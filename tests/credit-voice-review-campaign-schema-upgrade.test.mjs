import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { creditWelcomeVoiceSchemaStatements as currentSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";

// Captured verbatim from scripts/credit-welcome-voice-schema.mjs at
// b7dc49f08a65aa53f66f7942231e66185abc545c. No Git or production access at test time.
const legacySchemaStatements = [
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


test("legacy NORMAL and controlled parent/child survive campaign upgrade and idempotent reinstall with constraints intact", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY); INSERT INTO "Credito" VALUES (1),(2),(3)');
  for (const statement of legacySchemaStatements) await db.exec(statement);
  const parentId = "11111111-1111-4111-8111-111111111111";
  const childId = "22222222-2222-4222-8222-222222222222";
  const normalId = "33333333-3333-4333-8333-333333333333";
  const insertLegacy = (id, creditId, source, attemptNumber, repeatOf, status) => db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","source","attemptNumber","repeatOf","status","snapshot","createdAt","updatedAt","dispatchedAt","completedAt","providerCallId","resultHash","identityVerifiedAt")
    VALUES ($1::uuid,$2,$3,$4,$5::uuid,$6,$7::jsonb,'2026-10-08T15:00:00Z','2026-10-08T15:02:00Z','2026-10-08T15:00:00Z','2026-10-08T15:02:00Z',$8,$9,'2026-10-08T15:01:00Z')`,
    [id, creditId, source, attemptNumber, repeatOf, status, JSON.stringify({ creditId, initialPayment: 200,
      installmentAmounts: [100, 100, 100], calendar: ["2026-10-17", "2026-11-02", "2026-11-17"] }), `call-fixture-${id}`, "a".repeat(64)]);
  await insertLegacy(parentId, 1, "CONTROLLED_TEST", 0, null, "COMPLETED");
  await insertLegacy(childId, 1, "CONTROLLED_TEST", 1, parentId, "COMPLETED");
  await insertLegacy(normalId, 2, "NORMAL", 0, null, "ACCEPTED");
  const read = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId","attemptNumber"').then(result => result.rows);
  const before = await read();
  for (let run = 0; run < 2; run++) {
    for (const statement of currentSchemaStatements) await db.exec(statement);
  }
  const after = await read();
  assert.equal(after.length, before.length);
  after.forEach((row, index) => {
    assert.deepEqual(Object.fromEntries(Object.keys(before[index]).map(key => [key, row[key]])), before[index]);
    for (const column of ["campaignId", "campaignSlot", "communicationOutcome", "disconnectionReason"]) assert.equal(row[column], null);
  });
  await assert.rejects(db.query('DELETE FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid', [parentId]));
  await assert.rejects(db.query(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","repeatOf","status")
    VALUES ('44444444-4444-4444-8444-444444444444',1,'CONTROLLED_TEST',2,$1::uuid,'PENDING')`, [parentId]));
  await assert.rejects(db.exec(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","status")
    VALUES ('44444444-4444-4444-8444-444444444444',1,'NORMAL',0,'PENDING')`));
  await db.exec(`INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES ('frozen','2026-10-09','[1]'::jsonb);
    INSERT INTO "VoiceReviewCampaignMember" ("campaignId","creditoId","reviewRevision","reviewHash") VALUES ('frozen',1,1,'fixture-hash');`);
  const insertCampaign = (id, creditId, attemptNumber, slot, repeatOf = null) => db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","source","attemptNumber","repeatOf","campaignId","campaignSlot","status")
    VALUES ($1::uuid,$2,'SCHEDULED_CAMPAIGN',$3,$4::uuid,'frozen',$5,'DISPATCHING')`, [id, creditId, attemptNumber, repeatOf, slot]);
  await assert.rejects(insertCampaign("44444444-4444-4444-8444-444444444444", 3, 1, "2026-10-09T08:00"), /foreign key/);
  await assert.rejects(insertCampaign("44444444-4444-4444-8444-444444444444", 1, 2, null), /check constraint/);
  await assert.rejects(insertCampaign("44444444-4444-4444-8444-444444444444", 1, 2, "2026-10-09T08:00", childId), /check constraint/);
  await insertCampaign("44444444-4444-4444-8444-444444444444", 1, 2, "2026-10-09T08:00");
  await assert.rejects(insertCampaign("55555555-5555-4555-8555-555555555555", 1, 3, "2026-10-09T08:00"), /unique constraint/);
  const final = await read();
  assert.equal(final.length, 4);
  for (const row of final.filter(row => row.source !== "SCHEDULED_CAMPAIGN")) {
    const original = before.find(value => value.id === row.id);
    assert.deepEqual(Object.fromEntries(Object.keys(original).map(key => [key, row[key]])), original);
  }
});
