function check(table, name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" CHECK (${expression}); END IF; END $$`;
}
export const approvalSharedSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalSharedGrant" (
    "id" UUID PRIMARY KEY,"generation" BIGSERIAL UNIQUE,"scope" VARCHAR(32) NOT NULL DEFAULT 'CREDIT_APPROVAL',
    "issuedByUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "revokedAt" TIMESTAMP(3),"revokedByUserId" INTEGER REFERENCES public."Usuario"("id") ON DELETE RESTRICT)`,
  `ALTER TABLE public."CreditApprovalSharedGrant" ADD COLUMN IF NOT EXISTS "generation" BIGSERIAL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalSharedGrant_generation_key" ON public."CreditApprovalSharedGrant"("generation")`,
  `ALTER TABLE public."CreditApprovalSharedGrant" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  check("CreditApprovalSharedGrant","CreditApprovalSharedGrant_scope_check", `"scope"='CREDIT_APPROVAL'`),
  check("CreditApprovalSharedGrant","CreditApprovalSharedGrant_revocation_check", '("revokedAt" IS NULL)=("revokedByUserId" IS NULL)'),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalSharedGrant_one_active" ON public."CreditApprovalSharedGrant"("scope") WHERE "revokedAt" IS NULL`,
  `CREATE TABLE IF NOT EXISTS public."CreditApprovalSharedSession" (
    "id" UUID PRIMARY KEY,"grantId" UUID NOT NULL REFERENCES public."CreditApprovalSharedGrant"("id") ON DELETE RESTRICT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "expiresAt" TIMESTAMP(3) NOT NULL,"revokedAt" TIMESTAMP(3))`,
  `ALTER TABLE public."CreditApprovalSharedSession" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
  check("CreditApprovalSharedSession","CreditApprovalSharedSession_expiry_check", `"expiresAt">"createdAt" AND "expiresAt"<="createdAt"+INTERVAL '8 hours'`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditApprovalSharedSession_id_grant" ON public."CreditApprovalSharedSession"("id","grantId")`,
  `CREATE INDEX IF NOT EXISTS "CreditApprovalSharedSession_grant_idx" ON public."CreditApprovalSharedSession"("grantId","expiresAt")`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_shared_protect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'SHARED_ACCESS_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
    IF TG_TABLE_NAME='CreditApprovalSharedGrant' THEN
      IF ROW(OLD."id",OLD."generation",OLD."scope",OLD."issuedByUserId",OLD."createdAt") IS DISTINCT FROM ROW(NEW."id",NEW."generation",NEW."scope",NEW."issuedByUserId",NEW."createdAt")
        OR (OLD."revokedAt" IS NOT NULL AND ROW(OLD."revokedAt",OLD."revokedByUserId") IS DISTINCT FROM ROW(NEW."revokedAt",NEW."revokedByUserId"))
        THEN RAISE EXCEPTION 'SHARED_ACCESS_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
    ELSE
      IF ROW(OLD."id",OLD."grantId",OLD."createdAt",OLD."expiresAt") IS DISTINCT FROM ROW(NEW."id",NEW."grantId",NEW."createdAt",NEW."expiresAt")
        OR (OLD."revokedAt" IS NOT NULL AND OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt")
        THEN RAISE EXCEPTION 'SHARED_ACCESS_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END $$`,
  ...["CreditApprovalSharedGrant","CreditApprovalSharedSession"].flatMap(table=>[
    `CREATE OR REPLACE TRIGGER "${table}_immutable" BEFORE UPDATE OR DELETE ON public."${table}" FOR EACH ROW EXECUTE FUNCTION public.credit_approval_shared_protect()`,
    `CREATE OR REPLACE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON public."${table}" FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_shared_protect()`,
  ]),
  // Optional audit tables are installed first. Composite FKs prevent mixing a
  // real session with another grant, while preserving all prior personal actors.
  ...[
    ["CreditApprovalReview","approvedBySessionId","approvedByGrantId"],
    ["CreditApprovalEvent","actorSessionId","actorGrantId"],
    ["CreditApprovalEvidenceRevision","actorSessionId","actorGrantId"],
    ["CreditApprovalReissue","requestedBySessionId","requestedByGrantId"],
    ["CreditApprovalNoveltyEvent","actorSessionId","actorGrantId"],
  ].map(([table,session,grant])=>`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${session}')
      AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${table}_shared_actor_fkey') THEN
      ALTER TABLE public."${table}" ADD CONSTRAINT "${table}_shared_actor_fkey" FOREIGN KEY ("${session}","${grant}")
        REFERENCES public."CreditApprovalSharedSession"("id","grantId") ON DELETE RESTRICT;
    END IF; END $$`),
];
export async function installApprovalSharedSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-approval-shared-schema'))");
    for(const statement of approvalSharedSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch(error) { await client.query("ROLLBACK"); throw error; }
}
