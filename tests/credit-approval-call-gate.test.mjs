import assert from "node:assert/strict";
import test from "node:test";
import { service, approvalFixture, approvalDatabase, CALL_RECORDING_ID, readyCallRecording, plain } from "./credit-approval-test-loader.mjs";

const actor = { id: 7, nombre: "Analista de prueba" };
const anotherId = "00000000-0000-4000-8000-000000000082";
const inputFor = (detail, recordingId = CALL_RECORDING_ID) => ({ revision: detail.review.revision, reviewHash: detail.review.reviewHash, recordingId });
const pureDetail = (fixture, state) => service.buildCreditApprovalDetail(fixture.credit, fixture.review, fixture.assessment, fixture.document, undefined, undefined, state);

test("el nuevo OK exige recordingId UUID válido; la forma previa solo queda disponible para retry histórico", () => {
  const body = { revision: 1, reviewHash: "a".repeat(64) };
  assert.deepEqual(plain(service.parseCreditApproval(body)), body);
  assert.deepEqual(plain(service.parseCreditApproval({ ...body, recordingId: CALL_RECORDING_ID })), { ...body, recordingId: CALL_RECORDING_ID });
  for (const recordingId of [null, "", 1, "invalid", "00000000-0000-0000-0000-000000000081"]) {
    assert.throws(() => service.parseCreditApproval({ ...body, recordingId }), { code: "INVALID_REVIEW" });
  }
  assert.throws(() => service.parseCreditApproval({ ...body, recordingId: CALL_RECORDING_ID, actorUserId: 7 }), { code: "INVALID_REVIEW" });
});

test("detalle pendiente exige llamada y grabación sin cambiar huella base ni condiciones firmadas", () => {
  const fixture = approvalFixture(), before = plain(fixture);
  const empty = pureDetail(fixture, { available: true, recording: null });
  assert.equal(empty.callRecording.required, true);
  assert.equal(empty.callRecording.canUpload, true);
  assert.equal(empty.canApprove, false);
  const recording = readyCallRecording(empty);
  const complete = pureDetail(fixture, { available: true, recording });
  assert.equal(complete.canApprove, true);
  assert.equal(complete.review.reviewHash, empty.review.reviewHash);
  assert.equal(complete.callRecording.recording.id, CALL_RECORDING_ID);
  for (const changed of [{ revision: 2 }, { reviewHash: "b".repeat(64) }]) {
    const stale = pureDetail(fixture, { available: true, recording: { ...recording, ...changed } });
    assert.equal(stale.canApprove, false);
    assert.equal(stale.callRecording.recording, null);
  }
  assert.deepEqual(plain(fixture), before);
});

test("falta o fallo de almacenamiento de audio bloquea pending antes de escribir", async () => {
  for (const [overrides, code, status] of [[{ callRecording: null }, "CALL_RECORDING_REQUIRED", 409], [{ callRecordingError: true }, "CALL_RECORDING_UNAVAILABLE", 503]]) {
    const { db, state } = approvalDatabase(overrides);
    const detail = await service.getCreditApprovalDetail(db, 81);
    assert.equal(detail.canApprove, false);
    assert.equal(detail.callRecording.available, !overrides.callRecordingError);
    await assert.rejects(service.approveCredit(db, 81, inputFor(detail), actor), { code, status });
    assert.equal(state.writes.length, 0);
  }
});

test("sin identificador explícito o con un audio sustituido no se registra OK", async () => {
  const { db, state } = approvalDatabase();
  const detail = await service.getCreditApprovalDetail(db, 81);
  const input = inputFor(detail);
  delete input.recordingId;
  await assert.rejects(service.approveCredit(db, 81, input, actor), { code: "CALL_RECORDING_CHANGED" });
  state.callRecording = { ...readyCallRecording(detail), id: anotherId };
  await assert.rejects(service.approveCredit(db, 81, inputFor(detail), actor), { code: "CALL_RECORDING_CHANGED" });
  assert.equal(state.writes.length, 0);
});

test("foto o nueva revisión requieren una grabación de esa misma versión", async () => {
  const { db, state } = approvalDatabase();
  const original = await service.getCreditApprovalDetail(db, 81);
  state.callRecording = readyCallRecording(original);
  state.credit.fotoEntregaDataUrl += " ";
  const changed = await service.getCreditApprovalDetail(db, 81);
  assert.notEqual(changed.review.reviewHash, original.review.reviewHash);
  assert.equal(changed.callRecording.recording, null);
  await assert.rejects(service.approveCredit(db, 81, inputFor(changed), actor), { code: "CALL_RECORDING_REQUIRED" });
  assert.equal(state.writes.length, 0);
});

test("OK vincula el audio a revisión y evento; retry no duplica ni sustituye audio o actor", async () => {
  const { db, state } = approvalDatabase();
  const detail = await service.getCreditApprovalDetail(db, 81);
  const confirmed = await service.approveCredit(db, 81, inputFor(detail), actor);
  assert.equal(confirmed.item.review.status, "APPROVED");
  assert.equal(confirmed.item.callRecording.required, false);
  assert.equal(confirmed.item.callRecording.canUpload, false);
  assert.equal(state.review.callRecordingId, CALL_RECORDING_ID);
  assert.equal(state.events[0][9], CALL_RECORDING_ID);
  const before = plain({ review: state.review, events: state.events }), count = state.writes.length;
  const legacyRetry = { revision: detail.review.revision, reviewHash: detail.review.reviewHash };
  assert.equal((await service.approveCredit(db, 81, legacyRetry, { id: 99, nombre: "Otro" })).unchanged, true);
  await assert.rejects(service.approveCredit(db, 81, inputFor(detail, anotherId), actor), { code: "CALL_RECORDING_CHANGED" });
  assert.deepEqual(plain({ review: state.review, events: state.events }), before);
  assert.equal(state.writes.length, count);
});

test("aprobación histórica sin audio se conserva y no depende del nuevo almacenamiento", async () => {
  const { db, state } = approvalDatabase({ callRecordingError: true });
  const pending = await service.getCreditApprovalDetail(db, 81);
  state.review = { status: "APPROVED", revision: 3, approvedRevision: 3, approvedByName: "Analista histórico",
    approvedAt: new Date("2026-09-01T12:00:00Z"), reviewHash: pending.review.reviewHash, callRecordingId: null };
  const before = plain(state.review);
  const approved = await service.getCreditApprovalDetail(db, 81);
  assert.equal(approved.review.status, "APPROVED");
  assert.equal(approved.callRecording.required, false);
  assert.equal(approved.callRecording.recording, null);
  assert.equal(approved.callRecording.available, true);
  assert.equal(approved.callRecording.canUpload, false);
  const input = { revision: 3, reviewHash: approved.review.reviewHash };
  assert.equal((await service.approveCredit(db, 81, input, actor)).unchanged, true);
  assert.deepEqual(plain(state.review), before);
  assert.equal(state.writes.length, 0);
});
