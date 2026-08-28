import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  IPHONE_INITIAL_PAYMENT_PERCENTAGE,
  IPHONE_MAX_CREDIT_INSTALLMENTS,
  IPHONE_MAX_FINANCED_AMOUNT,
  IPHONE_MAX_INSTALLMENT_VALUE,
  calculateRequiredInitialPaymentForFinancingLimit,
  calculateRequiredInitialPaymentByPlatform,
  getCreditInstallmentOptions,
  normalizeCreditInstallments,
  parseCreditInstallmentSelection,
  resolveEffectiveDataCreditoFinancingLimit,
  resolveRequiredInitialPaymentByPlatform,
  validateIphoneInstallmentLimit,
} = await jiti.import(
  "../lib/credit-factory.ts"
);
const {
  ARES_FRENCH_AMORTIZATION_VERSION,
  calculateFrenchAmortization,
} = await jiti.import("../lib/credit-amortization.ts");

test("el monto maximo de la oferta limita el saldo realmente financiado", () => {
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(500_000, 600_000, 40),
    200_000
  );
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(800_000, 600_000, 40),
    320_000
  );
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(1_000_000, 600_000, 20),
    400_000
  );
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(3_000_000, 2_500_000, 0),
    500_000
  );
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(1_300_000, 1_200_000, 20),
    260_000
  );
  assert.equal(
    calculateRequiredInitialPaymentForFinancingLimit(1_300_000, 0, 20),
    1_300_000
  );
});

const requiredInitial = ({
  total,
  percentage,
  maximum,
  platform = "ANDROID",
  catalogBase,
  iphoneMaximum,
}) =>
  calculateRequiredInitialPaymentByPlatform({
    valorTotalEquipo: total,
    precioBaseVenta: catalogBase,
    initialPaymentPercentage: percentage,
    maxFinancedAmount: maximum,
    platform,
    iphoneMaxFinancedAmount: iphoneMaximum,
  });

test("el cupo solo aumenta la inicial cuando el saldo lo supera", () => {
  assert.equal(
    requiredInitial({
      total: 500_000,
      percentage: 40,
      maximum: 600_000,
      catalogBase: 800_000,
    }),
    200_000
  );
  assert.equal(
    requiredInitial({
      total: 800_000,
      percentage: 40,
      maximum: 600_000,
      catalogBase: 800_000,
    }),
    320_000
  );
  assert.equal(
    requiredInitial({
      total: 3_000_000,
      percentage: 0,
      maximum: 2_500_000,
      catalogBase: 3_000_000,
    }),
    500_000
  );
});

test("el cupo DataCredito usa la misma regla de saldo para Android y iPhone", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    assert.equal(
      requiredInitial({
        total: 2_600_000,
        percentage: 5,
        maximum: 2_200_000,
        platform,
        catalogBase: 3_000_000,
        iphoneMaximum: 3_000_000,
      }),
      400_000
    );
  }
});

test("el tope DataCredito nunca amplia las salvaguardas existentes", () => {
  assert.equal(
    requiredInitial({
      total: 1_000_000,
      percentage: 40,
      maximum: 600_000,
      catalogBase: 500_000,
    }),
    700_000
  );
  assert.equal(
    requiredInitial({
      total: 1_000_000,
      percentage: 20,
      maximum: 2_000_000,
    }),
    360_000
  );
  assert.equal(
    requiredInitial({
      total: 4_000_000,
      percentage: 10,
      maximum: 5_000_000,
      platform: "IPHONE",
      iphoneMaximum: 3_500_000,
    }),
    500_000
  );
});

test("no suma excedente cuando el saldo ya cabe en el cupo aprobado", () => {
  const breakdown = resolveRequiredInitialPaymentByPlatform({
    valorTotalEquipo: 2_915_000,
    precioBaseVenta: 3_000_000,
    initialPaymentPercentage: 30,
    platform: "IPHONE",
    iphoneMaxFinancedAmount: 3_500_000,
    maxFinancedAmount: 2_500_000,
  });

  assert.deepEqual(breakdown, {
    dataCreditoInitialPayment: 415_000,
    dataCreditoInitialPaymentAdjustment: 0,
    platformInitialPayment: 874_500,
    requiredInitialPayment: 874_500,
  });
  assert.equal(2_915_000 - breakdown.requiredInitialPayment, 2_040_500);
});

