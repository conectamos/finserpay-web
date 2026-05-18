import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  ensureFcmDeviceTokenTable,
  isFcmConfigured,
  listFcmTokensForDocument,
  markFcmTokenSendResult,
  sendFcmNotification,
  type FcmDeviceTokenRow,
} from "@/lib/fcm-notifications";
import prisma from "@/lib/prisma";

const DEFAULT_PUSH_LIMIT = 300;

let notificationLogReady = false;

type ReminderCredit = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  montoCredito: number;
  valorCuota: number;
  plazoMeses: number | null;
  frecuenciaPago: string;
  fechaPrimerPago: Date | null;
  fechaProximoPago: Date | null;
  estado: string;
  abonos: Array<{
    valor: number;
    fechaAbono: Date;
  }>;
};

type ReminderCategory =
  | "MORA"
  | "VENCE_2_DIAS"
  | "VENCE_HOY"
  | "VENCE_MANANA";

type PushReminderOptions = {
  dryRun?: boolean;
  limit?: unknown;
  today?: Date | string | null;
};

type PushReminderMessage = {
  body: string;
  category: ReminderCategory;
  dueDate: string;
  targetDate: string;
  title: string;
};

export type PushReminderAction =
  | "DUPLICATE"
  | "FAILED"
  | "NO_TOKEN"
  | "SENT"
  | "SKIPPED"
  | "WOULD_SEND";

export type PushReminderResult = {
  action: PushReminderAction;
  category: ReminderCategory | null;
  clienteDocumento: string | null;
  clienteNombre: string;
  creditoId: number;
  dueDate: string | null;
  error: string | null;
  folio: string;
  message: string;
  tokenId: number | null;
};

export type PushReminderReport = {
  configured: boolean;
  dryRun: boolean;
  generatedAt: string;
  items: PushReminderResult[];
  ok: boolean;
  summary: {
    checked: number;
    duplicate: number;
    failed: number;
    noToken: number;
    sent: number;
    skipped: number;
    wouldSend: number;
  };
  today: string;
};

function normalizeLimit(value: unknown) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PUSH_LIMIT;
  }

  return Math.min(parsed, 1000);
}

