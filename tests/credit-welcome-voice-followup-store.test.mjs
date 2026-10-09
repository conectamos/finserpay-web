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
  return { db, store, enqueue, events, followups, accepted, result, update, env, queries: () => queries,
    now: () => time, time: value => { time = new Date(value); }, advance: ms => { time = new Date(time.getTime() + ms); }, rollback: () => { rollback = true; } };
}

test("five real attempts total wait five minutes after each no-answer, then use unique daily Colombia slots", async t => {
  const f = await fixture(t);
  const initial = await f.enqueue();
  let event = (await f.store.claimPendingCreditWelcomeVoice())[0];
  assert.equal(event.eventId, initial.eventId);
  for (let attempt = 1; attempt <= 5; attempt++) {
    assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(event.eventId));
    await f.accepted(event); f.advance(30_000); await f.result(event);
    assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
    const row = (await f.followups())[0];
    assert.equal(row.fastAttempts, attempt);
    if (attempt < 5) {
      assert.equal(row.phase, "FAST");
      assert.equal(new Date(row.nextAttemptAt).getTime(), f.now().getTime() + 300_000);
      f.advance(299_999); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
      f.advance(1); event = (await f.store.claimPendingCreditWelcomeVoice())[0]; assert.ok(event);
    } else {
      assert.equal(row.phase, "PENDING");
      assert.equal(new Date(row.nextAttemptAt).toISOString(), "2026-10-09T15:00:00.000Z");
    }
  }
  assert.equal((await f.events()).length, 5);
  assert.deepEqual((await f.events()).map(row => row.source), ["NORMAL", ...Array(4).fill("AUTOMATIC_RETRY")]);
  f.time("2026-10-09T14:59:59.999Z"); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  f.time("2026-10-09T15:00:00Z");
  const pending = (await Promise.all([f.store.claimPendingCreditWelcomeVoice(), f.store.claimPendingCreditWelcomeVoice()])).flat();
  assert.equal(pending.length, 1);
  const record = (await f.events()).at(-1);
  assert.equal(record.retryPhase, "PENDING"); assert.equal(record.retrySlot, "2026-10-09T10:00");
  assert.equal(record.campaignId, null); assert.equal(record.repeatOf, null);
  await f.accepted(pending[0]); f.advance(60_000); await f.result(pending[0]);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.followups())[0].fastAttempts, 5);
  f.time("2026-10-09T19:10:00Z"); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  f.time("2026-10-10T13:00:00Z");
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 1);
  assert.equal((await f.events()).at(-1).retrySlot, "2026-10-10T08:00");
});

test("unknown and in-flight calls never age into redial; only a late authentic no-answer releases unknown", async t => {
  const f = await fixture(t, { count: 3 });
  for (let id = 1; id <= 3; id++) await f.enqueue(id);
  const events = await f.store.claimPendingCreditWelcomeVoice();
  await f.store.markCreditWelcomeVoiceDispatchUnknown(events[0].eventId);
  await f.accepted(events[1]);
  await f.result(events[2], { communicationOutcome: "UNCERTAIN" });
  f.advance(24 * 60 * 60_000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.deepEqual((await f.followups()).map(row => [row.phase, row.reason]), [["HELD", "UNKNOWN_CALL"], ["FAST", "CALL_IN_FLIGHT"], ["HELD", "UNCERTAIN_RESULT"]]);
  await f.result(events[0]);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  f.advance(300_000);
  const [retry] = await f.store.claimPendingCreditWelcomeVoice();
  assert.equal(retry.creditId, 1); assert.notEqual(retry.eventId, events[0].eventId);
  assert.equal((await f.followups())[0].fastAttempts, 1);
});

test("real verified contact and refusals stop following even when approval is already approved", async t => {
  const f = await fixture(t, { count: 4 });
  for (let id = 1; id <= 4; id++) await f.enqueue(id);
  const events = await f.store.claimPendingCreditWelcomeVoice();
  await f.result(events[0], { communicationOutcome: "HUMAN_CONTACT" });
  await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: events[1].eventId, creditId: 2, requireFreshDispatch: true,
    customerName: "Ana", customerDocument: "00123456" });
  await f.result(events[1], { communicationOutcome: "UNCERTAIN" });
  await f.result(events[2], { communicationOutcome: "OPT_OUT" });
  await f.result(events[3], { communicationOutcome: "NO_ANSWER", resultCode: "RECORDING_DECLINED" });
  f.advance(300_000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.deepEqual((await f.followups()).map(row => row.phase), ["CONTACTED", "CONTACTED", "STOPPED", "STOPPED"]);
  assert.equal((await f.db.query('SELECT COUNT(*)::integer AS count FROM "CreditApprovalReview" WHERE "status"=\'APPROVED\'')).rows[0].count, 4);
});

