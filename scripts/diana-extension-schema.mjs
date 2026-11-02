import { moraExceptionRequestSchemaStatements } from "./mora-exception-requests-schema.mjs";
import { analystMoraSchemaStatements } from "./analyst-mora-schema.mjs";

/** Shared read-only readiness contract used by the installer and live requests. */
export function dianaExtensionSchemaCheckSql() {
  const columns = ["id", "code", "creditoId", "actorSystemKey", "status", "phone", "identityHash", "inputHash", "creditFingerprint", "scope", "folio", "days",
    "installmentNumber", "installmentDueDate", "expiresOn", "promiseAmount", "promiseDate", "reason", "offerText", "offerDigest", "createdAt", "expiresAt", "updatedAt",
    "conversationId", "externalConversationId", "contactId", "offerMessageId", "offeredAt", "confirmationMessageId", "confirmedAt", "extensionId", "managementId", "rejectedReason"];
  return `WITH components AS (SELECT
    (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public' AND table_name IN
      ('DianaExtensionProposal','CreditMoraExceptionRequest','CreditMoraExceptionEvent','CreditMoraManagementEvent','AttentionAudit','AttentionMetaBinding')) AS "tablesReady",
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND is_nullable='YES' AND
      ((table_name='CreditMoraExceptionRequest' AND column_name IN ('createdBySystemKey','decidedBySystemKey'))
        OR (table_name='CreditMoraExceptionEvent' AND column_name='actorSystemKey')
        OR (table_name='CreditMoraManagementEvent' AND column_name IN ('responsibleSystemKey','actorSystemKey')))) AS "systemColumnsReady",
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND is_nullable='YES' AND
      ((table_name='CreditMoraExceptionRequest' AND column_name='createdByUserId')
        OR (table_name='CreditMoraManagementEvent' AND column_name IN ('responsibleUserId','actorUserId')))) AS "nullableActorsReady",
    (SELECT count(*)::int FROM pg_constraint WHERE convalidated AND
      ((conrelid=to_regclass('public."CreditMoraExceptionRequest"') AND conname='CreditMoraExceptionRequest_actor_identity'
        AND pg_get_constraintdef(oid) LIKE '%createdBySystemKey%' AND pg_get_constraintdef(oid) LIKE '%decidedBySystemKey%')
      OR (conrelid=to_regclass('public."CreditMoraExceptionEvent"') AND conname='CreditMoraExceptionEvent_system_actor')
      OR (conrelid=to_regclass('public."CreditMoraManagementEvent"') AND conname='CreditMoraManagementEvent_actor_identity'
        AND pg_get_constraintdef(oid) LIKE '%responsibleSystemKey%' AND pg_get_constraintdef(oid) LIKE '%actorSystemKey%'))
      AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA%') AS "actorConstraintsReady",
    (SELECT count(*)::int FROM pg_constraint WHERE convalidated AND conrelid=to_regclass('public."CreditMoraExceptionRequest"')
      AND ((conname='CreditMoraExceptionRequest_source_values' AND pg_get_constraintdef(oid) LIKE '%CENTRAL_DIRECT%' AND pg_get_constraintdef(oid) LIKE '%ANALYST_REQUEST%')
        OR (conname='CreditMoraExceptionRequest_source_fields' AND pg_get_constraintdef(oid) LIKE '%installmentNumber%' AND pg_get_constraintdef(oid) LIKE '%promiseDate%'))
      AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA%') AS "sourceConstraintsReady",
    NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."CreditMoraExceptionRequest"') AND conname='CreditMoraExceptionRequest_source_check') AS "legacySourceCheckRemoved",
    EXISTS(SELECT 1 FROM pg_constraint WHERE convalidated AND conrelid=to_regclass('public."AttentionAudit"') AND conname='AttentionAudit_actor' AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA%') AS "attentionAuditReady",
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid=to_regclass('public."DianaExtensionProposal"')
      AND tgname IN ('DianaExtensionProposal_immutable','DianaExtensionProposal_no_truncate') AND NOT tgisinternal AND tgenabled IN ('O','A')) AS "proposalTriggersReady",
    (SELECT count(*)::int FROM information_schema.columns WHERE table_schema='public' AND table_name='DianaExtensionProposal'
      AND column_name IN (${columns.map(column => `'${column}'`).join(",")})) AS "proposalColumnsReady",
    (SELECT count(*)::int FROM pg_index WHERE indisunique AND indisvalid AND
      ((indexrelid=to_regclass('public."CreditMoraExceptionRequest_one_open"') AND indrelid=to_regclass('public."CreditMoraExceptionRequest"')
        AND pg_get_indexdef(indexrelid) LIKE '%("creditoId")%' AND pg_get_expr(indpred,indrelid) LIKE '%PENDING%' AND pg_get_expr(indpred,indrelid) LIKE '%APPROVED%')
      OR (indexrelid=to_regclass('public."DianaExtensionProposal_one_active"') AND indrelid=to_regclass('public."DianaExtensionProposal"')
        AND pg_get_indexdef(indexrelid) LIKE '%("creditoId")%' AND pg_get_expr(indpred,indrelid) LIKE '%PENDING%' AND pg_get_expr(indpred,indrelid) LIKE '%OFFERED%'))) AS "activeIndexesReady")
    SELECT *, ("tablesReady"=6 AND "systemColumnsReady"=5 AND "nullableActorsReady"=3 AND "actorConstraintsReady"=3
      AND "sourceConstraintsReady"=2 AND "legacySourceCheckRemoved" AND "attentionAuditReady" AND "proposalTriggersReady"=2
      AND "proposalColumnsReady"=${columns.length} AND "activeIndexesReady"=2) AS ready FROM components`;
}

