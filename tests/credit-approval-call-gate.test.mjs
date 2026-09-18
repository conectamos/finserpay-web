import assert from "node:assert/strict";
import test from "node:test";
import { loadApprovalModule, service, approvalFixture, approvalDatabase, CALL_RECORDING_ID, readyCallRecording, plain } from "./credit-approval-test-loader.mjs";

const actor = { id: 7, nombre: "Analista de prueba" };
const centralActor = { id: 70, nombre: "Administrador central" };
const sharedActor = { kind: "SHARED_LINK", id: null, nombre: "Acceso compartido",
  grantId: "00000000-0000-4000-8000-000000000071", sessionId: "00000000-0000-4000-8000-000000000072" };
const anotherId = "00000000-0000-4000-8000-000000000082";
const inputFor = (detail, recordingId = CALL_RECORDING_ID) => ({ revision: detail.review.revision, reviewHash: detail.review.reviewHash, recordingId });
const pureDetail = (fixture, state, canSkipCallRecording = false, reissue) => service.buildCreditApprovalDetail(
  fixture.credit, fixture.review, fixture.assessment, fixture.document, reissue, undefined, state, undefined, canSkipCallRecording);
const continuity = loadApprovalModule("lib/credit-approval-call-continuity.ts", {
  "@/lib/credit-approval": { getCreditApprovalDetail: async () => { throw new Error("El test suministra el detalle final"); } },
});

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

test("solo el administrador central activo puede aprobar sin una grabación", async () => {
  const { db, state } = approvalDatabase({ callRecording: null, centralAdminUserIds: [centralActor.id] });
  const detail = await service.getCreditApprovalDetail(db, 81, centralActor);
  assert.equal(detail.callRecording.required, false);
  assert.equal(detail.callRecording.canUpload, true);
  assert.equal(detail.canApprove, true);

  const result = await service.approveCredit(db, 81,
    { revision: detail.review.revision, reviewHash: detail.review.reviewHash }, centralActor);
  assert.equal(result.item.review.status, "APPROVED");
  assert.equal(state.review.callRecordingId, null);
  assert.equal(state.events[0][9], null);
  assert.match(state.events[0][10], /administrador central/);

  const identityChecks = state.queries.filter(({ sql }) => sql.includes("credit_approval_actor_can_skip_call_recording"));
  assert.equal(identityChecks.length, 2);
  assert.ok(identityChecks.every(({ params }) => params[0] === centralActor.id));
});

test("analista, administrador externo y enlace compartido siguen requiriendo audio", async () => {
  for (const currentActor of [actor, { id: 80, nombre: "Administrador externo" }, sharedActor]) {
    const { db, state } = approvalDatabase({ callRecording: null, centralAdminUserIds: [centralActor.id] });
    const detail = await service.getCreditApprovalDetail(db, 81, currentActor);
    assert.equal(detail.callRecording.required, true);
    assert.equal(detail.canApprove, false);
    await assert.rejects(service.approveCredit(db, 81,
      { revision: detail.review.revision, reviewHash: detail.review.reviewHash }, currentActor),
      { code: "CALL_RECORDING_REQUIRED", status: 409 });
    assert.equal(state.writes.length, 0);
  }
});

test("el administrador central sin audio no depende del almacenamiento de grabaciones", async () => {
  const { db, state } = approvalDatabase({ callRecordingError: true, centralAdminUserIds: [centralActor.id] });
  const detail = await service.getCreditApprovalDetail(db, 81, centralActor);
  assert.equal(detail.callRecording.available, false);
  assert.equal(detail.callRecording.required, false);
  assert.equal(detail.canApprove, true);
  await service.approveCredit(db, 81,
    { revision: detail.review.revision, reviewHash: detail.review.reviewHash }, centralActor);
  assert.equal(state.review.callRecordingId, null);
});

test("la carga opcional central solo está disponible mientras la revisión siga pendiente y elegible", () => {
  const pendingFixture = approvalFixture();
  const pending = pureDetail(pendingFixture, { available: true, recording: null }, true);
  assert.equal(pending.callRecording.required, false);
  assert.equal(pending.callRecording.canUpload, true);

  const approvedFixture = approvalFixture();
  approvedFixture.review = { status: "APPROVED", revision: 1, approvedRevision: 1,
    approvedAt: new Date("2026-09-11T15:00:00Z"), approvedByName: "Administrador central", callRecordingId: null };
  const approved = pureDetail(approvedFixture, { available: true, recording: null }, true);

  const legacyFixture = approvalFixture(); legacyFixture.credit.required = false;
  const legacy = pureDetail(legacyFixture, { available: true, recording: null }, true);
  const paidFixture = approvalFixture(); paidFixture.credit.paid = true;
  const paid = pureDetail(paidFixture, { available: true, recording: null }, true);
  const cancelledFixture = approvalFixture(); cancelledFixture.credit.estado = "CANCELADO";
  const cancelled = pureDetail(cancelledFixture, { available: true, recording: null }, true);
  const blockedFixture = approvalFixture();
  const blocked = pureDetail(blockedFixture, { available: true, recording: null }, true,
    { available: true, blocked: true, operation: null });
  const unavailable = pureDetail(approvalFixture(), { available: false, recording: null }, true);

  for (const detail of [approved, legacy, paid, cancelled, blocked, unavailable]) {
    assert.equal(detail.callRecording.canUpload, false);
  }
});
test("si existe audio vigente el administrador central debe confirmar ese identificador", async () => {
  const { db, state } = approvalDatabase({ centralAdminUserIds: [centralActor.id] });
  const detail = await service.getCreditApprovalDetail(db, 81, centralActor);
  assert.equal(detail.callRecording.required, false);
  assert.equal(detail.callRecording.recording.id, CALL_RECORDING_ID);
  await assert.rejects(service.approveCredit(db, 81,
    { revision: detail.review.revision, reviewHash: detail.review.reviewHash }, centralActor),
    { code: "CALL_RECORDING_CHANGED", status: 409 });
  await assert.rejects(service.approveCredit(db, 81,
    inputFor(detail, anotherId), centralActor), { code: "CALL_RECORDING_CHANGED", status: 409 });
  assert.equal(state.writes.length, 0);
  await service.approveCredit(db, 81, inputFor(detail), centralActor);
  assert.equal(state.review.callRecordingId, CALL_RECORDING_ID);
});

