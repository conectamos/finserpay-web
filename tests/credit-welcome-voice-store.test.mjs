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
  jiti.import("../lib/credit-welcome-voice-core.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/credit-factory-snapshot.ts"), jiti.import("../lib/cartera-export.ts"),
  jiti.import("../lib/dapta-welcome.ts"),
  jiti.import("../lib/credit-welcome-voice-speech.ts"),
  jiti.import("../lib/credit-voice-review-campaign-core.ts"),
]);
const sample = (id = 1, overrides = {}) => ({ id, folio: "FC-TEST-" + id,
  clienteNombre: "ANA MARÍA PRUEBA", clienteDocumento: "00123456", clienteTelefono: "3000000001",
  referenciaEquipo: null, equipoMarca: null, equipoModelo: null,
  estado: "INSCRITO", pazYSalvoEmitidoAt: null, cuotaInicial: 200, montoCredito: 300, valorCuota: 100,
  plazoMeses: 3, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17", fechaProximoPago: "2026-10-17",
  contratoSnapshot: null, planCapitalVigente: null, abonos: [],
  amortizacion: { numeroCuotas: 3, cuotaComercial: "100.00", frecuenciaPago: "QUINCENAL", cuotas: [
    { numero: 1, fechaVencimiento: "2026-10-17", cuotaCobro: "100.00" },
    { numero: 2, fechaVencimiento: "2026-11-02", cuotaCobro: "100.00" },
    { numero: 3, fechaVencimiento: "2026-11-17", cuotaCobro: "100.00" },
  ] }, ...overrides });

async function fixture(t, { credits = [sample()], enabled = true, failTransaction = false } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "data" JSONB NOT NULL)');
  for (const statement of creditWelcomeVoiceSchemaStatements) await db.exec(statement);
  for (const credit of credits) await db.query('INSERT INTO "Credito" ("id","data") VALUES ($1,$2::jsonb)', [credit.id, JSON.stringify(credit)]);
  let rollback = failTransaction;
  let queries = 0;
  let flag = enabled;
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { queries++; return (await connection.query(sql, values)).affectedRows; },
    credito: { findUnique: async ({ where, select }) => {
      assert.equal(select.amortizacion.select.numeroCuotas, true);
      assert.equal(select.abonos.where.estado.not, "ANULADO");
      assert.equal(select.referenciaEquipo, true);
      assert.equal(select.equipoMarca, true);
      assert.equal(select.equipoModelo, true);
      queries++;
      return (await connection.query('SELECT "data" FROM "Credito" WHERE "id"=$1', [where.id])).rows[0]?.data ?? null;
    } },
  });
  const client = { ...adapter(db), $transaction: callback => db.transaction(async connection => {
    const result = await callback(adapter(connection));
    if (rollback) { rollback = false; await connection.query("SELECT 'rollback test'::integer"); }
    return result;
  }) };
  const loaded = loadReissueModule("lib/credit-welcome-voice-store.ts", {
    "@/lib/prisma": { default: client }, "@/lib/credit-payment-plan": plan,
    "@/lib/credit-factory-snapshot": snapshot, "@/lib/cartera-export": cartera,
    "@/lib/dapta-welcome": phone, "@/lib/credit-welcome-voice-core": core,
    "@/lib/credit-welcome-voice-speech": speech,
    "@/lib/credit-welcome-voice-document": documentParser,
    "@/lib/credit-voice-review-campaign-core": campaignPolicy,
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  }, { process: { env: {} } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => flag,
    now: () => new Date("2026-10-08T15:00:00.000Z") });
  const enqueue = (creditId = 1, source = "NORMAL") => client.$transaction(tx => store.enqueueCreditWelcomeVoice(tx, { creditId, source }));
  const rows = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId","attemptNumber"').then(result => result.rows);
  const update = (id, fields) => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(fields)]);
  const identity = (eventId, fields = {}) => store.verifyCreditWelcomeVoiceIdentity({ eventId, creditId: 1,
    customerName: "Ana Maria Prueba", customerDocument: "00.123.456", ...fields });
  const result = (eventId, fields = {}) => store.saveCreditWelcomeVoiceResult({ eventId, creditId: 1,
    providerCallId: "call-test-1", status: "COMPLETED", summary: "Cliente confirma condiciones.",
    doubts: "Preguntó por los medios de pago.", transcript: "Transcripción privada de prueba.", durationSeconds: 75,
    recordingUrl: "https://app.dapta.ai/calls/call-test-1", ...fields });
  return { db, client, loaded, store, enqueue, rows, update, identity, result,
    queries: () => queries, setEnabled: value => { flag = value; }, rollbackNext: () => { rollback = true; } };
}

test("disabled feature does not read or enqueue, and a disabled processor claims nothing", async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal(await f.enqueue(), null);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001" }),
    error => error.code === "CONTROLLED_TEST_DISABLED");
  assert.equal(f.queries(), 0);
});

test("credit creation event commits atomically and replay/concurrent enqueue create one event", async t => {
  const f = await fixture(t);
  const attempts = await Promise.all([f.enqueue(), f.enqueue(), f.enqueue()]);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal((await f.rows()).length, 1);
  assert.equal(await f.enqueue(), null);
});

