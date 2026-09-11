import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadCallModule, errors, actors, files, tone, stateModule, plain } from "./credit-approval-call-test-loader.mjs";

function setup(overrides = {}) {
  const state = { rows: [], queries: [], writes: [], revoked: false, writable: true,
    detail: { review: { revision: 1, reviewHash: "a".repeat(64), required: true, status: "PENDING" },
      capabilities: { canCorrectEvidence: true, correctionBlockedReason: null }, callRecording: { available: true } }, ...overrides };
  const db = {
    async $queryRawUnsafe(sql, ...args) {
      state.queries.push({ sql, args });
      if (sql.includes('FROM "Credito" WHERE')) return [{ id: args[0] }];
      if (sql.includes('FROM "CreditApprovalReview"')) return [];
      if (sql.includes('"idempotencyKey"=$1')) return state.rows.filter(row => row.idempotencyKey === args[0]);
      if (sql.includes('SELECT recording."bytes"')) return state.rows.filter(row => row.id === args[0] && row.creditoId === args[1]);
      if (sql.includes('FROM "CreditApprovalCallRecording"')) return state.rows.filter(row => row.creditoId === args[0] &&
        (args[3] ? row.id === args[3] : row.revision === args[1] && row.reviewHash === args[2])).slice(-1);
      throw Error(sql);
    },
    async $executeRawUnsafe(sql, ...p) {
      state.writes.push({ sql, args: p });
      assert.match(sql, /^INSERT INTO "CreditApprovalCallRecording"/);
      const [id, creditoId, revision, reviewHash, fileName, mimeType, sizeBytes, sha256, bytes,
        actorUserId, actorName, actorKind, actorGrantId, actorSessionId, idempotencyKey] = p;
      state.rows.push({ id, creditoId, revision, reviewHash, fileName, mimeType, sizeBytes, sha256, bytes,
        actorUserId, actorName, actorKind, actorGrantId, actorSessionId, idempotencyKey, createdAt: new Date() });
      return 1;
    },
  };
  const service = loadCallModule("lib/credit-approval-call-store.ts", {
    "@/lib/credit-approval": { getCreditApprovalDetail: async () => state.detail },
    "@/lib/credit-approval-errors": errors, "@/lib/credit-approval-call-state": stateModule,
    "@/lib/credit-approval-actor": { ...actors,
      async assertApprovalActorActive() { state.queries.push({ sql: "LOCK ACTOR" }); if (state.revoked) throw new actors.ApprovalActorAccessError(); },
      async assertApprovalActorCreditAccess() { if (!state.writable) throw new actors.ApprovalActorCreditAccessError(); },
    },
  });
  return { state, db, service };
}
const actor = { id: 12, nombre: "Analista de prueba" };
const input = async (patch = {}) => ({ ...await files.prepareApprovalCallFile(tone(), "llamada.wav"),
  revision: 1, reviewHash: "a".repeat(64), idempotencyKey: randomUUID(), ...patch });

