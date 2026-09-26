import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const { resolveHomeInstallmentPayment } = await jiti.import(
  "../app/clientes/credit-dashboard-presentation.ts"
);

function creditFromPlan(options = {}) {
  const plan = buildCreditPaymentPlan({
    montoCredito: 2_740_000,
    valorCuota: 137_000,
    plazoMeses: 20,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-08-17",
    today: "2026-09-26",
    abonos: [],
    ...options,
  });
  return { estadoPago: plan.estadoPago, cuotas: plan.installments };
}

function selectedForPayment(credit, summary) {
  return credit.cuotas.filter((item) =>
    !item.eliminada && item.saldoPendiente > 0 && item.numero <= summary.installmentLimit
  );
}

test("el inicio suma las tres cuotas vencidas de 137 mil y selecciona el mismo saldo", () => {
  const credit = creditFromPlan();
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(credit.estadoPago, "MORA");
  assert.deepEqual(summary, {
    amount: 411_000,
    overdueCount: 3,
    dueDate: "2026-08-17",
    installmentLimit: 3,
    requiresPlanReview: false,
  });
  const selection = selectedForPayment(credit, summary);
  assert.deepEqual(selection.map((item) => item.numero), [1, 2, 3]);
  assert.equal(selection.reduce((total, item) => total + item.saldoPendiente, 0), summary.amount);
  assert.equal(credit.cuotas[3].fechaVencimiento, "2026-10-02");
});

test("el total vencido descuenta un abono parcial en lugar de multiplicar cuotas completas", () => {
  const credit = creditFromPlan({ abonos: [{ valor: 50_000, fechaAbono: "2026-08-20" }] });
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(credit.cuotas[0].saldoPendiente, 87_000);
  assert.equal(summary.amount, 361_000);
  assert.equal(summary.overdueCount, 3);
  assert.equal(summary.installmentLimit, 3);
  assert.equal(selectedForPayment(credit, summary).reduce((total, item) => total + item.saldoPendiente, 0), 361_000);
});

test("la cuota que vence hoy y las futuras quedan fuera del saldo en mora", () => {
  const credit = creditFromPlan({ today: "2026-09-17" });
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(credit.cuotas[2].fechaVencimiento, "2026-09-17");
  assert.equal(credit.cuotas[2].estaEnMora, false);
  assert.equal(summary.amount, 274_000);
  assert.equal(summary.overdueCount, 2);
  assert.equal(summary.installmentLimit, 2);
  assert.deepEqual(selectedForPayment(credit, summary).map((item) => item.numero), [1, 2]);
});

test("las cuotas pagadas o eliminadas no suman ni amplían la selección de mora", () => {
  const credit = creditFromPlan({ abonos: [{ valor: 137_000, fechaAbono: "2026-08-20" }] });
  credit.cuotas.push({
    numero: 21, fechaVencimiento: "2026-07-01", saldoPendiente: 999_000,
    valorProgramado: 999_000, estado: "PENDIENTE", estaEnMora: true, eliminada: true,
  });
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(summary.amount, 274_000);
  assert.equal(summary.overdueCount, 2);
  assert.equal(summary.dueDate, "2026-09-02");
  assert.equal(summary.installmentLimit, 3);
  assert.equal(summary.requiresPlanReview, false);
});

test("un crédito al día conserva el pago de una sola próxima cuota", () => {
  const credit = creditFromPlan({ today: "2026-08-17" });
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(credit.estadoPago, "AL_DIA");
  assert.deepEqual(summary, {
    amount: 137_000,
    overdueCount: 0,
    dueDate: "2026-08-17",
    installmentLimit: 1,
    requiresPlanReview: false,
  });
});

test("un crédito finalizado o sin cuotas no ofrece un saldo para pagar", () => {
  for (const credit of [creditFromPlan({ settled: true }), { estadoPago: "PAGADO", cuotas: [] }]) {
    assert.deepEqual(resolveHomeInstallmentPayment(credit), {
      amount: 0, overdueCount: 0, dueDate: null,
      installmentLimit: undefined, requiresPlanReview: false,
    });
  }
});

test("una primera cuota reprogramada futura no se cobra silenciosamente junto a vencidas posteriores", () => {
  const credit = creditFromPlan({ fechaProximoPago: "2026-09-28" });
  const summary = resolveHomeInstallmentPayment(credit);

  assert.equal(credit.cuotas[0].estaEnMora, false);
  assert.equal(credit.cuotas[1].estaEnMora, true);
  assert.equal(credit.cuotas[2].estaEnMora, true);
  assert.equal(summary.amount, 274_000);
  assert.equal(summary.overdueCount, 2);
  assert.equal(summary.dueDate, "2026-09-02");
  assert.equal(summary.installmentLimit, 3);
  assert.equal(summary.requiresPlanReview, true);
  assert.equal(selectedForPayment(credit, summary).reduce((total, item) => total + item.saldoPendiente, 0), 411_000);
});