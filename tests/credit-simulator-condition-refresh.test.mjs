import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": projectRoot } });
const { resolveInitialPaymentAfterMinimumRefresh } = await jiti.import("../lib/credit-factory.ts");
const source = readFileSync(path.join(projectRoot, "app/dashboard/creditos/credit-factory-console.tsx"), "utf8");
const ast = ts.createSourceFile("credit-factory-console.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode(predicate) {
  const matches = [];
  function visit(node) {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, "Debe encontrarse un único nodo de producción");
  return matches[0];
}

function execute(code, context) {
  return runInNewContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context, { timeout: 1000 });
}

const initialEffect = findNode(node => ts.isCallExpression(node) &&
  node.expression.getText(ast) === "useEffect" &&
  node.arguments[0]?.getText(ast).includes("resolveInitialPaymentAfterMinimumRefresh"));

function fixture(overrides = {}) {
  const context = {
    simulatorMode: true, simulationPolicyReady: true,
    simulatorPlanResetGeneration: 0,
    valorTotalEquipoNumero: 2_200_000, valorEquipoTotal: "2200000",
    cuotaInicialMinimaNumero: 660_000,
    draftResumeHydrating: false, firmaSeguroProcessExists: false,
    resolveInitialPaymentAfterMinimumRefresh,
    cuotaInicial: "", plazoMeses: "16", ...overrides,
  };
  context.setCuotaInicial = update => {
    context.cuotaInicial = typeof update === "function" ? update(context.cuotaInicial) : update;
  };
  context.setSimulatorPlanResetGeneration = update => {
    context.simulatorPlanResetGeneration = typeof update === "function"
      ? update(context.simulatorPlanResetGeneration) : update;
  };
  let previousDependencies;
  const runInitialEffect = () => {
    const dependencies = Array.from(execute(initialEffect.arguments[1].getText(ast), context));
    if (previousDependencies && dependencies.every((value, index) => Object.is(value, previousDependencies[index]))) return false;
    previousDependencies = dependencies;
    execute(`(${initialEffect.arguments[0].getText(ast)})()`, context);
    return true;
  };
  return { context, runInitialEffect };
}

test("reiniciar la simulación repuebla la inicial aunque el mínimo siga exactamente igual", () => {
  const { context, runInitialEffect } = fixture();
  assert.equal(runInitialEffect(), true);
  assert.equal(context.cuotaInicial, "660000");
  context.setCuotaInicial("");
  assert.equal(runInitialEffect(), false, "Vaciar el campo no fuerza un clamp al escribir");
  context.setSimulatorPlanResetGeneration(current => current + 1);
  assert.equal(runInitialEffect(), true);
  assert.equal(context.cuotaInicial, "660000", "El reinicio explícito no deja la propuesta sin inicial");
});

test("el reinicio conserva una inicial válida de cero y no corrige cada pulsación", () => {
  const { context, runInitialEffect } = fixture({ cuotaInicialMinimaNumero: 0 });
  runInitialEffect();
  assert.equal(context.cuotaInicial, "0");
  context.setCuotaInicial("");
  assert.equal(runInitialEffect(), false);
  assert.equal(context.cuotaInicial, "");
  context.setSimulatorPlanResetGeneration(current => current + 1);
  runInitialEffect();
  assert.equal(context.cuotaInicial, "0");
});

test("actualizar el mínimo o la disponibilidad respeta una inicial manual válida", () => {
  const { context, runInitialEffect } = fixture({ cuotaInicial: "800000" });
  runInitialEffect();
  context.cuotaInicialMinimaNumero = 700_000;
  runInitialEffect();
  assert.equal(context.cuotaInicial, "800000");
  context.simulationPolicyReady = false;
  runInitialEffect();
  context.simulationPolicyReady = true;
  runInitialEffect();
  assert.equal(context.cuotaInicial, "800000");
  context.setCuotaInicial("12");
  assert.equal(runInitialEffect(), false);
  assert.equal(context.cuotaInicial, "12", "El asesor puede completar un importe transitorio");
});

test("los términos firmados o en restauración conservan la inicial de originación", () => {
  for (const locked of [{ firmaSeguroProcessExists: true }, { draftResumeHydrating: true }]) {
    const { context, runInitialEffect } = fixture({ simulatorMode: false, cuotaInicial: "10000", ...locked });
    runInitialEffect();
    context.cuotaInicialMinimaNumero = 900_000;
    runInitialEffect();
    assert.equal(context.cuotaInicial, "10000");
  }
});

test("Limpiar reinicia explícitamente el plan de simulación incluso si estaba en su opción por defecto", () => {
  const clear = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "clearStepTwoFields");
  for (const simulatorMode of [true, false]) {
    const { context } = fixture({ simulatorMode, firmaSeguroDraftCorrectionPending: false });
    Object.assign(context, {
      setRestoredEquipmentCatalogId() {}, setEquipoMarca() {}, setEquipoModelo() {}, setImei() {},
      setValorEquipoTotal(value) { context.valorEquipoTotal = value; context.valorTotalEquipoNumero = Number(value); },
      setPlazoMeses(value) { context.plazoMeses = value; },
      setSimulatorConditionSelection() {}, setSimulatorInitialPaymentPercentage() {},
      DEFAULT_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE: 30,
      setStepTwoClearConfirmOpen() {}, setDraftStatus() {}, setDraftErrorMessage() {}, setNotice() {},
    });
    execute(`(${clear.initializer.getText(ast)})()`, context);
    assert.equal(context.simulatorPlanResetGeneration, simulatorMode ? 1 : 0);
    assert.equal(context.cuotaInicial, "");
    assert.equal(context.plazoMeses, "");
  }
});

test("Limpiar respeta el bloqueo de un contrato y no reinicia su plan", () => {
  const clear = findNode(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === "clearStepTwoFields");
  for (const locked of [{ firmaSeguroProcessExists: true }, { firmaSeguroDraftCorrectionPending: true }]) {
    const { context } = fixture({ cuotaInicial: "800000", firmaSeguroDraftCorrectionPending: false, ...locked });
    Object.assign(context, { setStepTwoClearConfirmOpen() {}, setNotice() {} });
    execute(`(${clear.initializer.getText(ast)})()`, context);
    assert.equal(context.simulatorPlanResetGeneration, 0);
    assert.equal(context.cuotaInicial, "800000");
  }
});
