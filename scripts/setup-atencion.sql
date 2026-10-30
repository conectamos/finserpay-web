BEGIN;
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS "AttentionConversation" (
  id uuid PRIMARY KEY, "externalId" text UNIQUE, channel text NOT NULL CHECK (channel IN ('internal','whatsapp')),
  phone text, name text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','open','closed')),
  mode text NOT NULL DEFAULT 'unknown' CHECK (mode IN ('unknown','ai','human_requested','human')),
  "sedeId" integer REFERENCES "Sede"(id) ON DELETE RESTRICT,
  "assigneeKey" text, "assigneeName" text, "assigneeUserId" integer REFERENCES "Usuario"(id) ON DELETE RESTRICT,
  "assigneeSellerId" integer REFERENCES "Vendedor"(id) ON DELETE RESTRICT,
  "linkedCreditId" integer REFERENCES "Credito"(id) ON DELETE RESTRICT,
  "lastContactAt" timestamptz, "closedAt" timestamptz, "daptaMessagesCursor" text, "historyTruncated" boolean NOT NULL DEFAULT false,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags)='array'), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "closedAt" timestamptz;
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "daptaMessagesCursor" text;
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "metaManaged" boolean NOT NULL DEFAULT false;
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "metaLastInboundAt" timestamptz;
-- Global inbox: source conversations are not assigned to an arbitrary sales branch.
ALTER TABLE "AttentionConversation" ALTER COLUMN "sedeId" DROP NOT NULL;
-- A Meta channel identifier is not necessarily a verifiable telephone number.
ALTER TABLE "AttentionConversation" ALTER COLUMN phone DROP NOT NULL;
CREATE INDEX IF NOT EXISTS "AttentionConversation_scope" ON "AttentionConversation"("sedeId","assigneeKey",status,"updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "AttentionConversation_analyst" ON "AttentionConversation"("assigneeUserId","assigneeKey",status,"updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "AttentionConversation_phone" ON "AttentionConversation"(phone);
CREATE TABLE IF NOT EXISTS "AttentionMessage" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "externalId" text NOT NULL, direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
  text text NOT NULL, "sentAt" timestamptz NOT NULL, author text,
  UNIQUE("conversationId","externalId")
);
CREATE INDEX IF NOT EXISTS "AttentionMessage_timeline" ON "AttentionMessage"("conversationId","sentAt",id);
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "metaWamid" text;
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "metaPhoneNumberId" text;
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "attachment" jsonb;
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "deliveryStatus" text;
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "deliveryAt" timestamptz;
ALTER TABLE "AttentionMessage" ADD COLUMN IF NOT EXISTS "replyToWamid" text;
CREATE UNIQUE INDEX IF NOT EXISTS "AttentionMessage_meta_identity" ON "AttentionMessage"("metaPhoneNumberId","metaWamid");
CREATE TABLE IF NOT EXISTS "AttentionNote" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  text text NOT NULL, author text NOT NULL, "userId" integer NOT NULL REFERENCES "Usuario"(id), "sellerId" integer REFERENCES "Vendedor"(id),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "AttentionTask" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  title text NOT NULL, "dueAt" timestamptz, "completedAt" timestamptz, author text NOT NULL,
  "userId" integer NOT NULL REFERENCES "Usuario"(id), "sellerId" integer REFERENCES "Vendedor"(id), "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "AttentionNote_timeline" ON "AttentionNote"("conversationId","createdAt",id);
