import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { creditWelcomeVoiceSchemaStatements } from "../scripts/credit-welcome-voice-schema.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const [core, plan, snapshot, cartera, phone, speech, campaign] = await Promise.all([
  jiti.import("../lib/credit-welcome-voice-core.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/credit-factory-snapshot.ts"), jiti.import("../lib/cartera-export.ts"),
  jiti.import("../lib/dapta-welcome.ts"), jiti.import("../lib/credit-welcome-voice-speech.ts"),
  jiti.import("../lib/credit-voice-review-campaign-core.ts"),
]);
const dispatcher = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-speech": speech,
  "@/lib/credit-welcome-voice-store": {},
}, { AbortSignal });
const dispatchConfig = { webhookUrl: "https://api.dapta.ai/synthetic-operator-test", secret: "synthetic-operator-dispatch-secret-at-least-32-characters",
  agentId: "4b68b7b8-382f-4f9a-8e1f-8b88665acf38" };
const now = new Date("2026-10-09T18:30:00.000Z");
const requestId = "98a7dfb4-a20d-482c-9411-8bff948ab001";
const requestId2 = "98a7dfb4-a20d-482c-9411-8bff948ab002";
const requestId3 = "98a7dfb4-a20d-482c-9411-8bff948ab003";
const input = (overrides = {}) => ({ creditId: 1, requestId, actorId: 51, ...overrides });
const sample = (id = 1, overrides = {}) => ({ id, folio: `FC-OPERATOR-TEST-${id}`,
  clienteNombre: "ANA MARÍA PRUEBA", clienteDocumento: "00123456", clienteTelefono: "3000000001",
  referenciaEquipo: null, equipoMarca: null, equipoModelo: null, estado: "ENTREGABLE", pazYSalvoEmitidoAt: null,
  cuotaInicial: 200, montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2026-10-17", fechaProximoPago: "2026-10-17", contratoSnapshot: null, planCapitalVigente: null, abonos: [],
  amortizacion: { numeroCuotas: 3, cuotaComercial: "100.00", frecuenciaPago: "QUINCENAL",
    cuotas: ["2026-10-17", "2026-11-02", "2026-11-17"].map((fechaVencimiento, index) => ({ numero: index + 1, fechaVencimiento, cuotaCobro: "100.00" })) },
  ...overrides });

async function fixture(t, { credits = [sample()], enabled = false } = {}) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY,"data" JSONB NOT NULL)');
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  for (const credit of credits) await db.query('INSERT INTO "Credito" VALUES ($1,$2::jsonb)', [credit.id, JSON.stringify(credit)]);
  let rollback = false, queries = 0, writes = 0, transactions = 0, flag = enabled;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries++; writes++; return (await connection.query(sql, values)).affectedRows; },
    credito: { findUnique: async ({ where }) => (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null },
  });
  const client = { ...adapter(db), $transaction: callback => db.transaction(async connection => {
    transactions++;
    const result = await callback(adapter(connection));
    if (rollback) { rollback = false; throw new Error("Synthetic operator rollback"); }
    return result;
  }) };
  const loaded = loadReissueModule("lib/credit-welcome-voice-store.ts", {
    "@/lib/prisma": { default: client }, "@/lib/credit-payment-plan": plan,
    "@/lib/credit-factory-snapshot": snapshot, "@/lib/cartera-export": cartera, "@/lib/dapta-welcome": phone,
    "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-speech": speech,
    "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
    "@/lib/credit-welcome-voice-followup-core": loadReissueModule("lib/credit-welcome-voice-followup-core.ts"),
    "@/lib/credit-voice-review-campaign-core": campaign,
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  }, { process: { env: {} } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => flag, now: () => now });
  const events = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId","attemptNumber"').then(result => result.rows);
  const requests = () => db.query('SELECT * FROM "CreditWelcomeVoiceOperatorRequest"').then(result => result.rows);
  const complete = call => store.saveCreditWelcomeVoiceResult({ eventId: call.eventId, creditId: call.creditId,
    providerCallId: `call-operator-${call.eventId}`, status: "COMPLETED", communicationOutcome: "HUMAN_CONTACT", completedAt: now.toISOString() });
  const update = fields => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [1, JSON.stringify(fields)]);
  return { db, client, store, loaded, events, requests, complete, update, queries: () => queries,
    writes: () => writes, transactions: () => transactions,
    rollbackNext: () => { rollback = true; }, setEnabled: value => { flag = value; } };
}

