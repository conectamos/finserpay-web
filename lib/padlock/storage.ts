import { createHash, randomUUID } from "node:crypto";

import prisma from "@/lib/prisma";
import { isValidCreditDeviceReplacementImei } from "@/lib/credit-device-replacement";
import {
  PADLOCK_DEFAULT_MAX_ATTEMPTS,
  PADLOCK_PRODUCT,
  decidePadlockAction,
  hasUnresolvedPadlockProviderAttempt,
  isPadlockProviderAttemptOpen,
  planPadlockCommandMutation,
  shouldKeepPadlockProviderAttemptPending,
  type PadlockAction,
  type PadlockBindingContext,
  type PadlockDecision,
  type PadlockDecisionCommitResult,
  type PadlockEngineRepository,
  type PadlockEvaluationContext,
  type PadlockEvaluationTrigger,
  type PadlockLockCause,
  type PadlockPolicyRevision,
} from "@/lib/padlock/engine";
import { buildPadlockFinancialPosition } from "@/lib/padlock/finance";
import { redactPadlockSensitiveText } from "@/lib/padlock/redaction";

export type PadlockCommandStatus =
  | "PENDING"
  | "PROCESSING"
  | "RETRY"
  | "CONFIRMED"
  | "ERROR"
  | "REVIEW_REQUIRED"
  | "CANCELLED"
  | "SUPERSEDED";

export type PadlockProviderState =
  | "UNKNOWN"
  | "LOCKED"
  | "UNLOCKED"
  | "LOCKING"
  | "UNLOCKING"
  | "NOT_ENROLLED"
  | "ERROR";

export type PadlockSqlDatabase = {
  $queryRawUnsafe<T = unknown>(
    query: string,
    ...values: unknown[]
  ): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

type PadlockRootDatabase = PadlockSqlDatabase & {
  $transaction<T>(
    operation: (transaction: PadlockSqlDatabase) => Promise<T>
  ): Promise<T>;
};

const database = prisma as unknown as PadlockRootDatabase;
const ACTIVE_COMMAND_STATUSES = ["PENDING", "PROCESSING", "RETRY"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE_PATTERN = /[^A-Z0-9_:-]/g;

export class PadlockStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = "PadlockStorageError";
  }
}

function asInteger(
  value: unknown,
  code: string,
  options: { min?: number; max?: number } = {}
) {
  const number = Number(value);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new PadlockStorageError(code, "Valor numerico Padlock invalido.", 400);
  }
  return number;
}

function safeCode(value: unknown, fallback: string, maxLength = 64) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_")
    .replace(SAFE_CODE_PATTERN, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

function safeText(value: unknown, maxLength: number) {
  return redactPadlockSensitiveText(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function requiredReason(value: unknown) {
  const reason = safeText(value, 500);
  if (reason.length < 5) {
    throw new PadlockStorageError(
      "PADLOCK_REASON_REQUIRED",
      "Registra un motivo de al menos 5 caracteres.",
      400
    );
  }
  return reason;
}

function requiredCorrelationId(value: unknown) {
  const correlationId = String(value || "").trim();
  if (!UUID_PATTERN.test(correlationId)) {
    throw new PadlockStorageError(
      "PADLOCK_CORRELATION_ID_INVALID",
      "La correlacion Padlock no es valida.",
      400
    );
  }
  return correlationId;
}

function requiredUuid(value: unknown, code: string) {
  const id = String(value || "").trim();
  if (!UUID_PATTERN.test(id)) {
    throw new PadlockStorageError(code, "Identificador Padlock invalido.", 400);
  }
  return id;
}

function verificationHash(value: unknown) {
  const reference = safeText(value, 500);
  if (reference.length < 8) {
    throw new PadlockStorageError(
      "PADLOCK_VERIFICATION_REFERENCE_REQUIRED",
      "La verificacion del enrolamiento Padlock es obligatoria.",
      400
    );
  }
  return createHash("sha256").update(reference, "utf8").digest("hex");
}

function normalizeImei(value: unknown) {
  const imei = String(value || "").trim();
  if (!isValidCreditDeviceReplacementImei(imei)) {
    throw new PadlockStorageError(
      "PADLOCK_IMEI_INVALID",
      "El IMEI debe tener 15 digitos y un digito de control valido.",
      400
    );
  }
  return imei;
}

function maskImei(value: unknown) {
  const imei = String(value || "").trim();
  return imei.length >= 4 ? "•".repeat(Math.max(0, imei.length - 4)) + imei.slice(-4) : "";
}

async function inTransaction<T>(
  operation: (transaction: PadlockSqlDatabase) => Promise<T>
) {
  return database.$transaction(operation);
}

async function lockKeys(transaction: PadlockSqlDatabase, keys: string[]) {
  for (const key of [...new Set(keys)].sort()) {
    await transaction.$executeRawUnsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))",
      key
    );
  }
}

type AuditInput = {
  bindingId?: string | null;
  commandId?: string | null;
  policyRevisionId?: string | null;
  creditId?: number | null;
  eventType: string;
  action?: PadlockAction | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  reasonCode?: string | null;
  operatorReason?: string | null;
  desiredVersion?: number | null;
  attemptNumber?: number | null;
  actorType: "SYSTEM" | "USER" | "WORKER";
  actorUserId?: number | null;
  correlationId: string;
};

async function appendAudit(
  transaction: PadlockSqlDatabase,
  input: AuditInput
) {
  await transaction.$executeRawUnsafe(
    `
      INSERT INTO "PadlockAuditEvent" (
        "id", "bindingId", "commandId", "policyRevisionId", "creditId",
        "eventType", "action", "fromStatus", "toStatus", "reasonCode",
        "operatorReason", "desiredVersion", "attemptNumber", "actorType",
        "actorUserId", "correlationId", "createdAt"
      )
      VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
        $6, $7, $8, $9, $10,
        $11, $12::integer, $13::integer, $14, $15::integer,
        $16::uuid, CURRENT_TIMESTAMP
      )
    `,
    randomUUID(),
    input.bindingId || null,
    input.commandId || null,
    input.policyRevisionId || null,
    input.creditId || null,
    safeCode(input.eventType, "PADLOCK_EVENT", 48),
    input.action || null,
    input.fromStatus ? safeCode(input.fromStatus, "UNKNOWN", 24) : null,
    input.toStatus ? safeCode(input.toStatus, "UNKNOWN", 24) : null,
    input.reasonCode ? safeCode(input.reasonCode, "UNSPECIFIED", 64) : null,
    input.operatorReason ? safeText(input.operatorReason, 500) : null,
    input.desiredVersion ?? null,
    input.attemptNumber ?? null,
    input.actorType,
    input.actorUserId || null,
    requiredCorrelationId(input.correlationId)
  );
}

type PolicyRow = {
  id: string;
  scopeKey: string;
  scopeType: "GLOBAL" | "ALLY";
  allyId: number | null;
  allyName?: string | null;
  product: "IPHONE";
  version: number;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  reason: string | null;
  createdByUserId: number;
  createdAt: Date;
};

function policyFromRow(row: PolicyRow): PadlockPolicyRevision {
  return {
    id: row.id,
    scopeType: row.scopeType,
    allyId: row.allyId,
    product: PADLOCK_PRODUCT,
    version: Number(row.version),
    enabled: Boolean(row.enabled),
    graceDays: Number(row.graceDays),
    lockAfterDaysPastDue: Number(row.lockAfterDaysPastDue),
    unlockCondition: row.unlockCondition,
  };
}

export async function listPadlockPolicies(options?: {
  includeHistory?: boolean;
}) {
  const rows = await database.$queryRawUnsafe<PolicyRow[]>(
    `
      SELECT policy.*, ally."nombre" AS "allyName"
      FROM "PadlockPolicyRevision" policy
      LEFT JOIN "Aliado" ally ON ally."id" = policy."allyId"
      WHERE $1::boolean
        OR NOT EXISTS (
          SELECT 1
          FROM "PadlockPolicyRevision" newer
          WHERE newer."scopeKey" = policy."scopeKey"
            AND newer."version" > policy."version"
        )
      ORDER BY policy."scopeType", ally."nombre" NULLS FIRST,
        policy."version" DESC
    `,
    Boolean(options?.includeHistory)
  );
  return rows.map((row) => ({
    ...policyFromRow(row),
    scopeKey: row.scopeKey,
    allyName: row.allyName || null,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    effectiveLockThresholdDays:
      Number(row.graceDays) + Number(row.lockAfterDaysPastDue),
  }));
}

export async function createPadlockPolicyRevision(input: {
  scopeType: "GLOBAL" | "ALLY";
  allyId?: number | null;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: "CURRENT" | "SETTLED";
  actorUserId: number;
  reason: string;
  correlationId?: string;
}) {
  const scopeType = input.scopeType;
  const allyId =
    scopeType === "ALLY"
      ? asInteger(input.allyId, "PADLOCK_ALLY_INVALID", { min: 1 })
      : null;
  const scopeKey =
    scopeType === "ALLY" ? `ALLY:${allyId}:IPHONE` : "GLOBAL:IPHONE";
  const graceDays = asInteger(input.graceDays, "PADLOCK_GRACE_DAYS_INVALID", {
    max: 3650,
  });
  const lockAfterDaysPastDue = asInteger(
    input.lockAfterDaysPastDue,
    "PADLOCK_LOCK_DAYS_INVALID",
    { max: 3650 }
  );
  const actorUserId = asInteger(
    input.actorUserId,
    "PADLOCK_ACTOR_INVALID",
    { min: 1 }
  );
  const unlockCondition = input.unlockCondition;
  if (unlockCondition !== "CURRENT" && unlockCondition !== "SETTLED") {
    throw new PadlockStorageError(
      "PADLOCK_UNLOCK_CONDITION_INVALID",
      "Condicion de desbloqueo Padlock invalida.",
      400
    );
  }
  const reason = requiredReason(input.reason);
  const correlationId = input.correlationId
    ? requiredCorrelationId(input.correlationId)
    : randomUUID();

  return inTransaction(async (transaction) => {
    await lockKeys(transaction, [`padlock:policy:${scopeKey}`]);
    if (allyId) {
      const allies = await transaction.$queryRawUnsafe<Array<{ id: number }>>(
        'SELECT "id" FROM "Aliado" WHERE "id" = $1 LIMIT 1',
        allyId
      );
      if (!allies[0]) {
        throw new PadlockStorageError(
          "PADLOCK_ALLY_NOT_FOUND",
          "El aliado de la politica no existe.",
          404
        );
      }
    }
    const versions = await transaction.$queryRawUnsafe<Array<{ version: number }>>(
      `
        SELECT COALESCE(MAX("version"), 0)::integer AS "version"
        FROM "PadlockPolicyRevision"
        WHERE "scopeKey" = $1
      `,
      scopeKey
    );
    const version = Number(versions[0]?.version || 0) + 1;
    const id = randomUUID();
    const rows = await transaction.$queryRawUnsafe<PolicyRow[]>(
      `
        INSERT INTO "PadlockPolicyRevision" (
          "id", "scopeKey", "scopeType", "allyId", "product", "version",
          "enabled", "graceDays", "lockAfterDaysPastDue", "unlockCondition",
          "reason", "createdByUserId", "createdAt"
        )
        VALUES (
          $1::uuid, $2, $3, $4::integer, 'IPHONE', $5::integer,
          $6::boolean, $7::integer, $8::integer, $9,
          $10, $11::integer, CURRENT_TIMESTAMP
        )
        RETURNING *
      `,
      id,
      scopeKey,
      scopeType,
      allyId,
      version,
      Boolean(input.enabled),
      graceDays,
      lockAfterDaysPastDue,
      unlockCondition,
      reason,
      actorUserId
    );
    await appendAudit(transaction, {
      policyRevisionId: id,
      eventType: "POLICY_REVISION_CREATED",
      reasonCode: input.enabled ? "POLICY_ENABLED" : "POLICY_DISABLED",
      actorType: "USER",
      actorUserId,
      correlationId,
    });
    return {
      ...policyFromRow(rows[0]),
      scopeKey,
      reason,
      createdByUserId: actorUserId,
      createdAt: rows[0].createdAt,
      effectiveLockThresholdDays: graceDays + lockAfterDaysPastDue,
    };
  });
}

