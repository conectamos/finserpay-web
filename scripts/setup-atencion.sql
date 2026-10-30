BEGIN;
SET LOCAL search_path = public;
CREATE TABLE IF NOT EXISTS "AttentionConversation" (
  id uuid PRIMARY KEY, "externalId" text UNIQUE, channel text NOT NULL CHECK (channel IN ('internal','whatsapp')),
  phone text NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','open','closed')),
  mode text NOT NULL DEFAULT 'unknown' CHECK (mode IN ('unknown','ai','human_requested','human')),
  "sedeId" integer NOT NULL REFERENCES "Sede"(id) ON DELETE RESTRICT,
  "assigneeKey" text, "assigneeName" text, "assigneeUserId" integer REFERENCES "Usuario"(id) ON DELETE RESTRICT,
  "assigneeSellerId" integer REFERENCES "Vendedor"(id) ON DELETE RESTRICT,
  "linkedCreditId" integer REFERENCES "Credito"(id) ON DELETE RESTRICT,
  "lastContactAt" timestamptz, "closedAt" timestamptz, "daptaMessagesCursor" text, "historyTruncated" boolean NOT NULL DEFAULT false,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags)='array'), version integer NOT NULL DEFAULT 1 CHECK(version>0),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "closedAt" timestamptz;
ALTER TABLE "AttentionConversation" ADD COLUMN IF NOT EXISTS "daptaMessagesCursor" text;
CREATE INDEX IF NOT EXISTS "AttentionConversation_scope" ON "AttentionConversation"("sedeId","assigneeKey",status,"updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "AttentionConversation_phone" ON "AttentionConversation"(phone);
CREATE TABLE IF NOT EXISTS "AttentionMessage" (
  id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
  "externalId" text NOT NULL, direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
  text text NOT NULL, "sentAt" timestamptz NOT NULL, author text,
  UNIQUE("conversationId","externalId")
);
CREATE INDEX IF NOT EXISTS "AttentionMessage_timeline" ON "AttentionMessage"("conversationId","sentAt",id);
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
CREATE TABLE IF NOT EXISTS "AttentionRequest" (
  "actorKey" text NOT NULL, "requestId" uuid NOT NULL, fingerprint text NOT NULL, "resultId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY("actorKey","requestId")
);
CREATE OR REPLACE FUNCTION attention_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Attention audit is append-only'; END; $$;
DROP TRIGGER IF EXISTS attention_audit_immutable ON "AttentionAudit";
CREATE TRIGGER attention_audit_immutable BEFORE UPDATE OR DELETE ON "AttentionAudit" FOR EACH ROW EXECUTE FUNCTION attention_audit_immutable();
COMMIT;