test("explicit operator call works with automatic flag off, audits its separate destination and preserves backend identity and callback scope", async t => {
  const f = await fixture(t);
  const beforeCredit = (await f.db.query('SELECT "data" FROM "Credito"')).rows;
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ phone: "+57 300 000 0002", expectedDocument: "00.123.456" }));
  assert.equal(call.created, true); assert.equal(call.status, "DISPATCHING"); assert.equal(call.destinationPhone, "573000000002");
  assert.equal(call.snapshot.phone, "573000000001"); assert.equal(call.snapshot.document, "00123456");
  const event = (await f.events())[0], metadata = (await f.requests())[0];
  assert.equal(event.source, "OPERATOR_REQUEST"); assert.equal(event.attemptNumber, 0); assert.equal(event.repeatOf, null);
  assert.equal(event.campaignId, null); assert.equal(event.retryPhase, null); assert.equal(event.status, "DISPATCHING");
  assert.equal(metadata.requestId, requestId); assert.equal(metadata.eventId, call.eventId); assert.equal(metadata.actorId, 51);
  assert.equal(metadata.destinationPhone, call.destinationPhone); assert.equal(metadata.reason, "MANUAL_WELCOME_CALL");
  assert.deepEqual((await f.db.query('SELECT "data" FROM "Credito"')).rows, beforeCredit);
  const prepared = await f.store.prepareCreditWelcomeVoiceDispatch(call.eventId);
  assert.equal(prepared.destinationPhone, call.destinationPhone); assert.equal(prepared.snapshot.phone, call.snapshot.phone);
  const identity = await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: call.eventId, requireFreshDispatch: true,
    customerName: "Ana", customerDocument: "cero cero uno dos tres cuatro cinco seis." });
  assert.equal(identity.verificado, true); assert.equal(identity.condiciones.installmentAmount, 100);
  assert.equal("phone" in identity.condiciones, false); assert.equal("document" in identity.condiciones, false);
  await f.complete(call); await f.store.markCreditWelcomeVoiceDispatchAccepted(call.eventId, `call-operator-${call.eventId}`);
  assert.equal((await f.events())[0].status, "COMPLETED"); assert.ok((await f.events())[0].identityVerifiedAt);
  assert.equal((await f.db.query('SELECT count(*)::int AS count FROM "CreditWelcomeVoiceFollowup"')).rows[0].count, 0);
  f.setEnabled(true); assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("concurrent same-key requests create one call; replays report current status and cannot change credit, actor, document or destination", async t => {
  const f = await fixture(t, { credits: [sample(), sample(2)] });
  const results = await Promise.all([f.store.prepareCreditWelcomeVoiceOperatorCall(input()), f.store.prepareCreditWelcomeVoiceOperatorCall(input())]);
  assert.equal(results.filter(call => call.created).length, 1); assert.equal(new Set(results.map(call => call.eventId)).size, 1);
  const call = results[0];
  for (const change of [{ creditId: 2 }, { actorId: 52 }, { phone: "3000000002" }, { expectedDocument: "00123457" }]) {
    await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input(change)), error => error.code === "OPERATOR_CALL_REQUEST_MISMATCH");
  }
  await f.complete(call); await f.update({ estado: "PAGADO" });
  const replay = await f.store.prepareCreditWelcomeVoiceOperatorCall(input());
  assert.equal(replay.created, false); assert.equal(replay.eventId, call.eventId); assert.equal(replay.status, "COMPLETED");
  assert.equal((await f.events()).length, 1); assert.equal((await f.requests()).length, 1);
});

