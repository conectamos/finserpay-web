import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url),
  "utf8"
);
const parsed = ts.createSourceFile(
  "credit-factory-console.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);

// Exercise the production predicates and handlers without mounting the full factory.
function declaration(name) {
  const matches = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(matches.length, 1, `Expected one production declaration: ${name}`);
  return `const ${matches[0].getText(parsed)};`;
}

function execute(code, context) {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  return runInNewContext(outputText, context, { timeout: 1000 });
}

function evaluatePlan(overrides = {}) {
  return execute(
    [
      declaration("imeiDigits"),
      declaration("imeiValido"),
      declaration("financialPreviewReady"),
      declaration("stepEquipoReady"),
      "({ financialPreviewReady, stepEquipoReady })",
    ].join("\n"),
    {
      imei: "",
      simulationPolicyReady: true,
      cuotaInicialValida: true,
      saldoFinanciado: 2_000_000,
      plazoMesesNumero: 24,
      iphoneInstallmentLimitExceeded: false,
      iphoneFactorySignaturePending: false,
      iphoneFactoryRangeActive: false,
      creditInstallmentOptions: ["24"],
      plazoMeses: "24",
      equipoMarca: "IPHONE",
      equipoModelo: "IPHONE 13 PRO 256GB",
      simulatorMode: false,
      ...overrides,
    }
  );
}

async function navigate(handler, { plan = {}, central = false, target = 4 } = {}) {
  const notices = [];
  const visitedSteps = [];
  const confirmationRequests = [];
  const readiness = evaluatePlan(plan);
  await execute(
    [
      declaration("FLEXIBLE_WIZARD_FOR_TESTING"),
      declaration("canAdminMoveFreelyInFactory"),
      declaration(handler),
      `${handler}(targetStep)`,
    ].join("\n"),
    {
      ...readiness,
      targetStep: target,
      wizardStep: 2,
      signedContractEditLocked: false,
      advisorSignedContractStep: 5,
      firmaSeguroDraftCorrectionPending: false,
      simulatorMode: false,
      canSeeInternalPricing: central,
      createClientMode: true,
      dataCreditoVeriffDocumentRejected: false,
      iphoneInstallmentLimitExceeded: plan.iphoneInstallmentLimitExceeded || false,
      visibleIphoneInstallmentLimitMessage: "La cuota supera el límite autorizado.",
      hideIdentityWizardStep: true,
      iphoneFactory: true,
      draftId: null,
      nextVisibleWizardStep: () => 4,
      clampWizardStep: (step) => step,
      setNotice: (notice) => notices.push(notice),
      setWizardStep: (step) => visitedSteps.push(step),
      persistWizardStep: async (step) => visitedSteps.push(step),
      requestEquipmentImeiConfirmation: async (step) => confirmationRequests.push(step),
    }
  );
  return { notices, visitedSteps, confirmationRequests };
}

test("la cuota se puede consultar con IMEI vacío o incompleto; el equipo sigue pendiente", () => {
  for (const imei of ["", "123", "35000000000000"]) {
    const state = evaluatePlan({ imei });
    assert.equal(state.financialPreviewReady, true, `Vista previa con IMEI ${imei}`);
    assert.equal(state.stepEquipoReady, false, `Avance con IMEI ${imei}`);
  }
  const complete = evaluatePlan({ imei: "350000000000001" });
  assert.equal(complete.financialPreviewReady, true);
  assert.equal(complete.stepEquipoReady, true);
});

test("la vista previa mantiene todas las condiciones financieras del plan", () => {
  for (const invalidPlan of [
    { simulationPolicyReady: false },
    { cuotaInicialValida: false },
    { saldoFinanciado: 0 },
    { plazoMesesNumero: 0 },
    { iphoneInstallmentLimitExceeded: true },
  ]) {
    const state = evaluatePlan({ imei: "350000000000001", ...invalidPlan });
    assert.equal(state.financialPreviewReady, false, JSON.stringify(invalidPlan));
    assert.equal(state.stepEquipoReady, false, JSON.stringify(invalidPlan));
  }
});

test("marca y modelo siguen siendo obligatorios para completar el paso 2", () => {
  for (const missingEquipment of [{ equipoMarca: " " }, { equipoModelo: " " }]) {
    const state = evaluatePlan({ imei: "350000000000001", ...missingEquipment });
    assert.equal(state.financialPreviewReady, true);
    assert.equal(state.stepEquipoReady, false);
  }
});

test("ambas rutas de avance bloquean el paso 2 incompleto para vendedor y administrador central", async () => {
  for (const handler of ["goToStep", "advanceToStep"]) {
    for (const central of [false, true]) {
      for (const plan of [
        { imei: "" },
        { imei: "35000000000000" },
        { imei: "350000000000001", equipoMarca: "" },
        { imei: "350000000000001", equipoModelo: "" },
        { imei: "350000000000001", cuotaInicialValida: false },
        { imei: "350000000000001", saldoFinanciado: 0 },
        { imei: "350000000000001", plazoMesesNumero: 0 },
        { imei: "350000000000001", iphoneInstallmentLimitExceeded: true },
      ]) {
        const result = await navigate(handler, { central, plan });
        const description = `${handler}, central=${central}, ${JSON.stringify(plan)}`;
        assert.deepEqual(result.visitedSteps, [], description);
        assert.deepEqual(result.confirmationRequests, [], description);
        assert.equal(result.notices.length, 1, description);
        assert.ok(result.notices[0].text, description);
      }
    }
  }
});

test("el paso 2 completo exige confirmar el IMEI antes de avanzar en ambas rutas y perfiles", async () => {
  for (const handler of ["goToStep", "advanceToStep"]) {
    for (const central of [false, true]) {
      const result = await navigate(handler, {
        central,
        plan: { imei: "350000000000001" },
      });
      assert.deepEqual(result.visitedSteps, []);
      assert.deepEqual(result.confirmationRequests, [4]);
      assert.deepEqual(result.notices, []);
    }
  }
});

test("el usuario puede regresar al cliente aunque aún no tenga IMEI", async () => {
  for (const handler of ["goToStep", "advanceToStep"]) {
    for (const central of [false, true]) {
      const result = await navigate(handler, { central, target: 1 });
      assert.deepEqual(result.visitedSteps, [1]);
      assert.deepEqual(result.confirmationRequests, []);
      assert.deepEqual(result.notices, []);
    }
  }
});

test("el simulador conserva la consulta de la cuota sin exigir IMEI", () => {
  const state = evaluatePlan({ simulatorMode: true, imei: "" });
  assert.equal(state.financialPreviewReady, true);
  assert.equal(state.stepEquipoReady, true);
});

function loadProductionComponent(filename) {
  const exports = {};
  execute(readFileSync(new URL(`../app/dashboard/creditos/${filename}.tsx`, import.meta.url), "utf8"), {
    exports,
    require: (specifier) => {
      if (specifier.endsWith(".module.css")) return { default: {} };
      if (specifier === "./equipment-visual") return { default: loadProductionComponent("equipment-visual") };
      return require(specifier);
    },
  });
  return exports.default;
}

const CreditFinancingProposal = loadProductionComponent("credit-financing-proposal");

function renderInstallment(overrides = {}) {
  const candidates = [];
  function visit(node) {
    if (
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(parsed) === "CreditFinancingProposal"
    ) {
      candidates.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(candidates.length, 1, "Expected the production shared financing proposal");
  const readiness = evaluatePlan(overrides);
  const element = execute(
    ["stepTwoPlanEquipmentReady", "stepTwoPolicyAvailable", "stepTwoPlanSelectionValid", "stepTwoProposalReady"].map(declaration).join("\n") + "\nconst card = (" + candidates[0] + "); card;",
    {
      require,
      exports: {},
      CreditFinancingProposal,
      dataCreditoCreditCreationMode: true,
      dataCreditoBypassed: false,
      activeDataCreditoOffer: {},
      simulatorMode: false,
      simulationPolicyReady: true,
      creditInstallmentOptions: ["24"],
      plazoMeses: "24",
      displayEquipmentName: "iPhone 13 Pro 256GB",
      equipoMarca: "IPHONE",
      equipoModelo: "iPhone 13 Pro 256GB",
      currentDevicePlatform: "iphone",
      valorTotalEquipoNumero: 2_500_000,
      cuotaInicialValida: overrides.cuotaInicialValida ?? true,
      cuotaInicialNumero: 500_000,
      saldoBaseFinanciado: 2_000_000,
      plazoMesesNumero: 24,
      frecuenciaPagoLabel: "Quincenal",
      valorCuota: 123_456,
      ...overrides,
      ...readiness,
    }
  );
  return renderToStaticMarkup(element);
}

test("la tarjeta real muestra la cuota mientras el IMEI está vacío o incompleto", () => {
  for (const imei of ["", "35000000000000", "350000000000001"]) {
    const markup = renderInstallment({ imei });
    assert.match(markup, /data-ready="true"/);
    assert.match(markup, />\$\s*123\.456<\/dd>/);
    assert.match(markup, /Cuota quincenal/);
    assert.doesNotMatch(markup, /Cuota exacta/);
  }
});

test("la tarjeta real conserva el estado pendiente con datos financieros incompletos", () => {
  const markup = renderInstallment({ cuotaInicialValida: false });
  assert.match(markup, /data-ready="false"/);
  assert.match(markup, /<dt>Cuota quincenal<\/dt><dd>—<\/dd>/);
  assert.doesNotMatch(markup, /123\.456/);
  assert.match(markup, /<dt>Inicial<\/dt><dd>—<\/dd>/);
  assert.match(markup, /<dt>Financiado<\/dt><dd>—<\/dd>/);
});

test("la propuesta real retira la cuota anterior al invalidar el plan y se recupera sin exigir IMEI", () => {
  for (const simulatorMode of [false, true]) {
    const valid = { simulatorMode, imei: "" };
    assert.match(renderInstallment(valid), />\$\s*123\.456<\/dd>/);
    for (const invalid of [
      { simulationPolicyReady: false },
      { cuotaInicialValida: false },
      { saldoFinanciado: 0 },
      { plazoMesesNumero: 0 },
      { iphoneInstallmentLimitExceeded: true },
      { equipoMarca: "" },
      { equipoModelo: "" },
      { valorTotalEquipoNumero: 0 },
    ]) {
      const markup = renderInstallment({ ...valid, ...invalid });
      assert.match(markup, /<dt>Cuota quincenal<\/dt><dd>—<\/dd>/, JSON.stringify(invalid));
      assert.doesNotMatch(markup, /123\.456/, JSON.stringify(invalid));
    }
    assert.match(renderInstallment(valid), />\$\s*123\.456<\/dd>/);
  }
});
