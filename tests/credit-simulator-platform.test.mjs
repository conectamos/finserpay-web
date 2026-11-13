import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const {
  ANDROID_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE,
  DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE,
  SIMULATOR_INITIAL_PAYMENT_PERCENTAGES,
  calculateAndroidSimulatorInitialPayment,
  getAndroidSimulatorInitialPaymentPercentages,
  resolveAndroidSimulatorInitialPaymentPercentage,
  resolveInitialPaymentAfterMinimumRefresh,
} = await jiti.import("../lib/credit-factory.ts");
const { calculateFrenchAmortization } = await jiti.import(
  "../lib/credit-amortization.ts"
);
const { resolveCreditPolicyFinancialSettings } = await jiti.import("../lib/credit-policy-financial-settings.ts");

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
const consoleAst = ts.createSourceFile("credit-factory-console.tsx", consoleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function productionNode(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(consoleAst);
  assert.equal(matches.length, 1, "Expected one matching production node");
  return matches[0];
}

function executeProduction(code, context) {
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, context, { timeout: 1000 });
}

function productionVariable(name) {
  return productionNode(node => ts.isVariableDeclaration(node) && node.name.getText(consoleAst) === name).initializer.getText(consoleAst);
}

test("el simulador exige escoger Android o iPhone antes de calcular", () => {
  assert.match(
    page,
    /\(entryMode === "create-client" \|\| entryMode === "simulator"\)\s*&&\s*!devicePlatform/
  );
  assert.match(page, /params\.set\("mode", entryMode\)/);
  assert.match(page, /mode=\{entryMode === "simulator" \? "simulator" : "sale"\}/);
  assert.match(page, /devicePlatform \|\| "sin-plataforma"/);
  assert.match(selector, /mode\?: "sale" \| "simulator"/);
  assert.match(selector, /<NewSalePlatformSelector \{\.\.\.props\}/);

});

