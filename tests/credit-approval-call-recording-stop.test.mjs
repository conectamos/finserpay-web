import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { loadCallModule, errors, actors, files, stateModule, tone } from "./credit-approval-call-test-loader.mjs";

const recordingStop = loadCallModule("lib/credit-welcome-voice-recording.ts");
const actor = { id: 12, nombre: "Analista sintético" };
const sources = ["NORMAL", "INDIVIDUAL_IMPORT", "AUTOMATIC_RETRY", "SCHEDULED_CAMPAIGN", "OPERATOR_REQUEST", "CONTROLLED_TEST"];

async function fixture(t, { voiceTables = ["followup", "members", "events"] } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" integer PRIMARY KEY,"contract" jsonb NOT NULL);
    CREATE TABLE "CreditApprovalReview" ("creditoId" integer PRIMARY KEY REFERENCES "Credito","revision" integer,"status" text);
    CREATE TABLE "CreditApprovalCallRecording" (
      "id" uuid PRIMARY KEY,"creditoId" integer REFERENCES "Credito","revision" integer NOT NULL,"reviewHash" text NOT NULL,
      "fileName" text NOT NULL,"mimeType" text NOT NULL,"sizeBytes" integer NOT NULL,"sha256" text NOT NULL,"bytes" bytea NOT NULL,
      "createdAt" timestamp(3) NOT NULL,"actorUserId" integer,"actorName" text NOT NULL,"actorKind" text NOT NULL,
      "actorGrantId" uuid,"actorSessionId" uuid,"idempotencyKey" uuid UNIQUE NOT NULL);
    CREATE FUNCTION public.credit_approval_effective_call_recording(integer,integer,text) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
    INSERT INTO "Credito" VALUES (81,'{"signed":"original"}'),(82,'{"signed":"other"}');
    INSERT INTO "CreditApprovalReview" VALUES (81,1,'PENDING'),(82,1,'PENDING');`);
  if (voiceTables.includes("followup")) await db.exec(`CREATE TABLE "CreditWelcomeVoiceFollowup" (
    "creditoId" integer PRIMARY KEY,"phase" text,"reason" text,"nextAttemptAt" timestamptz,"updatedAt" timestamptz);
    INSERT INTO "CreditWelcomeVoiceFollowup" VALUES (81,'FAST',NULL,'2026-10-17T17:30:00Z',NULL),(82,'PENDING',NULL,'2026-10-17T17:30:00Z',NULL);`);
  if (voiceTables.includes("members")) await db.exec(`CREATE TABLE "VoiceReviewCampaignMember" (
    "campaignId" uuid,"creditoId" integer,"state" text,"stopReason" text,"updatedAt" timestamptz,PRIMARY KEY ("campaignId","creditoId"));
    INSERT INTO "VoiceReviewCampaignMember" VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',81,'ACTIVE',NULL,NULL),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',81,'HELD',NULL,NULL),
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',82,'ACTIVE',NULL,NULL);`);
  if (voiceTables.includes("events")) await db.exec(`CREATE TABLE "CreditWelcomeVoiceEvent" (
    "id" uuid PRIMARY KEY,"creditoId" integer,"source" text,"status" text,"resultCode" text,"updatedAt" timestamptz,
    "identityVerifiedAt" timestamptz,"termsConfirmed" boolean,"recordingUrl" text);`);
  const detail = { review: { revision: 1, reviewHash: "a".repeat(64), required: false, status: "PENDING" },
    capabilities: { canCorrectEvidence: true, correctionBlockedReason: null }, callRecording: { available: true, canUpload: true } };
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows,
  });
  const store = loadCallModule("lib/credit-approval-call-store.ts", {
    "@/lib/credit-approval": { getCreditApprovalDetail: async () => detail },
    "@/lib/credit-approval-errors": errors, "@/lib/credit-approval-actor": actors,
    "@/lib/credit-approval-call-state": stateModule, "@/lib/credit-welcome-voice-recording": recordingStop,
  });
  const transact = work => db.transaction(connection => work(adapter(connection)));
  const upload = (input, creditId = 81, currentActor = actor) => transact(tx => store.saveCreditApprovalCall(tx, creditId, input, currentActor));
  const event = async (creditId = 81, source = "NORMAL", status = "PENDING") => {
    const id = randomUUID();
    await db.query('INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","status","recordingUrl") VALUES ($1,$2,$3,$4,$5)',
      [id, creditId, source, status, "https://recordings.invalid/provider-only"]);
    return id;
  };
  const events = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "id"').then(result => result.rows);
  const file = { ...await files.prepareApprovalCallFile(tone(), "llamada.wav"), revision: 1, reviewHash: "a".repeat(64), idempotencyKey: randomUUID() };
  return { db, adapter, store, transact, upload, event, events, detail, file };
}