type BindingRow = {
  id: string;
  creditId: number;
  imei: string;
  product: string;
  status: "ACTIVE" | "RETIRED";
  verifiedAt: Date;
  verifiedByUserId: number;
  verificationReferenceHash: string;
  desiredState: "UNKNOWN" | "LOCKED" | "UNLOCKED";
  desiredVersion: number;
  desiredLockCause: PadlockLockCause | null;
  confirmedState: "UNKNOWN" | "LOCKED" | "UNLOCKED";
  confirmedLockCause: PadlockLockCause | null;
  lastProviderState: PadlockProviderState | null;
  lastConfirmedAt: Date | null;
  retiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type CreditBindingRow = {
  creditId: number;
  creditImei: string;
  creditState: string;
  creditPlatform: string | null;
  creditTheftLockActive: boolean;
  creditMoraLockActive: boolean;
};

export async function bindPadlockIphoneDevice(input: {
  creditId: number;
  imei: string;
  initialProviderState: "UNLOCKED";
  verifiedByUserId: number;
  verificationReference: string;
  correlationId?: string;
}) {
  const creditId = asInteger(input.creditId, "PADLOCK_CREDIT_INVALID", { min: 1 });
  const imei = normalizeImei(input.imei);
  const verifiedByUserId = asInteger(
    input.verifiedByUserId,
    "PADLOCK_ACTOR_INVALID",
    { min: 1 }
  );
  const referenceHash = verificationHash(input.verificationReference);
  if (input.initialProviderState !== "UNLOCKED") {
    throw new PadlockStorageError(
      "PADLOCK_INITIAL_STATE_INVALID",
      "El binding inicial requiere confirmación remota de estado desbloqueado.",
      409
    );
  }
  const correlationId = input.correlationId
    ? requiredCorrelationId(input.correlationId)
    : randomUUID();

  return inTransaction(async (transaction) => {
    await lockKeys(transaction, [
      `padlock:binding:credit:${creditId}`,
      `padlock:binding:imei:${imei}`,
    ]);
    const credits = await transaction.$queryRawUnsafe<CreditBindingRow[]>(
      `
        SELECT credit."id" AS "creditId", credit."imei" AS "creditImei",
          credit."estado" AS "creditState",
          credit."bloqueoRobo" AS "creditTheftLockActive",
          credit."bloqueoMora" AS "creditMoraLockActive",
          COALESCE(
            NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', ''),
            NULLIF(liquidated."plataforma", '')
          ) AS "creditPlatform"
        FROM "Credito" credit
        LEFT JOIN "LiquidacionAliadoCredito" liquidated
          ON liquidated."creditoId" = credit."id"
        WHERE credit."id" = $1
        LIMIT 1
        FOR UPDATE OF credit
      `,
      creditId
    );
    const credit = credits[0];
    if (!credit) {
      throw new PadlockStorageError(
        "PADLOCK_CREDIT_NOT_FOUND",
        "El credito no existe.",
        404
      );
    }
    if (String(credit.creditPlatform || "").trim().toUpperCase() !== PADLOCK_PRODUCT) {
      throw new PadlockStorageError(
        "PADLOCK_EXPLICIT_IPHONE_REQUIRED",
        "El credito no tiene plataforma IPHONE explicita.",
        409
      );
    }
    if (String(credit.creditImei || "").trim() !== imei) {
      throw new PadlockStorageError(
        "PADLOCK_CREDIT_IMEI_MISMATCH",
        "El IMEI verificado no coincide con el IMEI operativo del credito.",
        409
      );
    }
    if (["ANULADO", "CANCELADO", "CANCELLED"].includes(safeCode(credit.creditState, ""))) {
      throw new PadlockStorageError(
        "PADLOCK_CREDIT_NOT_ACTIVE",
        "El credito no esta vigente.",
        409
      );
    }
    if (credit.creditTheftLockActive) {
      throw new PadlockStorageError(
        "PADLOCK_ROBBERY_LOCK_REQUIRES_REVIEW",
        "El credito conserva un bloqueo por robo. Debe conciliarse antes de vincularlo a Padlock.",
        409
      );
    }
    if (credit.creditMoraLockActive) {
      throw new PadlockStorageError(
        "PADLOCK_EXISTING_MORA_LOCK_REQUIRES_REVIEW",
        "El credito conserva un bloqueo por mora previo. Debe conciliarse antes de vincularlo a Padlock.",
        409
      );
    }
    const existing = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        SELECT *
        FROM "PadlockDeviceBinding"
        WHERE ("creditId" = $1 OR "imei" = $2)
          AND "status" = 'ACTIVE'
        ORDER BY "createdAt" DESC
        FOR UPDATE
      `,
      creditId,
      imei
    );
    if (existing[0]) {
      if (existing[0].creditId === creditId && existing[0].imei.trim() === imei) {
        return { ...existing[0], imeiMasked: maskImei(existing[0].imei) };
      }
      throw new PadlockStorageError(
        "PADLOCK_BINDING_CONFLICT",
        "El credito o el IMEI ya tiene otro binding Padlock activo.",
        409
      );
    }
    const id = randomUUID();
    const rows = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        INSERT INTO "PadlockDeviceBinding" (
          "id", "creditId", "imei", "product", "status", "verifiedAt",
          "verifiedByUserId", "verificationReferenceHash", "desiredState",
          "desiredVersion", "confirmedState", "lastProviderState",
          "lastConfirmedAt", "createdAt", "updatedAt"
        )
        VALUES (
          $1::uuid, $2::integer, $3, 'IPHONE', 'ACTIVE', CURRENT_TIMESTAMP,
          $4::integer, $5, 'UNLOCKED', 0, 'UNLOCKED', 'UNLOCKED',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        RETURNING *
      `,
      id,
      creditId,
      imei,
      verifiedByUserId,
      referenceHash
    );
    await appendAudit(transaction, {
      bindingId: id,
      creditId,
      eventType: "BINDING_VERIFIED",
      reasonCode: "EXPLICIT_IPHONE_BINDING",
      desiredVersion: 0,
      actorType: "USER",
      actorUserId: verifiedByUserId,
      correlationId,
    });
    return { ...rows[0], imeiMasked: maskImei(imei) };
  });
}

type EvaluationRow = BindingRow & {
  allyId: number | null;
  creditImei: string;
  creditLifecycleState: string;
  creditPlatform: string | null;
  creditTheftLockActive: boolean;
  montoCredito: number;
  valorCuota: number;
  plazoMeses: number | null;
  frecuenciaPago: string;
  fechaPrimerPago: Date | null;
  fechaProximoPago: Date | null;
  pazYSalvoEmitidoAt: Date | null;
  hasPendingAutoMoraLock: boolean;
  hasUnreconciledAutoMoraLockAttempt: boolean;
  hasActiveMoraBlockExemption: boolean;
  autoMoraLockDecisionAt: Date | null;
  hasConfirmedPaymentAfterAutoMoraLockDecision: boolean;
};

type PaymentRow = {
  valor: number;
  fechaAbono: Date;
  estado: string;
};

async function resolvePolicyWith(
  query: PadlockSqlDatabase,
  allyId: number | null
) {
  const rows = await query.$queryRawUnsafe<PolicyRow[]>(
    `
      SELECT policy.*
      FROM "PadlockPolicyRevision" policy
      WHERE policy."product" = 'IPHONE'
        AND (
          (policy."scopeType" = 'ALLY' AND policy."allyId" = $1::integer)
          OR policy."scopeType" = 'GLOBAL'
        )
      ORDER BY
        CASE
          WHEN policy."scopeType" = 'ALLY' AND policy."allyId" = $1::integer
            THEN 0
          ELSE 1
        END,
        policy."version" DESC
      LIMIT 1
    `,
    allyId
  );
  return rows[0] ? policyFromRow(rows[0]) : null;
}

async function loadEvaluationContextWith(
  query: PadlockSqlDatabase,
  creditId: number,
  effectiveAt: Date
): Promise<PadlockEvaluationContext | null> {
  const rows = await query.$queryRawUnsafe<EvaluationRow[]>(
    `
      SELECT binding.*, credit."imei" AS "creditImei",
        credit."estado" AS "creditLifecycleState",
        credit."bloqueoRobo" AS "creditTheftLockActive",
        COALESCE(
          NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', ''),
          NULLIF(liquidated."plataforma", '')
        ) AS "creditPlatform",
        branch."aliadoId" AS "allyId",
        credit."montoCredito", credit."valorCuota", credit."plazoMeses",
        credit."frecuenciaPago", credit."fechaPrimerPago",
        credit."fechaProximoPago", credit."pazYSalvoEmitidoAt",
        relevant_auto_lock."decisionAt" AS "autoMoraLockDecisionAt",
        EXISTS (
          SELECT 1
          FROM "CreditoAbono" confirmed_payment
          WHERE confirmed_payment."creditoId" = credit."id"
            AND confirmed_payment."estado" = 'ACTIVO'
            AND confirmed_payment."valor" > 0
            AND relevant_auto_lock."decisionAt" IS NOT NULL
            AND confirmed_payment."createdAt" > relevant_auto_lock."decisionAt"
        ) AS "hasConfirmedPaymentAfterAutoMoraLockDecision",
        EXISTS (
          SELECT 1
          FROM "ExcepcionBloqueoMora" exemption
          WHERE exemption."documento" = LEFT(
              REGEXP_REPLACE(COALESCE(credit."clienteDocumento", ''), '[^0-9]', '', 'g'),
              20
            )
            AND LENGTH(
              LEFT(
                REGEXP_REPLACE(COALESCE(credit."clienteDocumento", ''), '[^0-9]', '', 'g'),
                20
              )
            ) > 0
            AND exemption."activa" = TRUE
            AND (exemption."fechaFin" IS NULL OR exemption."fechaFin" >= $3::timestamp)
        ) AS "hasActiveMoraBlockExemption",
        EXISTS (
          SELECT 1
          FROM "PadlockCommand" pending_lock
          WHERE pending_lock."bindingId" = binding."id"
            AND pending_lock."action" = 'LOCK'
            AND pending_lock."lockCause" = 'AUTO_MORA'
            AND pending_lock."status" = ANY($2::text[])
        ) AS "hasPendingAutoMoraLock",
        EXISTS (
          SELECT 1
          FROM "PadlockCommand" attempted_lock
          WHERE attempted_lock."bindingId" = binding."id"
            AND attempted_lock."action" = 'LOCK'
            AND attempted_lock."lockCause" = 'AUTO_MORA'
            AND attempted_lock."providerAttemptCount" > 0
            AND attempted_lock."lastProviderAttemptStartedAt" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM "PadlockCommand" compensating_unlock
              WHERE compensating_unlock."bindingId" = binding."id"
                AND compensating_unlock."action" = 'UNLOCK'
                AND compensating_unlock."status" = 'CONFIRMED'
                AND compensating_unlock."confirmedAt"
                  >= COALESCE(
                    attempted_lock."lastProviderAttemptCompletedAt",
                    attempted_lock."lastProviderAttemptStartedAt"
                  )
            )
        ) AS "hasUnreconciledAutoMoraLockAttempt"
      FROM "PadlockDeviceBinding" binding
      JOIN "Credito" credit ON credit."id" = binding."creditId"
      JOIN "Sede" branch ON branch."id" = credit."sedeId"
      LEFT JOIN "LiquidacionAliadoCredito" liquidated
        ON liquidated."creditoId" = credit."id"
      LEFT JOIN LATERAL (
        SELECT MAX(lock_command."evaluatedAt") AS "decisionAt"
        FROM "PadlockCommand" lock_command
        WHERE lock_command."bindingId" = binding."id"
          AND lock_command."action" = 'LOCK'
          AND lock_command."lockCause" = 'AUTO_MORA'
          AND (
            lock_command."status" = 'CONFIRMED'
            OR lock_command."desiredVersion" = binding."desiredVersion"
            OR (
              lock_command."providerAttemptCount" > 0
              AND lock_command."lastProviderAttemptStartedAt" IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM "PadlockCommand" compensating_unlock
                WHERE compensating_unlock."bindingId" = binding."id"
                  AND compensating_unlock."action" = 'UNLOCK'
                  AND compensating_unlock."status" = 'CONFIRMED'
                  AND compensating_unlock."confirmedAt"
                    >= COALESCE(
                      lock_command."lastProviderAttemptCompletedAt",
                      lock_command."lastProviderAttemptStartedAt"
                    )
              )
            )
        )
      ) relevant_auto_lock ON TRUE
      WHERE binding."creditId" = $1
        AND binding."status" = 'ACTIVE'
      ORDER BY binding."createdAt" DESC
      LIMIT 1
    `,
    creditId,
    [...ACTIVE_COMMAND_STATUSES],
    effectiveAt
  );
  const row = rows[0];
  if (!row) return null;
  const payments = await query.$queryRawUnsafe<PaymentRow[]>(
    `
      SELECT "valor", "fechaAbono", "estado"
      FROM "CreditoAbono"
      WHERE "creditoId" = $1
        AND "estado" <> 'ANULADO'
      ORDER BY "fechaAbono", "id"
    `,
    creditId
  );
  const policy = await resolvePolicyWith(query, row.allyId);
  const binding: PadlockBindingContext = {
    id: row.id,
    creditId: row.creditId,
    imei: row.imei.trim(),
    product: row.product,
    status: row.status,
    verifiedAt: row.verifiedAt,
    desiredState: row.desiredState,
    desiredVersion: Number(row.desiredVersion),
    desiredLockCause: row.desiredLockCause,
    confirmedState: row.confirmedState,
    confirmedLockCause: row.confirmedLockCause,
    hasPendingAutoMoraLock: Boolean(row.hasPendingAutoMoraLock),
    hasUnreconciledAutoMoraLockAttempt: Boolean(
      row.hasUnreconciledAutoMoraLockAttempt
    ),
    hasActiveMoraBlockExemption: Boolean(row.hasActiveMoraBlockExemption),
    creditTheftLockActive: Boolean(row.creditTheftLockActive),
    autoMoraLockDecisionAt: row.autoMoraLockDecisionAt,
    hasConfirmedPaymentAfterAutoMoraLockDecision: Boolean(
      row.hasConfirmedPaymentAfterAutoMoraLockDecision
    ),
    creditImei: String(row.creditImei || "").trim(),
    creditPlatform: row.creditPlatform,
    creditLifecycleState: row.creditLifecycleState,
  };
  return {
    binding,
    policy,
    financial: {
      montoCredito: Number(row.montoCredito),
      valorCuota: Number(row.valorCuota),
      plazoMeses: row.plazoMeses,
      frecuenciaPago: row.frecuenciaPago,
      fechaPrimerPago: row.fechaPrimerPago,
      fechaProximoPago: row.fechaProximoPago,
      pazYSalvoEmitidoAt: row.pazYSalvoEmitidoAt,
      abonos: payments.map((payment) => ({
        valor: Number(payment.valor),
        fechaAbono: payment.fechaAbono,
        estado: payment.estado,
      })),
    },
  };
}