test("rollback of the credit transaction leaves no outbox event; retry can enqueue", async t => {
  const f = await fixture(t, { failTransaction: true });
  await assert.rejects(f.enqueue());
  assert.equal((await f.rows()).length, 0);
  assert.ok(await f.enqueue());
});

test("snapshot reads commercial decimal amount and the real amortization calendar, not months", async t => {
  const f = await fixture(t);
  await f.enqueue();
  const snap = (await f.rows())[0].snapshot;
  assert.equal(snap.document, "00123456");
  assert.equal(snap.name, "ana maria prueba");
  assert.equal(snap.spokenName, "ANA MARÍA PRUEBA");
  assert.equal(core.normalizeWelcomeVoiceName(snap.spokenName), snap.name);
  assert.equal(snap.phone, "573000000001");
  assert.equal(snap.installmentCount, 3);
  assert.equal(snap.installmentAmount, 100);
  assert.deepEqual(snap.calendar, ["2026-10-17", "2026-11-02", "2026-11-17"]);
  assert.equal(snap.installmentsEqual, true);
});

test("different final installment is preserved, with installmentsEqual=false", async t => {
  const credit = sample();
  credit.amortizacion.cuotas[2].cuotaCobro = "99.50";
  const f = await fixture(t, { credits: [credit] });
  await f.enqueue();
  const snap = (await f.rows())[0].snapshot;
  assert.equal(snap.installmentsEqual, false);
  assert.deepEqual(snap.installmentAmounts, [100, 100, 99.5]);
});

test("equipment reference prefers the purchased contractual equipment and reaches verified conditions only", async t => {
  const f = await fixture(t, { credits: [sample(1, {
    referenciaEquipo: "Samsung Galaxy A56", equipoMarca: "Samsung", equipoModelo: "Galaxy A56",
    contratoSnapshot: { equipo: { referencia: "  iPhone 16   Pro 256GB  ", marca: "Apple", modelo: "iPhone 15" } },
  })] });
  const { eventId } = await f.enqueue();
  const persisted = (await f.rows())[0].snapshot;
  assert.equal(persisted.equipmentReference, "iPhone 16 Pro 256GB");
  assert.equal(persisted.initialPayment, 200);
  assert.equal(persisted.installmentAmount, 100);
  assert.deepEqual(persisted.calendar, ["2026-10-17", "2026-11-02", "2026-11-17"]);
  const rejected = await f.identity(eventId);
  assert.equal(rejected.verificado, false);
  assert.equal("condiciones" in rejected, false);
  await f.store.claimPendingCreditWelcomeVoice();
  const verified = await f.identity(eventId);
  assert.equal(verified.verificado, true);
  assert.equal(verified.condiciones.equipmentReference, "iPhone 16 Pro 256GB");
  assert.equal(verified.condiciones.speech.equipmentReference, speech.welcomeVoiceEquipmentSpoken(persisted.equipmentReference));
});

test("equipment reference falls back only to registered labels, preserving contractual brand/model when present", async t => {
  const f = await fixture(t);
  const build = fields => f.loaded.buildCreditWelcomeVoiceSnapshot(sample(1, fields));
  assert.equal(build({ referenciaEquipo: "Galaxy S24 128GB", equipoMarca: "Samsung", equipoModelo: "Galaxy A55" }).equipmentReference,
    "Galaxy S24 128GB");
  assert.equal(build({ equipoMarca: " Samsung  ", equipoModelo: " Galaxy A55   256GB " }).equipmentReference,
    "Samsung Galaxy A55 256GB");
  assert.equal(build({ equipoModelo: "iPhone 16", equipoMarca: null }).equipmentReference, "iPhone 16");
  assert.equal(build({ referenciaEquipo: "Otro equipo actual", contratoSnapshot: { equipo: { marca: "Apple", modelo: "iPhone 16" } } }).equipmentReference,
    "Apple iPhone 16");
  assert.equal(build({ referenciaEquipo: "   ", equipoMarca: " ", equipoModelo: null }).equipmentReference, null);
  assert.equal(build({}).equipmentReference, null);
});

test("equipment reference is bounded and never includes controls or unsafe markup instead of substituting a different purchase", async t => {
  const f = await fixture(t);
  const build = fields => f.loaded.buildCreditWelcomeVoiceSnapshot(sample(1, fields));
  for (const reference of ["iPhone\n16", "Galaxy\u0085A55", "iPhone\u0000 16", "<modelo>", "x".repeat(241)]) {
    assert.equal(build({ referenciaEquipo: reference }).equipmentReference, null);
    assert.equal(build({ referenciaEquipo: "Otro equipo", contratoSnapshot: { equipo: { referencia: reference } } }).equipmentReference, null);
  }
  assert.equal(build({ referenciaEquipo: "x".repeat(240) }).equipmentReference, "x".repeat(240));
});

