import { moraExceptionRequestSchemaStatements } from "./mora-exception-requests-schema.mjs";
import { analystMoraSchemaStatements } from "./analyst-mora-schema.mjs";

export function dianaExtensionRequestSchemaCheckSql() {
  const columns = [
    ["id", "uuid", "NO"], ["messageId", "uuid", "NO"], ["conversationId", "uuid", "NO"], ["externalConversationId", "uuid", "NO"],
    ["contactId", "varchar", "NO"], ["phone", "varchar", "NO"], ["scope", "jsonb", "NO"], ["messageAt", "timestamptz", "NO"],
    ["observedAt", "timestamptz", "NO"], ["textDigest", "bpchar", "NO"], ["requestHash", "bpchar", "NO"], ["intent", "jsonb", "NO"],
    ["outcome", "varchar", "NO"], ["reason", "varchar", "YES"], ["creditoId", "int4", "YES"], ["days", "int4", "YES"],
    ["installmentNumber", "int4", "YES"], ["installmentDueDate", "date", "YES"], ["expiresOn", "date", "YES"],
    ["extensionId", "uuid", "YES"], ["managementId", "uuid", "YES"], ["createdAt", "timestamptz", "NO"],
  ];
  const foreignKeys = [["conversationId", "AttentionConversation"], ["creditoId", "Credito"], ["extensionId", "CreditMoraExceptionRequest"], ["managementId", "CreditMoraManagementEvent"]];
  return `SELECT (
    to_regclass('public."DianaExtensionRequest"') IS NOT NULL
    AND (SELECT count(*) FROM (VALUES ${columns.map(row => `(${row.map(value => `'${value}'`).join(",")})`).join(",")}) expected(name,kind,nullable)
      JOIN information_schema.columns actual ON actual.table_schema='public' AND actual.table_name='DianaExtensionRequest'
        AND actual.column_name=expected.name AND actual.udt_name=expected.kind AND actual.is_nullable=expected.nullable)=${columns.length}
    AND EXISTS(SELECT 1 FROM pg_constraint p JOIN pg_attribute a ON a.attrelid=p.conrelid AND a.attname='id'
      WHERE p.conrelid=to_regclass('public."DianaExtensionRequest"') AND p.contype='p' AND p.conkey=ARRAY[a.attnum]::smallint[])
    AND (SELECT count(*) FROM (VALUES ${foreignKeys.map(row => `('${row[0]}','${row[1]}')`).join(",")}) expected(name,target)
      JOIN pg_attribute a ON a.attrelid=to_regclass('public."DianaExtensionRequest"') AND a.attname=expected.name
      JOIN pg_constraint f ON f.conrelid=a.attrelid AND f.contype='f' AND f.convalidated AND f.conkey=ARRAY[a.attnum]::smallint[]
        AND f.confrelid=to_regclass('public."'||expected.target||'"') AND f.confdeltype='r')=${foreignKeys.length}
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."CreditMoraExceptionRequest"')
      AND conname='CreditMoraExceptionRequest_source_values' AND convalidated AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA_REQUEST%')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."CreditMoraExceptionRequest"')
      AND conname='CreditMoraExceptionRequest_source_fields' AND convalidated AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA_REQUEST%')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."CreditMoraExceptionRequest"')
      AND conname='CreditMoraExceptionRequest_actor_identity' AND convalidated AND pg_get_constraintdef(oid) LIKE '%SYSTEM_DIANA_REQUEST%')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."CreditMoraManagementEvent"')
      AND conname='CreditMoraManagementEvent_result_details_check' AND convalidated AND pg_get_constraintdef(oid) LIKE '%PRORROGA_APROBADA%')
    AND EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='messageId'
      WHERE i.indexrelid=to_regclass('public."DianaExtensionRequest_message"') AND i.indrelid=to_regclass('public."DianaExtensionRequest"')
        AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnkeyatts=1 AND i.indkey[0]=a.attnum)
    AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public."CreditMoraExceptionRequest_one_open"')
      AND indrelid=to_regclass('public."CreditMoraExceptionRequest"') AND indisunique AND indisvalid
      AND pg_get_indexdef(indexrelid) LIKE '%("creditoId")%' AND pg_get_expr(indpred,indrelid) LIKE '%PENDING%' AND pg_get_expr(indpred,indrelid) LIKE '%APPROVED%')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public."DianaExtensionRequest"')
      AND conname='DianaExtensionRequest_grant_facts' AND convalidated)
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public."CreditMoraExceptionRequest"')
      AND tgname='CreditMoraExceptionRequest_diana_identity' AND NOT tgisinternal AND tgenabled IN ('O','A')
      AND tgfoid=to_regprocedure('public.mora_diana_request_identity_immutable()'))
    AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('public."DianaExtensionRequest"')
      AND tgname IN ('DianaExtensionRequest_immutable','DianaExtensionRequest_no_truncate') AND NOT tgisinternal AND tgenabled IN ('O','A')
      AND tgfoid=to_regprocedure('public.diana_extension_request_immutable()'))=2
  ) AS ready`;
}
export function dianaExtensionRequestSchemaStatements() {
  return [
    ...moraExceptionRequestSchemaStatements(), ...analystMoraSchemaStatements(),
    `CREATE TABLE IF NOT EXISTS "DianaExtensionRequest" (
      id UUID PRIMARY KEY, "messageId" UUID NOT NULL, "conversationId" UUID NOT NULL REFERENCES "AttentionConversation"(id) ON DELETE RESTRICT,
      "externalConversationId" UUID NOT NULL, "contactId" VARCHAR(16) NOT NULL, phone VARCHAR(16) NOT NULL,
      scope JSONB NOT NULL CHECK(jsonb_typeof(scope)='object'), "messageAt" TIMESTAMPTZ NOT NULL,
      "observedAt" TIMESTAMPTZ NOT NULL, "textDigest" CHAR(64) NOT NULL, "requestHash" CHAR(64) NOT NULL,
      intent JSONB NOT NULL CHECK(jsonb_typeof(intent)='object'),
      outcome VARCHAR(16) NOT NULL CHECK(outcome IN ('GRANTED','REJECTED','NEEDS_CREDIT')),
      reason VARCHAR(500), "creditoId" INTEGER REFERENCES "Credito"(id) ON DELETE RESTRICT,
      days INTEGER CHECK(days BETWEEN 1 AND 4), "installmentNumber" INTEGER, "installmentDueDate" DATE, "expiresOn" DATE,
      "extensionId" UUID UNIQUE REFERENCES "CreditMoraExceptionRequest"(id) ON DELETE RESTRICT,
      "managementId" UUID UNIQUE REFERENCES "CreditMoraManagementEvent"(id) ON DELETE RESTRICT,
      "createdAt" TIMESTAMPTZ NOT NULL,
      CHECK(phone='+'||"contactId" AND "contactId" ~ '^[1-9][0-9]{7,14}$'),
      CHECK("observedAt">="messageAt" AND "createdAt">="messageAt"),
      CONSTRAINT "DianaExtensionRequest_grant_facts" CHECK((outcome='GRANTED' AND "creditoId" IS NOT NULL AND days IS NOT NULL
        AND "installmentNumber" IS NOT NULL AND "installmentNumber">0 AND "expiresOn" IS NOT NULL
        AND "installmentDueDate" IS NOT NULL AND "expiresOn"="installmentDueDate"+days
        AND extract(day FROM "installmentDueDate") IN(2,17) AND "extensionId" IS NOT NULL AND "managementId" IS NOT NULL)
        OR (outcome<>'GRANTED' AND "extensionId" IS NULL AND "managementId" IS NULL))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "DianaExtensionRequest_message" ON "DianaExtensionRequest"("messageId")`,
    `CREATE INDEX IF NOT EXISTS "DianaExtensionRequest_latest" ON "DianaExtensionRequest"("conversationId","messageAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "DianaExtensionRequest_credit" ON "DianaExtensionRequest"("creditoId","createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "DianaExtensionRequest_phone" ON "DianaExtensionRequest"(phone,"messageAt" DESC)`,
    `CREATE OR REPLACE FUNCTION public.diana_extension_request_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'El historial de solicitudes de Diana es inmutable' USING ERRCODE='23514'; END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "DianaExtensionRequest_immutable" ON "DianaExtensionRequest"`,
    `CREATE TRIGGER "DianaExtensionRequest_immutable" BEFORE UPDATE OR DELETE ON "DianaExtensionRequest" FOR EACH ROW EXECUTE FUNCTION public.diana_extension_request_immutable()`,
    `DROP TRIGGER IF EXISTS "DianaExtensionRequest_no_truncate" ON "DianaExtensionRequest"`,
    `CREATE TRIGGER "DianaExtensionRequest_no_truncate" BEFORE TRUNCATE ON "DianaExtensionRequest" FOR EACH STATEMENT EXECUTE FUNCTION public.diana_extension_request_immutable()`,
  ];
}
export async function installDianaExtensionRequestSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-diana-request-schema'))");
    for (const sql of dianaExtensionRequestSchemaStatements()) await client.query(sql);
    await client.query("COMMIT");
  }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
