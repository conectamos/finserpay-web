export const creditPrincipalPaymentSchemaStatements = [
  `ALTER TABLE public."Credito" ADD COLUMN IF NOT EXISTS "planCapitalVigente" JSONB`,
  `CREATE TABLE IF NOT EXISTS public."CreditPrincipalPaymentRevision" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "abonoId" INTEGER NOT NULL UNIQUE REFERENCES public."CreditoAbono"("id") ON DELETE RESTRICT,
    "revision" INTEGER NOT NULL CHECK ("revision" > 0),
    "idempotencyKey" VARCHAR(100) NOT NULL CHECK (LENGTH(BTRIM("idempotencyKey")) >= 16),
    "requestHash" CHAR(64) NOT NULL,
    "previewHash" CHAR(64) NOT NULL,
    "snapshotBefore" JSONB,
    "snapshotAfter" JSONB NOT NULL,
    "conciliacion" JSONB NOT NULL,
    "resultado" JSONB NOT NULL,
    "usuarioId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    UNIQUE ("creditoId", "idempotencyKey"),
    UNIQUE ("creditoId", "revision")
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditPrincipalPaymentRevision_creditoId_createdAt_idx"
    ON public."CreditPrincipalPaymentRevision"("creditoId", "createdAt")`,
  `CREATE OR REPLACE FUNCTION public.credit_principal_payment_reject_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'El historial de abonos extraordinarios a capital es inmutable';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditPrincipalPaymentRevision_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditPrincipalPaymentRevision"
    FOR EACH ROW EXECUTE FUNCTION public.credit_principal_payment_reject_history_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditPrincipalPaymentRevision_no_truncate"
    BEFORE TRUNCATE ON public."CreditPrincipalPaymentRevision"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_principal_payment_reject_history_mutation()`,
];

export async function installCreditPrincipalPaymentSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-principal-payment-schema'))");
    for (const statement of creditPrincipalPaymentSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
