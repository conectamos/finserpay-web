import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  ARES_COMMERCIAL_AMORTIZATION_VERSION,
  ARES_FRENCH_AMORTIZATION_VERSION,
  FRENCH_AMORTIZATION_VERSION,
  calculateFrenchAmortization,
} = await jiti.import("../lib/credit-amortization.ts");
const { buildCreditPaymentPlan } = await jiti.import("../lib/credit-payment-plan.ts");
const {
  createFinancingTermsSeal,
  readFinancingTermsSeal,
  financingTermsSealsMatch,
} = await jiti.import("../lib/credit-amortization-contract.ts");

const baseInput = {
  calculoVersion: ARES_COMMERCIAL_AMORTIZATION_VERSION,
  valorVenta: 2_600_000,
  cuotaInicial: 780_000,
  numeroCuotas: 40,
  tasaInteresEa: 29.24,
  fianzaCuotaPorcentaje: 75 / 40,
  seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL",
  fechaPrimerPago: "2026-10-02",
};

function closeTo(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `Esperaba ${expected} +/- ${tolerance}, recibio ${actual}`);
}

const sealInput = {
  folio: "FP-ARES-VERSIONED-TEST",
  documento: "1234567890",
  contrato: {
    tipoDocumento: "CC", clienteNombre: "Cliente prueba",
    clienteTelefono: "3000000000", clienteCorreo: "cliente@example.com",
    clienteDireccion: "Calle 1", equipoMarca: "IPHONE", equipoModelo: "13 PRO",
    referenciaEquipo: "IPHONE 13 PRO", imei: "123456789012345",
  },
  parametros: {
    fianzaTotalPorcentaje: 75, fianzaModalidad: "TOTAL_CREDITO",
    fianzaFuente: "POLITICA", tasaPeriodoDecimales: 6,
    redondeoComercial: { modo: "PISO", multiplo: 50 },
    policyVersion: 1, policyRevisionId: "policy-ares-test",
  },
};

test("ARES V2 pacta 40 cuotas de 90.850 y no recupera el redondeo en la ultima", () => {
  const plan = calculateFrenchAmortization(baseInput);
  assert.equal(plan.version, ARES_COMMERCIAL_AMORTIZATION_VERSION);
  assert.equal(plan.valorFinanciado, 1_820_000);
  assert.equal(plan.tasaPeriodo, 0.010745);
  closeTo(plan.cuotaTotal, 90_887.54120958316);
  assert.equal(plan.cuotaComercial, 90_850);
  assert.equal(plan.cuotaCobro, 90_850);
  assert.equal(plan.montoTotal, 3_634_000);
  closeTo(plan.montoTotalExacto, 3_635_501.6483833264);
  closeTo(plan.descuentoRedondeo, 1_501.6483833264);
  assert.equal(plan.cuotas.length, 40);
  for (const row of plan.cuotas) assert.equal(row.cuotaCobro, 90_850);
  closeTo(plan.cuotas.reduce((sum, row) => sum + row.abonoCapital, 0), 1_820_000);
  assert.equal(plan.cuotas.at(-1).saldoFinal, 0);
  closeTo(plan.cuotas.reduce((sum, row) => sum + row.cuotaCobro, 0), plan.montoTotal);
  closeTo(plan.cuotas.reduce((sum, row) => sum + row.cuotaTotal - row.cuotaCobro, 0),
    plan.descuentoRedondeo);
  closeTo(plan.valorFinanciado + plan.valorInteresTotal + plan.valorFianzaTotal +
    plan.valorSeguroTotal - plan.descuentoRedondeo, plan.montoTotal);

  const v1 = calculateFrenchAmortization({ ...baseInput,
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION });
  for (const field of ["tasaPeriodo", "cuotaCredito", "cuotaFianza", "cuotaSeguro",
    "cuotaTotal", "valorInteresTotal", "valorFianzaTotal", "valorSeguroTotal"]) {
    assert.equal(plan[field], v1[field], field);
  }
  plan.cuotas.forEach((row, index) => {
    const { cuotaCobro: _v2Collection, ...exactRow } = row;
    const { cuotaCobro: _v1Collection, ...legacyExactRow } = v1.cuotas[index];
    assert.deepEqual(exactRow, legacyExactRow);
  });
});

