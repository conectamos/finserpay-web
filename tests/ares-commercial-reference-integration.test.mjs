import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { approvalFixture, completeApprovalDetail } from "./credit-approval-test-loader.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const spec = JSON.parse(await readFile(new URL("./fixtures/ares-ipadlock-amortizer.json", import.meta.url), "utf8"));
const closeTo = (actual, expected, tolerance = 0.000001) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("especificación proporcionada: se traduce matemáticamente sin ejecutar expresiones del JSON", () => {
  assert.equal(spec.nodes.length, 8);
  assert.equal(spec.nodes.find((node) => node.name === "capital").formula, "valor_venta - cuota_inicial");
  assert.equal(spec.nodes.find((node) => node.name === "total_cuota").formula, "cuota_capital + cuota_aval + cuota_seguro");
  const surety = spec.nodes.find((node) => node.name === "aval").input;
  const insurance = spec.nodes.find((node) => node.name === "seguro").input;
  assert.equal(surety, 75);
  assert.equal(insurance, 0.6);
  for (const example of spec.examples) {
    const principal = example.sale - example.initial;
    const rateFactor = 10 ** spec.configuration.periodicRateDecimals;
    const rate = Math.round((Math.pow(1 + spec.configuration.annualEffectiveRatePercentage / 100, 1 / spec.configuration.periodsPerYear) - 1) * rateFactor) / rateFactor;
    const creditInstallment = principal * rate / (1 - Math.pow(1 + rate, -example.installments));
    const guaranteeInstallment = principal * surety / (100 * example.installments);
    const insuranceInstallment = ((principal * insurance) / 1000) / 2;
    const exact = creditInstallment + guaranteeInstallment + insuranceInstallment;
    const referenceCommercial = Math.floor(exact / spec.configuration.commercialRounding.multiple) * spec.configuration.commercialRounding.multiple;
    assert.equal(referenceCommercial, example.commercialInstallment);
    const plan = calculateFrenchAmortization({
      calculoVersion: "ARES_FRANCES_V2", valorVenta: example.sale, cuotaInicial: example.initial,
      numeroCuotas: example.installments, tasaInteresEa: spec.configuration.annualEffectiveRatePercentage,
      fianzaCuotaPorcentaje: surety / example.installments, seguroCuotaPorcentaje: insurance / 20,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02",
    });
    closeTo(plan.cuotaCredito, creditInstallment);
    closeTo(plan.cuotaFianza, guaranteeInstallment);
    closeTo(plan.cuotaSeguro, insuranceInstallment);
    closeTo(plan.cuotaTotal, exact);
    assert.equal(plan.cuotaCobro, referenceCommercial);
  }
});

test("cada ejemplo V2 mantiene cuota pactada en muro y calendario, incluso último pago y abonos parciales", () => {
  for (const example of spec.examples) {
    const plan = calculateFrenchAmortization({
      calculoVersion: "ARES_FRANCES_V2", valorVenta: example.sale, cuotaInicial: example.initial,
      numeroCuotas: example.installments, tasaInteresEa: 29.24,
      fianzaCuotaPorcentaje: 75 / example.installments, seguroCuotaPorcentaje: 0.03,
      frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02",
    });
    const fixture = approvalFixture();
    Object.assign(fixture.credit, {
      valorEquipoTotal: plan.valorVenta, cuotaInicial: plan.cuotaInicial, saldoBaseFinanciado: plan.valorFinanciado,
      plazoMeses: plan.numeroCuotas, valorCuota: plan.cuotaCobro, cuotaComercialGuardada: String(plan.cuotaComercial),
    });
    fixture.credit.contratoSnapshot.financiero = {
      calculoVersion: plan.version, cuotaComercial: plan.cuotaComercial, cuotaPactada: plan.cuotaCobro,
      montoTotal: plan.montoTotal, cuotaTotalExacta: plan.cuotaTotal, descuentoRedondeo: plan.descuentoRedondeo,
    };
    const detail = completeApprovalDetail(fixture);
    assert.equal(detail.valorCuota, example.commercialInstallment);
    const terms = {
      montoCredito: plan.montoTotal, valorCuota: plan.cuotaCobro, plazoMeses: plan.numeroCuotas,
      frecuenciaPago: plan.frecuenciaPago, fechaPrimerPago: plan.cuotas[0].fechaVencimiento, today: "2026-09-14",
    };
    const pending = buildCreditPaymentPlan({ ...terms, abonos: [{ valor: plan.cuotaCobro / 2 }] });
    assert.equal(pending.nextInstallment.valorProgramado, detail.valorCuota);
    assert.equal(pending.nextInstallment.saldoPendiente, detail.valorCuota / 2);
    assert.equal(pending.installments.at(-1).valorProgramado, detail.valorCuota);
    const paid = buildCreditPaymentPlan({ ...terms, abonos: [{ valor: plan.montoTotal }] });
    assert.equal(paid.saldoPendiente, 0);
    assert.equal(paid.estadoPago, "PAGADO");
    closeTo(plan.valorFinanciado + plan.valorInteresTotal + plan.valorFianzaTotal + plan.valorSeguroTotal - plan.descuentoRedondeo, plan.montoTotal);
  }
});
