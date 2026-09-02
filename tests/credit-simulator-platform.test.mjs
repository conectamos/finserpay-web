import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  ANDROID_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE,
  ANDROID_SIMULATOR_TOTAL_SURETY_PERCENTAGE,
  DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE,
  SIMULATOR_INITIAL_PAYMENT_PERCENTAGES,
  calculateAndroidSimulatorInitialPayment,
  calculateAndroidSimulatorInstallmentSuretyPercentage,
} = await jiti.import("../lib/credit-factory.ts");
const { calculateFrenchAmortization } = await jiti.import(
  "../lib/credit-amortization.ts"
);

const page = readFileSync(
  new URL("../app/dashboard/creditos/page.tsx", import.meta.url),
  "utf8"
);
const selector = readFileSync(
  new URL("../app/dashboard/creditos/credit-platform-selector.tsx", import.meta.url),
  "utf8"
);
const sidebar = readFileSync(
  new URL("../app/dashboard/_components/admin-sidebar.tsx", import.meta.url),
  "utf8"
);
const dashboard = readFileSync(
  new URL("../app/dashboard/_components/admin-central-dashboard.tsx", import.meta.url),
  "utf8"
);
const consoleSource = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8"
);
const creditFactorySource = readFileSync(
  new URL("../lib/credit-factory.ts", import.meta.url),
  "utf8"
);

