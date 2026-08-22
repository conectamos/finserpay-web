import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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

test("el simulador iPhone usa inicial del 30 por ciento y plazo flexible", () => {
  assert.match(
    consoleSource,
    /simulatorMode && iphoneFactory\s*\? configuredInitialPaymentPercentage/
  );
  assert.match(
    consoleSource,
    /const dataCreditoLocksInstallmentCount\s*=\s*Boolean\(dataCreditoInstallmentCount\) && !simulatorMode/
  );
  assert.match(
    consoleSource,
    /dataCreditoLocksInstallmentCount\s*\? \[String\(dataCreditoInstallmentCount\)\]\s*:\s*getCreditInstallmentOptions\(plazoMaximoCuotas\)/
  );
  assert.match(
    consoleSource,
    /policyInstallmentOptions\.filter\(\(option\) => \{[\s\S]{0,1800}validateIphoneInstallmentLimit/
  );
  assert.match(
    consoleSource,
    /Solo se muestran plazos cuya cuota no supera/
  );
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
  assert.match(consoleSource, /IPHONE_MAX_INSTALLMENT_VALUE/);
});

test("el desglose interno solo se muestra al administrador central", () => {
  assert.match(
    consoleSource,
    /\{canSeeInternalPricing && amortizationPlan \? \([\s\S]{0,500}<p>Exacta:/
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
