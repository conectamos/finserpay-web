export function analystMoraSchemaStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS "CreditMoraManagementEvent" (
      "id" UUID PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "action" VARCHAR(32) NOT NULL CHECK ("action" IN ('LLAMADA','WHATSAPP','SIN_RESPUESTA','PROMESA_PAGO','ACUERDO_PAGO','SOPORTE_RECIBIDO','ESCALADO','VISITA_PENDIENTE')),
      "actedAt" TIMESTAMPTZ NOT NULL, "responsibleUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "responsibleName" VARCHAR(180) NOT NULL, "result" VARCHAR(500) NOT NULL CHECK (LENGTH(BTRIM("result"))>=3), "comment" VARCHAR(2000) NOT NULL CHECK (LENGTH(BTRIM("comment"))>=5),
      "nextFollowUpAt" TIMESTAMPTZ NOT NULL CHECK ("nextFollowUpAt">"actedAt"), "managementStatus" VARCHAR(32) NOT NULL CHECK ("managementStatus" IN ('PENDIENTE','CONTACTADO','SIN_RESPUESTA','PROMESA_PAGO','ACUERDO_PAGO','SOPORTE_RECIBIDO','ESCALADO','CERRADO')),
      "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT, "actorName" VARCHAR(180) NOT NULL,
      "idempotencyKey" UUID NOT NULL UNIQUE, "requestHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraManagementEvent_latest" ON "CreditMoraManagementEvent" ("creditoId","createdAt" DESC,"id" DESC)`,
    `CREATE TABLE IF NOT EXISTS "CreditMoraSupport" (
      "id" UUID PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "subjectKind" VARCHAR(16) NOT NULL CHECK ("subjectKind" IN ('GESTION','EXCEPCION')), "subjectId" UUID NOT NULL,
      "fileName" VARCHAR(160) NOT NULL, "mimeType" VARCHAR(32) NOT NULL CHECK ("mimeType" IN ('application/pdf','image/png','image/jpeg')),
      "sizeBytes" INTEGER NOT NULL CHECK ("sizeBytes">0 AND "sizeBytes"<=10485760), "bytes" BYTEA NOT NULL CHECK (OCTET_LENGTH("bytes")="sizeBytes"),
      "reason" VARCHAR(1000) NOT NULL, "actorUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" VARCHAR(180) NOT NULL, "idempotencyKey" UUID NOT NULL UNIQUE, "requestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE INDEX IF NOT EXISTS "CreditMoraSupport_subject" ON "CreditMoraSupport" ("subjectKind","subjectId","createdAt")`,
    `CREATE OR REPLACE FUNCTION public.analyst_mora_history_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'El historial de mora es inmutable' USING ERRCODE='23514'; END; $$ LANGUAGE plpgsql`,
    `DROP TRIGGER IF EXISTS "CreditMoraManagementEvent_immutable" ON "CreditMoraManagementEvent"`,
    `CREATE TRIGGER "CreditMoraManagementEvent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON "CreditMoraManagementEvent" FOR EACH STATEMENT EXECUTE FUNCTION public.analyst_mora_history_immutable()`,
    `DROP TRIGGER IF EXISTS "CreditMoraSupport_immutable" ON "CreditMoraSupport"`,
    `CREATE TRIGGER "CreditMoraSupport_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE ON "CreditMoraSupport" FOR EACH STATEMENT EXECUTE FUNCTION public.analyst_mora_history_immutable()`,
  ];
}
export async function installAnalystMoraSchema(client) {
  await client.query("BEGIN");
  try { for (const sql of analystMoraSchemaStatements()) await client.query(sql); await client.query("COMMIT"); }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
