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
  normalizeCreditInstallmentLimit,
  normalizeCreditInstallments,
  normalizeMoneyLimit,
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

test("la simulación toma cupo, plazo y cuota máxima de los parámetros generales", () => {
  for (const iphoneFactory of [false, true]) {
    const context = {
      simulatorMode: true, iphoneFactory, dataCreditoCreditCreationMode: false, dataCreditoApproval: null,
      activeDataCreditoPlatform: null, activeDataCreditoOffer: null,
      dataCreditoMaxFinancedAmount: 0, dataCreditoInstallmentCount: 0,
      iphoneMaxFinancedAmount: 1_800_000,
      creditSettings: { iphoneTopeFinanciado: 1_800_000, iphoneTopeCuota: 120_000, iphonePlazoMaximoCuotas: 24, plazoMaximoCuotas: 12 },
      IPHONE_MAX_FINANCED_AMOUNT: 3_500_000, IPHONE_MAX_INSTALLMENT_VALUE: 160_000,
      IPHONE_MAX_CREDIT_INSTALLMENTS: 48, DEFAULT_MAX_CREDIT_INSTALLMENTS: 16,
      normalizeMoneyLimit, normalizeCreditInstallmentLimit,
    };
    assert.equal(executeProduction(productionVariable("activeDataCreditoOffer"), context), null, "No existe una oferta aprobada de cliente en el simulador");
    assert.equal(executeProduction(productionVariable("plazoMaximoCuotas"), context), iphoneFactory ? 24 : 12);
    if (iphoneFactory) {
      assert.equal(executeProduction(productionVariable("iphoneMaxInstallmentValue"), context), 120_000);
      assert.equal(executeProduction(productionVariable("iphoneMaxFinancedAmount"), context), 1_800_000);
    }
  }
  assert.doesNotMatch(consoleSource, /dataCreditoLocksInstallmentCount/);
  assert.match(consoleSource, /getCreditInstallmentOptions\(plazoMaximoCuotas\)/);
});

test("ambos simuladores respetan precio base, inicial general20/30 y cupo global iPhone sin cupo de cliente", () => {
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
    for (const [percentage, iphoneCap, expected] of [[20, 2_000_000, 800_000], [30, 2_000_000, 950_000], [20, 900_000, platform === "IPHONE" ? 1_100_000 : 800_000]]) {
      const context = {
        simulatorMode: true, valorTotalEquipoNumero: 2_000_000, precioBaseVentaCatalogo: 1_500_000,
        initialPaymentPercentage: percentage, activeDataCreditoPlatform: null, currentDevicePlatform: platform.toLowerCase(),
        activeDataCreditoOffer: null, dataCreditoMaxFinancedAmount: 100_000,
        iphoneMaxFinancedAmount: iphoneCap, resolveRequiredInitialPaymentByPlatform,
      };
      const breakdown = executeProduction(productionVariable("initialPaymentBreakdown"), context);
      assert.equal(breakdown.requiredInitialPayment, expected, `${platform}, inicial=${percentage}, topeGlobal=${iphoneCap}`);
      assert.equal(executeProduction(productionVariable("cuotaInicialMinimaNumero"), { ...context, initialPaymentBreakdown: breakdown }), expected);
    }
  }
  assert.equal(resolveInitialPaymentAfterMinimumRefresh({ currentValue: "1200000", totalValue: "2000000", minimumValue: 1_100_000 }), "1200000");
  assert.equal(resolveInitialPaymentAfterMinimumRefresh({ currentValue: "1000000", totalValue: "2000000", minimumValue: 1_100_000 }), "1100000");
});

test("los controles reales muestran únicamente20/30 y conservan la selección simple de inicial", () => {
  const clearedInitial = [];
  let resetGeneration = 0;
  const context = {
    simulatorMode: true, simulatorInitialPaymentPercentage: 30, SIMULATOR_INITIAL_PAYMENT_PERCENTAGES: [20, 30],
    formatPercent: value => `${value} %`, setCuotaInicial: value => clearedInitial.push(value),
    setSimulatorPlanResetGeneration: update => { resetGeneration = typeof update === "function" ? update(resetGeneration) : update; },
  };
  context.setSimulatorInitialPaymentPercentage = value => { context.simulatorInitialPaymentPercentage = value; };
  const change = percentage => executeProduction(`(${productionVariable("handleSimulatorInitialPaymentPercentageChange")})(percentage)`, { ...context, percentage });
  context.handleSimulatorInitialPaymentPercentageChange = change;
  const mapExpression = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "SIMULATOR_INITIAL_PAYMENT_PERCENTAGES.map");
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
    return Array.from(executeProduction(`(${mapExpression.getText(consoleAst)})`, { ...context, exports: {}, require: () => ({ jsx, jsxs: jsx }) }), findInput);
  };
  assert.deepEqual(radios().map(radio => radio.value), [20, 30]);
  assert.deepEqual(radios().map(radio => radio.name), ["simulator-initial-payment-percentage", "simulator-initial-payment-percentage"]);
  assert.deepEqual(radios().filter(radio => radio.checked).map(radio => radio.value), [30]);
  radios().find(radio => radio.value === 20).onChange();
  assert.equal(context.simulatorInitialPaymentPercentage, 20);
  assert.deepEqual(radios().filter(radio => radio.checked).map(radio => radio.value), [20]);
  assert.deepEqual(clearedInitial, [""]);
  assert.equal(resetGeneration, 1);
  change(5);
  change(20);
  assert.equal(context.simulatorInitialPaymentPercentage, 20, "Sólo20/30 están disponibles y repetir no reinicia el plan");
  assert.deepEqual(clearedInitial, [""]);
  assert.equal(resetGeneration, 1);
  radios().find(radio => radio.value === 30).onChange();
  assert.equal(context.simulatorInitialPaymentPercentage, 30);
  assert.equal(resetGeneration, 2);
  assert.doesNotMatch(consoleSource, /simulator-policy-condition|step-two-simulator-condition/);
});

