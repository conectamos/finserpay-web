import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

class AttentionError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
class CreditApprovalError extends Error {}
class CreditWelcomeVoiceStoreError extends Error {}
const outcomes = { HUMAN_CONTACT: "Bienvenida realizada", NO_ANSWER: "No contestó", OPT_OUT: "No autoriza", UNCERTAIN: "Por confirmar" };
const module = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync(new URL("../lib/atencion-work-welcome.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, require(name) {
    if (name === "server-only") return {};
    if (name === "node:crypto") return { createHash };
    if (name.endsWith("atencion-core")) return { AttentionError, attentionText: value => { if (typeof value !== "string" || !value.trim()) throw new AttentionError("Texto obligatorio"); return value.trim(); }, attentionUuid: value => { if (!/^[a-f0-9-]{36}$/.test(value)) throw new AttentionError("UUID inválido"); return value; } };
    if (name.endsWith("credit-approval")) return { CreditApprovalError };
    if (name.endsWith("credit-welcome-voice-store")) return { CreditWelcomeVoiceStoreError };
    if (name.endsWith("credit-welcome-voice-phone")) return { normalizeManualVoicePhone: value => /^57\d{10}$/.test(value) ? value : null };
    if (name.endsWith("atencion-work-welcome-types")) return { attentionWelcomeOutcomes: outcomes };
    if (/atencion-work-storage|credit-approval-call-store|credit-welcome-voice-dispatch/.test(name)) return {};
    throw new Error(`Unexpected import ${name}`);
  },
});
const { createAttentionWorkWelcome } = module.exports;
const workId = "a0000000-0000-4000-8000-000000000001";
const actor = { type: "attention", actor: { userId: 5, key: "analyst:5", name: "Analista", central: false } };

