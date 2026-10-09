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
const documentParser = loadReissueModule("lib/credit-welcome-voice-document.ts");
const [core, plan, snapshot, cartera, phone, speech, campaignPolicy] = await Promise.all([
  jiti.import("../lib/credit-welcome-voice-core.ts"),
  jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/credit-factory-snapshot.ts"),
  jiti.import("../lib/cartera-export.ts"),
  jiti.import("../lib/dapta-welcome.ts"),
  jiti.import("../lib/credit-welcome-voice-speech.ts"),
  jiti.import("../lib/credit-voice-review-campaign-core.ts"),
]);
const http = loadReissueModule("lib/credit-welcome-voice-http.ts", {
  "@/lib/roles": loadReissueModule("lib/roles.ts"),
  "@/lib/aliados": loadReissueModule("lib/aliados.ts"),
  "@/lib/credit-route-lookup": loadReissueModule("lib/credit-route-lookup.ts"),
  "@/lib/credit-welcome-voice-document": loadReissueModule("lib/credit-welcome-voice-document.ts"),
  "@/lib/credit-welcome-voice-phone": loadReissueModule("lib/credit-welcome-voice-phone.ts"),
});
const now = new Date("2026-10-08T15:00:00.000Z");
const flowSecret = "synthetic-dedicated-identity-flow-key-32-or-more";
const bearer = `Bearer ${flowSecret}`;
const actualName = "Luz, que esté a la Hernández.";
const actualDocuments = [
  "Treinta y ocho, uno cuarenta y cuatro, cero nueve dos.",
  "treinta y ocho, ciento cuarenta y cuatro, cero noventa y dos.",
];
const calendar = ["2026-10-17", "2026-11-02", "2026-11-17"];
// The utterances are the observed payload. Financial terms and contact are synthetic.
const credit = () => ({
  id: 72, folio: "FC-ASR-TEST-72", clienteNombre: "LUZ HERNANDEZ",
  clienteDocumento: "38144092", clienteTelefono: "3000000001",
  referenciaEquipo: null, equipoMarca: null, equipoModelo: null,
  estado: "INSCRITO", pazYSalvoEmitidoAt: null, cuotaInicial: 200000,
  montoCredito: 477450, valorCuota: 159150, plazoMeses: 3, frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: calendar[0], fechaProximoPago: calendar[0],
  contratoSnapshot: null, planCapitalVigente: null, abonos: [],
  amortizacion: { numeroCuotas: 3, cuotaComercial: "159150.00", frecuenciaPago: "QUINCENAL",
    cuotas: calendar.map((fechaVencimiento, index) => ({ numero: index + 1, fechaVencimiento, cuotaCobro: "159150.00" })) },
});

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "data" JSONB NOT NULL)');
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  await db.query('INSERT INTO "Credito" ("id","data") VALUES ($1,$2::jsonb)', [72, JSON.stringify(credit())]);
  let queries = 0, writes = 0;
  let rollback = false;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries++; writes++; return (await connection.query(sql, values)).affectedRows; },
    credito: { findUnique: async ({ where, select }) => {
      assert.equal(select.amortizacion.select.cuotas.orderBy.numero, "asc");
      assert.equal(select.abonos.where.estado.not, "ANULADO");
      queries++;
      return (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null;
    } },
  });
  const client = { ...adapter(db), $transaction: callback => db.transaction(async connection => {
    const value = await callback(adapter(connection));
    if (rollback) { rollback = false; throw new Error("Synthetic recovery rollback"); }
    return value;
  }) };
  const loaded = loadReissueModule("lib/credit-welcome-voice-store.ts", {
    "@/lib/prisma": { default: client }, "@/lib/credit-payment-plan": plan,
    "@/lib/credit-factory-snapshot": snapshot, "@/lib/cartera-export": cartera,
    "@/lib/dapta-welcome": phone, "@/lib/credit-welcome-voice-core": core,
    "@/lib/credit-welcome-voice-speech": speech,
    "@/lib/credit-welcome-voice-document": documentParser,
    "@/lib/credit-welcome-voice-followup-core": loadReissueModule("lib/credit-welcome-voice-followup-core.ts"),
    "@/lib/credit-voice-review-campaign-core": campaignPolicy,
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  }, { process: { env: {} } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => true, now: () => now });
  const { eventId } = await client.$transaction(tx => store.enqueueCreditWelcomeVoice(tx, { creditId: 72, source: "NORMAL" }));
  const POST = http.createCreditWelcomeVoiceIdentityHandler({
    verifyToken: value => core.verifyWelcomeVoiceToken(value, { secret: "synthetic-legacy-token-secret-with-32-characters", now }),
    verifyFlowAuthorization: value => core.verifyWelcomeVoiceIdentityFlowAuthorization(value, { secret: flowSecret }),
    verifyIdentity: store.verifyCreditWelcomeVoiceIdentity,
  });
  const post = async (overrides = {}, authorization = bearer) => {
    const response = await POST(new Request("https://finser.test/api/integraciones/dapta/bienvenida-voz/identidad", {
      method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ event_id: eventId, customer_name: actualName, customer_document: actualDocuments[0], ...overrides }),
    }));
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    return { status: response.status, body: await response.json() };
  };
  const row = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid', [eventId]).then(result => result.rows[0]);
  return { db, store, eventId, post, row, queries: () => queries, writes: () => writes,
    rollbackNext: () => { rollback = true; },
    claim: () => store.claimPendingCreditWelcomeVoice() };
}

