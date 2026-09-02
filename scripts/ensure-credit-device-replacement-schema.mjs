import pg from "pg";

const { Client } = pg;
const connectionString = String(process.env.DATABASE_URL || "").trim();

if (!connectionString) {
  throw new Error(
    "DATABASE_URL no esta configurada para preparar el esquema de reemplazos de equipo."
  );
}

const client = new Client({
  application_name: "finserpay-credit-device-replacement-schema",
  connectionString,
  connectionTimeoutMillis: 10_000,
});

const statements = [
  `
    CREATE TABLE IF NOT EXISTS public."CreditDeviceReplacement" (
      "id" UUID NOT NULL,
      "creditId" INTEGER NOT NULL,
      "solicitudId" INTEGER NOT NULL,
      "previousImei" VARCHAR(15) NOT NULL,
      "newImei" VARCHAR(15) NOT NULL,
      "reason" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'PENDING_ENROLLMENT',
      "requestedCreditUpdatedAt" TIMESTAMPTZ NOT NULL,
      "createdByUserId" INTEGER,
      "createdByName" TEXT NOT NULL,
      "createdByUsername" TEXT,
      "source" TEXT NOT NULL DEFAULT 'ADMIN_PORTAL',
      "correlationId" UUID NOT NULL,
      "completedByUserId" INTEGER,
      "completedByName" TEXT,
      "completedAt" TIMESTAMPTZ,
      "cancelledByUserId" INTEGER,
      "cancelledByName" TEXT,
      "cancelledReason" TEXT,
      "cancelledAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CreditDeviceReplacement_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "CreditDeviceReplacement_correlationId_key" UNIQUE ("correlationId"),
      CONSTRAINT "CreditDeviceReplacement_credit_fkey"
        FOREIGN KEY ("creditId") REFERENCES public."Credito"("id") ON DELETE RESTRICT,
      CONSTRAINT "CreditDeviceReplacement_solicitud_fkey"
        FOREIGN KEY ("solicitudId") REFERENCES public."CreditoBorrador"("id") ON DELETE RESTRICT,
      CONSTRAINT "CreditDeviceReplacement_createdBy_fkey"
        FOREIGN KEY ("createdByUserId") REFERENCES public."Usuario"("id") ON DELETE SET NULL,
      CONSTRAINT "CreditDeviceReplacement_completedBy_fkey"
        FOREIGN KEY ("completedByUserId") REFERENCES public."Usuario"("id") ON DELETE SET NULL,
      CONSTRAINT "CreditDeviceReplacement_cancelledBy_fkey"
        FOREIGN KEY ("cancelledByUserId") REFERENCES public."Usuario"("id") ON DELETE SET NULL,
      CONSTRAINT "CreditDeviceReplacement_status_check"
        CHECK ("status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED', 'COMPLETED', 'CANCELLED')),
      CONSTRAINT "CreditDeviceReplacement_imei_check"
        CHECK (
          "previousImei" ~ '^[0-9]{15}$'
          AND "newImei" ~ '^[0-9]{15}$'
          AND "previousImei" <> "newImei"
        ),
      CONSTRAINT "CreditDeviceReplacement_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 5 AND 500),
      CONSTRAINT "CreditDeviceReplacement_completion_check"
        CHECK (
          ("status" <> 'COMPLETED')
          OR (
            "completedAt" IS NOT NULL
            AND "completedByName" IS NOT NULL
          )
        )
    )
  `,
  `
    ALTER TABLE public."CreditDeviceReplacement"
      ADD COLUMN IF NOT EXISTS "id" UUID,
      ADD COLUMN IF NOT EXISTS "creditId" INTEGER,
      ADD COLUMN IF NOT EXISTS "solicitudId" INTEGER,
      ADD COLUMN IF NOT EXISTS "previousImei" VARCHAR(15),
      ADD COLUMN IF NOT EXISTS "newImei" VARCHAR(15),
      ADD COLUMN IF NOT EXISTS "reason" TEXT,
      ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'PENDING_ENROLLMENT',
      ADD COLUMN IF NOT EXISTS "requestedCreditUpdatedAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "createdByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "createdByName" TEXT,
      ADD COLUMN IF NOT EXISTS "createdByUsername" TEXT,
      ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'ADMIN_PORTAL',
      ADD COLUMN IF NOT EXISTS "correlationId" UUID,
      ADD COLUMN IF NOT EXISTS "completedByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "completedByName" TEXT,
      ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "cancelledByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "cancelledByName" TEXT,
      ADD COLUMN IF NOT EXISTS "cancelledReason" TEXT,
      ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  `,
  `
    ALTER TABLE public."CreditDeviceReplacement"
      ALTER COLUMN "status" SET DEFAULT 'PENDING_ENROLLMENT',
      ALTER COLUMN "source" SET DEFAULT 'ADMIN_PORTAL',
      ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN "id" SET NOT NULL,
      ALTER COLUMN "creditId" SET NOT NULL,
      ALTER COLUMN "solicitudId" SET NOT NULL,
      ALTER COLUMN "previousImei" SET NOT NULL,
      ALTER COLUMN "newImei" SET NOT NULL,
      ALTER COLUMN "reason" SET NOT NULL,
      ALTER COLUMN "status" SET NOT NULL,
      ALTER COLUMN "requestedCreditUpdatedAt" SET NOT NULL,
      ALTER COLUMN "createdByName" SET NOT NULL,
      ALTER COLUMN "source" SET NOT NULL,
      ALTER COLUMN "correlationId" SET NOT NULL,
      ALTER COLUMN "createdAt" SET NOT NULL,
      ALTER COLUMN "updatedAt" SET NOT NULL
  `,
  `
    ALTER TABLE public."CreditDeviceReplacement"
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacement_status_check",
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacement_imei_check",
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacement_reason_check",
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacement_completion_check",
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacement_cancellation_check"
  `,
  `
    ALTER TABLE public."CreditDeviceReplacement"
      ADD CONSTRAINT "CreditDeviceReplacement_status_check"
        CHECK (
          "status" IN (
            'PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED', 'COMPLETED', 'CANCELLED'
          )
        ),
      ADD CONSTRAINT "CreditDeviceReplacement_imei_check"
        CHECK (
          "previousImei" ~ '^[0-9]{15}$'
          AND "newImei" ~ '^[0-9]{15}$'
          AND "previousImei" <> "newImei"
        ),
      ADD CONSTRAINT "CreditDeviceReplacement_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 5 AND 500),
      ADD CONSTRAINT "CreditDeviceReplacement_completion_check"
        CHECK (
          (
            "status" = 'COMPLETED'
            AND "completedByUserId" IS NOT NULL
            AND NULLIF(btrim("completedByName"), '') IS NOT NULL
            AND "completedAt" IS NOT NULL
          )
          OR (
            "status" <> 'COMPLETED'
            AND "completedByUserId" IS NULL
            AND "completedByName" IS NULL
            AND "completedAt" IS NULL
          )
        ),
      ADD CONSTRAINT "CreditDeviceReplacement_cancellation_check"
        CHECK (
          (
            "status" = 'CANCELLED'
            AND "cancelledByUserId" IS NOT NULL
            AND NULLIF(btrim("cancelledByName"), '') IS NOT NULL
            AND NULLIF(btrim("cancelledReason"), '') IS NOT NULL
            AND char_length(btrim("cancelledReason")) BETWEEN 5 AND 500
            AND "cancelledAt" IS NOT NULL
          )
          OR (
            "status" <> 'CANCELLED'
            AND "cancelledByUserId" IS NULL
            AND "cancelledByName" IS NULL
            AND "cancelledReason" IS NULL
            AND "cancelledAt" IS NULL
          )
        )
  `,
  `
    CREATE TABLE IF NOT EXISTS public."CreditDeviceReplacementReview" (
      "id" UUID NOT NULL,
      "replacementId" UUID NOT NULL,
      "decision" TEXT NOT NULL,
      "checklistVersion" TEXT NOT NULL,
      "checklist" JSONB NOT NULL,
      "documentHash" CHAR(64) NOT NULL,
      "imeiHash" CHAR(64) NOT NULL,
      "checklistHash" CHAR(64) NOT NULL,
      "identityKeyVersion" TEXT NOT NULL,
      "grantId" UUID,
      "grantIssuedByUserId" INTEGER,
      "grantIssuedByName" TEXT,
      "accessFingerprint" CHAR(64) NOT NULL,
      "analystName" TEXT NOT NULL,
      "analystExternalId" TEXT NOT NULL,
      "correlationId" UUID NOT NULL,
      "approvedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CreditDeviceReplacementReview_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "CreditDeviceReplacementReview_replacementId_key" UNIQUE ("replacementId"),
      CONSTRAINT "CreditDeviceReplacementReview_correlationId_key" UNIQUE ("correlationId"),
      CONSTRAINT "CreditDeviceReplacementReview_replacement_fkey"
        FOREIGN KEY ("replacementId")
        REFERENCES public."CreditDeviceReplacement"("id") ON DELETE RESTRICT,
      CONSTRAINT "CreditDeviceReplacementReview_grant_fkey"
        FOREIGN KEY ("grantId")
        REFERENCES public."IphoneEnrollmentAccessGrant"("id") ON DELETE RESTRICT,
      CONSTRAINT "CreditDeviceReplacementReview_grantIssuedBy_fkey"
        FOREIGN KEY ("grantIssuedByUserId")
        REFERENCES public."Usuario"("id") ON DELETE SET NULL,
      CONSTRAINT "CreditDeviceReplacementReview_decision_check"
        CHECK ("decision" = 'APROBADO')
    )
  `,
  `
    ALTER TABLE public."CreditDeviceReplacementReview"
      ADD COLUMN IF NOT EXISTS "replacementId" UUID,
      ADD COLUMN IF NOT EXISTS "decision" TEXT,
      ADD COLUMN IF NOT EXISTS "checklistVersion" TEXT,
      ADD COLUMN IF NOT EXISTS "checklist" JSONB,
      ADD COLUMN IF NOT EXISTS "documentHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "imeiHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "checklistHash" CHAR(64),
      ADD COLUMN IF NOT EXISTS "identityKeyVersion" TEXT,
      ADD COLUMN IF NOT EXISTS "grantId" UUID,
      ADD COLUMN IF NOT EXISTS "grantIssuedByUserId" INTEGER,
      ADD COLUMN IF NOT EXISTS "grantIssuedByName" TEXT,
      ADD COLUMN IF NOT EXISTS "accessFingerprint" CHAR(64),
      ADD COLUMN IF NOT EXISTS "analystName" TEXT,
      ADD COLUMN IF NOT EXISTS "analystExternalId" TEXT,
      ADD COLUMN IF NOT EXISTS "correlationId" UUID,
      ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  `,
  `
    ALTER TABLE public."CreditDeviceReplacementReview"
      ALTER COLUMN "approvedAt" SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
      ALTER COLUMN "id" SET NOT NULL,
      ALTER COLUMN "replacementId" SET NOT NULL,
      ALTER COLUMN "decision" SET NOT NULL,
      ALTER COLUMN "checklistVersion" SET NOT NULL,
      ALTER COLUMN "checklist" SET NOT NULL,
      ALTER COLUMN "documentHash" SET NOT NULL,
      ALTER COLUMN "imeiHash" SET NOT NULL,
      ALTER COLUMN "checklistHash" SET NOT NULL,
      ALTER COLUMN "identityKeyVersion" SET NOT NULL,
      ALTER COLUMN "accessFingerprint" SET NOT NULL,
      ALTER COLUMN "analystName" SET NOT NULL,
      ALTER COLUMN "analystExternalId" SET NOT NULL,
      ALTER COLUMN "correlationId" SET NOT NULL,
      ALTER COLUMN "approvedAt" SET NOT NULL,
      ALTER COLUMN "createdAt" SET NOT NULL
  `,
  `
    ALTER TABLE public."CreditDeviceReplacementReview"
      DROP CONSTRAINT IF EXISTS "CreditDeviceReplacementReview_decision_check"
  `,
  `
    ALTER TABLE public."CreditDeviceReplacementReview"
      ADD CONSTRAINT "CreditDeviceReplacementReview_decision_check"
        CHECK ("decision" = 'APROBADO')
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacementReview_replacementId_key"
    ON public."CreditDeviceReplacementReview" ("replacementId")
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacementReview_correlationId_key"
    ON public."CreditDeviceReplacementReview" ("correlationId")
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacement_active_credit_key"
    ON public."CreditDeviceReplacement" ("creditId")
    WHERE "status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacement_correlationId_key"
    ON public."CreditDeviceReplacement" ("correlationId")
  `,
  `
    CREATE OR REPLACE FUNCTION public."prevent_credit_device_replacement_review_mutation"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'CreditDeviceReplacementReview is append-only';
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "CreditDeviceReplacementReview_immutable"
    ON public."CreditDeviceReplacementReview"
  `,
  `
    CREATE TRIGGER "CreditDeviceReplacementReview_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditDeviceReplacementReview"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_credit_device_replacement_review_mutation"()
  `,
  `
    CREATE OR REPLACE FUNCTION public."enforce_credit_device_replacement_lifecycle"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'PENDING_ENROLLMENT' THEN
          RAISE EXCEPTION 'CreditDeviceReplacement must start pending enrollment';
        END IF;
        RETURN NEW;
      END IF;

      IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."creditId" IS DISTINCT FROM OLD."creditId"
        OR NEW."solicitudId" IS DISTINCT FROM OLD."solicitudId"
        OR NEW."previousImei" IS DISTINCT FROM OLD."previousImei"
        OR NEW."newImei" IS DISTINCT FROM OLD."newImei"
        OR NEW."reason" IS DISTINCT FROM OLD."reason"
        OR NEW."requestedCreditUpdatedAt" IS DISTINCT FROM OLD."requestedCreditUpdatedAt"
        OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
        OR NEW."createdByName" IS DISTINCT FROM OLD."createdByName"
        OR NEW."createdByUsername" IS DISTINCT FROM OLD."createdByUsername"
        OR NEW."source" IS DISTINCT FROM OLD."source"
        OR NEW."correlationId" IS DISTINCT FROM OLD."correlationId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      THEN
        RAISE EXCEPTION 'CreditDeviceReplacement identity fields are immutable';
      END IF;

      IF NOT (
        (
          OLD."status" = 'PENDING_ENROLLMENT'
          AND NEW."status" IN ('ENROLLMENT_APPROVED', 'CANCELLED')
        )
        OR (
          OLD."status" = 'ENROLLMENT_APPROVED'
          AND NEW."status" IN ('COMPLETED', 'CANCELLED')
        )
      ) THEN
        RAISE EXCEPTION 'Invalid CreditDeviceReplacement status transition: % -> %',
          OLD."status", NEW."status";
      END IF;

      IF NEW."status" = 'COMPLETED' AND (
        NEW."completedByUserId" IS NULL
        OR NULLIF(btrim(NEW."completedByName"), '') IS NULL
        OR NEW."completedAt" IS NULL
      ) THEN
        RAISE EXCEPTION 'Completed replacement requires completion metadata';
      END IF;

      IF NEW."status" = 'CANCELLED' AND (
        NEW."cancelledByUserId" IS NULL
        OR NULLIF(btrim(NEW."cancelledByName"), '') IS NULL
        OR NULLIF(btrim(NEW."cancelledReason"), '') IS NULL
        OR char_length(btrim(NEW."cancelledReason")) NOT BETWEEN 5 AND 500
        OR NEW."cancelledAt" IS NULL
      ) THEN
        RAISE EXCEPTION 'Cancelled replacement requires cancellation metadata';
      END IF;

      IF NEW."status" IN ('ENROLLMENT_APPROVED', 'COMPLETED')
        AND NOT EXISTS (
          SELECT 1
          FROM public."CreditDeviceReplacementReview" review
          WHERE review."replacementId" = NEW."id"
            AND review."decision" = 'APROBADO'
        )
      THEN
        RAISE EXCEPTION 'Approved or completed replacement requires an approved review';
      END IF;

      RETURN NEW;
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "CreditDeviceReplacement_lifecycle"
    ON public."CreditDeviceReplacement"
  `,
  `
    CREATE TRIGGER "CreditDeviceReplacement_lifecycle"
    BEFORE INSERT OR UPDATE ON public."CreditDeviceReplacement"
    FOR EACH ROW EXECUTE FUNCTION public."enforce_credit_device_replacement_lifecycle"()
  `,
  `
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM public."CreditDeviceReplacement" replacement
        WHERE replacement."status" IN ('ENROLLMENT_APPROVED', 'COMPLETED')
          AND NOT EXISTS (
            SELECT 1
            FROM public."CreditDeviceReplacementReview" review
            WHERE review."replacementId" = replacement."id"
              AND review."decision" = 'APROBADO'
          )
      ) THEN
        RAISE EXCEPTION 'Existing replacement lacks an approved review';
      END IF;
    END;
    $$
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS "CreditDeviceReplacement_active_new_imei_key"
    ON public."CreditDeviceReplacement" ("newImei")
    WHERE "status" IN ('PENDING_ENROLLMENT', 'ENROLLMENT_APPROVED')
  `,
  `
    CREATE INDEX IF NOT EXISTS "CreditDeviceReplacement_credit_created_idx"
    ON public."CreditDeviceReplacement" ("creditId", "createdAt" DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS public."CreditDeviceReplacementEvent" (
      "id" UUID NOT NULL,
      "replacementId" UUID NOT NULL,
      "eventType" TEXT NOT NULL,
      "actorType" TEXT NOT NULL,
      "actorUserId" INTEGER,
      "actorName" TEXT NOT NULL,
      "correlationId" UUID NOT NULL,
      "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CreditDeviceReplacementEvent_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "CreditDeviceReplacementEvent_correlationId_key" UNIQUE ("correlationId"),
      CONSTRAINT "CreditDeviceReplacementEvent_replacement_fkey"
        FOREIGN KEY ("replacementId")
        REFERENCES public."CreditDeviceReplacement"("id") ON DELETE RESTRICT,
      CONSTRAINT "CreditDeviceReplacementEvent_actor_fkey"
        FOREIGN KEY ("actorUserId") REFERENCES public."Usuario"("id") ON DELETE SET NULL,
      CONSTRAINT "CreditDeviceReplacementEvent_type_check"
        CHECK ("eventType" IN ('CREATED', 'ENROLLMENT_APPROVED', 'COMPLETED', 'CANCELLED')),
      CONSTRAINT "CreditDeviceReplacementEvent_actor_check"
        CHECK ("actorType" IN ('USER', 'ANALYST', 'SYSTEM_SUPPORT'))
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS "CreditDeviceReplacementEvent_replacement_created_idx"
    ON public."CreditDeviceReplacementEvent" ("replacementId", "createdAt")
  `,
  `
    CREATE OR REPLACE FUNCTION public."prevent_credit_device_replacement_event_mutation"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'CreditDeviceReplacementEvent is append-only';
    END;
    $$
  `,
  `
    DROP TRIGGER IF EXISTS "CreditDeviceReplacementEvent_immutable"
    ON public."CreditDeviceReplacementEvent"
  `,
  `
    CREATE TRIGGER "CreditDeviceReplacementEvent_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditDeviceReplacementEvent"
    FOR EACH ROW EXECUTE FUNCTION public."prevent_credit_device_replacement_event_mutation"()
  `,
];

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '10s'");
  await client.query("SET LOCAL statement_timeout = '120s'");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-device-replacement-schema'))"
  );
  for (const statement of statements) {
    await client.query(statement);
  }
  await client.query("COMMIT");
  console.log("Esquema de reemplazos de equipo verificado.");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
