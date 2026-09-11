import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { loadCallModule, errors, actors, files, tone, stateModule } from "./credit-approval-call-test-loader.mjs";

// Storage SQL verification only. TEMP tables do not install or test deployment guards.
const connectionString = process.env.CREDIT_APPROVAL_CALL_TEST_DATABASE_URL;
if (connectionString) {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/approval_call_test");
}
pg.types.setTypeParser(1114, value => new Date(`${value.replace(" ", "T")}Z`));

test("call storage queries against isolated PostgreSQL TEMP tables", { skip: !connectionString }, async t => {
  const client = new pg.Client({ connectionString }); await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE "Aliado" ("id" integer PRIMARY KEY,"codigo" text NOT NULL);
      CREATE TEMP TABLE "Sede" ("id" integer PRIMARY KEY,"aliadoId" integer NOT NULL);
      CREATE TEMP TABLE "Credito" ("id" integer PRIMARY KEY,"sedeId" integer NOT NULL,"contract" jsonb NOT NULL);
      CREATE TEMP TABLE "CreditApprovalReview" ("creditoId" integer PRIMARY KEY,"revision" integer,"status" text);
      CREATE TEMP TABLE "CreditApprovalCallRecording" (
        "id" uuid PRIMARY KEY,"creditoId" integer NOT NULL,"revision" integer NOT NULL,"reviewHash" text NOT NULL,
        "fileName" text NOT NULL,"mimeType" text NOT NULL,"sizeBytes" integer NOT NULL,"sha256" text NOT NULL,"bytes" bytea NOT NULL,
        "createdAt" timestamp(3) NOT NULL,"actorUserId" integer,"actorName" text NOT NULL,"actorKind" text NOT NULL,
        "actorGrantId" uuid,"actorSessionId" uuid,"idempotencyKey" uuid UNIQUE NOT NULL);
      INSERT INTO "Aliado" VALUES (1,'ALLY_TEST'); INSERT INTO "Sede" VALUES (1,1);
      INSERT INTO "Credito" VALUES (81,1,'{"signed":"original","principal":800000}'),(82,1,'{"signed":"other"}');
      INSERT INTO "CreditApprovalReview" VALUES (81,1,'PENDING'),(82,1,'PENDING');`);
    const db = {
      $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
      $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
    };
    const detail = { review: { revision: 1, reviewHash: "a".repeat(64), required: true, status: "PENDING" },
      capabilities: { canCorrectEvidence: true, correctionBlockedReason: null }, callRecording: { available: true } };
    const store = loadCallModule("lib/credit-approval-call-store.ts", {
      "@/lib/credit-approval": { getCreditApprovalDetail: async () => detail },
      "@/lib/credit-approval-errors": errors, "@/lib/credit-approval-actor": actors, "@/lib/credit-approval-call-state": stateModule,
    });
    const transact = async fn => { await client.query("BEGIN"); try { const result = await fn(); await client.query("COMMIT"); return result; } catch (error) { await client.query("ROLLBACK"); throw error; } };
    const input = { ...await files.prepareApprovalCallFile(tone(), "llamada.wav"), revision: 1, reviewHash: detail.review.reviewHash, idempotencyKey: randomUUID() };
    const actor = { id: 12, nombre: "Analista de prueba" };
    let first;
    await t.test("bytea, metadata and private lookup preserve exact uploaded content", async () => {
      first = await transact(() => store.saveCreditApprovalCall(db, 81, input, actor));
      assert.equal(first.unchanged, false); assert.equal(first.state.recording.sizeBytes, tone().length);
      assert.equal(first.state.recording.sha256, input.sha256);
      const audio = await store.readCreditApprovalCallBytes(db, 81, first.state.recording.id);
      assert.ok(audio.bytes.equals(tone())); assert.equal(audio.mimeType, "audio/wav");
      const raw = (await client.query('SELECT octet_length("bytes") AS size,"actorUserId","actorKind" FROM "CreditApprovalCallRecording"')).rows[0];
      assert.equal(raw.size, tone().length); assert.equal(raw.actorUserId, 12); assert.equal(raw.actorKind, "USER");
    });
    await t.test("repeated action keeps one row and rejects rebinding the key", async () => {
      const retried = await transact(() => store.saveCreditApprovalCall(db, 81, input, actor));
      assert.equal(retried.unchanged, true); assert.equal(retried.state.recording.id, first.state.recording.id);
      await assert.rejects(transact(() => store.saveCreditApprovalCall(db, 82, input, actor)), e => e.code === "CALL_RECORDING_KEY_CONFLICT");
      assert.equal((await client.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording"')).rows[0].count, 1);
    });
    await t.test("another recording is appended and selected while old bytes remain available", async () => {
      const second = await transact(() => store.saveCreditApprovalCall(db, 81, { ...input, fileName: "segunda.wav", idempotencyKey: randomUUID() }, actor));
      const current = await stateModule.readCreditApprovalCallState(db, 81, 1, detail.review.reviewHash);
      assert.equal(current.recording.id, second.state.recording.id);
      assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 1, detail.review.reviewHash, first.state.recording.id)).recording.id, first.state.recording.id);
      assert.ok((await store.readCreditApprovalCallBytes(db, 81, first.state.recording.id)).bytes.equals(tone()));
    });
    await t.test("revision/hash and credit scope exclude stale or foreign audio", async () => {
      for (const [id, revision, hash] of [[82, 1, detail.review.reviewHash], [81, 2, detail.review.reviewHash], [81, 1, "b".repeat(64)]]) {
        assert.equal((await stateModule.readCreditApprovalCallState(db, id, revision, hash)).recording, null);
      }
      assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 1, detail.review.reviewHash, null)).recording, null);
      await assert.rejects(store.readCreditApprovalCallBytes(db, 82, first.state.recording.id), e => e.status === 404);
    });
    await t.test("recording upload never updates the signed contract or review", async () => {
      const credit = (await client.query('SELECT "contract" FROM "Credito" WHERE "id"=81')).rows[0];
      const review = (await client.query('SELECT "revision","status" FROM "CreditApprovalReview" WHERE "creditoId"=81')).rows[0];
      assert.deepEqual(credit.contract, { signed: "original", principal: 800000 });
      assert.deepEqual(review, { revision: 1, status: "PENDING" });
    });
  } finally { await client.end(); }
});
