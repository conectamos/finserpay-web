function ensureCheck(table, name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" CHECK (${expression}); END IF; END $$`;
}
export const creditApprovalNoveltiesSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalNovelty" (
    "id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'WAITING_ALLY',"version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"resolvedAt" TIMESTAMP(3))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalNovelty_one_active" ON public."CreditApprovalNovelty"("creditoId") WHERE "status"<>'RESOLVED'`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalNovelty_credit_created" ON public."CreditApprovalNovelty"("creditoId","createdAt" DESC)`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalNoveltyItem" (
    "id" UUID PRIMARY KEY,"noveltyId" UUID NOT NULL REFERENCES public."CreditApprovalNovelty"("id") ON DELETE RESTRICT,
    "key" VARCHAR(32) NOT NULL,"status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',"version" INTEGER NOT NULL DEFAULT 1,
    "reason" VARCHAR(1000) NOT NULL,"openedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "respondedAt" TIMESTAMP(3),"responseText" VARCHAR(2000),"responsePhotoHash" VARCHAR(64))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalNoveltyItem_case_key" ON public."CreditApprovalNoveltyItem"("noveltyId","key")`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalNoveltyEvent" (
    "id" UUID PRIMARY KEY,"noveltyId" UUID NOT NULL REFERENCES public."CreditApprovalNovelty"("id") ON DELETE RESTRICT,
    "itemId" UUID REFERENCES public."CreditApprovalNoveltyItem"("id") ON DELETE RESTRICT,
    "type" VARCHAR(32) NOT NULL,"actorKind" VARCHAR(16) NOT NULL DEFAULT 'USER',
    "actorUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT,"actorName" VARCHAR(160) NOT NULL,
    "actorGrantId" UUID,"actorSessionId" UUID,"payload" JSONB NOT NULL,
    "requestKey" UUID,"requestHash" VARCHAR(64),"createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalNoveltyEvent_request_key" ON public."CreditApprovalNoveltyEvent"("requestKey") WHERE "requestKey" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalNoveltyEvent_case_created" ON public."CreditApprovalNoveltyEvent"("noveltyId","createdAt","id")`,
  ensureCheck("CreditApprovalNovelty", "CreditApprovalNovelty_status_check", `"status" IN ('WAITING_ALLY','RESPONDED','RESOLVED') AND "version">0 AND (("status"='RESOLVED')=("resolvedAt" IS NOT NULL))`),
  ensureCheck("CreditApprovalNoveltyItem", "CreditApprovalNoveltyItem_key_check", `"key" IN ('GENERAL','cedula-frente','cedula-posterior','selfie-cedula','foto-entrega','foto-remision')`),
  ensureCheck("CreditApprovalNoveltyItem", "CreditApprovalNoveltyItem_state_check", `"status" IN ('OPEN','RESPONDED') AND "version">0 AND LENGTH(BTRIM("reason")) BETWEEN 5 AND 1000`),
  ensureCheck("CreditApprovalNoveltyItem", "CreditApprovalNoveltyItem_response_check", `("status"='OPEN' AND "respondedAt" IS NULL AND "responseText" IS NULL AND "responsePhotoHash" IS NULL)
    OR ("status"='RESPONDED' AND "respondedAt" IS NOT NULL AND (("key"='GENERAL' AND "responseText" IS NOT NULL AND LENGTH(BTRIM("responseText")) BETWEEN 5 AND 2000 AND "responsePhotoHash" IS NULL)
      OR ("key"<>'GENERAL' AND "responsePhotoHash" IS NOT NULL AND "responsePhotoHash" ~ '^[a-f0-9]{64}$')))`),
  ensureCheck("CreditApprovalNoveltyEvent", "CreditApprovalNoveltyEvent_actor_check", `LENGTH(BTRIM("actorName"))>0 AND (("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))`),
  ensureCheck("CreditApprovalNoveltyEvent", "CreditApprovalNoveltyEvent_request_check", `("requestKey" IS NULL AND "requestHash" IS NULL) OR ("requestKey" IS NOT NULL AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[a-f0-9]{64}$')`),
  ensureCheck("CreditApprovalNoveltyEvent", "CreditApprovalNoveltyEvent_type_check", `"type" IN ('REPORTED','PHOTO_RESPONDED','GENERAL_RESPONDED','APPROVED_RESOLVED')`),
  ...[["CreditApprovalNovelty", "createdAt"], ["CreditApprovalNovelty", "updatedAt"], ["CreditApprovalNoveltyItem", "openedAt"], ["CreditApprovalNoveltyEvent", "createdAt"]]
    .map(([table, column]) => `ALTER TABLE public."${table}" ALTER COLUMN "${column}" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`),
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_editable(target_id INTEGER)
    RETURNS void LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id"=target_id FOR UPDATE;
      PERFORM 1 FROM public."CreditApprovalReview" WHERE "creditoId"=target_id FOR UPDATE;
      IF NOT EXISTS (SELECT 1 FROM public."Credito" c JOIN public."Sede" s ON s."id"=c."sedeId"
        JOIN public."Aliado" a ON a."id"=s."aliadoId" CROSS JOIN public."CreditApprovalPolicy" p
        WHERE c."id"=target_id AND p."id"=1 AND c."createdAt">=p."activatedAt"
          AND NOT (COALESCE(c."equalityService",'')='IMPORTACION_MASIVA' AND COALESCE(c."contratoSnapshot" #>> '{origen,tipo}','')='IMPORTACION_MASIVA')
          AND EXISTS (SELECT 1 FROM public."CreditApprovalReview" r WHERE r."creditoId"=target_id)
          AND UPPER(BTRIM(COALESCE(a."codigo",'')))<>'FINSERPAY'
          AND UPPER(BTRIM(COALESCE(c."estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA'))
        OR EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" WHERE "creditoId"=target_id) THEN
        RAISE EXCEPTION 'NOVELTY_CREDIT_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
    END $$`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_protect()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOVELTY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
      PERFORM public.credit_approval_novelty_editable(NEW."creditoId");
      IF TG_OP='INSERT' THEN
        IF NEW."status"<>'WAITING_ALLY' THEN RAISE EXCEPTION 'NOVELTY_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
      ELSE
        IF OLD."status"='RESOLVED' OR ROW(OLD."id",OLD."creditoId",OLD."createdAt") IS DISTINCT FROM ROW(NEW."id",NEW."creditoId",NEW."createdAt")
          THEN RAISE EXCEPTION 'NOVELTY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF NEW."version"<>OLD."version"+1 THEN RAISE EXCEPTION 'NOVELTY_INVALID_VERSION' USING ERRCODE='23514'; END IF;
        IF NEW."status" IN ('RESPONDED','RESOLVED') AND (NOT EXISTS (SELECT 1 FROM public."CreditApprovalNoveltyItem" WHERE "noveltyId"=NEW."id")
          OR EXISTS (SELECT 1 FROM public."CreditApprovalNoveltyItem" WHERE "noveltyId"=NEW."id" AND "status"='OPEN')) THEN
          RAISE EXCEPTION 'NOVELTY_PENDING' USING ERRCODE='23514'; END IF;
        IF NEW."status"='RESOLVED' AND OLD."status"<>'RESPONDED' THEN RAISE EXCEPTION 'NOVELTY_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalNovelty_protect" BEFORE INSERT OR UPDATE OR DELETE ON public."CreditApprovalNovelty"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_protect()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_created()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM public.credit_approval_invalidate(NEW."creditoId",'NOVELTY_CHANGED'); RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalNovelty_created" AFTER INSERT ON public."CreditApprovalNovelty"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_created()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_item_protect()
    RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target_id INTEGER; case_status TEXT; BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'NOVELTY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
      SELECT "creditoId" INTO target_id FROM public."CreditApprovalNovelty" WHERE "id"=NEW."noveltyId";
      PERFORM public.credit_approval_novelty_editable(target_id);
      SELECT "status" INTO case_status FROM public."CreditApprovalNovelty" WHERE "id"=NEW."noveltyId" FOR UPDATE;
      IF case_status IS NULL OR case_status='RESOLVED' THEN RAISE EXCEPTION 'NOVELTY_ALREADY_RESOLVED' USING ERRCODE='23514'; END IF;
      IF TG_OP='INSERT' THEN
        IF NEW."status"<>'OPEN' THEN RAISE EXCEPTION 'NOVELTY_INVALID_TRANSITION' USING ERRCODE='23514'; END IF;
      ELSE
        IF ROW(OLD."id",OLD."noveltyId",OLD."key") IS DISTINCT FROM ROW(NEW."id",NEW."noveltyId",NEW."key") THEN
          RAISE EXCEPTION 'NOVELTY_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF NEW."status"='RESPONDED' AND OLD."status"<>'OPEN' THEN RAISE EXCEPTION 'NOVELTY_CHANGED' USING ERRCODE='23514'; END IF;
        NEW."version":=OLD."version"+1;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalNoveltyItem_protect" BEFORE INSERT OR UPDATE OR DELETE ON public."CreditApprovalNoveltyItem"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_item_protect()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_item_changed()
    RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target_id INTEGER; BEGIN
      SELECT "creditoId" INTO target_id FROM public."CreditApprovalNovelty" WHERE "id"=NEW."noveltyId";
      UPDATE public."CreditApprovalNovelty" SET "status"=CASE WHEN EXISTS (
        SELECT 1 FROM public."CreditApprovalNoveltyItem" WHERE "noveltyId"=NEW."noveltyId" AND "status"='OPEN') THEN 'WAITING_ALLY' ELSE 'RESPONDED' END,
        "version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id"=NEW."noveltyId";
      PERFORM public.credit_approval_invalidate(target_id,'NOVELTY_CHANGED');
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalNoveltyItem_changed" AFTER INSERT OR UPDATE ON public."CreditApprovalNoveltyItem"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_item_changed()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_novelty_guard()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id"=NEW."creditoId" FOR UPDATE;
      IF TG_TABLE_NAME='CreditApprovalReview' THEN
        IF NEW."status"<>'APPROVED' THEN RETURN NEW; END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM public."CreditApprovalNovelty" WHERE "creditoId"=NEW."creditoId" AND "status"<>'RESOLVED') THEN
        RAISE EXCEPTION 'NOVELTY_PENDING' USING ERRCODE='23514'; END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_require_novelty_resolution" BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_guard()`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_novelty_resolution" BEFORE INSERT ON public."LiquidacionAliadoCredito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_novelty_guard()`,
  ...["CreditApprovalNovelty", "CreditApprovalNoveltyItem", "CreditApprovalNoveltyEvent"].map(table =>
    `CREATE OR REPLACE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON public."${table}" FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`),
  `CREATE OR REPLACE TRIGGER "CreditApprovalNoveltyEvent_immutable" BEFORE UPDATE OR DELETE ON public."CreditApprovalNoveltyEvent"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
];
export async function installCreditApprovalNoveltiesSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-novelties-schema'))");
    for (const statement of creditApprovalNoveltiesSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