test("el simulador aparece para administradores centrales y aliados", () => {
  assert.match(
    sidebar,
    /isAdminRole\(rolUsuario\)[\s\S]{0,120}href: "\/dashboard\/creditos\?mode=simulator"/
  );
  assert.match(
    dashboard,
    /<Action\s+href="\/dashboard\/creditos\?mode=simulator"[\s\S]{0,100}label="Simular"/
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

test("iPhone conserva inicial20/30 y ambos simuladores permiten editar el importe manual", () => {
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
    /simulatorInitialPaymentPercentages\.map\(\s*\(percentage\)/
  );
  assert.match(consoleSource, /type="radio"/);
  assert.doesNotMatch(consoleSource, /readOnly=\{simulatorMode\}/);
  const initialInput = productionNode(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(consoleAst) === "input" && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(consoleAst) === "id" && attribute.initializer?.getText(consoleAst) === '"step-two-initial"'));
  const changeHandler = initialInput.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(consoleAst) === "onChange").initializer.expression;
  const changedInitial = [];
  for (const input of ["$ 400.000", ""]) {
    executeProduction(`(${changeHandler.getText(consoleAst)})(event)`, {
      event: { target: { value: input } }, setCuotaInicial: value => changedInitial.push(value),
    });
  }
  assert.deepEqual(changedInitial, ["400000", ""]);
  assert.equal(
    resolveInitialPaymentAfterMinimumRefresh({
      currentValue: "400000",
      totalValue: "1000000",
      minimumValue: 300000,
    }),
    "400000"
  );
  assert.equal(
    resolveInitialPaymentAfterMinimumRefresh({
      currentValue: "250000",
      totalValue: "1000000",
      minimumValue: 300000,
    }),
    "300000"
  );
});

test("Android admite inicial0/5/10 de política, normaliza opciones válidas y no convierte cero en30", () => {
  assert.deepEqual(getAndroidSimulatorInitialPaymentPercentages([10, 0, 5, 10, 5, 2.5, 100, -1, 101, NaN, Infinity, null, false, "20", undefined]), [0, 2.5, 5, 10, 100]);
  for (const invalid of [null, undefined, "0,5,10", {}, 10]) assert.deepEqual(getAndroidSimulatorInitialPaymentPercentages(invalid), []);
  for (const [percentage, expected] of [[0, 0], [5, 50_000], [10, 100_000], [2.5, 25_000], [100, 1_000_000]]) {
    assert.equal(calculateAndroidSimulatorInitialPayment(1_000_000, percentage), expected);
  }
  for (const percentage of [-1, 101, NaN, Infinity, null, undefined]) {
    assert.equal(calculateAndroidSimulatorInitialPayment(1_000_000, percentage), 300_000);
  }
  for (const total of [0, -100, NaN, Infinity, null, undefined]) assert.equal(calculateAndroidSimulatorInitialPayment(total, 5), 0);
  assert.equal(resolveAndroidSimulatorInitialPaymentPercentage({ selectedPercentage: 0, policyPercentages: [0, 5, 10], policyDefaultPercentage: 10 }), 0);
  assert.equal(resolveAndroidSimulatorInitialPaymentPercentage({ selectedPercentage: 30, policyPercentages: [0, 5, 10], policyDefaultPercentage: 10 }), 10);
  assert.equal(resolveAndroidSimulatorInitialPaymentPercentage({ selectedPercentage: 30, policyPercentages: [10, 5, 0], policyDefaultPercentage: 75 }), 0);
  assert.equal(resolveAndroidSimulatorInitialPaymentPercentage({ selectedPercentage: 5, policyPercentages: [20, 30], policyDefaultPercentage: 30 }), 30);
});

test("radios y selección reales usan la política Android y conservan estado independiente al volver a iPhone", () => {
  const clearedInitial = [];
  const context = {
    DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE, SIMULATOR_INITIAL_PAYMENT_PERCENTAGES,
    getAndroidSimulatorInitialPaymentPercentages, resolveAndroidSimulatorInitialPaymentPercentage,
    useMemo: calculate => calculate(),
    simulatorAndroidRulesActive: true,
    dataCreditoSimulation: { platform: "ANDROID", initialPaymentPercentages: [10, 5, 0, 5], offer: { initialPaymentPercentage: 10 } },
    setCuotaInicial: value => clearedInitial.push(value),
  };
  for (const name of ["androidSimulatorInitialPaymentPercentage", "iphoneSimulatorInitialPaymentPercentage"]) {
    const declaration = productionNode(node => ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.name.elements.some(element => ts.isBindingElement(element) && element.name.getText(consoleAst) === name));
    context[name] = executeProduction(`(${declaration.initializer.getText(consoleAst)})[0]`, { DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE, useState: initial => [initial, () => {}] });
  }
  context.setAndroidSimulatorInitialPaymentPercentage = value => { context.androidSimulatorInitialPaymentPercentage = value; };
  context.setIphoneSimulatorInitialPaymentPercentage = value => { context.iphoneSimulatorInitialPaymentPercentage = value; };
  const refresh = android => {
    context.simulatorAndroidRulesActive = android;
    for (const name of ["androidSimulatorInitialPaymentPercentages", "simulatorInitialPaymentPercentages", "simulatorInitialPaymentPercentage"]) context[name] = executeProduction(productionVariable(name), context);
  };
  const change = value => {
    executeProduction(`(${productionVariable("handleSimulatorInitialPaymentPercentageChange")})(percentage)`, { ...context, percentage: value });
    refresh(context.simulatorAndroidRulesActive);
  };
  context.handleSimulatorInitialPaymentPercentageChange = change;
  const mapExpression = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "simulatorInitialPaymentPercentages.map");
  const radios = () => {
    const jsx = (type, props) => ({ type, props });
    const result = executeProduction(`(${mapExpression.getText(consoleAst)})`, { ...context, exports: {}, require: () => ({ jsx, jsxs: jsx }) });
    return Array.from(result, label => label.props.children.find(child => child.type === "input").props);
  };
  refresh(true);
  assert.equal(context.simulatorInitialPaymentPercentage, 10, "Inicial por defecto aprobada, sin conservar30 fuera de la política");
  assert.deepEqual(radios().map(radio => radio.value), [0, 5, 10]);
  assert.deepEqual(radios().filter(radio => radio.checked).map(radio => radio.value), [10]);
  radios().find(radio => radio.value === 0).onChange();
  assert.equal(context.simulatorInitialPaymentPercentage, 0);
  assert.equal(context.iphoneSimulatorInitialPaymentPercentage, 30);
  assert.deepEqual(radios().filter(radio => radio.checked).map(radio => radio.value), [0]);
  change(30);
  assert.equal(context.simulatorInitialPaymentPercentage, 0, "El handler rechaza porcentajes fuera de política");
  assert.equal(clearedInitial.length, 1);
  refresh(false);
  assert.equal(context.simulatorInitialPaymentPercentage, 30);
  assert.deepEqual(radios().map(radio => radio.value), [20, 30]);
  change(0);
  assert.equal(context.simulatorInitialPaymentPercentage, 30);
  assert.equal(clearedInitial.length, 1, "La selección Android no puede entrar en iPhone");
  change(20);
  assert.equal(context.simulatorInitialPaymentPercentage, 20);
  refresh(true);
  assert.equal(context.simulatorInitialPaymentPercentage, 0, "Android conserva su selección propia");
  refresh(false);
  assert.equal(context.simulatorInitialPaymentPercentage, 20, "iPhone conserva su selección propia");
  assert.deepEqual(clearedInitial, ["", ""]);
  context.dataCreditoSimulation = { platform: "ANDROID", offer: { initialPaymentPercentage: 0 } };
  refresh(true);
  assert.deepEqual(Array.from(context.simulatorInitialPaymentPercentages), [0], "La respuesta antigua usa sólo su inicial aprobada, incluido cero");
  context.dataCreditoSimulation = { platform: "ANDROID", initialPaymentPercentages: [5, 10], offer: { initialPaymentPercentage: 5 } };
  refresh(true);
  assert.equal(context.simulatorInitialPaymentPercentage, 5, "Una nueva política retira cero y aplica su default permitido");
  context.dataCreditoSimulation = null;
  refresh(true);
  assert.deepEqual(radios(), [], "Sin política cargada no se inventan opciones de aprobación");
  assert.equal(executeProduction(productionVariable("simulationPolicyReady"), { simulatorMode: true, simulationPolicyOffer: null }), false);
  context.dataCreditoSimulation = { platform: "IPHONE", initialPaymentPercentages: [0, 5, 10], offer: { initialPaymentPercentage: 0 } };
  refresh(true);
  assert.deepEqual(radios(), [], "Las opciones de una respuesta iPhone no se aplican a Android");
  const mismatched = { simulatorMode: true, dataCreditoSimulationStatus: "ready", dataCreditoPlatform: "ANDROID", dataCreditoSimulation: { ...context.dataCreditoSimulation, decision: "APROBADO" } };
  assert.equal(executeProduction(productionVariable("simulationPolicyOffer"), mismatched), null);
  assert.equal(executeProduction(productionVariable("simulationPolicyOffer"), { ...mismatched, dataCreditoPlatform: "IPHONE" }), context.dataCreditoSimulation.offer);
});