test("a new explicit request may follow real human contact without resetting history or automatic followup", async t => {
  const f = await fixture(t, { enabled: true });
  const initial = await f.client.$transaction(tx => f.store.enqueueCreditWelcomeVoice(tx, { creditId: 1, source: "NORMAL" }));
  await f.store.claimPendingCreditWelcomeVoice();
  await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: initial.eventId, requireFreshDispatch: true, customerName: "Ana", customerDocument: "00123456" });
  await f.complete({ ...initial, creditId: 1 });
  const history = (await f.events())[0], followup = (await f.db.query('SELECT * FROM "CreditWelcomeVoiceFollowup"')).rows;
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input());
  assert.equal(call.created, true); assert.equal((await f.events())[1].attemptNumber, 1);
  assert.deepEqual((await f.events())[0], history); assert.deepEqual((await f.db.query('SELECT * FROM "CreditWelcomeVoiceFollowup"')).rows, followup);
  assert.ok(await f.store.prepareCreditWelcomeVoiceDispatch(call.eventId));
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  await f.complete(call);
  const second = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId2 }));
  assert.equal(second.created, true); assert.equal((await f.events())[2].attemptNumber, 2);
});

test("pending, live and unknown calls block another request; concurrent different requests cannot reserve two calls", async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.store.prepareCreditWelcomeVoiceOperatorCall(input()),
    f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId2 }))]);
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(value => value.status === "rejected").reason.code, "OTHER_CALL_IN_FLIGHT");
  const call = outcomes.find(value => value.status === "fulfilled").value;
  for (const status of ["PENDING", "DISPATCHING", "ACCEPTED", "UNKNOWN"]) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2 WHERE "id"=$1::uuid', [call.eventId, status]);
    await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId3 })), error => error.code === "OTHER_CALL_IN_FLIGHT");
    const availability = await f.store.getCreditWelcomeVoiceOperatorAvailability(1);
    assert.equal(availability.canCall, false); assert.equal(availability.reason, "Hay una llamada pendiente o con resultado sin confirmar.");
  }
  assert.equal((await f.events()).length, 1); assert.equal((await f.requests()).length, 1);
});

test("manual request and metadata roll back together and validation rejects wrong credit, recipient or document before reservation", async t => {
  const f = await fixture(t);
  for (const change of [{ requestId: "bad" }, { actorId: 0 }, { creditId: 0 }, { phone: "555" }, { expectedDocument: "not-a-document" }]) {
    const before = f.queries();
    await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input(change)), error => error.code === "INVALID_OPERATOR_CALL");
    assert.equal(f.queries(), before);
  }
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ expectedDocument: "00123457" })), error => error.code === "OPERATOR_CALL_DOCUMENT_MISMATCH");
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ creditId: 999 })), error => error.code === "CREDIT_NOT_FOUND");
  f.rollbackNext(); await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input()), /Synthetic operator rollback/);
  assert.deepEqual(await f.events(), []); assert.deepEqual(await f.requests(), []);
  assert.equal((await f.store.prepareCreditWelcomeVoiceOperatorCall(input())).created, true);
});

