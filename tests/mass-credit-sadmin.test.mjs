import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sample, routeFixture, catalogs, call, postgresAdapter } from "./mass-credit-sadmin-fixture.mjs";
import { service, actor, databaseAdapter, prepareServiceFixture } from "./credit-sadmin-service-fixture.mjs";

const emptyDb = { ...catalogs, $queryRawUnsafe: async () => [], credito: { findMany: async () => [] } };
const commit = (requestId = randomUUID()) => ({ commit: true, sadminConfirmed: true, requestId });

test("preview: errors on every duplicate row; numbers are text and keep leading zeros", async () => {
  const route = routeFixture(emptyDb);
  const { data } = await call(route, [sample(1, { numeroCreditoSadmin: " 000-AbC " }), sample(2, { numeroCreditoSadmin: "000-abc" }), sample(3, { cedula: "09.000-01" })]);
  assert.equal(data.commit, false); assert.equal(data.summary.invalid, 3);
  assert.match(data.rows[0].errors.join(" "), /SADMIN repetido/);
  assert.match(data.rows[1].errors.join(" "), /SADMIN repetido/);
  assert.match(data.rows[0].errors.join(" "), /Cédula repetida/);
  assert.match(data.rows[2].errors.join(" "), /Cédula repetida/);
  assert.equal(data.rows[0].normalized.numeroCreditoSadmin, "000-AbC");
});
test("missing, blank, numeric, overlong and control-character SADMIN values cannot be imported", async () => {
  for (const number of [undefined, "", "   ", 123, "x".repeat(81), "12\n34"]) {
    const { data } = await call(routeFixture(emptyDb), [sample(1, { numeroCreditoSadmin: number })]);
    assert.equal(data.summary.invalid, 1); assert.equal(data.rows[0].ok, false);
    assert.match(data.rows[0].errors.join(" "), /SADMIN/);
  }
});
test("missing payment date and blacklist are reported on the affected row", async () => {
  const { data } = await call(routeFixture(emptyDb, { blocked: "900001" }), [sample(1), sample(2, { fechaPago: "" })]);
  assert.match(data.rows[0].errors.join(" "), /bloqueada/);
  assert.match(data.rows[1].errors.join(" "), /FECHA DE PAGO/);
  assert.equal(data.summary.invalid, 2);
});
test("commit requires explicit admin attestation, a retry identifier and central-admin access", async () => {
  const route = routeFixture(emptyDb);
  for (const sadminConfirmed of [undefined, false, "true", 1]) {
    const result = await call(route, [sample()], { commit: true, sadminConfirmed, requestId: randomUUID() });
    assert.equal(result.status, 400); assert.equal(result.data.code, "SADMIN_CONFIRMATION_REQUIRED");
  }
  assert.equal((await call(route, [sample()], { commit: true, sadminConfirmed: true })).data.code, "INVALID_IMPORT_REQUEST");
  assert.equal((await call(routeFixture(emptyDb, { user: null }), [sample()])).status, 401);
  assert.equal((await call(routeFixture(emptyDb, { user: { rolNombre: "VENDEDOR" } }), [sample()], commit())).status, 403);
});

