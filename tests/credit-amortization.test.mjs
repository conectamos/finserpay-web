import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
  },
});
const {
  ARES_FRENCH_AMORTIZATION_VERSION,
  DEFAULT_INSTALLMENT_SURETY_PERCENTAGE,
  FRENCH_AMORTIZATION_VERSION,
  annualEffectiveToPeriodicRate,
  calculateFrenchAmortization,
  floorCommercialInstallment,
  roundCommercialInstallment,
  roundPeriodicRateForAres,
} = await jiti.import("../lib/credit-amortization.ts");
const { buildCreditPaymentPlan } = await jiti.import(
  "../lib/credit-payment-plan.ts"
);
const {
  createFinancingTermsSeal,
  financingTermsSealsMatch,
} = await jiti.import("../lib/credit-amortization-contract.ts");

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Esperaba ${expected} +/- ${tolerance}, recibio ${actual}`
  );
}

test("calcula el ejemplo francés ARES redondeando la tasa periódica a 6 decimales", () => {
  const result = calculateFrenchAmortization({
    valorVenta: 3_553_000,
    cuotaInicial: 760_000,
    numeroCuotas: 36,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 36,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.valorFinanciado, 2_793_000);
  assert.equal(result.version, ARES_FRENCH_AMORTIZATION_VERSION);
  assert.equal(result.periodosPorAno, 24);
  closeTo(result.tasaPeriodo, 0.010882, 1e-15);
  closeTo(result.cuotaCredito, 94_185.79168850755);
  closeTo(result.cuotaFianza, 58_187.5);
  closeTo(result.cuotaSeguro, 837.9);
  closeTo(result.cuotaTotal, 153_211.19168850756);
  assert.equal(result.cuotaComercial, 153_200);
  assert.equal(result.cuotas.length, 36);

  const first = result.cuotas[0];
  assert.equal(first.numero, 1);
  assert.equal(first.fechaVencimiento, "2026-09-17");
  closeTo(first.saldoInicial, 2_793_000);
  closeTo(first.interes, 30_393.426);
  closeTo(first.abonoCapital, 63_792.365688507554);
  closeTo(first.fianza, 58_187.5);
  closeTo(first.seguro, 837.9);
  closeTo(first.cuotaTotal, 153_211.19168850756);
  closeTo(first.saldoFinal, 2_729_207.6343114926);

  const second = result.cuotas[1];
  assert.equal(second.numero, 2);
  assert.equal(second.fechaVencimiento, "2026-10-02");
  closeTo(second.saldoInicial, 2_729_207.6343114926);
  closeTo(second.interes, 29_699.23747657766);
  closeTo(second.abonoCapital, 64_486.55421192989);
  closeTo(second.saldoFinal, 2_664_721.0800995626);
  assert.ok(second.interes < first.interes);
  assert.ok(second.abonoCapital > first.abonoCapital);

  const last = result.cuotas.at(-1);
  closeTo(last.saldoInicial, 93_171.89512576758);
  closeTo(last.interes, 1_013.8965627586027);
  closeTo(last.abonoCapital, 93_171.89512576758);
  closeTo(last.cuotaCredito, 94_185.79168852618);
  closeTo(last.cuotaTotal, 153_211.1916885262);
  assert.equal(last.saldoFinal, 0);
  assert.equal(result.cuotas[0].cuotaCobro, 153_211.19);
  assert.equal(last.cuotaCobro, 153_211.25);
  closeTo(
    result.cuotas.reduce((sum, item) => sum + item.cuotaCobro, 0),
    Math.round(result.montoTotal * 100) / 100,
    0.000001
  );

  closeTo(result.valorInteresTotal, 597_688.5007862904);
  closeTo(result.valorFianzaTotal, 2_094_750);
  closeTo(result.valorSeguroTotal, 30_164.4);
  closeTo(result.montoTotal, 5_515_602.90078629);
  closeTo(
    result.cuotas.reduce((total, item) => total + item.abonoCapital, 0),
    result.valorFinanciado
  );

  result.cuotas.slice(0, -1).forEach((item, index) => {
    closeTo(item.saldoFinal, result.cuotas[index + 1].saldoInicial);
    closeTo(item.cuotaCredito, result.cuotaCredito);
    closeTo(item.cuotaTotal, result.cuotaTotal);
  });
});

test("replica el caso ARES de 16 cuotas con inicial manual", () => {
  const result = calculateFrenchAmortization({
    valorVenta: 1_800_000,
    cuotaInicial: 529_500,
    numeroCuotas: 16,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 16,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.cuotaInicial, 529_500);
  assert.equal(result.valorFinanciado, 1_270_500);
  closeTo(result.tasaPeriodo, 0.010882, 1e-15);
  closeTo(result.cuotaCredito, 86_949.72725169588);
  closeTo(result.cuotaFianza, 59_554.6875);
  closeTo(result.cuotaSeguro, 381.15);
  closeTo(result.cuotaTotal, 146_885.56475169587);
  assert.equal(result.cuotaComercial, 146_850);
});

test("replica el caso ARES de 3.5 millones a 40 cuotas", () => {
  const result = calculateFrenchAmortization({
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
    valorVenta: 3_500_000,
    cuotaInicial: 1_050_000,
    numeroCuotas: 40,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 40,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.valorFinanciado, 2_450_000);
  closeTo(result.tasaPeriodo, 0.010882, 1e-15);
  closeTo(result.cuotaCredito, 75_871.97450071451);
  closeTo(result.cuotaFianza, 45_937.5);
  closeTo(result.cuotaSeguro, 735);
  closeTo(result.cuotaTotal, 122_544.47450071451);
  assert.equal(result.cuotaComercial, 122_500);
});

test("replica el segundo caso ARES de 20 cuotas", () => {
  const result = calculateFrenchAmortization({
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
    valorVenta: 2_000_000,
    cuotaInicial: 350_000,
    numeroCuotas: 20,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 20,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.valorFinanciado, 1_650_000);
  closeTo(result.tasaPeriodo, 0.010882, 1e-15);
  closeTo(result.cuotaCredito, 92_249.36030040233);
  closeTo(result.cuotaFianza, 61_875);
  closeTo(result.cuotaSeguro, 495);
  closeTo(result.cuotaTotal, 154_619.36030040233);
  assert.equal(result.cuotaComercial, 154_600);
});

test("replica el caso ARES de 45 cuotas del PDF", () => {
  const result = calculateFrenchAmortization({
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
    valorVenta: 4_200_000,
    cuotaInicial: 700_000,
    numeroCuotas: 45,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 45,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.valorFinanciado, 3_500_000);
  closeTo(result.tasaPeriodo, 0.010882, 1e-15);
  closeTo(result.cuotaCredito, 98_783.46557282565);
  closeTo(result.cuotaFianza, 58_333.333333333336);
  closeTo(result.cuotaSeguro, 1_050);
  closeTo(result.cuotaTotal, 158_166.79890615898);
  assert.equal(result.cuotaComercial, 158_150);
});

test("conserva FRANCES_V1 para reproducir cálculos legados cuando se solicita", () => {
  const result = calculateFrenchAmortization({
    calculoVersion: FRENCH_AMORTIZATION_VERSION,
    valorVenta: 1_800_000,
    cuotaInicial: 529_500,
    numeroCuotas: 16,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 16,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(result.version, FRENCH_AMORTIZATION_VERSION);
  closeTo(result.tasaPeriodo, 0.010881504805543951, 1e-15);
  closeTo(result.cuotaCredito, 86_949.37499849562);
  closeTo(result.cuotaTotal, 146_885.21249849562);
  assert.equal(result.cuotaComercial, 146_900);
});

test("usa la periodicidad configurada para convertir la TEA", () => {
  const monthly = calculateFrenchAmortization({
    valorVenta: 1_200_000,
    cuotaInicial: 200_000,
    numeroCuotas: 12,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 2,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(monthly.frecuenciaPago, "MENSUAL");
  assert.equal(monthly.periodosPorAno, 12);
  closeTo(
    monthly.tasaPeriodo,
    roundPeriodicRateForAres(annualEffectiveToPeriodicRate(29.66, 12)),
    1e-15
  );
  assert.equal(monthly.cuotas[1].fechaVencimiento, "2026-10-17");
});

test("ajusta los vencimientos mensuales al ultimo dia disponible", () => {
  const monthly = calculateFrenchAmortization({
    valorVenta: 1_200_000,
    cuotaInicial: 200_000,
    numeroCuotas: 3,
    tasaInteresEa: 20,
    fianzaCuotaPorcentaje: 2,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "MENSUAL",
    fechaPrimerPago: "2026-01-31",
  });

  assert.deepEqual(
    monthly.cuotas.map((item) => item.fechaVencimiento),
    ["2026-01-31", "2026-02-28", "2026-03-31"]
  );
});

test("usa la cuota exacta para recaudo y deja la comercial solo para mostrar", () => {
  const result = calculateFrenchAmortization({
    valorVenta: 3_553_000,
    cuotaInicial: 760_000,
    numeroCuotas: 36,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: DEFAULT_INSTALLMENT_SURETY_PERCENTAGE,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });
  const paymentPlan = buildCreditPaymentPlan({
    montoCredito: Math.round(result.montoTotal * 100) / 100,
    valorCuota: result.cuotaTotal,
    plazoMeses: result.numeroCuotas,
    frecuenciaPago: result.frecuenciaPago,
    fechaPrimerPago: result.cuotas[0].fechaVencimiento,
    today: "2026-09-01",
  });

  assert.equal(paymentPlan.installments[0].valorProgramado, 153_211.18);
  assert.equal(paymentPlan.installments.at(-1).valorProgramado, 153_211.27);
  assert.notEqual(paymentPlan.installments[0].valorProgramado, result.cuotaComercial);
  closeTo(
    paymentPlan.installments.reduce(
      (total, item) => total + item.valorProgramado,
      0
    ),
    5_515_602.57,
    0.001
  );
});

test("sella los terminos de FirmaSeguro y detecta cualquier recalculo distinto", () => {
  const baseInput = {
    valorVenta: 1_800_000,
    cuotaInicial: 529_500,
    numeroCuotas: 16,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / 16,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  };
  const parametros = {
    fianzaTotalPorcentaje: 75,
    fianzaModalidad: "TOTAL_CREDITO",
    fianzaFuente: "POLITICA",
    tasaPeriodoDecimales: 6,
    redondeoComercial: {
      modo: "PISO",
      multiplo: 50,
    },
    policyVersion: 3,
    policyRevisionId: "policy-revision-test",
  };
  const original = createFinancingTermsSeal({
    folio: "FP-TEST-1",
    documento: "1110178524",
    contrato: {
      tipoDocumento: "CC",
      clienteNombre: "Cliente Prueba",
      clienteTelefono: "3000000000",
      clienteCorreo: "cliente@example.com",
      clienteDireccion: "Calle 1",
      equipoMarca: "INFINIX",
      equipoModelo: "NOTE 60 PRO",
      referenciaEquipo: "INFINIX NOTE 60 PRO",
      imei: "123456789012345",
    },
    amortizacion: calculateFrenchAmortization(baseInput),
    parametros,
  });
  const same = createFinancingTermsSeal({
    folio: "FP-TEST-1",
    documento: "1110178524",
    contrato: original.snapshot,
    amortizacion: calculateFrenchAmortization(baseInput),
    parametros,
  });
  const changed = createFinancingTermsSeal({
    folio: "FP-TEST-1",
    documento: "1110178524",
    contrato: original.snapshot,
    amortizacion: calculateFrenchAmortization({
      ...baseInput,
      tasaInteresEa: 30,
    }),
    parametros,
  });

  assert.equal(original.snapshot.fianzaModalidad, "TOTAL_CREDITO");
  assert.equal(original.snapshot.fianzaTotalPorcentaje, "75.000000000000");
  assert.equal(original.snapshot.redondeoComercialModo, "PISO");
  assert.equal(original.snapshot.redondeoComercialMultiplo, 50);
  assert.equal(financingTermsSealsMatch(original, same), true);
  assert.equal(financingTermsSealsMatch(original, changed), false);
  assert.equal(
    financingTermsSealsMatch({ ...original, checksum: "0".repeat(64) }, same),
    false
  );
});

test("maneja una TEA de cero y ajusta la ultima cuota a saldo cero", () => {
  const result = calculateFrenchAmortization({
    valorVenta: 1_000_000,
    cuotaInicial: 100_000,
    numeroCuotas: 7,
    tasaInteresEa: 0,
    fianzaCuotaPorcentaje: 0,
    seguroCuotaPorcentaje: 0,
    frecuenciaPago: "SEMANAL",
    fechaPrimerPago: "2026-09-17",
  });

  closeTo(result.cuotaCredito, 900_000 / 7);
  assert.equal(result.valorInteresTotal, 0);
  assert.equal(result.cuotas.at(-1).saldoFinal, 0);
  closeTo(
    result.cuotas.reduce((total, item) => total + item.abonoCapital, 0),
    900_000
  );
});

test("redondea solo la cuota comercial a la centena mas cercana", () => {
  assert.equal(roundCommercialInstallment(153_210.39188739771), 153_200);
  assert.equal(roundCommercialInstallment(153_250), 153_300);
  assert.equal(roundCommercialInstallment(153_249.99), 153_200);
});

test("ARES lleva la cuota comercial al múltiplo de 50 inferior", () => {
  assert.equal(floorCommercialInstallment(146_885.5648), 146_850);
  assert.equal(floorCommercialInstallment(154_619.3603), 154_600);
  assert.equal(floorCommercialInstallment(146_850), 146_850);
});

test("rechaza entradas financieras invalidas", () => {
  assert.throws(
    () =>
      calculateFrenchAmortization({
        valorVenta: 1_000_000,
        cuotaInicial: 1_000_000,
        numeroCuotas: 12,
        tasaInteresEa: 29.66,
        fianzaCuotaPorcentaje: 2,
        seguroCuotaPorcentaje: 0.03,
        frecuenciaPago: "QUINCENAL",
        fechaPrimerPago: "2026-09-17",
      }),
    /cuotaInicial debe ser menor/
  );
  assert.throws(
    () =>
      calculateFrenchAmortization({
        valorVenta: 1_000_000,
        cuotaInicial: 100_000,
        numeroCuotas: 0,
        tasaInteresEa: 29.66,
        fianzaCuotaPorcentaje: 2,
        seguroCuotaPorcentaje: 0.03,
        frecuenciaPago: "QUINCENAL",
        fechaPrimerPago: "2026-09-17",
      }),
    /numeroCuotas debe ser un entero positivo/
  );
});