export async function loadPadlockEvaluationContext(
  creditId: number,
  effectiveAt: Date = new Date()
) {
  const evaluatedAt = new Date(effectiveAt);
  if (Number.isNaN(evaluatedAt.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_EVALUATED_AT_INVALID",
      "Fecha de evaluacion Padlock invalida.",
      400
    );
  }
  return loadEvaluationContextWith(
    database,
    asInteger(creditId, "PADLOCK_CREDIT_INVALID", { min: 1 }),
    evaluatedAt
  );
}

export async function listPadlockEvaluationCreditIds(options?: {
  limit?: number;
  purpose?: "ALL" | "AUTO_UNLOCK";
  afterCreditId?: number;
}) {
  const limit = asInteger(options?.limit ?? 1000, "PADLOCK_LIMIT_INVALID", {
    min: 1,
    max: 5000,
  });
  const purpose = options?.purpose || "ALL";
  const afterCreditId = asInteger(
    options?.afterCreditId ?? 0,
    "PADLOCK_AFTER_CREDIT_ID_INVALID",
    { min: 0 }
  );
  if (purpose !== "ALL" && purpose !== "AUTO_UNLOCK") {
    throw new PadlockStorageError(
      "PADLOCK_EVALUATION_PURPOSE_INVALID",
      "Proposito de evaluacion Padlock invalido.",
      400
    );
  }
  const rows = await database.$queryRawUnsafe<Array<{ creditId: number }>>(
    `
      SELECT binding."creditId"
      FROM "PadlockDeviceBinding" binding
      WHERE binding."status" = 'ACTIVE'
        AND binding."product" = 'IPHONE'
        AND binding."creditId" > $4
        AND (
          $2 = 'ALL'
          OR (
            $2 = 'AUTO_UNLOCK'
            AND (
              (
                binding."desiredState" = 'LOCKED'
                AND binding."desiredLockCause" = 'AUTO_MORA'
              )
              OR (
                binding."confirmedState" = 'LOCKED'
                AND binding."confirmedLockCause" = 'AUTO_MORA'
              )
              OR EXISTS (
                SELECT 1
                FROM "PadlockCommand" active_lock
                WHERE active_lock."bindingId" = binding."id"
                  AND active_lock."action" = 'LOCK'
                  AND active_lock."lockCause" = 'AUTO_MORA'
                  AND active_lock."status" = ANY($3::text[])
              )
              OR EXISTS (
                SELECT 1
                FROM "PadlockCommand" attempted_lock
                WHERE attempted_lock."bindingId" = binding."id"
                  AND attempted_lock."action" = 'LOCK'
                  AND attempted_lock."lockCause" = 'AUTO_MORA'
                  AND attempted_lock."providerAttemptCount" > 0
                  AND attempted_lock."lastProviderAttemptStartedAt" IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "PadlockCommand" compensating_unlock
                    WHERE compensating_unlock."bindingId" = binding."id"
                      AND compensating_unlock."action" = 'UNLOCK'
                    AND compensating_unlock."status" = 'CONFIRMED'
                    AND compensating_unlock."confirmedAt"
                        >= COALESCE(
                          attempted_lock."lastProviderAttemptCompletedAt",
                          attempted_lock."lastProviderAttemptStartedAt"
                        )
                  )
              )
            )
          )
        )
      ORDER BY binding."creditId"
      LIMIT $1
    `,
    limit,
    purpose,
    [...ACTIVE_COMMAND_STATUSES],
    afterCreditId
  );
  return rows.map((row) => Number(row.creditId));
}

