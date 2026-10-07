export const creditDueReminderSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditDueReminder" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "numeroCuota" INTEGER NOT NULL CHECK ("numeroCuota" > 0),
    "templateKey" VARCHAR(100) NOT NULL,
    "fechaVencimiento" DATE NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('CLAIMED','ACCEPTED','FAILED','UNKNOWN')),
    "attempts" INTEGER NOT NULL DEFAULT 1 CHECK ("attempts" = 1),
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "claimExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "resultCode" VARCHAR(40),
    "httpStatus" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditDueReminder_unique_installment_template"
      UNIQUE ("creditoId", "numeroCuota", "templateKey")
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditDueReminder_status_claimExpiresAt_idx"
    ON public."CreditDueReminder" ("status", "claimExpiresAt")`,
];

export async function installCreditDueReminderSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-due-reminder-schema'))");
    for (const statement of creditDueReminderSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
