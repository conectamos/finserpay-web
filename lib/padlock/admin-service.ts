import { createHash } from "node:crypto";
import prisma from "@/lib/prisma";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";
import { queryPadlockDeviceByImei } from "@/lib/padlock/client";
import {
  getPadlockRuntimeConfig,
  assertPadlockSandboxDeviceAllowed,
  isPadlockSandboxCreditAllowed,
  resolvePadlockConfig,
} from "@/lib/padlock/config";
import { buildPadlockFinancialPosition } from "@/lib/padlock/finance";
import { buildPadlockAdminStatusSummary } from "@/lib/padlock/admin-summary";
import {
  decidePadlockAction,
  hasUnresolvedPadlockProviderAttempt,
} from "@/lib/padlock/engine";
import {
  PadlockStorageError,
  bindPadlockIphoneDevice,
  createPadlockPolicyRevision,
  enqueueManualPadlockCommand,
  listPadlockBindings,
  listPadlockCommands,
  listPadlockPolicies,
  loadPadlockEvaluationContext,
  requeuePadlockCommandReconciliation as requeuePadlockCommandReconciliationWith,
  type PadlockCommandStatus,
  type PadlockProviderState,
} from "@/lib/padlock/storage";
import { PadlockError } from "@/lib/padlock/types";

type AdminCommandRow = {
  id: string;
  bindingId: string;
  creditId: number;
  folio: string;
  imeiMasked: string;
  action: "LOCK" | "UNLOCK";
  status: PadlockCommandStatus;
  source: string;
  operatorReason: string | null;
  actorName: string | null;
  attemptCount: number;
  providerAttemptCount: number;
  lastProviderAttemptStartedAt: Date | null;
  lastProviderAttemptCompletedAt: Date | null;
  lastErrorCode: string | null;
  lastProviderState: PadlockProviderState | null;
  createdAt: Date;
};

type AdminPolicyRow = {
  id: string;
  scopeType: "GLOBAL" | "ALLY";
  allyId: number | null;
  allyName: string | null;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  version: number;
  reason: string | null;
  createdAt: Date;
};

type AdminBindingRow = {
  id: string;
  creditId: number;
  folio: string;
  clienteNombre: string;
  allyName: string | null;
  imeiMasked: string;
  status: "ACTIVE" | "RETIRED";
  verifiedAt: Date | null;
  desiredState: "UNKNOWN" | "LOCKED" | "UNLOCKED";
  lastProviderState: PadlockProviderState | null;
  bindingConsistent: boolean;
  updatedAt: Date;
};

type AdminAllyRow = {
  id: number;
  nombre: string;
  codigo: string | null;
};

type AdminLatestCommandRow = {
  bindingId: string;
  action: "LOCK" | "UNLOCK";
  status: PadlockCommandStatus;
};

type AdminStatusCountRow = {
  status: string;
  count: number;
};

type AdminTotalCountRow = {
  count: number;
};

type UiStatus =
  | "PENDING"
  | "PROCESSING"
  | "LOCKED"
  | "UNLOCKED"
  | "ERROR"
  | "REVIEW_REQUIRED"
  | "CANCELLED"
  | "SUPERSEDED"
  | "NOT_ENROLLED"
  | "UNKNOWN";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_BINDING_LIMIT = 100;
const ADMIN_COMMAND_LIMIT = 100;

export class PadlockAdminServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "PadlockAdminServiceError";
  }
}

