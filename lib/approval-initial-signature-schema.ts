import "server-only";

import prisma from "@/lib/prisma";

let setup: Promise<void> | null = null;

/** Durable, single-dispatch ledger for the first signature of an approval credit. */
export function ensureApprovalInitialSignatureSchema() {
  if (!setup) {
    setup = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CreditApprovalInitialSignature" (
        "id" UUID PRIMARY KEY,
        "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
        "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision">0),
        "sourceReviewHash" CHAR(64) NOT NULL CHECK ("sourceReviewHash" ~ '^[a-f0-9]{64}$'),
        "reservedRevision" INTEGER NOT NULL CHECK ("reservedRevision">"sourceRevision"),
        "termsHash" CHAR(64) NOT NULL CHECK ("termsHash" ~ '^[a-f0-9]{64}$'),
        "frozenCredit" JSONB NOT NULL,
        "sourceSeal" JSONB NOT NULL,
        "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
        "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
        "actorName" TEXT NOT NULL,
        "status" TEXT NOT NULL CHECK ("status" IN
          ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','COMPLETED','FAILED_SAFE','UNCERTAIN','TECHNICAL_ERROR')),
        "documentBase64" TEXT,
        "documentHash" CHAR(64),
        "requestPayload" JSONB,
        "processUuid" TEXT UNIQUE,
        "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
        "completedAt" TIMESTAMP(3),
        CONSTRAINT "CreditApprovalInitialSignature_document_check" CHECK (
          ("documentBase64" IS NULL AND "documentHash" IS NULL)
          OR ("documentBase64" IS NOT NULL AND "documentHash" ~ '^[a-f0-9]{64}$')),
        CONSTRAINT "CreditApprovalInitialSignature_dispatch_check" CHECK (
          "status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','COMPLETED') OR "documentBase64" IS NOT NULL),
        CONSTRAINT "CreditApprovalInitialSignature_process_check" CHECK (
          "status" NOT IN ('AWAITING_SIGNATURE','COMPLETED') OR "processUuid" IS NOT NULL),
        CONSTRAINT "CreditApprovalInitialSignature_completed_check" CHECK (
          "status"<>'COMPLETED' OR "completedAt" IS NOT NULL)
      )`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalInitialSignature_one_pending"
        ON "CreditApprovalInitialSignature"("creditoId")
        WHERE "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CreditApprovalInitialSignature_credit_created"
        ON "CreditApprovalInitialSignature"("creditoId","requestedAt" DESC)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CreditApprovalInitialSignatureEvent" (
        "id" BIGSERIAL PRIMARY KEY,
        "operationId" UUID NOT NULL REFERENCES "CreditApprovalInitialSignature"("id") ON DELETE RESTRICT,
        "previousStatus" TEXT,
        "status" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      )`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.credit_approval_initial_signature_protect()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INITIAL_SIGNATURE_IMMUTABLE' USING ERRCODE='23514'; END IF;
          IF TG_OP='UPDATE' THEN
            IF ROW(OLD."id",OLD."creditoId",OLD."sourceRevision",OLD."sourceReviewHash",
              OLD."reservedRevision",OLD."termsHash",OLD."frozenCredit",OLD."sourceSeal",
              OLD."reason",OLD."actorUserId",OLD."actorName",OLD."requestedAt")
              IS DISTINCT FROM ROW(NEW."id",NEW."creditoId",NEW."sourceRevision",NEW."sourceReviewHash",
              NEW."reservedRevision",NEW."termsHash",NEW."frozenCredit",NEW."sourceSeal",
              NEW."reason",NEW."actorUserId",NEW."actorName",NEW."requestedAt")
              OR (OLD."documentBase64" IS NOT NULL AND
                ROW(OLD."documentBase64",OLD."documentHash",OLD."requestPayload")
                IS DISTINCT FROM ROW(NEW."documentBase64",NEW."documentHash",NEW."requestPayload"))
              OR (OLD."processUuid" IS NOT NULL AND OLD."processUuid" IS DISTINCT FROM NEW."processUuid")
            THEN RAISE EXCEPTION 'INITIAL_SIGNATURE_IMMUTABLE' USING ERRCODE='23514'; END IF;
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditApprovalInitialSignature_protect"
        BEFORE UPDATE OR DELETE ON "CreditApprovalInitialSignature"
        FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initial_signature_protect()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.credit_approval_initial_signature_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_OP='INSERT' THEN
            INSERT INTO "CreditApprovalInitialSignatureEvent"("operationId","status")
              VALUES (NEW."id",NEW."status");
          ELSIF OLD."status" IS DISTINCT FROM NEW."status" THEN
            INSERT INTO "CreditApprovalInitialSignatureEvent"("operationId","previousStatus","status")
              VALUES (NEW."id",OLD."status",NEW."status");
          END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditApprovalInitialSignature_audit"
        AFTER INSERT OR UPDATE ON "CreditApprovalInitialSignature"
        FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initial_signature_audit()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.credit_approval_initial_signature_event_immutable()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'INITIAL_SIGNATURE_AUDIT_IMMUTABLE' USING ERRCODE='23514';
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditApprovalInitialSignatureEvent_immutable"
        BEFORE UPDATE OR DELETE ON "CreditApprovalInitialSignatureEvent"
        FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initial_signature_event_immutable()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.credit_approval_initial_signature_settlement_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF TG_TABLE_NAME='CreditApprovalReview' THEN
            IF NEW."status"<>'APPROVED' THEN RETURN NEW; END IF;
          END IF;
          IF EXISTS (SELECT 1 FROM "CreditApprovalInitialSignature" operation
            WHERE operation."creditoId"=NEW."creditoId"
              AND operation."status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN'))
          THEN RAISE EXCEPTION 'INITIAL_SIGNATURE_PENDING' USING ERRCODE='23514'; END IF;
          RETURN NEW;
        END $$`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "CreditApprovalReview_require_initial_signature_completion"
        BEFORE INSERT OR UPDATE ON "CreditApprovalReview"
        FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initial_signature_settlement_guard()`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_initial_signature_completion"
        BEFORE INSERT ON "LiquidacionAliadoCredito"
        FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initial_signature_settlement_guard()`);
    })().catch((error) => { setup = null; throw error; });
  }
  return setup;
}