test("agrega únicamente la diferencia necesaria cuando el saldo supera el cupo", () => {
  const breakdown = resolveRequiredInitialPaymentByPlatform({
    valorTotalEquipo: 3_000_000,
    precioBaseVenta: 3_000_000,
    initialPaymentPercentage: 20,
    platform: "IPHONE",
    iphoneMaxFinancedAmount: 3_500_000,
    maxFinancedAmount: 2_200_000,
  });

  assert.deepEqual(breakdown, {
    dataCreditoInitialPayment: 800_000,
    dataCreditoInitialPaymentAdjustment: 200_000,
    platformInitialPayment: 600_000,
    requiredInitialPayment: 800_000,
  });
  assert.equal(3_000_000 - breakdown.requiredInitialPayment, 2_200_000);
});

test("resuelve directamente el menor tope por plataforma", () => {
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "ANDROID",
      maxFinancedAmount: 600_000,
      precioBaseVenta: 500_000,
    }),
    500_000
  );
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "ANDROID",
      maxFinancedAmount: 2_000_000,
    }),
    800_000
  );
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "IPHONE",
      maxFinancedAmount: 5_000_000,
      iphoneMaxFinancedAmount: 3_500_000,
    }),
    3_500_000
  );
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "IPHONE",
      maxFinancedAmount: 3_500_000,
      precioBaseVenta: 2_200_000,
      iphoneMaxFinancedAmount: 3_500_000,
    }),
    2_200_000
  );
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "IPHONE",
      maxFinancedAmount: 5_000_000,
      precioBaseVenta: 4_200_000,
      iphoneMaxFinancedAmount: 3_500_000,
    }),
    3_500_000
  );
  assert.equal(
    resolveEffectiveDataCreditoFinancingLimit({
      platform: "IPHONE",
      maxFinancedAmount: 1_800_000,
      precioBaseVenta: 2_200_000,
      iphoneMaxFinancedAmount: 3_500_000,
    }),
    1_800_000
  );
});

test("cobra sobre el tope del equipo aunque el cupo DataCredito sea mayor", () => {
  for (const [equipmentPrice, expectedInitial] of [
    [700_000, 140_000],
    [900_000, 260_000],
    [1_200_000, 560_000],
    [1_300_000, 660_000],
  ]) {
    assert.equal(
      calculateRequiredInitialPaymentByPlatform({
        valorTotalEquipo: equipmentPrice,
        precioBaseVenta: 800_000,
        initialPaymentPercentage: 20,
        maxFinancedAmount: 1_200_000,
        platform: "ANDROID",
      }),
      expectedInitial,
      `Inicial incorrecta para un equipo de ${equipmentPrice}`
    );
    assert.ok(
      equipmentPrice - expectedInitial <= 640_000,
      "El saldo financiado no debe superar el 80% del tope del equipo"
    );
  }
});

test("iPhone suma a la inicial el sobrecosto sobre la base del modelo", () => {
  const breakdown = resolveRequiredInitialPaymentByPlatform({
    valorTotalEquipo: 3_000_000,
    platform: "IPHONE",
    maxFinancedAmount: 3_500_000,
    precioBaseVenta: 2_200_000,
    iphoneMaxFinancedAmount: 3_500_000,
    initialPaymentPercentage: 20,
  });

  assert.equal(breakdown.platformInitialPayment, 1_240_000);
  assert.equal(breakdown.dataCreditoInitialPaymentAdjustment, 0);
  assert.equal(breakdown.requiredInitialPayment, 1_240_000);
  assert.equal(3_000_000 - breakdown.requiredInitialPayment, 1_760_000);
  assert.equal(
    breakdown.requiredInitialPayment,
    440_000 + 800_000,
    "La inicial debe sumar el 20% de la base y todo el sobrecosto"
  );
});

test("el simulador iPhone ofrece plazos hasta 48 cuotas", () => {
  const options = getCreditInstallmentOptions(IPHONE_MAX_CREDIT_INSTALLMENTS);

  assert.equal(options[0], "1");
  assert.equal(options.at(-1), "48");
  assert.equal(options.length, 48);
  assert.equal(normalizeCreditInstallments(60, 24, 48), 48);
});