test("changed purchased equipment blocks postclaim dispatch and discloses no conditions", async t => {
  const credits = [
    sample(1, { contratoSnapshot: { equipo: { referencia: "iPhone 16 128GB" } } }),
    sample(2, { equipoMarca: "Samsung", equipoModelo: "Galaxy A55" }),
    sample(3),
  ];
  const f = await fixture(t, { credits });
  for (const credit of credits) await f.enqueue(credit.id);
  const claims = await f.store.claimPendingCreditWelcomeVoice();
  await f.update(1, { contratoSnapshot: { equipo: { referencia: "iPhone 17 128GB" } } });
  await f.update(2, { equipoModelo: "Galaxy A56" });
  await f.update(3, { referenciaEquipo: "Equipo ahora registrado" });
  for (const claim of claims) {
    assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(claim.eventId), null);
    const row = (await f.rows()).find(row => row.id === claim.eventId);
    assert.equal(row.status, "SKIPPED");
    assert.equal(row.resultCode, "CONDITIONS_CHANGED");
    const identity = await f.identity(claim.eventId, { creditId: claim.creditId });
    assert.equal(identity.verificado, false);
    assert.equal("condiciones" in identity, false);
  }
});

test("legacy completed test without equipment reference can create a fresh child without changing its parent", async t => {
  const f = await fixture(t, { credits: [sample(1, { referenciaEquipo: "iPhone 16 256GB" })] });
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.db.query(`UPDATE "CreditWelcomeVoiceEvent" SET "snapshot"="snapshot"-'equipmentReference' WHERE "id"=$1::uuid`, [original.eventId]);
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  const child = await f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: original.eventId });
  assert.notEqual(child.eventId, original.eventId);
  assert.equal(child.snapshot.equipmentReference, "iPhone 16 256GB");
  assert.equal((await f.store.prepareCreditWelcomeVoiceDispatch(child.eventId)).snapshot.equipmentReference, "iPhone 16 256GB");
  const verified = await f.identity(child.eventId);
  assert.equal(verified.verificado, true);
  assert.equal(verified.condiciones.equipmentReference, "iPhone 16 256GB");
  assert.deepEqual((await f.rows())[0], before);
});

test("a completed test with recorded equipment reference cannot be repeated after purchase changes", async t => {
  const f = await fixture(t, { credits: [sample(1, { referenciaEquipo: "iPhone 16 128GB" })] });
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  await f.update(1, { referenciaEquipo: "iPhone 17 128GB" });
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: original.eventId }),
    error => error.code === "CONTROLLED_TEST_SNAPSHOT_CHANGED");
  assert.deepEqual(await f.rows(), [before]);
});

test("individual mass creation without amortization uses stored contract conditions and dates", async t => {
  const f = await fixture(t, { credits: [sample(1, { amortizacion: null, frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2026-11-08", contratoSnapshot: { financiero: { cuotaInicial: 250,
      plazo: 3, valorCuota: 100, frecuenciaPago: "MENSUAL", fechaPrimerPago: "2026-11-08" } } })] });
  await f.enqueue(1, "INDIVIDUAL_IMPORT");
  const snap = (await f.rows())[0].snapshot;
  assert.equal(snap.initialPayment, 250);
  assert.equal(snap.frequency, "MENSUAL");
  assert.deepEqual(snap.calendar, ["2026-11-08", "2026-12-08", "2027-01-08"]);
});

test("invalid stored date is skipped instead of inventing a calendar", async t => {
  const f = await fixture(t, { credits: [sample(1, { amortizacion: null, fechaPrimerPago: "2026-02-30" })] });
  await f.enqueue();
  assert.equal((await f.rows())[0].status, "SKIPPED");
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("parallel claims receive each event once and never replay DISPATCHING/UNKNOWN/FAILED", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2), sample(3)] });
  await Promise.all([f.enqueue(1), f.enqueue(2), f.enqueue(3)]);
  const batches = await Promise.all([f.store.claimPendingCreditWelcomeVoice({ limit: 2 }), f.store.claimPendingCreditWelcomeVoice({ limit: 2 })]);
  const claims = batches.flat();
  assert.equal(claims.length, 3);
  assert.equal(new Set(claims.map(row => row.eventId)).size, 3);
  await f.store.markCreditWelcomeVoiceDispatchUnknown(claims[0].eventId);
  await f.store.markCreditWelcomeVoiceDispatchFailed(claims[1].eventId);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
});

test("cancelled, paid status, paz y salvo and actually settled balances cannot dispatch", async t => {
  for (const change of [{ estado: "ANULADO" }, { estado: "PAGADO" },
    { pazYSalvoEmitidoAt: "2026-10-08" }, { abonos: [{ valor: 300, fechaAbono: "2026-10-08", estado: "ACTIVO" }] }]) {
    const f = await fixture(t);
    await f.enqueue();
    await f.update(1, change);
    assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
    assert.equal((await f.rows())[0].status, "CANCELLED");
  }
});

test("postclaim revalidation blocks changed contact and conditions before HTTP dispatch", async t => {
  for (const [change, expected] of [
    [{ clienteTelefono: "3000000099" }, "CONTACT_CHANGED"],
    [{ clienteDocumento: "00999999" }, "CONTACT_CHANGED"],
    [{ cuotaInicial: 210 }, "CONDITIONS_CHANGED"],
    [{ estado: "ANULADO" }, "CREDIT_CLOSED"],
  ]) {
    const f = await fixture(t);
    await f.enqueue();
    const [claim] = await f.store.claimPendingCreditWelcomeVoice();
    await f.update(1, change);
    assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(claim.eventId), null);
    assert.equal((await f.rows())[0].resultCode, expected);
  }
});

