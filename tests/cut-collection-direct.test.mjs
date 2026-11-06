import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { buildDirectCutRows, summarizeCutRows, measureEarlyRisk } = await jiti.import("../lib/cut-collection.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { createPrincipalPaymentQuote, parseCapitalPlanSnapshot } = await jiti.import("../lib/credit-principal-payment.ts");

const cut = "2026-11-02";
const asOf = "2026-11-30T18:00:00.000Z";
test("riesgo temprano conserva DPF y evalúa seis cuotas al cierre de tres meses calendario", () => {
  const first = "2026-10-17";
  const loan = credit([
    payment(1, 99, "2026-10-20T20:00:00Z"),
    payment(2, 1, "2026-10-21T05:00:00Z"),
    payment(3, 499, "2026-11-15T15:00:00Z"),
    payment(4, 1, "2027-01-03T05:00:00Z"),
  ], { originatedAt: "2026-10-02T15:00:00Z" });
  loan.plan.montoCredito = 600;
  loan.plan.plazoMeses = 6;
  assert.deepEqual(measureEarlyRisk([loan], first, "2026-10-21T05:00:00Z").map(m => [m.cases, m.pending]),
    [[1, 0], [0, 1], [0, 1], [0, 1]]);
  assert.deepEqual(measureEarlyRisk([loan], first, "2026-12-05T05:00:00Z").at(-1),
    { label: "40/60", cases: 0, eligible: 0, pending: 1, unavailable: 0 });
  assert.deepEqual(measureEarlyRisk([loan], first, "2027-01-03T05:00:00Z").map(m => [m.cases, m.eligible]),
    [[1, 1], [0, 1], [0, 1], [1, 1]]);
});

test("40/60 ajusta el tercer mes al último día y cierra según la fecha local de Bogotá", () => {
  const examples = [
    ["2026-01-31T15:00:00Z", "2026-02-02", "2026-05-01T05:00:00Z"],
    ["2026-08-31T15:00:00Z", "2026-09-02", "2026-12-01T05:00:00Z"],
    ["2026-10-31T15:00:00Z", "2026-11-02", "2027-02-01T05:00:00Z"],
    ["2026-11-30T15:00:00Z", "2026-12-02", "2027-03-01T05:00:00Z"],
    ["2027-11-30T15:00:00Z", "2027-12-02", "2028-03-01T05:00:00Z"],
    ["2026-03-01T04:59:59Z", "2026-03-02", "2026-05-29T05:00:00Z"],
    ["2026-03-01T05:00:00Z", "2026-03-02", "2026-06-02T05:00:00Z"],
    ["2028-03-01T04:59:59Z", "2028-03-02", "2028-05-30T05:00:00Z"],
  ];
  for (const [originatedAt, first, close] of examples) {
    const loan = credit([], { originatedAt });
    Object.assign(loan.plan, { montoCredito: 600, plazoMeses: 6, fechaPrimerPago: first });
    freeze(loan);
    const beforeClose = new Date(Date.parse(close) - 1).toISOString();
    assert.deepEqual(measureEarlyRisk([loan], first, beforeClose).at(-1),
      { label: "40/60", cases: 0, eligible: 0, pending: 1, unavailable: 0 }, originatedAt);
    assert.deepEqual(measureEarlyRisk([loan], first, close).at(-1),
      { label: "40/60", cases: 1, eligible: 1, pending: 0, unavailable: 0 }, originatedAt);
  }
});

test("40/60 distingue cinco de seis cuotas y reversos de la sexta al cierre del tercer mes", () => {
  const first = "2026-02-02";
  const close = "2026-05-01T05:00:00.000Z";
  const beforeClose = "2026-05-01T04:59:59.999Z";
  const receipts = [
    [payment(1, 500, "2026-03-15T15:00:00Z"), payment(2, 100, beforeClose)],
    [payment(3, 500, "2026-03-15T15:00:00Z"), payment(4, 100, close)],
    [payment(5, 500, "2026-03-15T15:00:00Z"), payment(6, 100, "2026-04-15T15:00:00Z", { state: "ANULADO", annulledAt: close })],
    [payment(7, 500, "2026-03-15T15:00:00Z"), payment(8, 100, "2026-04-15T15:00:00Z", { state: "ANULADO", annulledAt: beforeClose })],
    [payment(9, 599.99, beforeClose)],
  ];
  const loans = receipts.map((payments, index) => {
    const loan = credit(payments, { id: index + 1, originatedAt: "2026-01-31T15:00:00Z" });
    Object.assign(loan.plan, { montoCredito: 600, plazoMeses: 6, fechaPrimerPago: first });
    return loan;
  });
  const before = structuredClone(loans);
  freeze(loans);
  assert.deepEqual(measureEarlyRisk(loans, first, close).at(-1),
    { label: "40/60", cases: 3, eligible: 5, pending: 0, unavailable: 0 });
  assert.deepEqual(measureEarlyRisk(loans, first, "2027-01-01T12:00:00Z").at(-1),
    { label: "40/60", cases: 3, eligible: 5, pending: 0, unavailable: 0 });
  assert.deepEqual(loans, before);
});

test("40/60 no inventa una sexta cuota en planes de menos de seis cuotas evaluables", () => {
  const loan = credit([payment(1, 500, "2026-04-15T15:00:00Z")], { originatedAt: "2026-01-31T15:00:00Z" });
  Object.assign(loan.plan, { montoCredito: 500, plazoMeses: 5, fechaPrimerPago: "2026-02-02" });
  const risk = measureEarlyRisk([loan], "2026-02-02", "2026-05-01T05:00:00Z");
  assert.deepEqual(risk.at(-1), { label: "40/60", cases: 0, eligible: 0, pending: 0, unavailable: 1 });
  assert(risk.slice(0, 3).every(metric => metric.eligible === 1 && metric.unavailable === 0));
});
function payment(id, value, paidAt = "2026-11-03T15:00:00.000Z", options = {}) {
  return { id, value, paidAt, createdAt: paidAt, state: "ACTIVO", annulledAt: null, method: "EFECTIVO", ...options };
}
function credit(payments = [], options = {}) {
  return { id: 1, folio: "CR-1", clientName: "Cliente de prueba", document: "12345678",
    aliadoId: 1, aliado: "Aliado", sedeId: 1, sede: "Sede", state: "ACTIVO", settledAt: null,
    plan: { montoCredito: 300, valorCuota: 100, plazoMeses: 3, frecuenciaPago: "QUINCENAL",
      fechaPrimerPago: "2026-10-17", fechaProximoPago: null, settled: false }, payments, ...options };
}
function report(credits, date = cut, now = asOf) {
  const result = buildDirectCutRows(credits, date, now);
  return { ...result, summary: summarizeCutRows(result.rows, result.previousRecovery, result.futureAdvances) };
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("consulta directa conserva la cuota completa y suma anticipos y pagos tardíos sin guardar", () => {
  const current = credit([
    payment(1, 100, "2026-10-17T15:00:00.000Z"),
    payment(2, 25, "2026-11-01T15:00:00.000Z"),
    payment(3, 40, "2026-11-05T15:00:00.000Z"),
  ]);
  const { rows, summary } = report([current]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].installment, 2);
  assert.equal(rows[0].dueDate, cut);
  assert.deepEqual([summary.expected, summary.received, summary.pending, summary.priorPayments], [100, 65, 35, 25]);
  assert.equal(summary.completion, 65);
  assert.equal(summary.creditsCount, 1);
  assert.equal(summary.pendingClients, 1);
  assert.equal(rows[0].status, "parcial");
  assert.equal(rows[0].lastPaymentAt, "2026-11-05T15:00:00.000Z");
  assert.equal(rows[0].payments.reduce((sum, item) => sum + item.received, 0), 65);
});

test("fechaProximoPago es cursor y no desplaza la cuota ya pagada fuera de su corte", () => {
  const current = credit([payment(1, 200)]);
  current.plan.fechaProximoPago = "2026-11-17";
  const { rows, summary } = report([current]);
  assert.deepEqual(rows.map(row => [row.installment, row.dueDate]), [[2, cut]]);
  assert.deepEqual([summary.expected, summary.received, summary.pending, summary.creditsCount], [100, 100, 0, 1]);
  assert.equal(rows[0].status, "pagado");
  assert.equal(summary.completion, 100);
});

test("sin fecha inicial usa el vencimiento disponible sin inventar uno para borradores", () => {
  const legacy = credit([], { plan: { montoCredito: 200, valorCuota: 100, plazoMeses: 2,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: null, fechaProximoPago: cut } });
  const draft = credit([], { id: 2, state: "GENERADO", plan: { montoCredito: 300,
    fechaPrimerPago: null, fechaProximoPago: null } });
  const result = report([legacy, draft]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].installment, 1);
  assert.equal(result.summary.expected, 100);
});

