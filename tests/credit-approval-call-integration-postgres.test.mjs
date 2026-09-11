import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";
import { prepareCallIntegrationFixture } from "./credit-approval-call-integration-fixture.mjs";
import { service as core, approvalFixture, approvalErrors, approvalActors } from "./credit-approval-test-loader.mjs";
import { loadCallModule, files, stateModule, tone } from "./credit-approval-call-test-loader.mjs";

pg.types.setTypeParser(1114, value => new Date(value.replace(" ", "T") + "Z"));
const connectionString = process.env.CREDIT_APPROVAL_CALL_TEST_DATABASE_URL;
const adapter = client => ({
  $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
});
const store = loadCallModule("lib/credit-approval-call-store.ts", {
  "@/lib/credit-approval": core, "@/lib/credit-approval-errors": approvalErrors,
  "@/lib/credit-approval-actor": approvalActors, "@/lib/credit-approval-call-state": stateModule,
});
const actor = { id: 7, nombre: "Analista de prueba" };
async function transaction(client, work) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try { const value = await work(adapter(client)); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
}
async function waitForLock(observer, processId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await observer.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [processId])).rows[0];
    if (row?.wait_event_type === "Lock") return;
    await pause(10);
  }
  assert.fail("La segunda operación no llegó al bloqueo esperado");
}
const approvalInput = detail => ({ revision: detail.review.revision, reviewHash: detail.review.reviewHash, recordingId: detail.callRecording.recording?.id });