test("la excepción central no omite novedades ni documentos del expediente", async () => {
  const { db, state } = approvalDatabase({ callRecording: null, centralAdminUserIds: [centralActor.id],
    novelty: { id: "novelty-test", status: "WAITING_ALLY", version: 1 },
    noveltyItems: [{ id: "photo-test", key: "foto-entrega", status: "OPEN", version: 1, reason: "Foto borrosa", openedAt: new Date() }] });
  const detail = await service.getCreditApprovalDetail(db, 81, centralActor);
  assert.equal(detail.callRecording.required, false);
  assert.equal(detail.canApprove, false);
  await assert.rejects(service.approveCredit(db, 81,
    { revision: detail.review.revision, reviewHash: detail.review.reviewHash }, centralActor),
    { code: "NOVELTY_PENDING", status: 409 });
  assert.equal(state.writes.length, 0);
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

test("un audio continuado conserva su tupla física y solo habilita la tupla efectiva declarada", () => {
  const fixture = approvalFixture();
  const original = pureDetail(fixture, { available: true, recording: null });
  const recording = readyCallRecording(original);
  fixture.review = {
    status: "PENDING", revision: 3, approvedRevision: null, approvedAt: null,
    approvedByName: null, reviewHash: null,
  };
  const pending = pureDetail(fixture, { available: true, recording: null });
  const continued = pureDetail(fixture, {
    available: true,
    recording,
    validFor: { revision: pending.review.revision, reviewHash: pending.review.reviewHash },
  });
  assert.equal(continued.canApprove, true);
  assert.equal(continued.callRecording.recording.id, recording.id);
  assert.equal(continued.callRecording.recording.revision, 1, "no reescribe la revisión física del audio");
  assert.equal(continued.callRecording.recording.reviewHash, original.review.reviewHash, "no falsifica la huella original");
  const wrongTarget = pureDetail(fixture, {
    available: true,
    recording,
    validFor: { revision: pending.review.revision, reviewHash: "b".repeat(64) },
  });
  assert.equal(wrongTarget.canApprove, false);
  assert.equal(wrongTarget.callRecording.recording, null);
});

test("la continuidad enlaza metadatos auditables sin copiar bytes y no actúa cuando falta audio", async () => {
  const sourceDetail = {
    id: 81, review: { revision: 4, reviewHash: "a".repeat(64), status: "PENDING" },
    callRecording: { available: true, recording: { id: CALL_RECORDING_ID } },
  };
  const source = continuity.captureCreditApprovalCallContinuity(sourceDetail);
  assert.deepEqual(plain(source), { recordingId: CALL_RECORDING_ID, revision: 4, reviewHash: "a".repeat(64) });

  const writes = [];
  const db = { async $executeRawUnsafe(sql, ...params) { writes.push({ sql, params }); return 1; } };
  const event = {
    noveltyId: "00000000-0000-4000-8000-000000000091",
    noveltyEventId: "00000000-0000-4000-8000-000000000092",
  };
  const target = {
    id: 81, review: { revision: 5, reviewHash: "a".repeat(64), status: "PENDING" },
    callRecording: { available: true, recording: { id: CALL_RECORDING_ID } },
  };
  assert.equal(await continuity.continueCreditApprovalCall(db, 81, source, event, target), true);
  assert.equal(writes.length, 1);
  assert.match(writes[0].sql, /^INSERT INTO "CreditApprovalCallContinuation"/);
  assert.doesNotMatch(writes[0].sql, /"bytes"/);
  assert.deepEqual(plain(writes[0].params.slice(1)), [
    81, CALL_RECORDING_ID, event.noveltyId, event.noveltyEventId,
    4, "a".repeat(64), 5, "a".repeat(64),
  ]);
  assert.equal(await continuity.continueCreditApprovalCall(db, 81, null, event, target), false);
  assert.equal(writes.length, 1);
});
