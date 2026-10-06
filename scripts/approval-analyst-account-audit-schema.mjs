function ensureCheck(name, expression) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}'
    AND conrelid='public."ApprovalAnalystAccountEvent"'::regclass) THEN
    ALTER TABLE public."ApprovalAnalystAccountEvent" ADD CONSTRAINT "${name}" CHECK (${expression}); END IF; END $$`;
}

function ensureForeignKey(name, definition) {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}'
    AND conrelid='public."ApprovalAnalystAccountEvent"'::regclass) THEN
    ALTER TABLE public."ApprovalAnalystAccountEvent" ADD CONSTRAINT "${name}" ${definition}; END IF; END $$`;
}

export const approvalAnalystAccountAuditSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."ApprovalAnalystAccountEvent" (
    "id" BIGSERIAL PRIMARY KEY,
    "analystUserId" INTEGER NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "eventType" VARCHAR(32) NOT NULL,
    "accountActive" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
  )`,
  ensureForeignKey("ApprovalAnalystAccountEvent_analystUserId_fkey",
    `FOREIGN KEY ("analystUserId") REFERENCES public."Usuario"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureForeignKey("ApprovalAnalystAccountEvent_actorUserId_fkey",
    `FOREIGN KEY ("actorUserId") REFERENCES public."Usuario"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`),
  ensureCheck("ApprovalAnalystAccountEvent_type_check",
    `"eventType" IN ('CREATED','ACTIVATED','DEACTIVATED','PASSWORD_RESET')`),
  ensureCheck("ApprovalAnalystAccountEvent_state_check", `
    ("eventType"='CREATED' AND "accountActive" IS NOT NULL)
    OR ("eventType"='ACTIVATED' AND "accountActive" IS TRUE)
    OR ("eventType"='DEACTIVATED' AND "accountActive" IS FALSE)
    OR ("eventType"='PASSWORD_RESET' AND "accountActive" IS NULL)`),
  `CREATE INDEX IF NOT EXISTS "ApprovalAnalystAccountEvent_analyst_created_idx"
    ON public."ApprovalAnalystAccountEvent"("analystUserId","createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ApprovalAnalystAccountEvent_actor_created_idx"
    ON public."ApprovalAnalystAccountEvent"("actorUserId","createdAt")`,
  `CREATE OR REPLACE FUNCTION public.approval_analyst_account_event_validate()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM public."Usuario" actor
        JOIN public."Rol" role ON role."id"=actor."rolId"
        JOIN public."Sede" site ON site."id"=actor."sedeId"
        JOIN public."Aliado" ally ON ally."id"=site."aliadoId"
        WHERE actor."id"=NEW."actorUserId" AND actor."activo" IS TRUE
          AND UPPER(BTRIM(role."nombre"))='ADMIN'
          AND UPPER(BTRIM(COALESCE(ally."codigo",'')))='FINSERPAY'
      ) THEN
        RAISE EXCEPTION 'APPROVAL_ANALYST_AUDIT_ACTOR_INVALID' USING ERRCODE='23514';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public."Usuario" analyst
        JOIN public."Rol" role ON role."id"=analyst."rolId"
        JOIN public."Sede" site ON site."id"=analyst."sedeId"
        JOIN public."Aliado" ally ON ally."id"=site."aliadoId"
        WHERE analyst."id"=NEW."analystUserId"
          AND UPPER(BTRIM(role."nombre"))='ANALISTA_APROBACION'
          AND UPPER(BTRIM(COALESCE(ally."codigo",'')))='FINSERPAY'
      ) THEN
        RAISE EXCEPTION 'APPROVAL_ANALYST_AUDIT_TARGET_INVALID' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $$`,
  `CREATE OR REPLACE TRIGGER "ApprovalAnalystAccountEvent_validate"
    BEFORE INSERT ON public."ApprovalAnalystAccountEvent"
    FOR EACH ROW EXECUTE FUNCTION public.approval_analyst_account_event_validate()`,
  `CREATE OR REPLACE FUNCTION public.approval_analyst_account_event_immutable()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'APPROVAL_ANALYST_ACCOUNT_HISTORY_IMMUTABLE';
    END $$`,
  `CREATE OR REPLACE TRIGGER "ApprovalAnalystAccountEvent_immutable"
    BEFORE UPDATE OR DELETE ON public."ApprovalAnalystAccountEvent"
    FOR EACH ROW EXECUTE FUNCTION public.approval_analyst_account_event_immutable()`,
  `CREATE OR REPLACE TRIGGER "ApprovalAnalystAccountEvent_no_truncate"
    BEFORE TRUNCATE ON public."ApprovalAnalystAccountEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION public.approval_analyst_account_event_immutable()`,
  `SELECT "id","analystUserId","actorUserId","eventType","accountActive","createdAt"
    FROM public."ApprovalAnalystAccountEvent" LIMIT 0`,
];

export async function installApprovalAnalystAccountAuditSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-approval-analyst-account-audit-schema'))");
    for (const statement of approvalAnalystAccountAuditSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
