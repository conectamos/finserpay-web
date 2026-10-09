export const creditWelcomeVoiceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."CreditWelcomeVoiceEvent" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "type" VARCHAR(32) NOT NULL DEFAULT 'BIENVENIDA_VOZ' CHECK ("type"='BIENVENIDA_VOZ'),
    "source" VARCHAR(32) NOT NULL CONSTRAINT "CreditWelcomeVoiceEvent_source_check"
      CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT','CONTROLLED_TEST')),
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "repeatOf" UUID,
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
    CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key" UNIQUE ("creditoId","type","attemptNumber"),
    CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_key" UNIQUE ("repeatOf"),
    CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_fkey" FOREIGN KEY ("repeatOf")
      REFERENCES public."CreditWelcomeVoiceEvent"("id") ON DELETE RESTRICT,
    CONSTRAINT "CreditWelcomeVoiceEvent_attempt_check" CHECK ("attemptNumber">=0 AND
      (("attemptNumber"=0 AND "repeatOf" IS NULL) OR
       ("attemptNumber">0 AND "source"='CONTROLLED_TEST' AND "repeatOf" IS NOT NULL)))
  )`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "repeatOf" UUID`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_credit_type_key' AND contype='u'
      AND replace(pg_get_constraintdef(oid),'"','')='UNIQUE (creditoId, type)') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key";
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_credit_type_key') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key"
        UNIQUE ("creditoId","type","attemptNumber");
    ELSIF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_credit_type_key' AND contype='u'
      AND replace(pg_get_constraintdef(oid),'"','')='UNIQUE (creditoId, type, attemptNumber)') THEN
      RAISE EXCEPTION 'Unsupported welcome voice uniqueness constraint';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_repeatOf_key') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_key" UNIQUE ("repeatOf");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_repeatOf_fkey') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_fkey"
        FOREIGN KEY ("repeatOf") REFERENCES public."CreditWelcomeVoiceEvent"("id") ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_attempt_check') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_attempt_check"
        CHECK ("attemptNumber">=0 AND (("attemptNumber"=0 AND "repeatOf" IS NULL) OR
          ("attemptNumber">0 AND "source"='CONTROLLED_TEST' AND "repeatOf" IS NOT NULL)));
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_source_check' AND pg_get_constraintdef(oid) LIKE '%CONTROLLED_TEST%') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" DROP CONSTRAINT IF EXISTS "CreditWelcomeVoiceEvent_source_check";
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_source_check"
        CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT','CONTROLLED_TEST'));
    END IF;
  END $$`,
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
