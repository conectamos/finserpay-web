import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  isEqualityConfigured,
  lockEqualityDevice,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
import {
  resolveCreditState,
  sanitizeText,
} from "@/lib/credit-factory";
import { buildMoraLockMessage } from "@/lib/credit-lock-message";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import {
  getActiveMoraBlockExemptionDocuments,
  isMoraBlockExempt,
  normalizeMoraExemptionDocument,
} from "@/lib/mora-block-exemptions";
import prisma from "@/lib/prisma";

const DEFAULT_SYNC_LIMIT = 500;

type MoraSyncCredit = {
  id: number;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  imei: string;
  deviceUid: string;
  montoCredito: number;
  valorCuota: number;
  plazoMeses: number | null;
  frecuenciaPago: string;
  fechaPrimerPago: Date | null;
  fechaProximoPago: Date | null;
  estado: string;
  deliverableLabel: string | null;
  deliverableReady: boolean;
  equalityState: string | null;
  equalityService: string | null;
  equalityPayload: unknown;
  equalityLastCheckAt: Date | null;
  bloqueoRobo: boolean;
  bloqueoRoboAt: Date | null;
  bloqueoMora: boolean;
  bloqueoMoraAt: Date | null;
  pazYSalvoEmitidoAt: Date | null;
  observacionAdmin: string | null;
  sede: {
    id: number;
    nombre: string;
  };
  abonos: Array<{
    valor: number;
    fechaAbono: Date;
  }>;
};

const moraSyncCreditSelect = {
  id: true,
  folio: true,
  clienteNombre: true,
  clienteDocumento: true,
  clienteTelefono: true,
  imei: true,
  deviceUid: true,
  montoCredito: true,
  valorCuota: true,
  plazoMeses: true,
  frecuenciaPago: true,
  fechaPrimerPago: true,
  fechaProximoPago: true,
  estado: true,
  deliverableLabel: true,
  deliverableReady: true,
  equalityState: true,
  equalityService: true,
  equalityPayload: true,
  equalityLastCheckAt: true,
  bloqueoRobo: true,
  bloqueoRoboAt: true,
  bloqueoMora: true,
  bloqueoMoraAt: true,
  pazYSalvoEmitidoAt: true,
  observacionAdmin: true,
  sede: {
    select: {
      id: true,
      nombre: true,
    },
  },
  abonos: {
    where: {
      estado: {
        not: "ANULADO",
      },
    },
    select: {
      valor: true,
      fechaAbono: true,
    },
    orderBy: {
      fechaAbono: "asc" as const,
    },
  },
} satisfies Prisma.CreditoSelect;

export type MoraSyncAction =
  | "FAILED"
  | "LOCKED"
  | "SKIPPED"
  | "UNCHANGED"
  | "UNLOCKED"
  | "WOULD_LOCK"
  | "WOULD_UNLOCK";

export type MoraSyncResult = {
  action: MoraSyncAction;
  bloqueoMora: boolean;
  bloqueoMoraAt: string | null;
  clienteDocumento: string | null;
  clienteNombre: string;
  cuotasEnMora: number;
  deviceUid: string;
  estado: string;
  estadoPago: string;
  fechaProximaCuota: string | null;
  folio: string;
  id: number;
  imei: string;
  message: string;
  remote: {
    deviceState?: string | null;
    resultCode?: string | null;
    resultMessage?: string | null;
    serviceDetails?: string | null;
  } | null;
  saldoPendiente: number;
  sede: string;
};

export type MoraSyncSummary = {
  blocked: number;
  checked: number;
  dryRun: boolean;
  failed: number;
  skipped: number;
  unchanged: number;
  unlocked: number;
  wouldLock: number;
  wouldUnlock: number;
};

export type MoraSyncReport = {
  ok: boolean;
  generatedAt: string;
  today: string;
  summary: MoraSyncSummary;
  items: MoraSyncResult[];
};

export type MoraSyncOptions = {
  dryRun?: boolean;
  exemptDocuments?: ReadonlySet<string>;
  limit?: unknown;
  today?: Date | string | null;
};

