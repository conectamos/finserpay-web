export function creditApprovalDocumentRefreshSchemaStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS "CreditApprovalDocumentRefreshEvent" (
      "id" UUID PRIMARY KEY,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL CHECK (LENGTH(BTRIM("processUuid")) BETWEEN 1 AND 128),
      "actorKind" TEXT NOT NULL CHECK ("actorKind" IN ('USER','SHARED_LINK')),
      "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL CHECK (LENGTH(BTRIM("actorName"))>0),
      "actorGrantId" UUID REFERENCES "CreditApprovalSharedGrant"("id") ON DELETE RESTRICT,
      "actorSessionId" UUID REFERENCES "CreditApprovalSharedSession"("id") ON DELETE RESTRICT,
      "status" TEXT NOT NULL CHECK ("status" IN ('REQUESTED','RECOVERED','UNAVAILABLE')),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      CONSTRAINT "CreditApprovalDocumentRefreshEvent_actor_check" CHECK (
        ("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
        OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))
    )`,
    `DO $$ BEGIN
      IF to_regclass('public."FirmaSeguroProcess"') IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='CreditApprovalDocumentRefreshEvent_process_fkey'
          AND conrelid='public."CreditApprovalDocumentRefreshEvent"'::regclass) THEN
        ALTER TABLE "CreditApprovalDocumentRefreshEvent"
          ADD CONSTRAINT "CreditApprovalDocumentRefreshEvent_process_fkey"
          FOREIGN KEY ("processUuid") REFERENCES "FirmaSeguroProcess"("processUuid") ON DELETE RESTRICT;
      END IF;
    END $$`,
    `CREATE INDEX IF NOT EXISTS "CreditApprovalDocumentRefreshEvent_credit_created"
      ON "CreditApprovalDocumentRefreshEvent"("creditoId","createdAt" DESC,"id")`,
    `CREATE OR REPLACE FUNCTION public.credit_approval_document_refresh_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'APPROVAL_DOCUMENT_REFRESH_AUDIT_IMMUTABLE' USING ERRCODE='23514';
      END $$`,
    `CREATE OR REPLACE TRIGGER "CreditApprovalDocumentRefreshEvent_immutable"
      BEFORE UPDATE OR DELETE OR TRUNCATE ON "CreditApprovalDocumentRefreshEvent"
      FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_document_refresh_immutable()`,
  ];
}
