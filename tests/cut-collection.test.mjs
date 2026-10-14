import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { captureCutSnapshot, buildCutRows, summarizeCutRows } = await jiti.import("../lib/cut-collection.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");
const cut = "2026-10-17";
const captured = "2026-10-14T15:00:00.000Z";
function payment(id, value, options = {}) {
  return { id, value, paidAt: `2026-10-${String(id < 10 ? 1 : 20).padStart(2, "0")}T16:00:00.000Z`,
    createdAt: id < 10 ? `2026-10-01T16:00:0${id}.000Z` : "2026-10-20T16:00:00.000Z",
    state: "ACTIVO", annulledAt: null, method: "EFECTIVO", ...options };
}
function credit(payments = [], options = {}) {
  return { id: 1, folio: "CR-1", clientName: "Cliente", document: "123", aliadoId: 1, aliado: "Aliado",
    sedeId: 1, sede: "Sede", state: "ACTIVO", plan: { montoCredito: 300, valorCuota: 100, plazoMeses: 3,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02", settled: false }, payments, ...options };
}
function report(saved, current = saved) {
  const snapshot = captureCutSnapshot(saved, cut, captured);
  const result = buildCutRows(snapshot, current);
  return { snapshot, ...result, summary: summarizeCutRows(result.rows, result.previousRecovery, result.futureAdvances) };
}

test("solo las cuotas del calendario seleccionado integran la proyección y el esperado es inmutable", () => {
  const original = credit([payment(1, 150)]);
  const result = report([original], [credit([payment(1, 150), payment(10, 25)])]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].installment, 2);
  assert.equal(result.rows[0].dueDate, cut);
  assert.deepEqual([result.summary.priorPayments, result.summary.expected, result.summary.received, result.summary.pending], [50, 50, 25, 25]);
  assert.equal(result.summary.completion, 50);
  original.plan.valorCuota = 500;
  original.payments[0].value = 1;
  assert.equal(result.snapshot.credits[0].plan.valorCuota, 100);
  assert.equal(result.snapshot.credits[0].payments[0].value, 150);
});

test("el esperado y los vencimientos se leen de valores persistidos, sin reconstruirlos del input", () => {
  const original = credit([payment(1, 150)]);
  const snapshot = captureCutSnapshot([original], cut, captured);
  assert.equal(snapshot.schedule[1].saldoPendiente, 50);
  snapshot.credits[0].plan.valorCuota = 999;
  snapshot.credits[0].plan.fechaPrimerPago = "2027-01-02";
  const result = buildCutRows(snapshot, [credit([payment(1, 150), payment(10, 20)])]);
  assert.deepEqual([result.rows[0].dueDate, result.rows[0].expected, result.rows[0].priorPayments, result.rows[0].received], [cut, 50, 50, 20]);
});

test("el recaudo tardío se distribuye entre mora, corte y cuotas futuras sin duplicarse", () => {
  const result = report([credit([payment(1, 50)])], [credit([payment(1, 50), payment(10, 220)])]);
  assert.deepEqual([result.summary.previousRecovery, result.summary.received, result.summary.futureAdvances], [50, 100, 70]);
  assert.equal(result.summary.pending, 0);
  assert.equal(result.rows[0].lastPaymentAt, "2026-10-20T16:00:00.000Z");
  assert.equal(result.rows[0].status, "pagado");
});

test("Efecty importado después con fecha histórica es nuevo por identidad y sigue el orden del recibo oficial", () => {
  const newReceipt = payment(10, 50, { paidAt: "2026-09-30T22:00:00.000Z", method: "EFECTY" });
  const result = report([credit([payment(1, 150)])], [credit([newReceipt, payment(1, 150)])]);
  assert.equal(result.summary.received, 0);
  assert.equal(result.summary.previousRecovery, 50);
  assert.equal(result.summary.priorReversals, -50);
  assert.equal(result.summary.pending, 0);
  const earlier = payment(1, 150, { paidAt: "2026-09-01T12:00:00.000Z" });
  const appliedToCut = report([credit([earlier])], [credit([newReceipt, earlier])]);
  assert.equal(appliedToCut.summary.received, 50);
  assert.equal(appliedToCut.rows[0].payments.find(row => row.id === 10).previous, false);
});

test("borradores sin cronograma no crean cuotas ni bloquean créditos con vencimiento real", () => {
  const draft = credit([], { id: 2, state: "GENERADO", plan: { montoCredito: 100, fechaPrimerPago: null, fechaProximoPago: null } });
  const result = report([credit(), draft]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.expected, 100);
});

test("IDs repetidos nunca multiplican el recaudo y duplicados inconsistentes fallan", () => {
  const repeated = payment(10, 50);
  const result = report([credit([payment(1, 100)])], [credit([payment(1, 100), repeated, { ...repeated }])]);
  assert.equal(result.summary.received, 50);
  assert.throws(() => report([credit()], [credit([repeated, { ...repeated, value: 70 }])]), /valores o estados distintos/);
});

test("anular o borrar un pago posterior elimina su recibido sin reducir el esperado", () => {
  for (const payments of [[payment(1, 100), payment(10, 50, { state: "ANULADO" })], [payment(1, 100)]]) {
    const result = report([credit([payment(1, 100)])], [credit(payments)]);
    assert.equal(result.summary.expected, 100);
    assert.equal(result.summary.received, 0);
    assert.equal(result.summary.pending, 100);
  }
});

test("el reverso de anticipos se muestra aparte y puede dejar pendiente superior al esperado", () => {
  const baseline = credit([payment(1, 100), payment(2, 50)]);
  for (const current of [[payment(1, 100, { state: "ANULADO" }), payment(2, 50)], [payment(2, 50)]]) {
    const result = report([baseline], [credit(current)]);
    assert.deepEqual([result.summary.expected, result.summary.received, result.summary.priorReversals, result.summary.pending], [50, 0, 50, 100]);
    assert.equal(result.rows[0].status, "pendiente");
  }
});

test("nuevos pagos posteriores a un reverso cubren el FIFO real y el ajuste previo sigue separado", () => {
  const result = report([credit([payment(1, 100), payment(2, 50)])], [credit([payment(2, 50), payment(10, 100)])]);
  assert.deepEqual([result.summary.previousRecovery, result.summary.expected, result.summary.received, result.summary.priorReversals, result.summary.pending], [50, 50, 50, 50, 50]);
  assert.equal(result.summary.completion, 100);
});

test("IDs ya conocidos anulados no se reclasifican como recibidos posteriores", () => {
  const result = report([credit([payment(1, 100), payment(2, 50, { state: "ANULADO" })])], [credit([payment(1, 100), payment(2, 50)])]);
  assert.equal(result.summary.received, 0);
  assert.equal(result.summary.priorReversals, -50);
  assert.equal(result.summary.pending, 50);
});

test("esperado cero no divide entre cero y clientes se cuentan una sola vez", () => {
  const paid = report([credit([payment(1, 200)])]);
  assert.equal(paid.summary.expected, 0);
  assert.equal(paid.summary.completion, null);
  assert.equal(paid.summary.pendingClients, 0);
  const multiple = report([credit(), credit([], { id: 2, folio: "CR-2" })]);
  assert.equal(multiple.summary.pendingClients, 1);
  assert.equal(multiple.summary.expected, 200);
});

test("la proyección conserva su vencimiento aunque cambien las fechas del cronograma actual", () => {
  const original = credit([payment(1, 100)]);
  const current = credit([payment(1, 100), payment(10, 40)]);
  current.plan.fechaProximoPago = "2026-10-20";
  const result = report([original], [current]);
  assert.equal(result.rows[0].dueDate, cut);
  assert.equal(result.summary.received, 40);
  assert.match(result.rows[0].warning, /cronograma cambió/);
});

test("cierre y condonación no se convierten en recibido", () => {
  const original = credit([payment(1, 100)]);
  const current = credit([payment(1, 100), payment(10, 30)]);
  current.plan = { ...current.plan, montoCredito: 130, valorCuota: 65, settled: true };
  const result = report([original], [current]);
  assert.equal(result.summary.expected, 100);
  assert.equal(result.summary.received, 30);
  assert.equal(result.summary.pending, 35);
  assert.match(result.rows[0].warning, /condonación/);
});

test("filtros de filas mantienen tarjetas y otros recaudos de los créditos visibles", () => {
  const result = report([credit(), credit([], { id: 2, folio: "CR-2", document: "456" })],
    [credit([payment(10, 230)]), credit([payment(11, 50)], { id: 2, folio: "CR-2", document: "456" })]);
  const filtered = summarizeCutRows(result.rows.filter(row => row.status === "pagado"), result.previousRecovery, result.futureAdvances);
  assert.deepEqual([filtered.expected, filtered.received, filtered.previousRecovery, filtered.futureAdvances, filtered.pendingClients], [100, 100, 100, 30, 0]);
});

test("captura y consulta son funciones puras y respetan fechas calendario de Colombia", () => {
  const credits = [credit()];
  credits[0].plan.fechaPrimerPago = "2026-10-02T00:00:00.000Z";
  const before = structuredClone(credits);
  const snapshot = captureCutSnapshot(credits, cut, "2026-10-15T02:00:00.000Z");
  const frozenSnapshot = structuredClone(snapshot);
  buildCutRows(snapshot, credits);
  assert.deepEqual(credits, before);
  assert.deepEqual(snapshot, frozenSnapshot);
  assert.equal(buildCutRows(snapshot, credits).rows[0].dueDate, cut);
  assert.throws(() => captureCutSnapshot(credits, "2026-02-30", captured), /inválida/);
});

const capital = {
  version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1, totalAbonadoAlCorte: 100,
  abonosAlCorte: [{ id: 1, valor: 100 }], saldoCapitalAlCorte: 150, numeroCuotasOriginal: 3,
  parametros: { capitalPendiente: 150, tasaPeriodo: 0, cuotaCredito: 100, fianzaCuota: 0, seguroCuota: 0, numeroProximaCuota: 2, fuente: "Conciliación documental de prueba" },
  cuotas: [
    { numero: 1, fechaVencimiento: "2026-10-02", valorProgramado: 100, valorAbonadoAlCorte: 100, eliminada: false },
    { numero: 2, fechaVencimiento: cut, valorProgramado: 100, valorAbonadoAlCorte: 0, eliminada: false, capital: 100, interes: 0, fianza: 0, seguro: 0, saldoCapital: 50 },
    { numero: 3, fechaVencimiento: "2026-11-02", valorProgramado: 50, valorAbonadoAlCorte: 0, eliminada: false, capital: 50, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
  ],
};
function capitalCredit(payments) {
  const result = credit(payments);
  result.plan.planCapitalVigente = structuredClone(capital);
  return result;
}
test("plan conciliado de capital usa sus cuotas vigentes y distingue anticipos", () => {
  const result = report([capitalCredit([payment(1, 100), payment(2, 30)])], [capitalCredit([payment(1, 100), payment(2, 30), payment(10, 50)])]);
  assert.deepEqual([result.summary.priorPayments, result.summary.expected, result.summary.received, result.summary.pending], [30, 70, 50, 20]);
});

test("un plan de capital conserva su calendario aunque falten las fechas del crédito legacy", () => {
  const saved = capitalCredit([payment(1, 100)]);
  saved.plan.fechaPrimerPago = null;
  saved.plan.fechaProximoPago = null;
  const result = report([saved]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.expected, 100);
});

test("anticipos conciliados muestran sus recaudos fuente sin inventar distribución por recibo", () => {
  const saved = capitalCredit([payment(1, 150)]);
  const plan = saved.plan.planCapitalVigente;
  plan.totalAbonadoAlCorte = 150;
  plan.abonosAlCorte = [{ id: 1, valor: 150 }];
  plan.saldoCapitalAlCorte = 100;
  plan.parametros.capitalPendiente = 100;
  plan.cuotas[1].valorAbonadoAlCorte = 50;
  const original = structuredClone(saved);
  const result = report([saved]);
  const row = result.rows[0];
  assert.deepEqual([row.priorPayments, row.expected, row.received], [50, 50, 0]);
  assert.deepEqual(row.payments, []);
  assert.equal(row.sourcePayments.length, 1);
  assert.deepEqual(row.sourcePayments[0], { id: 1, paidAt: saved.payments[0].paidAt,
    createdAt: saved.payments[0].createdAt, method: "EFECTIVO", state: "ACTIVO", amount: 150 });
  assert.equal(row.lastPaymentAt, null);
  assert.match(row.warning, /no conservan una distribución individual/);
  assert.deepEqual(saved, original);
});

test("capital inconciliable no se reemplaza por un cronograma inventado", () => {
  assert.throws(() => report([capitalCredit([payment(1, 99)])]), /conciliación/);
  const saved = capitalCredit([payment(1, 100)]);
  assert.throws(() => report([saved], [capitalCredit([payment(10, 100)])]), /conciliación/);
  const revised = capitalCredit([payment(1, 100)]);
  revised.plan.planCapitalVigente.revision = 2;
  assert.throws(() => report([saved], [revised]), /distribución histórica conciliada/);
});

test("el plan de capital producido por la implementación vigente no aplica el extraordinario a cuotas ordinarias", () => {
  const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const ordinary = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan({ ...terms, abonos: ordinary }), valor: 700000,
    capitalOriginal: 3500000, cuotaHabitual: 149700, abonos: ordinary,
    conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
      fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliación documental de prueba" },
  });
  const capitalSnapshot = parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
    abonosAlCorte: [...quote.planCapitalVigente.abonosAlCorte, { id: 3, valor: 700000 }] });
  const before = credit([payment(1, 150000), payment(2, 300000), payment(3, 700000)], {
    plan: { ...terms, montoCredito: quote.montoCreditoActualizado, planCapitalVigente: capitalSnapshot },
  });
  const saved = captureCutSnapshot([before], "2026-11-02", captured);
  const current = structuredClone(before);
  current.payments.push(payment(10, 10000));
  const evaluated = buildCutRows(saved, [current]);
  const summary = summarizeCutRows(evaluated.rows);
  assert.equal(evaluated.rows[0].installment, 4);
  assert.deepEqual([summary.priorPayments, summary.expected, summary.received, summary.pending],
    [900, 148800, 10000, 138800]);
  assert(!evaluated.rows[0].payments.some(payment => payment.id === 3));
  assert.equal(evaluated.rows[0].sourcePayments.find(payment => payment.id === 3).amount, 700000);
});

test("la eliminación del crédito no borra la proyección y la anulación se hace visible", () => {
  const saved = credit([payment(1, 150)]);
  const deleted = report([saved], []);
  assert.equal(deleted.summary.expected, 50);
  assert.equal(deleted.summary.pending, 100);
  assert.match(deleted.rows[0].warning, /ya no existe/);
  const annulled = report([saved], [credit([payment(1, 150)], { state: "ANULADO" })]);
  assert.match(annulled.rows[0].warning, /fue anulado/);
});