test("paid or changed credits stop or hold retries while preserving the original completed snapshot", async t => {
  const f = await fixture(t, { count: 3 });
  for (let id = 1; id <= 3; id++) await f.enqueue(id);
  const events = await f.store.claimPendingCreditWelcomeVoice();
  for (const event of events) await f.result(event);
  const before = await f.events();
  await f.update(1, { estado: "PAGADO" });
  await f.update(2, { clienteTelefono: "3000000002" });
  await f.update(3, { cuotaInicial: 201 });
  f.advance(300_000);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.deepEqual((await f.followups()).map(row => [row.phase, row.reason]), [["STOPPED", "CREDIT_CLOSED"], ["HELD", "CONTACT_CHANGED"], ["HELD", "CONDITIONS_CHANGED"]]);
  assert.deepEqual(await f.events(), before);
});

test("new queue and retry reservations roll back atomically and concurrent claims share their limit", async t => {
  const f = await fixture(t, { count: 2 });
  f.rollback(); await assert.rejects(f.enqueue());
  assert.equal((await f.events()).length, 0); assert.equal((await f.followups()).length, 0);
  await Promise.all([f.enqueue(), f.enqueue()]); await f.enqueue(2, "INDIVIDUAL_IMPORT");
  const first = (await Promise.all([f.store.claimPendingCreditWelcomeVoice({ limit: 1 }), f.store.claimPendingCreditWelcomeVoice({ limit: 1 })])).flat();
  assert.equal(first.length, 2); assert.equal(new Set(first.map(row => row.eventId)).size, 2);
  for (const event of first) await f.result(event);
  f.advance(300_000); f.rollback(); await assert.rejects(f.store.claimPendingCreditWelcomeVoice({ limit: 1 }));
  assert.equal((await f.events()).length, 2);
  const retries = (await Promise.all([f.store.claimPendingCreditWelcomeVoice({ limit: 1 }), f.store.claimPendingCreditWelcomeVoice({ limit: 1 })])).flat();
  assert.equal(retries.length, 2); assert.equal((await f.events()).length, 4);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("only initial real events at or after the configured start are adopted, and invalid adoption configuration does not disable new queues", async t => {
  const f = await fixture(t, { count: 4, env: { DAPTA_WELCOME_VOICE_AUTOMATIC_START_AT: "2026-10-09T14:00:00.000Z" } });
  f.time("2026-10-09T13:59:59.999Z"); const old = await f.enqueue(1);
  f.time("2026-10-09T14:00:00Z"); await f.enqueue(2, "INDIVIDUAL_IMPORT");
  await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 3, expectedPhone: "3000000001" });
  await f.db.exec('DELETE FROM "CreditWelcomeVoiceFollowup"');
  const claims = await f.store.claimPendingCreditWelcomeVoice();
  assert.deepEqual(Array.from(claims, row => row.creditId), [2]);
  assert.equal((await f.events()).find(row => row.id === old.eventId).status, "PENDING");
  assert.deepEqual((await f.followups()).map(row => row.creditoId), [2]);
  f.env.DAPTA_WELCOME_VOICE_AUTOMATIC_START_AT = "2026-02-30T14:00:00.000Z";
  await f.enqueue(4);
  assert.deepEqual(Array.from(await f.store.claimPendingCreditWelcomeVoice(), row => row.creditId), [4]);
  assert.equal((await f.followups()).length, 2);
});