test("ARES V2 replica los ejemplos de 59.150, 77.700 y el PDF de 154.600", () => {
  const fixtures = [
    { valorVenta: 1_980_000, cuotaInicial: 594_000, numeroCuotas: 48,
      tasaInteresEa: 29.24, expected: 59_150 },
    { valorVenta: 2_600_000, cuotaInicial: 780_000, numeroCuotas: 48,
      tasaInteresEa: 29.24, expected: 77_700 },
    { valorVenta: 2_000_000, cuotaInicial: 350_000, numeroCuotas: 20,
      tasaInteresEa: 29.66, expected: 154_600 },
  ];
  for (const { expected, ...fixture } of fixtures) {
    const plan = calculateFrenchAmortization({ ...baseInput, ...fixture,
      fianzaCuotaPorcentaje: 75 / fixture.numeroCuotas });
    assert.equal(plan.cuotaCobro, expected);
    assert.equal(plan.montoTotal, expected * fixture.numeroCuotas);
    assert.ok(plan.cuotas.every((row) => row.cuotaCobro === expected));
    assert.equal(plan.cuotas.at(-1).saldoFinal, 0);
  }
});

test("la formula de seguro ARES 0.6 / 1000 / 2 equivale al 0.03% por cuota", () => {
  for (const principal of [1_386_000, 1_650_000, 1_820_000, 3_500_000]) {
    const aresInsurance = ((principal * 0.6) / 1000) / 2;
    closeTo(aresInsurance, principal * (0.03 / 100));
  }
  const plan = calculateFrenchAmortization(baseInput);
  closeTo(plan.cuotaSeguro, ((plan.valorFinanciado * 0.6) / 1000) / 2);
  closeTo(plan.cuotaFianza, (plan.valorFinanciado * 75) / (100 * 40));
  closeTo(plan.cuotaTotal, plan.cuotaCredito + plan.cuotaFianza + plan.cuotaSeguro);
});

test("el calendario V2 termina PAGADO sin saldo residual al pagar la cuota pactada", () => {
  const plan = calculateFrenchAmortization(baseInput);
  const terms = {
    montoCredito: plan.montoTotal, valorCuota: plan.cuotaCobro,
    plazoMeses: plan.numeroCuotas, frecuenciaPago: plan.frecuenciaPago,
    fechaPrimerPago: plan.cuotas[0].fechaVencimiento, today: "2026-09-14",
  };
  const pending = buildCreditPaymentPlan(terms);
  assert.ok(pending.installments.every((row) => row.valorProgramado === 90_850));
  const lastPending = buildCreditPaymentPlan({ ...terms,
    abonos: [{ valor: 90_850 * 39 }] });
  assert.equal(lastPending.saldoPendiente, 90_850);
  const paid = buildCreditPaymentPlan({ ...terms,
    abonos: Array.from({ length: 40 }, () => ({ valor: 90_850 })) });
  assert.equal(paid.saldoPendiente, 0);
  assert.equal(paid.estadoPago, "PAGADO");
  assert.equal(paid.paidCount, 40);
  assert.equal(paid.pendingCount, 0);
});

test("V1 y la version predeterminada mantienen cuotas exactas y ajuste historico", () => {
  const legacyInput = { ...baseInput, calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
    valorVenta: 3_553_000, cuotaInicial: 760_000, numeroCuotas: 36,
    tasaInteresEa: 29.66, fianzaCuotaPorcentaje: 75 / 36 };
  const explicit = calculateFrenchAmortization(legacyInput);
  const { calculoVersion: _version, ...defaultInput } = legacyInput;
  assert.deepEqual(calculateFrenchAmortization(defaultInput), explicit);
  assert.equal(explicit.cuotaCobro, explicit.cuotaTotal);
  assert.equal(explicit.cuotas[0].cuotaCobro, 153_211.19);
  assert.equal(explicit.cuotas.at(-1).cuotaCobro, 153_211.25);
  closeTo(explicit.montoTotal, 5_515_602.90078629);
  assert.equal(explicit.montoTotalExacto, explicit.montoTotal);
  assert.equal(explicit.descuentoRedondeo, 0);
  const frenchV1 = calculateFrenchAmortization({ ...legacyInput,
    calculoVersion: FRENCH_AMORTIZATION_VERSION });
  assert.equal(frenchV1.cuotaCobro, frenchV1.cuotaTotal);
  assert.equal(frenchV1.montoTotalExacto, frenchV1.montoTotal);
  assert.equal(frenchV1.descuentoRedondeo, 0);
});