function dateOnly(value: Date | string | null | undefined) {
  const date = normalizeDateInput(value);

  if (!date) {
    return null;
  }

  date.setHours(12, 0, 0, 0);
  return date.toISOString().slice(0, 10);
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

function normalizeLimit(value: unknown) {
  const parsed = Math.trunc(Number(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SYNC_LIMIT;
  }

  return Math.min(parsed, 500);
}

function asJsonValue(payload: unknown) {
  return payload && typeof payload === "object"
    ? (payload as Prisma.InputJsonValue)
    : undefined;
}

function appendObservation(current: string | null, message: string) {
  const timestamp = new Date().toISOString();
  return [sanitizeText(current), `[${timestamp}] ${message}`]
    .filter(Boolean)
    .join("\n");
}

function serializeRemote(payload: unknown) {
  if (!payload) {
    return null;
  }

  const summary = getPayloadSummary(payload);
  const deviceMeta = getEqualityDeviceMeta(payload);

  return {
    resultCode: summary.resultCode || null,
    resultMessage: summary.resultMessage || null,
    deviceState: deviceMeta.deviceState || null,
    serviceDetails: deviceMeta.serviceDetails || null,
  };
}

function buildResult(
  credit: MoraSyncCredit,
  action: MoraSyncAction,
  message: string,
  plan: ReturnType<typeof buildCreditPaymentPlan>,
  remote: unknown = null
): MoraSyncResult {
  return {
    action,
    bloqueoMora: credit.bloqueoMora,
    bloqueoMoraAt: credit.bloqueoMoraAt?.toISOString() || null,
    clienteDocumento: credit.clienteDocumento,
    clienteNombre: credit.clienteNombre,
    cuotasEnMora: plan.overdueCount,
    deviceUid: credit.deviceUid,
    estado: credit.estado,
    estadoPago: plan.estadoPago,
    fechaProximaCuota: plan.nextInstallment?.fechaVencimiento || null,
    folio: credit.folio,
    id: credit.id,
    imei: credit.imei,
    message,
    remote: serializeRemote(remote),
    saldoPendiente: plan.saldoPendiente,
    sede: credit.sede.nombre,
  };
}

function buildUpdatedResult(
  credit: MoraSyncCredit,
  updated: {
    bloqueoMora: boolean;
    bloqueoMoraAt: Date | null;
    estado: string;
    equalityState: string | null;
    equalityService: string | null;
  },
  action: MoraSyncAction,
  message: string,
  plan: ReturnType<typeof buildCreditPaymentPlan>,
  remote: unknown = null
): MoraSyncResult {
  return {
    ...buildResult(credit, action, message, plan, remote),
    bloqueoMora: updated.bloqueoMora,
    bloqueoMoraAt: updated.bloqueoMoraAt?.toISOString() || null,
    estado: updated.estado,
    remote:
      serializeRemote(remote) ||
      (updated.equalityState || updated.equalityService
        ? {
            resultCode: null,
            resultMessage: null,
            deviceState: updated.equalityState,
            serviceDetails: updated.equalityService,
          }
        : null),
  };
}

export async function syncCreditMora(
  credit: MoraSyncCredit,
  options: MoraSyncOptions = {}
): Promise<MoraSyncResult> {
  const today = normalizeDateInput(options.today || null);
  const plan = buildCreditPaymentPlan({
    montoCredito: Number(credit.montoCredito || 0),
    valorCuota: Number(credit.valorCuota || 0),
    plazoMeses: Number(credit.plazoMeses || 1),
    frecuenciaPago: credit.frecuenciaPago,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    abonos: credit.abonos.map((item) => ({
      valor: Number(item.valor || 0),
      fechaAbono: item.fechaAbono,
    })),
    today,
  });
  const isInMora = plan.estadoPago === "MORA";
  const effectiveAt = today || new Date();
  const normalizedDocument = normalizeMoraExemptionDocument(
    credit.clienteDocumento
  );
  const exemptFromMoraBlock = normalizedDocument
    ? options.exemptDocuments
      ? options.exemptDocuments.has(normalizedDocument)
      : await isMoraBlockExempt(normalizedDocument, effectiveAt)
    : false;

  if (credit.estado === "ANULADO") {
    return buildResult(credit, "SKIPPED", "Credito anulado.", plan);
  }

  if (credit.pazYSalvoEmitidoAt) {
    return buildResult(credit, "SKIPPED", "Credito con paz y salvo emitido.", plan);
  }

  if (isMassImportedCredit(credit)) {
    return buildResult(
      credit,
      "SKIPPED",
      "Credito importado sin gestion de bloqueo; mora solo informativa.",
      plan
    );
  }

  if (plan.estadoPago === "PAGADO" && !credit.bloqueoMora) {
    return buildResult(credit, "SKIPPED", "Credito sin saldo pendiente.", plan);
  }

  if (exemptFromMoraBlock) {
    if (credit.bloqueoRobo) {
      return buildResult(
        credit,
        "SKIPPED",
        "Cedula con acuerdo, pero el bloqueo por robo permanece sin cambios.",
        plan
      );
    }

    if (!credit.bloqueoMora) {
      return buildResult(
        credit,
        "SKIPPED",
        "Cedula exenta de bloqueo por acuerdo; la mora sigue informativa.",
        plan
      );
    }

    if (!credit.deviceUid) {
      return buildResult(
        credit,
        "FAILED",
        "La excepcion esta activa, pero falta el deviceUid para desbloquear.",
        plan
      );
    }

    if (options.dryRun) {
      return buildResult(
        credit,
        "WOULD_UNLOCK",
        "Se desbloquearia por excepcion de acuerdo vigente.",
        plan
      );
    }

    if (!isEqualityConfigured()) {
      return buildResult(
        credit,
        "FAILED",
        "La excepcion esta activa, pero Equality no esta configurado para desbloquear.",
        plan
      );
    }

    try {
      const remotePayload = await unlockEqualityDevice(credit.deviceUid);
      const remoteQuery = await queryEqualityDevices(credit.deviceUid).catch(
        () => null
      );
      const payloadSource = remoteQuery || remotePayload || credit.equalityPayload;
      const deviceMeta = getEqualityDeviceMeta(payloadSource);
      const updated = await prisma.credito.update({
        where: { id: credit.id },
        data: {
          estado: resolveCreditState({
            bloqueoRobo: credit.bloqueoRobo,
            bloqueoMora: false,
            deliverable: deviceMeta.deliveryStatus || null,
            pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt,
          }),
          deliverableLabel:
            deviceMeta.deliveryStatus?.label || credit.deliverableLabel,
          deliverableReady:
            typeof deviceMeta.deliveryStatus?.ready === "boolean"
              ? deviceMeta.deliveryStatus.ready
              : credit.deliverableReady,
          equalityState: deviceMeta.deviceState || credit.equalityState,
          equalityService: deviceMeta.serviceDetails || credit.equalityService,
          equalityPayload: asJsonValue(payloadSource),
          equalityLastCheckAt: payloadSource
            ? new Date()
            : credit.equalityLastCheckAt,
          bloqueoMora: false,
          bloqueoMoraAt: null,
          observacionAdmin: appendObservation(
            credit.observacionAdmin,
            "ACUERDO: desbloqueo aplicado por excepcion de mora para la cedula."
          ),
        },
        select: {
          estado: true,
          equalityState: true,
          equalityService: true,
          bloqueoMora: true,
          bloqueoMoraAt: true,
        },
      });

      return buildUpdatedResult(
        credit,
        updated,
        "UNLOCKED",
        "Desbloqueo aplicado por excepcion de acuerdo vigente.",
        plan,
        payloadSource
      );
    } catch (error) {
      return buildResult(
        credit,
        "FAILED",
        isEqualityApiError(error)
          ? `Equality no confirmo el desbloqueo por acuerdo: ${error.message}`
          : "No se pudo desbloquear el equipo cubierto por el acuerdo.",
        plan,
        isEqualityApiError(error) ? error.payload : null
      );
    }
  }

  if (!credit.deviceUid) {
    return buildResult(credit, "SKIPPED", "Credito sin deviceUid para bloquear.", plan);
  }

  if (isInMora && credit.bloqueoRobo) {
    return buildResult(
      credit,
      "SKIPPED",
      "Equipo con bloqueo por robo; no se modifica por mora.",
      plan
    );
  }

  if (isInMora && credit.bloqueoMora) {
    return buildResult(credit, "UNCHANGED", "Ya estaba bloqueado por mora.", plan);
  }

  if (!isInMora && !credit.bloqueoMora) {
    return buildResult(credit, "UNCHANGED", "No tiene mora activa.", plan);
  }

  if (options.dryRun) {
    return buildResult(
      credit,
      isInMora ? "WOULD_LOCK" : "WOULD_UNLOCK",
      isInMora
        ? "Se bloquearia por mora al ejecutar el proceso."
        : "Se desbloquearia porque ya no tiene mora.",
      plan
    );
  }

  if (!isEqualityConfigured()) {
    return buildResult(
      credit,
      "SKIPPED",
      "Equality no esta configurado; no se pudo sincronizar mora.",
      plan
    );
  }

  try {
    const remotePayload = isInMora
      ? await lockEqualityDevice(credit.deviceUid, {
          lockMsgTitle: "Pago vencido",
          lockMsgContent: buildMoraLockMessage(credit.clienteDocumento),
        })
      : credit.bloqueoRobo
        ? null
        : await unlockEqualityDevice(credit.deviceUid);
    const remoteQuery = await queryEqualityDevices(credit.deviceUid).catch(() => null);
    const payloadSource = remoteQuery || remotePayload || credit.equalityPayload;
    const deviceMeta = getEqualityDeviceMeta(payloadSource);
    const updated = await prisma.credito.update({
      where: { id: credit.id },
      data: {
        estado: resolveCreditState({
          bloqueoRobo: credit.bloqueoRobo,
          bloqueoMora: isInMora,
          deliverable: deviceMeta.deliveryStatus || null,
          pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt,
        }),
        deliverableLabel:
          deviceMeta.deliveryStatus?.label || credit.deliverableLabel,
        deliverableReady:
          typeof deviceMeta.deliveryStatus?.ready === "boolean"
            ? deviceMeta.deliveryStatus.ready
            : credit.deliverableReady,
        equalityState: deviceMeta.deviceState || credit.equalityState,
        equalityService: deviceMeta.serviceDetails || credit.equalityService,
        equalityPayload: asJsonValue(payloadSource),
        equalityLastCheckAt: payloadSource ? new Date() : credit.equalityLastCheckAt,
        bloqueoMora: isInMora,
        bloqueoMoraAt: isInMora ? new Date() : null,
        observacionAdmin: appendObservation(
          credit.observacionAdmin,
          isInMora
            ? "MORA AUTO: bloqueo enviado por cuota vencida."
            : "MORA AUTO: desbloqueo enviado por credito al dia."
        ),
      },
      select: {
        estado: true,
        equalityState: true,
        equalityService: true,
        bloqueoMora: true,
        bloqueoMoraAt: true,
      },
    });

    return buildUpdatedResult(
      credit,
      updated,
      isInMora ? "LOCKED" : "UNLOCKED",
      isInMora
        ? "Bloqueo automatico por mora aplicado."
        : "Desbloqueo automatico por pago aplicado.",
      plan,
      payloadSource
    );
  } catch (error) {
    return buildResult(
      credit,
      "FAILED",
      isEqualityApiError(error)
        ? `Equality no confirmo la operacion: ${error.message}`
        : "No se pudo sincronizar mora con Equality.",
      plan,
      isEqualityApiError(error) ? error.payload : null
    );
  }
}

export async function syncAllCreditMora(
  options: MoraSyncOptions = {}
): Promise<MoraSyncReport> {
  await ensureCreditAbonoAuditColumns();

  const limit = normalizeLimit(options.limit);
  const today = normalizeDateInput(options.today || null) || new Date();
  const exemptDocuments = await getActiveMoraBlockExemptionDocuments(today);
  const credits = await prisma.credito.findMany({
    where: {
      estado: {
        not: "ANULADO",
      },
    },
    select: moraSyncCreditSelect,
    orderBy: [
      {
        bloqueoMora: "desc",
      },
      {
        fechaProximoPago: "asc",
      },
      {
        id: "asc",
      },
    ],
    take: limit,
  });
  const items: MoraSyncResult[] = [];

  for (const credit of credits) {
    items.push(
      await syncCreditMora(credit, {
        ...options,
        exemptDocuments,
        today,
      })
    );
  }

  const summary = items.reduce<MoraSyncSummary>(
    (acc, item) => {
      acc.checked += 1;

      if (item.action === "LOCKED") acc.blocked += 1;
      if (item.action === "UNLOCKED") acc.unlocked += 1;
      if (item.action === "WOULD_LOCK") acc.wouldLock += 1;
      if (item.action === "WOULD_UNLOCK") acc.wouldUnlock += 1;
      if (item.action === "FAILED") acc.failed += 1;
      if (item.action === "SKIPPED") acc.skipped += 1;
      if (item.action === "UNCHANGED") acc.unchanged += 1;

      return acc;
    },
    {
      blocked: 0,
      checked: 0,
      dryRun: Boolean(options.dryRun),
      failed: 0,
      skipped: 0,
      unchanged: 0,
      unlocked: 0,
      wouldLock: 0,
      wouldUnlock: 0,
    }
  );

  return {
    ok: summary.failed === 0,
    generatedAt: new Date().toISOString(),
    today: dateOnly(today) || new Date().toISOString().slice(0, 10),
    summary,
    items,
  };
}

export async function syncCreditMoraByDocument(
  documento: unknown,
  options: MoraSyncOptions = {}
) {
  await ensureCreditAbonoAuditColumns();

  const normalizedDocument = normalizeMoraExemptionDocument(documento);

  if (!normalizedDocument) {
    return [] as MoraSyncResult[];
  }

  const today = normalizeDateInput(options.today || null) || new Date();
  const exemptDocuments = await getActiveMoraBlockExemptionDocuments(today);
  const credits = await prisma.credito.findMany({
    where: {
      clienteDocumento: normalizedDocument,
      estado: {
        not: "ANULADO",
      },
    },
    select: moraSyncCreditSelect,
    orderBy: {
      id: "desc",
    },
  });
  const items: MoraSyncResult[] = [];

  for (const credit of credits) {
    items.push(
      await syncCreditMora(credit as MoraSyncCredit, {
        ...options,
        exemptDocuments,
        today,
      })
    );
  }

  return items;
}