test("deployment-gap adoption follows a real completed no-answer once and preserves its initial call evidence", async t => {
  const f = await fixture(t, { env: { DAPTA_WELCOME_VOICE_AUTOMATIC_START_AT: "2026-10-09T13:59:00.000Z" } });
  await f.enqueue(); const [initial] = await f.store.claimPendingCreditWelcomeVoice();
  await f.accepted(initial); f.advance(30_000); await f.result(initial);
  const before = (await f.events())[0];
  await f.db.exec('DELETE FROM "CreditWelcomeVoiceFollowup"');
  f.advance(20 * 60_000);
  const [retry] = await f.store.claimPendingCreditWelcomeVoice();
  assert.ok(retry && retry.eventId !== initial.eventId);
  const rows = await f.events(); assert.deepEqual(rows[0], before);
  assert.equal(rows[1].source, "AUTOMATIC_RETRY"); assert.equal(rows[1].retryPhase, "FAST");
  assert.equal((await f.followups())[0].fastAttempts, 1);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("a daily slot that closes before prepare cannot call or consume a real attempt and waits for the next slot", async t => {
  const f = await fixture(t);
  await f.enqueue(); const [first] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(first);
  // Reproduce five real historical FAST calls with authenticated ledger evidence.
  for (let n = 1; n < 5; n++) {
    f.advance(300_000); const [event] = await f.store.claimPendingCreditWelcomeVoice(); await f.result(event);
  }
  f.time("2026-10-09T15:09:59.999Z"); const [pending] = await f.store.claimPendingCreditWelcomeVoice();
  assert.ok(pending); f.advance(1);
  assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(pending.eventId), null);
  assert.equal((await f.events()).at(-1).resultCode, "WINDOW_CLOSED_BEFORE_DISPATCH");
  assert.equal((await f.followups())[0].fastAttempts, 5);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  f.time("2026-10-09T19:00:00Z"); const [retry] = await f.store.claimPendingCreditWelcomeVoice();
  assert.ok(retry); assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(retry.eventId));
  assert.equal((await f.events()).at(-1).retrySlot, "2026-10-09T14:00");
  assert.equal((await f.events()).at(-1).attemptNumber, 6);
});

test("a controlled test cannot be adopted or counted, and a disabled queue performs no database access", async t => {
  const f = await fixture(t);
  const initial = await f.enqueue();
  const controlled = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "3000000001" });
  assert.equal(controlled.eventId, initial.eventId); await f.result(controlled);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.followups())[0].phase, "STOPPED"); assert.equal((await f.followups())[0].fastAttempts, 0);
  const disabled = await fixture(t, { enabled: false });
  assert.equal(await disabled.enqueue(), null); assert.equal((await disabled.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal(disabled.queries(), 0);
});

test("a retry cancelled by final revalidation is known unsent and leaves the completed initial evidence intact", async t => {
  const f = await fixture(t, { count: 3 });
  for (let id = 1; id <= 3; id++) await f.enqueue(id);
  const first = await f.store.claimPendingCreditWelcomeVoice();
  for (const event of first) await f.result(event);
  const originals = await f.events(); f.advance(300_000);
  const retries = await f.store.claimPendingCreditWelcomeVoice();
  await f.update(1, { estado: "ANULADO" }); await f.update(2, { clienteTelefono: "3000000002" }); await f.update(3, { cuotaInicial: 201 });
  for (const event of retries) assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(event.eventId), null);
  const rows = await f.events();
  assert.deepEqual(rows.filter(row => row.attemptNumber === 0), originals);
  assert.deepEqual(rows.filter(row => row.attemptNumber > 0).map(row => [row.status, row.resultCode, row.providerCallId]), [
    ["CANCELLED", "CREDIT_CLOSED", null], ["SKIPPED", "CONTACT_CHANGED", null], ["SKIPPED", "CONDITIONS_CHANGED", null],
  ]);
  assert.deepEqual((await f.followups()).map(row => [row.phase, row.fastAttempts]), [["STOPPED", 1], ["HELD", 1], ["HELD", 1]]);
});