test("identity denies mismatches without disclosing conditions and locks after three attempts", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  await f.store.claimPendingCreditWelcomeVoice();
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.deepEqual(JSON.parse(JSON.stringify(await f.identity(eventId, { customerDocument: "99999999" }))), { verificado: false });
  }
  assert.equal((await f.rows())[0].identityAttempts, 3);
  assert.equal((await f.rows())[0].identityVerifiedAt, null);
  assert.equal((await f.identity(eventId)).verificado, false);
});

test("identity verifies backend data, preserves document zeroes and excludes document/phone from response", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  assert.equal((await f.identity(eventId)).verificado, false); // Not yet dispatched.
  await f.store.claimPendingCreditWelcomeVoice();
  assert.equal((await f.identity(eventId, { customerDocument: "123456" })).verificado, false);
  const verified = await f.identity(eventId);
  assert.equal(verified.verificado, true);
  assert.equal(verified.condiciones.initialPayment, 200);
  assert.equal("document" in verified.condiciones, false);
  assert.equal("phone" in verified.condiciones, false);
  assert.ok((await f.rows())[0].identityVerifiedAt);
  assert.equal((await f.identity(eventId)).verificado, true); // Safe repeated action.
  assert.equal((await f.identity(eventId, { creditId: 2 })).verificado, false);
});

test("identity flow derives credit from a fresh active event and rejects stale, future or closed dispatches", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  const flowInput = { eventId, requireFreshDispatch: true, customerName: "Ana Maria Prueba", customerDocument: "00123456" };
  assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity(flowInput)).verificado, false);
  await f.store.claimPendingCreditWelcomeVoice();
  assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity({ ...flowInput, requireFreshDispatch: false })).verificado, false);
  for (const dispatchedAt of [null, "2026-10-07T14:59:59.000Z", "2026-10-08T15:00:01.000Z"]) {
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [eventId, dispatchedAt]);
    assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity(flowInput)).verificado, false);
  }
  assert.equal((await f.rows())[0].identityAttempts, 0);
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "dispatchedAt"=$2 WHERE "id"=$1::uuid', [eventId, "2026-10-08T15:00:00.000Z"]);
  assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity({ ...flowInput, customerDocument: "99999999" })).verificado, false);
  assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity(flowInput)).verificado, true);
  await f.result(eventId);
  assert.equal((await f.store.verifyCreditWelcomeVoiceIdentity(flowInput)).verificado, false);
});

test("additional spoken names can match all registered components only with the exact document", async t => {
  const f = await fixture(t, { credits: [sample(1, { clienteNombre: "LUZ HERNANDEZ", clienteDocumento: "38144092" })] });
  const { eventId } = await f.enqueue();
  await f.store.claimPendingCreditWelcomeVoice();
  assert.equal((await f.identity(eventId, { customerName: "Luz Estela Hernández Gili", customerDocument: "38144093" })).verificado, false);
  assert.equal((await f.identity(eventId, { customerName: "Luz Estela García Gili", customerDocument: "38144092" })).verificado, false);
  assert.equal((await f.identity(eventId, { customerName: "Luz, que esté a la Hernández.", customerDocument: "38144092" })).verificado, true);
});

test("successful postcall is idempotent and markAccepted cannot overwrite a fast completed callback", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  await f.store.claimPendingCreditWelcomeVoice();
  await f.identity(eventId);
  assert.equal((await f.result(eventId)).unchanged, false);
  assert.equal((await f.result(eventId)).unchanged, true);
  await f.store.markCreditWelcomeVoiceDispatchAccepted(eventId, "call-test-1");
  const row = (await f.rows())[0];
  assert.equal(row.status, "COMPLETED");
  assert.ok(row.identityVerifiedAt);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  await assert.rejects(f.result(eventId, { summary: "Conflicting result" }), error => error.code === "RESULT_CONFLICT");
  await assert.rejects(f.result(eventId, { providerCallId: "different-call" }), error => error.code === "CALL_ID_CONFLICT");
});

test("a callback cannot manufacture backend identity verification and list omits transcript and financial PII", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  await f.store.claimPendingCreditWelcomeVoice();
  await f.result(eventId, { identityConfirmed: true });
  const [record] = await f.store.listCreditWelcomeVoiceCallsForCredit(1);
  assert.equal(record.identityVerified, false);
  assert.equal(record.audioStorage, "DAPTA_PRIVATE_LINK");
  assert.equal(record.doubts, "Preguntó por los medios de pago.");
  for (const field of ["snapshot", "document", "phone", "transcript", "identityAttempts"]) assert.equal(field in record, false);
  assert.equal((await f.store.listCreditWelcomeVoiceCallsForCredit(2)).length, 0);
});

