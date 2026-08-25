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

-- The legacy global table remains in place for blue-green compatibility.
-- New policy profiles use immutable, profile-scoped revisions.
CREATE TABLE IF NOT EXISTS "DataCreditoPolicyProfile" (
  "id" UUID PRIMARY KEY,
  "name" VARCHAR(80) NOT NULL,
  "description" VARCHAR(240),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "DataCreditoPolicyProfile" (
  "id", "name", "description", "active", "createdByUserId"
)
VALUES (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'Política general',
  'Política migrada desde la configuración global de DataCrédito.',
  true,
  NULL
)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "DataCreditoPolicyRevision" (
  "id" UUID PRIMARY KEY,
  "profileId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "policy" JSONB NOT NULL,
  "createdByUserId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataCreditoPolicyRevision_profile_fkey"
    FOREIGN KEY ("profileId")
    REFERENCES "DataCreditoPolicyProfile" ("id")
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoPolicyProfile_name_ci_key"
  ON "DataCreditoPolicyProfile" (LOWER("name"));

CREATE INDEX IF NOT EXISTS "DataCreditoPolicyProfile_active_idx"
  ON "DataCreditoPolicyProfile" ("active", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoPolicyRevision_profile_version_key"
  ON "DataCreditoPolicyRevision" ("profileId", "version");

CREATE INDEX IF NOT EXISTS "DataCreditoPolicyRevision_profile_created_idx"
  ON "DataCreditoPolicyRevision" ("profileId", "createdAt" DESC);

-- Deterministic UUIDs make the legacy backfill idempotent without extensions.
INSERT INTO "DataCreditoPolicyRevision" (
  "id", "profileId", "version", "policy", "createdByUserId", "createdAt"
)
SELECT
  (
    SUBSTRING(MD5('finserpay-datacredito-general:' || legacy."version"::text), 1, 8)
    || '-' || SUBSTRING(MD5('finserpay-datacredito-general:' || legacy."version"::text), 9, 4)
    || '-5' || SUBSTRING(MD5('finserpay-datacredito-general:' || legacy."version"::text), 13, 3)
    || '-a' || SUBSTRING(MD5('finserpay-datacredito-general:' || legacy."version"::text), 16, 3)
    || '-' || SUBSTRING(MD5('finserpay-datacredito-general:' || legacy."version"::text), 19, 12)
  )::uuid,
  '00000000-0000-4000-8000-000000000001'::uuid,
  legacy."version",
  legacy."policy",
  legacy."createdByUserId",
  legacy."createdAt"
FROM "DataCreditoPolicy" legacy
ON CONFLICT ("profileId", "version") DO NOTHING;

-- A fresh database has no legacy revisions. Seed one deterministic,
-- fail-closed revision so the required general profile is always usable
-- by the catalog but can never approve or finance a sale by accident.
WITH seeded AS (
  INSERT INTO "DataCreditoPolicyRevision" (
    "id", "profileId", "version", "policy", "createdByUserId"
  )
  SELECT
    '00000000-0000-5000-a000-000000000001'::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid,
    1,
    $policy$
    {
      "bands": [
        {"id":"bootstrap_android_noinfo","platform":"ANDROID","scoreMin":-1,"scoreMax":-1,"decision":"RECHAZADO","initialPaymentPercentage":0,"suretyPercentage":0,"maxFinancedAmount":1},
        {"id":"bootstrap_android_all","platform":"ANDROID","scoreMin":0,"scoreMax":950,"decision":"RECHAZADO","initialPaymentPercentage":0,"suretyPercentage":0,"maxFinancedAmount":1},
        {"id":"bootstrap_iphone_noinfo","platform":"IPHONE","scoreMin":-1,"scoreMax":-1,"decision":"RECHAZADO","initialPaymentPercentage":0,"suretyPercentage":0,"maxFinancedAmount":1},
        {"id":"bootstrap_iphone_all","platform":"IPHONE","scoreMin":0,"scoreMax":950,"decision":"RECHAZADO","initialPaymentPercentage":0,"suretyPercentage":0,"maxFinancedAmount":1}
      ]
    }
    $policy$::jsonb,
    0
  WHERE NOT EXISTS (SELECT 1 FROM "DataCreditoPolicyRevision")
  ON CONFLICT ("profileId", "version") DO NOTHING
  RETURNING 1
)
UPDATE "DataCreditoPolicyProfile"
SET "description" = 'Bootstrap fail-closed: rechaza toda solicitud hasta publicar una política comercial.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = '00000000-0000-4000-8000-000000000001'::uuid
  AND EXISTS (SELECT 1 FROM seeded);

CREATE OR REPLACE FUNCTION "finser_sync_legacy_datacredito_policy"()
RETURNS TRIGGER AS $$
DECLARE
  digest TEXT;
BEGIN
  digest := MD5('finserpay-datacredito-general:' || NEW."version"::text);
  INSERT INTO "DataCreditoPolicyRevision" (
    "id", "profileId", "version", "policy", "createdByUserId", "createdAt"
  ) VALUES (
    (
      SUBSTRING(digest, 1, 8) || '-' || SUBSTRING(digest, 9, 4)
      || '-5' || SUBSTRING(digest, 13, 3)
      || '-a' || SUBSTRING(digest, 16, 3)
      || '-' || SUBSTRING(digest, 19, 12)
    )::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid,
    NEW."version", NEW."policy", NEW."createdByUserId", NEW."createdAt"
  )
  ON CONFLICT ("profileId", "version") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoPolicy_sync_profile_revision" ON "DataCreditoPolicy";
CREATE TRIGGER "DataCreditoPolicy_sync_profile_revision"
AFTER INSERT ON "DataCreditoPolicy"
FOR EACH ROW EXECUTE FUNCTION "finser_sync_legacy_datacredito_policy"();

CREATE OR REPLACE FUNCTION "finser_prevent_datacredito_revision_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Las revisiones de política DataCrédito son inmutables.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoPolicyRevision_immutable" ON "DataCreditoPolicyRevision";
CREATE TRIGGER "DataCreditoPolicyRevision_immutable"
BEFORE UPDATE OR DELETE ON "DataCreditoPolicyRevision"
FOR EACH ROW EXECUTE FUNCTION "finser_prevent_datacredito_revision_mutation"();

ALTER TABLE "Aliado"
  ADD COLUMN IF NOT EXISTS "dataCreditoPolicyId" UUID;

UPDATE "Aliado"
SET "dataCreditoPolicyId" = '00000000-0000-4000-8000-000000000001'::uuid
WHERE "dataCreditoPolicyId" IS NULL;

ALTER TABLE "Aliado"
  ALTER COLUMN "dataCreditoPolicyId"
    SET DEFAULT '00000000-0000-4000-8000-000000000001'::uuid,
  ALTER COLUMN "dataCreditoPolicyId" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Aliado_dataCreditoPolicy_fkey'
      AND conrelid = '"Aliado"'::regclass
  ) THEN
    ALTER TABLE "Aliado"
      ADD CONSTRAINT "Aliado_dataCreditoPolicy_fkey"
      FOREIGN KEY ("dataCreditoPolicyId")
      REFERENCES "DataCreditoPolicyProfile" ("id")
      ON DELETE RESTRICT;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "Aliado_dataCreditoPolicyId_idx"
  ON "Aliado" ("dataCreditoPolicyId");

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
  "policyRevisionId" UUID NOT NULL,
  "reusedFromAssessmentId" UUID,
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
  ADD COLUMN IF NOT EXISTS "policyRevisionId" UUID,
  ADD COLUMN IF NOT EXISTS "reusedFromAssessmentId" UUID,
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

-- Older runtimes released a timed-out provider attempt as STALE_PENDING.
-- Because the provider may already have charged that request, migrate every
-- historical row to the protected ambiguous outcome before deriving the
-- root 15-day window and propagating it to reused rows.
UPDATE "DataCreditoAssessment"
SET "errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'NO_EVALUADO'
  AND "errorCode" = 'STALE_PENDING';

-- The root owns the contractual 15-day clock. A reused row must never extend
-- it from the clone creation time, even when this setup is executed again.
UPDATE "DataCreditoAssessment" root
SET "expiresAt" = LEAST(
  root."retainedUntil",
  root."createdAt" + INTERVAL '15 days'
)
WHERE root."reusedFromAssessmentId" IS NULL
  AND (
    root."status" IN ('APROBADO', 'RECHAZADO')
    OR (
      root."status" = 'NO_EVALUADO'
      AND (
        root."durationMs" IS NOT NULL
        OR root."errorCode" IN (
          'PROVIDER_OUTCOME_AMBIGUOUS', 'NO_EVALUABLE_INFORMATION',
          'TELCO_RISK_METRIC_UNAVAILABLE', 'POLICY_NO_MATCH'
        )
      )
    )
  );

UPDATE "DataCreditoAssessment" clone
SET "expiresAt" = LEAST(clone."retainedUntil", root."expiresAt")
FROM "DataCreditoAssessment" root
WHERE clone."reusedFromAssessmentId" = root."id";

UPDATE "DataCreditoAssessment" assessment
SET "policyRevisionId" = revision."id"
FROM "DataCreditoPolicyRevision" revision
WHERE assessment."policyRevisionId" IS NULL
  AND revision."profileId" = '00000000-0000-4000-8000-000000000001'::uuid
  AND revision."version" = assessment."policyVersion";

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
  ALTER COLUMN "policyRevisionId" SET NOT NULL,
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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DataCreditoAssessment_policyRevision_fkey'
      AND conrelid = '"DataCreditoAssessment"'::regclass
  ) THEN
    ALTER TABLE "DataCreditoAssessment"
      ADD CONSTRAINT "DataCreditoAssessment_policyRevision_fkey"
      FOREIGN KEY ("policyRevisionId")
      REFERENCES "DataCreditoPolicyRevision" ("id")
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'DataCreditoAssessment_reusedFrom_fkey'
      AND conrelid = '"DataCreditoAssessment"'::regclass
  ) THEN
    ALTER TABLE "DataCreditoAssessment"
      ADD CONSTRAINT "DataCreditoAssessment_reusedFrom_fkey"
      FOREIGN KEY ("reusedFromAssessmentId")
      REFERENCES "DataCreditoAssessment" ("id")
      ON DELETE CASCADE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "finser_resolve_legacy_assessment_revision"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."policyRevisionId" IS NULL THEN
    SELECT revision."id"
    INTO NEW."policyRevisionId"
    FROM "DataCreditoPolicyRevision" revision
    WHERE revision."profileId" = '00000000-0000-4000-8000-000000000001'::uuid
      AND revision."version" = NEW."policyVersion"
    LIMIT 1;
  END IF;
  IF NEW."policyRevisionId" IS NULL THEN
    RAISE EXCEPTION 'No existe revisión para policyVersion %', NEW."policyVersion";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoAssessment_resolve_legacy_revision"
  ON "DataCreditoAssessment";