function iso(value: Date | string | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function providerStateToUi(value: PadlockProviderState | null): UiStatus {
  switch (value) {
    case "LOCKED":
      return "LOCKED";
    case "UNLOCKED":
      return "UNLOCKED";
    case "LOCKING":
    case "UNLOCKING":
      return "PROCESSING";
    case "NOT_ENROLLED":
      return "NOT_ENROLLED";
    case "ERROR":
      return "ERROR";
    default:
      return "UNKNOWN";
  }
}

function commandStatusToUi(
  status: PadlockCommandStatus,
  action: "LOCK" | "UNLOCK"
): UiStatus {
  switch (status) {
    case "PENDING":
    case "RETRY":
      return "PENDING";
    case "PROCESSING":
      return "PROCESSING";
    case "CONFIRMED":
      return action === "LOCK" ? "LOCKED" : "UNLOCKED";
    case "ERROR":
      return "ERROR";
    case "REVIEW_REQUIRED":
      return "REVIEW_REQUIRED";
    case "CANCELLED":
      return "CANCELLED";
    case "SUPERSEDED":
      return "SUPERSEDED";
  }
}

function commandSourceToUi(source: string) {
  const normalized = String(source || "").toUpperCase();
  if (normalized === "MANUAL") return "MANUAL" as const;
  if (normalized.includes("SCHEDULED_LOCK")) return "AUTO_CUTOFF" as const;
  return "AUTO_FINANCIAL" as const;
}

function publicProviderCallsAllowed() {
  const runtime = getPadlockRuntimeConfig();
  return {
    runtime,
    allowed:
      runtime.enabled &&
      runtime.configured &&
      (runtime.environment !== "production" || runtime.productionAllowed) &&
      runtime.environment !== "not-configured",
  };
}

function assertProviderCallsAllowed() {
  const state = publicProviderCallsAllowed();
  if (!state.runtime.enabled) {
    throw new PadlockAdminServiceError(
      "PADLOCK_DISABLED",
      "La integración Padlock está apagada para certificación.",
      503
    );
  }
  if (!state.allowed) {
    throw new PadlockAdminServiceError(
      "PADLOCK_NOT_CONFIGURED",
      "Padlock no está configurado para realizar esta operación.",
      503
    );
  }
  return state.runtime;
}

function creditSnapshotPlatform(snapshot: unknown) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const equipment = (snapshot as Record<string, unknown>).equipo;
  if (!equipment || typeof equipment !== "object") return null;
  const platform = String(
    (equipment as Record<string, unknown>).plataforma || ""
  )
    .trim()
    .toUpperCase();
  return platform || null;
}

