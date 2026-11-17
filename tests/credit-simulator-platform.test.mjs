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
  calculateAndroidSimulatorInitialPayment,
  getAndroidSimulatorInitialPaymentPercentages,
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizeMoneyLimit,
  resolveAndroidSimulatorInitialPaymentPercentage,
  resolveInitialPaymentAfterMinimumRefresh,
  resolveRequiredInitialPaymentByPlatform,
  validateIphoneInstallmentLimit,
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

test("Android e iPhone usan cupo, plazo y tope de la condición elegida frente a parámetros globales distintos", () => {
  for (const iphoneFactory of [false, true]) {
    const offer = { initialPaymentPercentage: 10, maxFinancedAmount: 900_000, installmentCount: 10, maxInstallmentAmount: iphoneFactory ? 115_000 : null };
    const context = {
      simulatorMode: true, iphoneFactory, simulatorIphoneRulesActive: iphoneFactory,
      activeDataCreditoPlatform: iphoneFactory ? "IPHONE" : "ANDROID", activeDataCreditoOffer: offer,
      dataCreditoMaxFinancedAmount: offer.maxFinancedAmount, dataCreditoInstallmentCount: offer.installmentCount,
      iphoneMaxFinancedAmount: 3_500_000,
      creditSettings: { iphoneTopeFinanciado: 3_500_000, iphoneTopeCuota: 160_000, iphonePlazoMaximoCuotas: 48, plazoMaximoCuotas: 60 },
      IPHONE_MAX_FINANCED_AMOUNT: 3_500_000, IPHONE_MAX_INSTALLMENT_VALUE: 160_000,
      IPHONE_MAX_CREDIT_INSTALLMENTS: 48, DEFAULT_MAX_CREDIT_INSTALLMENTS: 16,
      normalizeMoneyLimit, normalizeCreditInstallmentLimit,
    };
    assert.equal(executeProduction(productionVariable("dataCreditoEffectiveMaxFinancedAmount"), context), 900_000);
    assert.equal(executeProduction(productionVariable("plazoMaximoCuotas"), context), 10);
    if (iphoneFactory) {
      const maximum = executeProduction(productionVariable("iphoneMaxInstallmentValue"), context);
      assert.equal(maximum, 115_000);
      assert.equal(executeProduction(productionVariable("policySummaryMaxInstallmentValue"), { ...context, iphoneMaxInstallmentValue: maximum }), 115_000);
    }
  }
  assert.doesNotMatch(consoleSource, /dataCreditoLocksInstallmentCount/);
  assert.match(consoleSource, /getCreditInstallmentOptions\(plazoMaximoCuotas\)/);
});

test("ambos simuladores conservan una inicial manual válida y ajustan el mínimo por precio base y cupo de política", () => {
  const initialInput = productionNode(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(consoleAst) === "input" && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(consoleAst) === "id" && attribute.initializer?.getText(consoleAst) === '"step-two-initial"'));
  const changeHandler = initialInput.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(consoleAst) === "onChange").initializer.expression;
  const changedInitial = [];
  for (const input of ["$ 400.000", ""]) {
    executeProduction(`(${changeHandler.getText(consoleAst)})(event)`, {
      event: { target: { value: input } }, setCuotaInicial: value => changedInitial.push(value),
    });
  }
  assert.deepEqual(changedInitial, ["400000", ""]);
  for (const platform of ["ANDROID", "IPHONE"]) {
    for (const [basePrice, cap, expected] of [[1_500_000, 900_000, 1_100_000], [1_500_000, 2_000_000, 800_000]]) {
      const context = {
        simulatorMode: true, simulatorIphoneRulesActive: platform === "IPHONE", simulatorAndroidRulesActive: platform === "ANDROID",
        valorTotalEquipoNumero: 2_000_000, precioBaseVentaCatalogo: basePrice, initialPaymentPercentage: 20,
        activeDataCreditoPlatform: platform, currentDevicePlatform: platform.toLowerCase(),
        activeDataCreditoOffer: { maxFinancedAmount: cap }, dataCreditoMaxFinancedAmount: cap,
        iphoneMaxFinancedAmount: 3_500_000, resolveRequiredInitialPaymentByPlatform,
      };
      const breakdown = executeProduction(productionVariable("initialPaymentBreakdown"), context);
      assert.equal(breakdown.requiredInitialPayment, expected, `${platform}, base=${basePrice}, cupo=${cap}`);
      const minimum = executeProduction(productionVariable("cuotaInicialMinimaNumero"), { ...context, initialPaymentBreakdown: breakdown });
      assert.equal(minimum, expected);
    }
  }
  assert.equal(resolveInitialPaymentAfterMinimumRefresh({ currentValue: "1200000", totalValue: "2000000", minimumValue: 1_100_000 }), "1200000");
  assert.equal(resolveInitialPaymentAfterMinimumRefresh({ currentValue: "1000000", totalValue: "2000000", minimumValue: 1_100_000 }), "1100000");
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

