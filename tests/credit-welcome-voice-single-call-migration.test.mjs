import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  creditWelcomeVoiceSchemaStatements,
  creditWelcomeVoiceSingleCallCleanupStatements,
  installCreditWelcomeVoiceSchema,
} from "../scripts/credit-welcome-voice-schema.mjs";

const at = "2026-10-01T15:00:00.000Z";
const zero = { followupsStopped: 0, campaignMembersStopped: 0, pendingEventsCancelled: 0,
  followupsRemaining: 0, campaignMembersRemaining: 0, pendingRetriesRemaining: 0 };

async function fixture(t, count = 14) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" integer PRIMARY KEY)');
  for (let id = 1; id <= count; id++) await db.query('INSERT INTO "Credito" VALUES($1)', [id]);
  // Model the deployed schema with its historical rows, before this policy migration.
  for (const sql of creditWelcomeVoiceSchemaStatements) {
    if (!creditWelcomeVoiceSingleCallCleanupStatements.includes(sql)) await db.exec(sql);
  }
  for (const campaign of ["synthetic-a", "synthetic-b"]) await db.query(
    'INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES($1,\'2026-10-01\',$2::jsonb)',
    [campaign, JSON.stringify(Array.from({ length: count }, (_, index) => index + 1))]);
  let sequence = 0;
  const event = async (creditoId, fields = {}) => {
    const id = `11111111-1111-4111-8111-${String(++sequence).padStart(12, "0")}`;
    const row = { id, creditoId, source: "NORMAL", attemptNumber: 0, status: "PENDING",
      snapshot: { synthetic: true }, createdAt: at, updatedAt: at, ...fields };
    const keys = Object.keys(row);
    await db.query(`INSERT INTO "CreditWelcomeVoiceEvent" (${keys.map(key => `"${key}"`).join(",")})
      VALUES(${keys.map((_, index) => "$" + (index + 1)).join(",")})`,
    keys.map(key => key === "snapshot" ? JSON.stringify(row[key]) : row[key]));
    return id;
  };
  const followup = async (creditoId, initial, fields = {}) => {
    const row = { creditoId, initialEventId: initial, lastEventId: initial, phase: "FAST", fastAttempts: 0,
      nextAttemptAt: at, createdAt: at, updatedAt: at, ...fields };
    const keys = Object.keys(row);
    await db.query(`INSERT INTO "CreditWelcomeVoiceFollowup" (${keys.map(key => `"${key}"`).join(",")})
      VALUES(${keys.map((_, index) => "$" + (index + 1)).join(",")})`, keys.map(key => row[key]));
  };
  const member = (creditoId, fields = {}) => {
    const row = { campaignId: "synthetic-a", creditoId, state: "ACTIVE", updatedAt: at, ...fields };
    const keys = Object.keys(row);
    return db.query(`INSERT INTO "VoiceReviewCampaignMember" (${keys.map(key => `"${key}"`).join(",")})
      VALUES(${keys.map((_, index) => "$" + (index + 1)).join(",")})`, keys.map(key => row[key]));
  };
  const read = async () => ({
    events: (await db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "id"')).rows,
    followups: (await db.query('SELECT * FROM "CreditWelcomeVoiceFollowup" ORDER BY "creditoId"')).rows,
    members: (await db.query('SELECT * FROM "VoiceReviewCampaignMember" ORDER BY "campaignId","creditoId"')).rows,
  });
  const install = async ({ failAfterCleanup = false } = {}) => installCreditWelcomeVoiceSchema({ query: async sql => {
    // PGlite does not implement advisory locking. All schema and cleanup SQL is real PostgreSQL.
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (failAfterCleanup && sql.startsWith("SELECT\n  (SELECT COUNT")) throw new Error("Synthetic rollback check");
    const result = await db.query(sql);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  } });
  return { db, event, followup, member, read, install };
}