export function dianaExtensionSchemaStatements() {
  return [
    ...moraExceptionRequestSchemaStatements(),
    ...analystMoraSchemaStatements(),
    `CREATE TABLE IF NOT EXISTS "DianaExtensionProposal" (
      id UUID PRIMARY KEY, code VARCHAR(19) NOT NULL UNIQUE CHECK (code ~ '^PR-[A-F0-9]{16}$'),
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"(id) ON DELETE RESTRICT,
      "actorSystemKey" VARCHAR(32) NOT NULL DEFAULT 'SYSTEM_DIANA' CHECK ("actorSystemKey"='SYSTEM_DIANA'),
      status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','OFFERED','GRANTED','EXPIRED','REJECTED')),
      phone VARCHAR(16) NOT NULL CHECK (phone ~ '^[+][1-9][0-9]{7,14}$'),
      "identityHash" CHAR(64) NOT NULL, "inputHash" CHAR(64) NOT NULL, "creditFingerprint" CHAR(64) NOT NULL,
      scope JSONB NOT NULL CHECK (jsonb_typeof(scope)='object'), folio VARCHAR(120) NOT NULL,
      days INTEGER NOT NULL CHECK (days BETWEEN 1 AND 4), "installmentNumber" INTEGER NOT NULL CHECK ("installmentNumber">0),
      "installmentDueDate" DATE NOT NULL, "expiresOn" DATE NOT NULL,
      "promiseAmount" NUMERIC(20,2) NOT NULL CHECK ("promiseAmount">0), "promiseDate" DATE NOT NULL,
      reason VARCHAR(500) NOT NULL, "offerText" TEXT NOT NULL, "offerDigest" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL, "updatedAt" TIMESTAMPTZ NOT NULL,
      "conversationId" UUID REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
      "externalConversationId" UUID, "contactId" VARCHAR(16), "offerMessageId" UUID, "offeredAt" TIMESTAMPTZ,
      "confirmationMessageId" UUID UNIQUE, "confirmedAt" TIMESTAMPTZ,
      "extensionId" UUID UNIQUE REFERENCES "CreditMoraExceptionRequest"(id) ON DELETE RESTRICT,
      "managementId" UUID UNIQUE REFERENCES "CreditMoraManagementEvent"(id) ON DELETE RESTRICT,
      "rejectedReason" VARCHAR(500),
      CHECK ("expiresOn"="installmentDueDate"+days AND extract(day FROM "installmentDueDate") IN (2,17)),
      CHECK ("promiseDate"<="expiresOn" AND "promiseDate">=("createdAt" AT TIME ZONE 'America/Bogota')::date),
      CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '15 minutes'),
      CHECK (("offeredAt" IS NULL AND "offerMessageId" IS NULL AND "conversationId" IS NULL AND "externalConversationId" IS NULL AND "contactId" IS NULL)
        OR ("offeredAt" IS NOT NULL AND "offerMessageId" IS NOT NULL AND "conversationId" IS NOT NULL AND "externalConversationId" IS NOT NULL AND "contactId" IS NOT NULL
          AND "offeredAt">="createdAt" AND "offeredAt"<"expiresAt")),
      CHECK (status NOT IN ('OFFERED','GRANTED') OR "offeredAt" IS NOT NULL),
      CHECK (status<>'PENDING' OR "offeredAt" IS NULL),
      CHECK ((status='GRANTED' AND "extensionId" IS NOT NULL AND "managementId" IS NOT NULL AND "confirmationMessageId" IS NOT NULL
          AND "confirmedAt" IS NOT NULL AND "confirmedAt">"offeredAt" AND "confirmedAt"<"expiresAt")
        OR (status<>'GRANTED' AND "extensionId" IS NULL AND "managementId" IS NULL AND "confirmationMessageId" IS NULL AND "confirmedAt" IS NULL))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "DianaExtensionProposal_one_active" ON "DianaExtensionProposal"("creditoId") WHERE status IN ('PENDING','OFFERED')`,
    `CREATE INDEX IF NOT EXISTS "DianaExtensionProposal_expiry" ON "DianaExtensionProposal"(status,"expiresAt")`,
    `CREATE OR REPLACE FUNCTION public.diana_extension_proposal_immutable() RETURNS trigger AS $$
      BEGIN
        IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Las propuestas de Diana no se eliminan' USING ERRCODE='23514'; END IF;
        IF (to_jsonb(OLD)-ARRAY['status','updatedAt','conversationId','externalConversationId','contactId','offerMessageId','offeredAt','confirmationMessageId','confirmedAt','extensionId','managementId','rejectedReason'])
          IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['status','updatedAt','conversationId','externalConversationId','contactId','offerMessageId','offeredAt','confirmationMessageId','confirmedAt','extensionId','managementId','rejectedReason']) THEN
          RAISE EXCEPTION 'Los términos de la propuesta son inmutables' USING ERRCODE='23514';
        END IF;
        IF OLD."offeredAt" IS NOT NULL AND ROW(OLD."conversationId",OLD."externalConversationId",OLD."contactId",OLD."offerMessageId",OLD."offeredAt")
          IS DISTINCT FROM ROW(NEW."conversationId",NEW."externalConversationId",NEW."contactId",NEW."offerMessageId",NEW."offeredAt") THEN
          RAISE EXCEPTION 'La oferta verificada es inmutable' USING ERRCODE='23514';
        END IF;
        IF OLD.status IN ('GRANTED','EXPIRED','REJECTED') AND to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
          RAISE EXCEPTION 'La propuesta ya está cerrada' USING ERRCODE='23514';
        END IF;
        IF NEW.status<>OLD.status AND NOT ((OLD.status='PENDING' AND NEW.status IN ('OFFERED','EXPIRED','REJECTED'))
          OR (OLD.status='OFFERED' AND NEW.status IN ('GRANTED','EXPIRED','REJECTED'))) THEN
          RAISE EXCEPTION 'Transición de propuesta inválida' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "DianaExtensionProposal_immutable" ON "DianaExtensionProposal"`,
    `CREATE TRIGGER "DianaExtensionProposal_immutable" BEFORE UPDATE OR DELETE ON "DianaExtensionProposal" FOR EACH ROW EXECUTE FUNCTION public.diana_extension_proposal_immutable()`,
    `CREATE OR REPLACE FUNCTION public.diana_extension_proposal_no_truncate() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Las propuestas de Diana no se eliminan' USING ERRCODE='23514'; END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "DianaExtensionProposal_no_truncate" ON "DianaExtensionProposal"`,
    `CREATE TRIGGER "DianaExtensionProposal_no_truncate" BEFORE TRUNCATE ON "DianaExtensionProposal" FOR EACH STATEMENT EXECUTE FUNCTION public.diana_extension_proposal_no_truncate()`,
  ];
}

export async function installDianaExtensionSchema(client) {
  await client.query("BEGIN");
  try {
    for (const sql of dianaExtensionSchemaStatements()) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