test("los controles eligen condiciones completas incluso con igual inicial y conservan selección por plataforma y revisión", () => {
  const condition = (id, percentage, cap, installments, maxInstallment = null) => ({ id, offer: {
    initialPaymentPercentage: percentage, maxFinancedAmount: cap, installmentCount: installments,
    maxInstallmentAmount: maxInstallment, suretyPercentage: 75,
    financialSettings: { tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL" },
  } });
  const android = [condition("condition-1", 0, 600_000, 8), condition("condition-2", 0, 1_200_000, 16), condition("condition-3", 10, 2_000_000, 24)];
  const iphone = [condition("condition-1", 5, 1_500_000, 12, 110_000), condition("condition-2", 10, 2_500_000, 36, 145_000)];
  const simulation = (platform, revisionId, conditions) => ({ platform, policyRevisionId: revisionId, decision: "APROBADO", conditions, offer: conditions[0]?.offer ?? null });
  const clearedInitial = [];
  const context = {
    simulatorMode: true, dataCreditoSimulationStatus: "ready", dataCreditoPlatform: "ANDROID",
    simulatorConditionSelection: {}, dataCreditoSimulation: simulation("ANDROID", "android-v1", android),
    useMemo: calculate => calculate(), formatPercent: value => String(value), currency: value => String(value),
    setCuotaInicial: value => clearedInitial.push(value),
  };
  context.setSimulatorConditionSelection = update => {
    context.simulatorConditionSelection = typeof update === "function" ? update(context.simulatorConditionSelection) : update;
  };
  const refresh = () => {
    for (const name of ["simulatorPolicyConditions", "selectedSimulatorCondition", "simulationPolicyOffer", "simulatorInitialPaymentPercentage"]) {
      context[name] = executeProduction(productionVariable(name), context);
    }
  };
  const change = conditionId => {
    executeProduction(`(${productionVariable("handleSimulatorConditionChange")})(conditionId)`, { ...context, conditionId });
    refresh();
  };
  context.handleSimulatorConditionChange = change;
  const mapExpression = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "simulatorPolicyConditions.map");
  function findInput(element) {
    if (element?.type === "input") return element.props;
    const children = element?.props?.children;
    for (const child of Array.isArray(children) ? children.flat(Infinity) : [children]) {
      const input = child && typeof child === "object" ? findInput(child) : null;
      if (input) return input;
    }
    return null;
  }
  const radios = () => {
    const jsx = (type, props) => ({ type, props });
    const result = executeProduction(`(${mapExpression.getText(consoleAst)})`, { ...context, exports: {}, require: () => ({ jsx, jsxs: jsx }) });
    return Array.from(result, findInput);
  };
  refresh();
  assert.deepEqual(radios().map(radio => radio.value), ["condition-1", "condition-2", "condition-3"]);
  assert.deepEqual(radios().map(radio => radio.name), Array(3).fill("simulator-policy-condition"));
  assert.equal(context.simulatorInitialPaymentPercentage, 0, "Cero es una inicial de política válida");
  assert.equal(context.simulationPolicyOffer, android[0].offer);
  radios().find(radio => radio.value === "condition-2").onChange();
  assert.equal(context.simulationPolicyOffer, android[1].offer, "Mismo porcentaje selecciona el cupo y plazo de la segunda condición completos");
  assert.equal(context.simulatorInitialPaymentPercentage, 0);
  assert.deepEqual(radios().filter(radio => radio.checked).map(radio => radio.value), ["condition-2"]);
  change("no-existe");
  assert.equal(context.simulationPolicyOffer, android[1].offer);
  assert.deepEqual(clearedInitial, [""]);

  context.dataCreditoPlatform = "IPHONE";
  context.dataCreditoSimulation = simulation("IPHONE", "iphone-v1", iphone);
  refresh();
  assert.equal(context.simulatorInitialPaymentPercentage, 5, "iPhone ya no inventa inicial20/30");
  assert.equal(context.simulationPolicyOffer, iphone[0].offer);
  radios().find(radio => radio.value === "condition-2").onChange();
  assert.equal(context.simulationPolicyOffer, iphone[1].offer);
  assert.equal(context.simulatorInitialPaymentPercentage, 10);
  assert.equal(context.simulationPolicyOffer.maxInstallmentAmount, 145_000);
  context.dataCreditoPlatform = "ANDROID";
  context.dataCreditoSimulation = simulation("ANDROID", "android-v1", android);
  refresh();
  assert.equal(context.simulationPolicyOffer, android[1].offer, "Volver de iPhone conserva la condición Android de la misma revisión");
  context.dataCreditoSimulation = simulation("ANDROID", "android-v2", android);
  refresh();
  assert.equal(context.simulationPolicyOffer, android[0].offer, "Una nueva revisión no hereda una selección antigua por coincidencia de id");
  context.dataCreditoSimulationStatus = "loading";
  refresh();
  assert.deepEqual(radios(), []);
  assert.equal(context.simulationPolicyOffer, null);
  assert.equal(executeProduction(productionVariable("simulationPolicyReady"), context), false);
  context.dataCreditoSimulationStatus = "ready";
  context.dataCreditoSimulation = simulation("IPHONE", "iphone-v1", iphone);
  refresh();
  assert.deepEqual(radios(), [], "La respuesta de otra plataforma no genera condiciones locales");
  assert.equal(context.simulationPolicyOffer, null);
  context.dataCreditoSimulation = null;
  refresh();
  assert.deepEqual(radios(), [], "Sin política no se inventa una oferta aprobada");
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

test("ambos simuladores calculan interés, fianza, seguro, frecuencia y redondeo de la política elegida", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    const numeroCuotas = platform === "ANDROID" ? 16 : 24;
    const context = {
      activeDataCreditoOffer: { suretyPercentage: 60, financialSettings: {
        calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 25.18, fianzaTotalPorcentaje: 68,
        seguroCuotaPorcentaje: 0.04, frecuenciaPago: "MENSUAL", tasaPeriodoDecimales: 6,
        redondeoComercial: { modo: "PISO", multiplo: 50 },
      } },
      globalCreditSettings: { tasaInteresEa: 17.84, fianzaCuotaPorcentaje: 2.083333, seguroCuotaPorcentaje: 0.1, frecuenciaPago: "SEMANAL" },
      plazoMesesNumero: numeroCuotas, resolveCreditPolicyFinancialSettings,
      firmaSeguroDraftCorrectionPending: false, firmaSeguroSignedCorrectionFrequency: null,
    };
    const settings = executeProduction(productionVariable("resolvedPolicyFinancialSettings"), context);
    const calculation = { ...context, resolvedPolicyFinancialSettings: settings };
    const rate = executeProduction(productionVariable("tasaInteresEaNumero"), calculation);
    const surety = executeProduction(productionVariable("effectiveFianzaCuotaPorcentaje"), calculation);
    const frequency = executeProduction(productionVariable("frecuenciaPagoCredito"), calculation);
    assert.equal(rate, 25.18);
    assert.equal(surety, 68 / numeroCuotas);
    assert.equal(settings.seguroCuotaPorcentaje, 0.04);
    assert.equal(frequency, "MENSUAL");
    const plan = executeProduction(productionVariable("amortizationPlan"), {
      ...calculation, simulationPolicyReady: true, valorTotalEquipoNumero: 1_000_000,
      cuotaInicialNumero: 300_000, fechaPrimerPago: "2026-11-17", tasaInteresEaNumero: rate,
      effectiveFianzaCuotaPorcentaje: surety, frecuenciaPagoCredito: frequency,
      useMemo: calculate => calculate(), calculateFrenchAmortization,
    });
    assert.equal(plan.valorFinanciado, 700_000);
    assert.ok(Math.abs(plan.valorFianzaTotal - 476_000) < 0.001);
    assert.equal(plan.tasaInteresEa, 25.18);
    assert.equal(plan.seguroCuotaPorcentaje, 0.04);
    assert.equal(plan.frecuenciaPago, "MENSUAL");
    assert.equal(plan.cuotaCobro % 50, 0);
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

test("el plazo disponible respeta el tope de cuota de la política y conserva el rango exclusivo de fábrica", () => {
  const policyFinancialSettings = { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL", tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } };
  const context = {
    iphoneFactory: true, iphoneFactoryTermsLocked: false, iphoneFactoryRangeActive: false,
    simulatorMode: true, simulationPolicyReady: true, activeDataCreditoOffer: { financialSettings: policyFinancialSettings, suretyPercentage: 75 },
    valorTotalEquipoNumero: 1_000_000, cuotaInicialNumero: 400_000, fechaPrimerPago: "2026-11-17",
    iphoneMaxInstallmentValue: 105_000, dataCreditoInstallmentCount: 12, plazoMaximoCuotas: 12,
    policyInstallmentOptions: Array.from({ length: 12 }, (_, index) => String(index + 1)),
    IPHONE_DEFAULT_CREDIT_INSTALLMENTS: 24, globalCreditSettings: { tasaInteresEa: 0, fianzaCuotaPorcentaje: 0, seguroCuotaPorcentaje: 0, frecuenciaPago: "SEMANAL" },
    useMemo: calculate => calculate(), normalizeCreditInstallments, resolveCreditPolicyFinancialSettings,
    calculateFrenchAmortization, validateIphoneInstallmentLimit,
  };
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), context)), ["11", "12"], "La política105000 retira el plazo10 cuya cuota es108750 aunque el global permita160000");
  const lowerPrincipal = { ...context, cuotaInicialNumero: 600_000, iphoneMaxInstallmentValue: 85_000 };
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), lowerPrincipal)), ["9", "10", "11", "12"], "La simulación no añade un piso90000 ajeno a la política");
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), { ...lowerPrincipal, simulatorMode: false, iphoneFactoryRangeActive: true })), [], "La fábrica conserva la restricción operativa vigente");
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), { ...context, iphoneFactoryTermsLocked: true })), context.policyInstallmentOptions, "Las condiciones firmadas no se filtran de nuevo");
});