function normalizeDateInput(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value);
  }

  const normalized = String(value).trim();
  const dateOnlyMatch = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (dateOnlyMatch) {
    return new Date(
      Number(dateOnlyMatch[1]),
      Number(dateOnlyMatch[2]) - 1,
      Number(dateOnlyMatch[3]),
      12,
      0,
      0,
      0
    );
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateKey(value: Date | string | null | undefined) {
  const date = normalizeDateInput(value);

  if (!date) {
    return null;
  }

  date.setHours(12, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: Date, toKey: string) {
  const target = normalizeDateInput(toKey);
  if (!target) {
    return 999;
  }

  const base = new Date(from);
  base.setHours(12, 0, 0, 0);
  target.setHours(12, 0, 0, 0);

  return Math.round((target.getTime() - base.getTime()) / 86_400_000);
}

function firstName(value: string) {
  return value.trim().split(/\s+/)[0] || "Cliente";
}

function money(value: number) {
  return new Intl.NumberFormat("es-CO", {
    currency: "COP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Math.round(Number(value || 0)));
}

function buildMessage(
  credit: ReminderCredit,
  today: Date,
  plan: ReturnType<typeof buildCreditPaymentPlan>
): PushReminderMessage | null {
  const next = plan.nextInstallment;
  if (!next || plan.estadoPago === "PAGADO" || next.saldoPendiente <= 0) {
    return null;
  }

  const daysToDue = daysBetween(today, next.fechaVencimiento);
  const name = firstName(credit.clienteNombre);
  const quotaAmount = money(next.saldoPendiente);

  if (plan.estadoPago === "MORA") {
    return {
      body: `${name}, tu cuota esta vencida. Manten datos o WiFi activos y paga ${quotaAmount} para normalizar tu equipo.`,
      category: "MORA",
      dueDate: next.fechaVencimiento,
      targetDate: dateKey(today) || next.fechaVencimiento,
      title: "FINSER PAY: cuota vencida",
    };
  }

  if (daysToDue === 0) {
    return {
      body: `${name}, tu cuota vence hoy. Manten el celular conectado a internet y realiza el pago por ${quotaAmount}.`,
      category: "VENCE_HOY",
      dueDate: next.fechaVencimiento,
      targetDate: next.fechaVencimiento,
      title: "FINSER PAY: pago vence hoy",
    };
  }

  if (daysToDue === 1) {
    return {
      body: `${name}, tu proxima cuota vence manana. Manten datos o WiFi activos para recibir avisos de FINSER PAY.`,
      category: "VENCE_MANANA",
      dueDate: next.fechaVencimiento,
      targetDate: next.fechaVencimiento,
      title: "FINSER PAY: recuerda tu pago",
    };
  }

  if (daysToDue === 2) {
    return {
      body: `${name}, tu proxima cuota vence en 2 dias. Ten presente tu pago y manten conexion a internet.`,
      category: "VENCE_2_DIAS",
      dueDate: next.fechaVencimiento,
      targetDate: next.fechaVencimiento,
      title: "FINSER PAY: pago cercano",
    };
  }

  return null;
}

async function ensureNotificationLogTable() {
  if (notificationLogReady) {
    return;
  }

  await ensureFcmDeviceTokenTable();
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "FcmNotificationLog" (
      id SERIAL PRIMARY KEY,
      "tokenId" INTEGER,
      token TEXT NOT NULL,
      "clienteDocumento" TEXT,
      "creditoId" INTEGER,
      category TEXT NOT NULL,
      "targetDate" TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      error TEXT,
      "providerMessageId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "FcmNotificationLog_unique_target_idx"
    ON "FcmNotificationLog" (token, "creditoId", category, "targetDate")
  `);

  notificationLogReady = true;
}

async function createNotificationLog(
  credit: ReminderCredit,
  token: FcmDeviceTokenRow,
  message: PushReminderMessage
) {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `INSERT INTO "FcmNotificationLog"
      ("tokenId", token, "clienteDocumento", "creditoId", category, "targetDate",
       title, body, status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', NOW(), NOW())
     ON CONFLICT (token, "creditoId", category, "targetDate") DO NOTHING
     RETURNING id`,
    token.id,
    token.token,
    credit.clienteDocumento,
    credit.id,
    message.category,
    message.targetDate,
    message.title,
    message.body
  );

  return rows[0]?.id || null;
}

async function updateNotificationLog(
  id: number,
  status: "FAILED" | "SENT",
  error: string | null,
  providerMessageId: string | null
) {
  await prisma.$executeRawUnsafe(
    `UPDATE "FcmNotificationLog"
     SET status = $1, error = $2, "providerMessageId" = $3, "updatedAt" = NOW()
     WHERE id = $4`,
    status,
    error,
    providerMessageId,
    id
  );
}

function buildBaseResult(
  credit: ReminderCredit,
  action: PushReminderAction,
  message: string,
  reminder: PushReminderMessage | null,
  tokenId: number | null = null,
  error: string | null = null
): PushReminderResult {
  return {
    action,
    category: reminder?.category || null,
    clienteDocumento: credit.clienteDocumento,
    clienteNombre: credit.clienteNombre,
    creditoId: credit.id,
    dueDate: reminder?.dueDate || null,
    error,
    folio: credit.folio,
    message,
    tokenId,
  };
}

function buildClientPaymentUrl(credit: ReminderCredit) {
  const params = new URLSearchParams({
    credito: String(credit.id),
    panel: "payments",
  });

  if (credit.clienteDocumento) {
    params.set("documento", credit.clienteDocumento);
  }

  return `https://finserpay.com/clientes?${params.toString()}`;
}

async function dispatchForToken(
  credit: ReminderCredit,
  token: FcmDeviceTokenRow,
  reminder: PushReminderMessage,
  options: PushReminderOptions
) {
  if (options.dryRun) {
    return buildBaseResult(
      credit,
      "WOULD_SEND",
      "Se enviaria recordatorio push.",
      reminder,
      token.id
    );
  }

  if (!isFcmConfigured()) {
    return buildBaseResult(
      credit,
      "SKIPPED",
      "Firebase Cloud Messaging no esta configurado.",
      reminder,
      token.id
    );
  }

  const logId = await createNotificationLog(credit, token, reminder);
  if (!logId) {
    return buildBaseResult(
      credit,
      "DUPLICATE",
      "Recordatorio ya enviado para este objetivo.",
      reminder,
      token.id
    );
  }

  const result = await sendFcmNotification(token.token, {
    body: reminder.body,
    data: {
      category: reminder.category,
      creditoId: credit.id,
      documento: credit.clienteDocumento,
      dueDate: reminder.dueDate,
      folio: credit.folio,
      panel: "payments",
      url: buildClientPaymentUrl(credit),
    },
    title: reminder.title,
  });

  await updateNotificationLog(
    logId,
    result.ok ? "SENT" : "FAILED",
    result.error,
    result.providerMessageId
  );
  await markFcmTokenSendResult(token.id, result);

  return buildBaseResult(
    credit,
    result.ok ? "SENT" : "FAILED",
    result.ok ? "Recordatorio push enviado." : "No se pudo enviar el push.",
    reminder,
    token.id,
    result.error
  );
}

export async function dispatchCreditPushReminders(
  options: PushReminderOptions = {}
): Promise<PushReminderReport> {
  await ensureCreditAbonoAuditColumns();
  await ensureNotificationLogTable();

  const today = normalizeDateInput(options.today || null) || new Date();
  const limit = normalizeLimit(options.limit);
  const credits = await prisma.credito.findMany({
    orderBy: {
      id: "asc",
    },
    select: {
      abonos: {
        orderBy: {
          fechaAbono: "asc",
        },
        select: {
          fechaAbono: true,
          valor: true,
        },
        where: {
          estado: {
            not: "ANULADO",
          },
        },
      },
      clienteDocumento: true,
      clienteNombre: true,
      estado: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      folio: true,
      frecuenciaPago: true,
      id: true,
      montoCredito: true,
      plazoMeses: true,
      valorCuota: true,
    },
    take: limit,
    where: {
      estado: {
        not: "ANULADO",
      },
      pazYSalvoEmitidoAt: null,
    },
  });
  const items: PushReminderResult[] = [];

  for (const credit of credits) {
    const plan = buildCreditPaymentPlan({
      abonos: credit.abonos.map((item) => ({
        fechaAbono: item.fechaAbono,
        valor: Number(item.valor || 0),
      })),
      fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
      frecuenciaPago: credit.frecuenciaPago,
      montoCredito: Number(credit.montoCredito || 0),
      plazoMeses: Number(credit.plazoMeses || 1),
      today,
      valorCuota: Number(credit.valorCuota || 0),
    });
    const reminder = buildMessage(credit, today, plan);

    if (!reminder) {
      items.push(
        buildBaseResult(
          credit,
          "SKIPPED",
          "Credito sin recordatorio pendiente para hoy.",
          null
        )
      );
      continue;
    }

    if (!credit.clienteDocumento) {
      items.push(
        buildBaseResult(
          credit,
          "NO_TOKEN",
          "Credito sin cedula para buscar token.",
          reminder
        )
      );
      continue;
    }

    const tokens = await listFcmTokensForDocument(credit.clienteDocumento);

    if (!tokens.length) {
      items.push(
        buildBaseResult(
          credit,
          "NO_TOKEN",
          "Cliente sin app registrada para push.",
          reminder
        )
      );
      continue;
    }

    for (const token of tokens) {
      items.push(await dispatchForToken(credit, token, reminder, options));
    }
  }

  const summary = items.reduce<PushReminderReport["summary"]>(
    (acc, item) => {
      acc.checked += 1;
      if (item.action === "DUPLICATE") acc.duplicate += 1;
      if (item.action === "FAILED") acc.failed += 1;
      if (item.action === "NO_TOKEN") acc.noToken += 1;
      if (item.action === "SENT") acc.sent += 1;
      if (item.action === "SKIPPED") acc.skipped += 1;
      if (item.action === "WOULD_SEND") acc.wouldSend += 1;
      return acc;
    },
    {
      checked: 0,
      duplicate: 0,
      failed: 0,
      noToken: 0,
      sent: 0,
      skipped: 0,
      wouldSend: 0,
    }
  );

  return {
    configured: isFcmConfigured(),
    dryRun: Boolean(options.dryRun),
    generatedAt: new Date().toISOString(),
    items,
    ok: summary.failed === 0,
    summary,
    today: dateKey(today) || new Date().toISOString().slice(0, 10),
  };
}
