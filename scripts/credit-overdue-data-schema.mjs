export const creditOverdueDataSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditOverdueDataRecipient" (
    "recipientKey" VARCHAR(64) PRIMARY KEY,
    "nextEligibleDate" DATE,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS public."CreditOverdueDataAttempt" (
    "id" UUID PRIMARY KEY,
    "recipientKey" VARCHAR(64) NOT NULL REFERENCES public."CreditOverdueDataRecipient"("recipientKey") ON DELETE RESTRICT,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "campaignDate" DATE NOT NULL,
    "daysPastDue" INTEGER NOT NULL CHECK ("daysPastDue" >= 20),
    "status" TEXT NOT NULL CHECK ("status" IN ('CLAIMED','ACCEPTED','FAILED','UNKNOWN')),
    "claimedAt" TIMESTAMPTZ(3) NOT NULL,
    "claimExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3),
    "resultCode" VARCHAR(40),
    "httpStatus" INTEGER,
    CONSTRAINT "CreditOverdueDataAttempt_recipient_date_key" UNIQUE ("recipientKey", "campaignDate")
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditOverdueDataAttempt_status_expires_idx"
    ON public."CreditOverdueDataAttempt" ("status", "claimExpiresAt")`,
];

export async function installCreditOverdueDataSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-overdue-data-schema'))");
    for (const statement of creditOverdueDataSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
