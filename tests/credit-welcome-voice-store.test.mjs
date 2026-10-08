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
const [core, plan, snapshot, cartera, phone] = await Promise.all([
  jiti.import("../lib/credit-welcome-voice-core.ts"), jiti.import("../lib/credit-payment-plan.ts"),
  jiti.import("../lib/credit-factory-snapshot.ts"), jiti.import("../lib/cartera-export.ts"),
  jiti.import("../lib/dapta-welcome.ts"),
]);
const sample = (id = 1, overrides = {}) => ({ id, folio: "FC-TEST-" + id,
  clienteNombre: "ANA MARÍA PRUEBA", clienteDocumento: "00123456", clienteTelefono: "3000000001",
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
    "@/scripts/credit-welcome-voice-schema.mjs": { creditWelcomeVoiceSchemaStatements },
  }, { process: { env: {} } });
  const store = loaded.createCreditWelcomeVoiceStore({ database: client, enabled: () => flag,
    now: () => new Date("2026-10-08T15:00:00.000Z") });
  const enqueue = (creditId = 1, source = "NORMAL") => client.$transaction(tx => store.enqueueCreditWelcomeVoice(tx, { creditId, source }));
  const rows = () => db.query('SELECT * FROM "CreditWelcomeVoiceEvent" ORDER BY "creditoId"').then(result => result.rows);
  const update = (id, fields) => db.query('UPDATE "Credito" SET "data"="data"||$2::jsonb WHERE "id"=$1', [id, JSON.stringify(fields)]);
  const identity = (eventId, fields = {}) => store.verifyCreditWelcomeVoiceIdentity({ eventId, creditId: 1,
    customerName: "Ana Maria Prueba", customerDocument: "00.123.456", ...fields });
  const result = (eventId, fields = {}) => store.saveCreditWelcomeVoiceResult({ eventId, creditId: 1,
    providerCallId: "call-test-1", status: "COMPLETED", summary: "Cliente confirma condiciones.",
    doubts: "Preguntó por los medios de pago.", transcript: "Transcripción privada de prueba.", durationSeconds: 75,
    recordingUrl: "https://app.dapta.ai/calls/call-test-1", ...fields });
  return { db, client, loaded, store, enqueue, rows, update, identity, result,
    queries: () => queries, setEnabled: value => { flag = value; } };
}

test("disabled feature does not read or enqueue, and a disabled processor claims nothing", async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal(await f.enqueue(), null);
  assert.equal((await f.store.claimPendingCreditWelcomeVoice()).length, 0);
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
