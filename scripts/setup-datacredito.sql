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
  "status" = COALESCE("status", 'NO_EVALUADO'),
  "expiresAt" = COALESCE("expiresAt", CURRENT_TIMESTAMP),
  "retainedUntil" = COALESCE("retainedUntil", CURRENT_TIMESTAMP),
  "createdAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE
  "status" IS NULL
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

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_rate_idx"
  ON "DataCreditoAssessment" ("userId", "sellerId", "sedeId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_retention_idx"
  ON "DataCreditoAssessment" ("retainedUntil");

COMMIT;