async function bindingFinancialStatus(creditId: number, now: Date) {
  const context = await loadPadlockEvaluationContext(creditId, now);
  if (!context) {
    return {
      paymentStatus: "UNKNOWN" as const,
      daysPastDue: 0,
      requiresReview: true,
      reviewReason: "EVALUATION_CONTEXT_UNAVAILABLE",
    };
  }
  const position = buildPadlockFinancialPosition(context.financial, now);
  const decision = decidePadlockAction({
    context,
    trigger: "RECONCILIATION",
    now,
  });
  const requiresReview =
    decision.kind === "NONE" && decision.requiresReview === true;
  if (!position.reliable) {
    return {
      paymentStatus: "UNKNOWN" as const,
      daysPastDue: 0,
      requiresReview: true,
      reviewReason:
        decision.kind === "NONE" ? decision.reason : "FINANCIAL_POSITION_INCOMPLETE",
    };
  }
  return {
    paymentStatus:
      position.state === "SETTLED"
        ? ("PAGADO" as const)
        : position.state,
    daysPastDue: position.daysPastDue,
    requiresReview,
    reviewReason:
      requiresReview && decision.kind === "NONE" ? decision.reason : null,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function listLatestActionableCommandsForBindings(bindingIds: string[]) {
  if (bindingIds.length === 0) return [];

  return prisma.$queryRawUnsafe<AdminLatestCommandRow[]>(
    `
      SELECT DISTINCT ON (command."bindingId")
        command."bindingId"::text AS "bindingId",
        command."action",
        command."status"
      FROM "PadlockCommand" command
      WHERE command."bindingId" = ANY($1::uuid[])
        AND command."status" <> ALL($2::text[])
      ORDER BY command."bindingId", command."desiredVersion" DESC,
        command."createdAt" DESC, command."id" DESC
    `,
    bindingIds,
    ["CANCELLED", "SUPERSEDED"]
  );
}

async function listPadlockAdminStatusCounts() {
  return prisma.$queryRawUnsafe<AdminStatusCountRow[]>(
    `
      WITH latest_actionable AS (
        SELECT DISTINCT ON (command."bindingId")
          command."bindingId", command."action", command."status"
        FROM "PadlockCommand" command
        WHERE command."status" NOT IN ('CANCELLED', 'SUPERSEDED')
        ORDER BY command."bindingId", command."desiredVersion" DESC,
          command."createdAt" DESC, command."id" DESC
      ), resolved_status AS (
        SELECT CASE
          WHEN BTRIM(binding."imei") <> BTRIM(COALESCE(credit."imei", ''))
            OR UPPER(BTRIM(COALESCE(
              NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', ''),
              NULLIF(liquidated."plataforma", ''),
              ''
            ))) <> 'IPHONE'
            THEN 'REVIEW_REQUIRED'
          WHEN latest."status" IN ('PENDING', 'RETRY') THEN 'PENDING'
          WHEN latest."status" = 'PROCESSING' THEN 'PROCESSING'
          WHEN latest."status" = 'CONFIRMED' AND latest."action" = 'LOCK'
            THEN 'LOCKED'
          WHEN latest."status" = 'CONFIRMED' AND latest."action" = 'UNLOCK'
            THEN 'UNLOCKED'
          WHEN latest."status" = 'ERROR' THEN 'ERROR'
          WHEN latest."status" = 'REVIEW_REQUIRED' THEN 'REVIEW_REQUIRED'
          WHEN binding."lastProviderState" = 'LOCKED' THEN 'LOCKED'
          WHEN binding."lastProviderState" = 'UNLOCKED' THEN 'UNLOCKED'
          WHEN binding."lastProviderState" IN ('LOCKING', 'UNLOCKING')
            THEN 'PROCESSING'
          WHEN binding."lastProviderState" = 'NOT_ENROLLED' THEN 'NOT_ENROLLED'
          WHEN binding."lastProviderState" = 'ERROR' THEN 'ERROR'
          ELSE 'UNKNOWN'
        END AS "status"
        FROM "PadlockDeviceBinding" binding
        JOIN "Credito" credit ON credit."id" = binding."creditId"
        LEFT JOIN "LiquidacionAliadoCredito" liquidated
          ON liquidated."creditoId" = credit."id"
        LEFT JOIN latest_actionable latest ON latest."bindingId" = binding."id"
        WHERE binding."status" = 'ACTIVE'
      )
      SELECT "status", COUNT(*)::integer AS "count"
      FROM resolved_status
      GROUP BY "status"
    `
  );
}

async function countPadlockCommands() {
  const rows = await prisma.$queryRawUnsafe<AdminTotalCountRow[]>(
    'SELECT COUNT(*)::integer AS "count" FROM "PadlockCommand"'
  );
  return Number(rows[0]?.count || 0);
}

export async function getPadlockAdminOverview(now = new Date()) {
  const provider = publicProviderCallsAllowed();
  const [
    rawPolicyRows,
    rawBindingRows,
    rawCommandRows,
    rawAllyRows,
    rawStatusCountRows,
    totalCommands,
  ] = await Promise.all([
    listPadlockPolicies(),
    listPadlockBindings({ limit: ADMIN_BINDING_LIMIT, status: "ACTIVE" }),
    listPadlockCommands({
      limit: ADMIN_COMMAND_LIMIT,
      prioritizeUnresolvedProviderReviews: true,
    }),
    prisma.aliado.findMany({
      where: { activo: true },
      select: { id: true, nombre: true, codigo: true },
      orderBy: { nombre: "asc" },
    }),
    listPadlockAdminStatusCounts(),
    countPadlockCommands(),
  ]);
  const policyRows = rawPolicyRows as AdminPolicyRow[];
  const bindingRows = rawBindingRows as AdminBindingRow[];
  const commandRows = rawCommandRows as AdminCommandRow[];
  const allyRows = rawAllyRows as AdminAllyRow[];
  const statusSummary = buildPadlockAdminStatusSummary(rawStatusCountRows);

  const commands = commandRows.map((command) => ({
    id: command.id,
    bindingId: command.bindingId,
    creditId: Number(command.creditId),
    folio: command.folio,
    imeiMasked: command.imeiMasked,
    action: command.action,
    source: commandSourceToUi(command.source),
    status: commandStatusToUi(command.status, command.action),
    reason: command.operatorReason || null,
    requestedBy: command.actorName || null,
    attempts: Number(command.attemptCount || 0),
    canReconcile:
      command.status === "REVIEW_REQUIRED" &&
      hasUnresolvedPadlockProviderAttempt(command),
    errorCode: command.lastErrorCode || null,
    providerState: command.lastProviderState || null,
    createdAt: iso(command.createdAt),
  }));
  const latestActionableRows = await listLatestActionableCommandsForBindings(
    bindingRows.map((binding) => binding.id)
  );
  const latestActionableCommand = new Map(
    latestActionableRows.map((command) => [
      command.bindingId,
      commandStatusToUi(command.status, command.action),
    ])
  );

  const bindings = await mapWithConcurrency(bindingRows, 8, async (binding) => {
    const financial = await bindingFinancialStatus(binding.creditId, now);
    const latestStatus = latestActionableCommand.get(binding.id);
    const reviewReason = !binding.bindingConsistent
      ? "BINDING_IDENTITY_MISMATCH"
      : financial.reviewReason;
    const status: UiStatus = reviewReason
      ? "REVIEW_REQUIRED"
      : latestStatus
        ? latestStatus
        : providerStateToUi(binding.lastProviderState);

    return {
      id: binding.id,
      creditId: Number(binding.creditId),
      folio: binding.folio,
      customerName: binding.clienteNombre,
      allyName: binding.allyName || null,
      imeiMasked: binding.imeiMasked,
      verified: Boolean(binding.verifiedAt && binding.bindingConsistent),
      active: binding.status === "ACTIVE",
      status,
      desiredState:
        binding.desiredState === "LOCKED" || binding.desiredState === "UNLOCKED"
          ? binding.desiredState
          : null,
      paymentStatus: financial.paymentStatus,
      daysPastDue: financial.daysPastDue,
      reviewReason,
      lastUpdatedAt: iso(binding.updatedAt),
    };
  });

  return {
    integration: {
      enabled: provider.runtime.enabled,
      configured: provider.runtime.configured,
      providerCallsAllowed: provider.allowed,
      environment: provider.runtime.environment,
      scheduleLabel:
        "Días 5 y 20 de cada mes, a las 8:00 p. m. (America/Bogota).",
      automaticUnlockLabel:
        "Se programa al confirmar el pago y comprobar que el crédito quedó al día.",
    },
    counters: statusSummary.counters,
    lists: {
      bindings: {
        limit: ADMIN_BINDING_LIMIT,
        shown: bindings.length,
        total: statusSummary.total,
        limited: statusSummary.total > bindings.length,
      },
      commands: {
        limit: ADMIN_COMMAND_LIMIT,
        shown: commands.length,
        total: totalCommands,
        limited: totalCommands > commands.length,
      },
    },
    allies: allyRows
      .filter((ally) => !isFinserPayCentralAlly(ally.codigo))
      .map((ally) => ({ id: ally.id, name: ally.nombre })),
    policies: policyRows.map((policy) => ({
      id: policy.id,
      scopeType: policy.scopeType,
      allyId: policy.allyId,
      allyName: policy.allyName,
      productCode: "IPHONE" as const,
      enabled: policy.enabled,
      graceDays: policy.graceDays,
      lockAfterDaysPastDue: policy.lockAfterDaysPastDue,
      unlockCondition: policy.unlockCondition,
      version: policy.version,
      reason: policy.reason,
      updatedAt: iso(policy.createdAt),
    })),
    bindings,
    commands,
  };
}

export async function savePadlockPolicy(input: {
  scopeType: "GLOBAL" | "ALLY";
  allyId: number | null;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  reason: string;
  actorUserId: number;
  correlationId: string;
}) {
  const policy = await createPadlockPolicyRevision(input);
  return { id: policy.id, version: policy.version };
}

export async function verifyAndBindPadlockIphone(input: {
  creditId: number;
  imei: string;
  actorUserId: number;
  correlationId: string;
}) {
  if (!isValidCreditDeviceReplacementImei(input.imei)) {
    throw new PadlockAdminServiceError(
      "PADLOCK_IMEI_INVALID",
      "El IMEI debe tener 15 dígitos y un dígito de control válido.",
      400
    );
  }

  const credit = await prisma.credito.findUnique({
    where: { id: input.creditId },
    select: {
      id: true,
      imei: true,
      estado: true,
      bloqueoRobo: true,
      bloqueoMora: true,
      contratoSnapshot: true,
      liquidacionAliadoCredito: { select: { plataforma: true } },
    },
  });
  if (!credit) {
    throw new PadlockAdminServiceError(
      "PADLOCK_CREDIT_NOT_FOUND",
      "El crédito no existe.",
      404
    );
  }
  const platform =
    creditSnapshotPlatform(credit.contratoSnapshot) ||
    String(credit.liquidacionAliadoCredito?.plataforma || "")
      .trim()
      .toUpperCase();
  if (platform !== "IPHONE") {
    throw new PadlockAdminServiceError(
      "PADLOCK_EXPLICIT_IPHONE_REQUIRED",
      "El crédito no tiene plataforma iPhone explícita.",
      409
    );
  }
  if (String(credit.imei || "").trim() !== input.imei) {
    throw new PadlockAdminServiceError(
      "PADLOCK_CREDIT_IMEI_MISMATCH",
      "El IMEI no coincide con el dispositivo operativo del crédito.",
      409
    );
  }
  if (["ANULADO", "CANCELADO", "CANCELLED"].includes(credit.estado.toUpperCase())) {
    throw new PadlockAdminServiceError(
      "PADLOCK_CREDIT_NOT_ACTIVE",
      "El crédito no está vigente.",
      409
    );
  }
  if (credit.bloqueoRobo) {
    throw new PadlockAdminServiceError(
      "PADLOCK_ROBBERY_LOCK_REQUIRES_REVIEW",
      "El crédito conserva un bloqueo por robo. Debe conciliarse antes de vincularlo a Padlock.",
      409
    );
  }
  if (credit.bloqueoMora) {
    throw new PadlockAdminServiceError(
      "PADLOCK_EXISTING_MORA_LOCK_REQUIRES_REVIEW",
      "El crédito conserva un bloqueo por mora previo. Debe conciliarse antes de vincularlo a Padlock.",
      409
    );
  }

  assertProviderCallsAllowed();
  const config = resolvePadlockConfig(process.env, input.correlationId);
  if (!isPadlockSandboxCreditAllowed(config, String(input.creditId))) {
    throw new PadlockAdminServiceError(
      "PADLOCK_SANDBOX_CREDIT_NOT_ALLOWED",
      "El crédito no está autorizado para pruebas Padlock sandbox.",
      403
    );
  }

  const device = await queryPadlockDeviceByImei(input.imei, {
    correlationId: input.correlationId,
  });
  if (!device) {
    throw new PadlockAdminServiceError(
      "PADLOCK_DEVICE_NOT_FOUND",
      "Padlock no encontró una coincidencia exacta para el IMEI.",
      404
    );
  }
  if (device.identifier !== input.imei) {
    throw new PadlockAdminServiceError(
      "PADLOCK_IDENTIFIER_MISMATCH",
      "Padlock no confirmó el IMEI en su campo identifier canónico.",
      409
    );
  }
  if (device.status === "locked") {
    throw new PadlockAdminServiceError(
      "PADLOCK_PREEXISTING_LOCK_REQUIRES_REVIEW",
      "El dispositivo ya está bloqueado en Padlock. No puede vincularse sin aclarar y proteger la causa de ese bloqueo.",
      409
    );
  }
  if (device.status !== "unlocked") {
    throw new PadlockAdminServiceError(
      "PADLOCK_DEVICE_NOT_READY",
      "Padlock no confirmó que el dispositivo esté enrolado, operativo y desbloqueado.",
      409
    );
  }

  const providerFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        identifier: device.identifier,
        status: device.status,
        updatedAt: device.updatedAt,
      }),
      "utf8"
    )
    .digest("hex");
  const binding = await bindPadlockIphoneDevice({
    creditId: input.creditId,
    imei: input.imei,
    initialProviderState: "UNLOCKED",
    verifiedByUserId: input.actorUserId,
    verificationReference: `${input.correlationId}:${providerFingerprint}`,
    correlationId: input.correlationId,
  });

  return {
    id: binding.id,
    creditId: Number(binding.creditId),
    imeiMasked: binding.imeiMasked,
    verified: true,
  };
}