function assertRegisteredConditions(body) {
  assert.equal(body.ok, true);
  assert.equal(body.verificado, true);
  assert.equal(body.nextAction, "CONTINUE"); assert.equal(body.code, null); assert.equal(body.question, null); assert.equal(body.mayEndCall, false);
  const value = body.condiciones;
  assert.equal(value.creditId, 72);
  assert.equal(value.folio, "FC-ASR-TEST-72");
  assert.equal(value.name, "luz hernandez");
  assert.equal(value.initialPayment, 200000);
  assert.equal(value.installmentCount, 3);
  assert.equal(value.installmentAmount, 159150);
  assert.equal(value.installmentsEqual, true);
  assert.deepEqual(value.installmentAmounts, [159150, 159150, 159150]);
  assert.equal(value.frequency, "QUINCENAL");
  assert.equal(value.firstDueDate, calendar[0]);
  assert.deepEqual(value.calendar, calendar);
  assert.equal(value.speech.installmentAmount, "ciento cincuenta y nueve mil ciento cincuenta pesos");
  for (const key of ["document", "phone", "event_token", "identityAttempts"]) assert.equal(key in value, false);
}
function assertRecovery(body, nextAction = "REVIEW", remainingAttempts = 0, code = "IDENTITY_NOT_CONFIRMED") {
  assert.deepEqual(body, { ok: true, verificado: false, condiciones: null, code, nextAction, remainingAttempts,
    question: nextAction === "ASK_NAME" ? "¿Me dice solo su primer nombre, por favor?"
      : nextAction === "ASK_DOCUMENT" ? "¿Me repite su cédula completa, desde el primer dígito, con una pausa entre cada número?" : "No pude confirmar sus datos. Un asesor revisará su caso.",
    mayEndCall: nextAction === "REVIEW" });
}
function assertRecoveryState(row, expected) {
  const { lastFailure, failedInputHashes, ...flags } = row.identityRecovery;
  assert.deepEqual(flags, expected);
  if (lastFailure) {
    assert.deepEqual(Object.keys(lastFailure).sort(), ["attempts", "code", "inputHash", "nextAction"]);
    assert.match(lastFailure.inputHash, /^[a-f0-9]{64}$/);
    assert.equal(lastFailure.attempts, row.identityAttempts);
    assert.ok(failedInputHashes.includes(lastFailure.inputHash));
    assert.equal(new Set(failedInputHashes).size, failedInputHashes.length);
    assert.ok(failedInputHashes.length <= row.identityAttempts);
  }
  return lastFailure;
}

