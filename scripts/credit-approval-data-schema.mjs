function ensureCheck(name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='${name}' AND conrelid='public."CreditApprovalDataCorrection"'::regclass) THEN
    ALTER TABLE public."CreditApprovalDataCorrection" ADD CONSTRAINT "${name}" CHECK (${expression});
    END IF; END $$`;
}

function ensureForeignKey(name, columns, target, targetColumns) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='${name}' AND conrelid='public."CreditApprovalDataCorrection"'::regclass) THEN
    ALTER TABLE public."CreditApprovalDataCorrection" ADD CONSTRAINT "${name}"
      FOREIGN KEY (${columns}) REFERENCES public."${target}"(${targetColumns}) ON DELETE RESTRICT;
    END IF; END $$`;
}

const snapshotCheck = (column) => `public.credit_approval_data_snapshot_valid("${column}")`;

export const creditApprovalDataSchemaStatements = [
  `ALTER TABLE public."CreditApprovalReview"
    ADD COLUMN IF NOT EXISTS "reviewHashVersion" SMALLINT,
    ADD COLUMN IF NOT EXISTS "approvedHashVersion" SMALLINT`,
  `UPDATE public."CreditApprovalReview" SET "reviewHashVersion"=1
    WHERE "reviewHashVersion" IS NULL`,
  `UPDATE public."CreditApprovalReview" SET "approvedHashVersion"=1
    WHERE "status"='APPROVED' AND "reviewHashVersion"=1 AND "approvedHashVersion" IS NULL`,
  `ALTER TABLE public."CreditApprovalReview"
    ALTER COLUMN "reviewHashVersion" SET DEFAULT 2,
    ALTER COLUMN "reviewHashVersion" SET NOT NULL`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conname='CreditApprovalReview_hash_version_check'
        AND conrelid='public."CreditApprovalReview"'::regclass) THEN
      ALTER TABLE public."CreditApprovalReview"
        ADD CONSTRAINT "CreditApprovalReview_hash_version_check"
        CHECK ("reviewHashVersion" IN (1,2));
    END IF; END $$`,
  `ALTER TABLE public."CreditApprovalReview"
    DROP CONSTRAINT IF EXISTS "CreditApprovalReview_hash_alignment_check"`,
  `ALTER TABLE public."CreditApprovalReview"
    ADD CONSTRAINT "CreditApprovalReview_hash_alignment_check" CHECK (
      ("status"='PENDING' AND "approvedHashVersion" IS NULL)
      OR ("status"='APPROVED' AND "approvedHashVersion" IS NOT NULL
        AND "approvedHashVersion"="reviewHashVersion"))`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_guard_hash_version()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."status"='PENDING' THEN
        NEW."approvedHashVersion":=NULL;
      ELSIF NEW."status"='APPROVED' AND NEW."approvedHashVersion" IS NULL
        AND NEW."reviewHashVersion"=1 THEN
        NEW."approvedHashVersion":=1;
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_hash_version_guard"
    BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_guard_hash_version()`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_data_snapshot_valid(value JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT jsonb_typeof(value)='object'
        AND (SELECT COUNT(*)=6 FROM jsonb_object_keys(value))
        AND value ?& ARRAY['clienteCorreo','clienteTelefono','clienteDepartamento','clienteCiudad','clienteDireccion','referenciaEquipo']
        AND jsonb_typeof(value->'clienteCorreo') IN ('string','null')
        AND jsonb_typeof(value->'clienteTelefono') IN ('string','null')
        AND jsonb_typeof(value->'clienteDepartamento') IN ('string','null')
        AND jsonb_typeof(value->'clienteCiudad') IN ('string','null')
        AND jsonb_typeof(value->'clienteDireccion') IN ('string','null')
        AND jsonb_typeof(value->'referenciaEquipo') IN ('string','null')
    $$`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalDataCorrection" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "idempotencyKey" UUID NOT NULL UNIQUE,
    "requestHash" CHAR(64) NOT NULL,
    "requestedRevision" INTEGER NOT NULL,
    "requestedReviewHash" VARCHAR(64) NOT NULL,
    "requestedHashVersion" SMALLINT NOT NULL DEFAULT 1,
    "resultingRevision" INTEGER NOT NULL,
    "resultingReviewHash" VARCHAR(64) NOT NULL,
    "resultingHashVersion" SMALLINT NOT NULL DEFAULT 2,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actorKind" VARCHAR(16) NOT NULL,
    "actorUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" VARCHAR(160) NOT NULL,
    "actorGrantId" UUID,
    "actorSessionId" UUID,
    "catalogSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditApprovalDataCorrection_shared_actor_fkey"
      FOREIGN KEY ("actorSessionId","actorGrantId")
      REFERENCES public."CreditApprovalSharedSession"("id","grantId") ON DELETE RESTRICT
  )`,
  `ALTER TABLE public."CreditApprovalDataCorrection"
    ADD COLUMN IF NOT EXISTS "requestedHashVersion" SMALLINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS "resultingHashVersion" SMALLINT NOT NULL DEFAULT 2`,
  `ALTER TABLE public."CreditApprovalDataCorrection"
    ALTER COLUMN "id" SET DEFAULT gen_random_uuid(),
    ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  ensureForeignKey("CreditApprovalDataCorrection_creditoId_fkey", '"creditoId"', "Credito", '"id"'),
  ensureForeignKey("CreditApprovalDataCorrection_actorUserId_fkey", '"actorUserId"', "Usuario", '"id"'),
  ensureForeignKey("CreditApprovalDataCorrection_shared_actor_fkey", '"actorSessionId","actorGrantId"', "CreditApprovalSharedSession", '"id","grantId"'),
  ensureCheck("CreditApprovalDataCorrection_request_hash_check", `"requestHash" ~ '^[a-f0-9]{64}$'`),
  ensureCheck("CreditApprovalDataCorrection_review_hash_check", `"requestedReviewHash" ~ '^[a-f0-9]{64}$'
    AND "resultingReviewHash" ~ '^[a-f0-9]{64}$'`),
  ensureCheck("CreditApprovalDataCorrection_hash_version_check", `"requestedHashVersion" IN (1,2)
    AND "resultingHashVersion"=2`),
  ensureCheck("CreditApprovalDataCorrection_revision_check", `"requestedRevision">0
    AND "resultingRevision"="requestedRevision"+1`),
  ensureCheck("CreditApprovalDataCorrection_reason_check", `LENGTH(BTRIM("reason")) BETWEEN 5 AND 500`),
  ensureCheck("CreditApprovalDataCorrection_actor_check", `LENGTH(BTRIM("actorName"))>0 AND (
    ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorUserId">0
      AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL
      AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))`),
  ensureCheck("CreditApprovalDataCorrection_before_check", snapshotCheck("before")),
  ensureCheck("CreditApprovalDataCorrection_after_check", snapshotCheck("after")),
  ensureCheck("CreditApprovalDataCorrection_changed_check", `"before" IS DISTINCT FROM "after"`),
  ensureCheck("CreditApprovalDataCorrection_catalog_check", `(
    (("before"->>'referenciaEquipo') IS DISTINCT FROM ("after"->>'referenciaEquipo'))
      AND "catalogSnapshot" IS NOT NULL AND jsonb_typeof("catalogSnapshot")='object'
      AND "catalogSnapshot" ?& ARRAY['id','marca','modelo','precioBaseVenta','activo','plataforma','referenciaEquipo']
      AND jsonb_typeof("catalogSnapshot"->'id')='number'
      AND jsonb_typeof("catalogSnapshot"->'marca')='string'
      AND jsonb_typeof("catalogSnapshot"->'modelo')='string'
      AND jsonb_typeof("catalogSnapshot"->'precioBaseVenta')='number'
      AND "catalogSnapshot"->'activo'='true'::jsonb
      AND "catalogSnapshot"->>'plataforma' IN ('ANDROID','IPHONE')
      AND LENGTH(BTRIM("catalogSnapshot"->>'marca'))>0
      AND LENGTH(BTRIM("catalogSnapshot"->>'modelo'))>0
      AND "catalogSnapshot"->>'referenciaEquipo'="after"->>'referenciaEquipo'
    ) OR (
      ("before"->>'referenciaEquipo') IS NOT DISTINCT FROM ("after"->>'referenciaEquipo')
      AND "catalogSnapshot" IS NULL
    )`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalDataCorrection_idempotencyKey_key"
    ON public."CreditApprovalDataCorrection"("idempotencyKey")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalDataCorrection_credit_revision_key"
    ON public."CreditApprovalDataCorrection"("creditoId","resultingRevision")`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalDataCorrection_credit_created_idx"
    ON public."CreditApprovalDataCorrection"("creditoId","createdAt" DESC,"id" DESC)`,
  `CREATE OR REPLACE FUNCTION public.protect_credit_approval_data_correction()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'CREDIT_APPROVAL_DATA_HISTORY_IMMUTABLE' USING ERRCODE='23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalDataCorrection_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalDataCorrection"
    FOR EACH ROW EXECUTE FUNCTION public.protect_credit_approval_data_correction()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalDataCorrection_no_truncate"
    BEFORE TRUNCATE ON public."CreditApprovalDataCorrection"
    FOR EACH STATEMENT EXECUTE FUNCTION public.protect_credit_approval_data_correction()`,
];

export async function installCreditApprovalDataSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-data-schema'))");
    for (const statement of creditApprovalDataSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
