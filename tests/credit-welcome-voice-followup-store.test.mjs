import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditWelcomeVoiceSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const dependencies = {};
for (const name of ["credit-welcome-voice-core", "credit-payment-plan", "credit-factory-snapshot", "cartera-export", "dapta-welcome",
  "credit-welcome-voice-speech", "credit-voice-review-campaign-core", "credit-welcome-voice-document", "credit-welcome-voice-followup-core"]) {
  dependencies["@/lib/" + name] = await jiti.import("../lib/" + name + ".ts");
}
dependencies["@/lib/credit-welcome-voice-recording"] = loadReissueModule("lib/credit-welcome-voice-recording.ts");
const dispatcher = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": dependencies["@/lib/credit-welcome-voice-core"],
  "@/lib/credit-welcome-voice-speech": dependencies["@/lib/credit-welcome-voice-speech"],
  "@/lib/credit-welcome-voice-store": {},
}, { AbortSignal });
const credit = id => ({ id, folio: `FC-FOLLOWUP-${id}`, clienteNombre: "ANA MARIA PRUEBA", clienteDocumento: "00123456",
  clienteTelefono: "3000000001", referenciaEquipo: null, equipoMarca: null, equipoModelo: null,
  estado: "ENTREGABLE", pazYSalvoEmitidoAt: null, cuotaInicial: 200, montoCredito: 300, valorCuota: 100,
  plazoMeses: 3, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17", fechaProximoPago: "2026-10-17",
  contratoSnapshot: null, planCapitalVigente: null, abonos: [],
  amortizacion: { numeroCuotas: 3, cuotaComercial: "100.00", frecuenciaPago: "QUINCENAL", cuotas: [
    { numero: 1, fechaVencimiento: "2026-10-17", cuotaCobro: "100.00" },
    { numero: 2, fechaVencimiento: "2026-11-02", cuotaCobro: "100.00" },
    { numero: 3, fechaVencimiento: "2026-11-17", cuotaCobro: "100.00" },
  ] } });