function fixture(mode = "human") {
  let state = {
    version: 1, status: "pending", mode, owner: 5, creditId: 121, kind: "welcome", source: "C",
    recording: null, required: true, phone: "+573001234567", name: "Cliente de prueba", reviewHash: "a".repeat(64), matches: true,
    calls: [], ledger: {}, messages: [], notifications: 0, financialApproval: "PENDING", dispatched: 0,
  };
  function context(a, id, kind) {
    if (a.type !== "attention") throw new AttentionError("Solo analistas", 403);
    if (id !== workId || (!a.actor.central && a.actor.userId !== state.owner)) throw new AttentionError("No encontrado", 404);
    if (kind !== state.kind || state.source !== "C") throw new AttentionError("Otro trámite", 409);
    return { actor: a.actor, work: { id, targetId: state.creditId, targetSource: "C", conversationId: workId, version: state.version, state: state.status, callMode: state.mode },
      target: { name: state.name, document: "123456", imei: "123456789012345" },
      db: { $queryRawUnsafe: async (_query, _conversation, _actorKey, requestId) => { const saved = state.ledger[requestId]; return saved?.result?.action === "VOICE_REQUEST" ? [{ eventId: saved.result.eventId }] : []; } } };
  }
  const detail = () => ({ id: state.creditId, clienteNombre: state.name, clienteDocumento: "123456", clienteTelefono: state.phone, imei: "123456789012345",
    review: { status: "PENDING", revision: 2, reviewHash: state.reviewHash, required: true, approvedAt: null, approvedByName: null },
    callRecording: { available: true, required: state.required, canUpload: true, blockedReason: null, recording: state.recording },
  });
  const work = {
    workflowRead: async (a, id, kind, run) => run(context(a, id, kind)),
    workflowMutate: async (a, id, kind, input, run) => {
      const ctx = context(a, id, kind), fingerprint = JSON.stringify(input), prior = state.ledger[input.requestId];
      if (prior) { if (prior.fingerprint !== fingerprint) throw new AttentionError("Conflicto de intento", 409); return { detail: { item: { version: state.version, state: state.status } }, result: prior.result, alreadyApplied: true }; }
      if (input.version !== state.version || state.status === "completed") throw new AttentionError("Cambió la solicitud", 409);
      const before = structuredClone(state);
      try {
        const outcome = await run(ctx);
        state.status = outcome.complete ? "completed" : outcome.nextState || state.status;
        state.version++; state.messages.push(outcome.summary); state.notifications++;
        state.ledger[input.requestId] = { fingerprint, result: outcome.result };
        return { detail: { item: { version: state.version, state: state.status } }, result: outcome.result, alreadyApplied: false };
      } catch (error) { state = before; throw error; }
    },
  };
  const voice = () => ({
    listCreditWelcomeVoiceCallsForCredit: async id => { assert.equal(id, state.creditId); return state.calls.map(call => ({ ...call })); },
    getCreditWelcomeVoiceOperatorAvailability: async () => ({ canCall: true, phone: state.phone }),
    prepareCreditWelcomeVoiceOperatorCall: async input => {
      assert.equal(input.creditId, state.creditId); assert.equal(input.actorId, 5);
      const eventId = randomUUID(); state.calls.push({ id: eventId, creditId: state.creditId, status: "DISPATCHING", source: "OPERATOR_REQUEST", communicationOutcome: null });
      return { created: true, eventId, creditId: state.creditId, snapshot: {}, status: "DISPATCHING" };
    },
    prepareCreditWelcomeVoiceDispatch: async eventId => ({ eventId, creditId: state.creditId, snapshot: {} }),
    creditWelcomeVoiceEvidenceIsCurrent: async () => state.matches,
  });
  const service = createAttentionWorkWelcome({ work, ensure: async () => {}, configured: () => true, detail: async () => detail(), voice,
    saveRecording: async (_ctx, input) => {
      assert.equal(input.revision, 2); assert.equal(input.reviewHash, state.reviewHash);
      state.recording = { id: randomUUID(), fileName: input.fileName, revision: 2, reviewHash: state.reviewHash };
      return { state: { available: true, recording: state.recording }, unchanged: false };
    },
    recordingBytes: async (_ctx, recordingId) => { if (recordingId !== state.recording?.id) throw new AttentionError("Grabación ajena", 404); return { bytes: new Uint8Array([1, 2]), mimeType: "audio/ogg", fileName: "audio.ogg" }; },
    dispatch: async (claim, prepare) => { const prepared = await prepare(claim.eventId); if (prepared) { state.dispatched++; state.calls.find(call => call.id === claim.eventId).status = "ACCEPTED"; } },
  });
  const finish = async (outcome = "HUMAN_CONTACT", extra = {}) => {
    const view = await service.read(actor, workId);
    return { requestId: randomUUID(), version: view.workVersion, contextHash: view.contextHash, revision: view.detail.review.revision,
      reviewHash: view.detail.review.reviewHash, mode: state.mode, outcome, observation: "Resultado observado por el analista", ...extra };
  };
  return { service, finish, get: () => state, set: patch => Object.assign(state, patch) };
}

test("welcome endpoints bind actual credit, assignment and work type without exposing financial approval", async () => {
  const f = fixture(), view = await f.service.read(actor, workId);
  assert.equal(view.detail.id, 121); assert.equal(view.contextHash.length, 64); assert.equal(view.workVersion, 1);
  assert.equal(view.detail.canApprove, undefined); assert.equal(view.detail.evidence, undefined);
  await assert.rejects(f.service.read({ type: "seller" }, workId), { status: 403 });
  await assert.rejects(f.service.read({ type: "attention", actor: { ...actor.actor, userId: 7 } }, workId), { status: 404 });
  f.set({ source: "D" }); await assert.rejects(f.service.read(actor, workId), { status: 409 });
});

test("human contact requires current recording; upload and result are separate audited steps with replay protection", async () => {
  const f = fixture(); await assert.rejects(f.service.finish(actor, workId, await f.finish()), /grabación/);
  const view = await f.service.read(actor, workId), audio = { revision: 2, reviewHash: view.detail.review.reviewHash, idempotencyKey: randomUUID(), fileName: "llamada.ogg", mimeType: "audio/ogg", sha256: "c".repeat(64), sizeBytes: 2, bytes: new Uint8Array([1, 2]) };
  const upload = await f.service.upload(actor, workId, audio, view.workVersion, view.contextHash);
  assert.equal(upload.detail.item.state, "pending"); assert.match(upload.state.recording.href, new RegExp(`/solicitudes/${workId}/bienvenida/grabaciones/`));
  const body = await f.finish("HUMAN_CONTACT", { recordingId: upload.state.recording.id });
  const result = await f.service.finish(actor, workId, body);
  assert.equal(result.detail.item.state, "completed"); assert.equal(f.get().financialApproval, "PENDING");
  assert.equal(f.get().messages.length, 2); assert.equal(f.get().notifications, 2);
  assert.equal((await f.service.finish(actor, workId, body)).alreadyApplied, true);
  assert.equal(f.get().notifications, 2);
});