test("call upload preserves bytes and actor, locks credit before review and only inserts a recording", async () => {
  const { state, db, service } = setup();
  const file = await input();
  const before = JSON.stringify(state.detail);
  const result = await service.saveCreditApprovalCall(db, 81, file, actor);
  assert.equal(result.unchanged, false);
  assert.equal(result.state.recording.actorName, actor.nombre);
  assert.equal(result.state.recording.sha256, file.sha256);
  assert.equal(result.state.recording.href, `/api/aprobaciones/81/grabaciones/${state.rows[0].id}`);
  assert.equal("bytes" in result.state.recording, false);
  assert.equal(state.writes.length, 1); assert.equal(JSON.stringify(state.detail), before);
  assert.equal(state.queries[0].sql, "LOCK ACTOR");
  assert.match(state.queries[1].sql, /FROM "Credito".*FOR UPDATE/);
  assert.match(state.queries[2].sql, /FROM "CreditApprovalReview".*FOR UPDATE/);
  assert.ok(state.rows[0].bytes.equals(file.bytes));
});
test("call upload is idempotent and preserves original actor and bytes", async () => {
  const { state, db, service } = setup(); const file = await input();
  const first = await service.saveCreditApprovalCall(db, 81, file, actor);
  const retry = await service.saveCreditApprovalCall(db, 81, file, actor);
  assert.equal(retry.unchanged, true); assert.equal(retry.state.recording.id, first.state.recording.id);
  assert.equal(state.rows.length, 1); assert.equal(state.writes.length, 1);
  await assert.rejects(service.saveCreditApprovalCall(db, 81, file, { id: 13, nombre: "Otro" }), e => e.code === "CALL_RECORDING_KEY_CONFLICT");
  await assert.rejects(service.saveCreditApprovalCall(db, 81, { ...file, fileName: "otra.wav" }, actor), e => e.code === "CALL_RECORDING_KEY_CONFLICT");
  await assert.rejects(service.saveCreditApprovalCall(db, 82, file, actor), e => e.code === "CALL_RECORDING_KEY_CONFLICT");
});
test("replacement appends and keeps the previous recording accessible", async () => {
  const { state, db, service } = setup();
  const first = await service.saveCreditApprovalCall(db, 81, await input(), actor);
  const second = await service.saveCreditApprovalCall(db, 81, await input({ fileName: "segunda.wav" }), actor);
  assert.notEqual(first.state.recording.id, second.state.recording.id); assert.equal(state.rows.length, 2);
  const previous = await service.readCreditApprovalCallBytes(db, 81, first.state.recording.id);
  assert.ok(previous.bytes.equals(tone()));
});
test("shared actor audit retains grant and session and never invents a user", async () => {
  const { state, db, service } = setup();
  const shared = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido", grantId: randomUUID(), sessionId: randomUUID() };
  await service.saveCreditApprovalCall(db, 81, await input(), shared);
  assert.equal(state.rows[0].actorKind, "SHARED_LINK"); assert.equal(state.rows[0].actorUserId, null);
  assert.equal(state.rows[0].actorGrantId, shared.grantId); assert.equal(state.rows[0].actorSessionId, shared.sessionId);
});
test("upload denies revoked/out of scope, changed review, approved, legacy and blocked signatures", async () => {
  for (const patch of [ { revoked: true }, { writable: false },
    { review: { revision: 2 } }, { review: { reviewHash: "b".repeat(64) } },
    { review: { status: "APPROVED" } }, { review: { required: false } },
    { capabilities: { canCorrectEvidence: false, correctionBlockedReason: "Firma pendiente" } },
  ]) {
    const { state, db, service } = setup();
    Object.assign(state, { revoked: patch.revoked || false, writable: patch.writable ?? true });
    Object.assign(state.detail.review, patch.review); Object.assign(state.detail.capabilities, patch.capabilities);
    await assert.rejects(service.saveCreditApprovalCall(db, 81, await input(), actor));
    assert.equal(state.writes.length, 0);
  }
});
test("recording selection is scoped to revision/hash and preserves legacy null and fixed approved ID", async () => {
  const { db, service } = setup();
  const first = await service.saveCreditApprovalCall(db, 81, await input(), actor);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 1, "a".repeat(64))).recording.id, first.state.recording.id);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 2, "a".repeat(64))).recording, null);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 1, "b".repeat(64))).recording, null);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 82, 1, "a".repeat(64))).recording, null);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 1, "a".repeat(64), null)).recording, null);
  assert.equal((await stateModule.readCreditApprovalCallState(db, 81, 9, "b".repeat(64), first.state.recording.id)).recording.id, first.state.recording.id);
});
test("recording lookup fails closed on unavailable storage and never leaks another credit's bytes", async () => {
  const unavailable = await stateModule.readCreditApprovalCallState({ async $queryRawUnsafe() { throw Error("private database error"); } }, 81, 1, "a".repeat(64));
  assert.deepEqual(plain(unavailable), { available: false, recording: null });
  const { db, service } = setup(); const created = await service.saveCreditApprovalCall(db, 81, await input(), actor);
  await assert.rejects(service.readCreditApprovalCallBytes(db, 82, created.state.recording.id), e => e.status === 404);
});
