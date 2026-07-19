import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { resolveCreditState } from "@/lib/credit-factory";
import {
  extractEqualityDeviceSnapshot,
  getEqualityDeviceMeta,
  type EqualityDeviceSnapshot,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  isEqualityConfigured,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { isMassImportedCredit } from "@/lib/credit-import-flags";
import prisma from "@/lib/prisma";

type RawSqlClient = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "$queryRaw"
>;

type UnlockCommandRow = {
  attempts: number;
  commandKey: string;
  creditoId: number;
  deviceUid: string;
  id: number;
  source: string;
  sourceReference: string | null;
  status: string;
};

export type DeviceUnlockProcessResult = {
  commandId: number;
  confirmed: boolean;
  reason?: string;
  status: "BUSY" | "CANCELLED" | "CONFIRMED" | "RETRY";
};

let ensureTablePromise: Promise<void> | null = null;

export function ensureDeviceUnlockCommandTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = (async () => {
      await prisma.$executeRaw`
        CREATE TABLE IF NOT EXISTS "DeviceUnlockCommand" (
          "id" SERIAL PRIMARY KEY,
          "commandKey" TEXT NOT NULL UNIQUE,
          "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE CASCADE,
          "deviceUid" TEXT NOT NULL,
          "source" TEXT NOT NULL,
          "sourceReference" TEXT,
          "status" TEXT NOT NULL DEFAULT 'PENDING',
          "attempts" INTEGER NOT NULL DEFAULT 0,
          "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "lastAttemptAt" TIMESTAMP(3),
          "confirmedAt" TIMESTAMP(3),
          "lastError" TEXT,
          "remotePayload" JSONB,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `;
      await prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "DeviceUnlockCommand_status_nextAttemptAt_idx"
        ON "DeviceUnlockCommand" ("status", "nextAttemptAt")
      `;
      await prisma.$executeRaw`
        CREATE INDEX IF NOT EXISTS "DeviceUnlockCommand_creditoId_idx"
        ON "DeviceUnlockCommand" ("creditoId")
      `;
    })().catch((error) => {
      ensureTablePromise = null;
      throw error;
    });
  }

  return ensureTablePromise;
}

export async function enqueueDeviceUnlockCommand(options: {
  client?: RawSqlClient;
  commandKey: string;
  creditoId: number;
  deviceUid: string | null | undefined;
  source: string;
  sourceReference?: string | null;
}) {
  const client = options.client || prisma;
  const rows = await client.$queryRaw<Array<{ id: number; status: string }>>`
    INSERT INTO "DeviceUnlockCommand" AS command (
      "commandKey",
      "creditoId",
      "deviceUid",
      "source",
      "sourceReference",
      "status",
      "nextAttemptAt",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${options.commandKey},
      ${options.creditoId},
      ${String(options.deviceUid || "").trim()},
      ${options.source},
      ${options.sourceReference || null},
      'PENDING',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("commandKey") DO UPDATE SET
      "deviceUid" = EXCLUDED."deviceUid",
      "source" = EXCLUDED."source",
      "sourceReference" = EXCLUDED."sourceReference",
      "status" = CASE
        WHEN command."status" = 'CONFIRMED' THEN 'CONFIRMED'
        WHEN command."status" = 'PROCESSING'
          AND command."lastAttemptAt" > CURRENT_TIMESTAMP - INTERVAL '5 minutes'
          THEN 'PROCESSING'
        ELSE 'PENDING'
      END,
      "nextAttemptAt" = CASE
        WHEN command."status" = 'CONFIRMED' THEN command."nextAttemptAt"
        ELSE CURRENT_TIMESTAMP
      END,
      "lastError" = CASE
        WHEN command."status" = 'CONFIRMED' THEN command."lastError"
        ELSE NULL
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "id", "status"
  `;

  return rows[0] || null;
}

function normalizeRemoteState(value: string | null | undefined) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function hasPendingRemoteTransition(snapshot: EqualityDeviceSnapshot | null) {
  return Boolean(
    snapshot &&
      (String(snapshot.transitionState || "").trim() ||
        snapshot.transitionQueue.length > 0)
  );
}

export function isConfirmedUnlockedSnapshot(
  snapshot: EqualityDeviceSnapshot | null
) {
  if (!snapshot) {
    return false;
  }

  if (hasPendingRemoteTransition(snapshot)) {
    return false;
  }

  const state = normalizeRemoteState(snapshot.stateInfo);
  const explicitlyLocked = /\blocked\b/.test(state) && !/\bunlocked\b/.test(state);

  if (!state || explicitlyLocked) {
    return false;
  }

  return (
    /\bunlocked\b/.test(state) ||
    /\bactive\b/.test(state) ||
    state.includes("ready for use")
  );
}

function retryDelayMs(attempts: number) {
  const seconds = [30, 60, 120, 300, 600, 900];
  return seconds[Math.min(Math.max(attempts - 1, 0), seconds.length - 1)] * 1000;
}

function serializeError(error: unknown) {
  if (isEqualityApiError(error)) {
    return error.message;
  }

  return error instanceof Error ? error.message : String(error || "Error desconocido");
}

async function markCommandRetry(
  command: UnlockCommandRow,
  message: string,
  remotePayload?: unknown
) {
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(command.attempts));
  const remoteJson = remotePayload ? JSON.stringify(remotePayload) : null;

  await prisma.$executeRaw`
    UPDATE "DeviceUnlockCommand"
    SET
      "status" = 'RETRY',
      "nextAttemptAt" = ${nextAttemptAt},
      "lastError" = ${message.slice(0, 2000)},
      "remotePayload" = CASE
        WHEN ${remoteJson}::TEXT IS NULL THEN "remotePayload"
        ELSE CAST(${remoteJson} AS JSONB)
      END,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${command.id}
  `;
}

async function markCommandCancelled(commandId: number, message: string) {
  await prisma.$executeRaw`
    UPDATE "DeviceUnlockCommand"
    SET
      "status" = 'CANCELLED',
      "lastError" = ${message.slice(0, 2000)},
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = ${commandId}
  `;
}

async function claimCommand(commandId: number) {
  const rows = await prisma.$queryRaw<UnlockCommandRow[]>`
    WITH candidate AS (
      SELECT "id"
      FROM "DeviceUnlockCommand"
      WHERE "id" = ${commandId}
        AND (
          (
            "status" IN ('PENDING', 'RETRY')
            AND "nextAttemptAt" <= CURRENT_TIMESTAMP
          )
          OR (
            "status" = 'PROCESSING'
            AND "lastAttemptAt" <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
          )
        )
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "DeviceUnlockCommand" AS command
    SET
      "status" = 'PROCESSING',
      "attempts" = command."attempts" + 1,
      "lastAttemptAt" = CURRENT_TIMESTAMP,
      "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate
    WHERE command."id" = candidate."id"
    RETURNING
      command."id",
      command."commandKey",
      command."creditoId",
      command."deviceUid",
      command."source",
      command."sourceReference",
      command."status",
      command."attempts"
  `;

  return rows[0] || null;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendObservation(current: string | null, next: string) {
  return [current, next].filter(Boolean).join("\n");
}

export async function processDeviceUnlockCommand(
  commandId: number
): Promise<DeviceUnlockProcessResult> {
  await ensureDeviceUnlockCommandTable();
  await ensureCreditAbonoAuditColumns();

  const command = await claimCommand(commandId);

  if (!command) {
    return { commandId, confirmed: false, status: "BUSY" };
  }

  const credit = await prisma.credito.findUnique({
    where: { id: command.creditoId },
    select: {
      id: true,
      deviceUid: true,
      montoCredito: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      deliverableLabel: true,
      deliverableReady: true,
      equalityState: true,
      equalityService: true,
      equalityPayload: true,
      equalityLastCheckAt: true,
      bloqueoRobo: true,
      observacionAdmin: true,
      pazYSalvoEmitidoAt: true,
      abonos: {
        where: { estado: { not: "ANULADO" } },
        select: { valor: true, fechaAbono: true },
        orderBy: { fechaAbono: "asc" },
      },
    },
  });

  if (!credit) {
    await markCommandCancelled(command.id, "El credito ya no existe.");
    return {
      commandId: command.id,
      confirmed: false,
      reason: "CREDIT_NOT_FOUND",
      status: "CANCELLED",
    };
  }

  if (isMassImportedCredit(credit)) {
    await markCommandCancelled(command.id, "Credito importado sin control remoto.");
    return {
      commandId: command.id,
      confirmed: false,
      reason: "MASS_IMPORTED_CREDIT",
      status: "CANCELLED",
    };
  }

  if (credit.bloqueoRobo) {
    await markCommandCancelled(command.id, "El bloqueo por robo permanece activo.");
    return {
      commandId: command.id,
      confirmed: false,
      reason: "ROBBERY_LOCK_ACTIVE",
      status: "CANCELLED",
    };
  }

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
  });

  if (plan.estadoPago === "MORA") {
    await markCommandCancelled(
      command.id,
      "El credito volvio a MORA antes de confirmar el desbloqueo."
    );
    return {
      commandId: command.id,
      confirmed: false,
      reason: "CREDIT_IN_MORA",
      status: "CANCELLED",
    };
  }

  const deviceUid = String(credit.deviceUid || command.deviceUid || "").trim();

  if (!deviceUid) {
    await markCommandRetry(command, "El credito no tiene deviceUid para desbloquear.");
    return {
      commandId: command.id,
      confirmed: false,
      reason: "DEVICE_UID_MISSING",
      status: "RETRY",
    };
  }

  if (!isEqualityConfigured()) {
    await markCommandRetry(command, "Trustonic/Equality no esta configurado.");
    return {
      commandId: command.id,
      confirmed: false,
      reason: "EQUALITY_NOT_CONFIGURED",
      status: "RETRY",
    };
  }

  let commandPayload: unknown = null;
  let lastQueryPayload: unknown = null;

  try {
    lastQueryPayload = await queryEqualityDevices(deviceUid);
    let snapshot = extractEqualityDeviceSnapshot(lastQueryPayload);
    let confirmedPayload: unknown = isConfirmedUnlockedSnapshot(snapshot)
      ? lastQueryPayload
      : null;

    if (!confirmedPayload && !hasPendingRemoteTransition(snapshot)) {
      commandPayload = await unlockEqualityDevice(deviceUid);
    }

    for (const delayMs of confirmedPayload ? [] : [0, 1500, 3000]) {
      if (delayMs) {
        await wait(delayMs);
      }

      lastQueryPayload = await queryEqualityDevices(deviceUid);
      snapshot = extractEqualityDeviceSnapshot(lastQueryPayload);

      if (!isConfirmedUnlockedSnapshot(snapshot)) {
        continue;
      }

      confirmedPayload = lastQueryPayload;
      break;
    }

    if (confirmedPayload) {
      const deviceMeta = getEqualityDeviceMeta(confirmedPayload);
      const remoteJson = JSON.stringify(confirmedPayload);

      await prisma.$transaction(async (tx) => {
        await tx.credito.update({
          where: { id: credit.id },
          data: {
            estado: resolveCreditState({
              bloqueoRobo: false,
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
            equalityService:
              deviceMeta.serviceDetails || credit.equalityService,
            equalityPayload: confirmedPayload as Prisma.InputJsonValue,
            equalityLastCheckAt: new Date(),
            bloqueoMora: false,
            bloqueoMoraAt: null,
            observacionAdmin: appendObservation(
              credit.observacionAdmin,
              `DESBLOQUEO CONFIRMADO: ${command.source} ${
                command.sourceReference || command.commandKey
              }.`
            ),
          },
        });

        await tx.$executeRaw`
          UPDATE "DeviceUnlockCommand"
          SET
            "status" = 'CONFIRMED',
            "confirmedAt" = CURRENT_TIMESTAMP,
            "nextAttemptAt" = CURRENT_TIMESTAMP,
            "lastError" = NULL,
            "remotePayload" = CAST(${remoteJson} AS JSONB),
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = ${command.id}
        `;
      });

      return {
        commandId: command.id,
        confirmed: true,
        status: "CONFIRMED",
      };
    }

    snapshot = extractEqualityDeviceSnapshot(lastQueryPayload);
    const state = snapshot?.stateInfo || "sin estado remoto";
    const transitions = [
      snapshot?.transitionState,
      ...(snapshot?.transitionQueue || []),
    ]
      .filter(Boolean)
      .join(", ");
    const reason = `Trustonic aun no confirma el desbloqueo. Estado: ${state}${
      transitions ? `; transiciones: ${transitions}` : ""
    }.`;

    await markCommandRetry(command, reason, lastQueryPayload || commandPayload);
    return {
      commandId: command.id,
      confirmed: false,
      reason,
      status: "RETRY",
    };
  } catch (error) {
    const reason = `Fallo el desbloqueo o su confirmacion: ${serializeError(error)}`;
    const errorPayload = isEqualityApiError(error) ? error.payload : null;
    await markCommandRetry(
      command,
      reason,
      errorPayload || lastQueryPayload || commandPayload
    );
    return {
      commandId: command.id,
      confirmed: false,
      reason,
      status: "RETRY",
    };
  }
}

export async function enqueueUnlockForCurrentCredit(options: {
  commandKey: string;
  creditoId: number;
  source: string;
  sourceReference?: string | null;
}) {
  await ensureDeviceUnlockCommandTable();
  await ensureCreditAbonoAuditColumns();

  const credit = await prisma.credito.findUnique({
    where: { id: options.creditoId },
    select: {
      id: true,
      deviceUid: true,
      montoCredito: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      bloqueoRobo: true,
      observacionAdmin: true,
      abonos: {
        where: { estado: { not: "ANULADO" } },
        select: { valor: true, fechaAbono: true },
        orderBy: { fechaAbono: "asc" },
      },
    },
  });

  if (!credit || credit.bloqueoRobo || isMassImportedCredit(credit)) {
    return null;
  }

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
  });

  if (plan.estadoPago === "MORA") {
    return null;
  }

  return enqueueDeviceUnlockCommand({
    commandKey: options.commandKey,
    creditoId: credit.id,
    deviceUid: credit.deviceUid,
    source: options.source,
    sourceReference: options.sourceReference,
  });
}

export async function processPendingDeviceUnlockCommands(options?: {
  limit?: number;
}) {
  await ensureDeviceUnlockCommandTable();
  const limit = Math.min(Math.max(options?.limit || 20, 1), 100);
  const due = await prisma.$queryRaw<Array<{ id: number }>>`
    SELECT "id"
    FROM "DeviceUnlockCommand"
    WHERE (
      "status" IN ('PENDING', 'RETRY')
      AND "nextAttemptAt" <= CURRENT_TIMESTAMP
    ) OR (
      "status" = 'PROCESSING'
      AND "lastAttemptAt" <= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
    )
    ORDER BY "nextAttemptAt" ASC, "id" ASC
    LIMIT ${limit}
  `;

  const results: DeviceUnlockProcessResult[] = [];

  for (const item of due) {
    results.push(await processDeviceUnlockCommand(item.id));
  }

  return {
    ok: true,
    processed: results.length,
    confirmed: results.filter((item) => item.status === "CONFIRMED").length,
    retry: results.filter((item) => item.status === "RETRY").length,
    cancelled: results.filter((item) => item.status === "CANCELLED").length,
    busy: results.filter((item) => item.status === "BUSY").length,
  };
}

type ApprovedWompiUnlockRecoveryRow = {
  creditoId: number;
  id: number;
  processedAbonoId: number;
  reference: string;
};

export async function recoverRecentApprovedWompiUnlockCommands(options?: {
  limit?: number;
}) {
  await ensureDeviceUnlockCommandTable();
  const limit = Math.min(Math.max(options?.limit || 100, 1), 500);
  const rows = await prisma.$queryRaw<ApprovedWompiUnlockRecoveryRow[]>`
    SELECT
      intent."id",
      intent."creditoId",
      intent."processedAbonoId",
      intent."reference"
    FROM "WompiPaymentIntent" AS intent
    LEFT JOIN "DeviceUnlockCommand" AS command
      ON command."commandKey" = CONCAT(
        'WOMPI:',
        intent."id"::TEXT,
        ':',
        intent."processedAbonoId"::TEXT
      )
    WHERE intent."status" = 'APPROVED'
      AND intent."processedAbonoId" IS NOT NULL
      AND command."id" IS NULL
      AND COALESCE(intent."processedAt", intent."updatedAt") >=
        CURRENT_TIMESTAMP - INTERVAL '30 days'
    ORDER BY COALESCE(intent."processedAt", intent."updatedAt") DESC
    LIMIT ${limit}
  `;

  let enqueued = 0;

  for (const row of rows) {
    const command = await enqueueUnlockForCurrentCredit({
      commandKey: `WOMPI:${row.id}:${row.processedAbonoId}`,
      creditoId: row.creditoId,
      source: "WOMPI_RECOVERY",
      sourceReference: row.reference,
    });

    if (command) {
      enqueued += 1;
    }
  }

  return {
    ok: true,
    checked: rows.length,
    enqueued,
  };
}
