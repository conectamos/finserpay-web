import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const engine = await jiti.import("../lib/cut-collection.ts");
const accessModule = await jiti.import("../lib/cut-collection-access.ts");
const { buildCutCollectionWorkbook } = await jiti.import("../lib/cut-collection-excel.ts");
const { cutAccessFromDashboard, parseCutFilters } = accessModule;
const numberRules = await jiti.import("../lib/credit-display-number.ts");
const numberModule = { exports: {} };
const numberCode = ts.transpileModule(readFileSync(path.join(root, "lib/credit-display-number-server.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function("require", "module", "exports", numberCode)(name => {
  if (name === "server-only") return {};
  if (name === "@/lib/credit-display-number") return numberRules;
  if (name === "@/lib/prisma") return { default: new Proxy({}, { get() { throw new Error("Live Prisma access forbidden"); } }) };
  throw new Error(`Unexpected display-number dependency: ${name}`);
}, numberModule, numberModule.exports);
const source = readFileSync(path.join(root, "lib/cut-collection-storage.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loadedModule = { exports: {} };
const mocks = {
  "./cut-collection": engine, "./cut-collection-access": accessModule,
  "./credit-display-number-server": numberModule.exports,
};
new Function("require", "module", "exports", compiled)(name => {
  if (name in mocks) return mocks[name];
  assert.equal(name, "node:crypto", `No live dependency allowed: ${name}`);
  return require(name);
}, loadedModule, loadedModule.exports);
const { createCutCollectionStore } = loadedModule.exports;
const migration = readFileSync(path.join(root, "scripts/setup-cut-collection.sql"), "utf8");
const filters = { day: 17, month: 10, year: 2026, aliadoId: null, sedeId: null, status: "todos" };
const central = cutAccessFromDashboard({ admin: true, supervisor: false,
  session: { id: 1, sedeId: 10, aliadoAccesoId: 1, aliadoAccesoCodigo: "FINSERPAY" } });
const allied = cutAccessFromDashboard({ admin: true, supervisor: false,
  session: { id: 2, sedeId: 20, aliadoAccesoId: 2, aliadoAccesoCodigo: "ALIADO" } });
const supervisor = cutAccessFromDashboard({ admin: false, supervisor: true,
  session: { id: 3, sedeId: 20, aliadoAccesoId: 2, aliadoAccesoCodigo: "ALIADO" } });
const fixtureSql = `
CREATE TABLE "Aliado"(id integer PRIMARY KEY,nombre text);
CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer);
CREATE TABLE "Credito"(id serial PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,
  "sedeId" integer,estado text,"montoCredito" float,"valorCuota" float,"plazoMeses" integer,
  "frecuenciaPago" text,"fechaPrimerPago" timestamp,"fechaProximoPago" timestamp,"pazYSalvoEmitidoAt" timestamp);
CREATE TABLE "CreditoAbono"(id serial PRIMARY KEY,"creditoId" integer,valor float,estado text,"metodoPago" text,
  "sedeId" integer,"fechaAbono" timestamp,"createdAt" timestamp,"anuladoAt" timestamp);
CREATE TABLE "CreditSadminRegistration"("creditoId" integer PRIMARY KEY,"numeroCredito" text,"numeroCreditoConfirmado" boolean);
INSERT INTO "Aliado" VALUES(1,'FINSER PAY'),(2,'Aliado autorizado'),(3,'Aliado externo');
INSERT INTO "Sede" VALUES(10,'Central',1),(20,'Sede propia',2),(21,'Segunda sede del aliado',2),(30,'Sede ajena',3),(99,'Recaudo digital',1);`;

function adapter(database, calls = []) {
  return {
    $queryRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return (await database.query(sql, args)).rows; },
    $transaction: async (callback, options) => {
      assert.deepEqual(options, { isolationLevel: "RepeatableRead", timeout: 60000, maxWait: 10000 });
      return database.transaction(tx => callback(adapter(tx, calls)));
    },
  };
}
async function fixture(t, install = true) {
  // Match adapter-pg/Prisma: timestamp without timezone is a UTC Date, not host-local time.
  const pg = new PGlite({ parsers: {
    1114: value => new Date(`${value.replace(" ", "T")}Z`),
    1082: value => new Date(`${value}T00:00:00.000Z`),
  } });
  t.after(() => pg.close());
  await pg.exec(fixtureSql);
  if (install) await pg.exec(migration);
  const calls = [];
  const db = adapter(pg, calls);
  const store = createCutCollectionStore(db);
  let sequence = 0;
  async function credit(input = {}) {
    sequence++;
    const result = await pg.query(`INSERT INTO "Credito"
      (folio,"clienteNombre","clienteDocumento","sedeId",estado,"montoCredito","valorCuota","plazoMeses","frecuenciaPago","fechaPrimerPago")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamp) RETURNING id`, [input.folio || `CR-${sequence}`,
      input.name || `Cliente ${sequence}`, input.document || String(1000 + sequence), input.sedeId || 20,
      input.state || "ACTIVO", input.total ?? 300, input.installment ?? 100, input.count ?? 3,
      input.frequency || "QUINCENAL", input.first || "2026-10-02T00:00:00.000Z"]);
    return result.rows[0].id;
  }
  async function payment(creditId, value, input = {}) {
    const result = await pg.query(`INSERT INTO "CreditoAbono"
      ("creditoId",valor,estado,"metodoPago","sedeId","fechaAbono","createdAt","anuladoAt")
      VALUES($1,$2,$3,$4,$5,$6::timestamp,$7::timestamp,$8::timestamp) RETURNING id`,
      [creditId, value, input.state || "ACTIVO", input.method || "EFECTIVO", input.sedeId || 20,
        input.paidAt || "2026-10-01T17:00:00.000Z", input.createdAt || "2026-10-01T17:00:00.000Z", input.annulledAt || null]);
    return result.rows[0].id;
  }
  async function financialData() {
    return { credits: (await pg.query('SELECT * FROM "Credito" ORDER BY id')).rows,
      payments: (await pg.query('SELECT * FROM "CreditoAbono" ORDER BY id')).rows };
  }
  return { pg, store, db, calls, credit, payment, financialData };
}
function totalsMatch(report) {
  for (const field of ["expected", "received", "pending", "priorPayments", "priorReversals"]) {
    assert.equal(Math.round(report.summary[field] * 100), report.rows.reduce((sum, row) => sum + Math.round(row[field] * 100), 0), field);
  }
}

test("consulta directa funciona sin tabla de proyecciones, suma lo pagado y no escribe", async t => {
  const f = await fixture(t, false);
  const id = await f.credit();
  await f.payment(id, 150);
  await f.payment(id, 25, { paidAt: "2026-10-25T19:00:00Z" });
  const before = await f.financialData();
  f.calls.length = 0;
  const report = await f.store.directReport(allied, filters);
  assert.equal(report.mode, "consulta");
  assert.equal(report.projection, null);
  assert.deepEqual(report.history, []);
  assert.deepEqual([report.summary.creditsCount, report.summary.expected, report.summary.received,
    report.summary.priorPayments, report.summary.pending], [1, 100, 75, 50, 25]);
  totalsMatch(report);
  assert.deepEqual(await f.financialData(), before);
  assert(f.calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
  assert(!f.calls.some(({ sql }) => /CutCollectionProjection|to_regclass/i.test(sql)));
});

test("consulta directa conserva créditos pagados en su fecha, filtros y sedes propietarias", async t => {
  const f = await fixture(t);
  const paid = await f.credit({ document: "555" });
  const pending = await f.credit({ document: "555" });
  const outside = await f.credit({ sedeId: 30 });
  await f.payment(paid, 200, { sedeId: 99, paidAt: "2026-10-17T17:00:00Z" });
  await f.payment(outside, 200, { sedeId: 20 });
  await f.pg.query('UPDATE "Credito" SET "fechaProximoPago"=$1 WHERE id=$2', ["2026-11-02T17:00:00Z", paid]);
  const report = await f.store.directReport(allied, filters);
  assert.deepEqual(report.rows.map(row => row.creditId), [paid, pending]);
  assert.equal(report.summary.creditsCount, 2);
  assert.equal(report.summary.pendingClients, 1);
  assert.equal(report.summary.received, 100);
  const filtered = await f.store.directReport(allied, { ...filters, status: "pagado" });
  assert.deepEqual(filtered.rows.map(row => row.creditId), [paid]);
  assert.equal(filtered.summary.creditsCount, 1);
  assert.equal(filtered.summary.expected, 100);
  totalsMatch(filtered);
  await assert.rejects(f.store.directReport(allied, { ...filters, sedeId: 30 }), /no autorizada/);
});

test("compara seis cohortes con pagos reales en una lectura y un instante sin historial ni Sadmin", async t => {
  const f = await fixture(t, false);
  await f.pg.exec('ALTER TABLE "Credito" ADD COLUMN "fechaCredito" timestamp');
  const dates = ["2020-11-17", "2020-09-17", "2020-11-02", "2020-10-02", "2020-10-17", "2020-12-02"];
  const atDay = (date, days) => new Date(Date.parse(`${date}T00:00:00-05:00`) + days * 86400000).toISOString();
  for (const [index, date] of dates.entries()) {
    const id = await f.credit({ first: date, total: 600, count: 6 });
    await f.pg.query('UPDATE "Credito" SET "fechaCredito"=$1 WHERE id=$2', [atDay(date, -15), id]);
    if (index === 1) await f.payment(id, 600, { paidAt: atDay(date, -1), sedeId: 99 });
    if (index === 2) await f.payment(id, 100, { paidAt: atDay(date, 5) });
    if (index === 3) await f.payment(id, 100, { state: "ANULADO", paidAt: atDay(date, -1), annulledAt: atDay(date, 4) });
    if (index === 4) await f.payment(id, 99, { paidAt: atDay(date, -1) });
  }
  await f.credit({ first: dates[0], sedeId: 30 });
  await f.credit({ first: "2019-10-17", installment: 0 });
  const before = await f.financialData();
  const inputDates = Object.freeze([...dates]);
  const inputFilters = Object.freeze({ ...filters, status: "pagado" });
  let transactions = 0;
  const store = createCutCollectionStore({ ...f.db, $transaction: (...args) => { transactions++; return f.db.$transaction(...args); } });
  f.calls.length = 0;
  const comparison = await store.directRiskComparison(allied, inputFilters, inputDates);
  assert.equal(transactions, 1);
  assert.deepEqual(comparison.map(item => item.cutDate), dates);
  assert.equal(new Set(comparison.map(item => item.queriedAt)).size, 1);
  assert(comparison.every(item => Number.isFinite(Date.parse(item.queriedAt))));
  assert.deepEqual(comparison.map(item => item.earlyRisk.map(metric => [metric.cases, metric.eligible])), [
    [[1, 1], [1, 1], [1, 1], [1, 1]],
    [[0, 1], [0, 1], [0, 1], [0, 1]],
    [[1, 1], [0, 1], [0, 1], [1, 1]],
    [[0, 1], [1, 1], [1, 1], [1, 1]],
    [[1, 1], [1, 1], [1, 1], [1, 1]],
    [[1, 1], [1, 1], [1, 1], [1, 1]],
  ]);
  assert.equal(f.calls.length, 4, "scope, database time, credits and payments are each read once");
  assert.equal(f.calls.filter(({ sql }) => sql.includes("CURRENT_TIMESTAMP")).length, 1);
  const cohortQueries = f.calls.filter(({ sql }) => sql.includes('c."fechaPrimerPago"::date=ANY($2::date[])'));
  assert.equal(cohortQueries.length, 2);
  assert(cohortQueries.every(({ args }) => JSON.stringify(args) === JSON.stringify([[20, 21], dates])));
  assert(f.calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
  assert(!f.calls.some(({ sql }) => /CutCollectionProjection|CreditSadminRegistration|to_regclass|OFFSET/i.test(sql)));
  assert.deepEqual(await f.financialData(), before);
  assert.deepEqual(inputDates, dates);
  assert(comparison.every(item => Object.keys(item).sort().join() === "cutDate,earlyRisk,queriedAt"));
});

test("comparación y reporte unitario miden seis cuotas al cierre del tercer mes calendario", async t => {
  const f = await fixture(t, false);
  await f.pg.exec('ALTER TABLE "Credito" ADD COLUMN "fechaCredito" timestamp');
  const first = "2020-02-02";
  const complete = await f.credit({ first, total: 600, count: 6 });
  const incomplete = await f.credit({ first, total: 600, count: 6 });
  const fiveInstallments = await f.credit({ first, total: 500, count: 5 });
  const reversedSixth = await f.credit({ first, total: 600, count: 6 });
  await f.pg.query('UPDATE "Credito" SET "fechaCredito"=$1', ["2020-01-31T15:00:00Z"]);
  await f.payment(complete, 500, { paidAt: "2020-03-15T15:00:00Z" });
  await f.payment(complete, 100, { paidAt: "2020-05-01T04:59:59.999Z" });
  await f.payment(incomplete, 500, { paidAt: "2020-04-30T17:00:00Z" });
  await f.payment(incomplete, 100, { paidAt: "2020-05-01T05:00:00Z" });
  await f.payment(fiveInstallments, 500, { paidAt: "2020-04-30T17:00:00Z" });
  await f.payment(reversedSixth, 500, { paidAt: "2020-03-15T15:00:00Z" });
  await f.payment(reversedSixth, 100, { state: "ANULADO", paidAt: "2020-04-15T15:00:00Z", annulledAt: "2020-04-30T17:00:00Z" });
  const [comparison] = await f.store.directRiskComparison(allied, filters, [first]);
  const report = await f.store.directReport(allied, { ...filters, day: 2, month: 2, year: 2020 });
  assert.deepEqual(comparison.earlyRisk, report.earlyRisk);
  assert.deepEqual(comparison.earlyRisk.at(-1),
    { label: "40/60", cases: 2, eligible: 3, pending: 0, unavailable: 1 });
});

test("comparación respeta aliado, supervisor, sede propietaria y movimientos sin filtrar por estado actual", async t => {
  const f = await fixture(t, false);
  const dates = ["2020-10-02"];
  const own = await f.credit({ first: dates[0] });
  await f.credit({ first: dates[0], sedeId: 21 });
  const foreign = await f.credit({ first: dates[0], sedeId: 30 });
  await f.payment(foreign, 300, { sedeId: 20, paidAt: "2020-10-01T17:00:00Z" });
  const risk = async (access, selected = filters) => (await f.store.directRiskComparison(access, selected, dates))[0].earlyRisk;
  const adminRisk = await risk(allied);
  assert.deepEqual(adminRisk[0], { label: "DPF 3", cases: 2, eligible: 2, pending: 0, unavailable: 0 });
  assert.equal((await risk(supervisor))[0].eligible, 1);
  assert.deepEqual((await risk(central))[0], { label: "DPF 3", cases: 2, eligible: 3, pending: 0, unavailable: 0 });
  assert.deepEqual(await risk(central, { ...filters, aliadoId: 2 }), adminRisk);
  assert.equal((await risk(allied, { ...filters, sedeId: 21 }))[0].eligible, 1);
  for (const status of ["pendiente", "parcial", "pagado"]) assert.deepEqual(await risk(allied, { ...filters, status }), adminRisk);
  for (const [access, selected] of [[allied, { ...filters, aliadoId: 3 }], [allied, { ...filters, sedeId: 30 }], [supervisor, { ...filters, sedeId: 21 }]]) {
    await assert.rejects(f.store.directRiskComparison(access, selected, dates), error => error.status === 403);
  }
  await f.pg.query('UPDATE "Credito" SET "sedeId"=30 WHERE id=$1', [own]);
  assert.equal((await risk(allied))[0].eligible, 1);
  assert.equal((await risk(supervisor))[0].eligible, 0);
});

test("comparación valida cantidad, fechas y duplicados antes de consultar", async t => {
  const f = await fixture(t, false);
  const invalid = [[], null, "2020-10-02", ["2020-10-02", "2020-10-02"],
    ["2020-10-01"], ["2020-13-02"], ["2020-2-02"], ["2020-10-02T00:00:00Z"],
    ["1999-10-02"], ["2201-10-02"], [null], [42],
    ["2020-10-02", "2020-10-17", "2020-11-02", "2020-11-17", "2020-12-02", "2020-12-17", "2021-01-02"]];
  f.calls.length = 0;
  for (const dates of invalid) await assert.rejects(f.store.directRiskComparison(allied, filters, dates), error => error.status === 400);
  assert.deepEqual(f.calls, []);
});

test("comparación sin cohortes devuelve mediciones vacías sin requerir tablas de versiones", async t => {
  const f = await fixture(t, false);
  const dates = ["2020-10-02", "2020-10-17"];
  const comparison = await f.store.directRiskComparison({ ...allied, aliadoId: 999 }, filters, dates);
  assert.deepEqual(comparison.map(item => item.cutDate), dates);
  assert(comparison.every(item => item.earlyRisk.length === 4 && item.earlyRisk.every(metric =>
    metric.cases === 0 && metric.eligible === 0 && metric.pending === 0 && metric.unavailable === 0)));
  assert.equal(f.calls.length, 2, "an empty authorized scope requires only scope and database time");
});

test("comparación conserva no comparables de planes de capital sin construir el reporte completo", async t => {
  const f = await fixture(t, false);
  await f.pg.exec('ALTER TABLE "Credito" ADD COLUMN "planCapitalVigente" jsonb');
  const id = await f.credit({ first: "2020-10-02" });
  await f.pg.query('UPDATE "Credito" SET "planCapitalVigente"=$1::jsonb WHERE id=$2', [JSON.stringify({ requiresReconciliation: true }), id]);
  const [comparison] = await f.store.directRiskComparison(allied, filters, ["2020-10-02"]);
  assert(comparison.earlyRisk.every(metric => metric.unavailable === 1 && metric.eligible === 0));
});

test("guardar fija el esperado; los pagos parciales tardíos se aplican a cuotas reales y no alteran créditos", async t => {
  const f = await fixture(t);
  const id = await f.credit();
  await f.payment(id, 150);
  const beforeSave = await f.financialData();
  const saved = await f.store.save(allied, filters, randomUUID());
  assert.equal(saved.summary.expected, 50);
  assert.equal(saved.summary.priorPayments, 50);
  assert.equal(saved.summary.received, 0);
  assert.deepEqual(await f.financialData(), beforeSave);
  const storedBefore = (await f.pg.query('SELECT snapshot FROM "CutCollectionProjection"')).rows[0].snapshot;
  await f.payment(id, 25, { paidAt: "2026-10-25T19:00:00.000Z", createdAt: "2026-10-25T19:00:00.000Z" });
  const beforeRead = await f.financialData();
  const refreshed = await f.store.report(allied, filters, saved.projection.id);
  assert.deepEqual([refreshed.summary.expected, refreshed.summary.received, refreshed.summary.pending], [50, 25, 25]);
  assert.equal(refreshed.rows[0].lastPaymentAt, "2026-10-25T19:00:00.000Z");
  totalsMatch(refreshed);
  assert.deepEqual(await f.financialData(), beforeRead);
  assert.deepEqual((await f.pg.query('SELECT snapshot FROM "CutCollectionProjection"')).rows[0].snapshot, storedBefore);
  assert(!f.calls.some(({ sql }) => /^\s*(UPDATE|DELETE|ALTER|CREATE)\b/i.test(sql)));
  assert(f.calls.filter(({ sql }) => /^\s*INSERT\b/i.test(sql)).every(({ sql }) => sql.includes('"CutCollectionProjection"')));
});

test("Efecty retroactivo cuenta después de guardar por ID, usa sede del crédito y conserva anticipos previos", async t => {
  const f = await fixture(t);
  const id = await f.credit();
  await f.payment(id, 150, { method: "EFECTY", sedeId: 99,
    paidAt: "2026-09-01T20:00:00.000Z", createdAt: "2026-09-01T20:00:00.000Z" });
  const saved = await f.store.save(supervisor, filters, randomUUID());
  const lateId = await f.payment(id, 100, { method: "EFECTY", sedeId: 99,
    paidAt: "2026-09-30T20:00:00.000Z", createdAt: "2026-10-20T20:00:00.000Z" });
  const result = await f.store.report(supervisor, filters, saved.projection.id);
  assert.deepEqual([result.summary.priorPayments, result.summary.expected, result.summary.received, result.summary.futureAdvances], [50, 50, 50, 50]);
  assert.equal(result.rows[0].payments.find(payment => payment.id === lateId).previous, false);
  assert.equal(result.rows[0].sede, "Sede propia");
  totalsMatch(result);
});

test("el adaptador actual de Sadmin usa números confirmados sin salir de la transacción ni del alcance", async t => {
  const f = await fixture(t);
  const confirmed = await f.credit();
  const pending = await f.credit();
  const foreign = await f.credit({ sedeId: 30 });
  await f.pg.query(`INSERT INTO "CreditSadminRegistration" VALUES
    ($1,'  SADMIN-0042  ',TRUE),($2,'BORRADOR-999',FALSE),($3,'SECRETO-SADMIN',TRUE)`,
  [confirmed, pending, foreign]);
  const report = await f.store.save(allied, filters, randomUUID());
  assert.equal(report.rows.find(row => row.creditId === confirmed).folio, "SADMIN-0042");
  assert.equal(report.rows.find(row => row.creditId === pending).folio, "CR-2");
  assert(!JSON.stringify(report).includes("SECRETO-SADMIN"));
  assert(!JSON.stringify(report).includes("BORRADOR-999"));
  const lookups = f.calls.filter(({ sql }) => sql.includes('FROM "CreditSadminRegistration"'));
  assert(lookups.length > 0);
  assert(lookups.every(({ args }) => !args[0].includes(foreign)));
});

test("reversos y borrados de anticipos no sobrescriben el esperado ni duplican caja", async t => {
  const f = await fixture(t);
  const id = await f.credit();
  const first = await f.payment(id, 100);
  await f.payment(id, 50, { createdAt: "2026-10-02T17:00:00.000Z" });
  const saved = await f.store.save(allied, filters, randomUUID());
  await f.pg.query('UPDATE "CreditoAbono" SET estado=\'ANULADO\',"anuladoAt"=CURRENT_TIMESTAMP WHERE id=$1', [first]);
  const annulled = await f.store.report(allied, filters, saved.projection.id);
  assert.deepEqual([annulled.summary.expected, annulled.summary.received, annulled.summary.priorReversals, annulled.summary.pending], [50, 0, 50, 100]);
  await f.pg.query('DELETE FROM "CreditoAbono" WHERE id=$1', [first]);
  const removed = await f.store.report(allied, filters, saved.projection.id);
  assert.deepEqual(removed.summary, annulled.summary);
  totalsMatch(removed);
});

test("versiones conservan historial, claves idempotentes recuperan el original y nuevas claves crean versiones", async t => {
  const f = await fixture(t);
  const id = await f.credit();
  await f.payment(id, 100);
  const key = randomUUID();
  const first = await f.store.save(allied, filters, key);
  await f.payment(id, 30, { createdAt: "2026-10-20T12:00:00.000Z" });
  const retry = await f.store.save(allied, filters, key);
  assert.equal(retry.projection.id, first.projection.id);
  assert.equal(retry.projection.createdAt, first.projection.createdAt);
  assert.equal(retry.summary.expected, 100);
  assert.equal(retry.summary.received, 30);
  const second = await f.store.save(allied, filters, randomUUID());
  assert.notEqual(second.projection.id, first.projection.id);
  assert.equal(second.summary.expected, 70);
  assert.equal(second.summary.received, 0);
  assert.equal(second.history.length, 2);
  const original = second.history.find(item => item.id === first.projection.id);
  assert.deepEqual([original.expected, original.received, original.pending], [100, 30, 70]);
  await assert.rejects(f.store.save(allied, { ...filters, day: 2 }, key), error => error.status === 409);
  await assert.rejects(f.store.report(allied, { ...filters, month: 11 }, first.projection.id), /otro corte/);
  assert.equal((await f.pg.query('SELECT count(*)::int count FROM "CutCollectionProjection"')).rows[0].count, 2);
});

test("administrador aliado y supervisor restringen filas, opciones, proyecciones y sedes manipuladas", async t => {
  const f = await fixture(t);
  const own = await f.credit();
  const sibling = await f.credit({ sedeId: 21 });
  const outsider = await f.credit({ sedeId: 30, name: "SECRETO EXTERNO" });
  const all = await f.store.save(central, filters, randomUUID());
  assert.equal(all.rows.length, 3);
  const ally = await f.store.report(allied, filters, all.projection.id);
  assert.deepEqual(ally.rows.map(row => row.creditId), [own, sibling]);
  assert.deepEqual(ally.options.sedes.map(row => row.id).sort(), [20, 21]);
  assert(!JSON.stringify(ally).includes("SECRETO EXTERNO"));
  const local = await f.store.report(supervisor, filters, all.projection.id);
  assert.deepEqual(local.rows.map(row => row.creditId), [own]);
  assert.equal(local.summary.expected, 100);
  assert.equal(local.history[0].expected, 100);
  await assert.rejects(f.store.report(allied, { ...filters, aliadoId: 3 }), error => error.status === 403);
  await assert.rejects(f.store.report(supervisor, { ...filters, sedeId: 21 }), error => error.status === 403);
  const privateProjection = await f.store.save(central, { ...filters, sedeId: 30 }, randomUUID());
  assert.equal(privateProjection.rows[0].creditId, outsider);
  await assert.rejects(f.store.report(allied, filters, privateProjection.projection.id), error => error.status === 404);
});

test("mover un crédito fuera del alcance elimina su detalle e historial del reporte y Excel", async t => {
  const f = await fixture(t);
  const moved = await f.credit({ name: "CLIENTE MOVIDO RESERVADO" });
  const remains = await f.credit({ name: "CLIENTE AUTORIZADO" });
  await f.payment(moved, 120);
  const saved = await f.store.save(allied, filters, randomUUID());
  await f.pg.query('UPDATE "Credito" SET "sedeId"=30 WHERE id=$1', [moved]);
  const report = await f.store.report(allied, filters, saved.projection.id);
  assert.deepEqual(report.rows.map(row => row.creditId), [remains]);
  assert.equal(report.summary.expected, 100);
  assert.equal(report.history[0].expected, 100);
  assert.equal(report.history[0].rowCount, 1);
  assert(!JSON.stringify(report).includes("CLIENTE MOVIDO RESERVADO"));
  const book = buildCutCollectionWorkbook(report);
  assert(!JSON.stringify(book.model).includes("CLIENTE MOVIDO RESERVADO"));
  assert.equal(book.getWorksheet("Cuotas").rowCount, 2);
  // The new branch cannot see the old branch's historical snapshot either.
  const external = { userId: 4, central: false, aliadoId: 3, sedeId: null };
  await assert.rejects(f.store.report(external, filters, saved.projection.id), error => error.status === 404);
});

test("estado filtra tarjetas y Excel, incluidos otros recaudos solo de créditos visibles", async t => {
  const f = await fixture(t);
  const paid = await f.credit();
  const pending = await f.credit();
  const saved = await f.store.save(allied, filters, randomUUID());
  await f.payment(paid, 230, { createdAt: "2026-10-20T12:00:00.000Z" });
  await f.payment(pending, 50, { createdAt: "2026-10-20T12:00:00.000Z" });
  const report = await f.store.report(allied, { ...filters, status: "pagado" }, saved.projection.id);
  assert.equal(report.rows.length, 1);
  assert.deepEqual([report.summary.expected, report.summary.received, report.summary.previousRecovery, report.summary.futureAdvances], [100, 100, 100, 30]);
  const book = buildCutCollectionWorkbook(report);
  assert.equal(book.getWorksheet("Cuotas").rowCount, 2);
  assert.equal(book.getWorksheet("Cuotas").getRow(2).getCell(10).value, 100);
  totalsMatch(report);
});

test("historial pagina 12 versiones y permite consultar una antigua fuera de la página actual", async t => {
  const f = await fixture(t);
  const moved = await f.credit({ name: "CLIENTE HISTÓRICO TRASLADADO" });
  const own = await f.credit();
  const first = await f.store.save(allied, filters, randomUUID());
  await f.pg.query('UPDATE "Credito" SET "sedeId"=30 WHERE id=$1', [moved]);
  const ids = [first.projection.id];
  for (let index = 0; index < 11; index++) {
    const saved = await f.store.save(allied, filters, randomUUID());
    ids.push(saved.projection.id);
    assert.equal(saved.historyPage, 0);
  }
  const page0 = await f.store.report(allied, filters);
  assert.equal(page0.historyPage, 0);
  assert.equal(page0.historyHasMore, true);
  assert.equal(page0.history.length, 10);
  assert(!page0.history.some(item => item.id === first.projection.id));
  const page1 = await f.store.report(allied, filters, null, 1);
  assert.equal(page1.historyPage, 1);
  assert.equal(page1.historyHasMore, false);
  assert.equal(page1.history.length, 2);
  assert.deepEqual(new Set([...page0.history, ...page1.history].map(item => item.id)), new Set(ids));
  const historical = await f.store.report(allied, filters, first.projection.id);
  assert.equal(historical.projection.id, first.projection.id);
  assert.deepEqual(historical.rows.map(row => row.creditId), [own]);
  assert.equal(historical.summary.expected, 100);
  assert(!JSON.stringify(historical).includes("CLIENTE HISTÓRICO TRASLADADO"));
  assert.equal(historical.history.length, 10);
  assert.equal((await f.store.report(allied, filters, first.projection.id, 2)).history.length, 0);
  const paginatedCalls = f.calls.filter(({ sql }) => sql.includes("LIMIT 11 OFFSET"));
  assert(paginatedCalls.some(({ args }) => args[1] === 10));
  assert(paginatedCalls.some(({ args }) => args[1] === 20));
  for (const invalid of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.store.report(allied, filters, null, invalid), /Página de historial inválida/);
  }
});

test("proyecciones multisedes sin cuotas autorizadas no ocupan páginas ni revelan más historial", async t => {
  const f = await fixture(t);
  await f.credit({ sedeId: 30, name: "VERSIÓN SOLO AJENA" });
  const privateVersion = await f.store.save(central, filters, randomUUID());
  await assert.rejects(f.store.report(allied, filters, privateVersion.projection.id), error => error.status === 404);
  for (let index = 0; index < 11; index++) await f.store.save(central, filters, randomUUID());
  const own = await f.credit();
  const mixed = await f.store.save(central, filters, randomUUID());
  const report = await f.store.report(allied, filters);
  assert.equal(report.history.length, 1);
  assert.equal(report.history[0].id, mixed.projection.id);
  assert.equal(report.history[0].expected, 100);
  assert.equal(report.historyHasMore, false);
  assert.deepEqual(report.rows.map(row => row.creditId), [own]);
  assert(!JSON.stringify(report).includes("VERSIÓN SOLO AJENA"));
});

test("la base rechaza UPDATE/DELETE de proyecciones y la migración puede repetirse sin pérdida", async t => {
  const f = await fixture(t);
  await f.credit();
  const saved = await f.store.save(allied, filters, randomUUID());
  await assert.rejects(f.pg.query('UPDATE "CutCollectionProjection" SET snapshot=\'{}\'::jsonb WHERE id=$1::uuid', [saved.projection.id]), /inmutables/);
  await assert.rejects(f.pg.query('DELETE FROM "CutCollectionProjection" WHERE id=$1::uuid', [saved.projection.id]), /inmutables/);
  await f.pg.exec(migration);
  const original = await f.store.report(allied, filters, saved.projection.id);
  assert.equal(original.summary.expected, 100);
  assert.equal(original.history.length, 1);
});

test("sin esquema solo funciona la vista previa sin instalar tablas ni tocar finanzas", async t => {
  const f = await fixture(t, false);
  await f.credit();
  const before = await f.financialData();
  const report = await f.store.report(allied, filters);
  assert.equal(report.projection, null);
  assert.equal(report.rows.length, 1);
  assert.match(report.warnings.join(" "), /instalar el esquema/);
  await assert.rejects(f.store.save(allied, filters, randomUUID()), error => error.status === 503);
  const present = (await f.pg.query(`SELECT to_regclass('public."CutCollectionProjection"') AS present`)).rows[0].present;
  assert.equal(present, null);
  assert.deepEqual(await f.financialData(), before);
});

test("el guardado reintenta conflictos de serialización y preserva un único snapshot", async t => {
  const f = await fixture(t);
  await f.credit();
  let attempts = 0;
  const retryStore = createCutCollectionStore({ ...f.db, $transaction: async (...args) => {
    if (++attempts < 3) throw Object.assign(new Error("serialization conflict"), { code: "P2034" });
    return f.db.$transaction(...args);
  } });
  const saved = await retryStore.save(allied, filters, randomUUID());
  assert.equal(attempts, 3);
  assert(saved.projection.id);
  assert.equal((await f.pg.query('SELECT count(*)::int count FROM "CutCollectionProjection"')).rows[0].count, 1);
});

test("autenticación, rol y filtros se validan y la fecha por defecto usa Bogotá", () => {
  assert.throws(() => cutAccessFromDashboard(null), error => error.status === 401);
  assert.throws(() => cutAccessFromDashboard({ admin: false, supervisor: false, session: { id: 5, sedeId: 20 } }), error => error.status === 403);
  assert.throws(() => cutAccessFromDashboard({ admin: true, supervisor: false, session: { id: 5, sedeId: 20 } }), error => error.status === 403);
  assert.throws(() => cutAccessFromDashboard({ admin: false, supervisor: true, session: { id: 5, sedeId: 0 } }), error => error.status === 403);
  const local = parseCutFilters({}, new Date("2026-10-18T02:00:00.000Z"));
  assert.deepEqual([local.day, local.month, local.year], [17, 10, 2026]);
  const next = parseCutFilters({}, new Date("2027-01-01T03:00:00.000Z"));
  assert.deepEqual([next.day, next.month, next.year], [2, 1, 2027]);
  for (const input of [{ day: 3 }, { month: 13 }, { year: 1999 }, { aliadoId: "1 OR 1=1" }, { status: "otro" }]) {
    assert.throws(() => parseCutFilters(input), /inválido|inválida|02 o 17/);
  }
});