test("no-answer and uncertain record followup and remain review; opt-out closes without claiming welcome success", async () => {
  for (const outcome of ["NO_ANSWER", "UNCERTAIN"]) {
    const f = fixture(), result = await f.service.finish(actor, workId, await f.finish(outcome));
    assert.equal(result.detail.item.state, "review"); assert.equal(result.result.outcome, outcome);
    assert.doesNotMatch(f.get().messages[0], /^Bienvenida realizada/);
  }
  const f = fixture(), result = await f.service.finish(actor, workId, await f.finish("OPT_OUT"));
  assert.equal(result.detail.item.state, "completed"); assert.match(f.get().messages[0], /cerrada sin bienvenida/);
});

test("canonical optional recording remains optional and stale phone/review is rejected", async () => {
  const optional = fixture(); optional.set({ required: false });
  assert.equal((await optional.service.finish(actor, workId, await optional.finish())).detail.item.state, "completed");
  const stale = fixture(), body = await stale.finish("NO_ANSWER"); stale.set({ phone: "+573009999999" });
  await assert.rejects(stale.service.finish(actor, workId, body), { status: 409 }); assert.equal(stale.get().notifications, 0);
});

test("Dapta reservation and dispatch occur once; same intent never redials; stale context rolls back reservation", async () => {
  const f = fixture("dapta"), view = await f.service.read(actor, workId), body = { requestId: randomUUID(), version: view.workVersion, contextHash: view.contextHash };
  assert.equal((await f.service.call(actor, workId, body)).status, "ACCEPTED"); assert.equal(f.get().dispatched, 1);
  assert.equal((await f.service.call(actor, workId, body)).alreadyApplied, true); assert.equal(f.get().dispatched, 1); assert.equal(f.get().notifications, 1);
  const stale = fixture("dapta"), old = await stale.service.read(actor, workId); stale.set({ phone: "+573008888888" });
  await assert.rejects(stale.service.call(actor, workId, { requestId: randomUUID(), version: old.workVersion, contextHash: old.contextHash }), error => error.status === 409 && error.requestCreated === false);
  assert.equal(stale.get().calls.length, 0); assert.equal(stale.get().dispatched, 0);
});

test("Dapta completion requires a real completed matching-current event and its actual outcome", async () => {
  for (const override of [{ status: "UNKNOWN" }, { status: "ACCEPTED" }, { providerCallId: null }, { source: "CONTROLLED_TEST" }, { communicationOutcome: "NO_ANSWER" }]) {
    const f = fixture("dapta"), id = randomUUID();
    f.set({ calls: [{ id, creditId: 121, status: "COMPLETED", providerCallId: "real-provider-id", completedAt: "2026-10-31T15:00:00Z", source: "OPERATOR_REQUEST", communicationOutcome: "HUMAN_CONTACT", ...override }] });
    await assert.rejects(f.service.finish(actor, workId, await f.finish("HUMAN_CONTACT", { voiceEventId: id })), { status: 409 });
    assert.equal(f.get().notifications, 0);
  }
  const f = fixture("dapta"), id = randomUUID();
  f.set({ calls: [{ id, creditId: 121, status: "COMPLETED", providerCallId: "real-provider-id", completedAt: "2026-10-31T15:00:00Z", source: "OPERATOR_REQUEST", communicationOutcome: "HUMAN_CONTACT" }], matches: false });
  await assert.rejects(f.service.finish(actor, workId, await f.finish("HUMAN_CONTACT", { voiceEventId: id })), /vigente/);
  f.set({ matches: true }); assert.equal((await f.service.finish(actor, workId, await f.finish("HUMAN_CONTACT", { voiceEventId: id }))).detail.item.state, "completed");
});