test("observed ASR payloads pass HTTP, literal parsing and the real store, persisting verified identity and registered conditions", async t => {
  for (let index = 0; index < actualDocuments.length; index++) await t.test(`observed utterance ${index + 1}`, async subtest => {
    const f = await fixture(subtest);
    const claims = await f.claim();
    assert.equal(claims.length, 1);
    assert.equal((await f.row()).identityAttempts, 0);
    const response = await f.post({ customer_document: actualDocuments[index], credit_id: 999,
      identity_confirmed: false, initialPayment: 1, installmentAmount: 1, installmentCount: 99 });
    assert.equal(response.status, 200);
    assertRegisteredConditions(response.body);
    const persisted = await f.row();
    assert.equal(persisted.creditoId, 72);
    assert.equal(persisted.status, "DISPATCHING");
    assert.equal(persisted.identityAttempts, 1);
    assert.equal(new Date(persisted.identityVerifiedAt).toISOString(), now.toISOString());
    assert.equal(persisted.snapshot.document, "38144092");
    assert.equal(persisted.snapshot.installmentAmount, response.body.condiciones.installmentAmount);
    const retry = await f.post({ customer_document: actualDocuments[index] });
    assertRegisteredConditions(retry.body);
    assert.equal((await f.row()).identityAttempts, 1);
  });
});

test("private authorization and an unambiguous transport are required before the real store can read or verify", async t => {
  const f = await fixture(t);
  await f.claim();
  const before = f.queries();
  for (const authorization of [null, "Bearer wrong", `${bearer}-other`]) {
    const response = await f.post({}, authorization);
    assert.equal(response.status, 401);
    assert.equal(response.body.code, "UNAUTHORIZED");
    assert.equal("condiciones" in response.body, false);
  }
  const mixed = await f.post({ event_token: "untrusted-model-value" });
  assert.equal(mixed.status, 400);
  assert.equal(f.queries(), before);
  assert.equal((await f.row()).identityAttempts, 0);
  assert.equal((await f.row()).identityVerifiedAt, null);
});

test("ambiguous document consumes a persisted attempt, then missing name can recover before verification", async t => {
  const f = await fixture(t);
  await f.claim();
  const ambiguous = await f.post({ customer_document: "doscientos cuarenta y cuatro veinte." });
  assertRecovery(ambiguous.body, "ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD");
  assert.equal((await f.row()).identityAttempts, 1);
  assertRecovery((await f.post({ customer_name: "Clara García." })).body, "ASK_NAME", 1);
  assert.equal((await f.row()).identityVerifiedAt, null);
  assert.equal((await f.row()).identityAttempts, 2);
  assertRegisteredConditions((await f.post()).body);
  assert.equal((await f.row()).identityAttempts, 3);
  assert.ok((await f.row()).identityVerifiedAt);
  assertRecovery((await f.post({ customer_document: "38144093." })).body);
  assert.equal((await f.row()).identityAttempts, 3);
});

test("three distinct backend mismatches lock the event even when the next HTTP payload contains the correct spoken identity", async t => {
  const f = await fixture(t);
  await f.claim();
  for (let attempt = 1; attempt <= 3; attempt++) {
    assertRecovery((await f.post({ customer_name: ["Clara García", "Ana García", "Marta García"][attempt - 1], customer_document: "38144093." })).body, ["ASK_NAME", "ASK_DOCUMENT", "REVIEW"][attempt - 1], attempt === 3 ? 0 : 3 - attempt);
    assert.equal((await f.row()).identityAttempts, attempt);
  }
  assertRecovery((await f.post()).body);
  assert.equal((await f.row()).identityAttempts, 3);
  assert.equal((await f.row()).identityVerifiedAt, null);
});

test("the same ASR payload cannot verify a pending, stale, future, missing or completed call event", async t => {
  const f = await fixture(t);
  assertRecovery((await f.post()).body);
  await f.claim();
  for (const dispatchedAt of [null, new Date(now.getTime() - 86400001), new Date(now.getTime() + 1)]) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [f.eventId, dispatchedAt]);
    assertRecovery((await f.post()).body);
  }
  assertRecovery((await f.post({ event_id: "ff968eac-0c3e-4b55-92e3-d4491e591ead" })).body);
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [f.eventId, now]);
  await f.store.saveCreditWelcomeVoiceResult({ eventId: f.eventId, creditId: 72,
    providerCallId: "call-asr-test-completed", status: "COMPLETED", summary: "Prueba aislada." });
  assertRecovery((await f.post()).body);
  assert.equal((await f.row()).identityAttempts, 0);
  assert.equal((await f.row()).identityVerifiedAt, null);
});