test("una configuración general tardía no sobrescribe plazo ni fecha elegidos en la simulación", () => {
  const nextInput = { plazoMaximoCuotas: 16, plazoCuotas: 12, iphonePlazoMaximoCuotas: 48, iphonePlazoCuotas: 36,
    frecuenciaPago: "QUINCENAL", tasaInteresEa: 29.24, fianzaPorcentaje: 75, iphoneTopeFinanciado: 3_500_000, iphoneTopeCuota: 160_000 };
  for (const iphoneFactory of [false, true]) {
    const updatedTerms = [];
    const context = {
      nextInput, simulatorMode: true, iphoneFactory, normalizeCreditInstallmentLimit, normalizeCreditInstallments, normalizeMoneyLimit,
      normalizePaymentFrequency: value => value, getDefaultFirstPaymentDate: () => "2026-11-17",
      IPHONE_MAX_CREDIT_INSTALLMENTS: 48, IPHONE_DEFAULT_CREDIT_INSTALLMENTS: 24, MAX_CREDIT_INSTALLMENTS: 60,
      DEFAULT_CREDIT_INSTALLMENTS: 12, IPHONE_INITIAL_PAYMENT_PERCENTAGE: 30, IPHONE_MAX_FINANCED_AMOUNT: 3_500_000,
      IPHONE_MAX_INSTALLMENT_VALUE: 160_000, DEFAULT_INSTALLMENT_SURETY_PERCENTAGE: 2.08, DEFAULT_INSTALLMENT_INSURANCE_PERCENTAGE: 0.03,
      setCreditSettings() {}, setGlobalCreditSettings() {}, setCreditSettingsDocument() {}, setTasaInteresEa() {}, setFianzaPorcentaje() {},
      setPlazoMeses: value => updatedTerms.push(["plazo", value]), setFechaPrimerPago: value => updatedTerms.push(["fecha", value]),
      applyingDraftRef: { current: false }, cancelPendingDraftAutosave() {},
    };
    executeProduction(`(${productionVariable("applyCreditSettings")})(nextInput, null, "")`, context);
    assert.deepEqual(updatedTerms, [], `La respuesta de configuración global no altera la simulación ${iphoneFactory ? "iPhone" : "Android"}`);
    const preservedTerms = { plazoMeses: "48", fechaPrimerPago: "2026-12-02", frecuenciaPago: "MENSUAL", fianzaPorcentaje: "68", policyControlled: true, restoringDraft: true };
    executeProduction(`(${productionVariable("applyCreditSettings")})(nextInput, null, "", preservedTerms)`, { ...context, simulatorMode: false, preservedTerms });
    assert.deepEqual(updatedTerms, [["plazo", "48"], ["fecha", "2026-12-02"]], "La restauración de una venta conserva sus términos pactados");
    assert.equal(context.applyingDraftRef.current, true);
  }
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
      return { ok: true, data: { simulation: { simulationOnly: true, platform: "IPHONE", decision: "APROBADO", conditions: [{ id: "condition-1", offer: {} }], offer: {} } } };
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
    const simulation = platform => ({ simulationOnly: true, platform, decision: "APROBADO", conditions: [{ id: "condition-1", offer: { initialPaymentPercentage: platform === "ANDROID" ? 0 : 30 } }], offer: { initialPaymentPercentage: platform === "ANDROID" ? 0 : 30 } });
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