test("untrusted recording URLs, credit/event mismatches and duplicate provider IDs are rejected", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2)] });
  const one = await f.enqueue(1), two = await f.enqueue(2);
  await f.store.claimPendingCreditWelcomeVoice();
  for (const recordingUrl of ["http://app.dapta.ai/calls/1", "https://app.dapta.ai.evil.invalid/calls/1", "https://user:password@app.dapta.ai/calls/1", "audio/call_1.ogg"]) {
    await assert.rejects(f.result(one.eventId, { recordingUrl }), error => error.code === "INVALID_RECORDING_URL");
  }
  await assert.rejects(f.result(one.eventId, { creditId: 2 }), error => error.code === "EVENT_NOT_FOUND");
  await f.result(one.eventId);
  await assert.rejects(f.result(two.eventId, { creditId: 2 }), error => error.code === "CALL_ID_CONFLICT");
});

test("unknown dispatch can receive its correlated callback but a never-dispatched event cannot", async t => {
  const f = await fixture(t);
  const { eventId } = await f.enqueue();
  await assert.rejects(f.result(eventId), error => error.code === "RESULT_NOT_ALLOWED");
  await f.store.claimPendingCreditWelcomeVoice();
  await f.store.markCreditWelcomeVoiceDispatchUnknown(eventId);
  await f.result(eventId);
  assert.equal((await f.rows())[0].status, "COMPLETED");
});

test("schema has no approval recording relation or audio bytes and installs repeatedly", async t => {
  const f = await fixture(t);
  for (const statement of creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  const columns = (await f.db.query("SELECT column_name FROM information_schema.columns WHERE table_name='CreditWelcomeVoiceEvent'")).rows.map(row => row.column_name);
  for (const forbidden of ["bytes", "revision", "reviewHash", "callRecordingId"]) assert.equal(columns.includes(forbidden), false);
});

test("controlled test works through an isolated factory while global creation stays disabled and unrelated queue stays pending", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2, { clienteTelefono: "3000000002" }), sample(3)] });
  const unrelated = await f.enqueue(1);
  f.setEnabled(false);
  const queryCount = f.queries();
  assert.equal(await f.enqueue(3), null);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal(f.queries(), queryCount);
  const directed = f.loaded.createCreditWelcomeVoiceStore({ database: f.client, enabled: () => true });
  const chosen = await directed.prepareCreditWelcomeVoiceControlledTest({ creditId: 2, expectedPhone: "+57 300 000 0002" });
  assert.equal(chosen.creditId, 2);
  assert.equal(chosen.snapshot.phone, "573000000002");
  const records = await f.rows();
  assert.equal(records.length, 2);
  assert.equal(records[0].id, unrelated.eventId);
  assert.equal(records[0].status, "PENDING");
  assert.equal(records[0].source, "NORMAL");
  assert.equal(records[1].id, chosen.eventId);
  assert.equal(records[1].status, "DISPATCHING");
  assert.equal(records[1].source, "CONTROLLED_TEST");
  assert.equal(await f.enqueue(3), null);
});

test("controlled test validates the expected number and eligible real credit before inserting anything", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2, { estado: "ANULADO" }),
    sample(3, { estado: "PAGADO" }), sample(4, { pazYSalvoEmitidoAt: "2026-10-08" }),
    sample(5, { abonos: [{ valor: 300, estado: "ACTIVO", fechaAbono: "2026-10-08" }] }),
    sample(6, { amortizacion: null, fechaPrimerPago: "2026-02-30" })] });
  const prepare = input => f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await assert.rejects(prepare({ creditId: 1, expectedPhone: "not-a-phone" }), error => error.code === "INVALID_CONTROLLED_TEST");
  assert.equal(f.queries(), 0);
  await assert.rejects(prepare({ creditId: 1, expectedPhone: "+573000000099" }), error => error.code === "CONTROLLED_TEST_PHONE_MISMATCH");
  await assert.rejects(prepare({ creditId: 99, expectedPhone: "+573000000001" }), error => error.code === "CREDIT_NOT_FOUND");
  for (const creditId of [2, 3, 4, 5, 6]) {
    await assert.rejects(prepare({ creditId, expectedPhone: "+573000000001" }), error => error.code === "CONTROLLED_TEST_INELIGIBLE");
  }
  assert.equal((await f.rows()).length, 0);
});

test("controlled test reuses only the chosen pending event and refuses altered snapshots without changing them", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2), sample(3)] });
  const one = await f.enqueue(1), two = await f.enqueue(2), three = await f.enqueue(3);
  await f.update(2, { clienteTelefono: "3000000002" });
  await f.update(3, { cuotaInicial: 210 });
  for (const [creditId, expectedPhone] of [[2, "+573000000002"], [3, "+573000000001"]]) {
    await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId, expectedPhone }),
      error => error.code === "CONTROLLED_TEST_SNAPSHOT_CHANGED");
  }
  const chosen = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "3000000001" });
  assert.equal(chosen.eventId, one.eventId);
  const records = await f.rows();
  assert.equal(records.length, 3);
  assert.equal(records[0].source, "CONTROLLED_TEST");
  for (const [index, previous] of [[1, two], [2, three]]) {
    assert.equal(records[index].id, previous.eventId);
    assert.equal(records[index].status, "PENDING");
    assert.equal(records[index].source, "NORMAL");
  }
});

