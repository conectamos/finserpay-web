import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import path from "node:path";
import { makeNativeCapitalFixture } from "./fixtures/credit-principal-payment-native.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { resolvePrincipalPaymentContext } = await jiti.import("../lib/credit-principal-payment-context.ts");
const { createPrincipalPaymentQuote } = await jiti.import("../lib/credit-principal-payment.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const cash = value => Math.round(value * 100) / 100;

for (const version of ["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
  for (const paidInstallments of [0, 3]) {
    test(`${version}: derives verified principal after ${paidInstallments} ordinary installments`, () => {
      const input = makeNativeCapitalFixture({ version, paidInstallments });
      const result = resolvePrincipalPaymentContext(input);
      assert.equal(result.modoConciliacion, "AUTOMATICA", result.motivoConciliacion);
      assert.equal(result.requiereConciliacion, false);
      assert.equal(result.capitalPendiente, cash(input.calculated.cuotas[paidInstallments].saldoInicial));
      assert.equal(result.conciliacion.numeroProximaCuota, paidInstallments + 1);
      assert.equal(result.conciliacion.tasaPeriodo, Number(input.credit.amortizacion.tasaPeriodo));
      assert.equal(cash(result.conciliacion.cuotaCredito + result.conciliacion.fianzaCuota + result.conciliacion.seguroCuota), cash(input.credit.valorCuota));
      assert.match(result.conciliacion.fuente, /amortizacion 17.*checksum/);
      const quote = createPrincipalPaymentQuote({ plan: input.plan, abonos: input.abonos,
        conciliacion: result.conciliacion, valor: 500000, capitalOriginal: input.credit.saldoBaseFinanciado,
        cuotaHabitual: cash(input.credit.valorCuota) });
      assert.equal(quote.saldoCapitalDespues, cash(result.capitalPendiente - 500000));
      assert.ok(quote.cuotasEliminadas > 0);
      assert.ok(quote.saldoPendienteDespues + 500000 <= input.plan.saldoPendiente);
    });
  }
}

test("V2 retains the commercial discount, not the larger exact component total", () => {
  const input = makeNativeCapitalFixture();
  const result = resolvePrincipalPaymentContext(input);
  assert.equal(result.conciliacion.cuotaCredito, input.credit.valorCuota - result.conciliacion.fianzaCuota - result.conciliacion.seguroCuota);
  assert.ok(result.conciliacion.cuotaCredito < Number(input.credit.amortizacion.cuotaCreditoExacta));
});
test("partial payment wholly within interest leaves verified principal unchanged", () => {
  const input = makeNativeCapitalFixture({ paidInstallments: 2, partial: 900 });
  const result = resolvePrincipalPaymentContext(input);
  assert.equal(result.modoConciliacion, "AUTOMATICA");
  assert.equal(result.capitalPendiente, cash(input.calculated.cuotas[2].saldoInicial));
});
test("partial payment reaching fees or capital requires reconciliation", () => {
  const input = makeNativeCapitalFixture({ paidInstallments: 2, partial: 40000 });
  const result = resolvePrincipalPaymentContext(input);
  assert.equal(result.modoConciliacion, "MANUAL");
  assert.match(result.motivoConciliacion, /pago parcial/);
});
test("stored historical rate is preserved independently of today's policy", () => {
  const input = makeNativeCapitalFixture({ tasa: 24.2 });
  const result = resolvePrincipalPaymentContext(input);
  assert.equal(result.modoConciliacion, "AUTOMATICA");
  assert.equal(result.conciliacion.tasaPeriodo, Number(input.credit.amortizacion.tasaPeriodo));
  assert.notEqual(result.conciliacion.tasaPeriodo, Number(makeNativeCapitalFixture().credit.amortizacion.tasaPeriodo));
});
test("zero-interest complete native plan is supported", () => {
  assert.equal(resolvePrincipalPaymentContext(makeNativeCapitalFixture({ tasa: 0 })).modoConciliacion, "AUTOMATICA");
});
for (const version of ["FRANCES_V1", "ARES_FRANCES_V1", "ARES_FRANCES_V2"]) {
  test(`${version}: valid signed source agrees with its decimal-persisted schedule`, () => {
    assert.equal(resolvePrincipalPaymentContext(makeNativeCapitalFixture({ signed: true, version })).modoConciliacion, "AUTOMATICA");
  });
}

const changes = {
  "missing schedule": input => { delete input.credit.amortizacion; },
  "unknown calculation version": input => { input.credit.amortizacion.calculoVersion = "FUTURE"; },
  "missing checksum": input => { delete input.credit.amortizacion.checksum; },
  "amortization belongs to another credit": input => { input.credit.amortizacion.creditoId++; },
  "missing row": input => { input.credit.amortizacion.cuotas.pop(); },
  "unsorted rows": input => { input.credit.amortizacion.cuotas.reverse(); },
  "modified capital": input => { input.credit.amortizacion.cuotas[3].saldoInicial = "999999"; },
  "modified interest": input => { input.credit.amortizacion.cuotas[3].interes = "999999"; },
  "modified fee": input => { input.credit.amortizacion.cuotas[3].fianza = "999999"; },
  "modified insurance": input => { input.credit.amortizacion.cuotas[3].seguro = "999999"; },
  "modified original principal": input => { input.credit.saldoBaseFinanciado++; },
  "modified total debt": input => { input.credit.montoCredito++; },
  "modified term": input => { input.credit.plazoMeses--; },
  "modified frequency": input => { input.credit.frecuenciaPago = "MENSUAL"; },
  "due date override": input => { input.plan.installments[0].fechaVencimiento = "2030-10-03"; },
  "invalid source date": input => { input.credit.amortizacion.cuotas[0].fechaVencimiento = "2030-02-31"; },
  "unbalanced total payments": input => { input.plan.totalPaid = 1; },
  "unbalanced outstanding": input => { input.plan.saldoPendiente--; },
  "forged zero principal": input => { input.credit.amortizacion.valorFinanciado = null; },
  "invalid signed checksum": input => { input.credit.contratoSnapshot.financiero.selloFinanciero.checksum = "b".repeat(64); },
  "signed parameters mismatch": input => { input.credit.amortizacion.parametrosSnapshot.financialTermsChecksum = "b".repeat(64); },
};
for (const [name, change] of Object.entries(changes)) {
  test(`fails to documented manual mode: ${name}`, () => {
    const input = makeNativeCapitalFixture({ signed: true });
    change(input);
    const result = resolvePrincipalPaymentContext(input);
    assert.equal(result.modoConciliacion, "MANUAL");
    assert.equal(result.capitalPendiente, null);
    assert.equal(result.conciliacion, null);
    assert.equal(result.requiereConciliacion, true);
    assert.ok(result.motivoConciliacion);
  });
}
for (const marker of [
  { equalityService: "IMPORTACION_MASIVA" },
  { observacionAdmin: "[IMPORTACION_MASIVA_SIN_BLOQUEO]" },
  { contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } },
]) {
  test(`imported source remains manual with complete amortization: ${Object.keys(marker)[0]}`, () => {
    const input = makeNativeCapitalFixture();
    Object.assign(input.credit, marker);
    assert.equal(resolvePrincipalPaymentContext(input).modoConciliacion, "MANUAL");
  });
}
test("legacy sub-peso pending clamp is not proof that principal was paid", () => {
  const input = makeNativeCapitalFixture();
  input.plan.installments[0].valorAbonado = input.plan.installments[0].valorProgramado - 0.5;
  input.plan.installments[0].saldoPendiente = 0;
  assert.equal(resolvePrincipalPaymentContext(input).modoConciliacion, "MANUAL");
});
test("a revised plan uses its audited source even for an imported credit without original amortization", () => {
  const input = makeNativeCapitalFixture();
  const source = resolvePrincipalPaymentContext(input);
  const quote = createPrincipalPaymentQuote({ plan: input.plan, abonos: [], conciliacion: source.conciliacion,
    valor: 500000, capitalOriginal: input.credit.saldoBaseFinanciado, cuotaHabitual: input.credit.valorCuota });
  quote.planCapitalVigente.abonosAlCorte.push({ id: 103, valor: 500000 });
  input.credit.planCapitalVigente = quote.planCapitalVigente;
  input.credit.montoCredito = quote.montoCreditoActualizado;
  input.credit.equalityService = "IMPORTACION_MASIVA";
  delete input.credit.amortizacion;
  input.plan = buildCreditPaymentPlan({ ...input.credit, abonos: [{ valor: 500000 }], today: "2030-09-20" });
  const result = resolvePrincipalPaymentContext(input);
  assert.equal(result.modoConciliacion, "VIGENTE");
  assert.equal(result.capitalPendiente, quote.saldoCapitalDespues);
  assert.equal(result.requiereConciliacion, false);
});
test("invalid revised snapshot fails closed and cannot fall back to original terms", () => {
  const input = makeNativeCapitalFixture();
  input.credit.planCapitalVigente = { version: "UNKNOWN" };
  assert.throws(() => resolvePrincipalPaymentContext(input), /Version/);
});