test("registered conditions and payment status are revalidated after dispatch before ASR verification can expose finances", async t => {
  const f = await fixture(t);
  await f.claim();
  for (const change of [
    { cuotaInicial: 1 }, { clienteTelefono: "3000000002" }, { estado: "PAGADO" },
    { abonos: [{ valor: 477450, fechaAbono: "2026-10-08", estado: "APROBADO" }] },
  ]) {
    await f.db.query('UPDATE "Credito" SET "data"=$2::jsonb WHERE "id"=$1', [72, JSON.stringify({ ...credit(), ...change })]);
    assertRecovery((await f.post()).body);
    assert.equal((await f.row()).identityAttempts, 0);
    assert.equal((await f.row()).identityVerifiedAt, null);
  }
  await f.db.query('UPDATE "Credito" SET "data"=$2::jsonb WHERE "id"=$1', [72, JSON.stringify(credit())]);
  assertRegisteredConditions((await f.post()).body);
  assert.equal((await f.row()).identityAttempts, 1);
});

test("one registered component plus exact document accepts the observed surname error without changing the strict matcher", async t => {
  const f = await fixture(t); await f.claim();
  const response = await f.post({ customer_name: "Luz Fernández Gil.", customer_document: "tres ocho uno cuatro cuatro cero nueve dos." });
  assertRegisteredConditions(response.body); assert.equal(response.body.remainingAttempts, 2);
  assert.equal((await f.row()).identityAttempts, 1);
  assert.equal(core.matchWelcomeVoiceIdentity({ name: "LUZ HERNANDEZ", document: "38144092" }, { name: "Luz Fernández Gil.", document: "38144092" }), false);
});
test("an acceptable name with a different complete document asks only for the document and correction can continue", async t => {
  const f = await fixture(t); await f.claim();
  assertRecovery((await f.post({ customer_name: "Luz", customer_document: "38144093" })).body, "ASK_DOCUMENT", 2);
  assertRecoveryState(await f.row(), { askedName: false, askedDocument: true, reviewRequired: false });
  const corrected = await f.post({ customer_name: "Luz", customer_document: "38144092" });
  assertRegisteredConditions(corrected.body); assert.equal(corrected.body.remainingAttempts, 1); assert.equal((await f.row()).identityAttempts, 2);
});
test("a first name mismatch asks for the real name and cannot close; corrected name verifies on the next attempt", async t => {
  const f = await fixture(t); await f.claim();
  assertRecovery((await f.post({ customer_name: "Clara Fernández Gil." })).body, "ASK_NAME", 2);
  assertRecoveryState(await f.row(), { askedName: true, askedDocument: false, reviewRequired: false });
  const good = await f.post({ customer_name: "Hernández" }); assertRegisteredConditions(good.body);
  assert.equal(good.body.remainingAttempts, 1); assert.equal((await f.row()).identityAttempts, 2);
});
test("identical unrecognized documents reuse guidance; a different failed clarification ends recovery and legacy cannot bypass it", async t => {
  const f = await fixture(t); await f.claim();
  const bad = { customer_document: "doscientos cuarenta y cuatro veinte." };
  assertRecovery((await f.post(bad)).body, "ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD");
  const before = await f.row(), writes = f.writes();
  assertRecovery((await f.post({ customer_document: "  DOSCIENTOS  cuarenta y cuatro VEINTE.  " })).body, "ASK_DOCUMENT", 2, "DOCUMENT_NOT_UNDERSTOOD");
  assert.deepEqual((await f.row()).identityRecovery, before.identityRecovery);
  assert.equal((await f.row()).identityAttempts, 1); assert.equal(f.writes(), writes);
  const distinctBad = { customer_document: "treinta ocho" };
  assertRecovery((await f.post(distinctBad)).body, "REVIEW", 0, "DOCUMENT_NOT_UNDERSTOOD");
  const terminal = await f.row();
  assertRecovery((await f.post(distinctBad)).body, "REVIEW", 0, "DOCUMENT_NOT_UNDERSTOOD");
  assert.deepEqual((await f.row()).identityRecovery, terminal.identityRecovery);
  assertRecovery((await f.post()).body);
  assert.equal((await f.row()).identityAttempts, 2); assert.equal((await f.row()).identityVerifiedAt, null);
  const legacy = await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: f.eventId, creditId: 72, customerName: "LUZ HERNANDEZ", customerDocument: "38144092" });
  assert.deepEqual(JSON.parse(JSON.stringify(legacy)), { verificado: false });
});
test("unrecognized documents share the same three-attempt budget with name corrections", async t => {
  const f = await fixture(t); await f.claim();
  assertRecovery((await f.post({ customer_name: "Clara García" })).body, "ASK_NAME", 2);
  assertRecovery((await f.post({ customer_document: "un documento desconocido" })).body, "ASK_DOCUMENT", 1, "DOCUMENT_NOT_UNDERSTOOD");
  assertRecovery((await f.post({ customer_document: "treinta ocho" })).body, "REVIEW", 0, "DOCUMENT_NOT_UNDERSTOOD");
  assert.equal((await f.row()).identityAttempts, 3); assertRecovery((await f.post()).body);
});
test("concurrent identical recovery requests consume one attempt and rollback cannot save budget, flags or a replay hash", async t => {
  const f = await fixture(t); await f.claim();
  f.rollbackNext(); const failed = await f.post({ customer_document: "treinta ocho" }); assert.equal(failed.status, 503);
  assert.equal((await f.row()).identityAttempts, 0); assert.deepEqual((await f.row()).identityRecovery, {});
  const results = await Promise.all([f.post({ customer_name: "Clara García" }), f.post({ customer_name: "Clara García" })]);
  assert.deepEqual(results[0].body, results[1].body);
  assertRecovery(results[0].body, "ASK_NAME", 2);
  assert.equal((await f.row()).identityAttempts, 1);
  assertRecoveryState(await f.row(), { askedName: true, askedDocument: false, reviewRequired: false });
  assertRecovery((await f.post({ customer_name: "Ana García" })).body, "ASK_DOCUMENT", 1);
  assertRegisteredConditions((await f.post()).body); assert.equal((await f.row()).identityAttempts, 3);
  assert.equal("lastFailure" in (await f.row()).identityRecovery, false);
});