test("cargar la política no prellena30 antes de conocer la inicial0/5/10 y preserva importes manuales o firmados", () => {
  const refreshEffect = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "useEffect" && node.arguments[0]?.getText(consoleAst).includes("resolveInitialPaymentAfterMinimumRefresh"));
  const dependencies = refreshEffect.arguments[1].elements.map(node => node.getText(consoleAst));
  assert.ok(dependencies.includes("simulationPolicyReady"));
  assert.ok(dependencies.includes("simulatorMode"));
  let amount = "", updates = 0;
  const context = {
    simulatorMode: true, simulationPolicyReady: false, valorTotalEquipoNumero: 1_000_000, valorEquipoTotal: "1000000",
    cuotaInicialMinimaNumero: 300_000, draftResumeHydrating: false, firmaSeguroProcessExists: false,
    resolveInitialPaymentAfterMinimumRefresh,
    setCuotaInicial: change => { updates += 1; amount = typeof change === "function" ? change(amount) : change; },
  };
  const refresh = overrides => executeProduction(`(${refreshEffect.arguments[0].getText(consoleAst)})()`, { ...context, ...overrides });
  refresh();
  assert.equal(amount, "");
  assert.equal(updates, 0, "El mínimo provisional30 no se convierte en una inicial ingresada");
  for (const percentage of [0, 5, 10]) {
    amount = "";
    refresh({ simulationPolicyReady: true, cuotaInicialMinimaNumero: calculateAndroidSimulatorInitialPayment(1_000_000, percentage) });
    assert.equal(amount, String(percentage * 10_000));
  }
  amount = "400000";
  refresh({ simulationPolicyReady: true, cuotaInicialMinimaNumero: 0 });
  assert.equal(amount, "400000", "Respeta una inicial manual válida");
  for (const lock of [{ firmaSeguroProcessExists: true }, { draftResumeHydrating: true }]) {
    amount = "10000";
    refresh({ simulatorMode: false, cuotaInicialMinimaNumero: 100_000, ...lock });
    assert.equal(amount, "10000", "Conserva términos firmados o en restauración");
  }
  amount = "";
  refresh({ simulatorMode: false, cuotaInicialMinimaNumero: 100_000 });
  assert.equal(amount, "100000", "Originación conserva su cálculo aunque el simulador no esté listo");
});

