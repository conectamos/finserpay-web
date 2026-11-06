import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { buildCutAutomaticAnalysis, buildDirectCutRows, summarizeCutRows } = await jiti.import("../lib/cut-collection.ts");
const filters = { day: 2, month: 11, year: 2026, aliadoId: null, sedeId: null, status: "todos" };
const payment = (id, value, paidAt) => ({ id, value, paidAt, createdAt: paidAt, state: "ACTIVO", annulledAt: null, method: "EFECTIVO" });
function credit(id, payments = [], extra = {}) {
  return { id, folio: `PRIVATE-FOLIO-${id}`, clientName: `PRIVATE-NAME-${id}`, document: `PRIVATE-DOCUMENT-${id}`,
    aliadoId: id, aliado: `Comercio ${id}`, sedeId: id, sede: `Sede ${id}`, state: "ACTIVO", settledAt: null,
    originatedAt: "2026-10-17T15:00:00Z", plan: { montoCredito: 300, valorCuota: 100, plazoMeses: 3,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-11-02", fechaProximoPago: null, settled: false }, payments, ...extra };
}
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("análisis deriva dos cortes anteriores y edades por día local de Bogotá, incluido cambio de año", () => {
  const analysis = buildCutAutomaticAnalysis([], { ...filters, day: 2, month: 1, year: 2027 }, "2027-01-03T04:59:59.999Z");
  assert.deepEqual(analysis.cuts.map(cut => [cut.cutDate, cut.ageDays]), [["2027-01-02", 0], ["2026-12-17", 16], ["2026-12-02", 31]]);
  assert.equal(analysis.collectionBasis.referenceAgeDays, 0);
  const tomorrow = buildCutAutomaticAnalysis([], { ...filters, day: 2, month: 1, year: 2027 }, "2027-01-03T05:00:00.000Z");
  assert.equal(tomorrow.cuts[0].ageDays, 1);
  const future = buildCutAutomaticAnalysis([], { ...filters, day: 17 }, "2026-11-06T17:00:00Z");
  assert.equal(future.cuts[0].ageDays, -11);
  assert.equal(future.collectionBasis.referenceAgeDays, null);
  assert.deepEqual(future.cuts.map(cut => cut.cutDate), ["2026-11-17", "2026-11-02", "2026-10-17"]);
});

test("análisis conserva recaudo acumulado sin truncarlo a una edad inventada y no expone datos personales", () => {
  const loan = credit(1, [payment(1, 250, "2026-11-05T15:00:00Z")]);
  loan.plan.fechaPrimerPago = "2026-10-02";
  const inputs = freeze([loan]);
  const before = structuredClone(inputs);
  const selected = freeze({ ...filters, status: "pagado" });
  const asOf = "2026-11-06T17:00:00Z";
  const analysis = buildCutAutomaticAnalysis(inputs, selected, asOf);
  assert.equal(analysis.filters.status, "todos");
  assert.equal(selected.status, "pagado");
  assert.deepEqual(analysis.collectionBasis, { mode: "current_accumulated", sameAgeAvailable: false,
    referenceAgeDays: 4, reason: "NO_COMPLETE_HISTORICAL_LEDGER" });
  assert.deepEqual(analysis.cuts.map(cut => cut.summary.received), [50, 100, 100]);
  for (const cut of analysis.cuts) {
    assert.deepEqual(cut.summary, summarizeCutRows(buildDirectCutRows(inputs, cut.cutDate, asOf).rows));
    assert.equal(cut.unavailableCredits, 0);
  }
  assert.deepEqual(analysis.warnings, []);
  assert(!JSON.stringify(analysis).includes("PRIVATE-"));
  assert.deepEqual(inputs, before);
});

test("prioridades ordenan saldo sin paz y salvo y conservan FPD 3 observado con saldo cero", () => {
  const loans = [
    credit(1, [payment(1, 40, "2026-11-03T15:00:00Z")]),
    credit(2, [payment(2, 80, "2026-11-03T15:00:00Z")]),
    credit(3, [payment(3, 100, "2026-11-07T15:00:00Z")]),
    credit(4, [], { settledAt: "2026-11-04T15:00:00Z" }),
  ];
  loans[3].plan.settled = true;
  const analysis = buildCutAutomaticAnalysis(freeze(loans), filters, "2026-11-10T17:00:00Z");
  const current = analysis.cuts[0].summary;
  assert.equal(current.pending, 180);
  assert.equal(current.pendingClients, 3);
  for (const groups of [analysis.priorities.allies, analysis.priorities.sites]) {
    assert.deepEqual(groups.map(group => group.id), [1, 2, 3, 4]);
    assert.deepEqual(groups.map(group => group.collectiblePending), [60, 20, 0, 0]);
    assert.equal(groups.find(group => group.id === 4).pending, 100);
    assert.deepEqual(groups.find(group => group.id === 3).fpd3,
      { label: "DPF 3", cases: 1, eligible: 1, pending: 0, unavailable: 0 });
    assert.equal(groups.find(group => group.id === 3).fpd3Rate, 100);
    assert.equal(groups.reduce((sum, group) => sum + group.pending, 0), current.pending);
  }
  assert.match(analysis.warnings.join(" "), /paz y salvo/);
});

test("conciliación incompleta produce total nulo y deshabilita ranking sin inventar riesgo cero", () => {
  const invalid = credit(2, [payment(2, -1, "2026-11-03T15:00:00Z")]);
  const analysis = buildCutAutomaticAnalysis([credit(1), invalid], filters, "2026-11-10T17:00:00Z");
  assert.equal(analysis.cuts[0].summary, null);
  assert.equal(analysis.cuts[0].unavailableCredits, 1);
  assert.deepEqual(analysis.priorities, { allies: [], sites: [] });
  assert.deepEqual(analysis.cuts[0].earlyRisk[0], { label: "DPF 3", cases: 1, eligible: 1, pending: 0, unavailable: 1 });
  assert.match(analysis.warnings.join(" "), /priorización por saldo está deshabilitada/);
  assert(!JSON.stringify(analysis).includes("PRIVATE-"));
});

test("FPD 3 agregado conserva tasa sin redondeo previo ni promedio de tasas individuales", () => {
  const loans = [credit(1), credit(2, [payment(2, 100, "2026-11-03T15:00:00Z")]), credit(3, [payment(3, 100, "2026-11-03T15:00:00Z")])];
  for (const loan of loans) Object.assign(loan, { aliadoId: 1, aliado: "Comercio 1", sedeId: 1, sede: "Sede 1" });
  const analysis = buildCutAutomaticAnalysis(loans, filters, "2026-11-10T17:00:00Z");
  assert.equal(analysis.priorities.allies[0].fpd3.eligible, 3);
  assert.equal(analysis.priorities.allies[0].fpd3.cases, 1);
  assert.equal(analysis.priorities.allies[0].fpd3Rate, 1 / 3 * 100);
  assert.equal(analysis.priorities.sites[0].fpd3Rate, 1 / 3 * 100);
});

test("sin cuotas ni cohortes no se crean prioridades ni porcentajes, y duplicados no duplican importes", () => {
  const analysis = buildCutAutomaticAnalysis([], filters, "2026-11-06T17:00:00Z");
  assert(analysis.cuts.every(cut => cut.summary.expected === 0 && cut.summary.completion === null &&
    cut.earlyRisk.every(metric => metric.cases === 0 && metric.eligible === 0 && metric.pending === 0 && metric.unavailable === 0)));
  assert.deepEqual(analysis.priorities, { allies: [], sites: [] });
  const one = credit(1);
  assert.throws(() => buildCutAutomaticAnalysis([one, one], filters, "2026-11-06T17:00:00Z"), /duplicados/);
});