test("a repeated tool request after the second distinct answer preserves its remaining attempt for a correct name", async t => {
  const f = await fixture(t); await f.claim();
  assertRecovery((await f.post({ customer_name: "Clara García." })).body, "ASK_NAME", 2);
  const second = { customer_name: "Ana García.", customer_document: actualDocuments[0] };
  const secondResponse = await f.post(second);
  assertRecovery(secondResponse.body, "ASK_DOCUMENT", 1);
  const secondRow = await f.row(), writes = f.writes();
  for (const customer_document of [actualDocuments[0], "38144092", "38.144.092", actualDocuments[1]]) {
    const duplicate = await f.post({ customer_name: "  ANA,  GARCÍA.  ", customer_document });
    assert.deepEqual(duplicate.body, secondResponse.body);
    assert.equal(duplicate.body.condiciones, null);
  }
  // A,B,A must return the current guidance rather than reopening the first name question.
  assert.deepEqual((await f.post({ customer_name: "Clara García." })).body, secondResponse.body);
  assert.equal((await f.row()).identityAttempts, 2); assert.equal((await f.row()).identityVerifiedAt, null);
  assert.equal(f.writes(), writes); assert.deepEqual((await f.row()).identityRecovery, secondRow.identityRecovery);
  const cached = assertRecoveryState(secondRow, { askedName: true, askedDocument: true, reviewRequired: false });
  assert.equal(cached.nextAction, "ASK_DOCUMENT"); assert.equal(cached.attempts, 2);
  assert.equal(secondRow.identityRecovery.failedInputHashes.length, 2);
  const persisted = JSON.stringify(secondRow.identityRecovery);
  for (const forbidden of ["Ana", "ana", "Garcia", "garcia", "38144092", "document", "phone", "condiciones", "initialPayment"]) {
    assert.equal(persisted.includes(forbidden), false, forbidden);
  }
  assertRegisteredConditions((await f.post({ customer_name: "Hernández" })).body);
  assert.equal((await f.row()).identityAttempts, 3); assert.ok((await f.row()).identityVerifiedAt);
  assert.equal("lastFailure" in (await f.row()).identityRecovery, false);
  assert.equal("failedInputHashes" in (await f.row()).identityRecovery, false);
});