test("schema upgrade preserves old calls, allows audited operator attempts and old installers never remove the additive support", async t => {
  const f = await fixture(t);
  const oldSource = execFileSync("git", ["show", "94c2f5e:scripts/credit-welcome-voice-schema.mjs"], { cwd: root, encoding: "utf8" });
  const oldModule = await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString("base64")}`);
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input());
  await f.complete(call); const history = await f.events(), audit = await f.requests();
  for (const statement of oldModule.creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  for (const statement of creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  assert.deepEqual(await f.events(), history); assert.deepEqual(await f.requests(), audit);
  assert.equal((await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId2 }))).created, true);
});

test("Codex-authorized calls require an explicit recipient and exact document and never invent a signed-in operator", async t => {
  const f = await fixture(t);
  const codex = input({ actorId: null, origin: "CODEX_AUTHORIZED", phone: "+573000000002", expectedDocument: "00123456" });
  for (const change of [{ phone: undefined }, { expectedDocument: undefined }, { actorId: 51 }, { origin: "UI" }, { origin: "UNKNOWN" }]) {
    const before = f.queries();
    await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall({ ...codex, ...change }), error => error.code === "INVALID_OPERATOR_CALL");
    assert.equal(f.queries(), before);
  }
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(codex);
  assert.equal(call.created, true); assert.equal(call.destinationPhone, "573000000002"); assert.equal(call.snapshot.phone, "573000000001");
  const row = (await f.requests())[0]; assert.equal(row.actorId, null); assert.equal(row.origin, "CODEX_AUTHORIZED");
  assert.equal((await f.store.prepareCreditWelcomeVoiceOperatorCall(codex)).created, false);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall({ ...codex, actorId: 51, origin: "UI" }), error => error.code === "OPERATOR_CALL_REQUEST_MISMATCH");
  const prepared = await f.store.prepareCreditWelcomeVoiceDispatch(call.eventId);
  assert.equal(prepared.destinationPhone, call.destinationPhone); assert.equal(prepared.snapshot.phone, call.snapshot.phone);
});

test("optout and operator exclusion prevent both a new manual request and its last-moment dispatch", async t => {
  const f = await fixture(t);
  const first = await f.store.prepareCreditWelcomeVoiceOperatorCall(input()); await f.complete(first);
  assert.equal((await f.store.getCreditWelcomeVoiceOperatorAvailability(1)).canCall, true);
  for (const change of [{ communicationOutcome: "OPT_OUT", resultCode: null },
    { communicationOutcome: "HUMAN_CONTACT", resultCode: "RECORDING_DECLINED" }]) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "communicationOutcome"=$2,"resultCode"=$3 WHERE "id"=$1::uuid', [first.eventId, change.communicationOutcome, change.resultCode]);
    await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId2 })), error => error.code === "OPT_OUT");
    const availability = await f.store.getCreditWelcomeVoiceOperatorAvailability(1);
    assert.equal(availability.canCall, false); assert.equal(availability.reason, "El cliente pidió no recibir llamadas o no autorizó la grabación.");
  }
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "communicationOutcome"=$2,"resultCode"=NULL WHERE "id"=$1::uuid', [first.eventId, "HUMAN_CONTACT"]);
  const second = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId2 }));
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "communicationOutcome"=$2 WHERE "id"=$1::uuid', [first.eventId, "OPT_OUT"]);
  assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(second.eventId), null);
  const cancelled = (await f.events())[1]; assert.equal(cancelled.status, "SKIPPED"); assert.equal(cancelled.resultCode, "OPT_OUT");
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "communicationOutcome"=$2 WHERE "id"=$1::uuid', [first.eventId, "HUMAN_CONTACT"]);
  const third = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: requestId3 }));
  await f.db.query('INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES ($1,$2,$3::jsonb)', ["operator-exclusion-test", "2026-10-09", "[1]"]);
  await f.db.query('INSERT INTO "VoiceReviewCampaignMember" ("campaignId","creditoId","state","stopReason") VALUES ($1,1,$2,$3)', ["operator-exclusion-test", "STOPPED", "OPERATOR_EXCLUDED"]);
  assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(third.eventId), null);
  const availability = await f.store.getCreditWelcomeVoiceOperatorAvailability(1);
  assert.equal(availability.canCall, false); assert.equal(availability.reason, "Este crédito está excluido de las llamadas.");
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: "98a7dfb4-a20d-482c-9411-8bff948ab004" })), error => error.code === "OPERATOR_EXCLUDED");
  assert.equal((await f.events()).length, 3); assert.equal((await f.requests()).length, 3);
});

test("paid credits and changes to the original phone or terms block the prepared call without moving its separate destination", async t => {
  const f = await fixture(t);
  const changes = [{ clienteTelefono: "3000000003" }, { cuotaInicial: 201 }, { estado: "PAGADO" },
    { abonos: [{ valor: 300, fechaAbono: "2026-10-09", estado: "APROBADO" }] }];
  for (let index = 0; index < changes.length; index++) {
    const request = `98a7dfb4-a20d-482c-9411-8bff948ab01${index}`;
    const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: request, phone: "3000000002" }));
    await f.update(changes[index]);
    assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(call.eventId), null);
    const event = (await f.events()).find(row => row.id === call.eventId), metadata = (await f.requests()).find(row => row.eventId === call.eventId);
    assert.ok(["CANCELLED", "SKIPPED"].includes(event.status));
    assert.equal(event.snapshot.phone, "573000000001"); assert.equal(metadata.destinationPhone, "573000000002");
    if (index >= 2) {
      await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ requestId: "98a7dfb4-a20d-482c-9411-8bff948ab021", phone: "3000000002" })),
        error => error.code === "OPERATOR_CALL_INELIGIBLE");
      assert.equal((await f.store.getCreditWelcomeVoiceOperatorAvailability(1)).canCall, false);
    }
    await f.db.query('UPDATE "Credito" SET "data"=$2::jsonb WHERE "id"=$1', [1, JSON.stringify(sample())]);
  }
});

test("operator request lookup is read-only and returns only current status to the same UI actor and credit", async t => {
  const f = await fixture(t, { credits: [sample(), sample(2)] });
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input());
  const before = { writes: f.writes(), transactions: f.transactions(), events: await f.events(), requests: await f.requests() };
  const lookup = await f.store.getCreditWelcomeVoiceOperatorRequest(input());
  assert.deepEqual(lookup, { eventId: call.eventId, status: "DISPATCHING" });
  assert.deepEqual(Object.keys(lookup).sort(), ["eventId", "status"]);
  assert.equal(f.writes(), before.writes); assert.equal(f.transactions(), before.transactions);
  for (const override of [{ actorId: 52 }, { creditId: 2 }, { requestId: requestId2 }]) {
    assert.equal(await f.store.getCreditWelcomeVoiceOperatorRequest(input(override)), null);
  }
  assert.deepEqual(await f.events(), before.events); assert.deepEqual(await f.requests(), before.requests);
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2 WHERE "id"=$1::uuid', [call.eventId, "UNKNOWN"]);
  assert.deepEqual(await f.store.getCreditWelcomeVoiceOperatorRequest(input()), { eventId: call.eventId, status: "UNKNOWN" });
  const codex = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ creditId: 2, requestId: requestId2, actorId: null,
    origin: "CODEX_AUTHORIZED", phone: "3000000002", expectedDocument: "00123456" }));
  const afterCodex = { writes: f.writes(), transactions: f.transactions() };
  assert.ok(codex.eventId);
  assert.equal(await f.store.getCreditWelcomeVoiceOperatorRequest(input({ creditId: 2, requestId: requestId2 })), null);
  assert.equal(f.writes(), afterCodex.writes); assert.equal(f.transactions(), afterCodex.transactions);
});

test("operator request lookup rejects invalid UUID or IDs before querying", async t => {
  const f = await fixture(t);
  const queries = f.queries();
  for (const override of [{ requestId: "bad" }, { requestId: `${requestId}suffix` }, { actorId: 0 },
    { actorId: null }, { actorId: 2_147_483_648 }, { creditId: 0 }, { creditId: Number.NaN }]) {
    await assert.rejects(f.store.getCreditWelcomeVoiceOperatorRequest(input(override)), error => error.code === "INVALID_OPERATOR_CALL");
  }
  assert.equal(f.queries(), queries); assert.equal(f.writes(), 0); assert.equal(f.transactions(), 0);
});

test("UI alternate destination is audited, canonical replays do not redial and real dispatcher keeps the original credit intact", async t => {
  const f = await fixture(t), received = [];
  const beforeCredit = (await f.db.query('SELECT "data" FROM "Credito" WHERE "id"=1')).rows[0].data;
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ phone: "+57 300 000 0002" }));
  const originalSnapshot = (await f.events())[0].snapshot;
  const metadata = (await f.requests())[0];
  assert.equal(metadata.origin, "UI"); assert.equal(metadata.actorId, 51); assert.equal(metadata.destinationPhone, "573000000002");
  assert.equal(originalSnapshot.phone, "573000000001"); assert.equal(originalSnapshot.initialPayment, 200);
  assert.deepEqual(originalSnapshot.installmentAmounts, [100, 100, 100]);
  const deps = { config: dispatchConfig, ensureSchema: async () => {}, claim: async () => [call],
    prepare: f.store.prepareCreditWelcomeVoiceDispatch,
    accepted: f.store.markCreditWelcomeVoiceDispatchAccepted, failed: f.store.markCreditWelcomeVoiceDispatchFailed,
    unknown: f.store.markCreditWelcomeVoiceDispatchUnknown,
    fetcher: async (url, options) => {
      received.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true, call_id: "call-ui-alternate-destination" });
    } };
  assert.equal((await dispatcher.dispatchCreditWelcomeVoice({}, deps)).accepted, 1);
  assert.equal(received.length, 1); assert.equal(received[0].body.to_number, "+573000000002");
  assert.equal(received[0].body.customer_name, originalSnapshot.name);
  assert.equal(received[0].body.customer_document, originalSnapshot.document);
  assert.equal(JSON.stringify(received[0].body).includes(originalSnapshot.phone), false);
  for (const field of ["snapshot", "initialPayment", "installmentAmount", "installmentCount", "firstDueDate", "calendar"]) {
    assert.equal(field in received[0].body, false);
  }
  const token = core.verifyWelcomeVoiceToken(received[0].body.event_token, { secret: dispatchConfig.secret });
  assert.equal(token.eventId, call.eventId); assert.equal(token.creditId, 1);
  for (const canonicalPhone of ["3000000002", "573000000002", "+573000000002", "+57 300 000 0002"]) {
    const replay = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ phone: canonicalPhone }));
    assert.equal(replay.created, false); assert.equal(replay.eventId, call.eventId); assert.equal(replay.status, "ACCEPTED");
    assert.equal(replay.destinationPhone, "573000000002");
  }
  await assert.rejects(f.store.prepareCreditWelcomeVoiceOperatorCall(input({ phone: "3000000003" })), error => error.code === "OPERATOR_CALL_REQUEST_MISMATCH");
  assert.equal(received.length, 1); assert.equal((await f.events()).length, 1); assert.equal((await f.requests()).length, 1);
  assert.deepEqual((await f.events())[0].snapshot, originalSnapshot);
  assert.deepEqual((await f.db.query('SELECT "data" FROM "Credito" WHERE "id"=1')).rows[0].data, beforeCredit);
});

test("an alternate destination never bypasses original-contact revalidation before the real dispatcher fetch", async t => {
  const f = await fixture(t);
  const call = await f.store.prepareCreditWelcomeVoiceOperatorCall(input({ phone: "3000000002" }));
  await f.update({ clienteTelefono: "3000000003" });
  const result = await dispatcher.dispatchCreditWelcomeVoice({}, {
    config: dispatchConfig, ensureSchema: async () => {}, claim: async () => [call], prepare: f.store.prepareCreditWelcomeVoiceDispatch,
    accepted: async () => assert.fail("A rejected prepare must not be accepted"),
    failed: async () => assert.fail("Revalidation owns the local rejection"), unknown: async () => assert.fail("No external request was made"),
    fetcher: async () => assert.fail("Changed original contact must never reach the provider"),
  });
  assert.equal(result.accepted, 0); assert.equal(result.skipped, 1);
  const event = (await f.events())[0]; assert.equal(event.status, "SKIPPED"); assert.equal(event.resultCode, "CONTACT_CHANGED");
  assert.equal(event.snapshot.phone, "573000000001"); assert.equal((await f.requests())[0].destinationPhone, "573000000002");
});