export async function listPadlockBindings(options?: {
  limit?: number;
  offset?: number;
  status?: "ACTIVE" | "RETIRED";
}) {
  const limit = asInteger(options?.limit ?? 100, "PADLOCK_LIMIT_INVALID", {
    min: 1,
    max: 500,
  });
  const offset = asInteger(options?.offset ?? 0, "PADLOCK_OFFSET_INVALID", {
    min: 0,
    max: 1_000_000,
  });
  const status = options?.status || "ACTIVE";
  const rows = await database.$queryRawUnsafe<
    Array<
      BindingRow & {
        folio: string;
        clienteNombre: string;
        allyName: string | null;
        creditImei: string;
        creditPlatform: string | null;
      }
    >
  >(
    `
      SELECT binding.*, credit."folio", credit."clienteNombre",
        credit."imei" AS "creditImei", ally."nombre" AS "allyName",
        COALESCE(
          NULLIF(credit."contratoSnapshot"->'equipo'->>'plataforma', ''),
          NULLIF(liquidated."plataforma", '')
        ) AS "creditPlatform"
      FROM "PadlockDeviceBinding" binding
      JOIN "Credito" credit ON credit."id" = binding."creditId"
      JOIN "Sede" branch ON branch."id" = credit."sedeId"
      LEFT JOIN "Aliado" ally ON ally."id" = branch."aliadoId"
      LEFT JOIN "LiquidacionAliadoCredito" liquidated
        ON liquidated."creditoId" = credit."id"
      WHERE binding."status" = $1
      ORDER BY binding."updatedAt" DESC, binding."id"
      LIMIT $2 OFFSET $3
    `,
    status,
    limit,
    offset
  );
  return rows.map((row) => ({
    id: row.id,
    creditId: row.creditId,
    folio: row.folio,
    clienteNombre: safeText(row.clienteNombre, 160),
    allyName: row.allyName,
    imeiMasked: maskImei(row.imei),
    product: row.product,
    status: row.status,
    verifiedAt: row.verifiedAt,
    desiredState: row.desiredState,
    desiredVersion: Number(row.desiredVersion),
    desiredLockCause: row.desiredLockCause,
    confirmedState: row.confirmedState,
    confirmedLockCause: row.confirmedLockCause,
    lastProviderState: row.lastProviderState,
    lastConfirmedAt: row.lastConfirmedAt,
    bindingConsistent:
      row.imei.trim() === String(row.creditImei || "").trim() &&
      String(row.creditPlatform || "").trim().toUpperCase() === PADLOCK_PRODUCT,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function retirePadlockBinding(input: {
  bindingId: string;
  actorUserId: number;
  reason: string;
  correlationId?: string;
}) {
  const bindingId = requiredUuid(input.bindingId, "PADLOCK_BINDING_ID_INVALID");
  const actorUserId = asInteger(
    input.actorUserId,
    "PADLOCK_ACTOR_INVALID",
    { min: 1 }
  );
  const reason = requiredReason(input.reason);
  const correlationId = input.correlationId
    ? requiredCorrelationId(input.correlationId)
    : randomUUID();

  return inTransaction(async (transaction) => {
    await lockKeys(transaction, [`padlock:binding:${bindingId}`]);
    const rows = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        SELECT *
        FROM "PadlockDeviceBinding"
        WHERE "id" = $1::uuid
        LIMIT 1
        FOR UPDATE
      `,
      bindingId
    );
    const binding = rows[0];
    if (!binding) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_NOT_FOUND",
        "El binding Padlock no existe.",
        404
      );
    }
    if (binding.status === "RETIRED") return { retired: false, alreadyRetired: true };
    if (
      binding.desiredState === "LOCKED" ||
      binding.confirmedState === "LOCKED"
    ) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_LOCKED",
        "El dispositivo debe quedar desbloqueado y confirmado antes de retirar el binding.",
        409
      );
    }
    const unresolvedProviderAttempt = await transaction.$queryRawUnsafe<
      Array<{ id: string }>
    >(
      `
        SELECT "id"::text
        FROM "PadlockCommand"
        WHERE "bindingId" = $1::uuid
          AND "providerAttemptCount" > 0
          AND "lastProviderAttemptStartedAt" IS NOT NULL
          AND (
            "lastProviderAttemptCompletedAt" IS NULL
            OR "lastProviderAttemptCompletedAt" < "lastProviderAttemptStartedAt"
          )
        LIMIT 1
        FOR UPDATE
      `,
      bindingId
    );
    if (unresolvedProviderAttempt[0]) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_PROVIDER_OUTCOME_UNRESOLVED",
        "No se puede retirar el binding mientras exista un resultado remoto sin conciliar.",
        409
      );
    }
    const processing = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT "id"::text
        FROM "PadlockCommand"
        WHERE "bindingId" = $1::uuid
          AND "status" = 'PROCESSING'
        LIMIT 1
        FOR UPDATE
      `,
      bindingId
    );
    if (processing[0]) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_BUSY",
        "No se puede retirar el binding mientras existe un despacho en curso.",
        409
      );
    }
    const commands = await transaction.$queryRawUnsafe<
      Array<{ id: string; status: PadlockCommandStatus; action: PadlockAction }>
    >(
      `
        SELECT "id"::text, "status", "action"
        FROM "PadlockCommand"
        WHERE "bindingId" = $1::uuid
          AND "status" = ANY($2::text[])
        FOR UPDATE
      `,
      bindingId,
      ["PENDING", "RETRY"]
    );
    for (const command of commands) {
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = 'CANCELLED', "cancelledAt" = CURRENT_TIMESTAMP,
            "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastErrorCode" = 'BINDING_RETIRED', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
        `,
        command.id
      );
    }
    await transaction.$executeRawUnsafe(
      `
        UPDATE "PadlockDeviceBinding"
        SET "status" = 'RETIRED', "retiredAt" = CURRENT_TIMESTAMP,
          "desiredState" = 'UNKNOWN', "desiredLockCause" = NULL,
          "desiredVersion" = "desiredVersion" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
      `,
      bindingId
    );
    for (const command of commands) {
      await appendAudit(transaction, {
        bindingId,
        commandId: command.id,
        creditId: binding.creditId,
        eventType: "COMMAND_CANCELLED",
        action: command.action,
        fromStatus: command.status,
        toStatus: "CANCELLED",
        reasonCode: "BINDING_RETIRED",
        actorType: "USER",
        actorUserId,
        operatorReason: reason,
        correlationId,
      });
    }
    await appendAudit(transaction, {
      bindingId,
      creditId: binding.creditId,
      eventType: "BINDING_RETIRED",
      reasonCode: "OPERATOR_REQUEST",
      desiredVersion: Number(binding.desiredVersion) + 1,
      actorType: "USER",
      actorUserId,
      operatorReason: reason,
      correlationId,
    });
    return { retired: true, alreadyRetired: false };
  });
}

type CommandRow = {
  id: string;
  bindingId: string;
  creditId: number;
  policyRevisionId: string | null;
  action: PadlockAction;
  lockCause: PadlockLockCause | null;
  desiredVersion: number;
  idempotencyKey: string;
  status: PadlockCommandStatus;
  source: string;
  correlationId: string;
  operatorReason: string | null;
  scheduleSlotAt: Date | null;
  decisionFinancialState: "MORA" | "AL_DIA" | "SETTLED";
  decisionDaysPastDue: number;
  decisionOutstandingBalance: number;
  decisionEffectiveDueDate: Date | null;
  evaluatedAt: Date;
  attemptCount: number;
  providerAttemptCount: number;
  lastProviderAttemptStartedAt: Date | null;
  lastProviderAttemptCompletedAt: Date | null;
  providerTransitionObservedAt: Date | null;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
  lastProviderState: PadlockProviderState | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type EnqueueDesiredInput = {
  binding: BindingRow;
  expectedDesiredVersion: number;
  action: PadlockAction;
  commandLockCause: PadlockLockCause | null;
  targetLockCause: PadlockLockCause | null;
  policyRevisionId: string | null;
  source: string;
  correlationId: string;
  operatorReason: string | null;
  scheduleSlotAt: Date | null;
  evaluatedAt: Date;
  position: ReturnType<typeof buildPadlockFinancialPosition>;
  actorType: "SYSTEM" | "USER";
  actorUserId?: number | null;
  allowTerminalRecovery?: boolean;
  reasonCode: string;
};

async function enqueueDesiredCommandWith(
  transaction: PadlockSqlDatabase,
  input: EnqueueDesiredInput
): Promise<PadlockDecisionCommitResult> {
  const activeCommands = await transaction.$queryRawUnsafe<CommandRow[]>(
    `
      SELECT *
      FROM "PadlockCommand"
      WHERE "bindingId" = $1::uuid
        AND "status" = ANY($2::text[])
      ORDER BY "desiredVersion", "createdAt"
      FOR UPDATE
    `,
    input.binding.id,
    [...ACTIVE_COMMAND_STATUSES]
  );
  const targetState = input.action === "LOCK" ? "LOCKED" : "UNLOCKED";
  const recoverable = input.allowTerminalRecovery
    ? await transaction.$queryRawUnsafe<Array<{ id: string }>>(
        `
          SELECT "id"::text
          FROM "PadlockCommand"
          WHERE "bindingId" = $1::uuid
            AND "desiredVersion" = $2::integer
            AND "action" = $3
            AND "status" IN ('ERROR', 'REVIEW_REQUIRED')
          ORDER BY "updatedAt" DESC
          LIMIT 1
          FOR UPDATE
        `,
        input.binding.id,
        input.binding.desiredVersion,
        input.action
      )
    : [];
  const targetIsConfirmed =
    input.action === "LOCK"
      ? input.binding.confirmedState === "LOCKED" &&
        input.binding.confirmedLockCause === input.targetLockCause
      : input.binding.confirmedState === "UNLOCKED";
  const mutation = planPadlockCommandMutation({
    currentDesiredState: input.binding.desiredState,
    currentDesiredLockCause: input.binding.desiredLockCause,
    currentDesiredVersion: Number(input.binding.desiredVersion),
    expectedDesiredVersion: input.expectedDesiredVersion,
    targetState,
    targetLockCause: input.targetLockCause,
    activeCommandIds: activeCommands.map((command) => command.id),
    forceNewVersion:
      Boolean(recoverable[0]) &&
      activeCommands.length === 0 &&
      !targetIsConfirmed,
  });
  if (mutation.kind === "STALE") {
    return { kind: "STALE", desiredVersion: mutation.desiredVersion };
  }
  if (mutation.kind === "UNCHANGED") {
    const current = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
      `
        SELECT "id"::text
        FROM "PadlockCommand"
        WHERE "bindingId" = $1::uuid
          AND "desiredVersion" = $2
        LIMIT 1
      `,
      input.binding.id,
      mutation.desiredVersion
    );
    if (input.actorType === "USER") {
      await appendAudit(transaction, {
        bindingId: input.binding.id,
        commandId: current[0]?.id || null,
        policyRevisionId: input.policyRevisionId,
        creditId: input.binding.creditId,
        eventType: "MANUAL_COMMAND_NOOP",
        action: input.action,
        fromStatus: input.binding.desiredState,
        toStatus: input.binding.desiredState,
        reasonCode: "MANUAL_TARGET_ALREADY_DESIRED",
        operatorReason: input.operatorReason,
        desiredVersion: mutation.desiredVersion,
        actorType: "USER",
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
      });
    }
    return {
      kind: "UNCHANGED",
      commandId: current[0]?.id || null,
      desiredVersion: mutation.desiredVersion,
    };
  }

  for (const command of activeCommands) {
    if (hasUnresolvedPadlockProviderAttempt(command)) {
      await appendAudit(transaction, {
        bindingId: input.binding.id,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: input.binding.creditId,
        eventType: "COMMAND_SUPERSESSION_DEFERRED",
        action: command.action,
        fromStatus: command.status,
        toStatus: command.status,
        reasonCode: "PROVIDER_ATTEMPT_OUTCOME_UNPROVEN",
        operatorReason: input.operatorReason,
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: Number(command.attemptCount),
        actorType: input.actorType,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
      });
      continue;
    }
    await transaction.$executeRawUnsafe(
      `
        UPDATE "PadlockCommand"
        SET "status" = 'SUPERSEDED', "supersededAt" = CURRENT_TIMESTAMP,
          "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
          "lastErrorCode" = 'DESIRED_STATE_CHANGED',
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "status" = ANY($2::text[])
      `,
      command.id,
      [...ACTIVE_COMMAND_STATUSES]
    );
    await appendAudit(transaction, {
      bindingId: input.binding.id,
      commandId: command.id,
      policyRevisionId: command.policyRevisionId,
      creditId: input.binding.creditId,
      eventType: "COMMAND_SUPERSEDED",
      action: command.action,
      fromStatus: command.status,
      toStatus: "SUPERSEDED",
      reasonCode: "DESIRED_STATE_CHANGED",
      desiredVersion: Number(command.desiredVersion),
      attemptNumber: Number(command.attemptCount),
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      operatorReason: input.operatorReason,
      correlationId: input.correlationId,
    });
  }

  await transaction.$executeRawUnsafe(
    `
      UPDATE "PadlockDeviceBinding"
      SET "desiredState" = $2, "desiredLockCause" = $3,
        "desiredVersion" = $4::integer, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1::uuid
        AND "desiredVersion" = $5::integer
    `,
    input.binding.id,
    targetState,
    input.targetLockCause,
    mutation.desiredVersion,
    input.expectedDesiredVersion
  );
  const commandId = randomUUID();
  const idempotencyKey =
    `PADLOCK:${input.binding.id}:${mutation.desiredVersion}:${input.action}`;
  await transaction.$executeRawUnsafe(
    `
      INSERT INTO "PadlockCommand" (
        "id", "bindingId", "creditId", "policyRevisionId", "action",
        "lockCause", "desiredVersion", "idempotencyKey", "status", "source",
        "correlationId", "operatorReason", "scheduleSlotAt",
        "decisionFinancialState", "decisionDaysPastDue",
        "decisionOutstandingBalance", "decisionEffectiveDueDate", "evaluatedAt",
        "attemptCount", "maxAttempts", "availableAt", "createdAt", "updatedAt"
      )
      VALUES (
        $1::uuid, $2::uuid, $3::integer, $4::uuid, $5,
        $6, $7::integer, $8, 'PENDING', $9,
        $10::uuid, $11, $12::timestamp,
        $13, $14::integer,
        $15::numeric, $16::date, $17::timestamp,
        0, $18::integer, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `,
    commandId,
    input.binding.id,
    input.binding.creditId,
    input.policyRevisionId,
    input.action,
    input.commandLockCause,
    mutation.desiredVersion,
    idempotencyKey,
    input.source,
    input.correlationId,
    input.operatorReason,
    input.scheduleSlotAt,
    input.position.state,
    input.position.daysPastDue,
    input.position.outstandingBalance,
    input.position.effectiveDueDate,
    input.evaluatedAt,
    PADLOCK_DEFAULT_MAX_ATTEMPTS
  );
  await appendAudit(transaction, {
    bindingId: input.binding.id,
    commandId,
    policyRevisionId: input.policyRevisionId,
    creditId: input.binding.creditId,
    eventType: "COMMAND_ENQUEUED",
    action: input.action,
    fromStatus: null,
    toStatus: "PENDING",
    reasonCode: input.reasonCode,
    desiredVersion: mutation.desiredVersion,
    attemptNumber: 0,
    actorType: input.actorType,
    actorUserId: input.actorUserId,
    operatorReason: input.operatorReason,
    correlationId: input.correlationId,
  });
  return {
    kind: "ENQUEUED",
    commandId,
    desiredVersion: mutation.desiredVersion,
  };
}

async function commitAutomaticDecision(input: {
  creditId: number;
  bindingId: string;
  expectedDesiredVersion: number;
  trigger: PadlockEvaluationTrigger;
  decision: Extract<PadlockDecision, { kind: "QUEUE" }>;
  evaluatedAt: Date;
  source: string;
  correlationId: string;
}) {
  const correlationId = requiredCorrelationId(input.correlationId);
  const source = safeCode(input.source, "AUTOMATIC_EVALUATION", 64);
  if (source === "MANUAL") {
    throw new PadlockStorageError(
      "PADLOCK_AUTOMATIC_SOURCE_INVALID",
      "Una evaluacion automatica no puede usar fuente MANUAL.",
      400
    );
  }

  return inTransaction(async (transaction) => {
    await lockKeys(transaction, [`padlock:binding:${input.bindingId}`]);
    const rows = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        SELECT *
        FROM "PadlockDeviceBinding"
        WHERE "id" = $1::uuid
          AND "creditId" = $2
          AND "status" = 'ACTIVE'
        LIMIT 1
        FOR UPDATE
      `,
      input.bindingId,
      input.creditId
    );
    const binding = rows[0];
    if (!binding) {
      return { kind: "STALE", desiredVersion: -1 } as const;
    }
    const context = await loadEvaluationContextWith(
      transaction,
      input.creditId,
      input.evaluatedAt
    );
    if (
      !context ||
      context.binding.id !== input.bindingId ||
      context.binding.desiredVersion !== input.expectedDesiredVersion
    ) {
      return {
        kind: "STALE",
        desiredVersion: context?.binding.desiredVersion ?? -1,
      } as const;
    }
    const revalidatedDecision = decidePadlockAction({
      context,
      trigger: input.trigger,
      now: input.evaluatedAt,
      lockScheduleSlotAt: input.decision.scheduleSlotAt,
    });
    if (
      revalidatedDecision.kind !== "QUEUE" ||
      revalidatedDecision.action !== input.decision.action ||
      revalidatedDecision.reason !== input.decision.reason ||
      revalidatedDecision.policyRevisionId !== input.decision.policyRevisionId
    ) {
      return {
        kind: "STALE",
        desiredVersion: context.binding.desiredVersion,
      } as const;
    }
    return enqueueDesiredCommandWith(transaction, {
      binding,
      expectedDesiredVersion: input.expectedDesiredVersion,
      action: input.decision.action,
      commandLockCause: input.decision.lockCause,
      targetLockCause:
        input.decision.action === "LOCK" ? input.decision.lockCause : null,
      policyRevisionId: input.decision.policyRevisionId,
      source,
      correlationId,
      operatorReason: null,
      scheduleSlotAt: input.decision.scheduleSlotAt,
      evaluatedAt: input.evaluatedAt,
      position: revalidatedDecision.position,
      actorType: "SYSTEM",
      reasonCode: input.decision.reason,
    });
  });
}

export const padlockEngineRepository: PadlockEngineRepository = {
  loadEvaluationContext: loadPadlockEvaluationContext,
  commitDecision: commitAutomaticDecision,
};

export async function enqueueManualPadlockCommand(input: {
  bindingId: string;
  action: PadlockAction;
  lockCause?: Exclude<PadlockLockCause, "AUTO_MORA">;
  actorUserId: number;
  reason: string;
  correlationId?: string;
  now?: Date;
}) {
  const bindingId = requiredUuid(input.bindingId, "PADLOCK_BINDING_ID_INVALID");
  const actorUserId = asInteger(
    input.actorUserId,
    "PADLOCK_ACTOR_INVALID",
    { min: 1 }
  );
  const action = input.action;
  if (action !== "LOCK" && action !== "UNLOCK") {
    throw new PadlockStorageError(
      "PADLOCK_ACTION_INVALID",
      "Accion Padlock invalida.",
      400
    );
  }
  const reason = requiredReason(input.reason);
  const correlationId = input.correlationId
    ? requiredCorrelationId(input.correlationId)
    : randomUUID();
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_EVALUATED_AT_INVALID",
      "Fecha de evaluacion Padlock invalida.",
      400
    );
  }
  const requestedLockCause = input.lockCause || "MANUAL";
  if (!["MANUAL", "ROBO", "FRAUDE"].includes(requestedLockCause)) {
    throw new PadlockStorageError(
      "PADLOCK_LOCK_CAUSE_INVALID",
      "Causa manual Padlock invalida.",
      400
    );
  }

  return inTransaction(async (transaction) => {
    await lockKeys(transaction, [`padlock:binding:${bindingId}`]);
    const rows = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        SELECT *
        FROM "PadlockDeviceBinding"
        WHERE "id" = $1::uuid
          AND "status" = 'ACTIVE'
        LIMIT 1
        FOR UPDATE
      `,
      bindingId
    );
    const binding = rows[0];
    if (!binding) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_NOT_FOUND",
        "El binding Padlock activo no existe.",
        404
      );
    }
    const context = await loadEvaluationContextWith(
      transaction,
      binding.creditId,
      now
    );
    if (
      !context ||
      context.binding.product !== PADLOCK_PRODUCT ||
      context.binding.creditPlatform?.trim().toUpperCase() !== PADLOCK_PRODUCT ||
      context.binding.imei !== context.binding.creditImei
    ) {
      throw new PadlockStorageError(
        "PADLOCK_BINDING_NOT_DISPATCHABLE",
        "El binding iPhone ya no coincide con el credito.",
        409
      );
    }
    if (action === "UNLOCK" && context.binding.creditTheftLockActive) {
      throw new PadlockStorageError(
        "PADLOCK_THEFT_LOCK_ACTIVE",
        "Retira primero el bloqueo canonico por robo antes de solicitar el desbloqueo Padlock.",
        409
      );
    }
    const position = buildPadlockFinancialPosition(context.financial, now);
    const commandLockCause =
      action === "LOCK"
        ? requestedLockCause
        : binding.desiredLockCause || binding.confirmedLockCause;
    return enqueueDesiredCommandWith(transaction, {
      binding,
      expectedDesiredVersion: Number(binding.desiredVersion),
      action,
      commandLockCause,
      targetLockCause: action === "LOCK" ? requestedLockCause : null,
      policyRevisionId: context.policy?.id || null,
      source: "MANUAL",
      correlationId,
      operatorReason: reason,
      scheduleSlotAt: null,
      evaluatedAt: now,
      position,
      actorType: "USER",
      actorUserId,
      allowTerminalRecovery: true,
      reasonCode:
        action === "LOCK" ? "MANUAL_LOCK_REQUESTED" : "MANUAL_UNLOCK_REQUESTED",
    });
  });
}

export async function requeuePadlockCommandReconciliation(input: {
  commandId: string;
  actorUserId: number;
  reason: string;
  correlationId?: string;
  now?: Date;
}) {
  const commandId = requiredUuid(input.commandId, "PADLOCK_COMMAND_ID_INVALID");
  const actorUserId = asInteger(
    input.actorUserId,
    "PADLOCK_ACTOR_INVALID",
    { min: 1 }
  );
  const reason = requiredReason(input.reason);
  const correlationId = input.correlationId
    ? requiredCorrelationId(input.correlationId)
    : randomUUID();
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_RECONCILIATION_TIME_INVALID",
      "Fecha de conciliación Padlock inválida.",
      400
    );
  }

  return inTransaction(async (transaction) => {
    const identity = await transaction.$queryRawUnsafe<
      Array<{ bindingId: string }>
    >(
      'SELECT "bindingId"::text FROM "PadlockCommand" WHERE "id" = $1::uuid LIMIT 1',
      commandId
    );
    if (!identity[0]) {
      throw new PadlockStorageError(
        "PADLOCK_COMMAND_NOT_FOUND",
        "El comando Padlock no existe.",
        404
      );
    }

    await lockKeys(transaction, [`padlock:binding:${identity[0].bindingId}`]);
    const commands = await transaction.$queryRawUnsafe<CommandRow[]>(
      'SELECT * FROM "PadlockCommand" WHERE "id" = $1::uuid LIMIT 1 FOR UPDATE',
      commandId
    );
    const command = commands[0];
    const bindings = await transaction.$queryRawUnsafe<BindingRow[]>(
      'SELECT * FROM "PadlockDeviceBinding" WHERE "id" = $1::uuid LIMIT 1 FOR UPDATE',
      command?.bindingId || identity[0].bindingId
    );
    const binding = bindings[0];
    if (!command || !binding || binding.status !== "ACTIVE") {
      throw new PadlockStorageError(
        "PADLOCK_RECONCILIATION_TARGET_NOT_ACTIVE",
        "El comando o su vinculación ya no están activos.",
        409
      );
    }
    if (command.status !== "REVIEW_REQUIRED") {
      throw new PadlockStorageError(
        "PADLOCK_RECONCILIATION_NOT_REQUIRED",
        "El comando no está esperando revisión.",
        409
      );
    }
    if (!hasUnresolvedPadlockProviderAttempt(command)) {
      throw new PadlockStorageError(
        "PADLOCK_RECONCILIATION_NOT_SAFE",
        "El comando no tiene un intento remoto pendiente que pueda conciliarse solo por consulta.",
        409
      );
    }

    const updated = await transaction.$executeRawUnsafe(
      `
        UPDATE "PadlockCommand"
        SET "status" = 'RETRY', "attemptCount" = 0,
          "availableAt" = $2::timestamp,
          "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
          "lastErrorCode" = 'MANUAL_GET_ONLY_RECONCILIATION_REQUESTED',
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "status" = 'REVIEW_REQUIRED'
      `,
      command.id,
      now
    );
    if (updated !== 1) {
      throw new PadlockStorageError(
        "PADLOCK_RECONCILIATION_RACE",
        "El comando cambió mientras se solicitaba la conciliación.",
        409
      );
    }

    await appendAudit(transaction, {
      bindingId: binding.id,
      commandId: command.id,
      policyRevisionId: command.policyRevisionId,
      creditId: command.creditId,
      eventType: "COMMAND_RECONCILIATION_REQUEUED",
      action: command.action,
      fromStatus: command.status,
      toStatus: "RETRY",
      reasonCode: "MANUAL_GET_ONLY_RECONCILIATION_REQUESTED",
      operatorReason: reason,
      desiredVersion: Number(command.desiredVersion),
      attemptNumber: Number(command.attemptCount),
      actorType: "USER",
      actorUserId,
      correlationId,
    });

    return {
      kind: "REQUEUED" as const,
      commandId: command.id,
      bindingId: binding.id,
      desiredVersion: Number(command.desiredVersion),
    };
  });
}

export type ClaimedPadlockCommand = {
  id: string;
  bindingId: string;
  creditId: number;
  action: PadlockAction;
  desiredVersion: number;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export async function claimPadlockCommands(input: {
  workerId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
}) {
  const workerId = safeText(input.workerId, 100);
  if (workerId.length < 3) {
    throw new PadlockStorageError(
      "PADLOCK_WORKER_ID_INVALID",
      "Identificador de worker Padlock invalido.",
      400
    );
  }
  const limit = asInteger(input.limit ?? 20, "PADLOCK_LIMIT_INVALID", {
    min: 1,
    max: 100,
  });
  const leaseMs = asInteger(
    input.leaseMs ?? 120_000,
    "PADLOCK_LEASE_INVALID",
    { min: 15_000, max: 600_000 }
  );
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_CLAIM_TIME_INVALID",
      "Fecha de claim Padlock invalida.",
      400
    );
  }
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const leaseToken = randomUUID();

  return inTransaction(async (transaction) => {
    const exhausted = await transaction.$queryRawUnsafe<CommandRow[]>(
      `
        SELECT *
        FROM "PadlockCommand"
        WHERE (
          ("status" IN ('PENDING', 'RETRY') AND "availableAt" <= $1::timestamp)
          OR (
            "status" = 'PROCESSING'
            AND "leaseExpiresAt" IS NOT NULL
            AND "leaseExpiresAt" <= $1::timestamp
          )
        )
          AND "attemptCount" >= "maxAttempts"
          AND "providerTransitionObservedAt" IS NULL
        ORDER BY "availableAt", "createdAt"
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      now,
      limit
    );
    for (const command of exhausted) {
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = 'REVIEW_REQUIRED',
            "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastErrorCode" = 'MAX_ATTEMPTS_REACHED',
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
        `,
        command.id
      );
      await appendAudit(transaction, {
        bindingId: command.bindingId,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: command.creditId,
        eventType: "COMMAND_REVIEW_REQUIRED",
        action: command.action,
        fromStatus: command.status,
        toStatus: "REVIEW_REQUIRED",
        reasonCode: "MAX_ATTEMPTS_REACHED",
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: Number(command.attemptCount),
        actorType: "WORKER",
        correlationId: command.correlationId,
      });
    }

    const due = await transaction.$queryRawUnsafe<CommandRow[]>(
      `
        SELECT candidate.*
        FROM "PadlockCommand" candidate
        WHERE (
          (candidate."status" IN ('PENDING', 'RETRY')
            AND candidate."availableAt" <= $1::timestamp)
          OR (
            candidate."status" = 'PROCESSING'
            AND candidate."leaseExpiresAt" IS NOT NULL
            AND candidate."leaseExpiresAt" <= $1::timestamp
          )
        )
          AND (
            candidate."attemptCount" < candidate."maxAttempts"
            OR candidate."providerTransitionObservedAt" IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "PadlockCommand" prior_attempt
            WHERE prior_attempt."bindingId" = candidate."bindingId"
              AND prior_attempt."id" <> candidate."id"
              AND prior_attempt."providerAttemptCount" > 0
              AND prior_attempt."lastProviderAttemptStartedAt" IS NOT NULL
              AND (
                prior_attempt."lastProviderAttemptCompletedAt" IS NULL
                OR prior_attempt."lastProviderAttemptCompletedAt"
                  < prior_attempt."lastProviderAttemptStartedAt"
              )
          )
        ORDER BY
          CASE WHEN candidate."action" = 'UNLOCK' THEN 0 ELSE 1 END,
          candidate."availableAt",
          candidate."createdAt"
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      `,
      now,
      limit
    );
    const claimed: ClaimedPadlockCommand[] = [];
    for (const command of due) {
      const attemptCount = Number(command.attemptCount) + 1;
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = 'PROCESSING', "attemptCount" = $2::integer,
            "leaseOwner" = $3, "leaseToken" = $4::uuid,
            "leaseExpiresAt" = $5::timestamp,
            "lastErrorCode" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
        `,
        command.id,
        attemptCount,
        workerId,
        leaseToken,
        leaseExpiresAt
      );
      await appendAudit(transaction, {
        bindingId: command.bindingId,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: command.creditId,
        eventType: "COMMAND_CLAIMED",
        action: command.action,
        fromStatus: command.status,
        toStatus: "PROCESSING",
        reasonCode:
          command.status === "PROCESSING" ? "EXPIRED_LEASE_RECLAIMED" : "DUE_COMMAND",
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: attemptCount,
        actorType: "WORKER",
        correlationId: command.correlationId,
      });
      claimed.push({
        id: command.id,
        bindingId: command.bindingId,
        creditId: command.creditId,
        action: command.action,
        desiredVersion: Number(command.desiredVersion),
        attemptCount,
        maxAttempts: Number(command.maxAttempts),
        leaseOwner: workerId,
        leaseToken,
        leaseExpiresAt,
      });
    }
    return claimed;
  });
}