test("cached failed guidance is unavailable with stale, foreign or closed scope and changed current credit", async t => {
  const f = await fixture(t); await f.claim();
  const input = { customer_name: "Clara García." };
  const failure = await f.post(input); assertRecovery(failure.body, "ASK_NAME", 2);
  const original = await f.row(), writes = f.writes();
  for (const dispatchedAt of [null, new Date(now.getTime() - 86400001), new Date(now.getTime() + 1)]) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [f.eventId, dispatchedAt]);
    assertRecovery((await f.post(input)).body);
  }
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [f.eventId, now]);
  const foreign = await f.store.verifyCreditWelcomeVoiceIdentity({ eventId: f.eventId, creditId: 73,
    requireFreshDispatch: true, customerName: input.customer_name, customerDocument: actualDocuments[0] });
  assert.equal(foreign.verificado, false); assert.equal(foreign.nextAction, "REVIEW"); assert.equal(foreign.condiciones, null);
  for (const change of [{ cuotaInicial: 1 }, { clienteTelefono: "3000000002" }, { estado: "PAGADO" },
    { abonos: [{ valor: 477450, fechaAbono: "2026-10-08", estado: "APROBADO" }] }]) {
    await f.db.query('UPDATE "Credito" SET "data"=$2::jsonb WHERE "id"=$1', [72, JSON.stringify({ ...credit(), ...change })]);
    assertRecovery((await f.post(input)).body);
  }
  await f.db.query('UPDATE "Credito" SET "data"=$2::jsonb WHERE "id"=$1', [72, JSON.stringify(credit())]);
  assert.deepEqual((await f.post(input)).body, failure.body);
  const unauthorizedBefore = f.queries();
  assert.equal((await f.post(input, "Bearer wrong")).status, 401); assert.equal(f.queries(), unauthorizedBefore);
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2 WHERE "id"=$1::uuid', [f.eventId, "COMPLETED"]);
  assertRecovery((await f.post(input)).body);
  assert.equal((await f.row()).identityAttempts, 1); assert.equal((await f.row()).identityVerifiedAt, null);
  assert.deepEqual((await f.row()).identityRecovery, original.identityRecovery); assert.equal(f.writes(), writes);
});

test("a legacy last-failure hash stays replayable while malformed or inconsistent cached metadata fails closed", async t => {
  const f = await fixture(t); await f.claim();
  const input = { customer_name: "Clara García." };
  const failure = await f.post(input), original = await f.row(), writes = f.writes();
  const legacyRecovery = { ...original.identityRecovery };
  delete legacyRecovery.failedInputHashes;
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "identityRecovery"=$2::jsonb WHERE "id"=$1::uuid', [f.eventId, JSON.stringify(legacyRecovery)]);
  assert.deepEqual((await f.post(input)).body, failure.body); assert.equal(f.writes(), writes);
  const malformed = [
    { ...original.identityRecovery, failedInputHashes: Array(4).fill(original.identityRecovery.lastFailure.inputHash) },
    { ...original.identityRecovery, failedInputHashes: ["a".repeat(64)] },
    { ...original.identityRecovery, lastFailure: { ...original.identityRecovery.lastFailure, nextAction: ["ASK_NAME"] } },
    { ...original.identityRecovery, lastFailure: { ...original.identityRecovery.lastFailure, code: ["IDENTITY_NOT_CONFIRMED"] } },
    { ...original.identityRecovery, lastFailure: { ...original.identityRecovery.lastFailure, attempts: 2 } },
  ];
  for (const recovery of malformed) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "identityRecovery"=$2::jsonb WHERE "id"=$1::uuid', [f.eventId, JSON.stringify(recovery)]);
    assertRecovery((await f.post(input)).body); assertRecovery((await f.post()).body);
    assert.equal((await f.row()).identityAttempts, 1); assert.equal((await f.row()).identityVerifiedAt, null);
    assert.equal(f.writes(), writes);
  }
});
