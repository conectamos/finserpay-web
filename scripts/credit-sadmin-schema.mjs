function ensureCheck(table, name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" CHECK (${expression}); END IF; END $$`;
}

function ensureForeignKey(table, name, definition) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}' AND conrelid='public."${table}"'::regclass)
    THEN ALTER TABLE public."${table}" ADD CONSTRAINT "${name}" ${definition}; END IF; END $$`;
}

export const creditSadminSchemaStatements = [
  `CREATE INDEX IF NOT EXISTS "Credito_sadmin_date_id" ON public."Credito"("fechaCredito" DESC,"id" DESC)
    WHERE UPPER(BTRIM(COALESCE("estado",''))) NOT IN ('ANULADO','ANULADA','CANCELADO','CANCELADA')`,
  `CREATE TABLE IF NOT EXISTS public."CreditSadminRegistration" (
    "creditoId" INTEGER PRIMARY KEY,"version" INTEGER NOT NULL DEFAULT 1,
    "codeudorCreado" BOOLEAN NOT NULL DEFAULT FALSE,"creditoCreado" BOOLEAN NOT NULL DEFAULT FALSE,
    "numeroCreditoConfirmado" BOOLEAN NOT NULL DEFAULT FALSE,"numeroCredito" VARCHAR(80),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
  ensureForeignKey("CreditSadminRegistration", "CreditSadminRegistration_creditoId_fkey",
    `FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureCheck("CreditSadminRegistration", "CreditSadminRegistration_version_check", `"version">=1`),
  ensureCheck("CreditSadminRegistration", "CreditSadminRegistration_number_check",
    `"numeroCredito" IS NULL OR ("numeroCredito"=BTRIM("numeroCredito") AND LENGTH("numeroCredito")>0)`),
  ensureCheck("CreditSadminRegistration", "CreditSadminRegistration_confirmation_check",
    `NOT "numeroCreditoConfirmado" OR "numeroCredito" IS NOT NULL`),
  ensureCheck("CreditSadminRegistration", "CreditSadminRegistration_completion_check",
    `("completedAt" IS NOT NULL)=("codeudorCreado" AND "creditoCreado" AND "numeroCreditoConfirmado" AND "numeroCredito" IS NOT NULL)`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditSadminRegistration_number_key" ON public."CreditSadminRegistration"(LOWER(BTRIM("numeroCredito"))) WHERE "numeroCredito" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public."CreditSadminEvent" (
    "id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL,"version" INTEGER NOT NULL,
    "actorKind" VARCHAR(16) NOT NULL,"actorUserId" INTEGER,"actorName" VARCHAR(160) NOT NULL,
    "actorGrantId" UUID,"actorSessionId" UUID,"payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))`,
  ensureForeignKey("CreditSadminEvent", "CreditSadminEvent_creditoId_fkey",
    `FOREIGN KEY ("creditoId") REFERENCES public."Credito"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureForeignKey("CreditSadminEvent", "CreditSadminEvent_actorUserId_fkey",
    `FOREIGN KEY ("actorUserId") REFERENCES public."Usuario"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureForeignKey("CreditSadminEvent", "CreditSadminEvent_shared_actor_fkey",
    `FOREIGN KEY ("actorSessionId","actorGrantId") REFERENCES public."CreditApprovalSharedSession"("id","grantId") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureCheck("CreditSadminEvent", "CreditSadminEvent_version_check", `"version">0`),
  ensureCheck("CreditSadminEvent", "CreditSadminEvent_actor_check",
    `LENGTH(BTRIM("actorName"))>0 AND (("actorKind"='USER' AND "actorUserId" IS NOT NULL AND "actorGrantId" IS NULL AND "actorSessionId" IS NULL)
      OR ("actorKind"='SHARED_LINK' AND "actorUserId" IS NULL AND "actorGrantId" IS NOT NULL AND "actorSessionId" IS NOT NULL))`),
  `CREATE UNIQUE INDEX IF NOT EXISTS "CreditSadminEvent_credit_version_key" ON public."CreditSadminEvent"("creditoId","version")`,
  `CREATE OR REPLACE TRIGGER "CreditSadminEvent_immutable" BEFORE UPDATE OR DELETE ON public."CreditSadminEvent"
    FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`,
  ...["CreditSadminRegistration", "CreditSadminEvent"].map(table =>
    `CREATE OR REPLACE TRIGGER "${table}_no_truncate" BEFORE TRUNCATE ON public."${table}"
      FOR EACH STATEMENT EXECUTE FUNCTION public.credit_approval_reject_history_mutation()`),
];

export async function installCreditSadminSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-sadmin-schema'))");
    for (const statement of creditSadminSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
