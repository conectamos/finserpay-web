import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  isFcmConfigured,
  listFcmTokensForDocument,
  markFcmTokenSendResult,
  sendFcmNotification,
  type FcmDeviceTokenRow,
} from "@/lib/fcm-notifications";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ManualPushBody = {
  body?: string;
  creditoId?: number | string | null;
  dryRun?: boolean | string;
  filter?: "MORA" | "TODOS_APP" | "VENCE_2_DIAS" | "VENCE_HOY" | "VENCE_MANANA";
  limit?: number | string;
  mode?: "bulk" | "credit";
  preset?: "custom" | "efecty" | "internet" | "mora";
  title?: string;
};

type PushCredit = {
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
    fechaAbono: Date;
    valor: number;
  }>;
};

type PushDispatchItem = {
  action: "FAILED" | "NO_TOKEN" | "SENT" | "WOULD_SEND";
  clienteDocumento: string | null;
  clienteNombre: string;
  creditoId: number;
  error: string | null;
  folio: string;
  tokenId: number | null;
};

const DEFAULT_BULK_LIMIT = 500;
const BULK_FILTERS = [
  "MORA",
  "TODOS_APP",
  "VENCE_2_DIAS",
  "VENCE_HOY",
  "VENCE_MANANA",
] as const;

function parseBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value ?? "").trim().toLowerCase();

  if (["1", "true", "yes", "si", "dry"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function sanitizeText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function firstName(value: string) {
  return value.trim().split(/\s+/)[0] || "Cliente";
}

function normalizeDateInput(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value);
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysBetween(from: Date, toKey: string | null | undefined) {
  const target = normalizeDateInput(toKey);

  if (!target) {
    return 999;
  }

  const base = new Date(from);
  base.setHours(12, 0, 0, 0);
  target.setHours(12, 0, 0, 0);

  return Math.round((target.getTime() - base.getTime()) / 86_400_000);
}

function matchesBulkFilter(credit: PushCredit, filter: ManualPushBody["filter"]) {
  if (filter === "TODOS_APP") {
    return true;
  }

  const plan = buildCreditPaymentPlan({
    abonos: credit.abonos.map((item) => ({
      fechaAbono: item.fechaAbono,
      valor: Number(item.valor || 0),
    })),
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    frecuenciaPago: credit.frecuenciaPago,
    montoCredito: Number(credit.montoCredito || 0),
    plazoMeses: Number(credit.plazoMeses || 1),
    today: new Date(),
    valorCuota: Number(credit.valorCuota || 0),
  });

  if (filter === "MORA") {
    return plan.estadoPago === "MORA";
  }

  const daysToDue = daysBetween(new Date(), plan.nextInstallment?.fechaVencimiento);

  if (filter === "VENCE_HOY") {
    return daysToDue === 0;
  }

  if (filter === "VENCE_MANANA") {
    return daysToDue === 1;
  }

  if (filter === "VENCE_2_DIAS") {
    return daysToDue === 2;
  }

  return false;
}

function buildPresetMessage(credit: PushCredit, input: ManualPushBody) {
  const title = sanitizeText(input.title, 90) || "FINSER PAY";
  const customBody = sanitizeText(input.body, 600);
  const preset = input.preset || "internet";
  const name = firstName(credit.clienteNombre);
  const reference = credit.clienteDocumento || "tu cedula";

  if (preset === "custom" && customBody) {
    return { body: customBody, title };
  }

  if (preset === "mora") {
    return {
      body: `${name}, tienes una cuota vencida. Mantén datos o WiFi activos y realiza tu pago para normalizar tu equipo.`,
      title: "FINSER PAY: cuota vencida",
    };
  }

  if (preset === "efecty") {
    return {
      body: `${name}, puedes pagar por EFECTY. Convenio 113950. Referencia ${reference}. Tambien puedes pagar desde la app FINSER PAY.`,
      title: "FINSER PAY: medios de pago",
    };
  }

  return {
    body: `${name}, mantén tu celular conectado a internet para recibir avisos de pago y desbloqueo de FINSER PAY.`,
    title: "FINSER PAY: mantén internet activo",
  };
}

function baseItem(
  credit: PushCredit,
  action: PushDispatchItem["action"],
  tokenId: number | null,
  error: string | null = null
): PushDispatchItem {
  return {
    action,
    clienteDocumento: credit.clienteDocumento,
    clienteNombre: credit.clienteNombre,
    creditoId: credit.id,
    error,
    folio: credit.folio,
    tokenId,
  };
}

async function dispatchForCredit(
  credit: PushCredit,
  tokens: FcmDeviceTokenRow[],
  input: ManualPushBody,
  dryRun: boolean
) {
  if (!tokens.length) {
    return [baseItem(credit, "NO_TOKEN", null, "Cliente sin app registrada")];
  }

  const message = buildPresetMessage(credit, input);
  const items: PushDispatchItem[] = [];

  for (const token of tokens) {
    if (dryRun) {
      items.push(baseItem(credit, "WOULD_SEND", token.id));
      continue;
    }

    const result = await sendFcmNotification(token.token, {
      body: message.body,
      data: {
        creditoId: credit.id,
        documento: credit.clienteDocumento,
        folio: credit.folio,
        mode: "manual",
        url: "https://finserpay.com/clientes",
      },
      title: message.title,
    });

    await markFcmTokenSendResult(token.id, result);
    items.push(
      baseItem(
        credit,
        result.ok ? "SENT" : "FAILED",
        token.id,
        result.error
      )
    );
  }

  return items;
}

function summarize(items: PushDispatchItem[]) {
  const uniqueCreditIds = new Set(items.map((item) => item.creditoId));

  return items.reduce(
    (acc, item) => {
      acc.checked += 1;
      if (item.action === "FAILED") acc.failed += 1;
      if (item.action === "NO_TOKEN") acc.noToken += 1;
      if (item.action === "SENT") acc.sent += 1;
      if (item.action === "WOULD_SEND") acc.wouldSend += 1;
      return acc;
    },
    {
      checked: 0,
      failed: 0,
      noToken: 0,
      sent: 0,
      targetCredits: uniqueCreditIds.size,
      wouldSend: 0,
    }
  );
}

export async function POST(req: Request) {
  const user = await getSessionUser();

  if (!user || !isAdminRole(user.rolNombre)) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const input = (await req.json().catch(() => ({}))) as ManualPushBody;
  const dryRun = parseBoolean(input.dryRun, false);
  const mode = input.mode === "bulk" ? "bulk" : "credit";

  if (!isFcmConfigured() && !dryRun) {
    return NextResponse.json(
      { error: "Firebase Cloud Messaging no esta configurado" },
      { status: 503 }
    );
  }

  await ensureCreditAbonoAuditColumns();

  const credits =
    mode === "credit"
      ? await prisma.credito.findMany({
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
          where: {
            id: parsePositiveInt(input.creditoId, 0, Number.MAX_SAFE_INTEGER),
          },
        })
      : await prisma.credito.findMany({
          orderBy: {
            id: "desc",
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
          take: parsePositiveInt(input.limit, DEFAULT_BULK_LIMIT, 1000),
          where: {
            estado: {
              not: "ANULADO",
            },
            pazYSalvoEmitidoAt: null,
          },
        });

  const filter = BULK_FILTERS.includes(input.filter as (typeof BULK_FILTERS)[number])
    ? input.filter
    : "MORA";
  const targetCredits =
    mode === "bulk"
      ? credits.filter((credit) => matchesBulkFilter(credit, filter))
      : credits;
  const items: PushDispatchItem[] = [];

  for (const credit of targetCredits) {
    if (!credit.clienteDocumento) {
      items.push(baseItem(credit, "NO_TOKEN", null, "Credito sin cedula"));
      continue;
    }

    const tokens = await listFcmTokensForDocument(credit.clienteDocumento);
    items.push(...(await dispatchForCredit(credit, tokens, input, dryRun)));
  }

  return NextResponse.json({
    dryRun,
    filter,
    mode,
    ok: items.every((item) => item.action !== "FAILED"),
    summary: summarize(items),
    items: items.slice(0, 50),
  });
}