test("los anticipos son un subconjunto por fecha efectiva en Bogotá, no por registro", () => {
  const { rows, summary } = report([credit([
    payment(1, 100, "2026-10-20T12:00:00.000Z"),
    payment(2, 25, "2026-11-02T04:59:59.999Z", { createdAt: "2026-11-10T15:00:00.000Z", method: "EFECTY" }),
    payment(3, 35, "2026-11-02T05:00:00.000Z"),
    payment(4, 40, "2026-11-20T15:00:00.000Z"),
  ])]);
  assert.deepEqual([summary.expected, summary.received, summary.priorPayments], [100, 100, 25]);
  assert.equal(rows[0].lastPaymentAt, "2026-11-20T15:00:00.000Z");
  assert.equal(rows[0].payments.find(item => item.id === 2).previous, true);
  assert.equal(rows[0].payments.find(item => item.id === 3).previous, false);
});

test("un pago repartido entre cuotas anteriores, corte y futuras no se suma tres veces", () => {
  const { rows, summary } = report([credit([payment(1, 270)])]);
  assert.deepEqual([summary.previousRecovery, summary.received, summary.futureAdvances], [100, 100, 70]);
  assert.equal(summary.previousRecovery + summary.received + summary.futureAdvances, 270);
  assert.equal(rows[0].payments[0].amount, 270);
  assert.equal(rows[0].payments[0].received, 100);
});

