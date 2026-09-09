function ensureCheck(table, name, expression) {
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}'
      AND conrelid='public."${table}"'::regclass) THEN
      ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" CHECK (${expression});
    END IF;
  END $$`;
}

const reviewApprovalCheck = `("status" = 'PENDING' AND "approvedRevision" IS NULL AND "approvedByUserId" IS NULL
      AND "approvedByName" IS NULL AND "approvedAt" IS NULL AND "reviewHash" IS NULL)
    OR ("status" = 'APPROVED' AND "approvedRevision" IS NOT NULL AND "approvedRevision" = "revision"
      AND "approvedByUserId" IS NOT NULL AND "approvedByName" IS NOT NULL
      AND LENGTH(BTRIM("approvedByName")) > 0 AND "approvedAt" IS NOT NULL
      AND "reviewHash" IS NOT NULL AND "reviewHash" ~ '^[a-f0-9]{64}$')`;

// Additive schema only: no credit, signed document or paid snapshot is rewritten.
export const creditApprovalSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalPolicy" (
    "id" INTEGER PRIMARY KEY CHECK ("id" = 1),
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  )`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalReview" (
    "creditoId" INTEGER PRIMARY KEY REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" > 0),
    "approvedRevision" INTEGER,
    "approvedByUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "approvedByName" VARCHAR(160), "approvedAt" TIMESTAMP(3), "reviewHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditApprovalReview_approval_check" CHECK (
      ("status" = 'PENDING' AND "approvedRevision" IS NULL AND "approvedByUserId" IS NULL
        AND "approvedByName" IS NULL AND "approvedAt" IS NULL AND "reviewHash" IS NULL)
      OR ("status" = 'APPROVED' AND "approvedRevision" IS NOT NULL AND "approvedRevision" = "revision"
        AND "approvedByUserId" IS NOT NULL AND "approvedByName" IS NOT NULL
        AND LENGTH(BTRIM("approvedByName")) > 0 AND "approvedAt" IS NOT NULL
        AND "reviewHash" IS NOT NULL AND "reviewHash" ~ '^[a-f0-9]{64}$')
    )
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalReview_status_updatedAt_idx"
    ON public."CreditApprovalReview" ("status", "updatedAt")`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalEvent" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "creditoId" INTEGER NOT NULL REFERENCES public."CreditApprovalReview"("creditoId") ON DELETE RESTRICT,
    "eventType" VARCHAR(16) NOT NULL CHECK ("eventType" IN ('APPROVED', 'INVALIDATED')),
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "actorUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" VARCHAR(160), "reason" TEXT, "reviewHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditApprovalEvent_actor_check" CHECK (
      "eventType" <> 'APPROVED' OR
      ("actorUserId" IS NOT NULL AND "actorName" IS NOT NULL AND LENGTH(BTRIM("actorName")) > 0)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalEvent_creditoId_createdAt_idx"
    ON public."CreditApprovalEvent" ("creditoId", "createdAt")`,
  // Prisma can create these tables before the predeploy script; install the SQL
  // invariants in that case too. An incompatible existing row aborts deployment.
  ensureCheck("CreditApprovalPolicy", "CreditApprovalPolicy_id_check", '"id" = 1'),
  ensureCheck("CreditApprovalReview", "CreditApprovalReview_revision_check", '"revision" > 0'),
  ensureCheck("CreditApprovalReview", "CreditApprovalReview_approval_check", reviewApprovalCheck),
  ensureCheck("CreditApprovalEvent", "CreditApprovalEvent_revision_check", '"revision" > 0'),
  ensureCheck("CreditApprovalEvent", "CreditApprovalEvent_eventType_check", `"eventType" IN ('APPROVED', 'INVALIDATED')`),
  ensureCheck("CreditApprovalEvent", "CreditApprovalEvent_actor_check", `"eventType" <> 'APPROVED' OR
    ("actorUserId" IS NOT NULL AND "actorName" IS NOT NULL AND LENGTH(BTRIM("actorName")) > 0)`),
  `CREATE OR REPLACE FUNCTION public.credit_approval_reject_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'CREDIT_APPROVAL_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalPolicy_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalPolicy"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalEvent_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalEvent"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_is_required(target_id INTEGER)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT NOT EXISTS (SELECT 1 FROM public."CreditApprovalPolicy" WHERE "id" = 1)
        OR EXISTS (SELECT 1 FROM public."CreditApprovalReview" WHERE "creditoId" = target_id)
        OR EXISTS (
          SELECT 1 FROM public."Credito" credit CROSS JOIN public."CreditApprovalPolicy" policy
          WHERE credit."id" = target_id AND policy."id" = 1
            AND credit."createdAt" >= policy."activatedAt"
            AND NOT (COALESCE(credit."equalityService", '') = 'IMPORTACION_MASIVA'
              AND COALESCE(credit."contratoSnapshot" #>> '{origen,tipo}', '') = 'IMPORTACION_MASIVA')
        )
    $$`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_initialize()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public."CreditApprovalPolicy" WHERE "id" = 1)
        OR EXISTS (SELECT 1 FROM public."CreditApprovalPolicy" WHERE "id" = 1 AND NEW."createdAt" >= "activatedAt"
          AND NOT (COALESCE(NEW."equalityService", '') = 'IMPORTACION_MASIVA'
            AND COALESCE(NEW."contratoSnapshot" #>> '{origen,tipo}', '') = 'IMPORTACION_MASIVA')) THEN
        INSERT INTO public."CreditApprovalReview" ("creditoId", "createdAt", "updatedAt")
        VALUES (NEW."id", CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
          ON CONFLICT ("creditoId") DO NOTHING;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "Credito_initialize_approval"
    AFTER INSERT ON public."Credito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_initialize()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_invalidate(target_id INTEGER, invalidation_reason TEXT)
    RETURNS void LANGUAGE plpgsql AS $$
    DECLARE next_revision INTEGER; previous_hash TEXT;
    BEGIN
      IF target_id IS NULL THEN RETURN; END IF;
      -- Lock order matches approval and settlement: Credit, then Review.
      PERFORM 1 FROM public."Credito" WHERE "id" = target_id FOR UPDATE;
      IF EXISTS (SELECT 1 FROM public."LiquidacionAliadoCredito" WHERE "creditoId" = target_id) THEN RETURN; END IF;
      SELECT "reviewHash" INTO previous_hash FROM public."CreditApprovalReview" WHERE "creditoId" = target_id FOR UPDATE;
      UPDATE public."CreditApprovalReview"
      SET "status" = 'PENDING', "revision" = "revision" + 1,
        "approvedRevision" = NULL, "approvedByUserId" = NULL, "approvedByName" = NULL,
        "approvedAt" = NULL, "reviewHash" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
      WHERE "creditoId" = target_id RETURNING "revision" INTO next_revision;
      IF next_revision IS NOT NULL THEN
        INSERT INTO public."CreditApprovalEvent" ("id", "creditoId", "eventType", "revision", "reason", "reviewHash", "createdAt")
        VALUES (gen_random_uuid(), target_id, 'INVALIDATED', next_revision, invalidation_reason, previous_hash,
          CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
      END IF;
    END $$`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_credit_changed()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF ROW(OLD."clienteNombre", OLD."clienteDocumento", OLD."valorEquipoTotal", OLD."cuotaInicial",
        OLD."saldoBaseFinanciado", OLD."montoCredito", OLD."imei", OLD."sedeId", OLD."equipoMarca", OLD."equipoModelo",
        OLD."contratoCedulaFrenteDataUrl", OLD."contratoCedulaRespaldoDataUrl",
        OLD."iphoneSelfieCedulaDataUrl", OLD."fotoEntregaDataUrl", OLD."fotoRemisionDataUrl",
        OLD."contratoSnapshot" -> 'financiero', OLD."contratoSnapshot" -> 'firma')
        IS DISTINCT FROM
        ROW(NEW."clienteNombre", NEW."clienteDocumento", NEW."valorEquipoTotal", NEW."cuotaInicial",
        NEW."saldoBaseFinanciado", NEW."montoCredito", NEW."imei", NEW."sedeId", NEW."equipoMarca", NEW."equipoModelo",
        NEW."contratoCedulaFrenteDataUrl", NEW."contratoCedulaRespaldoDataUrl",
        NEW."iphoneSelfieCedulaDataUrl", NEW."fotoEntregaDataUrl", NEW."fotoRemisionDataUrl",
        NEW."contratoSnapshot" -> 'financiero', NEW."contratoSnapshot" -> 'firma') THEN
        PERFORM public.credit_approval_invalidate(NEW."id", 'CREDIT_DOCUMENTATION_CHANGED');
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "Credito_invalidate_approval"
    AFTER UPDATE OF "clienteNombre", "clienteDocumento", "valorEquipoTotal", "cuotaInicial",
      "saldoBaseFinanciado", "montoCredito", "imei", "sedeId", "equipoMarca", "equipoModelo", "contratoCedulaFrenteDataUrl",
      "contratoCedulaRespaldoDataUrl", "iphoneSelfieCedulaDataUrl", "fotoEntregaDataUrl",
      "fotoRemisionDataUrl", "contratoSnapshot" ON public."Credito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_credit_changed()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_site_changed()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target_id INTEGER;
    BEGIN
      IF OLD."aliadoId" IS DISTINCT FROM NEW."aliadoId" THEN
        FOR target_id IN SELECT credit."id" FROM public."Credito" credit
          JOIN public."CreditApprovalReview" review ON review."creditoId" = credit."id"
          WHERE credit."sedeId" = NEW."id" ORDER BY credit."id" LOOP
          PERFORM public.credit_approval_invalidate(target_id, 'CREDIT_ALLY_CHANGED');
        END LOOP;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "Sede_invalidate_credit_approval"
    AFTER UPDATE OF "aliadoId" ON public."Sede"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_site_changed()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_signature_changed()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE old_credit INTEGER; new_credit INTEGER; target_id INTEGER;
    BEGIN
      IF TG_OP <> 'INSERT' THEN old_credit := OLD."creditoId"; END IF;
      IF TG_OP <> 'DELETE' THEN new_credit := NEW."creditoId"; END IF;
      IF TG_OP = 'UPDATE' AND
        ROW(OLD."creditoId", OLD."processUuid", OLD."status", OLD."signedDocumentBase64",
          OLD."signedDocumentFileName", OLD."supersededAt", OLD."completedAt")
        IS NOT DISTINCT FROM
        ROW(NEW."creditoId", NEW."processUuid", NEW."status", NEW."signedDocumentBase64",
          NEW."signedDocumentFileName", NEW."supersededAt", NEW."completedAt") THEN
        RETURN NEW;
      END IF;
      FOR target_id IN SELECT DISTINCT id FROM unnest(ARRAY[old_credit, new_credit]) AS ids(id)
        WHERE id IS NOT NULL ORDER BY id LOOP
        PERFORM public.credit_approval_invalidate(target_id, 'SIGNED_DOCUMENT_CHANGED');
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE FUNCTION public.install_credit_approval_firmaseguro_trigger()
    RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      IF to_regclass('public."FirmaSeguroProcess"') IS NOT NULL THEN
        EXECUTE 'CREATE OR REPLACE TRIGGER "FirmaSeguroProcess_invalidate_approval"
          AFTER INSERT OR UPDATE OR DELETE ON public."FirmaSeguroProcess"
          FOR EACH ROW EXECUTE FUNCTION public.credit_approval_signature_changed()';
      END IF;
    END $$`,
  `SELECT public.install_credit_approval_firmaseguro_trigger()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_guard_settlement()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM 1 FROM public."Credito" WHERE "id" = NEW."creditoId" FOR UPDATE;
      IF NOT EXISTS (SELECT 1 FROM public."CreditApprovalPolicy" WHERE "id" = 1) THEN
        RAISE EXCEPTION 'CREDIT_APPROVAL_POLICY_MISSING' USING ERRCODE = '23514';
      END IF;
      -- Lock the review too: Serializable callers must reject a concurrent invalidation.
      PERFORM 1 FROM public."CreditApprovalReview" WHERE "creditoId" = NEW."creditoId" FOR UPDATE;
      IF public.credit_approval_is_required(NEW."creditoId") AND NOT EXISTS (
        SELECT 1 FROM public."CreditApprovalReview"
        WHERE "creditoId" = NEW."creditoId" AND "status" = 'APPROVED' AND "approvedRevision" = "revision"
      ) THEN
        RAISE EXCEPTION 'CREDIT_APPROVAL_REQUIRED' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "LiquidacionAliadoCredito_require_approval"
    BEFORE INSERT ON public."LiquidacionAliadoCredito"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_guard_settlement()`,
  // First installation freezes the cutover; reruns never change it or backfill.
  `INSERT INTO public."CreditApprovalPolicy" ("id", "activatedAt")
    VALUES (1, CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ON CONFLICT ("id") DO NOTHING`,
];

export async function installCreditApprovalSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-schema'))");
    for (const statement of creditApprovalSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