test("single-call upgrade retires retry queues but preserves first unsent/claimed calls and all provider history", async t => {
  const f = await fixture(t);
  const first = await f.event(1, { status: "COMPLETED", providerCallId: "call-synthetic-1", resultHash: "a".repeat(64),
    completedAt: at, communicationOutcome: "NO_ANSWER", transcript: "Synthetic historical transcript" });
  const retry = await f.event(1, { source: "AUTOMATIC_RETRY", attemptNumber: 1, retryPhase: "FAST" });
  await f.followup(1, first, { lastEventId: retry, fastAttempts: 1 }); await f.member(1);
  const unsent = await f.event(2); await f.followup(2, unsent); await f.member(2);
  const accepted = await f.event(3, { source: "INDIVIDUAL_IMPORT", status: "ACCEPTED", acceptedAt: at });
  await f.followup(3, accepted, { fastAttempts: 1 });
  const unknown = await f.event(4, { status: "UNKNOWN" });
  await f.followup(4, unknown, { phase: "HELD", reason: "UNKNOWN_CALL" });
  const claimed = await f.event(5, { status: "DISPATCHING", dispatchedAt: at }); await f.followup(5, claimed);
  await f.member(6); const firstScheduled = await f.event(6, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 9,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  await f.member(7); const claimedScheduled = await f.event(7, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 7,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00", status: "DISPATCHING", dispatchedAt: at });
  await f.event(8, { source: "CONTROLLED_TEST", status: "COMPLETED", resultHash: "b".repeat(64) }); await f.member(8);
  const afterTest = await f.event(8, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 2,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  await f.event(9, { source: "OPERATOR_REQUEST", attemptNumber: 1, status: "COMPLETED", providerCallId: "call-synthetic-manual" });
  const afterManual = await f.event(9); await f.followup(9, afterManual);
  const contacted = await f.event(10, { status: "COMPLETED", identityVerifiedAt: at });
  await f.followup(10, contacted, { phase: "CONTACTED", reason: "HUMAN_CONTACT" });
  const recorded = await f.event(11, { status: "COMPLETED" });
  await f.followup(11, recorded, { phase: "STOPPED", reason: "CALL_RECORDING_SAVED" });
  await f.member(11, { state: "HELD", stopReason: "OPERATOR_EXCLUDED" });
  await f.event(12, { status: "FAILED" }); await f.member(12, { state: "HELD", stopReason: "UNCERTAIN_RESULT" });
  const scheduledRetry = await f.event(12, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 1,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  const prior13 = await f.event(13, { status: "COMPLETED" });
  const activeRetry = await f.event(13, { source: "AUTOMATIC_RETRY", attemptNumber: 1, retryPhase: "FAST", status: "DISPATCHING", dispatchedAt: at });
  await f.followup(13, prior13, { lastEventId: activeRetry, fastAttempts: 1 });
  const prior14 = await f.event(14, { status: "COMPLETED" });
  const ambiguousPending = await f.event(14, { source: "AUTOMATIC_RETRY", attemptNumber: 1, retryPhase: "FAST", providerCallId: "call-synthetic-inconsistent" });
  await f.followup(14, prior14, { lastEventId: ambiguousPending, fastAttempts: 1 });
  const before = await f.read();
  assert.deepEqual(await f.install(), { ...zero, followupsStopped: 5, campaignMembersStopped: 3, pendingEventsCancelled: 2 });
  const after = await f.read();
  assert.equal(after.events.length, before.events.length);
  for (const row of after.events) {
    const original = before.events.find(item => item.id === row.id);
    if ([retry, scheduledRetry].includes(row.id)) {
      assert.equal(row.status, "CANCELLED"); assert.equal(row.resultCode, "AUTOMATIC_CALL_LIMIT_REACHED");
      assert.deepEqual({ ...row, status: original.status, resultCode: original.resultCode, updatedAt: original.updatedAt }, original);
    } else assert.deepEqual(row, original, "No active, uncertain, historical or explicit event may change");
  }
  for (const id of [2, 5, 9, 10, 11]) assert.deepEqual(after.followups.find(row => row.creditoId === id), before.followups.find(row => row.creditoId === id));
  for (const id of [1, 3, 4, 13, 14]) {
    const row = after.followups.find(item => item.creditoId === id);
    assert.equal(row.phase, "STOPPED"); assert.equal(row.reason, "AUTOMATIC_CALL_LIMIT_REACHED"); assert.equal(row.nextAttemptAt, null);
  }
  for (const id of [6, 7, 8, 11]) assert.deepEqual(after.members.find(row => row.creditoId === id), before.members.find(row => row.creditoId === id));
  for (const id of [unsent, claimed, firstScheduled, claimedScheduled, afterTest, afterManual, activeRetry, ambiguousPending]) {
    assert.deepEqual(after.events.find(row => row.id === id), before.events.find(row => row.id === id));
  }
  assert.deepEqual(await f.install(), zero);
  assert.deepEqual(await f.read(), after, "A second installer must not rewrite timestamps or history");
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=\'COMPLETED\',"resultHash"=$2 WHERE "id"=$1', [unknown, "c".repeat(64)]);
  assert.deepEqual(await f.install(), zero, "A late authenticated callback cannot restart the retired stream");
  assert.equal((await f.read()).followups.find(row => row.creditoId === 4).phase, "STOPPED");
});

test("redundant unsent scheduled events yield to the real initial or earliest scheduled event, not attemptNumber", async t => {
  const f = await fixture(t, 3);
  const initial = await f.event(1); await f.followup(1, initial); await f.member(1);
  const redundant = await f.event(1, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 1,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  await f.member(2); await f.member(2, { campaignId: "synthetic-b" });
  const first = await f.event(2, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 20,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  const second = await f.event(2, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 2,
    campaignId: "synthetic-b", campaignSlot: "2026-10-01T14:00", createdAt: "2026-10-01T16:00:00Z" });
  await f.member(3);
  const sameCampaignFirst = await f.event(3, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 4,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T10:00" });
  const sameCampaignSecond = await f.event(3, { source: "SCHEDULED_CAMPAIGN", attemptNumber: 5,
    campaignId: "synthetic-a", campaignSlot: "2026-10-01T14:00" });
  assert.deepEqual(await f.install(), { ...zero, campaignMembersStopped: 2, pendingEventsCancelled: 3 });
  const state = await f.read();
  for (const id of [initial, first, sameCampaignFirst]) assert.equal(state.events.find(row => row.id === id).status, "PENDING");
  for (const id of [redundant, second, sameCampaignSecond]) assert.equal(state.events.find(row => row.id === id).status, "CANCELLED");
  assert.equal(state.members.find(row => row.creditoId === 2 && row.campaignId === "synthetic-a").state, "ACTIVE");
  assert.equal(state.members.find(row => row.creditoId === 2 && row.campaignId === "synthetic-b").state, "STOPPED");
  assert.equal(state.followups[0].phase, "FAST");
  assert.deepEqual(await f.install(), zero);
});

test("an installer failure after cleanup rolls back every state change before a later safe rerun", async t => {
  const f = await fixture(t, 1);
  const initial = await f.event(1, { status: "COMPLETED" });
  const retry = await f.event(1, { source: "AUTOMATIC_RETRY", attemptNumber: 1, retryPhase: "FAST" });
  await f.followup(1, initial, { lastEventId: retry, fastAttempts: 1 }); await f.member(1);
  const before = await f.read();
  await assert.rejects(f.install({ failAfterCleanup: true }), /Synthetic rollback check/);
  assert.deepEqual(await f.read(), before);
  assert.deepEqual(await f.install(), { ...zero, followupsStopped: 1, campaignMembersStopped: 1, pendingEventsCancelled: 1 });
});