test("la inicial espera la carga general y preserva importes manuales válidos o términos firmados", () => {
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
  assert.equal(updates, 0, "El mínimo provisional no se convierte en una inicial ingresada");
  for (const percentage of [20, 30]) {
    amount = "";
    refresh({ simulationPolicyReady: true, cuotaInicialMinimaNumero: percentage * 10_000 });
    assert.equal(amount, String(percentage * 10_000));
  }
  amount = "400000";
  refresh({ simulationPolicyReady: true, cuotaInicialMinimaNumero: 300_000 });
  assert.equal(amount, "400000", "Respeta una inicial manual válida");
  for (const lock of [{ firmaSeguroProcessExists: true }, { draftResumeHydrating: true }]) {
    amount = "10000";
    refresh({ simulatorMode: false, cuotaInicialMinimaNumero: 100_000, ...lock });
    assert.equal(amount, "10000", "Conserva términos firmados o en restauración");
  }
});

test("las opciones generales no reemplazan las condiciones aprobadas de una venta ni liberan contratos enviados a firma", () => {
  const context = { simulatorMode: false, simulatorInitialPaymentPercentage: 30, activeDataCreditoOffer: { initialPaymentPercentage: 10 }, configuredInitialPaymentPercentage: 20 };
  assert.equal(executeProduction(productionVariable("initialPaymentPercentage"), context), 10);
  assert.equal(executeProduction(productionVariable("initialPaymentPercentage"), { ...context, activeDataCreditoOffer: null }), 20);
  assert.equal(executeProduction(productionVariable("cuotaInicialMinimaNumero"), { initialPaymentBreakdown: { requiredInitialPayment: 450_000 } }), 450_000);
  for (const [firmaSeguroProcessExists, firmaSeguroDraftCorrectionPending] of [[true, false], [false, true]]) {
    const notices = [];
    executeProduction(`(${productionVariable("clearStepTwoFields")})()`, {
      firmaSeguroProcessExists, firmaSeguroDraftCorrectionPending, setStepTwoClearConfirmOpen() {}, setNotice: notice => notices.push(notice),
      setSimulatorInitialPaymentPercentage: () => assert.fail("Contrato protegido"), setSimulatorPlanResetGeneration: () => assert.fail("Contrato protegido"),
      setCuotaInicial: () => assert.fail("Contrato protegido"),
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /protegido.*enviado a firma/);
  }
});

test("el cálculo real del simulador usa interés, fianza, seguro, frecuencia y redondeo generales", () => {
  for (const platform of ["ANDROID", "IPHONE"]) {
    const numeroCuotas = platform === "ANDROID" ? 12 : 24;
    const context = {
      simulatorMode: true, activeDataCreditoOffer: null,
      globalCreditSettings: { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 25.18, fianzaTotalPorcentaje: 68,
        fianzaCuotaPorcentaje: 2, seguroCuotaPorcentaje: 0.04, frecuenciaPago: "MENSUAL" },
      plazoMesesNumero: numeroCuotas, resolveCreditPolicyFinancialSettings,
      firmaSeguroDraftCorrectionPending: false, firmaSeguroSignedCorrectionFrequency: null,
    };
    context.creditSettings = context.globalCreditSettings;
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

test("los plazos iPhone se filtran con la cuota máxima general y conservan el rango exclusivo de fábrica", () => {
  const generalSettings = { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75, fianzaCuotaPorcentaje: 2.08, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL" };
  const context = {
    iphoneFactory: true, iphoneFactoryTermsLocked: false, iphoneFactoryRangeActive: false,
    simulatorMode: true, simulationPolicyReady: true, activeDataCreditoOffer: null,
    valorTotalEquipoNumero: 1_000_000, cuotaInicialNumero: 400_000, fechaPrimerPago: "2026-11-17",
    iphoneMaxInstallmentValue: 105_000, dataCreditoInstallmentCount: 0, plazoMaximoCuotas: 12,
    policyInstallmentOptions: Array.from({ length: 12 }, (_, index) => String(index + 1)),
    IPHONE_DEFAULT_CREDIT_INSTALLMENTS: 24, globalCreditSettings: generalSettings, creditSettings: generalSettings,
    useMemo: calculate => calculate(), normalizeCreditInstallments, resolveCreditPolicyFinancialSettings,
    calculateFrenchAmortization, validateIphoneInstallmentLimit,
  };
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), context)), ["11", "12"], "El tope general105000 retira el plazo10 cuya cuota es108750");
  const lowerPrincipal = { ...context, cuotaInicialNumero: 600_000, iphoneMaxInstallmentValue: 85_000 };
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), lowerPrincipal)), ["9", "10", "11", "12"], "La simulación mantiene su validación sin añadir el piso de fábrica");
  const factory = { ...lowerPrincipal, simulatorMode: false, iphoneFactoryRangeActive: true, activeDataCreditoOffer: { financialSettings: null, suretyPercentage: 75 } };
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), factory)), [], "La fábrica conserva la restricción operativa vigente");
  assert.deepEqual(Array.from(executeProduction(productionVariable("creditInstallmentOptions"), { ...context, iphoneFactoryTermsLocked: true })), context.policyInstallmentOptions, "Las condiciones firmadas no se filtran de nuevo");
});