async function supersedeUndispatchedCommand(
  transaction: PadlockSqlDatabase,
  command: CommandRow,
  binding: BindingRow,
  reasonCode: string
) {
  await transaction.$executeRawUnsafe(
    `
      UPDATE "PadlockCommand"
      SET "status" = 'SUPERSEDED', "supersededAt" = CURRENT_TIMESTAMP,
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "lastErrorCode" = $2, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1::uuid
        AND "status" = 'PROCESSING'
    `,
    command.id,
    safeCode(reasonCode, "COMMAND_NO_LONGER_ELIGIBLE", 64)
  );
  if (Number(binding.desiredVersion) === Number(command.desiredVersion)) {
    await transaction.$executeRawUnsafe(
      `
        UPDATE "PadlockDeviceBinding"
        SET "desiredState" = "confirmedState",
          "desiredLockCause" = "confirmedLockCause",
          "desiredVersion" = "desiredVersion" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
          AND "desiredVersion" = $2::integer
      `,
      binding.id,
      command.desiredVersion
    );
  }
  await appendAudit(transaction, {
    bindingId: binding.id,
    commandId: command.id,
    policyRevisionId: command.policyRevisionId,
    creditId: command.creditId,
    eventType: "COMMAND_SUPERSEDED",
    action: command.action,
    fromStatus: command.status,
    toStatus: "SUPERSEDED",
    reasonCode,
    desiredVersion: Number(command.desiredVersion),
    attemptNumber: Number(command.attemptCount),
    actorType: "WORKER",
    correlationId: command.correlationId,
  });
}

