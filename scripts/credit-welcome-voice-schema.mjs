export const creditWelcomeVoiceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditWelcomeVoiceEvent" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "type" VARCHAR(32) NOT NULL DEFAULT 'BIENVENIDA_VOZ' CHECK ("type"='BIENVENIDA_VOZ'),
    "source" VARCHAR(32) NOT NULL CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT')),
    "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('PENDING','DISPATCHING','ACCEPTED','COMPLETED','FAILED','UNKNOWN','CANCELLED','SKIPPED')),
    "snapshot" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMPTZ(3),
    "acceptedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "providerCallId" VARCHAR(160) UNIQUE,
    "identityAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("identityAttempts" BETWEEN 0 AND 3),
    "identityVerifiedAt" TIMESTAMPTZ(3),
    "durationSeconds" DOUBLE PRECISION CHECK ("durationSeconds" IS NULL OR ("durationSeconds">=0 AND "durationSeconds"<=86400)),
    "summary" TEXT,
    "doubts" TEXT,
    "transcript" TEXT,
    "recordingUrl" TEXT,
    "resultCode" VARCHAR(64),
    "resultHash" VARCHAR(64),
    CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key" UNIQUE ("creditoId","type")
  )`,
  `CREATE INDEX IF NOT EXISTS "CreditWelcomeVoiceEvent_pending_idx"
    ON public."CreditWelcomeVoiceEvent" ("status","createdAt","id")`,
];

export async function installCreditWelcomeVoiceSchema(client) {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='120s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('finserpay-credit-welcome-voice-schema'))");
    for (const statement of creditWelcomeVoiceSchemaStatements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