test("a genuine late refusal supersedes an in-flight identity confirmation without restoring a retry", async t => {
  const f = await fixture(t); await f.enqueue();
  const [event] = await f.store.claimPendingCreditWelcomeVoice(); await f.accepted(event);
  await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: event.eventId, creditId: 1, requireFreshDispatch: true,
    customerName: "Ana", customerDocument: "00123456" });
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.followups())[0].phase, "CONTACTED");
  await f.result(event, { communicationOutcome: "OPT_OUT" });
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.followups())[0].phase, "STOPPED");
  f.advance(24 * 60 * 60_000); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("real contacts and opt-outs stop both campaign claim and prepare; controlled owner contact never does", async t => {
  const f = await fixture(t, { count: 3 });
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "shared-guards", startDate: "2026-10-09", creditIds: [1, 2, 3] });
  await f.enqueue(1); await f.enqueue(2);
  const real = await f.store.claimPendingCreditWelcomeVoice();
  await f.result(real[0], { communicationOutcome: "HUMAN_CONTACT" }); await f.result(real[1], { communicationOutcome: "OPT_OUT" });
  const controlled = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 3, expectedPhone: "3000000001" });
  await f.result(controlled, { communicationOutcome: "HUMAN_CONTACT" });
  f.time("2026-10-09T15:00:00Z");
  const scheduled = await f.store.claimVoiceReviewCampaign({ campaignId: "shared-guards", slot: "2026-10-09T10:00" });
  assert.deepEqual(Array.from(scheduled, row => row.creditId), [3]);
  assert.deepEqual((await f.db.query('SELECT "state" FROM "VoiceReviewCampaignMember" ORDER BY "creditoId"')).rows.map(row => row.state), ["CONTACTED", "STOPPED", "ACTIVE"]);
  const other = "11111111-1111-4111-8111-111111111111";
  await f.db.query(`INSERT INTO "CreditWelcomeVoiceEvent" ("id","creditoId","source","attemptNumber","retryPhase","status","dispatchedAt")
    VALUES ($1,3,'AUTOMATIC_RETRY',2,'FAST','DISPATCHING',$2)`, [other, f.now()]);
  await f.result({ eventId: other, creditId: 3 }, { communicationOutcome: "OPT_OUT" });
  assert.equal(await f.store.prepareVoiceReviewCampaign(scheduled[0].eventId), null);
  assert.equal((await f.db.query('SELECT "state","stopReason" FROM "VoiceReviewCampaignMember" WHERE "creditoId"=3')).rows[0].state, "STOPPED");
  assert.equal((await f.events()).find(row => row.id === scheduled[0].eventId).status, "SKIPPED");
});

test("operator exclusion remains global even when a fresh automatic outbox event exists", async t => {
  const f = await fixture(t);
  await f.db.exec('UPDATE "CreditApprovalReview" SET "status"=\'PENDING\'');
  await f.store.ensureVoiceReviewCampaign({ id: "original-exclusion", startDate: "2026-10-09", creditIds: [1] });
  await f.db.exec(`UPDATE "VoiceReviewCampaignMember" SET "state"='STOPPED',"stopReason"='OPERATOR_EXCLUDED'`);
  await f.enqueue(); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.deepEqual((await f.followups()).map(row => [row.phase, row.reason]), [["STOPPED", "OPERATOR_EXCLUDED"]]);
  assert.equal((await f.events())[0].dispatchedAt, null);
});

test("retry DDL rejects null phase and malformed daily keys and preserves queue state on idempotent installation", async t => {
  const f = await fixture(t); await f.enqueue();
  const first = (await f.store.claimPendingCreditWelcomeVoice())[0]; await f.result(first);
  f.advance(300_000); await f.store.claimPendingCreditWelcomeVoice();
  const beforeEvents = await f.events(), beforeQueues = await f.followups();
  for (let repeat = 0; repeat < 2; repeat++) for (const statement of creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  assert.deepEqual(await f.events(), beforeEvents); assert.deepEqual(await f.followups(), beforeQueues);
  let sequence = 10;
  const insert = (phase, slot, attempt = 2) => f.db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","source","attemptNumber","retryPhase","retrySlot","status") VALUES ($1,1,'AUTOMATIC_RETRY',$2,$3,$4,'PENDING')`,
    [`00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, attempt, phase, slot]);
  for (const [phase, slot] of [[null, null], ["OTHER", null], ["FAST", "2026-10-09T10:00"], ["PENDING", null], ["PENDING", "2026-10-09T09:00"]]) {
    await assert.rejects(insert(phase, slot), error => error.code === "23514");
  }
  await insert("PENDING", "2026-10-09T10:00");
  await assert.rejects(insert("PENDING", "2026-10-09T10:00", 3), error => error.code === "23505");
});