async function findPriorOpenProviderAttempt(
  transaction: PadlockSqlDatabase,
  command: CommandRow
) {
  const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    `
      SELECT prior_attempt."id"::text
      FROM "PadlockCommand" prior_attempt
      WHERE prior_attempt."bindingId" = $1::uuid
        AND prior_attempt."id" <> $2::uuid
        AND prior_attempt."providerAttemptCount" > 0
        AND prior_attempt."lastProviderAttemptStartedAt" IS NOT NULL
        AND (
          prior_attempt."lastProviderAttemptCompletedAt" IS NULL
          OR prior_attempt."lastProviderAttemptCompletedAt"
            < prior_attempt."lastProviderAttemptStartedAt"
        )
      ORDER BY prior_attempt."lastProviderAttemptStartedAt", prior_attempt."createdAt"
      LIMIT 1
      FOR UPDATE
    `,
    command.bindingId,
    command.id
  );
  return rows[0] || null;
}

async function deferClaimedCommandForPriorProviderAttempt(
  transaction: PadlockSqlDatabase,
  command: CommandRow,
  binding: BindingRow,
  now: Date,
  workerId: string,
  leaseToken: string
) {
  const retryAt = new Date(now.getTime() + 30_000);
  const deferred = await transaction.$executeRawUnsafe(
    `
      UPDATE "PadlockCommand"
      SET "status" = 'RETRY', "availableAt" = $4::timestamp,
        "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
        "lastErrorCode" = 'PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT',
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1::uuid
        AND "status" = 'PROCESSING'
        AND "leaseOwner" = $2
        AND "leaseToken" = $3::uuid
    `,
    command.id,
    workerId,
    leaseToken,
    retryAt
  );
  if (deferred !== 1) return false;
  await appendAudit(transaction, {
    bindingId: binding.id,
    commandId: command.id,
    policyRevisionId: command.policyRevisionId,
    creditId: command.creditId,
    eventType: "COMMAND_RETRY_SCHEDULED",
    action: command.action,
    fromStatus: command.status,
    toStatus: "RETRY",
    reasonCode: "PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT",
    desiredVersion: Number(command.desiredVersion),
    attemptNumber: Number(command.attemptCount),
    actorType: "WORKER",
    correlationId: command.correlationId,
  });
  return true;
}

export type PreparedPadlockDispatch =
  | {
      ready: true;
      command: {
        id: string;
        creditId: number;
        bindingId: string;
        imei: string;
        action: PadlockAction;
        lockCause: PadlockLockCause | null;
        desiredVersion: number;
        idempotencyKey: string;
        correlationId: string;
        attemptCount: number;
        hadProviderAttempt: boolean;
        reconciliationOnly: boolean;
        maxAttempts: number;
        leaseOwner: string;
        leaseToken: string;
      };
    }
  | {
      ready: false;
      code:
        | "COMMAND_NOT_CLAIMED"
        | "COMMAND_STALE"
        | "COMMAND_NO_LONGER_ELIGIBLE"
        | "POLICY_REVISION_CHANGED"
        | "PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT"
        | "PROVIDER_POST_REPLAY_BLOCKED";
      reevaluateCreditId?: number;
    };

export async function preparePadlockCommandDispatch(input: {
  commandId: string;
  workerId: string;
  leaseToken: string;
  now?: Date;
  startProviderAttempt?: boolean;
}): Promise<PreparedPadlockDispatch> {
  const commandId = requiredUuid(input.commandId, "PADLOCK_COMMAND_ID_INVALID");
  const leaseToken = requiredUuid(input.leaseToken, "PADLOCK_LEASE_TOKEN_INVALID");
  const workerId = safeText(input.workerId, 100);
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_DISPATCH_TIME_INVALID",
      "Fecha de despacho Padlock invalida.",
      400
    );
  }

  return inTransaction(async (transaction) => {
    const identity = await transaction.$queryRawUnsafe<
      Array<{ bindingId: string }>
    >(
      'SELECT "bindingId"::text FROM "PadlockCommand" WHERE "id" = $1::uuid LIMIT 1',
      commandId
    );
    if (!identity[0]) return { ready: false, code: "COMMAND_NOT_CLAIMED" };
    await lockKeys(transaction, [`padlock:binding:${identity[0].bindingId}`]);
    const commands = await transaction.$queryRawUnsafe<CommandRow[]>(
      `
        SELECT *
        FROM "PadlockCommand"
        WHERE "id" = $1::uuid
        LIMIT 1
        FOR UPDATE
      `,
      commandId
    );
    const command = commands[0];
    const bindings = await transaction.$queryRawUnsafe<BindingRow[]>(
      `
        SELECT *
        FROM "PadlockDeviceBinding"
        WHERE "id" = $1::uuid
        LIMIT 1
        FOR UPDATE
      `,
      command?.bindingId || identity[0].bindingId
    );
    const binding = bindings[0];
    if (
      !command ||
      !binding ||
      command.status !== "PROCESSING" ||
      command.leaseOwner !== workerId ||
      command.leaseToken !== leaseToken ||
      !command.leaseExpiresAt ||
      new Date(command.leaseExpiresAt).getTime() <= now.getTime()
    ) {
      return { ready: false, code: "COMMAND_NOT_CLAIMED" };
    }
    const desiredMatches =
      binding.status === "ACTIVE" &&
      Number(binding.desiredVersion) === Number(command.desiredVersion) &&
      ((command.action === "LOCK" &&
        binding.desiredState === "LOCKED" &&
        binding.desiredLockCause === command.lockCause) ||
        (command.action === "UNLOCK" && binding.desiredState === "UNLOCKED"));
    // Once a POST has an unproven outcome, every later attempt is GET-only.
    // This applies even when the desired state has not changed: observing the
    // device before the delayed transition does not make replaying POST safe.
    const reconciliationOnly = hasUnresolvedPadlockProviderAttempt(command);
    if (input.startProviderAttempt === true && reconciliationOnly) {
      const retryAt = new Date(now.getTime() + 30_000);
      const blocked = await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = 'RETRY', "availableAt" = $4::timestamp,
            "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastErrorCode" = 'PROVIDER_POST_REPLAY_BLOCKED',
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
            AND "status" = 'PROCESSING'
            AND "leaseOwner" = $2
            AND "leaseToken" = $3::uuid
        `,
        command.id,
        workerId,
        leaseToken,
        retryAt
      );
      if (blocked === 1) {
        await appendAudit(transaction, {
          bindingId: binding.id,
          commandId: command.id,
          policyRevisionId: command.policyRevisionId,
          creditId: command.creditId,
          eventType: "PROVIDER_POST_REPLAY_BLOCKED",
          action: command.action,
          fromStatus: command.status,
          toStatus: "RETRY",
          reasonCode: "UNRESOLVED_PROVIDER_ATTEMPT",
          desiredVersion: Number(command.desiredVersion),
          attemptNumber: Number(command.attemptCount),
          actorType: "WORKER",
          correlationId: command.correlationId,
        });
      }
      return { ready: false, code: "PROVIDER_POST_REPLAY_BLOCKED" };
    }
    if (!desiredMatches && !reconciliationOnly) {
      await supersedeUndispatchedCommand(
        transaction,
        command,
        binding,
        "COMMAND_STALE"
      );
      return {
        ready: false,
        code: "COMMAND_STALE",
        reevaluateCreditId: command.creditId,
      };
    }

    const context = await loadEvaluationContextWith(
      transaction,
      command.creditId,
      now
    );
    if (!context && !reconciliationOnly) {
      await supersedeUndispatchedCommand(
        transaction,
        command,
        binding,
        "BINDING_NOT_ACTIVE"
      );
      return {
        ready: false,
        code: "COMMAND_NO_LONGER_ELIGIBLE",
        reevaluateCreditId: command.creditId,
      };
    }
    if (context && !reconciliationOnly && command.source !== "MANUAL") {
      const decision = decidePadlockAction({
        context,
        trigger: command.action === "LOCK" ? "LOCK_SCHEDULE" : "FINANCIAL_CHANGE",
        now,
        lockScheduleSlotAt: command.scheduleSlotAt,
        ignoreDesiredState: true,
      });
      if (
        decision.kind !== "QUEUE" ||
        decision.action !== command.action
      ) {
        await supersedeUndispatchedCommand(
          transaction,
          command,
          binding,
          decision.reason
        );
        return {
          ready: false,
          code: "COMMAND_NO_LONGER_ELIGIBLE",
          reevaluateCreditId: command.creditId,
        };
      }
      if (decision.policyRevisionId !== command.policyRevisionId) {
        await supersedeUndispatchedCommand(
          transaction,
          command,
          binding,
          "POLICY_REVISION_CHANGED"
        );
        return {
          ready: false,
          code: "POLICY_REVISION_CHANGED",
          reevaluateCreditId: command.creditId,
        };
      }
    } else if (
      context &&
      !reconciliationOnly &&
      (context.binding.product !== PADLOCK_PRODUCT ||
        context.binding.creditPlatform?.trim().toUpperCase() !== PADLOCK_PRODUCT ||
        context.binding.imei !== context.binding.creditImei ||
        (command.action === "UNLOCK" &&
          context.binding.creditTheftLockActive))
    ) {
      const reasonCode =
        command.action === "UNLOCK" && context.binding.creditTheftLockActive
          ? "THEFT_LOCK_ACTIVE"
          : "BINDING_NOT_DISPATCHABLE";
      await supersedeUndispatchedCommand(
        transaction,
        command,
        binding,
        reasonCode
      );
      return {
        ready: false,
        code: "COMMAND_NO_LONGER_ELIGIBLE",
        reevaluateCreditId: command.creditId,
      };
    }

    const priorOpenAttempt = await findPriorOpenProviderAttempt(
      transaction,
      command
    );
    if (priorOpenAttempt) {
      const deferred = await deferClaimedCommandForPriorProviderAttempt(
        transaction,
        command,
        binding,
        now,
        workerId,
        leaseToken
      );
      return {
        ready: false,
        code: deferred
          ? "PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT"
          : "COMMAND_NOT_CLAIMED",
      };
    }

    let providerAttemptCount = Number(command.providerAttemptCount || 0);
    if (input.startProviderAttempt === true) {
      const marked = await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "providerAttemptCount" = "providerAttemptCount" + 1,
            "lastProviderAttemptStartedAt" = $4::timestamp,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
            AND "status" = 'PROCESSING'
            AND "leaseOwner" = $2
            AND "leaseToken" = $3::uuid
            AND "leaseExpiresAt" > $4::timestamp
        `,
        command.id,
        workerId,
        leaseToken,
        now
      );
      if (marked !== 1) {
        return { ready: false, code: "COMMAND_NOT_CLAIMED" };
      }
      providerAttemptCount += 1;
      await appendAudit(transaction, {
        bindingId: binding.id,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: command.creditId,
        eventType: "PROVIDER_COMMAND_ATTEMPT_STARTED",
        action: command.action,
        fromStatus: "PROCESSING",
        toStatus: "PROCESSING",
        reasonCode: "PROVIDER_POST_ABOUT_TO_START",
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: providerAttemptCount,
        actorType: "WORKER",
        correlationId: command.correlationId,
      });
    }

    return {
      ready: true,
      command: {
        id: command.id,
        creditId: command.creditId,
        bindingId: command.bindingId,
        // An unresolved POST must be reconciled against the immutable binding
        // IMEI even if the credit context was later changed or became
        // unavailable. No new POST is allowed in that path.
        imei: context?.binding.imei || binding.imei,
        action: command.action,
        lockCause: command.lockCause,
        desiredVersion: Number(command.desiredVersion),
        idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
        attemptCount: Number(command.attemptCount),
        hadProviderAttempt: providerAttemptCount > 0,
        reconciliationOnly,
        maxAttempts: Number(command.maxAttempts),
        leaseOwner: workerId,
        leaseToken,
      },
    };
  });
}

