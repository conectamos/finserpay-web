import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { createHistoricalPlanCorrectionQuote } = await jiti.import("../lib/credit-historical-plan-correction.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { resolveCreditPaymentSummary } = await jiti.import("../lib/credit-factory.ts");
const { splitOutstandingBalance } = await jiti.import("../lib/credit-outstanding-balance.ts");

test("dashboard cash balances and the revised installment ledger agree before and after later collections", () => {
  const original = {
    montoCredito: 1000, valorCuota: 100, plazoMeses: 10, frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-02", saldoBaseFinanciado: 500, valorEquipoTotal: 500,
    cuotaInicial: 0, valorFianza: 500, valorInteres: 0,
  };
  const receipts = [
    { id: 1, valor: 100, fechaAbono: "2026-09-02" },
    { id: 2, valor: 150, fechaAbono: "2026-09-17" },
  ];
  const preserved = structuredClone(receipts);
  const current = buildCreditPaymentPlan({ ...original, abonos: receipts, today: "2026-11-19" });
  const quote = createHistoricalPlanCorrectionQuote({
    plazoMeses: 12, cuotasPagadas: 3, valorCuota: 80, frecuenciaPago: "QUINCENAL",
    fechaProximaCuota: "2026-12-02", motivo: "Corrección histórica sintética con recibos conservados",
    abonos: receipts, planActual: current,
    componentesPendientesAlCorte: splitOutstandingBalance({
      ...original, saldoPendiente: current.saldoPendiente, totalAbonado: current.totalPaid,
    }),
  });
  assert.equal(quote.totalPlanNominal, 960);
  assert.equal(quote.montoCreditoActualizado, 970);
  assert.equal(quote.diferenciaHistorica, 10);
  for (const later of [[], [{ id: 3, valor: 80, fechaAbono: "2026-12-02" }]]) {
    const payments = [...receipts, ...later];
    const revised = buildCreditPaymentPlan({
      ...original, ...quote, montoCredito: quote.montoCreditoActualizado,
      fechaPrimerPago: quote.fechaPrimerPago, fechaProximoPago: null,
      abonos: payments, today: "2026-11-19",
    });
    const summary = resolveCreditPaymentSummary({
      montoCredito: quote.montoCreditoActualizado, totalAbonado: revised.totalPaid,
      abonosCount: payments.length,
    });
    const expectedCollected = later.length ? 330 : 250;
    const expectedPending = later.length ? 640 : 720;
    assert.equal(summary.totalRecaudado, expectedCollected, "recognizing installments cannot create cash");
    assert.equal(summary.saldoPendiente, expectedPending);
    assert.equal(revised.saldoPendiente, expectedPending);
    assert.equal(revised.paidCount, later.length ? 4 : 3);
    assert.equal(revised.pendingCount, later.length ? 8 : 9);
    assert.equal(revised.nextInstallment.saldoPendiente, 80, "the historical excess cannot reduce a future quota again");
    assert.equal(summary.abonosCount, payments.length, "receipt count stays distinct from recognized paid installments");
  }
  assert.deepEqual(receipts, preserved);
});