test("controlled test refuses every attempted or closed state and cannot claim a credit twice concurrently", async t => {
  const states = ["DISPATCHING", "ACCEPTED", "COMPLETED", "FAILED", "UNKNOWN", "CANCELLED", "SKIPPED"];
  const f = await fixture(t, { credits: [...states.map((_, index) => sample(index + 1)), sample(8)] });
  for (let index = 0; index < states.length; index++) {
    const event = await f.enqueue(index + 1);
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2 WHERE "id"=$1::uuid', [event.eventId, states[index]]);
    await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: index + 1, expectedPhone: "+573000000001" }),
      error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  }
  const attempts = await Promise.allSettled([1, 2].map(() => f.store.prepareCreditWelcomeVoiceControlledTest({
    creditId: 8, expectedPhone: "+573000000001" })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.code, "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  const records = await f.rows();
  assert.deepEqual(records.slice(0, 7).map(row => row.status), states);
  assert.ok(records.slice(0, 7).every(row => row.source === "NORMAL"));
  assert.equal(records[7].status, "DISPATCHING");
});

test("controlled test preparation rolls back atomically, then a retry of the unsent transaction can succeed", async t => {
  const f = await fixture(t, { failTransaction: true });
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest(input));
  assert.equal((await f.rows()).length, 0);
  const claim = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  assert.equal((await f.rows())[0].id, claim.eventId);
  assert.equal((await f.rows())[0].status, "DISPATCHING");
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest(input), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
});

test("controlled test source migrates a previously installed check idempotently without losing existing events", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2)] });
  const original = await f.enqueue(1);
  await f.db.exec(`ALTER TABLE "CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_source_check";
    ALTER TABLE "CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_source_check"
      CHECK ("source" IN ('NORMAL','INDIVIDUAL_IMPORT'));`);
  for (let run = 0; run < 2; run++) {
    for (const statement of creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  }
  await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 2, expectedPhone: "+573000000001" });
  const records = await f.rows();
  assert.equal(records[0].id, original.eventId);
  assert.equal(records[0].status, "PENDING");
  assert.equal(records[1].source, "CONTROLLED_TEST");
  await assert.rejects(f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "source"=$2 WHERE "id"=$1::uuid',
    [original.eventId, "UNSUPPORTED_SOURCE"]));
});

test("manual repeat creates exactly one fresh auditable child, leaving the completed call and callback scope intact", async t => {
  const f = await fixture(t);
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  // Existing production snapshots predate spokenName; repeating one must preserve it.
  await f.db.query(`UPDATE "CreditWelcomeVoiceEvent" SET "snapshot"="snapshot"-'spokenName' WHERE "id"=$1::uuid`, [original.eventId]);
  await f.identity(original.eventId);
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  const attempts = await Promise.allSettled([1, 2, 3].map(() => f.store.prepareCreditWelcomeVoiceControlledTest({
    ...input, repeatOf: original.eventId })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(attempts.filter(result => result.status === "rejected").every(result => result.reason.code === "CONTROLLED_TEST_ALREADY_REPEATED"));
  const repeated = attempts.find(result => result.status === "fulfilled").value;
  assert.notEqual(repeated.eventId, original.eventId);
  const [parent, child] = await f.rows();
  assert.deepEqual(parent, before);
  assert.equal(child.attemptNumber, 1);
  assert.equal(child.repeatOf, original.eventId);
  assert.equal(child.source, "CONTROLLED_TEST");
  assert.equal(child.status, "DISPATCHING");
  assert.equal(child.providerCallId, null);
  assert.equal(child.identityVerifiedAt, null);
  assert.equal(child.identityAttempts, 0);
  assert.equal(child.snapshot.spokenName, "ANA MARÍA PRUEBA");
  assert.equal(child.snapshot.phone, "573000000001");
  assert.equal((await f.result(original.eventId)).unchanged, true);
  assert.equal((await f.rows())[1].status, "DISPATCHING");
  const secret = "synthetic-repeat-token-secret-long-enough";
  const oldToken = core.createWelcomeVoiceToken({ creditId: 1, eventId: original.eventId }, { secret });
  const newToken = core.createWelcomeVoiceToken({ creditId: 1, eventId: repeated.eventId }, { secret });
  assert.notEqual(oldToken, newToken);
  assert.equal(core.verifyWelcomeVoiceToken(newToken, { secret }).eventId, repeated.eventId);
  await assert.rejects(f.result(repeated.eventId), error => error.code === "CALL_ID_CONFLICT");
  await f.store.markCreditWelcomeVoiceDispatchUnknown(repeated.eventId);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
  assert.equal((await f.identity(repeated.eventId)).verificado, true);
  await f.result(repeated.eventId, { providerCallId: "call-repeat-1" });
  assert.deepEqual((await f.rows())[0], before);
  assert.equal((await f.rows())[1].providerCallId, "call-repeat-1");
  assert.equal(await f.enqueue(), null);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest(input), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
});

test("manual repeat allocates after an intervening scheduled attempt and concurrent replay preserves both completed calls", async t => {
  const f = await fixture(t);
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const first = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.result(first.eventId);
  const parent = await f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: first.eventId });
  await f.result(parent.eventId, { providerCallId: "completed-controlled-13" });
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "attemptNumber"=13 WHERE "id"=$1::uuid', [parent.eventId]);
  await f.db.exec(`INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES ('intervening','2026-10-09','[1]');
    INSERT INTO "VoiceReviewCampaignMember" ("campaignId","creditoId") VALUES ('intervening',1);`);
  const scheduledId = "00000000-0000-4000-8000-000000000014";
  await f.db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","source","attemptNumber","campaignId","campaignSlot","status","snapshot","providerCallId","resultHash")
    SELECT $1::uuid,1,'SCHEDULED_CAMPAIGN',14,'intervening','2026-10-09T08:00','COMPLETED',"snapshot",'scheduled-14',$2
      FROM "CreditWelcomeVoiceEvent" WHERE "id"=$3::uuid`, [scheduledId, "a".repeat(64), parent.eventId]);
  const before = await f.rows();
  const attempts = await Promise.allSettled([1, 2].map(() => f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: parent.eventId })));
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(attempts.find(result => result.status === "rejected").reason.code, "CONTROLLED_TEST_ALREADY_REPEATED");
  const claim = attempts.find(result => result.status === "fulfilled").value;
  const records = await f.rows();
  assert.deepEqual(records.slice(0, 3), before);
  assert.equal(records.length, 4);
  assert.equal(records[3].id, claim.eventId);
  assert.equal(records[3].attemptNumber, 15);
  assert.equal(records[3].repeatOf, parent.eventId);
  assert.equal(records[3].source, "CONTROLLED_TEST");
  assert.equal(records[3].status, "DISPATCHING");
  assert.equal(records[3].providerCallId, null);
});

test("manual repeat fails without insertion when the shared credit attempt sequence is exhausted", async t => {
  const f = await fixture(t);
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const first = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.result(first.eventId);
  await f.db.exec(`INSERT INTO "VoiceReviewCampaign" ("id","startDate","creditIds") VALUES ('exhausted','2026-10-09','[1]');
    INSERT INTO "VoiceReviewCampaignMember" ("campaignId","creditoId") VALUES ('exhausted',1);`);
  await f.db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","source","attemptNumber","campaignId","campaignSlot","status","snapshot")
    SELECT '00000000-0000-4000-8000-000000000099'::uuid,1,'SCHEDULED_CAMPAIGN',2147483647,'exhausted','2026-10-09T08:00','COMPLETED',"snapshot"
      FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid`, [first.eventId]);
  const before = await f.rows();
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: first.eventId }),
    error => error.code === "CONTROLLED_TEST_REPEAT_NOT_ALLOWED");
  assert.deepEqual(await f.rows(), before);
});

