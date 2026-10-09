export function firmaSeguroRecipientDeliverySchemaStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS "FirmaSeguroRecipientDelivery" (
      "id" UUID PRIMARY KEY,
      "draftId" INTEGER NOT NULL REFERENCES "CreditoBorrador"("id") ON DELETE RESTRICT,
      "processUuid" TEXT NOT NULL REFERENCES "FirmaSeguroProcess"("processUuid") ON DELETE RESTRICT,
      "signatureId" INTEGER NOT NULL CHECK ("signatureId">0),
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" TEXT NOT NULL CHECK (LENGTH(BTRIM("actorName"))>0),
      "reason" TEXT NOT NULL CHECK (LENGTH(BTRIM("reason")) BETWEEN 5 AND 500),
      "intentSha256" CHAR(64) NOT NULL CHECK ("intentSha256" ~ '^[a-f0-9]{64}$'),
      "beforeContact" JSONB NOT NULL,"afterContact" JSONB NOT NULL,
      "status" TEXT NOT NULL CHECK ("status" IN
        ('PREPARING','EDITING','RECIPIENT_UPDATED','RESENDING','RESENT','EDIT_UNCERTAIN','RESEND_FAILED','RESEND_UNCERTAIN','FAILED_SAFE')),
      "lastError" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      "editedAt" TIMESTAMP(3),"resentAt" TIMESTAMP(3),
      CHECK ("status" NOT IN ('RECIPIENT_UPDATED','RESENDING','RESENT','RESEND_FAILED','RESEND_UNCERTAIN') OR "editedAt" IS NOT NULL),
      CHECK ("status"<>'RESENT' OR "resentAt" IS NOT NULL))`,
    `DROP INDEX IF EXISTS "FirmaSeguroRecipientDelivery_one_pending"`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "FirmaSeguroRecipientDelivery_one_pending_process"
      ON "FirmaSeguroRecipientDelivery"("draftId","processUuid") WHERE "status" NOT IN ('RESENT','FAILED_SAFE')`,
    `CREATE INDEX IF NOT EXISTS "FirmaSeguroRecipientDelivery_latest"
      ON "FirmaSeguroRecipientDelivery"("draftId","processUuid","createdAt" DESC,"id" DESC)`,
    `CREATE TABLE IF NOT EXISTS "FirmaSeguroRecipientDeliveryEvent" (
      "id" BIGSERIAL PRIMARY KEY,
      "deliveryId" UUID NOT NULL REFERENCES "FirmaSeguroRecipientDelivery"("id") ON DELETE RESTRICT,
      "previousStatus" TEXT,"status" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
    `CREATE OR REPLACE FUNCTION public.firmaseguro_recipient_delivery_audit()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='INSERT' THEN
          INSERT INTO "FirmaSeguroRecipientDeliveryEvent"("deliveryId","status") VALUES (NEW."id",NEW."status");
        ELSIF NEW."status" IS DISTINCT FROM OLD."status" THEN
          INSERT INTO "FirmaSeguroRecipientDeliveryEvent"("deliveryId","previousStatus","status")
            VALUES (NEW."id",OLD."status",NEW."status");
        END IF; RETURN NEW; END $$`,
    `CREATE OR REPLACE TRIGGER "FirmaSeguroRecipientDelivery_audit" AFTER INSERT OR UPDATE ON "FirmaSeguroRecipientDelivery"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_recipient_delivery_audit()`,
    `CREATE OR REPLACE FUNCTION public.firmaseguro_recipient_delivery_guard()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'FIRMA_RECIPIENT_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END IF;
        IF ROW(OLD."id",OLD."draftId",OLD."processUuid",OLD."signatureId",OLD."actorUserId",OLD."actorName",
          OLD."reason",OLD."intentSha256",OLD."beforeContact",OLD."afterContact",OLD."createdAt")
          IS DISTINCT FROM ROW(NEW."id",NEW."draftId",NEW."processUuid",NEW."signatureId",NEW."actorUserId",NEW."actorName",
          NEW."reason",NEW."intentSha256",NEW."beforeContact",NEW."afterContact",NEW."createdAt")
          OR (OLD."editedAt" IS NOT NULL AND OLD."editedAt" IS DISTINCT FROM NEW."editedAt")
          OR (OLD."resentAt" IS NOT NULL AND OLD."resentAt" IS DISTINCT FROM NEW."resentAt")
          OR (OLD."status"='RESENT' AND NEW."status"<>'RESENT') THEN
          RAISE EXCEPTION 'FIRMA_RECIPIENT_HISTORY_IMMUTABLE' USING ERRCODE='23514';
        END IF;
        IF OLD."status" IS DISTINCT FROM NEW."status" AND NOT (
          (OLD."status"='PREPARING' AND NEW."status" IN ('EDITING','RECIPIENT_UPDATED'))
          OR (OLD."status" IN ('EDITING','EDIT_UNCERTAIN') AND NEW."status" IN ('RECIPIENT_UPDATED','PREPARING','EDIT_UNCERTAIN','FAILED_SAFE'))
          OR (OLD."status" IN ('RECIPIENT_UPDATED','RESEND_FAILED') AND NEW."status"='RESENDING')
          OR (OLD."status"='RESENDING' AND NEW."status" IN ('RESENT','RESEND_FAILED','RESEND_UNCERTAIN'))) THEN
          RAISE EXCEPTION 'FIRMA_RECIPIENT_TRANSITION_INVALID' USING ERRCODE='23514';
        END IF; RETURN NEW; END $$`,
    `CREATE OR REPLACE TRIGGER "FirmaSeguroRecipientDelivery_guard" BEFORE UPDATE OR DELETE ON "FirmaSeguroRecipientDelivery"
      FOR EACH ROW EXECUTE FUNCTION public.firmaseguro_recipient_delivery_guard()`,
    `CREATE OR REPLACE FUNCTION public.firmaseguro_recipient_event_immutable()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FIRMA_RECIPIENT_HISTORY_IMMUTABLE' USING ERRCODE='23514'; END $$`,
    `CREATE OR REPLACE TRIGGER "FirmaSeguroRecipientDeliveryEvent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON "FirmaSeguroRecipientDeliveryEvent"
      FOR EACH STATEMENT EXECUTE FUNCTION public.firmaseguro_recipient_event_immutable()`,
    `CREATE OR REPLACE TRIGGER "FirmaSeguroRecipientDelivery_no_truncate" BEFORE TRUNCATE ON "FirmaSeguroRecipientDelivery"
      FOR EACH STATEMENT EXECUTE FUNCTION public.firmaseguro_recipient_event_immutable()`,
  ];
}