CREATE INDEX IF NOT EXISTS "AttentionTask_timeline" ON "AttentionTask"("conversationId","createdAt" DESC,id);
CREATE TABLE IF NOT EXISTS "AttentionQuickReply" (
  id uuid PRIMARY KEY, title text NOT NULL, text text NOT NULL, "approvedBy" text NOT NULL,
  "approvedByUserId" integer NOT NULL REFERENCES "Usuario"(id), "approvedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "AttentionAudit" (
  id bigserial PRIMARY KEY, "conversationId" uuid REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "userId" integer NOT NULL REFERENCES "Usuario"(id), "sellerId" integer REFERENCES "Vendedor"(id),
  action text NOT NULL, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "AttentionAudit_timeline" ON "AttentionAudit"("conversationId","createdAt" DESC);
ALTER TABLE "AttentionAudit" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AttentionAudit" ADD COLUMN IF NOT EXISTS "actorKind" text NOT NULL DEFAULT 'user';
ALTER TABLE "AttentionAudit" ADD COLUMN IF NOT EXISTS "actorKey" text;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='"AttentionAudit"'::regclass AND conname='AttentionAudit_actor') THEN
    ALTER TABLE "AttentionAudit" ADD CONSTRAINT "AttentionAudit_actor" CHECK (
      ("actorKind"='user' AND "userId" IS NOT NULL) OR
      ("actorKind"='system' AND "userId" IS NULL AND "sellerId" IS NULL AND "actorKey" IS NOT NULL AND "actorKey"='SYSTEM_META'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS "AttentionMetaBinding" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "phoneNumberId" text NOT NULL, "wabaId" text NOT NULL, "contactId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("phoneNumberId","contactId")
);
CREATE INDEX IF NOT EXISTS "AttentionMetaBinding_conversation" ON "AttentionMetaBinding"("conversationId");
CREATE TABLE IF NOT EXISTS "AttentionMetaOutbox" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "userId" integer NOT NULL REFERENCES "Usuario"(id), "actorKey" text NOT NULL, "authorName" text NOT NULL,
  "requestId" uuid NOT NULL, fingerprint text NOT NULL, "conversationVersion" integer NOT NULL,
  "phoneNumberId" text NOT NULL, "wabaId" text NOT NULL, "contactId" text NOT NULL,
  text text NOT NULL, attachment jsonb, "uploadedMediaId" text,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','accepted','sent','delivered','read','failed','uncertain')),
  "messageId" uuid REFERENCES "AttentionMessage"(id), wamid text,
  "leaseToken" uuid, "leaseUntil" timestamptz, "sendStartedAt" timestamptz, "acceptedAt" timestamptz,
  "deliveryAt" timestamptz, "errorCode" text, attempts integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("actorKey","requestId"), UNIQUE("phoneNumberId",wamid)
);
CREATE INDEX IF NOT EXISTS "AttentionMetaOutbox_conversation" ON "AttentionMetaOutbox"("conversationId","createdAt");
CREATE TABLE IF NOT EXISTS "AttentionMetaDelivery" (
  id uuid PRIMARY KEY, "phoneNumberId" text NOT NULL, "wabaId" text NOT NULL, wamid text NOT NULL,
  recipient text NOT NULL, status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
  "eventAt" timestamptz NOT NULL, "errorCode" text, "requestId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("phoneNumberId",wamid,status,"eventAt")
);
CREATE TABLE IF NOT EXISTS "AttentionRequest" (
  "actorKey" text NOT NULL, "requestId" uuid NOT NULL, fingerprint text NOT NULL, "resultId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY("actorKey","requestId")
);
CREATE OR REPLACE FUNCTION attention_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Attention audit is append-only'; END; $$;
DROP TRIGGER IF EXISTS attention_audit_immutable ON "AttentionAudit";
CREATE TRIGGER attention_audit_immutable BEFORE UPDATE OR DELETE ON "AttentionAudit" FOR EACH ROW EXECUTE FUNCTION attention_audit_immutable();

-- Transactional invalidation only: no names, phones, message text, documents or
-- financial values enter NOTIFY. Role/assignment checks still run on each SSE.
CREATE OR REPLACE FUNCTION attention_realtime_notify() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  chat_id uuid;
  current_user_id integer;
  current_key text;
  current_seller_id integer;
  previous_user_id integer := NULL;
  previous_key text := NULL;
  previous_seller_id integer := NULL;
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='AttentionConversation' THEN
    chat_id := NEW.id;
    current_user_id := NEW."assigneeUserId"; current_key := NEW."assigneeKey"; current_seller_id := NEW."assigneeSellerId";
    IF TG_OP='UPDATE' THEN
      previous_user_id := OLD."assigneeUserId"; previous_key := OLD."assigneeKey"; previous_seller_id := OLD."assigneeSellerId";
    END IF;
  ELSE
    IF TG_TABLE_NAME='AttentionMetaOutbox' AND TG_OP='UPDATE' THEN
      IF (NEW.status,NEW."messageId",NEW."errorCode") IS NOT DISTINCT FROM (OLD.status,OLD."messageId",OLD."errorCode") THEN RETURN NEW; END IF;
    END IF;
    chat_id := NEW."conversationId";
    SELECT c."assigneeUserId",c."assigneeKey",c."assigneeSellerId" INTO current_user_id,current_key,current_seller_id
      FROM public."AttentionConversation" c WHERE c.id=chat_id;
  END IF;
  PERFORM pg_notify('finserpay_attention_changes', json_build_object(
    'conversationId',chat_id,'previousUserId',previous_user_id,'previousKey',previous_key,'previousSellerId',previous_seller_id,
    'currentUserId',current_user_id,'currentKey',current_key,'currentSellerId',current_seller_id)::text);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS attention_realtime_conversation ON "AttentionConversation";
CREATE TRIGGER attention_realtime_conversation AFTER INSERT OR UPDATE ON "AttentionConversation" FOR EACH ROW EXECUTE FUNCTION attention_realtime_notify();
DROP TRIGGER IF EXISTS attention_realtime_message ON "AttentionMessage";
CREATE TRIGGER attention_realtime_message AFTER INSERT OR UPDATE OF text,attachment,"deliveryStatus" ON "AttentionMessage" FOR EACH ROW EXECUTE FUNCTION attention_realtime_notify();
DROP TRIGGER IF EXISTS attention_realtime_outbox ON "AttentionMetaOutbox";
CREATE TRIGGER attention_realtime_outbox AFTER INSERT OR UPDATE OF status,"messageId","errorCode" ON "AttentionMetaOutbox" FOR EACH ROW EXECUTE FUNCTION attention_realtime_notify();
COMMIT;