test("V2 sella cuota pactada, total exacto y descuento sin agregar llaves a sellos V1", () => {
  const plan = calculateFrenchAmortization(baseInput);
  const sealed = createFinancingTermsSeal({ ...sealInput, amortizacion: plan });
  assert.equal(sealed.snapshot.cuotaPactada, "90850.000000");
  assert.equal(sealed.snapshot.totalPagar, "3634000.000000");
  assert.equal(sealed.snapshot.totalPagarExacto, "3635501.648383");
  assert.equal(sealed.snapshot.descuentoRedondeo, "1501.648383");
  assert.ok(readFinancingTermsSeal(sealed));
  assert.equal(financingTermsSealsMatch(sealed,
    createFinancingTermsSeal({ ...sealInput,
      amortizacion: calculateFrenchAmortization(baseInput) })), true);
  assert.equal(readFinancingTermsSeal({ ...sealed,
    snapshot: { ...sealed.snapshot, cuotaPactada: "90887.541210" } }), null);

  for (const version of [ARES_FRENCH_AMORTIZATION_VERSION, FRENCH_AMORTIZATION_VERSION]) {
    const legacy = createFinancingTermsSeal({ ...sealInput,
      amortizacion: calculateFrenchAmortization({ ...baseInput, calculoVersion: version }) });
    for (const field of ["cuotaPactada", "totalPagarExacto", "descuentoRedondeo"]) {
      assert.equal(Object.hasOwn(legacy.snapshot, field), false, `${version}: ${field}`);
    }
    assert.ok(readFinancingTermsSeal(legacy));
    assert.equal(financingTermsSealsMatch(legacy, sealed), false);
  }
});

test("V2 exige seis decimales y PISO/50 sin cambiar las opciones historicas V1", () => {
  for (const override of [
    { tasaPeriodoDecimales: 5 },
    { tasaPeriodoDecimales: 7 },
    { redondeoComercial: { modo: "REDONDEO", multiplo: 50 } },
    { redondeoComercial: { modo: "PISO", multiplo: 100 } },
  ]) {
    assert.throws(() => calculateFrenchAmortization({ ...baseInput, ...override }),
      /requiere tasa periodica a 6 decimales y redondeo PISO/);
    assert.doesNotThrow(() => calculateFrenchAmortization({ ...baseInput, ...override,
      calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION }));
  }
  assert.deepEqual(calculateFrenchAmortization({ ...baseInput,
    tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } }),
  calculateFrenchAmortization(baseInput));
});

test("V2 no permite que el descuento reduzca el total por debajo del capital", () => {
  const interestFree = { ...baseInput, valorVenta: 1_000_000, cuotaInicial: 100_000,
    numeroCuotas: 7, tasaInteresEa: 0, fianzaCuotaPorcentaje: 0,
    seguroCuotaPorcentaje: 0 };
  assert.throws(() => calculateFrenchAmortization(interestFree), /por debajo del capital/);
  assert.doesNotThrow(() => calculateFrenchAmortization({ ...interestFree,
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION }));
  const exactPrincipal = calculateFrenchAmortization({ ...interestFree, numeroCuotas: 10 });
  assert.equal(exactPrincipal.montoTotal, 900_000);
  assert.equal(exactPrincipal.cuotaCobro, 90_000);
  assert.equal(exactPrincipal.descuentoRedondeo, 0);
});
