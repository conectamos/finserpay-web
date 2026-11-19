import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { createHistoricalPlanCorrectionQuote, HistoricalPlanCorrectionError, parseHistoricalPlanCorrectionTerms } =
  await jiti.import("../lib/credit-historical-plan-correction.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { getCapitalOutstandingBalance, createPrincipalPaymentQuote } = await jiti.import("../lib/credit-principal-payment.ts");
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");
const { calculateCreditEarlyPayoff } = await jiti.import("../lib/credit-early-payoff.ts");

// Anonymized monetary reference. Synthetic receipt identifiers and no customer data.
const originalTerms = { montoCredito: 4912200, valorCuota: 136450, plazoMeses: 36,
  frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-09-17", today: "2026-11-19" };
const originalPayments = [
  { id: 1, valor: 136450, fechaAbono: "2026-09-26T05:14:03Z" },
  { id: 2, valor: 136450, fechaAbono: "2026-10-05T18:08:23Z" },
  { id: 3, valor: 136450, fechaAbono: "2026-10-19T21:48:12Z" },
  { id: 4, valor: 213000, fechaAbono: "2026-11-03T01:44:43Z" },
];
const originalPlan = buildCreditPaymentPlan({ ...originalTerms, abonos: originalPayments });
const balances = splitOutstandingBalance({ montoCredito: originalTerms.montoCredito,
  saldoBaseFinanciado: 2488000, saldoPendiente: originalPlan.saldoPendiente,
  valorEquipoTotal: 2488000, cuotaInicial: 0, valorFianza: 2424200, valorInteres: 0 });
const correctionTerms = { plazoMeses: 48, cuotasPagadas: 5, valorCuota: 106000,
  frecuenciaPago: "QUINCENAL", fechaProximaCuota: "2026-12-02",
  motivo: "Corrección de las condiciones históricas documentadas por administración." };
function input(overrides = {}) {
  return { ...structuredClone(correctionTerms), abonos: structuredClone(originalPayments),
    componentesPendientesAlCorte: structuredClone(balances), planActual: structuredClone(originalPlan), ...overrides };
}
function quote(overrides = {}) { return createHistoricalPlanCorrectionQuote(input(overrides)); }
function plan(result = quote(), payments = originalPayments) {
  return buildCreditPaymentPlan({ montoCredito: result.montoCreditoActualizado, valorCuota: result.valorCuota,
    plazoMeses: result.plazoMeses, frecuenciaPago: result.frecuenciaPago, fechaPrimerPago: result.fechaPrimerPago,
    planCapitalVigente: result.planCapitalVigente, abonos: payments, today: "2026-11-19" });
}

test("recognizes five installments while preserving all four receipts and actual cash", () => {
  const source = input();
  const before = structuredClone(source);
  const result = createHistoricalPlanCorrectionQuote(source);
  assert.deepEqual(source, before);
  assert.deepEqual(result.abonosConservados, originalPayments);
  assert.deepEqual(result.planCapitalVigente.abonosAlCorte, originalPayments.map(({ id, valor }) => ({ id, valor })));
  assert.equal(result.totalAbonadoAlCorte, 622350);
  assert.equal(result.totalNominalCuotasPagadas, 530000);
  assert.equal(result.diferenciaHistorica, 92350);
  assert.equal(result.totalPlanNominal, 5088000);
  assert.equal(result.montoCreditoActualizado, 5180350);
  assert.equal(result.montoCreditoActualizado - result.totalAbonadoAlCorte, 4558000);
});

test("installs exactly 43 full future installments, without assigning historical excess again", () => {
  const result = quote();
  const actual = plan(result);
  assert.equal(actual.paidCount, 5);
  assert.equal(actual.pendingCount, 43);
  assert.equal(actual.totalPaid, 622350);
  assert.equal(actual.saldoPendiente, 4558000);
  assert.equal(actual.overdueCount, 0);
  assert.equal(actual.estadoPago, "AL_DIA");
  assert.equal(actual.nextInstallment.numero, 6);
  assert.equal(actual.nextInstallment.valorAbonado, 0);
  assert.equal(actual.nextInstallment.saldoPendiente, 106000);
  assert.ok(actual.installments.slice(0, 5).every(row => row.estado === "PAGO" && row.valorAbonado === 106000));
  assert.ok(actual.installments.slice(5).every(row => row.valorProgramado === 106000 && row.saldoPendiente === 106000));
});

test("uses Bogotá calendar days 2 and 17 across year and month boundaries", () => {
  const result = quote();
  assert.equal(result.fechaPrimerPago, "2026-09-17");
  assert.deepEqual(result.proximaCuota, { numero: 6, fechaVencimiento: "2026-12-02", valor: 106000 });
  assert.deepEqual(result.ultimaCuota, { numero: 48, fechaVencimiento: "2028-09-02", valor: 106000 });
  const due = result.planCapitalVigente.cuotas.map(row => row.fechaVencimiento);
  assert.ok(due.every(d => ["02", "17"].includes(d.slice(-2))));
  assert.equal(due[6], "2026-12-17");
  assert.equal(due[7], "2027-01-02");
  assert.equal(new Set(due).size, 48);
});

test("only payments received after the conserved cut settle new future quotas", () => {
  const result = quote();
  const paid = [...originalPayments, { id: 5, valor: 106000 }];
  const next = plan(result, paid);
  assert.equal(next.paidCount, 6);
  assert.equal(next.pendingCount, 42);
  assert.equal(next.saldoPendiente, 4452000);
  assert.equal(next.nextInstallment.numero, 7);
  assert.equal(next.nextInstallment.saldoPendiente, 106000);
  const partial = plan(result, [...originalPayments, { id: 5, valor: 25000 }]);
  assert.equal(partial.paidCount, 5);
  assert.equal(partial.nextInstallment.saldoPendiente, 81000);
});

test("a receipt annulment does not silently restore an ordinary FIFO plan", () => {
  assert.throws(() => plan(quote(), originalPayments.slice(1)), /recaudos.*cambiaron/i);
});

test("preserves pending capital exactly and never turns the missing rate into an inferred rate", () => {
  const result = quote();
  assert.equal(result.componentesPendientes.saldoCapital, balances.saldoCapital);
  assert.equal(result.planCapitalVigente.saldoCapitalAlCorte, balances.saldoCapital);
  const outstanding = getCapitalOutstandingBalance(result.planCapitalVigente, 622350);
  assert.equal(outstanding.saldoCapital, balances.saldoCapital);
  assert.equal(outstanding.saldoIntereses, 0);
  assert.equal(outstanding.saldoSeguro, 0);
  assert.equal(Math.round(Object.values(outstanding).reduce((sum, value) => sum + value, 0) * 100), 455800000);
  assert.equal(result.planCapitalVigente.requiereConciliacionTasaPeriodo, true);
  assert.match(result.planCapitalVigente.parametros.fuente, /No se infiere tasa periódica/);
  assert.throws(() => createPrincipalPaymentQuote({ plan: plan(result), planCapitalVigente: result.planCapitalVigente,
    valor: 1000, capitalOriginal: 2488000, cuotaHabitual: 106000, abonos: originalPayments }), /tasa periodica documentada/i);
  const early = calculateCreditEarlyPayoff({ ...originalTerms, montoCredito: result.montoCreditoActualizado,
    plazoMeses: 48, valorCuota: 106000, fechaPrimerPago: result.fechaPrimerPago, saldoBaseFinanciado: 2488000,
    valorFianza: 2424200, valorInteres: 0, planCapitalVigente: result.planCapitalVigente, abonos: originalPayments });
  assert.equal(early.capitalPendiente, balances.saldoCapital);
  assert.equal(early.capitalPendiente > 0, true);
});

test("cent-exact distribution reconciles every future quota and closes principal to zero", () => {
  const result = quote();
  const rows = result.planCapitalVigente.cuotas.slice(5);
  for (const row of rows) {
    assert.equal(Math.round((row.capital + row.interes + row.fianza + row.seguro) * 100), 10600000);
    assert.ok(row.saldoCapital >= 0);
  }
  assert.equal(rows.at(-1).saldoCapital, 0);
  assert.equal(Math.round(rows.reduce((sum, row) => sum + row.capital, 0) * 100), Math.round(balances.saldoCapital * 100));
  assert.ok(rows.every(row => row.interes === 0 && row.seguro === 0));
});

test("supports receipt-free zero-paid schedules without fictitious paid history", () => {
  const noPayments = buildCreditPaymentPlan(originalTerms);
  const result = quote({ cuotasPagadas: 0, abonos: [], planActual: noPayments,
    componentesPendientesAlCorte: { saldoCapital: 2488000, saldoFianza: 2424200, saldoIntereses: 0 } });
  assert.equal(result.diferenciaHistorica, 0);
  assert.equal(result.proximaCuota.numero, 1);
  assert.equal(plan(result, []).paidCount, 0);
});

test("does not treat a shortfall in receipt cash as five actually paid installments", () => {
  assert.throws(() => quote({ cuotasPagadas: 6 }), /recibos existentes no alcanzan/i);
});

test("fails closed when current payment identity, money, source plan or breakdown do not reconcile", () => {
  const updates = [
    { abonos: [...originalPayments, originalPayments[0]] },
    { abonos: originalPayments.slice(1) },
    { planActual: { ...originalPlan, totalPaid: 622351 } },
    { planActual: { ...originalPlan, saldoPendiente: originalPlan.saldoPendiente + 1 } },
    { componentesPendientesAlCorte: { ...balances, saldoCapital: balances.saldoCapital + 1 } },
    { componentesPendientesAlCorte: { saldoCapital: originalPlan.saldoPendiente, saldoFianza: 0, saldoIntereses: 0 } },
    { valorCuota: 1 },
    { abonos: [{ ...originalPayments[0], valor: 0 }, ...originalPayments.slice(1)] },
    { abonos: [{ ...originalPayments[0], fechaAbono: "fecha incorrecta" }, ...originalPayments.slice(1)] },
  ];
  for (const update of updates) assert.throws(() => quote(update), HistoricalPlanCorrectionError);
  const alteredRow = structuredClone(originalPlan);
  alteredRow.installments[0].valorAbonado += 1;
  assert.throws(() => quote({ planActual: alteredRow }), /no concilia/i);
});

test("rejects unsupported term values instead of coercing or guessing", () => {
  for (const update of [
    { plazoMeses: 0 }, { plazoMeses: 61 }, { plazoMeses: "48" }, { plazoMeses: 48.5 },
    { cuotasPagadas: -1 }, { cuotasPagadas: 48 }, { cuotasPagadas: "5" },
    { valorCuota: -1 }, { valorCuota: 0 }, { valorCuota: 106000.001 }, { valorCuota: "106000" },
    { frecuenciaPago: "quincenal" }, { frecuenciaPago: "" }, { frecuenciaPago: "DIARIO" },
    { fechaProximaCuota: "2026-12-03" }, { fechaProximaCuota: "2026-02-30" },
    { fechaProximaCuota: "2026-12-02T00:00:00Z" }, { motivo: "" }, { motivo: "x".repeat(1001) },
  ]) assert.throws(() => parseHistoricalPlanCorrectionTerms({ ...correctionTerms, ...update }), HistoricalPlanCorrectionError);
});

test("supports other explicit frequencies while retaining a complete anchored calendar", () => {
  const monthly = quote({ frecuenciaPago: "MENSUAL", fechaProximaCuota: "2026-12-31" });
  assert.equal(monthly.planCapitalVigente.cuotas[7].fechaVencimiento, "2027-02-28");
  assert.equal(monthly.planCapitalVigente.cuotas[8].fechaVencimiento, "2027-03-31");
  const weekly = quote({ frecuenciaPago: "SEMANAL", fechaProximaCuota: "2026-12-03" });
  assert.equal(weekly.planCapitalVigente.cuotas[6].fechaVencimiento, "2026-12-10");
  const fortnight = quote({ frecuenciaPago: "CATORCENAL", fechaProximaCuota: "2026-12-03" });
  assert.equal(fortnight.planCapitalVigente.cuotas[6].fechaVencimiento, "2026-12-17");
});