test("real call schema, storage and approval integrate under concurrent actions", { skip: !connectionString }, async t => {
  const client = new pg.Client({ connectionString }); await client.connect(); t.after(() => client.end());
  await prepareCallIntegrationFixture(client, connectionString);
  const db = adapter(client), fixture = approvalFixture();
  async function createCredit() {
    const fields = core.APPROVAL_EVIDENCE.map(({ field }) => field);
    const id = (await client.query(`INSERT INTO "Credito" (${fields.map(field => `"${field}"`).join(",")})
      VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")}) RETURNING "id"`, fields.map(field => fixture.credit[field]))).rows[0].id;
    await client.query(`INSERT INTO "DataCreditoAssessment" VALUES ($1,$2,750,'{"initialPaymentPercentage":20}','APROBADO',CURRENT_TIMESTAMP,'2199-01-01')`, [`assessment-${id}`, id]);
    await client.query(`INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","signedDocumentBase64","signedDocumentFileName","completedAt")
      VALUES ($1,$2,'COMPLETED',$3,'firmado.pdf',CURRENT_TIMESTAMP)`, [id, `process-${id}`, fixture.document.signedDocumentBase64]);
    return id;
  }
  const read = id => core.getCreditApprovalDetail(db, id);
  const fileInput = async (detail, extension = "wav") => ({ ...await files.prepareApprovalCallFile(tone(extension), `llamada.${extension}`),
    revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: randomUUID() });
  const upload = (id, input, target = client) => transaction(target, tx => store.saveCreditApprovalCall(tx, id, input, actor));
  const approve = (id, input, target = client) => transaction(target, tx => core.approveCredit(tx, id, input, actor));
  const snapshot = async id => {
    const credit = (await client.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    const signature = (await client.query('SELECT * FROM "FirmaSeguroProcess" WHERE "creditoId"=$1', [id])).rows[0];
    return { credit, signature };
  };
  await t.test("missing audio blocks OK; every supported format becomes valid evidence without touching signed data", async () => {
    const id = await createCredit(), before = await snapshot(id);
    const empty = await read(id);
    assert.equal(empty.canApprove, false); assert.equal(empty.callRecording.required, true);
    await assert.rejects(approve(id, approvalInput(empty)), e => e.code === "CALL_RECORDING_REQUIRED");
    for (const extension of ["wav", "mp3", "m4a"]) {
      const input = await fileInput(await read(id), extension);
      const result = await upload(id, input), current = await read(id);
      assert.equal(current.canApprove, true); assert.equal(current.callRecording.recording.id, result.state.recording.id);
      assert.equal(current.review.reviewHash, empty.review.reviewHash);
      assert.ok((await store.readCreditApprovalCallBytes(db, id, result.state.recording.id)).bytes.equals(tone(extension)));
    }
    assert.deepEqual(await snapshot(id), before);
    assert.equal((await client.query('SELECT count(*)::integer AS count FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1', [id])).rows[0].count, 3);
  });
  await t.test("approval pins recording in review and event and rejects subsequent uploads", async () => {
    const id = await createCredit(), input = await fileInput(await read(id));
    const added = await upload(id, input), ready = await read(id);
    const ok = await approve(id, approvalInput(ready));
    assert.equal(ok.item.review.status, "APPROVED"); assert.equal(ok.item.callRecording.required, false);
    const review = (await client.query('SELECT "callRecordingId" FROM "CreditApprovalReview" WHERE "creditoId"=$1', [id])).rows[0];
    const event = (await client.query('SELECT "callRecordingId" FROM "CreditApprovalEvent" WHERE "creditoId"=$1 AND "eventType"=\'APPROVED\'', [id])).rows[0];
    assert.equal(review.callRecordingId, added.state.recording.id); assert.equal(event.callRecordingId, added.state.recording.id);
    assert.equal((await upload(id, input)).unchanged, true);
    await assert.rejects(upload(id, { ...input, idempotencyKey: randomUUID() }), e => e.code === "CALL_RECORDING_NOT_ALLOWED");
    assert.equal((await approve(id, approvalInput(ready))).unchanged, true);
  });
  await t.test("invalidating the reviewed credit keeps old audio but requires evidence for the new version", async () => {
    const id = await createCredit(), original = await read(id), input = await fileInput(original);
    const added = await upload(id, input); await approve(id, approvalInput(await read(id)));
    await client.query('UPDATE "Credito" SET "imei"=$2 WHERE "id"=$1', [id, "000000000000002"]);
    const changed = await read(id);
    assert.equal(changed.review.status, "PENDING"); assert.equal(changed.callRecording.recording, null);
    assert.ok(changed.review.revision > original.review.revision);
    await assert.rejects(upload(id, { ...input, idempotencyKey: randomUUID() }), e => e.code === "REVIEW_CHANGED");
    assert.ok((await store.readCreditApprovalCallBytes(db, id, added.state.recording.id)).bytes.equals(tone()));
    await upload(id, await fileInput(changed));
    assert.equal((await approve(id, approvalInput(await read(id)))).item.review.status, "APPROVED");
  });
  await t.test("a later serialized upload becomes latest even if its transaction started before the previous upload", async () => {
    const id = await createCredit(), firstInput = await fileInput(await read(id)), secondInput = await fileInput(await read(id), "mp3");
    const other = new pg.Client({ connectionString }); await other.connect();
    try {
      await client.query("BEGIN"); await client.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', [id]);
      const pending = upload(id, secondInput, other);
      await waitForLock(client, other.processID);
      const first = await store.saveCreditApprovalCall(db, id, firstInput, actor);
      await client.query("COMMIT");
      const second = await pending;
      assert.equal((await read(id)).callRecording.recording.id, second.state.recording.id);
      const saved = (await client.query('SELECT "id","createdAt" FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1 ORDER BY "createdAt"', [id])).rows;
      assert.equal(saved[0].id, first.state.recording.id); assert.equal(saved[1].id, second.state.recording.id);
      assert.ok(saved[1].createdAt.getTime() > saved[0].createdAt.getTime());
    } finally { await client.query("ROLLBACK"); await other.end(); }
  });
  await t.test("a waiting approval rejects a recording that another analyst replaced", async () => {
    const id = await createCredit(); await upload(id, await fileInput(await read(id)));
    const observed = approvalInput(await read(id)), replacement = await fileInput(await read(id), "mp3");
    const other = new pg.Client({ connectionString }); await other.connect();
    try {
      await client.query("BEGIN"); await client.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', [id]);
      const pending = assert.rejects(approve(id, observed, other), e => e.code === "CALL_RECORDING_CHANGED");
      await waitForLock(client, other.processID);
      await store.saveCreditApprovalCall(db, id, replacement, actor); await client.query("COMMIT"); await pending;
      assert.equal((await read(id)).review.status, "PENDING");
      assert.equal((await approve(id, approvalInput(await read(id)))).item.review.status, "APPROVED");
    } finally { await client.query("ROLLBACK"); await other.end(); }
  });
  await t.test("a waiting upload cannot replace the audio after another analyst approves", async () => {
    const id = await createCredit(); await upload(id, await fileInput(await read(id)));
    const observed = approvalInput(await read(id)), replacement = await fileInput(await read(id), "mp3");
    const other = new pg.Client({ connectionString }); await other.connect();
    try {
      await client.query("BEGIN"); await client.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', [id]);
      const pending = assert.rejects(upload(id, replacement, other), e => e.code === "CALL_RECORDING_NOT_ALLOWED");
      await waitForLock(client, other.processID);
      await core.approveCredit(db, id, observed, actor); await client.query("COMMIT"); await pending;
      assert.equal((await read(id)).callRecording.recording.id, observed.recordingId);
    } finally { await client.query("ROLLBACK"); await other.end(); }
  });
});
