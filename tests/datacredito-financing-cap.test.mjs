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
  calculateRequiredInitialPaymentByPlatform,
  resolveEffectiveDataCreditoFinancingLimit,
} = await jiti.import(
  "../lib/credit-factory.ts"
);

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

test("aplica el porcentaje sobre el tope y suma el excedente a la inicial", () => {
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
    440_000
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

test("el tope DataCredito usa la misma regla para Android y iPhone", () => {
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
      510_000
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
    850_000
  );
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
});