test("valid optional recording atomically stops only this credit's pending automatic calls without approving it", async t => {
  const f = await fixture(t);
  const automatic = await Promise.all(sources.slice(0, 4).map(source => f.event(81, source)));
  const preserved = await Promise.all([
    f.event(81, "OPERATOR_REQUEST"), f.event(81, "CONTROLLED_TEST"), f.event(82),
    ...["DISPATCHING", "ACCEPTED", "UNKNOWN", "COMPLETED"].map(status => f.event(81, "NORMAL", status)),
  ]);
  const before = (await f.events()).filter(row => preserved.includes(row.id));
  const result = await f.upload(f.file);
  assert.equal(result.unchanged, false); assert.equal(result.state.recording.sha256, f.file.sha256);
  const rows = await f.events();
  assert.ok(rows.filter(row => automatic.includes(row.id)).every(row => row.status === "CANCELLED" && row.resultCode === "CALL_RECORDING_SAVED"));
  assert.deepEqual(rows.filter(row => preserved.includes(row.id)), before);
  assert.ok(rows.every(row => row.identityVerifiedAt === null && row.termsConfirmed === null));
  const followups = (await f.db.query('SELECT * FROM "CreditWelcomeVoiceFollowup" ORDER BY "creditoId"')).rows;
  assert.equal(followups[0].phase, "STOPPED"); assert.equal(followups[0].reason, "CALL_RECORDING_SAVED"); assert.equal(followups[0].nextAttemptAt, null);
  assert.equal(followups[1].phase, "PENDING"); assert.equal(followups[1].reason, null);
  const members = (await f.db.query('SELECT * FROM "VoiceReviewCampaignMember"')).rows;
  assert.ok(members.filter(row => row.creditoId === 81).every(row => row.state === "STOPPED" && row.stopReason === "CALL_RECORDING_SAVED"));
  assert.equal(members.find(row => row.creditoId === 82).state, "ACTIVE");
  assert.deepEqual((await f.db.query('SELECT "revision","status" FROM "CreditApprovalReview" WHERE "creditoId"=81')).rows[0], { revision: 1, status: "PENDING" });
  assert.deepEqual((await f.db.query('SELECT "contract" FROM "Credito" WHERE "id"=81')).rows[0].contract, { signed: "original" });
});

test("matching replay cleans up newly pending calls even after review changed; conflicting replay never does", async t => {
  const f = await fixture(t);
  const saved = await f.upload(f.file);
  f.detail.review.revision = 2; f.detail.review.reviewHash = "b".repeat(64); f.detail.callRecording.canUpload = false;
  await f.db.query('UPDATE "CreditApprovalReview" SET "revision"=2 WHERE "creditoId"=81');
  const pending = await f.event();
  for (const [input, creditId, currentActor] of [
    [{ ...f.file, revision: 2 }, 81, actor], [{ ...f.file, fileName: "otro.wav" }, 81, actor],
    [f.file, 82, actor], [f.file, 81, { id: 13, nombre: "Otro actor" }],
  ]) await assert.rejects(f.upload(input, creditId, currentActor), { code: "CALL_RECORDING_KEY_CONFLICT" });
  assert.equal((await f.events()).find(row => row.id === pending).status, "PENDING");
  const replay = await f.upload(f.file);
  assert.equal(replay.unchanged, true); assert.equal(replay.state.recording.id, saved.state.recording.id);
  assert.equal((await f.events()).find(row => row.id === pending).status, "CANCELLED");
  assert.equal((await f.db.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 1);
});

test("rejected upload leaves automatic calls active and creates no recording", async t => {
  const f = await fixture(t); const pending = await f.event();
  await assert.rejects(f.upload({ ...f.file, revision: 2 }), { code: "REVIEW_CHANGED" });
  f.detail.callRecording.canUpload = false;
  await assert.rejects(f.upload(f.file), { code: "CALL_RECORDING_NOT_ALLOWED" });
  f.detail.callRecording.available = false;
  await assert.rejects(f.upload(f.file), { code: "CALL_RECORDING_UNAVAILABLE" });
  assert.equal((await f.events()).find(row => row.id === pending).status, "PENDING");
  assert.equal((await f.db.query('SELECT "phase" FROM "CreditWelcomeVoiceFollowup" WHERE "creditoId"=81')).rows[0].phase, "FAST");
  assert.equal((await f.db.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 0);
});

test("caller rollback restores both recording and automatic queues before safe retry", async t => {
  const f = await fixture(t); const pending = await f.event();
  await assert.rejects(f.transact(async tx => {
    await f.store.saveCreditApprovalCall(tx, 81, f.file, actor);
    assert.equal((await tx.$queryRawUnsafe('SELECT "status" FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1', pending))[0].status, "CANCELLED");
    throw Error("Synthetic caller rollback");
  }), /Synthetic caller rollback/);
  assert.equal((await f.events()).find(row => row.id === pending).status, "PENDING");
  assert.equal((await f.db.query('SELECT "phase" FROM "CreditWelcomeVoiceFollowup" WHERE "creditoId"=81')).rows[0].phase, "FAST");
  assert.equal((await f.db.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 0);
  await f.upload(f.file);
  assert.equal((await f.events()).find(row => row.id === pending).status, "CANCELLED");
});

test("uploads and replay work with absent or partial voice schema; provider links alone do not stop calls", async t => {
  for (const voiceTables of [[], ["followup"], ["members"], ["events"]]) {
    await t.test(voiceTables.join("+") || "no voice tables", async st => {
      const f = await fixture(st, { voiceTables });
      if (voiceTables.includes("events")) {
        await f.event();
        await f.transact(tx => recordingStop.stopAutomaticCreditWelcomeCallsForRecording(tx, 81, new Date()));
        assert.equal((await f.events())[0].status, "PENDING", "un enlace del proveedor no es un archivo manual guardado");
      }
      const first = await f.upload(f.file), replay = await f.upload(f.file);
      assert.equal(first.unchanged, false); assert.equal(replay.unchanged, true);
      assert.equal(replay.state.recording.id, first.state.recording.id);
      assert.equal((await f.db.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 1);
    });
  }
});
