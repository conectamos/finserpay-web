-- FINSER PAY schema change: 2026-08-11 / DataCredito prequalification v1
-- Idempotent preflight. Run before DATACREDITO_QUERY_ENABLED=true:
--   npm run db:setup-datacredito

BEGIN;

CREATE TABLE IF NOT EXISTS "DataCreditoPolicy" (
  "version" INTEGER PRIMARY KEY,
  "policy" JSONB NOT NULL,
  "createdByUserId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "DataCreditoAssessment" (
  "id" UUID PRIMARY KEY,
  "documentHash" CHAR(64) NOT NULL,
  "documentLast4" VARCHAR(4) NOT NULL,
  "surnameHash" CHAR(64) NOT NULL,
  "platform" VARCHAR(16) NOT NULL,
  "providerEnvironment" VARCHAR(32) NOT NULL DEFAULT 'legacy',
  "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  "score" INTEGER,
  "decision" VARCHAR(16),
  "offer" JSONB,
  "policyVersion" INTEGER NOT NULL,
  "consentVersion" VARCHAR(16) NOT NULL,
  "consentHash" CHAR(64) NOT NULL,
  "consentAt" TIMESTAMP(3) NOT NULL,
  "userId" INTEGER NOT NULL,
  "sellerId" INTEGER,
  "sedeId" INTEGER NOT NULL,
  "aliadoId" INTEGER,
  "ipHash" CHAR(64),
  "userAgentHash" CHAR(64),
  "correlationId" UUID NOT NULL,
  "transactionCode" VARCHAR(32),
  "providerStatus" VARCHAR(64),
  "errorCode" VARCHAR(64),
  "durationMs" INTEGER,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "claimTokenHash" CHAR(64),
  "claimExpiresAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "creditId" INTEGER,
  "retainedUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "DataCreditoAssessment"
  ADD COLUMN IF NOT EXISTS "documentHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "documentLast4" VARCHAR(4),
  ADD COLUMN IF NOT EXISTS "surnameHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "platform" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "providerEnvironment" VARCHAR(32) DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(24) DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "score" INTEGER,
  ADD COLUMN IF NOT EXISTS "decision" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "offer" JSONB,
  ADD COLUMN IF NOT EXISTS "policyVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "consentVersion" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "consentHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "consentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "userId" INTEGER,
  ADD COLUMN IF NOT EXISTS "sellerId" INTEGER,
  ADD COLUMN IF NOT EXISTS "sedeId" INTEGER,
  ADD COLUMN IF NOT EXISTS "aliadoId" INTEGER,
  ADD COLUMN IF NOT EXISTS "ipHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "userAgentHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "correlationId" UUID,
  ADD COLUMN IF NOT EXISTS "transactionCode" VARCHAR(32),
  ADD COLUMN IF NOT EXISTS "providerStatus" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "errorCode" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "durationMs" INTEGER,
  ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "claimTokenHash" CHAR(64),
  ADD COLUMN IF NOT EXISTS "claimExpiresAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "creditId" INTEGER,
  ADD COLUMN IF NOT EXISTS "retainedUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

UPDATE "DataCreditoAssessment"
SET
  "providerEnvironment" = COALESCE("providerEnvironment", 'legacy'),
  "status" = COALESCE("status", 'NO_EVALUADO'),
  "expiresAt" = COALESCE("expiresAt", CURRENT_TIMESTAMP),
  "retainedUntil" = COALESCE("retainedUntil", CURRENT_TIMESTAMP),
  "createdAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE
  "providerEnvironment" IS NULL
  OR "status" IS NULL
  OR "expiresAt" IS NULL
  OR "retainedUntil" IS NULL
  OR "createdAt" IS NULL
  OR "updatedAt" IS NULL;

-- Fail the preflight instead of accepting a partially upgraded audit table.
-- Existing incomplete rows must be remediated explicitly before activation.
ALTER TABLE "DataCreditoAssessment"
  ALTER COLUMN "documentHash" SET NOT NULL,
  ALTER COLUMN "documentLast4" SET NOT NULL,
  ALTER COLUMN "surnameHash" SET NOT NULL,
  ALTER COLUMN "platform" SET NOT NULL,
  ALTER COLUMN "providerEnvironment" SET DEFAULT 'legacy',
  ALTER COLUMN "providerEnvironment" SET NOT NULL,
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "policyVersion" SET NOT NULL,
  ALTER COLUMN "consentVersion" SET NOT NULL,
  ALTER COLUMN "consentHash" SET NOT NULL,
  ALTER COLUMN "consentAt" SET NOT NULL,
  ALTER COLUMN "userId" SET NOT NULL,
  ALTER COLUMN "sedeId" SET NOT NULL,
  ALTER COLUMN "correlationId" SET NOT NULL,
  ALTER COLUMN "expiresAt" SET NOT NULL,
  ALTER COLUMN "retainedUntil" SET NOT NULL,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "DataCreditoAssessmentSecurePayload" (
  "assessmentId" UUID PRIMARY KEY,
  "algorithm" VARCHAR(32) NOT NULL,
  "keyId" VARCHAR(32) NOT NULL,
  "aadVersion" INTEGER NOT NULL,
  "plaintextVersion" INTEGER NOT NULL,
  "nonce" BYTEA NOT NULL,
  "authTag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "plaintextBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataCreditoSecurePayload_assessment_fkey"
    FOREIGN KEY ("assessmentId")
    REFERENCES "DataCreditoAssessment" ("id")
    ON DELETE CASCADE,
  CONSTRAINT "DataCreditoSecurePayload_algorithm_check"
    CHECK ("algorithm" = 'AES-256-GCM'),
  CONSTRAINT "DataCreditoSecurePayload_key_id_check"
    CHECK ("keyId" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  CONSTRAINT "DataCreditoSecurePayload_aad_version_check"
    CHECK ("aadVersion" > 0),
  CONSTRAINT "DataCreditoSecurePayload_plaintext_version_check"
    CHECK ("plaintextVersion" > 0),
  CONSTRAINT "DataCreditoSecurePayload_nonce_check"
    CHECK (octet_length("nonce") = 12),
  CONSTRAINT "DataCreditoSecurePayload_auth_tag_check"
    CHECK (octet_length("authTag") = 16),
  CONSTRAINT "DataCreditoSecurePayload_plaintext_size_check"
    CHECK ("plaintextBytes" BETWEEN 1 AND 6291456),
  CONSTRAINT "DataCreditoSecurePayload_ciphertext_size_check"
    CHECK (octet_length("ciphertext") = "plaintextBytes")
);

CREATE TABLE IF NOT EXISTS "DataCreditoAdminAccessAudit" (
  "id" UUID PRIMARY KEY,
  "assessmentId" UUID NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "requestCorrelationId" UUID NOT NULL,
  "ipHash" CHAR(64),
  "userAgentHash" CHAR(64),
  "retainedUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataCreditoAdminAudit_assessment_fkey"
    FOREIGN KEY ("assessmentId")
    REFERENCES "DataCreditoAssessment" ("id")
    ON DELETE CASCADE,
  CONSTRAINT "DataCreditoAdminAudit_action_check"
    CHECK ("action" ~ '^[A-Z][A-Z0-9_]{0,31}$'),
  CONSTRAINT "DataCreditoAdminAudit_outcome_check"
    CHECK ("outcome" ~ '^[A-Z][A-Z0-9_]{0,31}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_correlation_key"
  ON "DataCreditoAssessment" ("correlationId");

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_key"
  ON "DataCreditoAssessment" (
    "documentHash", "surnameHash", "platform", "policyVersion", "userId",
    COALESCE("sellerId", 0), "sedeId", COALESCE("aliadoId", 0)
  )
  WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_document_key"
  ON "DataCreditoAssessment" (
    "documentHash", "platform", "sedeId", COALESCE("aliadoId", 0)
  )
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_idx"
  ON "DataCreditoAssessment" (
    "documentHash", "surnameHash", "platform", "policyVersion", "sedeId",
    "expiresAt" DESC
  );

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_environment_idx"
  ON "DataCreditoAssessment" (
    "documentHash", "surnameHash", "platform", "providerEnvironment",
    "policyVersion", "sedeId", "expiresAt" DESC
  );

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_rate_idx"
  ON "DataCreditoAssessment" ("userId", "sellerId", "sedeId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_retention_idx"
  ON "DataCreditoAssessment" ("retainedUntil");

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_created_idx"
  ON "DataCreditoAssessment" ("createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_document_idx"
  ON "DataCreditoAssessment" ("documentHash", "createdAt" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_admin_status_idx"
  ON "DataCreditoAssessment" ("status", "createdAt" DESC, "id" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoSecurePayload_key_nonce_key"
  ON "DataCreditoAssessmentSecurePayload" ("keyId", "nonce");

CREATE INDEX IF NOT EXISTS "DataCreditoAdminAudit_retention_idx"
  ON "DataCreditoAdminAccessAudit" ("retainedUntil");

CREATE INDEX IF NOT EXISTS "DataCreditoAdminAudit_assessment_created_idx"
  ON "DataCreditoAdminAccessAudit" ("assessmentId", "createdAt" DESC);

COMMIT;