test("el simulador exige escoger Android o iPhone antes de calcular", () => {
  assert.match(
    page,
    /\(entryMode === "create-client" \|\| entryMode === "simulator"\)\s*&&\s*!devicePlatform/
  );
  assert.match(page, /params\.set\("mode", entryMode\)/);
  assert.match(page, /mode=\{entryMode === "simulator" \? "simulator" : "sale"\}/);
  assert.match(page, /devicePlatform \|\| "sin-plataforma"/);
  assert.match(selector, /mode\?: "sale" \| "simulator"/);
  assert.match(selector, /actionLabel=\{simulatorMode \? "Simular Android"/);
  assert.match(selector, /actionLabel=\{simulatorMode \? "Simular iPhone"/);
});

test("el administrador central ve el simulador en menu y acciones rapidas", () => {
  assert.match(
    sidebar,
    /adminCentral[\s\S]{0,320}href: "\/dashboard\/creditos\?mode=simulator"/
  );
  assert.match(
    dashboard,
    /adminCentral \? \([\s\S]{0,260}href="\/dashboard\/creditos\?mode=simulator"/
  );
});

test("el simulador iPhone usa el porcentaje seleccionado y conserva el plazo flexible", () => {
  assert.match(
    consoleSource,
    /const simulatorIphoneRulesActive\s*=\s*simulatorMode && iphoneFactory/
  );
  assert.match(
    consoleSource,
    /const initialPaymentPercentage = simulatorMode\s*\? simulatorInitialPaymentPercentage/
  );
  assert.match(
    consoleSource,
    /const dataCreditoEffectiveMaxFinancedAmount\s*=\s*simulatorIphoneRulesActive\s*\? iphoneMaxFinancedAmount\s*:\s*dataCreditoMaxFinancedAmount/
  );
  assert.match(
    consoleSource,
    /resolveRequiredInitialPaymentByPlatform\([\s\S]{0,500}const cuotaInicialMinimaNumero = simulatorAndroidRulesActive[\s\S]{0,180}: initialPaymentBreakdown\.requiredInitialPayment/
  );
  assert.match(
    consoleSource,
    /const plazoMaximoCuotas = normalizeCreditInstallmentLimit\(\s*simulatorIphoneRulesActive\s*\? creditSettings\.iphonePlazoMaximoCuotas/
  );
  assert.doesNotMatch(
    consoleSource,
    /dataCreditoLocksInstallmentCount/
  );
  assert.match(
    consoleSource,
    /const policyInstallmentOptions = useMemo\([\s\S]{0,180}getCreditInstallmentOptions\(plazoMaximoCuotas\)/
  );
  assert.match(
    consoleSource,
    /const plazoMesesNumero = normalizeCreditInstallments\(\s*plazoMeses,[\s\S]{0,240}plazoMaximoCuotas/
  );
  assert.doesNotMatch(
    consoleSource,
    /const creditInstallmentOptions = useMemo\(\(\) => \{\s*if \(\s*!simulatorMode \|\|/
  );
  assert.match(
    consoleSource,
    /policyInstallmentOptions\.filter\(\(option\) => \{[\s\S]{0,1800}validateIphoneInstallmentLimit/
  );
  assert.match(
    consoleSource,
    /Puedes elegir hasta \{plazoMaximoCuotas\} cuotas\. No[\s\S]{0,120}máximo autorizado/
  );
});

test("el simulador permite consultar inicial del 20 o 30 por ciento", () => {
  assert.deepEqual(SIMULATOR_INITIAL_PAYMENT_PERCENTAGES, [20, 30]);
  assert.equal(DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE, 30);
  assert.equal(ANDROID_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE, 30);
  assert.equal(calculateAndroidSimulatorInitialPayment(1_000_000, 20), 200_000);
  assert.equal(calculateAndroidSimulatorInitialPayment(1_000_000, 30), 300_000);
  assert.match(
    consoleSource,
    /useState<SimulatorInitialPaymentPercentage>\(\s*DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE/
  );
  assert.match(
    consoleSource,
    /SIMULATOR_INITIAL_PAYMENT_PERCENTAGES\.map\(\(percentage\)/
  );
  assert.match(consoleSource, /type="radio"/);
  assert.match(consoleSource, /readOnly=\{simulatorMode\}/);
  assert.match(
    consoleSource,
    /setSimulatorInitialPaymentPercentage\(percentage\);\s*setCuotaInicial\(""\)/
  );
});

test("el simulador Android conserva la fianza total del 75 por ciento", () => {
  assert.match(
    creditFactorySource,
    /const DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE[^=]*=\s*30/
  );
  assert.match(
    creditFactorySource,
    /const ANDROID_SIMULATOR_TOTAL_SURETY_PERCENTAGE = 75/
  );
  assert.match(
    consoleSource,
    /const simulatorAndroidRulesActive\s*=\s*simulatorMode && !iphoneFactory/
  );
  assert.match(
    consoleSource,
    /const initialPaymentPercentage = simulatorMode\s*\? simulatorInitialPaymentPercentage/
  );
  assert.match(
    consoleSource,
    /const cuotaInicialMinimaNumero = simulatorAndroidRulesActive\s*\? calculateAndroidSimulatorInitialPayment\(\s*valorTotalEquipoNumero,\s*simulatorInitialPaymentPercentage/
  );
  assert.match(
    consoleSource,
    /simulatorAndroidRulesActive\s*\? calculateAndroidSimulatorInstallmentSuretyPercentage\(plazoMesesNumero\)/
  );

  const valorEquipo = 1_000_000;
  const numeroCuotas = 16;
  const cuotaInicial = calculateAndroidSimulatorInitialPayment(valorEquipo, 30);
  const fianzaCuotaPorcentaje =
    calculateAndroidSimulatorInstallmentSuretyPercentage(numeroCuotas);
  const amortization = calculateFrenchAmortization({
    valorVenta: valorEquipo,
    cuotaInicial,
    numeroCuotas,
    tasaInteresEa: 29.66,
    fianzaCuotaPorcentaje,
    seguroCuotaPorcentaje: 0.03,
    frecuenciaPago: "QUINCENAL",
    fechaPrimerPago: "2026-09-17",
  });

  assert.equal(ANDROID_SIMULATOR_TOTAL_SURETY_PERCENTAGE, 75);
  assert.equal(cuotaInicial, 300_000);
  assert.equal(amortization.valorFinanciado, 700_000);
  assert.equal(amortization.valorFianzaTotal, 525_000);
});

test("el simulador oculta la política DataCrédito y sus términos internos", () => {
  assert.doesNotMatch(
    consoleSource,
    /Política DataCrédito · Sin información/
  );
  assert.doesNotMatch(
    consoleSource,
    /Política DataCrédito · Regla Sin información/
  );
  assert.match(
    consoleSource,
    /\{!simulatorMode \? \([\s\S]*?\{creditSettingsScopeLabel\}/
  );
  assert.match(consoleSource, /\{activeDataCreditoOffer && !simulatorMode \? \(/);
  assert.match(consoleSource, /Oferta DataCrédito aprobada/);
  assert.match(consoleSource, /Inicial mínima \{formatPercent\(initialPaymentPercentage\)\}/);
  assert.match(
    consoleSource,
    /Cupo aprobado \{currency\(dataCreditoEffectiveMaxFinancedAmount\)\}/
  );
  assert.match(consoleSource, /Hasta \{plazoMaximoCuotas\} cuotas/);
});

test("el simulador iPhone conserva el tope global configurado", () => {
  assert.match(
    consoleSource,
    /!simulatorMode &&\s*activeDataCreditoPlatform === "IPHONE"/
  );
  assert.match(
    consoleSource,
    /simulatorMode && iphoneFactory\s*\? iphoneMaxInstallmentValue/
  );
  assert.match(
    consoleSource,
    /Cupo aprobado \{currency\(dataCreditoEffectiveMaxFinancedAmount\)\}/
  );
  assert.match(
    consoleSource,
    /Hasta \{plazoMaximoCuotas\} cuotas/
  );
  assert.match(consoleSource, /IPHONE_MAX_INSTALLMENT_VALUE/);
});

test("el desglose interno solo se muestra al administrador central", () => {
  assert.match(
    consoleSource,
    /stepEquipoReady && canSeeInternalPricing && amortizationPlan[\s\S]{0,300}Cuota exacta/
  );
  assert.match(
    consoleSource,
    /\{canSeeInternalPricing && iphoneFactory \? \([\s\S]{0,500}Tope iPhone/
  );
  assert.match(
    consoleSource,
    /\{canSeeInternalPricing && amortizationPlan \? \(\s*<CreditAmortizationTable/
  );
  assert.match(
    consoleSource,
    /const visibleIphoneInstallmentLimitMessage = canSeeInternalPricing/
  );
});
