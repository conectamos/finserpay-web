import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const recording = loadReissueModule("lib/credit-welcome-voice-recording.ts");
const now = new Date("2026-10-17T17:00:00.000Z");
const adapter = connection => ({
  $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
  $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows,
});

test("human welcome gates use only real welcome case results; opt-out prevails without fabricating provider evidence", async t => {
  const db = new PGlite(); t.after(() => db.close()); const client = adapter(db);
  assert.equal(await recording.readSavedHumanWelcomeOutcome(client, 1), null);
  await db.exec(`CREATE TABLE "AttentionWorkRequest" (kind text,"targetSource" text,"targetId" integer,"conversationId" integer);
    CREATE TABLE "AttentionAudit" ("conversationId" integer,action text,metadata jsonb);
    INSERT INTO "AttentionWorkRequest" VALUES ('welcome','C',1,1),('enrollment','C',2,2),('welcome','D',3,3);`);
  const add = (conversation, mode, outcome, action = "WELCOME_RESULT") => db.query('INSERT INTO "AttentionAudit" VALUES ($1,\'WORK_WORKFLOW\',$2::jsonb)', [conversation, JSON.stringify({ result: { action, mode, outcome } })]);
  await add(1, "human", "NO_ANSWER"); await add(1, "human", "UNCERTAIN"); await add(1, "dapta", "OPT_OUT");
  await add(1, "human", "OPT_OUT", "WELCOME_RECORDING"); await add(2, "human", "OPT_OUT"); await add(3, "human", "OPT_OUT");
  for (const id of [1, 2, 3, 4]) assert.equal(await recording.readSavedHumanWelcomeOutcome(client, id), null);
  await add(1, "human", "HUMAN_CONTACT"); assert.equal(await recording.readSavedHumanWelcomeOutcome(client, 1), "HUMAN_CONTACT");
  await add(1, "human", "OPT_OUT"); await add(1, "human", "HUMAN_CONTACT");
  assert.equal(await recording.readSavedHumanWelcomeOutcome(client, 1), "OPT_OUT");
});

test("only a saved approval recording row is evidence, regardless of revision, and old schemas remain safe", async t => {
  const db = new PGlite(); t.after(() => db.close());
  const client = adapter(db);
  assert.equal(await recording.hasSavedCreditApprovalCallRecording(client, 1), false);
  for (const id of [0, -1, 1.5, NaN, 2_147_483_648, "1"]) {
    assert.equal(await recording.hasSavedCreditApprovalCallRecording({
      $queryRawUnsafe: () => assert.fail("Invalid IDs must not query the database"),
    }, id), false);
  }
  await db.exec('CREATE TABLE "CreditApprovalCallRecording" ("creditoId" integer,"revision" integer,"bytes" bytea)');
  await db.query('INSERT INTO "CreditApprovalCallRecording" VALUES (1,1,$1)', [new Uint8Array([1, 2, 3])]);
  assert.equal(await recording.hasSavedCreditApprovalCallRecording(client, 1), true);
  assert.equal(await recording.hasSavedCreditApprovalCallRecording(client, 2), false);
  // Uploads can run before the optional voice/campaign tables have been installed.
  await recording.stopAutomaticCreditWelcomeCallsForRecording(client, 1, now);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 1);
});

