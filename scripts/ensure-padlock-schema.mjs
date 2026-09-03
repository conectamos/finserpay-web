import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de Padlock."
  );
}

const client = new Client({
  application_name: "finserpay-padlock-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  `
    CREATE TABLE IF NOT EXISTS public."PadlockPolicyRevision" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "scopeKey" VARCHAR(80) NOT NULL,
      "scopeType" VARCHAR(16) NOT NULL,
      "allyId" INTEGER,
      "product" VARCHAR(16) NOT NULL DEFAULT 'IPHONE',
      "version" INTEGER NOT NULL,
      "enabled" BOOLEAN NOT NULL,
      "graceDays" INTEGER NOT NULL,
      "lockAfterDaysPastDue" INTEGER NOT NULL,
      "unlockCondition" VARCHAR(16) NOT NULL,
      "reason" VARCHAR(500),
      "createdByUserId" INTEGER NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PadlockPolicyRevision_allyId_fkey"
        FOREIGN KEY ("allyId") REFERENCES public."Aliado"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockPolicyRevision_scope_check"
        CHECK (
          (
            "scopeType" = 'GLOBAL'
            AND "allyId" IS NULL
            AND "scopeKey" = 'GLOBAL:IPHONE'
          )
          OR (
            "scopeType" = 'ALLY'
            AND "allyId" IS NOT NULL
            AND "scopeKey" = CONCAT('ALLY:', "allyId"::TEXT, ':IPHONE')
          )
        ),
      CONSTRAINT "PadlockPolicyRevision_product_check"
        CHECK ("product" = 'IPHONE'),
      CONSTRAINT "PadlockPolicyRevision_version_check"
        CHECK ("version" > 0),
      CONSTRAINT "PadlockPolicyRevision_days_check"
        CHECK (
          "graceDays" BETWEEN 0 AND 3650
          AND "lockAfterDaysPastDue" BETWEEN 0 AND 3650
        ),
      CONSTRAINT "PadlockPolicyRevision_unlock_check"
        CHECK ("unlockCondition" IN ('CURRENT', 'SETTLED')),
      CONSTRAINT "PadlockPolicyRevision_actor_check"
        CHECK ("createdByUserId" > 0)
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "PadlockPolicyRevision_scopeKey_version_key"
      ON public."PadlockPolicyRevision" ("scopeKey", "version")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockPolicyRevision_scopeType_product_version_idx"
      ON public."PadlockPolicyRevision" ("scopeType", "product", "version")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockPolicyRevision_allyId_product_version_idx"
      ON public."PadlockPolicyRevision" ("allyId", "product", "version")
  `,
  `
    CREATE TABLE IF NOT EXISTS public."PadlockDeviceBinding" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "creditId" INTEGER NOT NULL,
      "imei" CHAR(15) NOT NULL,
      "product" VARCHAR(16) NOT NULL DEFAULT 'IPHONE',
      "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      "verifiedAt" TIMESTAMP(3) NOT NULL,
      "verifiedByUserId" INTEGER NOT NULL,
      "verificationReferenceHash" CHAR(64) NOT NULL,
      "desiredState" VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
      "desiredVersion" INTEGER NOT NULL DEFAULT 0,
      "desiredLockCause" VARCHAR(16),
      "confirmedState" VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
      "confirmedLockCause" VARCHAR(16),
      "lastProviderState" VARCHAR(32),
      "lastConfirmedAt" TIMESTAMP(3),
      "retiredAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PadlockDeviceBinding_creditId_fkey"
        FOREIGN KEY ("creditId") REFERENCES public."Credito"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockDeviceBinding_imei_check"
        CHECK ("imei" ~ '^[0-9]{15}$'),
      CONSTRAINT "PadlockDeviceBinding_product_check"
        CHECK ("product" = 'IPHONE'),
      CONSTRAINT "PadlockDeviceBinding_status_check"
        CHECK ("status" IN ('ACTIVE', 'RETIRED')),
      CONSTRAINT "PadlockDeviceBinding_desired_state_check"
        CHECK ("desiredState" IN ('UNKNOWN', 'LOCKED', 'UNLOCKED')),
      CONSTRAINT "PadlockDeviceBinding_confirmed_state_check"
        CHECK ("confirmedState" IN ('UNKNOWN', 'LOCKED', 'UNLOCKED')),
      CONSTRAINT "PadlockDeviceBinding_lock_causes_check"
        CHECK (
          ("desiredLockCause" IS NULL OR "desiredLockCause" IN ('AUTO_MORA', 'MANUAL', 'ROBO', 'FRAUDE'))
          AND ("confirmedLockCause" IS NULL OR "confirmedLockCause" IN ('AUTO_MORA', 'MANUAL', 'ROBO', 'FRAUDE'))
          AND ("desiredState" = 'LOCKED' OR "desiredLockCause" IS NULL)
          AND ("confirmedState" = 'LOCKED' OR "confirmedLockCause" IS NULL)
        ),
      CONSTRAINT "PadlockDeviceBinding_version_check"
        CHECK ("desiredVersion" >= 0),
      CONSTRAINT "PadlockDeviceBinding_verification_check"
        CHECK (
          "verifiedByUserId" > 0
          AND "verificationReferenceHash" ~ '^[a-f0-9]{64}$'
        ),
      CONSTRAINT "PadlockDeviceBinding_retired_check"
        CHECK (
          ("status" = 'ACTIVE' AND "retiredAt" IS NULL)
          OR ("status" = 'RETIRED' AND "retiredAt" IS NOT NULL)
        )
    )
  `,
  `
    DROP INDEX IF EXISTS public."PadlockDeviceBinding_imei_key"
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "PadlockDeviceBinding_active_imei_key"
      ON public."PadlockDeviceBinding" ("imei")
      WHERE "status" = 'ACTIVE'
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockDeviceBinding_imei_idx"
      ON public."PadlockDeviceBinding" ("imei")
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "PadlockDeviceBinding_active_credit_key"
      ON public."PadlockDeviceBinding" ("creditId")
      WHERE "status" = 'ACTIVE'
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockDeviceBinding_creditId_status_idx"
      ON public."PadlockDeviceBinding" ("creditId", "status")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockDeviceBinding_status_product_idx"
      ON public."PadlockDeviceBinding" ("status", "product")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockDeviceBinding_desiredState_status_idx"
      ON public."PadlockDeviceBinding" ("desiredState", "status")
  `,
  `
    CREATE TABLE IF NOT EXISTS public."PadlockCommand" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "bindingId" UUID NOT NULL,
      "creditId" INTEGER NOT NULL,
      "policyRevisionId" UUID,
      "action" VARCHAR(16) NOT NULL,
      "lockCause" VARCHAR(16),
      "desiredVersion" INTEGER NOT NULL,
      "idempotencyKey" VARCHAR(180) NOT NULL,
      "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
      "source" VARCHAR(64) NOT NULL,
      "correlationId" UUID NOT NULL,
      "operatorReason" VARCHAR(500),
      "scheduleSlotAt" TIMESTAMP(3),
      "decisionFinancialState" VARCHAR(16) NOT NULL,
      "decisionDaysPastDue" INTEGER NOT NULL,
      "decisionOutstandingBalance" NUMERIC(20,2) NOT NULL,
      "decisionEffectiveDueDate" DATE,
      "evaluatedAt" TIMESTAMP(3) NOT NULL,
      "attemptCount" INTEGER NOT NULL DEFAULT 0,
      "providerAttemptCount" INTEGER NOT NULL DEFAULT 0,
      "lastProviderAttemptStartedAt" TIMESTAMP(3),
      "lastProviderAttemptCompletedAt" TIMESTAMP(3),
      "maxAttempts" INTEGER NOT NULL DEFAULT 6,
      "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "leaseOwner" VARCHAR(100),
      "leaseToken" UUID,
      "leaseExpiresAt" TIMESTAMP(3),
      "lastErrorCode" VARCHAR(64),
      "lastProviderState" VARCHAR(32),
      "confirmedAt" TIMESTAMP(3),
      "cancelledAt" TIMESTAMP(3),
      "supersededAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PadlockCommand_bindingId_fkey"
        FOREIGN KEY ("bindingId") REFERENCES public."PadlockDeviceBinding"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockCommand_creditId_fkey"
        FOREIGN KEY ("creditId") REFERENCES public."Credito"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockCommand_policyRevisionId_fkey"
        FOREIGN KEY ("policyRevisionId") REFERENCES public."PadlockPolicyRevision"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockCommand_action_check"
        CHECK ("action" IN ('LOCK', 'UNLOCK')),
      CONSTRAINT "PadlockCommand_lock_cause_check"
        CHECK (
          ("lockCause" IS NULL OR "lockCause" IN ('AUTO_MORA', 'MANUAL', 'ROBO', 'FRAUDE'))
          AND ("action" = 'UNLOCK' OR "lockCause" IS NOT NULL)
        ),
      CONSTRAINT "PadlockCommand_status_check"
        CHECK ("status" IN (
          'PENDING', 'PROCESSING', 'RETRY', 'CONFIRMED', 'ERROR',
          'REVIEW_REQUIRED', 'CANCELLED', 'SUPERSEDED'
        )),
      CONSTRAINT "PadlockCommand_attempts_check"
        CHECK (
          "desiredVersion" > 0
          AND "attemptCount" >= 0
          AND "maxAttempts" BETWEEN 1 AND 50
        ),
      CONSTRAINT "PadlockCommand_financial_snapshot_check"
        CHECK (
          "decisionFinancialState" IN ('MORA', 'AL_DIA', 'SETTLED')
          AND "decisionDaysPastDue" >= 0
          AND "decisionOutstandingBalance" >= 0
        ),
      CONSTRAINT "PadlockCommand_operator_reason_check"
        CHECK (
          ("source" = 'MANUAL' AND LENGTH("operatorReason") BETWEEN 5 AND 500)
          OR ("source" <> 'MANUAL' AND "operatorReason" IS NULL)
        ),
      CONSTRAINT "PadlockCommand_lease_check"
        CHECK (
          (
            "leaseOwner" IS NULL
            AND "leaseToken" IS NULL
            AND "leaseExpiresAt" IS NULL
          )
          OR (
            "leaseOwner" IS NOT NULL
            AND "leaseToken" IS NOT NULL
            AND "leaseExpiresAt" IS NOT NULL
          )
        ),
      CONSTRAINT "PadlockCommand_schedule_check"
        CHECK (
          (
            "action" = 'LOCK'
            AND "lockCause" = 'AUTO_MORA'
            AND "scheduleSlotAt" IS NOT NULL
          )
          OR (
            NOT ("action" = 'LOCK' AND "lockCause" = 'AUTO_MORA')
            AND "scheduleSlotAt" IS NULL
          )
        )
    )
  `,
  `
    ALTER TABLE public."PadlockCommand"
      ADD COLUMN IF NOT EXISTS "providerAttemptCount" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "lastProviderAttemptStartedAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "lastProviderAttemptCompletedAt" TIMESTAMP(3)
  `,
  `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'PadlockCommand_provider_attempts_check'
          AND conrelid = 'public."PadlockCommand"'::regclass
      ) THEN
        ALTER TABLE public."PadlockCommand"
          ADD CONSTRAINT "PadlockCommand_provider_attempts_check"
          CHECK ("providerAttemptCount" >= 0);
      END IF;
    END;
    $$
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "PadlockCommand_idempotencyKey_key"
      ON public."PadlockCommand" ("idempotencyKey")
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "PadlockCommand_bindingId_desiredVersion_key"
      ON public."PadlockCommand" ("bindingId", "desiredVersion")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockCommand_status_availableAt_idx"
      ON public."PadlockCommand" ("status", "availableAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockCommand_bindingId_createdAt_idx"
      ON public."PadlockCommand" ("bindingId", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockCommand_creditId_createdAt_idx"
      ON public."PadlockCommand" ("creditId", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockCommand_leaseExpiresAt_idx"
      ON public."PadlockCommand" ("leaseExpiresAt")
  `,
  `
    CREATE TABLE IF NOT EXISTS public."PadlockAuditEvent" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "bindingId" UUID,
      "commandId" UUID,
      "policyRevisionId" UUID,
      "creditId" INTEGER,
      "eventType" VARCHAR(48) NOT NULL,
      "action" VARCHAR(16),
      "fromStatus" VARCHAR(24),
      "toStatus" VARCHAR(24),
      "reasonCode" VARCHAR(64),
      "operatorReason" VARCHAR(500),
      "desiredVersion" INTEGER,
      "attemptNumber" INTEGER,
      "actorType" VARCHAR(16) NOT NULL,
      "actorUserId" INTEGER,
      "correlationId" UUID NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PadlockAuditEvent_bindingId_fkey"
        FOREIGN KEY ("bindingId") REFERENCES public."PadlockDeviceBinding"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockAuditEvent_commandId_fkey"
        FOREIGN KEY ("commandId") REFERENCES public."PadlockCommand"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockAuditEvent_policyRevisionId_fkey"
        FOREIGN KEY ("policyRevisionId") REFERENCES public."PadlockPolicyRevision"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockAuditEvent_creditId_fkey"
        FOREIGN KEY ("creditId") REFERENCES public."Credito"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "PadlockAuditEvent_action_check"
        CHECK ("action" IS NULL OR "action" IN ('LOCK', 'UNLOCK')),
      CONSTRAINT "PadlockAuditEvent_actor_check"
        CHECK (
          "actorType" IN ('SYSTEM', 'USER', 'WORKER')
          AND ("actorType" <> 'USER' OR "actorUserId" IS NOT NULL)
        ),
      CONSTRAINT "PadlockAuditEvent_entity_check"
        CHECK (
          "bindingId" IS NOT NULL
          OR "commandId" IS NOT NULL
          OR "policyRevisionId" IS NOT NULL
        )
    )
  `,
  `
    ALTER TABLE public."PadlockAuditEvent"
      ADD COLUMN IF NOT EXISTS "operatorReason" VARCHAR(500)
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockAuditEvent_bindingId_createdAt_idx"
      ON public."PadlockAuditEvent" ("bindingId", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockAuditEvent_commandId_createdAt_idx"
      ON public."PadlockAuditEvent" ("commandId", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockAuditEvent_creditId_createdAt_idx"
      ON public."PadlockAuditEvent" ("creditId", "createdAt")
  `,
  `
    CREATE INDEX IF NOT EXISTS "PadlockAuditEvent_eventType_createdAt_idx"
      ON public."PadlockAuditEvent" ("eventType", "createdAt")
  `,
  `
    CREATE OR REPLACE FUNCTION public.finserpay_padlock_reject_immutable_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'Padlock audit and policy revision records are immutable';
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "PadlockAuditEvent_immutable" ON public."PadlockAuditEvent"
  `,
  `
    CREATE TRIGGER "PadlockAuditEvent_immutable"
    BEFORE UPDATE OR DELETE ON public."PadlockAuditEvent"
    FOR EACH ROW EXECUTE FUNCTION public.finserpay_padlock_reject_immutable_mutation()
  `,
  `
    DROP TRIGGER IF EXISTS "PadlockPolicyRevision_immutable" ON public."PadlockPolicyRevision"
  `,
  `
    CREATE TRIGGER "PadlockPolicyRevision_immutable"
    BEFORE UPDATE OR DELETE ON public."PadlockPolicyRevision"
    FOR EACH ROW EXECUTE FUNCTION public.finserpay_padlock_reject_immutable_mutation()
  `,
  `
    CREATE OR REPLACE FUNCTION public.finserpay_padlock_protect_binding_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."creditId" <> OLD."creditId"
        OR NEW."imei" <> OLD."imei"
        OR NEW."product" <> OLD."product"
        OR NEW."verifiedAt" <> OLD."verifiedAt"
        OR NEW."verifiedByUserId" <> OLD."verifiedByUserId"
        OR NEW."verificationReferenceHash" <> OLD."verificationReferenceHash"
      THEN
        RAISE EXCEPTION 'Padlock binding identity is immutable; retire and create another binding';
      END IF;
      RETURN NEW;
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "PadlockDeviceBinding_identity_immutable"
      ON public."PadlockDeviceBinding"
  `,
  `
    CREATE TRIGGER "PadlockDeviceBinding_identity_immutable"
    BEFORE UPDATE ON public."PadlockDeviceBinding"
    FOR EACH ROW EXECUTE FUNCTION public.finserpay_padlock_protect_binding_identity()
  `,
  `
    CREATE OR REPLACE FUNCTION public.finserpay_padlock_protect_command_identity()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW."bindingId" <> OLD."bindingId"
        OR NEW."creditId" <> OLD."creditId"
        OR NEW."policyRevisionId" IS DISTINCT FROM OLD."policyRevisionId"
        OR NEW."action" <> OLD."action"
        OR NEW."lockCause" IS DISTINCT FROM OLD."lockCause"
        OR NEW."desiredVersion" <> OLD."desiredVersion"
        OR NEW."idempotencyKey" <> OLD."idempotencyKey"
        OR NEW."source" <> OLD."source"
        OR NEW."correlationId" <> OLD."correlationId"
        OR NEW."operatorReason" IS DISTINCT FROM OLD."operatorReason"
        OR NEW."scheduleSlotAt" IS DISTINCT FROM OLD."scheduleSlotAt"
        OR NEW."decisionFinancialState" <> OLD."decisionFinancialState"
        OR NEW."decisionDaysPastDue" <> OLD."decisionDaysPastDue"
        OR NEW."decisionOutstandingBalance" <> OLD."decisionOutstandingBalance"
        OR NEW."decisionEffectiveDueDate" IS DISTINCT FROM OLD."decisionEffectiveDueDate"
        OR NEW."evaluatedAt" <> OLD."evaluatedAt"
        OR NEW."maxAttempts" <> OLD."maxAttempts"
        OR NEW."createdAt" <> OLD."createdAt"
      THEN
        RAISE EXCEPTION 'Padlock command identity is immutable';
      END IF;
      RETURN NEW;
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "PadlockCommand_identity_immutable"
      ON public."PadlockCommand"
  `,
  `
    CREATE TRIGGER "PadlockCommand_identity_immutable"
    BEFORE UPDATE ON public."PadlockCommand"
    FOR EACH ROW EXECUTE FUNCTION public.finserpay_padlock_protect_command_identity()
  `,
];

const expectedColumns = [
  ["PadlockPolicyRevision", "scopeKey", "character varying", "NO"],
  ["PadlockPolicyRevision", "unlockCondition", "character varying", "NO"],
  ["PadlockDeviceBinding", "imei", "character", "NO"],
  ["PadlockDeviceBinding", "desiredVersion", "integer", "NO"],
  ["PadlockDeviceBinding", "desiredLockCause", "character varying", "YES"],
  ["PadlockCommand", "status", "character varying", "NO"],
  ["PadlockCommand", "lockCause", "character varying", "YES"],
  ["PadlockCommand", "operatorReason", "character varying", "YES"],
  ["PadlockCommand", "decisionOutstandingBalance", "numeric", "NO"],
  ["PadlockCommand", "evaluatedAt", "timestamp without time zone", "NO"],
  ["PadlockCommand", "providerAttemptCount", "integer", "NO"],
  ["PadlockCommand", "lastProviderAttemptStartedAt", "timestamp without time zone", "YES"],
  ["PadlockCommand", "lastProviderAttemptCompletedAt", "timestamp without time zone", "YES"],
  ["PadlockCommand", "leaseToken", "uuid", "YES"],
  ["PadlockAuditEvent", "reasonCode", "character varying", "YES"],
  ["PadlockAuditEvent", "operatorReason", "character varying", "YES"],
  ["PadlockAuditEvent", "correlationId", "uuid", "NO"],
];

const requiredTriggers = [
  "PadlockAuditEvent_immutable",
  "PadlockPolicyRevision_immutable",
  "PadlockDeviceBinding_identity_immutable",
  "PadlockCommand_identity_immutable",
];

async function assertCompatibleSchema() {
  const result = await client.query(
    `
      SELECT table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [[
      "PadlockPolicyRevision",
      "PadlockDeviceBinding",
      "PadlockCommand",
      "PadlockAuditEvent",
    ]]
  );
  const columns = new Map(
    result.rows.map((row) => [row.table_name + "." + row.column_name, row])
  );

  for (const [table, column, dataType, nullable] of expectedColumns) {
    const actual = columns.get(table + "." + column);
    if (
      !actual ||
      actual.data_type !== dataType ||
      actual.is_nullable !== nullable
    ) {
      throw new Error("Definicion incompatible en " + table + "." + column + ".");
    }
  }

  const triggerResult = await client.query(
    `
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND trigger_name = ANY($1::text[])
    `,
    [requiredTriggers]
  );
  const triggers = new Set(triggerResult.rows.map((row) => row.trigger_name));
  for (const trigger of requiredTriggers) {
    if (!triggers.has(trigger)) {
      throw new Error("Trigger de proteccion Padlock faltante: " + trigger + ".");
    }
  }
}

try {
  await client.connect();
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('finserpay-padlock-schema'))"
    );
    for (const statement of statements) {
      await client.query(statement);
    }
    await assertCompatibleSchema();
    await client.query("COMMIT");
    console.log("Esquema de Padlock preparado correctamente.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
} catch (error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code || "").replace(/[^A-Z0-9_]/gi, "").slice(0, 24)
      : "";
  throw new Error(
    "No se pudo preparar el esquema de Padlock" +
      (code ? " (" + code + ")" : "") +
      "."
  );
} finally {
  await client.end().catch(() => undefined);
}
