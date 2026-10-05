import "server-only";

import prisma from "@/lib/prisma";

let setup: Promise<void> | null = null;

/** The operational ledger is separate from the pre-settlement approval ledger. */
export function ensureApprovalOperationalSchema() {
  if (!setup) {
    setup = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ApprovalOperationalAction" (
        "id" UUID PRIMARY KEY,
        "targetKind" TEXT NOT NULL CHECK ("targetKind" IN ('CREDIT','DRAFT')),
        "targetId" INTEGER NOT NULL CHECK ("targetId">0),
        "creditId" INTEGER REFERENCES "Credito"("id") ON DELETE RESTRICT,
        "eventType" TEXT NOT NULL CHECK ("eventType" IN
          ('IMEI_REQUESTED','IMEI_APPLIED','IMEI_CORRECTED','CONTACT_UPDATED','SIGNATURE_REQUESTED')),
        "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
        "actorName" TEXT NOT NULL,
        "previousImei" TEXT,
        "newImei" TEXT,
        "reason" TEXT NOT NULL,
        "evidenceMime" TEXT,
        "evidenceName" TEXT,
        "evidenceData" BYTEA,
        "evidenceSha256" CHAR(64),
        "beforeContact" JSONB,
        "afterContact" JSONB,
        "status" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        CONSTRAINT "ApprovalOperationalAction_reason_check" CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
        CONSTRAINT "ApprovalOperationalAction_evidence_check" CHECK (
          ("evidenceData" IS NULL AND "evidenceMime" IS NULL AND "evidenceName" IS NULL AND "evidenceSha256" IS NULL)
          OR ("evidenceData" IS NOT NULL AND "evidenceMime" IS NOT NULL AND "evidenceName" IS NOT NULL
            AND "evidenceSha256" ~ '^[a-f0-9]{64}$' AND OCTET_LENGTH("evidenceData") <= 10485760))
      )`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ApprovalOperationalAction_target_created"
        ON "ApprovalOperationalAction"("targetKind","targetId","createdAt" DESC,"id" DESC)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ApprovalOperationalContractVersion" (
        "id" UUID PRIMARY KEY,
        "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
        "replacementId" UUID,
        "previousProcessUuid" TEXT NOT NULL,
        "supersededProcessUuid" TEXT,
        "newProcessUuid" TEXT UNIQUE,
        "previousImei" TEXT NOT NULL CHECK ("previousImei" ~ '^[0-9]{15}$'),
        "newImei" TEXT NOT NULL CHECK ("newImei" ~ '^[0-9]{15}$'),
        "sentPhone" TEXT,
        "sentEmail" TEXT,
        "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
        "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
        "actorName" TEXT NOT NULL,
        "status" TEXT NOT NULL CHECK ("status" IN
          ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','COMPLETED','FAILED_SAFE','UNCERTAIN','TECHNICAL_ERROR')),
        "version" INTEGER NOT NULL CHECK ("version">0),
        "sourceTermsHash" CHAR(64) NOT NULL CHECK ("sourceTermsHash" ~ '^[a-f0-9]{64}$'),
        "originalDocumentHash" CHAR(64) NOT NULL CHECK ("originalDocumentHash" ~ '^[a-f0-9]{64}$'),
        "documentBase64" TEXT,
        "documentHash" CHAR(64),
        "frozenCredit" JSONB NOT NULL,
        "requestPayload" JSONB,
        "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        "lastCheckedAt" TIMESTAMP(3),
        "completedAt" TIMESTAMP(3),
        CONSTRAINT "ApprovalOperationalContractVersion_document_check" CHECK (
          ("documentBase64" IS NULL AND "documentHash" IS NULL)
          OR ("documentBase64" IS NOT NULL AND "documentHash" ~ '^[a-f0-9]{64}$')),
        CONSTRAINT "ApprovalOperationalContractVersion_dispatch_check" CHECK (
          "status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','COMPLETED') OR "documentBase64" IS NOT NULL),
        CONSTRAINT "ApprovalOperationalContractVersion_process_check" CHECK (
          "status" NOT IN ('AWAITING_SIGNATURE','COMPLETED') OR "newProcessUuid" IS NOT NULL)
      )`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "ApprovalOperationalContractVersion"
        ADD COLUMN IF NOT EXISTS "supersededProcessUuid" TEXT`);
      // Existing installations retain the original inline CHECK after CREATE IF
      // NOT EXISTS. Replace it before any mutation can record a terminal failure.
      await prisma.$executeRawUnsafe(`ALTER TABLE "ApprovalOperationalContractVersion"
        DROP CONSTRAINT IF EXISTS "ApprovalOperationalContractVersion_status_check",
        ADD CONSTRAINT "ApprovalOperationalContractVersion_status_check" CHECK ("status" IN
          ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','COMPLETED','FAILED_SAFE','UNCERTAIN','TECHNICAL_ERROR'))`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalOperationalContractVersion_one_pending"
        ON "ApprovalOperationalContractVersion"("creditoId")
        WHERE "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "ApprovalOperationalContractVersion_credit_version"
        ON "ApprovalOperationalContractVersion"("creditoId","version")`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ApprovalOperationalContractVersion_credit_created"
        ON "ApprovalOperationalContractVersion"("creditoId","requestedAt" DESC,"id" DESC)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ApprovalOperationalContractVersionEvent" (
        "id" BIGSERIAL PRIMARY KEY,
        "operationId" UUID NOT NULL REFERENCES "ApprovalOperationalContractVersion"("id") ON DELETE RESTRICT,
        "previousStatus" TEXT,
        "status" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.approval_operational_immutable()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'OPERATIONAL_AUDIT_IMMUTABLE' USING ERRCODE='23514';
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "ApprovalOperationalAction_immutable"
        BEFORE UPDATE OR DELETE ON "ApprovalOperationalAction"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_immutable()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "ApprovalOperationalContractVersionEvent_immutable"
        BEFORE UPDATE OR DELETE ON "ApprovalOperationalContractVersionEvent"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_immutable()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.approval_operational_version_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP='INSERT' THEN
            INSERT INTO "ApprovalOperationalContractVersionEvent"("operationId","status") VALUES (NEW."id",NEW."status");
          ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
            INSERT INTO "ApprovalOperationalContractVersionEvent"("operationId","previousStatus","status")
              VALUES (NEW."id",OLD."status",NEW."status");
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "ApprovalOperationalContractVersion_audit"
        AFTER INSERT OR UPDATE ON "ApprovalOperationalContractVersion"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_version_audit()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.approval_operational_version_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OPERATIONAL_VERSION_IMMUTABLE' USING ERRCODE='23514'; END IF;
          IF ROW(OLD."id",OLD."creditoId",OLD."replacementId",OLD."previousProcessUuid",OLD."supersededProcessUuid",
            OLD."previousImei",OLD."newImei",OLD."sentPhone",OLD."sentEmail",OLD."reason",
            OLD."actorUserId",OLD."actorName",OLD."version",OLD."sourceTermsHash",
            OLD."originalDocumentHash",OLD."frozenCredit",OLD."requestedAt")
            IS DISTINCT FROM ROW(NEW."id",NEW."creditoId",NEW."replacementId",NEW."previousProcessUuid",NEW."supersededProcessUuid",
            NEW."previousImei",NEW."newImei",NEW."sentPhone",NEW."sentEmail",NEW."reason",
            NEW."actorUserId",NEW."actorName",NEW."version",NEW."sourceTermsHash",
            NEW."originalDocumentHash",NEW."frozenCredit",NEW."requestedAt")
            OR (OLD."documentBase64" IS NOT NULL AND OLD."documentBase64" IS DISTINCT FROM NEW."documentBase64")
            OR (OLD."documentHash" IS NOT NULL AND OLD."documentHash" IS DISTINCT FROM NEW."documentHash")
            OR (OLD."newProcessUuid" IS NOT NULL AND OLD."newProcessUuid" IS DISTINCT FROM NEW."newProcessUuid")
            OR (OLD."requestPayload" IS NOT NULL AND OLD."requestPayload" IS DISTINCT FROM NEW."requestPayload") THEN
            RAISE EXCEPTION 'OPERATIONAL_VERSION_IMMUTABLE' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "ApprovalOperationalContractVersion_guard"
        BEFORE UPDATE OR DELETE ON "ApprovalOperationalContractVersion"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_version_guard()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.approval_operational_preserve_original()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" version
            WHERE version."previousProcessUuid"=OLD."processUuid") THEN
            IF TG_OP='DELETE' THEN RAISE EXCEPTION 'OPERATIONAL_SIGNATURE_IMMUTABLE' USING ERRCODE='23514'; END IF;
            IF ROW(OLD."processUuid",OLD."creditoId",OLD."signedDocumentBase64",OLD."signedDocumentFileName",OLD."draftPayload",OLD."completedAt")
              IS DISTINCT FROM ROW(NEW."processUuid",NEW."creditoId",NEW."signedDocumentBase64",NEW."signedDocumentFileName",NEW."draftPayload",NEW."completedAt")
              OR (OLD."supersededAt" IS NOT NULL AND OLD."supersededAt" IS DISTINCT FROM NEW."supersededAt") THEN
              RAISE EXCEPTION 'OPERATIONAL_SIGNATURE_IMMUTABLE' USING ERRCODE='23514';
            END IF;
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`DO $$ BEGIN IF to_regclass('public."FirmaSeguroProcess"') IS NOT NULL THEN
        EXECUTE 'CREATE OR REPLACE TRIGGER "FirmaSeguroProcess_preserve_operational_original"
          BEFORE UPDATE OR DELETE ON "FirmaSeguroProcess"
          FOR EACH ROW EXECUTE FUNCTION public.approval_operational_preserve_original()';
        END IF; END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.approval_operational_guard_pre_settlement()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_TABLE_NAME='CreditApprovalReview' THEN
            IF NEW."status"<>'APPROVED' THEN RETURN NEW; END IF;
          END IF;
          IF EXISTS (SELECT 1 FROM "CreditDeviceReplacement" replacement
            WHERE replacement."creditId"=NEW."creditoId"
              AND replacement."source"='APPROVAL_OPERATIONS'
              AND replacement."status" IN ('PENDING_ENROLLMENT','ENROLLMENT_APPROVED'))
            OR EXISTS (SELECT 1 FROM "ApprovalOperationalContractVersion" version
              WHERE version."creditoId"=NEW."creditoId"
                AND version."version"=(SELECT MAX(latest."version") FROM "ApprovalOperationalContractVersion" latest
                  WHERE latest."creditoId"=NEW."creditoId")
                AND version."status"<>'COMPLETED') THEN
            RAISE EXCEPTION 'OPERATIONAL_IMEI_SIGNATURE_PENDING' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditApprovalReview_require_operational_completion"
        BEFORE INSERT OR UPDATE ON "CreditApprovalReview"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_guard_pre_settlement()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_operational_completion"
        BEFORE INSERT ON "LiquidacionAliadoCredito"
        FOR EACH ROW EXECUTE FUNCTION public.approval_operational_guard_pre_settlement()`);
    })().catch((error) => { setup = null; throw error; });
  }
  return setup;
}