export async function queueManualPadlockCommand(input: {
  bindingId: string;
  action: "LOCK" | "UNLOCK";
  reason: string;
  actorUserId: number;
  correlationId: string;
}) {
  assertProviderCallsAllowed();
  if (!UUID_PATTERN.test(input.bindingId)) {
    throw new PadlockAdminServiceError(
      "PADLOCK_BINDING_ID_INVALID",
      "El dispositivo vinculado no es válido.",
      400
    );
  }
  const rows = await prisma.$queryRaw<Array<{ creditId: number }>>`
    SELECT "creditId"
    FROM "PadlockDeviceBinding"
    WHERE "id" = ${input.bindingId}::uuid
      AND "status" = 'ACTIVE'
    LIMIT 1
  `;
  const creditId = Number(rows[0]?.creditId || 0);
  const context = creditId
    ? await loadPadlockEvaluationContext(creditId)
    : null;
  if (!context || context.binding.id !== input.bindingId) {
    throw new PadlockAdminServiceError(
      "PADLOCK_BINDING_NOT_FOUND",
      "El dispositivo vinculado no existe o ya no está activo.",
      404
    );
  }
  const config = resolvePadlockConfig(process.env, input.correlationId);
  if (!isPadlockSandboxCreditAllowed(config, String(creditId))) {
    throw new PadlockAdminServiceError(
      "PADLOCK_SANDBOX_CREDIT_NOT_ALLOWED",
      "El crédito no está autorizado para pruebas Padlock sandbox.",
      403
    );
  }
  assertPadlockSandboxDeviceAllowed(
    config,
    context.binding.imei,
    input.correlationId
  );
  const result = await enqueueManualPadlockCommand({
    bindingId: input.bindingId,
    action: input.action,
    actorUserId: input.actorUserId,
    reason: input.reason,
    correlationId: input.correlationId,
  });
  return {
    outcome: result.kind,
    commandId: "commandId" in result ? result.commandId : null,
    desiredVersion: result.desiredVersion,
  };
}

