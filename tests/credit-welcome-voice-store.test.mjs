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