test("recording cleanup stops queued automation only and preserves every possibly dispatched call and explicit request", async t => {
  const db = new PGlite(); t.after(() => db.close());
  const client = adapter(db);
  await db.exec(`CREATE TABLE "CreditApprovalCallRecording" ("creditoId" integer);
    CREATE TABLE "CreditWelcomeVoiceFollowup" ("creditoId" integer PRIMARY KEY,"phase" text,"reason" text,"nextAttemptAt" timestamptz,"updatedAt" timestamptz);
    CREATE TABLE "VoiceReviewCampaignMember" ("campaignId" text,"creditoId" integer,"state" text,"stopReason" text,"updatedAt" timestamptz,PRIMARY KEY("campaignId","creditoId"));
    CREATE TABLE "CreditWelcomeVoiceEvent" ("id" integer PRIMARY KEY,"creditoId" integer,"source" text,"status" text,"resultCode" text,"updatedAt" timestamptz);
    INSERT INTO "CreditApprovalCallRecording" VALUES(1);
    INSERT INTO "CreditWelcomeVoiceFollowup" VALUES(1,'PENDING',NULL,now(),NULL),(2,'FAST',NULL,now(),NULL);
    INSERT INTO "VoiceReviewCampaignMember" VALUES('one',1,'ACTIVE',NULL,NULL),('two',1,'HELD','OLD_HOLD',NULL),('done',1,'CONTACTED','REAL_CONTACT',NULL),('other',2,'ACTIVE',NULL,NULL),('excluded',1,'HELD','OPERATOR_EXCLUDED',NULL);`);
  const sources = ["NORMAL", "INDIVIDUAL_IMPORT", "AUTOMATIC_RETRY", "SCHEDULED_CAMPAIGN", "OPERATOR_REQUEST", "CONTROLLED_TEST"];
  let id = 0;
  for (const source of sources) await db.query('INSERT INTO "CreditWelcomeVoiceEvent" VALUES($1,1,$2,\'PENDING\',NULL,NULL)', [++id, source]);
  for (const status of ["DISPATCHING", "ACCEPTED", "UNKNOWN", "COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]) {
    await db.query('INSERT INTO "CreditWelcomeVoiceEvent" VALUES($1,1,\'NORMAL\',$2,\'ORIGINAL_EVIDENCE\',NULL)', [++id, status]);
  }
  await db.query('INSERT INTO "CreditWelcomeVoiceEvent" VALUES($1,2,\'NORMAL\',\'PENDING\',NULL,NULL)', [++id]);
  const read = async () => ({
    followups: (await db.query('SELECT * FROM "CreditWelcomeVoiceFollowup" ORDER BY "creditoId"')).rows,
    members: (await db.query('SELECT * FROM "VoiceReviewCampaignMember" ORDER BY "campaignId"')).rows,
    events: (await db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "id"')).rows,
  });
  const before = await read();
  await db.transaction(tx => recording.stopAutomaticCreditWelcomeCallsForRecording(adapter(tx), 1, now));
  const after = await read();
  assert.equal(after.followups[0].phase, "STOPPED");
  assert.equal(after.followups[0].reason, "CALL_RECORDING_SAVED");
  assert.equal(after.followups[0].nextAttemptAt, null);
  assert.deepEqual(after.followups[1], before.followups[1]);
  for (const member of after.members.filter(row => ["one", "two"].includes(row.campaignId))) {
    assert.equal(member.state, "STOPPED"); assert.equal(member.stopReason, "CALL_RECORDING_SAVED");
  }
  assert.deepEqual(after.members.filter(row => ["done", "other", "excluded"].includes(row.campaignId)), before.members.filter(row => ["done", "other", "excluded"].includes(row.campaignId)));
  for (const event of after.events.slice(0, 4)) {
    assert.equal(event.status, "CANCELLED"); assert.equal(event.resultCode, "CALL_RECORDING_SAVED");
  }
  assert.deepEqual(after.events.slice(4), before.events.slice(4));
  await recording.stopAutomaticCreditWelcomeCallsForRecording(client, 1, now);
  assert.deepEqual(await read(), after, "Cleanup is idempotent and never rewrites terminal or explicit history");
});

test("recording and queue cleanup roll back together, without blocking a credit that has no saved recording", async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "CreditApprovalCallRecording" ("creditoId" integer);
    CREATE TABLE "CreditWelcomeVoiceFollowup" ("creditoId" integer PRIMARY KEY,"phase" text,"reason" text,"nextAttemptAt" timestamptz,"updatedAt" timestamptz);
    INSERT INTO "CreditWelcomeVoiceFollowup" VALUES(1,'FAST',NULL,now(),NULL);`);
  const original = (await db.query('SELECT * FROM "CreditWelcomeVoiceFollowup"')).rows;
  await recording.stopAutomaticCreditWelcomeCallsForRecording(adapter(db), 1, now);
  assert.deepEqual((await db.query('SELECT * FROM "CreditWelcomeVoiceFollowup"')).rows, original);
  await assert.rejects(db.transaction(async tx => {
    await tx.query('INSERT INTO "CreditApprovalCallRecording" VALUES(1)');
    await recording.stopAutomaticCreditWelcomeCallsForRecording(adapter(tx), 1, now);
    assert.equal((await tx.query('SELECT "phase" FROM "CreditWelcomeVoiceFollowup"')).rows[0].phase, "STOPPED");
    throw new Error("Synthetic upload rollback");
  }), /Synthetic upload rollback/);
  assert.equal(await recording.hasSavedCreditApprovalCallRecording(adapter(db), 1), false);
  assert.deepEqual((await db.query('SELECT * FROM "CreditWelcomeVoiceFollowup"')).rows, original);
});