test("un corte futuro incluye cuotas anticipadas totalmente pagadas y mantiene esperado completo", () => {
  const result = report([credit([payment(1, 300, "2026-10-20T15:00:00.000Z")])], "2026-11-17", "2026-11-02T18:00:00.000Z");
  assert.deepEqual([result.summary.expected, result.summary.received, result.summary.priorPayments, result.summary.creditsCount], [100, 100, 100, 1]);
  assert.equal(result.summary.pendingClients, 0);
});

test("el conteo de créditos incluye pagados y no confunde varias obligaciones de un cliente", () => {
  const { rows, summary } = report([
    credit([payment(1, 200)]),
    credit([], { id: 2, folio: "CR-2", document: "12.345.678" }),
    credit([], { id: 3, folio: "CR-3", document: "87654321" }),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(summary.creditsCount, 3);
  assert.equal(summary.pendingClients, 2);
  assert.deepEqual([summary.expected, summary.received, summary.pending], [300, 100, 200]);
  const paidOnly = summarizeCutRows(rows.filter(row => row.status === "pagado"));
  assert.deepEqual([paidOnly.creditsCount, paidOnly.expected, paidOnly.received, paidOnly.pendingClients], [1, 100, 100, 0]);
  assert.equal(paidOnly.previousRecovery, 100);
});

test("identidades repetidas no duplican efectivo y el orden de entrada no altera el FIFO", () => {
  const older = payment(9, 100, "2026-10-20T15:00:00.000Z");
  const partial = payment(2, 45);
  const normal = report([credit([older, partial])]);
  const repeated = report([credit([partial, older, { ...partial }])]);
  assert.deepEqual(repeated.summary, normal.summary);
  assert.equal(repeated.summary.received, 45);
  assert.equal(repeated.rows[0].payments.filter(item => item.id === 2).length, 1);
});

test("anulaciones y reversos retiran efectivo y una eliminación no deja pagos fantasma", () => {
  for (const state of ["ANULADO", "REVERSADO", "REVERTIDO"]) {
    const { summary } = report([credit([
      payment(1, 100, "2026-10-20T15:00:00.000Z"),
      payment(2, 40, "2026-11-03T15:00:00.000Z", { state, annulledAt: "2026-11-05T15:00:00.000Z" }),
      payment(3, 15),
    ])]);
    assert.deepEqual([summary.expected, summary.received, summary.pending, summary.priorPayments], [100, 15, 85, 0]);
  }
  const removed = report([credit([payment(1, 100, "2026-10-20T15:00:00.000Z"), payment(3, 15)])]);
  assert.equal(removed.summary.received, 15);
  const priorReversed = report([credit([
    payment(1, 100, "2026-10-20T15:00:00.000Z", { state: "ANULADO" }), payment(2, 40),
  ])]);
  assert.deepEqual([priorReversed.summary.received, priorReversed.summary.previousRecovery, priorReversed.summary.pending], [0, 40, 100]);
});

test("excluye créditos anulados, cuotas sin valor y fechas ajenas al corte", () => {
  const result = report([
    credit([], { id: 1, state: "ANULADO" }),
    credit([], { id: 2, plan: { montoCredito: 0, valorCuota: 0, plazoMeses: 3,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17" } }),
    credit([], { id: 3, plan: { montoCredito: 100, valorCuota: 100, plazoMeses: 1,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-11-17" } }),
  ]);
  assert.deepEqual(result.rows, []);
  assert.deepEqual([result.summary.expected, result.summary.received, result.summary.pending, result.summary.creditsCount], [0, 0, 0, 0]);
  assert.equal(result.summary.completion, null);
});

test("cierre antes del inicio de Bogotá excluye el crédito; cierre ese día no inventa condonación como efectivo", () => {
  const before = credit([payment(1, 130)], { settledAt: "2026-11-02T04:59:59.999Z" });
  before.plan.settled = true;
  assert.equal(report([before]).rows.length, 0);
  for (const settledAt of ["2026-11-02T05:00:00.000Z", "2026-11-10T15:00:00.000Z"]) {
    const current = credit([payment(1, 130)], { settledAt, state: "PAGADO" });
    current.plan.settled = true;
    const result = report([current]);
    assert.deepEqual([result.summary.expected, result.summary.received, result.summary.pending, result.summary.creditsCount], [100, 30, 70, 1]);
    assert.match(result.rows[0].warning, /condonaci[oó]n|cierre|finalizado/i);
  }
});

function capitalCredit(sourceDates = ["2026-10-20T15:00:00.000Z", "2026-11-01T15:00:00.000Z"], later = []) {
  const snapshot = {
    version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 4, totalAbonadoAlCorte: 250,
    abonosAlCorte: [{ id: 1, valor: 150 }, { id: 2, valor: 100 }], saldoCapitalAlCorte: 100, numeroCuotasOriginal: 3,
    parametros: { capitalPendiente: 100, tasaPeriodo: 0, cuotaCredito: 100, fianzaCuota: 0,
      seguroCuota: 0, numeroProximaCuota: 2, fuente: "Conciliación documental sintética para prueba" },
    cuotas: [
      { numero: 1, fechaVencimiento: "2026-10-17", valorProgramado: 100, valorAbonadoAlCorte: 100, eliminada: false },
      { numero: 2, fechaVencimiento: cut, valorProgramado: 100, valorAbonadoAlCorte: 50,
        eliminada: false, capital: 100, interes: 0, fianza: 0, seguro: 0, saldoCapital: 50 },
      { numero: 3, fechaVencimiento: "2026-11-17", valorProgramado: 50, valorAbonadoAlCorte: 0,
        eliminada: false, capital: 50, interes: 0, fianza: 0, seguro: 0, saldoCapital: 0 },
    ],
  };
  const current = credit([payment(1, 150, sourceDates[0]), payment(2, 100, sourceDates[1]), ...later]);
  current.plan = { ...current.plan, montoCredito: 350, planCapitalVigente: snapshot };
  return current;
}

test("capital vigente consulta su revisión actual sin necesitar una proyección anterior", () => {
  const current = capitalCredit(undefined, [payment(3, 20, "2026-11-05T15:00:00.000Z")]);
  const result = report([current]);
  assert.deepEqual([result.summary.expected, result.summary.received, result.summary.pending, result.summary.priorPayments], [100, 70, 30, 50]);
  assert.equal(result.rows[0].unclassifiedReceived, 0);
  assert.equal(result.summary.unclassifiedReceived, 0);
  current.plan.planCapitalVigente.revision = 5;
  assert.deepEqual(report([current]).summary, result.summary);
});

test("fuentes de capital conservan bruto sin fingir asignación individual ni última fecha de pago", () => {
  const { rows } = report([capitalCredit()]);
  const row = rows[0];
  assert.equal(row.received, 50, "Los 250 fuente incluyen 100 de capital extraordinario y 100 de otra cuota");
  assert.equal(row.priorPayments, 50);
  assert.deepEqual(row.payments, []);
  assert.deepEqual(row.sourcePayments.map(item => [item.id, item.amount]), [[1, 150], [2, 100]]);
  assert.equal(row.lastPaymentAt, null);
  assert.ok(row.warning);
});

test("seed conciliado con fechas mezcladas sigue recibido pero no se inventa su proporción de anticipos", () => {
  const { rows, summary } = report([capitalCredit([
    "2026-11-01T15:00:00.000Z", "2026-11-02T05:00:00.000Z",
  ], [payment(3, 20, "2026-11-03T15:00:00.000Z")])]);
  assert.deepEqual([rows[0].expected, rows[0].received, rows[0].priorPayments, rows[0].unclassifiedReceived], [100, 70, 0, 50]);
  assert.equal(summary.unclassifiedReceived, 50);
  assert.equal(summary.pending, 30);
  assert.ok(rows[0].warning);
});

test("seed cuyos recibos son todos del corte o posteriores no es anticipo", () => {
  const result = report([capitalCredit(["2026-11-02T05:00:00.000Z", "2026-11-03T15:00:00.000Z"])]);
  assert.deepEqual([result.summary.received, result.summary.priorPayments, result.summary.unclassifiedReceived], [50, 0, 0]);
});

test("calendario de capital no necesita fecha legacy y una cuota eliminada no integra otro corte", () => {
  const current = capitalCredit();
  current.plan.fechaPrimerPago = null;
  current.plan.fechaProximoPago = null;
  assert.equal(report([current]).rows[0].dueDate, cut);
  const snapshot = current.plan.planCapitalVigente;
  snapshot.cuotas[2] = { ...snapshot.cuotas[2], valorProgramado: 0, capital: 0, valorAbonadoAlCorte: 0, eliminada: true };
  snapshot.cuotas[1].saldoCapital = 0;
  snapshot.saldoCapitalAlCorte = 50;
  snapshot.parametros.capitalPendiente = 50;
  current.plan.montoCredito = 300;
  assert.equal(report([current], "2026-11-17").rows.length, 0);
});

test("un abono extraordinario producido por el motor real no infla el recaudo ordinario del corte", () => {
  const terms = { montoCredito: 149700 * 48, valorCuota: 149700, plazoMeses: 48,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-09-26" };
  const ordinary = [{ id: 1, valor: 150000 }, { id: 2, valor: 300000 }];
  const quote = createPrincipalPaymentQuote({
    plan: buildCreditPaymentPlan({ ...terms, abonos: ordinary }), valor: 700000,
    capitalOriginal: 3500000, cuotaHabitual: 149700, abonos: ordinary,
    conciliacion: { capitalPendiente: 3347264, tasaPeriodo: 0.010881, cuotaCredito: 94470,
      fianzaCuota: 54180, seguroCuota: 1050, numeroProximaCuota: 4, fuente: "Conciliación documental sintética para prueba" },
  });
  const capital = parseCapitalPlanSnapshot({ ...quote.planCapitalVigente,
    abonosAlCorte: [...quote.planCapitalVigente.abonosAlCorte, { id: 3, valor: 700000 }] });
  const current = credit([
    payment(1, 150000, "2026-09-20T15:00:00.000Z"),
    payment(2, 300000, "2026-09-21T15:00:00.000Z"),
    payment(3, 700000, "2026-09-26T15:00:00.000Z"), payment(4, 10000),
  ], { plan: { ...terms, montoCredito: quote.montoCreditoActualizado, planCapitalVigente: capital } });
  const result = report([current]);
  assert.equal(result.rows[0].installment, 4);
  assert.deepEqual([result.summary.expected, result.summary.received, result.summary.priorPayments, result.summary.pending], [149700, 10900, 900, 138800]);
  assert.equal(result.rows[0].sourcePayments.find(item => item.id === 3).amount, 700000);
  assert(!result.rows[0].payments.some(item => item.id === 3));
});

test("totales filtrados provienen de las mismas filas y no repiten créditos al resumir cuotas", () => {
  const second = capitalCredit();
  second.id = 2;
  second.folio = "CR-2";
  const result = report([credit([payment(1, 270)]), second]);
  const ordinary = result.rows.find(row => row.received === 100);
  const filtered = summarizeCutRows(result.rows.filter(row => row.status === "pagado"));
  assert.deepEqual([filtered.expected, filtered.received, filtered.pending, filtered.creditsCount], [100, 100, 0, 1]);
  const duplicateCreditRow = { ...ordinary, key: `${ordinary.key}:otra`, installment: 99,
    expected: 40, received: 10, pending: 30, priorPayments: 0, unclassifiedReceived: 0, status: "parcial" };
  const summary = summarizeCutRows([ordinary, duplicateCreditRow]);
  assert.deepEqual([summary.expected, summary.received, summary.pending, summary.creditsCount], [140, 110, 30, 1]);
  assert.equal(summary.previousRecovery, 100);
  assert.equal(summary.futureAdvances, 70);
  assert.equal(summary.pendingClients, 1);
});

test("consulta directa es pura y respeta calendario almacenado UTC frente a fechas de pago Bogotá", () => {
  const current = capitalCredit(undefined, [payment(3, 20)]);
  const ordinary = credit([payment(7, 175)], { id: 2, folio: "CR-2" });
  ordinary.plan.fechaPrimerPago = "2026-10-17T00:00:00.000Z";
  const inputs = [current, ordinary];
  const before = structuredClone(inputs);
  freeze(inputs);
  const result = report(inputs);
  assert.equal(result.rows.length, 2);
  assert(result.rows.every(row => row.dueDate === cut));
  summarizeCutRows(freeze(result.rows));
  assert.deepEqual(inputs, before);
  assert.throws(() => report(inputs, "2026-02-30"), /inválida|inv[aá]lido/i);
});