export type PadlockProviderOutcome =
  | {
      kind: "CONFIRMED";
      providerState: "LOCKED" | "UNLOCKED";
      confirmationSource: "OBSERVED" | "COMMAND_RESULT";
    }
  | {
      kind: "PENDING";
      providerState: "LOCKING" | "UNLOCKING";
    }
  | {
      kind: "RETRY";
      errorCode: string;
      providerState?: PadlockProviderState | null;
    }
  | {
      kind: "ERROR";
      errorCode: string;
      providerState?: PadlockProviderState | null;
    }
  | {
      kind: "REVIEW";
      errorCode: string;
      providerState?: PadlockProviderState | null;
    }
  | {
      kind: "NOT_ENROLLED";
      providerState?: "NOT_ENROLLED";
    };

function normalizeProviderState(value: unknown): PadlockProviderState | null {
  const state = safeCode(value, "", 32);
  return [
    "UNKNOWN",
    "LOCKED",
    "UNLOCKED",
    "LOCKING",
    "UNLOCKING",
    "NOT_ENROLLED",
    "ERROR",
  ].includes(state)
    ? (state as PadlockProviderState)
    : null;
}

function padlockRetryAt(now: Date, attemptCount: number) {
  const exponent = Math.max(0, Math.min(6, attemptCount - 1));
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** exponent);
  return new Date(now.getTime() + delayMs);
}

function waitsForPadlockDeviceConnectivity(
  command: CommandRow,
  outcome: PadlockProviderOutcome,
  providerState: PadlockProviderState | null
) {
  return shouldKeepPadlockProviderAttemptPending({
    action: command.action,
    providerAttemptCount: Number(command.providerAttemptCount || 0),
    providerTransitionObservedAt: command.providerTransitionObservedAt,
    providerState,
    outcomeKind: outcome.kind,
  });
}

export async function recordPadlockCommandOutcome(input: {
  commandId: string;
  workerId: string;
  leaseToken: string;
  outcome: PadlockProviderOutcome;
  now?: Date;
}) {
  const commandId = requiredUuid(input.commandId, "PADLOCK_COMMAND_ID_INVALID");
  const leaseToken = requiredUuid(input.leaseToken, "PADLOCK_LEASE_TOKEN_INVALID");
  const workerId = safeText(input.workerId, 100);
  const now = input.now ? new Date(input.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new PadlockStorageError(
      "PADLOCK_OUTCOME_TIME_INVALID",
      "Fecha de resultado Padlock invalida.",
      400
    );
  }

  return inTransaction(async (transaction) => {
    const identity = await transaction.$queryRawUnsafe<
      Array<{ bindingId: string }>
    >(
      'SELECT "bindingId"::text FROM "PadlockCommand" WHERE "id" = $1::uuid LIMIT 1',
      commandId
    );
    if (!identity[0]) {
      throw new PadlockStorageError(
        "PADLOCK_COMMAND_NOT_FOUND",
        "El comando Padlock no existe.",
        404
      );
    }
    await lockKeys(transaction, [`padlock:binding:${identity[0].bindingId}`]);
    const commands = await transaction.$queryRawUnsafe<CommandRow[]>(
      'SELECT * FROM "PadlockCommand" WHERE "id" = $1::uuid LIMIT 1 FOR UPDATE',
      commandId
    );
    const command = commands[0];
    const bindings = await transaction.$queryRawUnsafe<BindingRow[]>(
      'SELECT * FROM "PadlockDeviceBinding" WHERE "id" = $1::uuid LIMIT 1 FOR UPDATE',
      command?.bindingId || identity[0].bindingId
    );
    const binding = bindings[0];
    if (
      !command ||
      !binding ||
      command.status !== "PROCESSING" ||
      command.leaseOwner !== workerId ||
      command.leaseToken !== leaseToken
    ) {
      throw new PadlockStorageError(
        "PADLOCK_LEASE_LOST",
        "El lease del comando Padlock ya no esta vigente.",
        409
      );
    }
    const providerState =
      input.outcome.kind === "NOT_ENROLLED"
        ? "NOT_ENROLLED"
        : normalizeProviderState(input.outcome.providerState);
    const expectedConfirmedState =
      command.action === "LOCK" ? "LOCKED" : "UNLOCKED";
    const confirmationSource =
      input.outcome.kind === "CONFIRMED"
        ? input.outcome.confirmationSource
        : null;
    const invalidConfirmationSource =
      input.outcome.kind === "CONFIRMED" &&
      confirmationSource !== "OBSERVED" &&
      confirmationSource !== "COMMAND_RESULT";
    const observedAutoMoraLockWithoutAttempt =
      input.outcome.kind === "CONFIRMED" &&
      confirmationSource === "OBSERVED" &&
      command.action === "LOCK" &&
      command.lockCause === "AUTO_MORA" &&
      Number(command.providerAttemptCount || 0) < 1;
    const commandResultWithoutAttempt =
      input.outcome.kind === "CONFIRMED" &&
      confirmationSource === "COMMAND_RESULT" &&
      Number(command.providerAttemptCount || 0) < 1;
    const validExpectedConfirmation =
      input.outcome.kind === "CONFIRMED" &&
      providerState === expectedConfirmedState &&
      !invalidConfirmationSource &&
      !observedAutoMoraLockWithoutAttempt &&
      !commandResultWithoutAttempt;
    // Only the terminal state requested by this exact command proves that its
    // previously ambiguous provider attempt has settled. An opposite stable
    // state may merely precede a delayed provider transition.
    const definitiveProviderObservation = validExpectedConfirmation;
    const waitingForDeviceConnectivity = waitsForPadlockDeviceConnectivity(
      command,
      input.outcome,
      providerState
    );
    const expectedTransitionState =
      command.action === "LOCK" ? "LOCKING" : "UNLOCKING";
    const transitionObservedThisOutcome =
      input.outcome.kind === "PENDING" &&
      providerState === expectedTransitionState &&
      Number(command.providerAttemptCount || 0) > 0;
    const desiredIsStale =
      Number(binding.desiredVersion) !== Number(command.desiredVersion) ||
      (command.action === "LOCK" && binding.desiredState !== "LOCKED") ||
      (command.action === "UNLOCK" && binding.desiredState !== "UNLOCKED");
    const ownProviderAttemptOpen = isPadlockProviderAttemptOpen(command);

    if (desiredIsStale) {
      if (!ownProviderAttemptOpen) {
        await supersedeUndispatchedCommand(
          transaction,
          command,
          binding,
          "STALE_PROVIDER_RESULT"
        );
        return {
          status: "SUPERSEDED" as const,
          stale: true,
          providerState,
        };
      }

      let lateReasonCode: string;
      if (definitiveProviderObservation) {
        lateReasonCode =
          validExpectedConfirmation
            ? confirmationSource === "OBSERVED"
              ? "LATE_REMOTE_STATE_OBSERVED_CONFIRMED"
              : "LATE_PROVIDER_COMMAND_RESULT_CONFIRMED"
            : "LATE_REMOTE_STATE_RECONCILED_NOT_APPLIED";
        await transaction.$executeRawUnsafe(
          `
            UPDATE "PadlockDeviceBinding"
            SET "confirmedState" = $2,
              "confirmedLockCause" = $3,
              "lastProviderState" = $2,
              "lastConfirmedAt" = $4::timestamp,
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE "id" = $1::uuid
          `,
          binding.id,
          providerState,
          providerState === "UNLOCKED"
            ? null
            : command.action === "LOCK"
              ? command.lockCause
              : binding.confirmedLockCause,
          now
        );
      } else {
        lateReasonCode =
          waitingForDeviceConnectivity && input.outcome.kind === "PENDING"
            ? "REMOTE_TRANSITION_PENDING"
            : invalidConfirmationSource
            ? "LATE_CONFIRMATION_SOURCE_INVALID"
            : observedAutoMoraLockWithoutAttempt
              ? "LOCKED_OBSERVED_WITHOUT_PROVIDER_ATTEMPT"
              : commandResultWithoutAttempt
                ? "COMMAND_RESULT_WITHOUT_PROVIDER_ATTEMPT"
                : input.outcome.kind === "CONFIRMED"
                  ? "LATE_REMOTE_STATE_CONTRADICTION"
                  : input.outcome.kind === "NOT_ENROLLED"
                    ? "LATE_DEVICE_NOT_ENROLLED"
                    : input.outcome.kind === "PENDING"
                      ? "LATE_PROVIDER_TRANSITION_PENDING"
                      : safeCode(
                          input.outcome.errorCode,
                          "LATE_PROVIDER_RESULT_REQUIRES_RECONCILIATION",
                          64
                        );
        if (providerState) {
          await transaction.$executeRawUnsafe(
            `
              UPDATE "PadlockDeviceBinding"
              SET "lastProviderState" = $2, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = $1::uuid
            `,
            binding.id,
            providerState
          );
        }
      }

      const reachedLimit =
        !waitingForDeviceConnectivity &&
        Number(command.attemptCount) >= Number(command.maxAttempts);
      const lateStatus: PadlockCommandStatus = definitiveProviderObservation
        ? "SUPERSEDED"
        : reachedLimit
          ? "REVIEW_REQUIRED"
          : "RETRY";
      const lateAvailableAt = definitiveProviderObservation
        ? now
        : padlockRetryAt(now, Number(command.attemptCount));
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = $2, "availableAt" = $5::timestamp,
            "supersededAt" = CASE
              WHEN $2 = 'SUPERSEDED' THEN $4::timestamp
              ELSE "supersededAt"
            END,
            "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastErrorCode" = $6, "lastProviderState" = $3,
            "providerTransitionObservedAt" = CASE
              WHEN $9::boolean THEN COALESCE("providerTransitionObservedAt", $4::timestamp)
              ELSE "providerTransitionObservedAt"
            END,
            "lastProviderAttemptCompletedAt" = CASE
              WHEN $7::boolean THEN $4::timestamp
              ELSE "lastProviderAttemptCompletedAt"
            END,
            "confirmedAt" = CASE
              WHEN $8::boolean THEN $4::timestamp
              ELSE "confirmedAt"
            END,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
        `,
        command.id,
        lateStatus,
        providerState,
        now,
        lateAvailableAt,
        safeCode(lateReasonCode, "STALE_PROVIDER_RESULT", 64),
        definitiveProviderObservation,
        validExpectedConfirmation,
        transitionObservedThisOutcome
      );
      await appendAudit(transaction, {
        bindingId: binding.id,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: command.creditId,
        eventType: definitiveProviderObservation
          ? "LATE_PROVIDER_OUTCOME_RECORDED"
          : "LATE_PROVIDER_OUTCOME_PENDING",
        action: command.action,
        fromStatus: command.status,
        toStatus: lateStatus,
        reasonCode: lateReasonCode,
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: Number(command.attemptCount),
        actorType: "WORKER",
        correlationId: command.correlationId,
      });
      return {
        status: lateStatus,
        stale: true,
        providerState,
        retryAt: lateStatus === "RETRY" ? lateAvailableAt : null,
      };
    }

    const priorOpenAttempt = await findPriorOpenProviderAttempt(
      transaction,
      command
    );
    if (priorOpenAttempt) {
      const retryAt = new Date(now.getTime() + 30_000);
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockCommand"
          SET "status" = 'RETRY', "availableAt" = $3::timestamp,
            "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastErrorCode" = 'PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT',
            "lastProviderState" = $2,
            "lastProviderAttemptCompletedAt" = CASE
              WHEN $4::boolean
                AND "providerAttemptCount" > 0
                AND "lastProviderAttemptStartedAt" IS NOT NULL
                AND (
                  "lastProviderAttemptCompletedAt" IS NULL
                  OR "lastProviderAttemptCompletedAt"
                    < "lastProviderAttemptStartedAt"
                )
                THEN $3::timestamp
              ELSE "lastProviderAttemptCompletedAt"
            END,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
        `,
        command.id,
        providerState,
        now,
        definitiveProviderObservation
      );
      await appendAudit(transaction, {
        bindingId: binding.id,
        commandId: command.id,
        policyRevisionId: command.policyRevisionId,
        creditId: command.creditId,
        eventType: "COMMAND_RETRY_SCHEDULED",
        action: command.action,
        fromStatus: command.status,
        toStatus: "RETRY",
        reasonCode: "PRIOR_PROVIDER_ATTEMPT_IN_FLIGHT",
        desiredVersion: Number(command.desiredVersion),
        attemptNumber: Number(command.attemptCount),
        actorType: "WORKER",
        correlationId: command.correlationId,
      });
      return {
        status: "RETRY" as const,
        stale: false,
        providerState,
        retryAt,
      };
    }

    let status: PadlockCommandStatus;
    let errorCode: string | null = null;
    let availableAt = now;

    if (invalidConfirmationSource) {
      status = "REVIEW_REQUIRED";
      errorCode = "CONFIRMATION_SOURCE_INVALID";
    } else if (observedAutoMoraLockWithoutAttempt) {
      status = "REVIEW_REQUIRED";
      errorCode = "LOCKED_OBSERVED_WITHOUT_PROVIDER_ATTEMPT";
    } else if (commandResultWithoutAttempt) {
      status = "REVIEW_REQUIRED";
      errorCode = "COMMAND_RESULT_WITHOUT_PROVIDER_ATTEMPT";
    } else if (validExpectedConfirmation) {
      status = "CONFIRMED";
      await transaction.$executeRawUnsafe(
        `
          UPDATE "PadlockDeviceBinding"
          SET "confirmedState" = $2,
            "confirmedLockCause" = $3,
            "lastProviderState" = $2,
            "lastConfirmedAt" = $4::timestamp,
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1::uuid
            AND "desiredVersion" = $5::integer
        `,
        binding.id,
        expectedConfirmedState,
        command.action === "LOCK" ? command.lockCause : null,
        now,
        command.desiredVersion
      );
    } else if (input.outcome.kind === "CONFIRMED") {
      status = "REVIEW_REQUIRED";
      errorCode = "REMOTE_STATE_CONTRADICTION";
    } else if (input.outcome.kind === "NOT_ENROLLED") {
      status = "REVIEW_REQUIRED";
      errorCode = "DEVICE_NOT_ENROLLED";
    } else if (input.outcome.kind === "REVIEW") {
      status = "REVIEW_REQUIRED";
      errorCode = safeCode(input.outcome.errorCode, "PROVIDER_STATE_REVIEW", 64);
    } else if (input.outcome.kind === "ERROR") {
      status = "ERROR";
      errorCode = safeCode(input.outcome.errorCode, "PROVIDER_ERROR", 64);
    } else {
      const reachedLimit =
        !waitingForDeviceConnectivity &&
        Number(command.attemptCount) >= Number(command.maxAttempts);
      status = reachedLimit ? "REVIEW_REQUIRED" : "RETRY";
      errorCode =
        reachedLimit
          ? "MAX_ATTEMPTS_REACHED"
          : input.outcome.kind === "PENDING"
            ? "REMOTE_TRANSITION_PENDING"
            : safeCode(input.outcome.errorCode, "PROVIDER_RETRY", 64);
      availableAt = reachedLimit
        ? now
        : padlockRetryAt(now, Number(command.attemptCount));
    }

    await transaction.$executeRawUnsafe(
      `
        UPDATE "PadlockCommand"
        SET "status" = $2, "availableAt" = $3::timestamp,
          "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
          "lastErrorCode" = $4, "lastProviderState" = $5,
          "providerTransitionObservedAt" = CASE
            WHEN $8::boolean THEN COALESCE("providerTransitionObservedAt", $6::timestamp)
            ELSE "providerTransitionObservedAt"
          END,
          "confirmedAt" = CASE WHEN $2 = 'CONFIRMED' THEN $6::timestamp ELSE "confirmedAt" END,
          "lastProviderAttemptCompletedAt" = CASE
            WHEN $7::boolean
              AND "providerAttemptCount" > 0
              AND "lastProviderAttemptStartedAt" IS NOT NULL
              AND (
                "lastProviderAttemptCompletedAt" IS NULL
                OR "lastProviderAttemptCompletedAt"
                  < "lastProviderAttemptStartedAt"
              )
              THEN $6::timestamp
            ELSE "lastProviderAttemptCompletedAt"
          END,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1::uuid
      `,
      command.id,
      status,
      availableAt,
      errorCode,
      providerState,
      now,
      definitiveProviderObservation,
      transitionObservedThisOutcome
    );
    await appendAudit(transaction, {
      bindingId: binding.id,
      commandId: command.id,
      policyRevisionId: command.policyRevisionId,
      creditId: command.creditId,
      eventType:
        status === "CONFIRMED"
          ? "COMMAND_CONFIRMED"
          : status === "RETRY"
            ? "COMMAND_RETRY_SCHEDULED"
            : status === "REVIEW_REQUIRED"
              ? "COMMAND_REVIEW_REQUIRED"
              : "COMMAND_FAILED",
      action: command.action,
      fromStatus: command.status,
      toStatus: status,
      reasonCode:
        status === "CONFIRMED"
          ? confirmationSource === "OBSERVED"
            ? "REMOTE_STATE_OBSERVED_CONFIRMED"
            : "PROVIDER_COMMAND_RESULT_CONFIRMED"
          : errorCode,
      desiredVersion: Number(command.desiredVersion),
      attemptNumber: Number(command.attemptCount),
      actorType: "WORKER",
      correlationId: command.correlationId,
    });
    return {
      status,
      stale: false,
      providerState,
      retryAt: status === "RETRY" ? availableAt : null,
    };
  });
}