const connectionString = process.env.MASS_CREDIT_TEST_DATABASE_URL;
test("PostgreSQL: CSV and individual creation, listing, atomic failures, replay and concurrency", {
  skip: !connectionString && "Requires isolated loopback mass_credit_sadmin_test database",
}, async t => {
  const pool = new pg.Pool({ connectionString, max: 8 });
  t.after(() => pool.end());
  await prepareServiceFixture(pool, connectionString, "mass_credit_sadmin_test");
  const state = {};
  const route = routeFixture(postgresAdapter(pool, state));
  const list = input => service.listSadminCredits(databaseAdapter(pool), actor, input);
  const counts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM "Credito") AS credits, (SELECT count(*)::int FROM "CreditSadminRegistration") AS registrations, (SELECT count(*)::int FROM "CreditSadminEvent") AS events')).rows[0];
  let first;
  await t.test("CSV creates two linked credits with audited SADMIN numbers; listing has no pending entries", async () => {
    const rows = [sample(1), sample(2)]; const request = commit();
    const preview = await call(route, rows);
    assert.equal(preview.data.summary.valid, 2);
    const result = await call(route, rows, request); first = { rows, request, result };
    assert.equal(result.status, 200); assert.equal(result.data.created, 2); assert.equal(result.data.commit, true);
    const page = await list({ status: "created" });
    assert.equal(page.total, 2); assert.equal(page.counts.pending, 0);
    for (const item of page.items) {
      assert.equal(item.sadmin.estado, "CREADO_SADMIN");
      assert.equal(item.numeroCreditoVisible, item.sadmin.numeroCredito);
      const index = Number(item.clienteDocumento.slice(-1));
      assert.equal(item.sadmin.numeroCredito, sample(index).numeroCreditoSadmin);
    }
    const saved = await pool.query('SELECT "contratoSnapshot" AS snapshot FROM "Credito" ORDER BY "id"');
    assert.equal(saved.rows[0].snapshot.cliente.cedula, rows[0].cedula);
    assert.equal(saved.rows[0].snapshot.origen.numeroCreditoSadmin, rows[0].numeroCreditoSadmin);
    const audit = await pool.query('SELECT "actorUserId","payload" FROM "CreditSadminEvent"');
    assert.ok(audit.rows.every(row => row.actorUserId === 1 && row.payload.confirmation === "ADMIN_EXISTING_SADMIN"));
  });
  await t.test("individual uses the same endpoint and appears in SADMIN with its number", async () => {
    const result = await call(route, [sample(3)], commit());
    assert.equal(result.data.created, 1);
    const page = await list({ q: "000-SADMIN-3", status: "created" });
    assert.equal(page.total, 1); assert.equal(page.items[0].clienteDocumento, "900003");
  });
  await t.test("existing document and existing number reject the complete batch before any insertion", async () => {
    const before = await counts();
    const result = await call(route, [sample(4, { cedula: "09.000-01" }), sample(5, { numeroCreditoSadmin: " 000-sadmin-2 " }), sample(6)], commit());
    assert.equal(result.data.commit, false); assert.equal(result.data.summary.invalid, 2);
    assert.match(result.data.rows[0].errors.join(" "), /ya tiene un crédito/);
    assert.match(result.data.rows[1].errors.join(" "), /ya registrado/);
    assert.deepEqual(await counts(), before);
    await pool.query('UPDATE "Credito" SET "estado"=$1 WHERE "clienteDocumento"=$2', ["PAGADO", "900003"]);
    assert.equal((await call(route, [sample(7, { cedula: "900003" })])).data.summary.invalid, 1);
  });
  await t.test("replay after lost response returns same credit IDs without duplication", async () => {
    const before = await counts();
    const replay = await call(route, first.rows, first.request);
    assert.deepEqual(replay.data, first.result.data); assert.deepEqual(await counts(), before);
    const conflict = await call(route, [sample(7), sample(8)], first.request);
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, "IMPORT_REQUEST_CONFLICT");
  });
  for (const fault of ["failRegistration", "failAudit"]) {
    await t.test(`${fault}: rolls back credit, registration and audit, then retry succeeds`, async () => {
      const index = fault === "failRegistration" ? 10 : 11;
      const before = await counts(); const request = commit(); state[fault] = true;
      const failed = await call(route, [sample(index)], request);
      assert.equal(failed.status, 500); assert.equal(failed.data.code, "IMPORT_SAVE_FAILED");
      assert.deepEqual(await counts(), before); state[fault] = false;
      const retried = await call(route, [sample(index)], request);
      assert.equal(retried.data.created, 1);
      assert.equal((await list({ q: sample(index).numeroCreditoSadmin, status: "created" })).total, 1);
    });
  }
  await t.test("failure on second CSV row rolls back the first credit and its completed registration", async () => {
    const before = await counts(); const request = commit();
    state.failRegistrationNumber = sample(13).numeroCreditoSadmin;
    const failed = await call(route, [sample(12), sample(13)], request);
    assert.equal(failed.status, 500); assert.deepEqual(await counts(), before);
    delete state.failRegistrationNumber;
    assert.equal((await call(route, [sample(12), sample(13)], request)).data.created, 2);
  });
  await t.test("simultaneous same document allows only one new credit", async () => {
    const outcomes = await Promise.all([call(route, [sample(20)], commit()), call(route, [sample(21, { cedula: sample(20).cedula })], commit())]);
    assert.equal(outcomes.filter(result => result.data.commit).length, 1);
    const rejected = outcomes.find(result => !result.data.commit);
    assert.match(rejected.data.rows[0].errors.join(" "), /ya tiene un crédito/);
  });
  await t.test("unique SADMIN constraint rejects racing requests and rolls back the loser", async () => {
    const before = await counts();
    let release; let arrived = 0;
    const ready = new Promise(resolve => { release = resolve; });
    state.beforeRegistration = async () => { if (++arrived === 2) release(); await ready; };
    const outcomes = await Promise.all([call(route, [sample(30)], commit()), call(route, [sample(31, { numeroCreditoSadmin: sample(30).numeroCreditoSadmin })], commit())]);
    delete state.beforeRegistration;
    assert.equal(outcomes.filter(result => result.data.commit).length, 1);
    assert.equal(outcomes.find(result => !result.data.commit).data.code, "IMPORT_DUPLICATE");
    const after = await counts();
    assert.deepEqual(after, { credits: before.credits + 1, registrations: before.registrations + 1, events: before.events + 1 });
  });
  await t.test("concurrent identical retries produce one credit and identical receipts", async () => {
    const request = commit(); const before = await counts();
    const [one, two] = await Promise.all([call(route, [sample(40)], request), call(route, [sample(40)], request)]);
    assert.deepEqual(one.data, two.data);
    assert.equal((await counts()).credits, before.credits + 1);
  });
});