test("opciones de simulación no reemplazan la inicial de originación ni liberan un contrato enviado a firma", () => {
  const context = { simulatorMode: false, simulatorInitialPaymentPercentage: 0, activeDataCreditoOffer: { initialPaymentPercentage: 10 }, configuredInitialPaymentPercentage: 20 };
  assert.equal(executeProduction(productionVariable("initialPaymentPercentage"), context), 10);
  assert.equal(executeProduction(productionVariable("initialPaymentPercentage"), { ...context, activeDataCreditoOffer: null }), 20);
  assert.equal(executeProduction(productionVariable("cuotaInicialMinimaNumero"), {
    simulatorAndroidRulesActive: false, initialPaymentBreakdown: { requiredInitialPayment: 450_000 },
    calculateAndroidSimulatorInitialPayment: () => assert.fail("Originación no debe usar inicial libre del simulador"),
  }), 450_000);
  for (const [firmaSeguroProcessExists, firmaSeguroDraftCorrectionPending] of [[true, false], [false, true]]) {
    const notices = [];
    executeProduction(`(${productionVariable("clearStepTwoFields")})()`, {
      firmaSeguroProcessExists, firmaSeguroDraftCorrectionPending,
      setStepTwoClearConfirmOpen() {}, setNotice: notice => notices.push(notice),
      setAndroidSimulatorInitialPaymentPercentage: () => assert.fail("Contrato protegido"),
      setIphoneSimulatorInitialPaymentPercentage: () => assert.fail("Contrato protegido"),
      setCuotaInicial: () => assert.fail("Contrato protegido"),
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /protegido.*enviado a firma/);
  }
});

test("ambos simuladores calculan fianza, interés y seguro con la política resuelta y no con la banda", () => {
  assert.match(
    creditFactorySource,
    /const DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE[^=]*=\s*30/
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
  const suretyExpression = productionNode(node => ts.isVariableDeclaration(node) && node.name.getText(consoleAst) === "effectiveFianzaCuotaPorcentaje").initializer;
  for (const platform of ["ANDROID", "IPHONE"]) {
    for (const totalSurety of [75, 68]) {
      const numeroCuotas = platform === "ANDROID" ? 16 : 24;
      const resolvedPolicyFinancialSettings = resolveCreditPolicyFinancialSettings({
        globalSettings: { tasaInteresEa: 17.84, fianzaCuotaPorcentaje: 2.083333, seguroCuotaPorcentaje: 0.1, frecuenciaPago: "MENSUAL" },
        policyFinancialSettings: { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: totalSurety, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } },
        legacyOfferSuretyPercentage: 60, numeroCuotas,
      });
      const fianzaCuotaPorcentaje = executeProduction(suretyExpression.getText(consoleAst), {
        simulatorAndroidRulesActive: platform === "ANDROID", plazoMesesNumero: numeroCuotas, resolvedPolicyFinancialSettings,
        calculateAndroidSimulatorInstallmentSuretyPercentage() { throw new Error("El simulador no debe sustituir la política"); },
      });
      assert.equal(fianzaCuotaPorcentaje, totalSurety / numeroCuotas);
      const amortization = calculateFrenchAmortization({ ...resolvedPolicyFinancialSettings,
        valorVenta: 1_000_000, cuotaInicial: 300_000, numeroCuotas, fianzaCuotaPorcentaje, fechaPrimerPago: "2026-11-17" });
      assert.equal(amortization.valorFinanciado, 700_000);
      assert.ok(Math.abs(amortization.valorFianzaTotal - 700_000 * totalSurety / 100) < 0.001);
      assert.equal(amortization.tasaInteresEa, 29.24);
      assert.equal(amortization.seguroCuotaPorcentaje, 0.03);
    }
  }
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
    /\{stepTwoPolicyAvailable && !simulatorMode \? \(/
  );
  assert.match(consoleSource, /Inicial mínima \{formatPercent\(initialPaymentPercentage\)\}/);
  assert.match(
    consoleSource,
    /Cupo aprobado[\s\S]{0,100}currency\(dataCreditoEffectiveMaxFinancedAmount\)/
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
    /Cupo aprobado[\s\S]{0,100}currency\(dataCreditoEffectiveMaxFinancedAmount\)/
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
    /const stepTwoProposalReady =[\s\S]{0,180}financialPreviewReady/
  );
  assert.match(
    productionNode(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(consoleAst) === "CreditFinancingProposal").getText(consoleAst),
    /ready=\{stepTwoProposalReady\}[\s\S]*installmentValue=\{valorCuota\}/
  );
  const amortization = productionNode(node => ts.isConditionalExpression(node) && node.whenTrue.getText(consoleAst).includes("<CreditAmortizationTable"));
  assert.match(
    amortization.getText(consoleAst),
    /canSeeInternalPricing && stepTwoProposalReady && amortizationPlan \? \(\s*<CreditAmortizationTable[^>]*defaultOpen=\{false\}/
  );
  assert.match(
    consoleSource,
    /const visibleIphoneInstallmentLimitMessage = canSeeInternalPricing/
  );
});

test("el simulador consulta solo la política local por GET y cancela el guardado de borradores", async () => {
  const creationMode = productionNode(node => ts.isVariableDeclaration(node) && node.name.getText(consoleAst) === "dataCreditoCreditCreationMode");
  assert.equal(executeProduction(`const ${creationMode.getText(consoleAst)}; dataCreditoCreditCreationMode;`, {
    paymentsView: false, lookupMode: false, simulatorMode: true,
  }), false);

  const policyEffect = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "useEffect" && node.arguments[0]?.getText(consoleAst).includes("const loadDataCreditoSimulation ="));
  const requests = [];
  const statuses = [];
  const cleanup = executeProduction(`(${policyEffect.arguments[0].getText(consoleAst)})()`, {
    simulatorMode: true, dataCreditoPlatform: "IPHONE", AbortController, URLSearchParams,
    setDataCreditoSimulation: () => {}, setDataCreditoSimulationMessage: () => {},
    setDataCreditoSimulationStatus: (status) => statuses.push(status),
    requestJson: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, data: { simulation: { simulationOnly: true, platform: "IPHONE", decision: "APROBADO", offer: {} } } };
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(statuses, ["loading", "ready"]);
  assert.equal(requests.length, 1);
  const requested = new URL(requests[0].url, "https://local.invalid");
  assert.equal(requested.pathname, "/api/creditos/datacredito/politica");
  assert.equal(requested.searchParams.get("purpose"), "simulation");
  assert.equal(requested.searchParams.get("platform"), "IPHONE");
  assert.equal(requests[0].options.method ?? "GET", "GET");
  cleanup();
  assert.equal(requests[0].options.signal.aborted, true);

  const autosaveEffect = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "useEffect" && node.arguments[0]?.getText(consoleAst).includes("const saveGeneration = draftSaveGenerationRef.current"));
  let cancellations = 0;
  executeProduction(`(${autosaveEffect.arguments[0].getText(consoleAst)})()`, {
    wizardStepTransitionInFlightRef: { current: false }, draftResumeHydrationRef: { current: false },
    createClientMode: true, simulatorMode: true, draftId: 42, draftHasMeaningfulData: true,
    cancelPendingDraftAutosave: () => { cancellations += 1; },
    serializeCreditDraftSaveRequest: () => assert.fail("The simulator must not prepare a draft save"),
    requestJson: () => assert.fail("The simulator must not persist a draft"),
    window: { setTimeout: () => assert.fail("The simulator must not schedule autosave") },
  });
  assert.equal(cancellations, 1);
});

test("una respuesta o error tardíos de Android abortado no sustituyen la política iPhone vigente", async () => {
  const policyEffect = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "useEffect" && node.arguments[0]?.getText(consoleAst).includes("const loadDataCreditoSimulation ="));
  for (const lateResult of ["success", "error"]) {
    let resolveOld, rejectOld;
    const old = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const writes = [], requests = [];
    let currentSimulation = null, currentStatus = "idle";
    const simulation = platform => ({ simulationOnly: true, platform, decision: "APROBADO", initialPaymentPercentages: platform === "ANDROID" ? [0, 5, 10] : [20, 30], offer: { initialPaymentPercentage: platform === "ANDROID" ? 0 : 30 } });
    const context = {
      simulatorMode: true, AbortController, URLSearchParams,
      setDataCreditoSimulation: value => { currentSimulation = value; writes.push(["simulation", value]); },
      setDataCreditoSimulationStatus: value => { currentStatus = value; writes.push(["status", value]); },
      setDataCreditoSimulationMessage: value => writes.push(["message", value]),
      requestJson: (url, options) => { requests.push({ url, options }); return url.includes("platform=ANDROID") ? old : Promise.resolve({ ok: true, data: { simulation: simulation("IPHONE") } }); },
    };
    const run = platform => executeProduction(`(${policyEffect.arguments[0].getText(consoleAst)})()`, { ...context, dataCreditoPlatform: platform });
    const cleanupOld = run("ANDROID");
    cleanupOld();
    const cleanupCurrent = run("IPHONE");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentStatus, "ready");
    assert.equal(currentSimulation.platform, "IPHONE");
    const settledWrites = writes.length;
    if (lateResult === "success") resolveOld({ ok: true, data: { simulation: simulation("ANDROID") } });
    else rejectOld(new Error("Respuesta vieja fallida"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes.length, settledWrites, "Una solicitud cancelada no puede cambiar ningún estado de la nueva plataforma");
    assert.equal(currentStatus, "ready");
    assert.equal(currentSimulation.platform, "IPHONE");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(requests[1].options.signal.aborted, false);
    cleanupCurrent();
  }
});