export async function listPadlockCommands(options?: {
  limit?: number;
  status?: PadlockCommandStatus;
  prioritizeUnresolvedProviderReviews?: boolean;
}) {
  const limit = asInteger(options?.limit ?? 50, "PADLOCK_LIMIT_INVALID", {
    min: 1,
    max: 200,
  });
  const status = options?.status || null;
  const prioritizeUnresolvedProviderReviews =
    options?.prioritizeUnresolvedProviderReviews === true;
  const rows = await database.$queryRawUnsafe<
    Array<
      CommandRow & {
        folio: string;
        imei: string;
        actorName: string | null;
      }
    >
  >(
    `
      SELECT command.*, credit."folio", binding."imei",
        actor."nombre" AS "actorName"
      FROM "PadlockCommand" command
      JOIN "PadlockDeviceBinding" binding ON binding."id" = command."bindingId"
      JOIN "Credito" credit ON credit."id" = command."creditId"
      LEFT JOIN LATERAL (
        SELECT audit."actorUserId"
        FROM "PadlockAuditEvent" audit
        WHERE audit."commandId" = command."id"
          AND audit."eventType" = 'COMMAND_ENQUEUED'
        ORDER BY audit."createdAt"
        LIMIT 1
      ) command_actor ON TRUE
      LEFT JOIN "Usuario" actor ON actor."id" = command_actor."actorUserId"
      WHERE ($1::text IS NULL OR command."status" = $1)
      ORDER BY
        CASE
          WHEN $3::boolean
            AND command."status" = 'REVIEW_REQUIRED'
            AND command."providerAttemptCount" > 0
            AND command."lastProviderAttemptStartedAt" IS NOT NULL
            AND (
              command."lastProviderAttemptCompletedAt" IS NULL
              OR command."lastProviderAttemptCompletedAt" < command."lastProviderAttemptStartedAt"
            )
          THEN 0
          ELSE 1
        END,
        command."createdAt" DESC,
        command."id"
      LIMIT $2
    `,
    status,
    limit,
    prioritizeUnresolvedProviderReviews
  );
  return rows.map((row) => ({
    id: row.id,
    bindingId: row.bindingId,
    creditId: row.creditId,
    folio: row.folio,
    imeiMasked: maskImei(row.imei),
    action: row.action,
    lockCause: row.lockCause,
    desiredVersion: Number(row.desiredVersion),
    status: row.status,
    source: row.source,
    operatorReason: row.operatorReason,
    actorName: row.actorName,
    scheduleSlotAt: row.scheduleSlotAt,
    decision: {
      financialState: row.decisionFinancialState,
      daysPastDue: Number(row.decisionDaysPastDue),
      outstandingBalance: Number(row.decisionOutstandingBalance),
      effectiveDueDate: row.decisionEffectiveDueDate,
      evaluatedAt: row.evaluatedAt,
      policyRevisionId: row.policyRevisionId,
    },
    attemptCount: Number(row.attemptCount),
    providerAttemptCount: Number(row.providerAttemptCount || 0),
    lastProviderAttemptStartedAt: row.lastProviderAttemptStartedAt,
    lastProviderAttemptCompletedAt: row.lastProviderAttemptCompletedAt,
    providerTransitionObservedAt: row.providerTransitionObservedAt,
    maxAttempts: Number(row.maxAttempts),
    availableAt: row.availableAt,
    lastErrorCode: row.lastErrorCode,
    lastProviderState: row.lastProviderState,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function listPadlockOverview() {
  const [bindingCounts, commandCounts, policies, recentCommands] =
    await Promise.all([
      database.$queryRawUnsafe<Array<{ status: string; count: number }>>(
        `
          SELECT "status", COUNT(*)::integer AS "count"
          FROM "PadlockDeviceBinding"
          GROUP BY "status"
        `
      ),
      database.$queryRawUnsafe<Array<{ status: string; count: number }>>(
        `
          SELECT "status", COUNT(*)::integer AS "count"
          FROM "PadlockCommand"
          GROUP BY "status"
        `
      ),
      listPadlockPolicies(),
      listPadlockCommands({ limit: 20 }),
    ]);
  return {
    bindings: Object.fromEntries(
      bindingCounts.map((row) => [row.status, Number(row.count)])
    ),
    commands: Object.fromEntries(
      commandCounts.map((row) => [row.status, Number(row.count)])
    ),
    policies,
    recentCommands,
  };
}
