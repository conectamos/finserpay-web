import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("..", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { calculateFrenchAmortization } = await jiti.import("../lib/credit-amortization.ts");
const {
  getCreditInstallmentOptions,
  normalizeCreditInstallments,
  validateIphoneInstallmentLimit,
} = await jiti.import("../lib/credit-factory.ts");
const { resolveCreditPolicyFinancialSettings } = await jiti.import("../lib/credit-policy-financial-settings.ts");
const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

// Execute the real preview/filter and readiness declarations, not a duplicate
// formula: a regression in the component must fail these tests as well.
function declaration(name) {
  const matches = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(matches.length, 1, `Unique declaration: ${name}`);
  return `const ${matches[0].getText(parsed)};`;
}

const declarations = [
  "creditInstallmentOptions", "amortizationPlan", "financialPlan", "saldoFinanciado",
  "valorCuota", "valorCuotaExacta", "valorCuotaPactada", "iphoneInstallmentLimit",
  "iphoneInstallmentLimitExceeded", "financialPreviewReady", "stepEquipoReady",
];
const executable = ts.transpileModule(
  declarations.map(declaration).join("\n") +
    "\n({ amortizationPlan, financialPreviewReady, stepEquipoReady, creditInstallmentOptions });",
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

const settings = {
  calculoVersion: "ARES_FRANCES_V2",
  tasaInteresEa: 29.24,
  fianzaTotalPorcentaje: 75,
  fianzaCuotaPorcentaje: 75 / 40,
  seguroCuotaPorcentaje: 0.03,
  frecuenciaPago: "QUINCENAL",
  tasaPeriodoDecimales: 6,
  redondeoComercial: { modo: "PISO", multiplo: 50 },
};

function preview({
  sale = 2_600_000, initial = 780_000, count = 40,
  platform = "IPHONE", simulator = true, date = "2026-10-02",
  overrides = {},
} = {}) {
  const financialSettings = resolveCreditPolicyFinancialSettings({
    globalSettings: settings, policyFinancialSettings: settings, numeroCuotas: 40,
  });
  financialSettings.fianzaCuotaPorcentaje = 75 / count;
  return runInNewContext(executable, {
    useMemo: (callback) => callback(),
    calculateFrenchAmortization, resolveCreditPolicyFinancialSettings,
    getCreditInstallmentOptions, normalizeCreditInstallments, validateIphoneInstallmentLimit,
    simulationPolicyReady: true,
    valorTotalEquipoNumero: sale,
    cuotaInicialNumero: initial,
    plazoMesesNumero: count,
    plazoMeses: String(count),
    plazoMaximoCuotas: 48,
    dataCreditoInstallmentCount: 48,
    policyInstallmentOptions: getCreditInstallmentOptions(48),
    IPHONE_DEFAULT_CREDIT_INSTALLMENTS: 40,
    fechaPrimerPago: date,
    activeDataCreditoOffer: { financialSettings: settings, suretyPercentage: 75 },
    globalCreditSettings: settings,
    resolvedPolicyFinancialSettings: financialSettings,
    tasaInteresEaNumero: 29.24,
    effectiveFianzaCuotaPorcentaje: 75 / count,
    frecuenciaPagoCredito: "QUINCENAL",
    saldoBaseFinanciado: Math.max(0, sale - initial),
    currentDevicePlatform: platform,
    iphoneFactory: platform === "IPHONE",
    iphoneFactoryTermsLocked: false,
    iphoneFactoryRangeActive: platform === "IPHONE" && !simulator,
    iphoneFactorySignaturePending: false,
    iphoneMaxInstallmentValue: 160_000,
    // Make the other gates valid so that an invalid plan alone must block advance.
    cuotaInicialValida: true,
    equipoMarca: platform,
    equipoModelo: "MODELO DE PRUEBA",
    imeiValido: true,
    simulatorMode: simulator,
    ...overrides,
  }, { timeout: 1000 });
}

function assertPending(result, description) {
  assert.equal(result.amortizationPlan, null, description);
  assert.equal(result.financialPreviewReady, false, description);
  assert.equal(result.stepEquipoReady, false, description);
}

for (const platform of ["ANDROID", "IPHONE"]) {
  for (const simulator of [true, false]) {
    for (const count of [16, 24, 40, 48]) {
      test(`${platform} ${simulator ? "simulador" : "venta"}, ${count} cuotas: escribir, borrar y pegar no rompe el render`, () => {
        const common = { platform, simulator, count };
        // Initial payment updates in an effect after the price render. Exercise
        // both the old zero value and the new 30% minimum, not only pasted prices.
        for (const sale of [0, 2, 26, 260]) {
          for (const initial of [0, Math.round(sale * 0.3)]) {
            assertPending(preview({ ...common, sale, initial }), `${sale}/${initial}`);
          }
        }
        for (const sale of [2600, 26000, 260000, 2600000]) {
          const result = preview({ ...common, sale, initial: Math.round(sale * 0.3) });
          assert.ok(result.amortizationPlan, `Typed prefix ${sale} has a calculable plan`);
          assert.ok(Number.isFinite(result.amortizationPlan.cuotaCobro));
        }
        const valid = preview(common);
        assert.ok(valid.amortizationPlan);
        for (const [sale, initial] of [[0, 780000], [260, 780000], [2600000, 2600000], [2600000, 3000000], [2, 0]]) {
          assertPending(preview({ ...common, sale, initial }), `${sale}/${initial}`);
        }
        const pasted = preview(common);
        assert.equal(pasted.amortizationPlan.cuotaCobro, valid.amortizationPlan.cuotaCobro);
        assert.equal(pasted.amortizationPlan.montoTotal, valid.amortizationPlan.montoTotal);
      });
    }
  }
}

test("fecha ausente/incorrecta y datos no finitos dejan pendiente el plan y permiten recuperarlo", () => {
  for (const date of ["", "not-a-date", "2026-99-99"]) {
    assertPending(preview({ date }), `date=${date}`);
  }
  for (const value of [NaN, Infinity, -Infinity]) {
    assertPending(preview({ sale: value }), `sale=${value}`);
    assertPending(preview({ initial: value }), `initial=${value}`);
    assertPending(preview({ count: value }), `count=${value}`);
    assertPending(preview({ overrides: { tasaInteresEaNumero: value } }), `rate=${value}`);
  }
  assertPending(preview({ overrides: { simulationPolicyReady: false } }), "policy not ready");
  const recovered = preview();
  assert.equal(recovered.amortizationPlan.cuotaCobro, 90_850);
  assert.equal(recovered.financialPreviewReady, true);
  assert.equal(recovered.stepEquipoReady, true);
});

test("conserva los tres ejemplos ARES y bloquea cuotas por fuera del rango de venta iPhone", () => {
  for (const [sale, initial, count, expected] of [
    [2_600_000, 780_000, 40, 90_850],
    [2_600_000, 780_000, 48, 77_700],
    [1_980_000, 594_000, 48, 59_150],
  ]) {
    const simulated = preview({ sale, initial, count });
    assert.equal(simulated.amortizationPlan.cuotaCobro, expected);
    assert.equal(simulated.amortizationPlan.montoTotal, expected * count);
    assert.ok(simulated.amortizationPlan.cuotas.every((row) => row.cuotaCobro === expected));
    assert.equal(simulated.financialPreviewReady, true);
    const saleResult = preview({ sale, initial, count, simulator: false });
    assert.equal(saleResult.amortizationPlan.cuotaCobro, expected);
    assert.equal(saleResult.stepEquipoReady, expected >= 90_000);
    assert.equal(saleResult.creditInstallmentOptions.includes(String(count)), expected >= 90_000);
  }
});

test("el motor estricto conserva el rechazo de cobros inferiores al capital; solo el preview se recupera", () => {
  assert.throws(() => calculateFrenchAmortization({
    calculoVersion: "ARES_FRANCES_V2", valorVenta: 2, cuotaInicial: 0, numeroCuotas: 40,
    tasaInteresEa: 29.24, fianzaCuotaPorcentaje: 75 / 40, seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-02",
  }), /por debajo del capital financiado/);
  assertPending(preview({ sale: 2, initial: 0 }));
});
