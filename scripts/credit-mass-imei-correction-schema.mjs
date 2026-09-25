export const creditMassImeiCorrectionSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditMassImeiCorrection" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL UNIQUE REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "requestId" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "rowNumber" INTEGER NOT NULL CHECK ("rowNumber" BETWEEN 1 AND 250),
    "numeroCreditoSadmin" VARCHAR(80) NOT NULL,
    "clienteDocumento" VARCHAR(80) NOT NULL CHECK ("clienteDocumento" ~ '^[0-9]{5,80}$'),
    "previousImei" VARCHAR(15) NOT NULL CHECK ("previousImei" ~ '^[0-9]{15}$'),
    "newImei" VARCHAR(15) NOT NULL UNIQUE CHECK ("newImei" ~ '^[0-9]{15}$'),
    "actorUserId" INTEGER NOT NULL REFERENCES public."Usuario"("id") ON DELETE RESTRICT,
    "actorName" VARCHAR(160) NOT NULL CHECK (LENGTH(BTRIM("actorName")) > 0),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
    CONSTRAINT "CreditMassImeiCorrection_imei_changed_check" CHECK ("previousImei" <> "newImei"),
    CONSTRAINT "CreditMassImeiCorrection_request_row_key" UNIQUE ("requestId", "rowNumber")
  )`,
  `ALTER TABLE public."CreditMassImeiCorrection"
    ADD COLUMN IF NOT EXISTS "clienteDocumento" VARCHAR(80)`,
  `ALTER TABLE public."CreditMassImeiCorrection"
    ALTER COLUMN "clienteDocumento" SET NOT NULL`,
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'CreditMassImeiCorrection_document_check'
        AND conrelid = 'public."CreditMassImeiCorrection"'::regclass
    ) THEN
      ALTER TABLE public."CreditMassImeiCorrection"
        ADD CONSTRAINT "CreditMassImeiCorrection_document_check"
        CHECK ("clienteDocumento" ~ '^[0-9]{5,80}$');
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS "CreditMassImeiCorrection_request_idx"
    ON public."CreditMassImeiCorrection"("requestId")`,
  `CREATE OR REPLACE FUNCTION public.credit_mass_imei_reject_history_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'El historial de correcciones de IMEI es inmutable';
    END $$`,
  `CREATE OR REPLACE TRIGGER "CreditMassImeiCorrection_immutable"
    BEFORE UPDATE OR DELETE ON public."CreditMassImeiCorrection"
    FOR EACH ROW EXECUTE FUNCTION public.credit_mass_imei_reject_history_mutation()`,
  `CREATE OR REPLACE TRIGGER "CreditMassImeiCorrection_no_truncate"
    BEFORE TRUNCATE ON public."CreditMassImeiCorrection"
    FOR EACH STATEMENT EXECUTE FUNCTION public.credit_mass_imei_reject_history_mutation()`,
];

export async function installCreditMassImeiCorrectionSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-mass-imei-correction-schema'))");
    for (const statement of creditMassImeiCorrectionSchemaStatements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