export async function requeueReviewedPadlockCommand(input: {
  commandId: string;
  reason: string;
  actorUserId: number;
  correlationId: string;
}) {
  assertProviderCallsAllowed();
  if (!UUID_PATTERN.test(input.commandId)) {
    throw new PadlockAdminServiceError(
      "PADLOCK_COMMAND_ID_INVALID",
      "El comando Padlock no es válido.",
      400
    );
  }
  const rows = await prisma.$queryRaw<
    Array<{ creditId: number; bindingId: string; imei: string }>
  >`
    SELECT command."creditId", command."bindingId", binding."imei"
    FROM "PadlockCommand" command
    JOIN "PadlockDeviceBinding" binding ON binding."id" = command."bindingId"
    WHERE command."id" = ${input.commandId}::uuid
      AND binding."status" = 'ACTIVE'
    LIMIT 1
  `;
  const target = rows[0];
  if (!target) {
    throw new PadlockAdminServiceError(
      "PADLOCK_RECONCILIATION_TARGET_NOT_FOUND",
      "El comando o su vinculación activa no existen.",
      404
    );
  }

  const config = resolvePadlockConfig(process.env, input.correlationId);
  if (!isPadlockSandboxCreditAllowed(config, String(target.creditId))) {
    throw new PadlockAdminServiceError(
      "PADLOCK_SANDBOX_CREDIT_NOT_ALLOWED",
      "El crédito no está autorizado para pruebas Padlock sandbox.",
      403
    );
  }
  assertPadlockSandboxDeviceAllowed(
    config,
    target.imei,
    input.correlationId
  );

  return requeuePadlockCommandReconciliationWith({
    commandId: input.commandId,
    actorUserId: input.actorUserId,
    reason: input.reason,
    correlationId: input.correlationId,
  });
}

export function publicPadlockAdminError(error: unknown) {
  if (error instanceof PadlockAdminServiceError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof PadlockStorageError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (error instanceof PadlockError) {
    const status = [400, 403, 404, 409, 429, 502, 503, 504].includes(
      error.httpStatus
    )
      ? error.httpStatus
      : 502;
    return { code: error.code, message: error.message, status };
  }
  return {
    code: "PADLOCK_ADMIN_ERROR",
    message: "No se pudo completar la operación Padlock.",
    status: 500,
  };
}