CREATE TRIGGER "DataCreditoAssessment_resolve_legacy_revision"
BEFORE INSERT ON "DataCreditoAssessment"
FOR EACH ROW EXECUTE FUNCTION "finser_resolve_legacy_assessment_revision"();

-- During a blue-green rollout an old runtime can still reserve with its
-- historical short TTL. Normalize the root exactly when it becomes terminal;
-- clones keep the root expiry so reuse never creates a sliding window.
CREATE OR REPLACE FUNCTION "finser_set_datacredito_terminal_expiry"()
RETURNS TRIGGER AS $$
BEGIN
  -- An old runtime may release a stale PENDING and immediately query again.
  -- The outcome is ambiguous once the process may have reached the provider.
  IF OLD."status" = 'PENDING'
    AND NEW."status" = 'NO_EVALUADO'
    AND NEW."errorCode" = 'STALE_PENDING'
  THEN
    NEW."errorCode" := 'PROVIDER_OUTCOME_AMBIGUOUS';
  END IF;

  IF OLD."status" = 'PENDING'
    AND NEW."reusedFromAssessmentId" IS NULL
    AND (
      NEW."status" IN ('APROBADO', 'RECHAZADO')
      OR (
        NEW."status" = 'NO_EVALUADO'
        AND (
          NEW."durationMs" IS NOT NULL
          OR NEW."errorCode" IN (
            'PROVIDER_OUTCOME_AMBIGUOUS', 'NO_EVALUABLE_INFORMATION',
            'TELCO_RISK_METRIC_UNAVAILABLE', 'POLICY_NO_MATCH'
          )
        )
      )
    )
  THEN
    NEW."expiresAt" := LEAST(
      NEW."retainedUntil",
      NEW."createdAt" + INTERVAL '15 days'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoAssessment_terminal_expiry"
  ON "DataCreditoAssessment";
CREATE TRIGGER "DataCreditoAssessment_terminal_expiry"
BEFORE UPDATE OF "status" ON "DataCreditoAssessment"
FOR EACH ROW EXECUTE FUNCTION "finser_set_datacredito_terminal_expiry"();

LOCK TABLE "DataCreditoAssessment" IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION "finser_guard_datacredito_pending_global"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'datacredito-document:' || NEW."providerEnvironment" || ':' ||
        NEW."documentHash",
      0::bigint
    )
  );

  IF EXISTS (
    SELECT 1
    FROM "DataCreditoAssessment" assessment
    WHERE assessment."documentHash" = NEW."documentHash"
      AND assessment."providerEnvironment" = NEW."providerEnvironment"
      AND (
        assessment."status" = 'PENDING'
        OR (
          assessment."status" IN ('APROBADO', 'RECHAZADO')
          AND assessment."expiresAt" > CURRENT_TIMESTAMP
        )
        OR (
          assessment."status" = 'NO_EVALUADO'
          AND assessment."expiresAt" > CURRENT_TIMESTAMP
          AND (
            assessment."durationMs" IS NOT NULL
            OR assessment."errorCode" IN (
              'PROVIDER_OUTCOME_AMBIGUOUS', 'NO_EVALUABLE_INFORMATION',
              'TELCO_RISK_METRIC_UNAVAILABLE', 'POLICY_NO_MATCH'
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'Ya existe una consulta DataCredito activa para documento y ambiente'
      USING ERRCODE = '23505',
        CONSTRAINT = 'DataCreditoAssessment_document_guard_key';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoAssessment_global_pending_guard"
  ON "DataCreditoAssessment";
DROP TRIGGER IF EXISTS "DataCreditoAssessment_guard_pending_global"
  ON "DataCreditoAssessment";
CREATE TRIGGER "DataCreditoAssessment_guard_pending_global"
BEFORE INSERT ON "DataCreditoAssessment"
FOR EACH ROW
WHEN (NEW."status" = 'PENDING')
EXECUTE FUNCTION "finser_guard_datacredito_pending_global"();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DataCreditoAssessment" assessment
    WHERE assessment."status" = 'APROBADO'
      AND assessment."expiresAt" > CURRENT_TIMESTAMP
      AND assessment."claimTokenHash" IS NOT NULL
      AND assessment."claimExpiresAt" > CURRENT_TIMESTAMP
    GROUP BY assessment."documentHash", assessment."providerEnvironment"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Existen reclamaciones DataCredito globales duplicadas; espere su vencimiento y reintente el setup';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "finser_guard_datacredito_global_usage_v1"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."documentHash" IS DISTINCT FROM OLD."documentHash"
    OR NEW."providerEnvironment" IS DISTINCT FROM OLD."providerEnvironment"
  THEN
    RAISE EXCEPTION
      'La llave global de una consulta DataCredito es inmutable'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'datacredito-document:' || NEW."providerEnvironment" || ':' ||
        NEW."documentHash",
      0::bigint
    )
  );

  -- A confirmed consumption can never be moved to another credit.
  IF OLD."consumedAt" IS NOT NULL
    AND (
      NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt"
      OR NEW."creditId" IS DISTINCT FROM OLD."creditId"
    )
  THEN
    RETURN NULL;
  END IF;

  -- Old runtimes update the root and every clone. Skipping rows without the
  -- active claim turns that legacy statement into an exact one-row consume.
  IF OLD."consumedAt" IS NULL AND NEW."consumedAt" IS NOT NULL THEN
    IF OLD."status" <> 'APROBADO'
      OR OLD."expiresAt" <= CURRENT_TIMESTAMP
      OR OLD."claimTokenHash" IS NULL
      OR OLD."claimExpiresAt" IS NULL
      OR OLD."claimExpiresAt" <= CURRENT_TIMESTAMP
      OR NEW."creditId" IS NULL
      OR NEW."creditId" <= 0
    THEN
      RETURN NULL;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "DataCreditoAssessment" other
      WHERE other."id" <> OLD."id"
        AND other."documentHash" = OLD."documentHash"
        AND other."providerEnvironment" = OLD."providerEnvironment"
        AND other."status" IN ('APROBADO', 'RECHAZADO')
        AND other."expiresAt" > CURRENT_TIMESTAMP
        AND other."consumedAt" IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM "DataCreditoAssessment" other
      WHERE other."id" <> OLD."id"
        AND other."documentHash" = OLD."documentHash"
        AND other."providerEnvironment" = OLD."providerEnvironment"
        AND other."status" = 'APROBADO'
        AND other."expiresAt" > CURRENT_TIMESTAMP
        AND other."claimTokenHash" IS NOT NULL
        AND other."claimExpiresAt" > CURRENT_TIMESTAMP
    ) THEN
      RETURN NULL;
    END IF;

    RETURN NEW;
  END IF;

  -- Claim creation or renewal is globally exclusive for the document.
  IF (
    NEW."claimTokenHash" IS NOT NULL
    OR NEW."claimExpiresAt" IS NOT NULL
  ) AND (
    NEW."claimTokenHash" IS DISTINCT FROM OLD."claimTokenHash"
    OR NEW."claimExpiresAt" IS DISTINCT FROM OLD."claimExpiresAt"
  ) THEN
    IF NEW."claimTokenHash" IS NULL
      OR NEW."claimExpiresAt" IS NULL
      OR NEW."claimExpiresAt" <= CURRENT_TIMESTAMP
      OR (
        OLD."claimTokenHash" IS NOT NULL
        AND OLD."claimExpiresAt" > CURRENT_TIMESTAMP
      )
      OR NEW."status" <> 'APROBADO'
      OR NEW."expiresAt" <= CURRENT_TIMESTAMP
      OR NEW."consumedAt" IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM "DataCreditoAssessment" other
        WHERE other."documentHash" = NEW."documentHash"
          AND other."providerEnvironment" = NEW."providerEnvironment"
          AND other."status" IN ('APROBADO', 'RECHAZADO')
          AND other."expiresAt" > CURRENT_TIMESTAMP
          AND other."consumedAt" IS NOT NULL
      )
      OR EXISTS (
        SELECT 1
        FROM "DataCreditoAssessment" other
        WHERE other."id" <> OLD."id"
          AND other."documentHash" = NEW."documentHash"
          AND other."providerEnvironment" = NEW."providerEnvironment"
          AND other."status" = 'APROBADO'
          AND other."expiresAt" > CURRENT_TIMESTAMP
          AND other."claimTokenHash" IS NOT NULL
          AND other."claimExpiresAt" > CURRENT_TIMESTAMP
      )
    THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "DataCreditoAssessment_guard_global_usage"
  ON "DataCreditoAssessment";
CREATE TRIGGER "DataCreditoAssessment_guard_global_usage"
BEFORE UPDATE OF "claimTokenHash", "claimExpiresAt", "consumedAt", "creditId"
ON "DataCreditoAssessment"
FOR EACH ROW
EXECUTE FUNCTION "finser_guard_datacredito_global_usage_v1"();

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

CREATE TABLE IF NOT EXISTS "DataCreditoPolicyAssignmentAudit" (
  "id" UUID PRIMARY KEY,
  "allyId" INTEGER NOT NULL,
  "previousPolicyId" UUID NOT NULL,
  "policyId" UUID NOT NULL,
  "actorUserId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataCreditoPolicyAssignmentAudit_ally_fkey"
    FOREIGN KEY ("allyId") REFERENCES "Aliado" ("id") ON DELETE RESTRICT,
  CONSTRAINT "DataCreditoPolicyAssignmentAudit_previous_fkey"
    FOREIGN KEY ("previousPolicyId")
    REFERENCES "DataCreditoPolicyProfile" ("id") ON DELETE RESTRICT,
  CONSTRAINT "DataCreditoPolicyAssignmentAudit_policy_fkey"
    FOREIGN KEY ("policyId")
    REFERENCES "DataCreditoPolicyProfile" ("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "DataCreditoPolicyAssignmentAudit_ally_created_idx"
  ON "DataCreditoPolicyAssignmentAudit" ("allyId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "DataCreditoPolicyAssignmentAudit_policy_created_idx"
  ON "DataCreditoPolicyAssignmentAudit" ("policyId", "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_correlation_key"
  ON "DataCreditoAssessment" ("correlationId");

DROP INDEX IF EXISTS "DataCreditoAssessment_pending_key";
CREATE UNIQUE INDEX "DataCreditoAssessment_pending_key"
  ON "DataCreditoAssessment" (
    "documentHash", "surnameHash", "platform", "policyRevisionId", "userId",
    COALESCE("sellerId", 0), "sedeId", COALESCE("aliadoId", 0)
  )
  WHERE "status" = 'PENDING';

-- A pending older than six minutes cannot still own the provider sequence.
-- Normalize it before installing the global anti-query uniqueness barrier.
UPDATE "DataCreditoAssessment"
SET "status" = 'NO_EVALUADO',
    "errorCode" = 'PROVIDER_OUTCOME_AMBIGUOUS',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'PENDING'
  AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '6 minutes';

CREATE UNIQUE INDEX IF NOT EXISTS "DataCreditoAssessment_pending_document_key"
  ON "DataCreditoAssessment" (
    "documentHash", "providerEnvironment", COALESCE("aliadoId", 0)
  )
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_idx"
  ON "DataCreditoAssessment" (
    "documentHash", COALESCE("aliadoId", 0),
    "expiresAt" DESC, "createdAt" DESC
  );

CREATE INDEX IF NOT EXISTS "DataCreditoAssessment_reuse_environment_idx"
  ON "DataCreditoAssessment" (
    "documentHash", "providerEnvironment", COALESCE("aliadoId", 0),
    "expiresAt" DESC, "createdAt" DESC
  );

DROP INDEX IF EXISTS "DataCreditoAssessment_pending_global_key";
CREATE UNIQUE INDEX "DataCreditoAssessment_pending_global_key"
  ON "DataCreditoAssessment" ("documentHash", "providerEnvironment")
  WHERE "status" = 'PENDING';

DROP INDEX IF EXISTS "DataCreditoAssessment_reuse_global_idx";
CREATE INDEX "DataCreditoAssessment_reuse_global_idx"
  ON "DataCreditoAssessment" (
    "documentHash", "expiresAt" DESC, "createdAt" DESC
  );

DROP INDEX IF EXISTS "DataCreditoAssessment_reuse_environment_global_idx";
CREATE INDEX "DataCreditoAssessment_reuse_environment_global_idx"
  ON "DataCreditoAssessment" (
    "documentHash", "providerEnvironment",
    "expiresAt" DESC, "createdAt" DESC
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
