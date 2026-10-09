export const creditWelcomeVoiceSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS public."VoiceReviewCampaign" (
    "id" VARCHAR(64) PRIMARY KEY,
    "startDate" DATE NOT NULL,
    "creditIds" JSONB NOT NULL CHECK (jsonb_typeof("creditIds")='array'),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS public."VoiceReviewCampaignMember" (
    "campaignId" VARCHAR(64) NOT NULL REFERENCES public."VoiceReviewCampaign"("id") ON DELETE RESTRICT,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','CONTACTED','STOPPED','HELD')),
    "stopReason" VARCHAR(64),
    "lastEventId" UUID,
    "reviewRevision" INTEGER,
    "reviewHash" VARCHAR(64),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("campaignId","creditoId")
  )`,
  `CREATE OR REPLACE FUNCTION public.voice_review_campaign_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF ROW(NEW."id",NEW."startDate",NEW."creditIds",NEW."createdAt") IS DISTINCT FROM
      ROW(OLD."id",OLD."startDate",OLD."creditIds",OLD."createdAt") THEN
      RAISE EXCEPTION 'Voice review campaign cohort is immutable';
    END IF;
    RETURN NEW;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public."VoiceReviewCampaign"'::regclass AND tgname='VoiceReviewCampaign_immutable') THEN
      CREATE TRIGGER "VoiceReviewCampaign_immutable" BEFORE UPDATE ON public."VoiceReviewCampaign"
        FOR EACH ROW EXECUTE FUNCTION public.voice_review_campaign_immutable();
    END IF;
  END $$`,
  `CREATE TABLE IF NOT EXISTS public."CreditWelcomeVoiceEvent" (
    "id" UUID PRIMARY KEY,
    "creditoId" INTEGER NOT NULL REFERENCES public."Credito"("id") ON DELETE RESTRICT,
    "type" VARCHAR(32) NOT NULL DEFAULT 'BIENVENIDA_VOZ' CHECK ("type"='BIENVENIDA_VOZ'),
    "source" VARCHAR(32) NOT NULL CONSTRAINT "CreditWelcomeVoiceEvent_source_check"
      CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT','CONTROLLED_TEST','SCHEDULED_CAMPAIGN')),
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "repeatOf" UUID,
    "campaignId" VARCHAR(64),
    "campaignSlot" VARCHAR(16),
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
    "communicationOutcome" VARCHAR(32),
    "disconnectionReason" VARCHAR(64),
    "resultHash" VARCHAR(64),
    CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key" UNIQUE ("creditoId","type","attemptNumber"),
    CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_key" UNIQUE ("repeatOf"),
    CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_fkey" FOREIGN KEY ("repeatOf")
      REFERENCES public."CreditWelcomeVoiceEvent"("id") ON DELETE RESTRICT,
    CONSTRAINT "CreditWelcomeVoiceEvent_campaign_member_fkey" FOREIGN KEY ("campaignId","creditoId")
      REFERENCES public."VoiceReviewCampaignMember"("campaignId","creditoId") ON DELETE RESTRICT,
    CONSTRAINT "CreditWelcomeVoiceEvent_campaign_slot_key" UNIQUE ("campaignId","creditoId","campaignSlot"),
    CONSTRAINT "CreditWelcomeVoiceEvent_attempt_check" CHECK ("attemptNumber">=0 AND
      (("source"='SCHEDULED_CAMPAIGN' AND "attemptNumber">0 AND "repeatOf" IS NULL AND "campaignId" IS NOT NULL AND "campaignSlot" IS NOT NULL) OR
       ("source"<>'SCHEDULED_CAMPAIGN' AND "campaignId" IS NULL AND "campaignSlot" IS NULL AND
        (("attemptNumber"=0 AND "repeatOf" IS NULL) OR ("attemptNumber">0 AND "source"='CONTROLLED_TEST' AND "repeatOf" IS NOT NULL)))))
  )`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "attemptNumber" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "repeatOf" UUID`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "campaignId" VARCHAR(64)`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "campaignSlot" VARCHAR(16)`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "communicationOutcome" VARCHAR(32)`,
  `ALTER TABLE public."CreditWelcomeVoiceEvent" ADD COLUMN IF NOT EXISTS "disconnectionReason" VARCHAR(64)`,
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
      AND conname='CreditWelcomeVoiceEvent_attempt_check' AND pg_get_constraintdef(oid) LIKE '%SCHEDULED_CAMPAIGN%') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" DROP CONSTRAINT IF EXISTS "CreditWelcomeVoiceEvent_attempt_check";
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_attempt_check"
        CHECK ("attemptNumber">=0 AND
          (("source"='SCHEDULED_CAMPAIGN' AND "attemptNumber">0 AND "repeatOf" IS NULL AND "campaignId" IS NOT NULL AND "campaignSlot" IS NOT NULL) OR
           ("source"<>'SCHEDULED_CAMPAIGN' AND "campaignId" IS NULL AND "campaignSlot" IS NULL AND
            (("attemptNumber"=0 AND "repeatOf" IS NULL) OR ("attemptNumber">0 AND "source"='CONTROLLED_TEST' AND "repeatOf" IS NOT NULL)))));
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass
      AND conname='CreditWelcomeVoiceEvent_source_check' AND pg_get_constraintdef(oid) LIKE '%SCHEDULED_CAMPAIGN%') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" DROP CONSTRAINT IF EXISTS "CreditWelcomeVoiceEvent_source_check";
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_source_check"
        CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT','CONTROLLED_TEST','SCHEDULED_CAMPAIGN'));
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass AND conname='CreditWelcomeVoiceEvent_campaign_member_fkey') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_campaign_member_fkey"
        FOREIGN KEY ("campaignId","creditoId") REFERENCES public."VoiceReviewCampaignMember"("campaignId","creditoId") ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass AND conname='CreditWelcomeVoiceEvent_campaign_slot_key') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_campaign_slot_key" UNIQUE ("campaignId","creditoId","campaignSlot");
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass AND conname='CreditWelcomeVoiceEvent_outcome_check') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_outcome_check"
        CHECK ("communicationOutcome" IS NULL OR "communicationOutcome" IN ('HUMAN_CONTACT','NO_ANSWER','OPT_OUT','UNCERTAIN'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public."CreditWelcomeVoiceEvent"'::regclass AND conname='CreditWelcomeVoiceEvent_reason_check') THEN
      ALTER TABLE public."CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_reason_check"
        CHECK ("disconnectionReason" IS NULL OR "disconnectionReason" ~ '^[a-z0-9_]{1,64}$');
    END IF;
  END $$`,
  `CREATE OR REPLACE FUNCTION public.voice_review_campaign_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF TG_OP='UPDATE' AND ROW(NEW."campaignId",NEW."creditoId",NEW."reviewRevision",NEW."reviewHash") IS DISTINCT FROM
      ROW(OLD."campaignId",OLD."creditoId",OLD."reviewRevision",OLD."reviewHash") THEN
      RAISE EXCEPTION 'Voice review campaign membership is immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."VoiceReviewCampaign" c WHERE c."id"=NEW."campaignId" AND c."creditIds" @> jsonb_build_array(NEW."creditoId")) THEN
      RAISE EXCEPTION 'Credit is outside the frozen voice campaign cohort';
    END IF;
    RETURN NEW;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public."VoiceReviewCampaignMember"'::regclass AND tgname='VoiceReviewCampaignMember_guard') THEN
      CREATE TRIGGER "VoiceReviewCampaignMember_guard" BEFORE INSERT OR UPDATE ON public."VoiceReviewCampaignMember"
        FOR EACH ROW EXECUTE FUNCTION public.voice_review_campaign_member_guard();
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS "VoiceReviewCampaignMember_active_idx" ON public."VoiceReviewCampaignMember" ("campaignId","state","creditoId")`,
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
