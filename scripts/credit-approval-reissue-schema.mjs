// Additive reissue versions; neither credits nor activation policy are rewritten.
function ensureCheck(name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='${name}' AND conrelid='public."CreditApprovalReissue"'::regclass) THEN
    ALTER TABLE public."CreditApprovalReissue" ADD CONSTRAINT "${name}" CHECK (${expression});
    END IF; END $$`;
}
export const creditApprovalReissueSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalReissue" (
    "id" UUID PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "previousProcessUuid" TEXT NOT NULL, "sourceRevision" INTEGER NOT NULL CHECK ("sourceRevision" > 0),
    "reason" VARCHAR(500) NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
    "requestedByUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "requestedByName" VARCHAR(160) NOT NULL,
    "requestedByKind" VARCHAR(16) NOT NULL DEFAULT 'USER',"requestedByGrantId" UUID,"requestedBySessionId" UUID,
    "frozenCredit" JSONB NOT NULL, "originalContractSnapshot" JSONB NOT NULL,
    "originalSignedDocumentBase64" TEXT NOT NULL, "originalDocumentHash" VARCHAR(64) NOT NULL,
    "sourceTermsHash" VARCHAR(64) NOT NULL,
    "documentBase64" TEXT, "documentHash" VARCHAR(64), "requestPayload" JSONB,
    "newProcessUuid" TEXT UNIQUE, "status" VARCHAR(32) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "lastCheckedAt" TIMESTAMP(3), "dispatchedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
    CHECK ("status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','COMPLETED','FAILED_SAFE','UNCERTAIN')),
    CHECK ("originalDocumentHash" ~ '^[a-f0-9]{64}$' AND "sourceTermsHash" ~ '^[a-f0-9]{64}$'),
    CHECK (("documentBase64" IS NULL AND "documentHash" IS NULL) OR ("documentBase64" IS NOT NULL AND "documentHash" IS NOT NULL AND "documentHash" ~ '^[a-f0-9]{64}$')),
    CHECK ("status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','COMPLETED') OR "documentBase64" IS NOT NULL),
    CHECK ("status" NOT IN ('AWAITING_SIGNATURE','COMPLETED') OR "newProcessUuid" IS NOT NULL),
    CHECK ("status" <> 'COMPLETED' OR "completedAt" IS NOT NULL)
  )`,
  `ALTER TABLE public."CreditApprovalReissue" ALTER COLUMN "requestedByUserId" DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS "requestedByKind" VARCHAR(16) NOT NULL DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS "requestedByGrantId" UUID,ADD COLUMN IF NOT EXISTS "requestedBySessionId" UUID`,
  ensureCheck("CreditApprovalReissue_actor_check", `LENGTH(BTRIM("requestedByName"))>0 AND (
    ("requestedByKind"='USER' AND "requestedByUserId" IS NOT NULL AND "requestedByUserId">0 AND "requestedByGrantId" IS NULL AND "requestedBySessionId" IS NULL)
    OR ("requestedByKind"='SHARED_LINK' AND "requestedByUserId" IS NULL AND "requestedByGrantId" IS NOT NULL AND "requestedBySessionId" IS NOT NULL))`),
  ensureCheck("CreditApprovalReissue_revision_check", '"sourceRevision">0'),
  ensureCheck("CreditApprovalReissue_reason_check", 'LENGTH(BTRIM("reason")) BETWEEN 5 AND 500'),
  ensureCheck("CreditApprovalReissue_status_check", `"status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','COMPLETED','FAILED_SAFE','UNCERTAIN')`),
  ensureCheck("CreditApprovalReissue_hash_check", `"originalDocumentHash" ~ '^[a-f0-9]{64}$' AND "sourceTermsHash" ~ '^[a-f0-9]{64}$'`),
  `ALTER TABLE public."CreditApprovalReissue" DROP CONSTRAINT IF EXISTS "CreditApprovalReissue_document_check"`,
  ensureCheck("CreditApprovalReissue_document_check", `("documentBase64" IS NULL AND "documentHash" IS NULL)
    OR ("documentBase64" IS NOT NULL AND "documentHash" IS NOT NULL AND "documentHash" ~ '^[a-f0-9]{64}$')`),
  ensureCheck("CreditApprovalReissue_dispatched_check", `"status" NOT IN ('DISPATCHING','AWAITING_SIGNATURE','COMPLETED') OR "documentBase64" IS NOT NULL`),
  ensureCheck("CreditApprovalReissue_process_check", `"status" NOT IN ('AWAITING_SIGNATURE','COMPLETED') OR "newProcessUuid" IS NOT NULL`),
  ensureCheck("CreditApprovalReissue_completed_check", `"status"<>'COMPLETED' OR "completedAt" IS NOT NULL`),
  `ALTER TABLE public."CreditApprovalReissue"
    ALTER COLUMN "requestedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    ALTER COLUMN "updatedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalReissue_one_pending"
    ON public."CreditApprovalReissue"("creditoId")
    WHERE "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalReissue_credit_created"
    ON public."CreditApprovalReissue"("creditoId","requestedAt" DESC)`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalReissueEvent" (
    "id" BIGSERIAL PRIMARY KEY,
    "operationId" UUID NOT NULL REFERENCES public."CreditApprovalReissue"("id") ON DELETE RESTRICT,
    "previousStatus" VARCHAR(32), "status" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  )`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_reissue_protect()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'REISSUE_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
      IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM public."Credito" WHERE "id"=NEW."creditoId" FOR UPDATE;
        IF NEW."status" <> 'PREPARING' OR NOT EXISTS (
          SELECT 1 FROM public."Credito" credit JOIN public."Sede" site ON site."id"=credit."sedeId"
          JOIN public."Aliado" ally ON ally."id"=site."aliadoId" CROSS JOIN public."CreditApprovalPolicy" policy
          WHERE credit."id"=NEW."creditoId" AND policy."id"=1 AND credit."createdAt">=policy."activatedAt"
          AND UPPER(BTRIM(ally."codigo")) <> 'FINSERPAY'
          AND UPPER(BTRIM(credit."estado")) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')
          AND NOT (COALESCE(credit."equalityService",'')='IMPORTACION_MASIVA'
            AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')
        ) OR EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" WHERE "creditoId"=NEW."creditoId") THEN
          RAISE EXCEPTION 'REISSUE_CREDIT_NOT_ELIGIBLE' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END IF;
      IF ROW(OLD."id",OLD."creditoId",OLD."previousProcessUuid",OLD."sourceRevision",OLD."reason",
        OLD."requestedByUserId",OLD."requestedByName",OLD."requestedByKind",OLD."requestedByGrantId",OLD."requestedBySessionId",OLD."frozenCredit",OLD."originalContractSnapshot",
        OLD."originalSignedDocumentBase64",OLD."originalDocumentHash",OLD."sourceTermsHash",OLD."requestedAt")
        IS DISTINCT FROM ROW(NEW."id",NEW."creditoId",NEW."previousProcessUuid",NEW."sourceRevision",NEW."reason",
        NEW."requestedByUserId",NEW."requestedByName",NEW."requestedByKind",NEW."requestedByGrantId",NEW."requestedBySessionId",NEW."frozenCredit",NEW."originalContractSnapshot",
        NEW."originalSignedDocumentBase64",NEW."originalDocumentHash",NEW."sourceTermsHash",NEW."requestedAt")
        OR (OLD."documentBase64" IS NOT NULL AND ROW(OLD."documentBase64",OLD."documentHash",OLD."requestPayload")
          IS DISTINCT FROM ROW(NEW."documentBase64",NEW."documentHash",NEW."requestPayload"))
        OR (OLD."newProcessUuid" IS NOT NULL AND OLD."newProcessUuid" IS DISTINCT FROM NEW."newProcessUuid") THEN
        RAISE EXCEPTION 'REISSUE_HISTORY_IMMUTABLE' USING ERRCODE='23514';
      END IF;
      IF OLD."status" IS DISTINCT FROM NEW."status" AND NOT (
        (OLD."status"='PREPARING' AND NEW."status" IN ('DISPATCHING','FAILED_SAFE')) OR
        (OLD."status"='DISPATCHING' AND NEW."status" IN ('AWAITING_SIGNATURE','UNCERTAIN')) OR
        (OLD."status"='UNCERTAIN' AND NEW."status"='AWAITING_SIGNATURE' AND OLD."newProcessUuid" IS NULL AND NEW."newProcessUuid" IS NOT NULL) OR
        (OLD."status" IN ('AWAITING_SIGNATURE','UNCERTAIN') AND NEW."status"='COMPLETED')
      ) THEN RAISE EXCEPTION 'REISSUE_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
      IF NEW."status"='COMPLETED' AND NOT EXISTS (
        SELECT 1 FROM public."FirmaSeguroProcess" process
        WHERE process."processUuid"=NEW."newProcessUuid" AND process."creditoId"=NEW."creditoId"
          AND process."supersededAt" IS NULL AND COALESCE(process."signedDocumentBase64",'') <> ''
          AND (process."completedAt" IS NOT NULL OR UPPER(process."status") IN ('COMPLETED','SIGNED','SUCCESS','SUCCESSFUL'))
      ) THEN RAISE EXCEPTION 'REISSUE_DOCUMENT_NOT_READY' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReissue_protect"
    BEFORE INSERT OR UPDATE OR DELETE ON public."CreditApprovalReissue"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reissue_protect()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_reissue_audit()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' THEN
        INSERT INTO public."CreditApprovalReissueEvent"("operationId","status","createdAt") VALUES (NEW."id",NEW."status",CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
        PERFORM public.credit_approval_invalidate(NEW."creditoId",'SIGNATURE_REISSUE_REQUESTED');
      ELSIF OLD."status" IS DISTINCT FROM NEW."status" THEN
        INSERT INTO public."CreditApprovalReissueEvent"("operationId","previousStatus","status","createdAt")
          VALUES (NEW."id",OLD."status",NEW."status",CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReissue_audit"
    AFTER INSERT OR UPDATE ON public."CreditApprovalReissue"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reissue_audit()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReissueEvent_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalReissueEvent"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_reissue_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id"=NEW."creditoId" FOR UPDATE;
      IF TG_TABLE_NAME='CreditApprovalReview' THEN
        IF NEW."status"<>'APPROVED' THEN RETURN NEW; END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM public."CreditApprovalReissue" WHERE "creditoId"=NEW."creditoId"
        AND "status" IN ('PREPARING','DISPATCHING','AWAITING_SIGNATURE','UNCERTAIN')) THEN
        RAISE EXCEPTION 'SIGNATURE_REISSUE_PENDING' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_require_current_signature"
    BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reissue_guard()`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_current_signature"
    BEFORE INSERT ON public."LiquidacionAliadoCredito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reissue_guard()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_reissue_preserve_document()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM public."CreditApprovalReissue" WHERE "previousProcessUuid"=OLD."processUuid") THEN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'REISSUE_ORIGINAL_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF ROW(OLD."processUuid",OLD."creditoId",OLD."signedDocumentBase64",OLD."signedDocumentFileName",OLD."draftPayload",OLD."completedAt")
          IS DISTINCT FROM ROW(NEW."processUuid",NEW."creditoId",NEW."signedDocumentBase64",NEW."signedDocumentFileName",NEW."draftPayload",NEW."completedAt")
          OR (OLD."supersededAt" IS NOT NULL AND OLD."supersededAt" IS DISTINCT FROM NEW."supersededAt") THEN
          RAISE EXCEPTION 'REISSUE_ORIGINAL_IMMUTABLE' USING ERRCODE='23514';
        END IF;
      END IF;
      IF TG_OP='DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`,
  `DO $$ BEGIN IF to_regclass('public."FirmaSeguroProcess"') IS NOT NULL THEN
    EXECUTE 'CREATE OR REPLACE TRIGGER "FirmaSeguroProcess_preserve_reissue_original"
      BEFORE UPDATE OR DELETE ON public."FirmaSeguroProcess"
      FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reissue_preserve_document()';
    END IF; END $$`,
];
export async function installCreditApprovalReissueSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-reissue-schema'))");
    for (const statement of creditApprovalReissueSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