async function fixture(t, { count = 1, enabled = true, env = {} } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" ("id" integer PRIMARY KEY,"data" jsonb NOT NULL);
    CREATE TABLE "CreditApprovalReview" ("creditoId" integer PRIMARY KEY,"status" varchar(16),"revision" integer,"reviewHash" varchar(64));`);
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  for (let id = 1; id <= count; id++) {
    await db.query('INSERT INTO "Credito" VALUES ($1,$2::jsonb)', [id, JSON.stringify(credit(id))]);
    await db.query('INSERT INTO "CreditApprovalReview" VALUES ($1,\'APPROVED\',1,NULL)', [id]);
  }
  let time = new Date("2026-10-09T14:00:00Z"), rollback = false, queries = 0;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).affectedRows; },
    credito: { findUnique: async ({ where }) => (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null },
  });
  const client = { ...adapter(db), $transaction: callback => db.transaction(async connection => {
    const result = await callback(adapter(connection));
    if (rollback) { rollback = false; throw new Error("Synthetic rollback"); }
    return result;
  }) };
  const loaded = loadReissueModule("lib/credit-welcome-voice-store.ts", { ...dependencies, "@/lib/prisma": { default: client },
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => enabled, now: () => time, env });
  const enqueue = (creditId = 1, source = "NORMAL") => client.$transaction(tx => store.enqueueCreditWelcomeVoice(tx, { creditId, source }));
  const events = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId","attemptNumber"').then(r => r.rows);
  const followups = () => db.query('SELECT * FROM "CreditWelcomeVoiceFollowup" ORDER BY "creditoId"').then(r => r.rows);
  const accepted = event => store.markCreditWelcomeVoiceDispatchAccepted(event.eventId, "call-" + event.eventId);
  const result = (event, fields = {}) => store.saveCreditWelcomeVoiceResult({ eventId: event.eventId, creditId: event.creditId,
    providerCallId: "call-" + event.eventId, status: "COMPLETED", communicationOutcome: "NO_ANSWER", disconnectionReason: "dial_no_answer",
    completedAt: time.toISOString(), ...fields });
  const update = (id, fields) => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(fields)]);
  const saveRecording = async (id = 1, revision = 1) => {
    await db.exec('CREATE TABLE IF NOT EXISTS "CreditApprovalCallRecording" ("creditoId" integer,"revision" integer,"bytes" bytea)');
    await db.query('INSERT INTO "CreditApprovalCallRecording" VALUES($1,$2,$3)', [id, revision, new Uint8Array([1, 2, 3])]);
  };
  return { db, store, enqueue, events, followups, accepted, result, update, saveRecording, env, queries: () => queries,
    now: () => time, time: value => { time = new Date(value); }, advance: ms => { time = new Date(time.getTime() + ms); }, rollback: () => { rollback = true; } };
}

test("saved recording from any approval revision prevents new initial queues and stops already pending automatic sources", async t => {
  const f = await fixture(t, { count: 4 });
  await f.enqueue(1, "NORMAL"); await f.enqueue(2, "INDIVIDUAL_IMPORT"); await f.enqueue(3);
  await f.saveRecording(1, 1); await f.saveRecording(2, 1); await f.saveRecording(4, 1);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "revision"=9');
  assert.equal(await f.enqueue(4), null);
  assert.deepEqual(Array.from(await f.store.claimPendingCreditWelcomeVoice(), row => row.creditId), [3]);
  assert.deepEqual((await f.followups()).slice(0, 2).map(row => [row.phase, row.reason, row.nextAttemptAt]), [
    ["STOPPED", "CALL_RECORDING_SAVED", null], ["STOPPED", "CALL_RECORDING_SAVED", null],
  ]);
  assert.deepEqual((await f.events()).slice(0, 2).map(row => [row.status, row.resultCode]), [
    ["CANCELLED", "CALL_RECORDING_SAVED"], ["CANCELLED", "CALL_RECORDING_SAVED"],
  ]);
  assert.equal((await f.events()).length, 3);
});

test("recording saved after a claim blocks the real dispatcher before HTTP and cancels only its known-unsent event", async t => {
  const f = await fixture(t);
  await f.enqueue(); const claims = await f.store.claimPendingCreditWelcomeVoice();
  assert.equal(claims.length, 1); assert.equal((await f.events())[0].status, "DISPATCHING");
  await f.saveRecording();
  let requests = 0;
  const report = await dispatcher.dispatchCreditWelcomeVoice({}, {
    config: { webhookUrl: "https://api.dapta.ai/synthetic-recording-test", secret: "synthetic-recording-test-secret-at-least-32-characters",
      agentId: "4b68b7b8-382f-4f9a-8e1f-8b88665acf38" },
    ensureSchema: async () => {}, claim: async () => claims,
    prepare: f.store.prepareCreditWelcomeVoiceDispatch,
    accepted: () => assert.fail("A recorded credit must not be dispatched"),
    unknown: () => assert.fail("No HTTP means no ambiguous provider result"),
    failed: () => assert.fail("Recording suppression has its own persistent result"),
    fetcher: async () => { requests++; assert.fail("Must not call Dapta"); },
  });
  assert.equal(report.skipped, 1); assert.equal(report.accepted, 0); assert.equal(requests, 0);
  const [event] = await f.events(), [followup] = await f.followups();
  assert.equal(event.status, "CANCELLED"); assert.equal(event.resultCode, "CALL_RECORDING_SAVED");
  assert.equal(followup.phase, "STOPPED"); assert.equal(followup.reason, "CALL_RECORDING_SAVED");
  assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(claims[0].eventId), null);
});

test("recording stops existing FAST and daily queues without rewriting completed call evidence", async t => {
  const f = await fixture(t, { count: 2 });
  await f.enqueue(1); await f.enqueue(2);
  const initials = await f.store.claimPendingCreditWelcomeVoice();
  for (const initial of initials) await f.result(initial);
  const history = await f.events();
  await f.db.exec(`UPDATE "CreditWelcomeVoiceFollowup" SET "phase"='PENDING',"fastAttempts"=5,
    "nextAttemptAt"='2026-10-09T15:00:00Z' WHERE "creditoId"=2`);
  await f.saveRecording(1); await f.saveRecording(2);
  f.time("2026-10-09T15:00:00Z");
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.deepEqual(await f.events(), history);
  assert.deepEqual((await f.followups()).map(row => [row.phase, row.reason]), [
    ["STOPPED", "CALL_RECORDING_SAVED"], ["STOPPED", "CALL_RECORDING_SAVED"],
  ]);
  f.advance(24 * 60 * 60_000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("a deployment-gap historical initial with a saved recording is never adopted or retried", async t => {
  const f = await fixture(t, { env: { DAPTA_WELCOME_VOICE_AUTOMATIC_START_AT: "2026-10-09T13:59:00.000Z" } });
  await f.enqueue(); const [initial] = await f.store.claimPendingCreditWelcomeVoice();
  await f.accepted(initial); await f.result(initial); const history = await f.events();
  await f.db.exec('DELETE FROM "CreditWelcomeVoiceFollowup"');
  await f.saveRecording(); f.advance(300_000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.followups()).length, 0); assert.deepEqual(await f.events(), history);
});

async function legacyRetry(f, initial, { phase = "FAST", status = "DISPATCHING" } = {}) {
  const original = (await f.events()).find(row => row.id === initial.eventId);
  const id = phase === "FAST" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
  await f.db.query('INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","retryPhase","retrySlot","status","snapshot","dispatchedAt") VALUES ($1,$2,\'AUTOMATIC_RETRY\',1,$3,$4,$5,$6::jsonb,$7)',
    [id, initial.creditId, phase, phase === "PENDING" ? "2026-10-09T10:00" : null, status, JSON.stringify(original.snapshot), status === "DISPATCHING" ? f.now() : null]);
  await f.db.query('UPDATE "CreditWelcomeVoiceFollowup" SET "lastEventId"=$2,"phase"=$3,"fastAttempts"=1,"reason"=NULL WHERE "creditoId"=$1',
    [initial.creditId, id, phase]);
  return { eventId: id, creditId: initial.creditId, snapshot: original.snapshot };
}

test("one automatic call is final after no-answer, voicemail, failure, unknown, uncertainty or human contact", async t => {
  const f = await fixture(t, { count: 7 });
  for (let id = 1; id <= 7; id++) await f.enqueue(id, id % 2 ? "NORMAL" : "INDIVIDUAL_IMPORT");
  const claims = await f.store.claimPendingCreditWelcomeVoice({ limit: 10 });
  for (const claim of claims) assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(claim.eventId));
  await f.result(claims[0]);
  await f.result(claims[1], { resultCode: "VOICEMAIL", disconnectionReason: "voicemail_reached" });
  await f.result(claims[2], { status: "FAILED", resultCode: "CALL_FAILED" });
  await f.store.markCreditWelcomeVoiceDispatchUnknown(claims[3].eventId);
  await f.result(claims[4], { communicationOutcome: "UNCERTAIN" });
  await f.result(claims[5], { communicationOutcome: "HUMAN_CONTACT" });
  await f.store.markCreditWelcomeVoiceDispatchFailed(claims[6].eventId, "INVALID_DISPATCH_CONFIG");
  const history = await f.events();
  for (const time of ["2026-10-09T14:05:00Z", "2026-10-09T15:00:00Z", "2026-10-10T13:00:00Z", "2026-11-09T22:00:00Z"]) {
    f.time(time); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  }
  assert.deepEqual(await f.events(), history);
  assert.deepEqual((await f.followups()).map(row => row.phase), ["STOPPED", "STOPPED", "STOPPED", "STOPPED", "STOPPED", "CONTACTED", "STOPPED"]);
  assert.ok((await f.followups()).every(row => row.nextAttemptAt === null));
});

test("concurrent claims share the initial event and a second worker cannot suppress its still-unsent prepare", async t => {
  const f = await fixture(t, { count: 2 });
  f.rollback(); await assert.rejects(f.enqueue());
  assert.equal((await f.events()).length, 0);
  await Promise.all([f.enqueue(), f.enqueue()]); await f.enqueue(2, "INDIVIDUAL_IMPORT");
  const claims = (await Promise.all([f.store.claimPendingCreditWelcomeVoice({ limit: 1 }), f.store.claimPendingCreditWelcomeVoice({ limit: 1 })])).flat();
  assert.equal(claims.length, 2); assert.equal(new Set(claims.map(row => row.eventId)).size, 2);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  for (const claim of claims) assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(claim.eventId));
  for (const claim of claims) await f.result(claim);
  f.advance(300000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.events()).length, 2);
});

test("claimed legacy FAST and daily retries are cancelled at the real pre-HTTP gate, preserving initial history", async t => {
  for (const phase of ["FAST", "PENDING"]) {
    const f = await fixture(t); await f.enqueue();
    const [initial] = await f.store.claimPendingCreditWelcomeVoice();
    await f.result(initial, { recordingUrl: "https://app.dapta.ai/calls/synthetic-original" });
    const original = (await f.events())[0];
    const retry = await legacyRetry(f, initial, { phase });
    let requests = 0;
    const report = await dispatcher.dispatchCreditWelcomeVoice({}, {
      config: { webhookUrl: "https://api.dapta.ai/synthetic-single-call", secret: "synthetic-single-call-secret-at-least-32-characters",
        agentId: "4b68b7b8-382f-4f9a-8e1f-8b88665acf38" },
      ensureSchema: async () => {}, claim: async () => [retry], prepare: f.store.prepareCreditWelcomeVoiceDispatch,
      accepted: () => assert.fail("A retry cannot be accepted"), unknown: () => assert.fail("No HTTP was made"),
      failed: () => assert.fail("Suppression is persistent"), fetcher: async () => { requests++; assert.fail("No external call"); },
    });
    assert.equal(requests, 0); assert.equal(report.skipped, 1);
    const rows = await f.events(); assert.deepEqual(rows[0], original);
    assert.equal(rows[1].status, "CANCELLED"); assert.equal(rows[1].resultCode, "AUTOMATIC_CALL_LIMIT_REACHED");
    assert.equal((await f.followups())[0].phase, "STOPPED");
    assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(retry.eventId), null);
  }
});

test("a queued legacy retry never becomes a second call and is durably cancelled", async t => {
  const f = await fixture(t); await f.enqueue();
  const [initial] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(initial);
  const retry = await legacyRetry(f, initial, { status: "PENDING" });
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  const row = (await f.events()).find(row => row.id === retry.eventId);
  assert.equal(row.status, "CANCELLED"); assert.equal(row.dispatchedAt, null);
  assert.equal((await f.followups())[0].reason, "AUTOMATIC_CALL_LIMIT_REACHED");
});

test("late authenticated callbacks and recordings remain writable after automatic followup has stopped", async t => {
  const f = await fixture(t); await f.enqueue();
  const [initial] = await f.store.claimPendingCreditWelcomeVoice();
  await f.store.markCreditWelcomeVoiceDispatchUnknown(initial.eventId);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  const result = { communicationOutcome: "HUMAN_CONTACT", recordingUrl: "https://app.dapta.ai/calls/synthetic-late", durationSeconds: 81 };
  await f.result(initial, result); await f.result(initial, result);
  const [row] = await f.events();
  assert.equal(row.status, "COMPLETED"); assert.equal(row.communicationOutcome, "HUMAN_CONTACT");
  assert.equal(row.recordingUrl, result.recordingUrl); assert.equal(row.durationSeconds, 81);
  f.advance(86400000); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.events()).length, 1);
});

test("deployment-gap adoption stops completed initials and preserves a genuinely pending first call", async t => {
  const f = await fixture(t, { count: 2, env: { DAPTA_WELCOME_VOICE_AUTOMATIC_START_AT: "2026-10-09T13:59:00.000Z" } });
  await f.enqueue(1);
  const [initial] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(initial);
  const original = (await f.events())[0]; await f.enqueue(2, "INDIVIDUAL_IMPORT");
  await f.db.exec('DELETE FROM "CreditWelcomeVoiceFollowup"');
  f.advance(300000);
  const adopted = await f.store.claimPendingCreditWelcomeVoice();
  assert.deepEqual(Array.from(adopted, row => row.creditId), [2]);
  assert.equal((await f.followups()).find(row => row.creditoId === 1).phase, "STOPPED");
  assert.deepEqual((await f.events())[0], original);
  assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(adopted[0].eventId));
});

test("automatic sources share one credit-wide limit while an explicit operator call remains available", async t => {
  const f = await fixture(t); await f.enqueue();
  const [initial] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(initial);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "same-credit", startDate: "2026-10-09", creditIds: [1] });
  f.time("2026-10-09T15:00:00Z");
  assert.equal((await f.store.claimVoiceReviewCampaign({ campaignId: "same-credit", slot: "2026-10-09T10:00" })).length, 0);
  assert.equal((await f.db.query('SELECT "state" FROM "VoiceReviewCampaignMember"')).rows[0].state, "STOPPED");
  const operator = await f.store.prepareCreditWelcomeVoiceOperatorCall({ creditId: 1, requestId: "33333333-3333-4333-8333-333333333333",
    actorId: 7, phone: "3000000002" });
  assert.equal(operator.created, true); assert.equal(operator.destinationPhone, "573000000002");
  const prepared = await f.store.prepareCreditWelcomeVoiceDispatch(operator.eventId);
  assert.equal(prepared.destinationPhone, "573000000002");
  assert.equal(prepared.snapshot.phone, initial.snapshot.phone);
  assert.equal((await f.events()).filter(row => row.source === "NORMAL").length, 1);
});

test("a first scheduled call with nonzero attempt number is allowed but it blocks a later normal stream", async t => {
  const f = await fixture(t);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "first-scheduled", startDate: "2026-10-09", creditIds: [1] });
  f.time("2026-10-09T15:00:00Z");
  const [scheduled] = await f.store.claimVoiceReviewCampaign({ campaignId: "first-scheduled", slot: "2026-10-09T10:00" });
  assert.equal((await f.events())[0].attemptNumber, 1);
  // A concurrent creation hook cannot add a NORMAL/PENDING event that would
  // suppress this already reserved, still-unsent first scheduled call.
  assert.equal(await f.enqueue(), null);
  assert.ok(await f.store.prepareVoiceReviewCampaign(scheduled.eventId)); await f.result(scheduled);
  assert.equal(await f.enqueue(), null);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.events()).some(row => row.source === "NORMAL"), false);
  assert.equal((await f.events()).filter(row => row.source === "SCHEDULED_CAMPAIGN").length, 1);
});

test("a legacy scheduled claim is blocked before HTTP when another automatic source already attempted the credit", async t => {
  const f = await fixture(t);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "claimed-before-policy", startDate: "2026-10-09", creditIds: [1] });
  f.time("2026-10-09T15:00:00Z");
  const [scheduled] = await f.store.claimVoiceReviewCampaign({ campaignId: "claimed-before-policy", slot: "2026-10-09T10:00" });
  const previous = "66666666-6666-4666-8666-666666666666";
  await f.db.query('INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","status","snapshot","dispatchedAt","resultCode") VALUES ($1,1,\'NORMAL\',0,\'FAILED\',$2::jsonb,$3,\'CALL_FAILED\')',
    [previous, JSON.stringify(scheduled.snapshot), f.now()]);
  const original = (await f.events()).find(row => row.id === previous);
  assert.equal(await f.store.prepareVoiceReviewCampaign(scheduled.eventId), null);
  const rows = await f.events(); assert.deepEqual(rows.find(row => row.id === previous), original);
  assert.equal(rows.find(row => row.id === scheduled.eventId).status, "CANCELLED");
  assert.equal((await f.db.query('SELECT "state" FROM "VoiceReviewCampaignMember"')).rows[0].state, "STOPPED");
});

test("first-call financial and contact guards still reject changed data before HTTP", async t => {
  const f = await fixture(t, { count: 3 });
  for (let id = 1; id <= 3; id++) await f.enqueue(id);
  const claims = await f.store.claimPendingCreditWelcomeVoice();
  await f.update(1, { estado: "ANULADO" }); await f.update(2, { clienteTelefono: "3000000002" }); await f.update(3, { cuotaInicial: 201 });
  for (const claim of claims) assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(claim.eventId), null);
  assert.deepEqual((await f.events()).map(row => row.resultCode), ["CREDIT_CLOSED", "CONTACT_CHANGED", "CONDITIONS_CHANGED"]);
});

test("explicit opt-out and operator exclusion remain authoritative for manual requests", async t => {
  const f = await fixture(t, { count: 2 });
  await f.enqueue(1);
  const [initial] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(initial, { communicationOutcome: "OPT_OUT" });
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall({ creditId: 1, requestId: "44444444-4444-4444-8444-444444444444", actorId: 7 }),
    error => error.code === "OPT_OUT");
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "excluded", startDate: "2026-10-09", creditIds: [2] });
  await f.db.exec('UPDATE "VoiceReviewCampaignMember" SET "state"=\'STOPPED\',"stopReason"=\'OPERATOR_EXCLUDED\'');
  await f.enqueue(2); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall({ creditId: 2, requestId: "55555555-5555-4555-8555-555555555555", actorId: 7 }),
    error => error.code === "OPERATOR_EXCLUDED");
});

test("a controlled test is explicit, ignored by automatic adoption and unchanged by the new limit", async t => {
  const f = await fixture(t); const initial = await f.enqueue();
  const controlled = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "3000000001" });
  assert.equal(controlled.eventId, initial.eventId);
  assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(controlled.eventId));
  await f.result(controlled, { communicationOutcome: "HUMAN_CONTACT" });
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.events())[0].source, "CONTROLLED_TEST");
  const disabled = await fixture(t, { enabled: false });
  assert.equal(await disabled.enqueue(), null);
  assert.equal((await disabled.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal(disabled.queries(), 0);
});
