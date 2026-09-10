import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

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
    }
  );
  return { notices, visitedSteps };
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
        assert.equal(result.notices.length, 1, description);
        assert.ok(result.notices[0].text, description);
      }
    }
  }
});

test("el paso 2 completo permite continuar en ambas rutas y perfiles", async () => {
  for (const handler of ["goToStep", "advanceToStep"]) {
    for (const central of [false, true]) {
      const result = await navigate(handler, {
        central,
        plan: { imei: "350000000000001" },
      });
      assert.deepEqual(result.visitedSteps, [4]);
      assert.deepEqual(result.notices, []);
    }
  }
});

test("el usuario puede regresar al cliente aunque aún no tenga IMEI", async () => {
  for (const handler of ["goToStep", "advanceToStep"]) {
    for (const central of [false, true]) {
      const result = await navigate(handler, { central, target: 1 });
      assert.deepEqual(result.visitedSteps, [1]);
      assert.deepEqual(result.notices, []);
    }
  }
});

test("el simulador conserva la consulta de la cuota sin exigir IMEI", () => {
  const state = evaluatePlan({ simulatorMode: true, imei: "" });
  assert.equal(state.financialPreviewReady, true);
  assert.equal(state.stepEquipoReady, true);
});

function renderInstallment(overrides = {}) {
  const candidates = [];
  function visit(node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(parsed) === "div" &&
      node.getText(parsed).includes("? currency(valorCuota) :")
    ) {
      candidates.push(node.getText(parsed));
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  candidates.sort((left, right) => left.length - right.length);
  assert.ok(candidates.length, "Expected the production installment card");
  const element = execute(
    "const card = (" + candidates[0] + "); card;",
    {
      require: createRequire(import.meta.url),
      exports: {},
      ...evaluatePlan(overrides),
      frecuenciaPagoLabel: "Quincenal",
      valorCuota: 123_456,
      currency: (value) => "COP " + value,
      exactCurrency: (value) => "COP " + value,
      canSeeInternalPricing: false,
      amortizationPlan: { cuotaTotal: 123_455.5 },
    }
  );
  return renderToStaticMarkup(element);
}

test("la tarjeta real muestra la cuota mientras el IMEI está vacío o incompleto", () => {
  for (const imei of ["", "35000000000000", "350000000000001"]) {
    const markup = renderInstallment({ imei });
    assert.match(markup, />COP 123456<\/strong>/);
    assert.match(markup, /Cálculo actualizado/);
    assert.doesNotMatch(markup, /Cuota exacta/);
  }
});

test("la tarjeta real conserva el estado pendiente con datos financieros incompletos", () => {
  const markup = renderInstallment({ cuotaInicialValida: false });
  assert.match(markup, />-<\/strong>/);
  assert.doesNotMatch(markup, />COP 123456<\/strong>/);
  assert.match(markup, /Completa los datos financieros para calcular/);
});