test("cada política DataCredito usa su plazo como máximo y permite uno menor", () => {
  const policies = [
    { max: 16, selected: 12 },
    { max: 24, selected: 16 },
    { max: 40, selected: 24 },
    { max: 48, selected: 40 },
  ];

  for (const { max, selected } of policies) {
    const options = getCreditInstallmentOptions(max);

    assert.equal(options.length, max);
    assert.equal(options[0], "1");
    assert.equal(options.at(-1), String(max));
    assert.equal(options.includes(String(selected)), true);
    assert.equal(options.includes(String(max + 1)), false);
    assert.equal(parseCreditInstallmentSelection(selected, max), selected);
    assert.equal(parseCreditInstallmentSelection(max, max), max);

    for (const value of [undefined, null, 0, -1, max + 0.5, max + 1, "texto"]) {
      assert.equal(
        parseCreditInstallmentSelection(value, max),
        null,
        `Debía rechazar ${String(value)} para un máximo de ${max}`
      );
    }
  }
});

test("la regla comercial iPhone conserva 30%, 3.5M, 48 y 160k", () => {
  assert.equal(IPHONE_INITIAL_PAYMENT_PERCENTAGE, 30);
  assert.equal(IPHONE_MAX_FINANCED_AMOUNT, 3_500_000);
  assert.equal(IPHONE_MAX_CREDIT_INSTALLMENTS, 48);
  assert.equal(IPHONE_MAX_INSTALLMENT_VALUE, 160_000);

  const initialPayment = calculateRequiredInitialPaymentForFinancingLimit(
    5_000_000,
    IPHONE_MAX_FINANCED_AMOUNT,
    IPHONE_INITIAL_PAYMENT_PERCENTAGE
  );

  assert.equal(initialPayment, 1_500_000);
  assert.equal(5_000_000 - initialPayment, 3_500_000);

  const plan = calculateFrenchAmortization({
    calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
    valorVenta: 5_000_000,
    cuotaInicial: initialPayment,
    numeroCuotas: IPHONE_MAX_CREDIT_INSTALLMENTS,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje: 75 / IPHONE_MAX_CREDIT_INSTALLMENTS,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(plan.valorFinanciado, 3_500_000);
  assert.equal(
    validateIphoneInstallmentLimit({
      platform: "IPHONE",
      valorCuota: plan.cuotaTotal,
      iphoneMaxInstallmentValue: IPHONE_MAX_INSTALLMENT_VALUE,
    }).exceeded,
    false
  );
  assert.ok(plan.cuotaTotal <= IPHONE_MAX_INSTALLMENT_VALUE);
});

test("el tope iPhone acepta 160000 y bloquea cualquier exceso exacto", () => {
  assert.equal(
    validateIphoneInstallmentLimit({
      platform: "IPHONE",
      valorCuota: 160_000,
      iphoneMaxInstallmentValue: 160_000,
    }).exceeded,
    false
  );
  assert.equal(
    validateIphoneInstallmentLimit({
      platform: "IPHONE",
      valorCuota: 160_000.01,
      iphoneMaxInstallmentValue: 160_000,
    }).exceeded,
    true
  );
  assert.equal(
    validateIphoneInstallmentLimit({
      platform: "ANDROID",
      valorCuota: 160_000.01,
      iphoneMaxInstallmentValue: 160_000,
    }).exceeded,
    false
  );
});

test("el plazo de la politica es maximo y admite cada plazo menor dentro del tope", () => {
  const maxInstallments = 40;
  const allowedInstallments = getCreditInstallmentOptions(maxInstallments).filter(
    (value) => {
      const installmentCount = Number(value);
      const plan = calculateFrenchAmortization({
        calculoVersion: ARES_FRENCH_AMORTIZATION_VERSION,
        valorVenta: 3_500_000,
        cuotaInicial: 1_050_000,
        numeroCuotas: installmentCount,
        tasaInteresEa: 29.66,
        fianzaCuotaPorcentaje: 75 / installmentCount,
        seguroCuotaPorcentaje: 0.03,
        frecuenciaPago: "QUINCENAL",
        fechaPrimerPago: "2026-09-17",
      });

      return !validateIphoneInstallmentLimit({
        platform: "IPHONE",
        valorCuota: plan.cuotaTotal,
        iphoneMaxInstallmentValue: 160_000,
      }).exceeded;
    }
  );

  assert.deepEqual(
    allowedInstallments,
    Array.from({ length: 11 }, (_, index) => String(index + 30))
  );
});