test("repeat requires a completed real controlled call of the same credit and rejects every ambiguous or closed alternative", async t => {
  const states = ["PENDING", "DISPATCHING", "ACCEPTED", "FAILED", "UNKNOWN", "CANCELLED", "SKIPPED", "COMPLETED"];
  const f = await fixture(t, { credits: Array.from({ length: 10 }, (_, index) => sample(index + 1)) });
  for (let index = 0; index < states.length; index++) {
    const original = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: index + 1, expectedPhone: "+573000000001" });
    await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=$2 WHERE "id"=$1::uuid', [original.eventId, states[index]]);
    // Even COMPLETED without a real callback receipt/hash must not permit a redial.
    await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: index + 1,
      expectedPhone: "+573000000001", repeatOf: original.eventId }), error => error.code === "CONTROLLED_TEST_REPEAT_NOT_ALLOWED");
  }
  const ordinary = await f.enqueue(9);
  await f.store.claimPendingCreditWelcomeVoice();
  await f.result(ordinary.eventId, { creditId: 9, providerCallId: "ordinary-completed-call" });
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 9, expectedPhone: "+573000000001", repeatOf: ordinary.eventId }),
    error => error.code === "CONTROLLED_TEST_REPEAT_NOT_ALLOWED");
  const controlled = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 10, expectedPhone: "+573000000001" });
  await f.result(controlled.eventId, { creditId: 10, providerCallId: "controlled-completed-call" });
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 9, expectedPhone: "+573000000001", repeatOf: controlled.eventId }),
    error => error.code === "CONTROLLED_TEST_REPEAT_NOT_ALLOWED");
  assert.equal((await f.rows()).length, 10);
});

test("manual repeat retains credit/contact/condition guards and never changes its parent on rejection", async t => {
  const f = await fixture(t);
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  const queryCount = f.queries();
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: "not-a-uuid" }), error => error.code === "INVALID_CONTROLLED_TEST");
  assert.equal(f.queries(), queryCount);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, expectedPhone: "+573000000099", repeatOf: original.eventId }),
    error => error.code === "CONTROLLED_TEST_PHONE_MISMATCH");
  for (const [changes, code] of [
    [{ cuotaInicial: 210 }, "CONTROLLED_TEST_SNAPSHOT_CHANGED"],
    [{ estado: "ANULADO" }, "CONTROLLED_TEST_INELIGIBLE"],
    [{ estado: "PAGADO" }, "CONTROLLED_TEST_INELIGIBLE"],
    [{ abonos: [{ valor: 300, fechaAbono: "2026-10-08", estado: "ACTIVO" }] }, "CONTROLLED_TEST_INELIGIBLE"],
  ]) {
    await f.update(1, { ...sample(), ...changes });
    await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: original.eventId }), error => error.code === code);
    assert.deepEqual(await f.rows(), [before]);
  }
});

