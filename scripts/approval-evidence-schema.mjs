function ensureCheck(name, expression) {
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}'
      AND conrelid='public."CreditApprovalEvidenceRevision"'::regclass) THEN
      ALTER TABLE public."CreditApprovalEvidenceRevision" ADD CONSTRAINT "${name}" CHECK (${expression});
    END IF;
  END $$`;
}

export const approvalEvidenceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalEvidenceRevision" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "evidenceKey" VARCHAR(32) NOT NULL,
    "previousDataUrl" TEXT, "previousSha256" VARCHAR(64), "nextSha256" VARCHAR(64) NOT NULL,
    "actorUserId" INTEGER, "actorName" TEXT NOT NULL,
    "actorKind" VARCHAR(16) NOT NULL DEFAULT 'USER',"actorGrantId" UUID,"actorSessionId" UUID,
    "source" VARCHAR(32) NOT NULL, "reviewRevision" INTEGER, "reviewHash" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  )`,
  `ALTER TABLE public."CreditApprovalEvidenceRevision" ALTER COLUMN "actorUserId" DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS "actorKind" VARCHAR(16) NOT NULL DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS "actorGrantId" UUID,ADD COLUMN IF NOT EXISTS "actorSessionId" UUID`,
  `ALTER TABLE public."CreditApprovalEvidenceRevision" DROP CONSTRAINT IF EXISTS "CreditApprovalEvidenceRevision_actor_check"`,
  // Prisma may create this table first without SQL checks or with a local-time
  // timestamp default. Add the same invariants without rewriting prior rows.
  `ALTER TABLE public."CreditApprovalEvidenceRevision" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
  `ALTER TABLE public."CreditApprovalEvidenceRevision" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  ensureCheck("CreditApprovalEvidenceRevision_key_check", `"evidenceKey" IN ('cedula-frente','cedula-posterior','selfie-cedula','foto-entrega','foto-remision')`),
  ensureCheck("CreditApprovalEvidenceRevision_source_check", `"source" IN ('ANALISTA_APROBACION','ADMIN_CENTRAL')`),
  ensureCheck("CreditApprovalEvidenceRevision_previous_hash_check", `"previousSha256" IS NULL OR "previousSha256" ~ '^[a-f0-9]{64}$'`),
  ensureCheck("CreditApprovalEvidenceRevision_next_hash_check", `"nextSha256" ~ '^[a-f0-9]{64}$'`),
  ensureCheck("CreditApprovalEvidenceRevision_revision_check", '"reviewRevision" > 0'),
  ensureCheck("CreditApprovalEvidenceRevision_review_hash_check", `"reviewHash" IS NULL OR "reviewHash" ~ '^[a-f0-9]{64}$'`),
  ensureCheck("CreditApprovalEvidenceRevision_previous_pair_check", '("previousDataUrl" IS NULL) = ("previousSha256" IS NULL)'),
  ensureCheck("CreditApprovalEvidenceRevision_actor_check", `LENGTH(BTRIM("actorName"))>0 AND (
    ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorUserId">0 AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))`),
  ensureCheck("CreditApprovalEvidenceRevision_review_check", `"source" <> 'ANALISTA_APROBACION' OR ("reviewRevision" IS NOT NULL AND "reviewHash" IS NOT NULL)`),
  `CREATE INDEX IF NOT EXISTS "CreditApprovalEvidenceRevision_credit_created_idx"
    ON public."CreditApprovalEvidenceRevision" ("creditoId", "createdAt")`,
  `CREATE OR REPLACE FUNCTION public.protect_credit_approval_evidence_history()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'CREDIT_APPROVAL_EVIDENCE_HISTORY_IMMUTABLE' USING ERRCODE = '23514';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalEvidenceRevision_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditApprovalEvidenceRevision"
    FOR EACH ROW EXECUTE FUNCTION public.protect_credit_approval_evidence_history()`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalEvidenceRevision_no_truncate"
    BEFORE TRUNCATE ON public."CreditApprovalEvidenceRevision"
    FOR EACH STATEMENT EXECUTE FUNCTION public.protect_credit_approval_evidence_history()`,
];

export async function installApprovalEvidenceSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-approval-evidence-schema'))");
    for (const statement of approvalEvidenceSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
