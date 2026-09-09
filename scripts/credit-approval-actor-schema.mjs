// Add actor metadata while preserving every recorded approval, event and credit.
export const creditApprovalActorSchemaStatements = [
  `ALTER TABLE public."CreditApprovalReview"
    ADD COLUMN IF NOT EXISTS "approvedByKind" VARCHAR(16) DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS "approvedByGrantId" UUID,
    ADD COLUMN IF NOT EXISTS "approvedBySessionId" UUID`,
  `ALTER TABLE public."CreditApprovalEvent"
    ADD COLUMN IF NOT EXISTS "actorKind" VARCHAR(16) NOT NULL DEFAULT 'USER',
    ADD COLUMN IF NOT EXISTS "actorGrantId" UUID,
    ADD COLUMN IF NOT EXISTS "actorSessionId" UUID`,
  // These new classification fields contain no prior decision data. Prisma may
  // have added a nullable column first; classify personal approvals by their
  // already recorded user, never by the administrator issuing a shared link.
  `UPDATE public."CreditApprovalReview" SET "approvedByKind"='USER'
    WHERE "status"='APPROVED' AND "approvedByKind" IS NULL AND "approvedByUserId" IS NOT NULL
      AND "approvedByGrantId" IS NULL AND "approvedBySessionId" IS NULL`,
  `UPDATE public."CreditApprovalReview" SET "approvedByKind"=NULL
    WHERE "status"='PENDING' AND "approvedByKind"='USER' AND "approvedByGrantId" IS NULL AND "approvedBySessionId" IS NULL`,
  `ALTER TABLE public."CreditApprovalReview" ALTER COLUMN "approvedByKind" DROP DEFAULT`,
  `CREATE OR REPLACE FUNCTION public.credit_approval_review_actor()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."status"='PENDING' THEN
        NEW."approvedByKind":=NULL; NEW."approvedByGrantId":=NULL; NEW."approvedBySessionId":=NULL;
      ELSIF NEW."status"='APPROVED' AND NEW."approvedByKind" IS NULL AND NEW."approvedByUserId" IS NOT NULL
        AND NEW."approvedByGrantId" IS NULL AND NEW."approvedBySessionId" IS NULL THEN
        NEW."approvedByKind":='USER';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditApprovalReview_actor_metadata" BEFORE INSERT OR UPDATE ON public."CreditApprovalReview"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_review_actor()`,
  `ALTER TABLE public."CreditApprovalReview" DROP CONSTRAINT IF EXISTS "CreditApprovalReview_approval_check"`,
  `ALTER TABLE public."CreditApprovalReview" ADD CONSTRAINT "CreditApprovalReview_approval_check" CHECK (
    ("status"='PENDING' AND "approvedRevision" IS NULL AND "approvedByUserId" IS NULL AND "approvedByName" IS NULL
      AND "approvedAt" IS NULL AND "reviewHash" IS NULL AND "approvedByKind" IS NULL AND "approvedByGrantId" IS NULL AND "approvedBySessionId" IS NULL)
    OR ("status"='APPROVED' AND "approvedRevision" IS NOT NULL AND "approvedRevision"="revision"
      AND "approvedByName" IS NOT NULL AND LENGTH(BTRIM("approvedByName"))>0 AND "approvedAt" IS NOT NULL
      AND "reviewHash" IS NOT NULL AND "reviewHash" ~ '^[a-f0-9]{64}$' AND "approvedByKind" IS NOT NULL AND (
        ("approvedByKind"='USER' AND "approvedByUserId" IS NOT NULL AND "approvedByGrantId" IS NULL AND "approvedBySessionId" IS NULL)
        OR ("approvedByKind"='SHARED_LINK' AND "approvedByUserId" IS NULL AND "approvedByGrantId" IS NOT NULL AND "approvedBySessionId" IS NOT NULL))))`,
  `ALTER TABLE public."CreditApprovalEvent" DROP CONSTRAINT IF EXISTS "CreditApprovalEvent_actor_check"`,
  `ALTER TABLE public."CreditApprovalEvent" ADD CONSTRAINT "CreditApprovalEvent_actor_check" CHECK (
    ("eventType"='INVALIDATED' AND "actorKind"='USER' AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
    OR ("eventType"='APPROVED' AND "actorName" IS NOT NULL AND LENGTH(BTRIM("actorName"))>0 AND (
      ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
      OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))))`,
];

export async function installCreditApprovalActorSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-approval-actor-schema'))");
    for (const statement of creditApprovalActorSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}