test("spoken name may retain accents but a stored display name for another identity cannot pass revalidation", async t => {
  const f = await fixture(t);
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001" });
  assert.equal(original.snapshot.spokenName, "ANA MARÍA PRUEBA");
  await f.db.query(`UPDATE "CreditWelcomeVoiceEvent" SET "snapshot"=jsonb_set("snapshot",'{spokenName}','"OTRA PERSONA"'::jsonb)
    WHERE "id"=$1::uuid`, [original.eventId]);
  assert.equal(await f.store.prepareCreditWelcomeVoiceDispatch(original.eventId), null);
  const row = (await f.rows())[0];
  assert.equal(row.status, "SKIPPED");
  assert.equal(row.resultCode, "CONDITIONS_CHANGED");
});

test("ordinary queue never claims a manual-repeat event even if it is pending, and automatic creation remains unique at attempt zero", async t => {
  const f = await fixture(t, { credits: [sample(1), sample(2)] });
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001" });
  await f.result(original.eventId);
  const child = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001", repeatOf: original.eventId });
  await f.db.query('UPDATE "CreditWelcomeVoiceEvent" SET "status"=\'PENDING\' WHERE "id"=$1::uuid', [child.eventId]);
  const normal = await f.enqueue(2);
  assert.equal(await f.enqueue(1), null);
  const claimed = await f.store.claimPendingCreditWelcomeVoice();
  assert.deepEqual(Array.from(claimed, row => row.eventId), [normal.eventId]);
  assert.equal((await f.rows()).find(row => row.id === child.eventId).status, "PENDING");
  assert.equal((await f.rows()).filter(row => row.creditoId === 1 && row.attemptNumber === 0).length, 1);
});

test("a failed repeat transaction rolls back only its fresh child and an explicit completed child can be repeated once", async t => {
  const f = await fixture(t);
  const input = { creditId: 1, expectedPhone: "+573000000001" };
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest(input);
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  f.rollbackNext();
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: original.eventId }));
  assert.deepEqual(await f.rows(), [before]);
  const child = await f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: original.eventId });
  await f.result(child.eventId, { providerCallId: "repeat-chain-1" });
  const grandchild = await f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: child.eventId });
  assert.notEqual(grandchild.eventId, child.eventId);
  const records = await f.rows();
  assert.deepEqual(records.map(row => row.attemptNumber), [0, 1, 2]);
  assert.deepEqual(records.map(row => row.repeatOf), [null, original.eventId, child.eventId]);
  assert.deepEqual(records[0], before);
  await assert.rejects(f.store.prepareCreditWelcomeVoiceControlledTest({ ...input, repeatOf: child.eventId }), error => error.code === "CONTROLLED_TEST_ALREADY_REPEATED");
});

test("schema migrates the previous two-column uniqueness preserving old calls and enforces manual repeat constraints", async t => {
  const f = await fixture(t);
  const original = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001" });
  await f.result(original.eventId);
  const before = (await f.rows())[0];
  await f.db.exec(`ALTER TABLE "CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_fkey";
    ALTER TABLE "CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_repeatOf_key";
    ALTER TABLE "CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_attempt_check";
    ALTER TABLE "CreditWelcomeVoiceEvent" DROP CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key";
    ALTER TABLE "CreditWelcomeVoiceEvent" ADD CONSTRAINT "CreditWelcomeVoiceEvent_credit_type_key" UNIQUE ("creditoId","type");
    ALTER TABLE "CreditWelcomeVoiceEvent" DROP COLUMN "attemptNumber";
    ALTER TABLE "CreditWelcomeVoiceEvent" DROP COLUMN "repeatOf";`);
  for (let run = 0; run < 2; run++) {
    for (const statement of creditWelcomeVoiceSchemaStatements) await f.db.exec(statement);
  }
  assert.deepEqual((await f.rows())[0], before);
  let sequence = 0;
  const insert = (attemptNumber, repeatOf, source = "CONTROLLED_TEST") => f.db.query(`INSERT INTO "CreditWelcomeVoiceEvent"
    ("id","creditoId","type","source","status","attemptNumber","repeatOf") VALUES ($1::uuid,1,'BIENVENIDA_VOZ',$2,'PENDING',$3,$4::uuid)`,
  [`00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`, source, attemptNumber, repeatOf]);
  for (const [attemptNumber, repeatOf, source] of [[-1, null, "CONTROLLED_TEST"], [0, original.eventId, "CONTROLLED_TEST"],
    [1, null, "CONTROLLED_TEST"], [1, original.eventId, "NORMAL"], [1, "00000000-0000-4000-8000-999999999999", "CONTROLLED_TEST"]]) {
    await assert.rejects(insert(attemptNumber, repeatOf, source));
  }
  const child = await f.store.prepareCreditWelcomeVoiceControlledTest({ creditId: 1, expectedPhone: "+573000000001", repeatOf: original.eventId });
  await assert.rejects(insert(2, original.eventId));
  await assert.rejects(f.db.query('DELETE FROM "CreditWelcomeVoiceEvent" WHERE "id"=$1::uuid', [original.eventId]));
  assert.equal((await f.rows())[1].id, child.eventId);
  assert.deepEqual((await f.rows())[0], before);
});