test("una carga general tardía no sobrescribe plazo ni fecha elegidos en la simulación", () => {
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
    assert.deepEqual(updatedTerms, [], `La respuesta general no altera la selección ${iphoneFactory ? "iPhone" : "Android"}`);
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

test("los parámetros de simulación cargados prevalecen sobre otra configuración tardía y nunca cruzan plataformas", () => {
  const response = { kind: "GENERAL_CREDIT_SETTINGS", simulationOnly: true, platform: "IPHONE", settings: { plazoCuotas: 24, iphoneTopeCuota: 120_000 }, globalSettings: { tasaInteresEa: 29.24 } };
  const context = {
    simulatorMode: true, dataCreditoSimulationStatus: "ready", dataCreditoPlatform: "IPHONE", dataCreditoSimulation: response,
    loadedCreditSettings: { plazoCuotas: 4, iphoneTopeCuota: 160_000 }, loadedGlobalCreditSettings: { tasaInteresEa: 18 },
  };
  context.simulatorGeneralSettings = executeProduction(productionVariable("simulatorGeneralSettings"), context);
  assert.equal(context.simulatorGeneralSettings, response);
  assert.equal(executeProduction(productionVariable("simulationPolicyReady"), context), true);
  for (const staleConfiguration of [4, 8, 12]) {
    context.loadedCreditSettings = { plazoCuotas: staleConfiguration };
    context.loadedGlobalCreditSettings = { tasaInteresEa: 10 + staleConfiguration };
    assert.equal(executeProduction(productionVariable("creditSettings"), context), response.settings);
    assert.equal(executeProduction(productionVariable("globalCreditSettings"), context), response.globalSettings);
  }
  for (const state of [{ dataCreditoPlatform: "ANDROID" }, { dataCreditoSimulationStatus: "loading" }, { dataCreditoSimulation: null }]) {
    const invalid = { ...context, ...state };
    invalid.simulatorGeneralSettings = executeProduction(productionVariable("simulatorGeneralSettings"), invalid);
    assert.equal(invalid.simulatorGeneralSettings, null);
    assert.equal(executeProduction(productionVariable("simulationPolicyReady"), invalid), false);
  }
});

test("el simulador consulta únicamente parámetros generales por GET y cancela el guardado de borradores", async () => {
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
      return { ok: true, data: { simulation: { kind: "GENERAL_CREDIT_SETTINGS", simulationOnly: true, platform: "IPHONE", settings: { plazoCuotas: 24 }, globalSettings: { tasaInteresEa: 29.24 } } } };
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

test("una respuesta o error tardíos de Android abortado no sustituyen los parámetros iPhone vigentes", async () => {
  const policyEffect = productionNode(node => ts.isCallExpression(node) && node.expression.getText(consoleAst) === "useEffect" && node.arguments[0]?.getText(consoleAst).includes("const loadDataCreditoSimulation ="));
  for (const lateResult of ["success", "error"]) {
    let resolveOld, rejectOld;
    const old = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
    const writes = [], requests = [];
    let currentSimulation = null, currentStatus = "idle";
    const simulation = platform => ({ kind: "GENERAL_CREDIT_SETTINGS", simulationOnly: true, platform, settings: { plazoCuotas: platform === "ANDROID" ? 12 : 24 }, globalSettings: { tasaInteresEa: 29.24 } });
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
