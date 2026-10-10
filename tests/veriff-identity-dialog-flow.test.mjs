import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
let entryEffect;
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declarations.set(node.name.text, node.initializer?.getText(ast));
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("const entryKey = String(draftId)")) entryEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(entryEffect);
function fixture(overrides = {}) {
  const state = {
    createClientMode: true, wizardStep: 4, simulatorMode: false, deliveryMode: false,
    draftResumeHydrating: false, draftResumeLoadFailed: false, veriffConfigLoaded: true,
    draftId: 7, equipmentImeiConfirmed: true, veriffApproved: false, veriffIdentityFlowEnabled: true,
    identityValidationEntryRef: { current: null }, identityValidationModalOpen: false,
    identityValidationQrVisible: false, identityValidationHandoffRequired: false,
    veriffValidation: { id: 91, sessionUrl: "https://veriff.invalid/current-session" },
    veriffHasFinalDecision: false, veriffSubmitting: false, veriffCanGenerateNewQr: true,
    veriffAutoSessionRef: { current: false }, generated: 0, requests: 0, focused: 0,
    signatureManagementRef: { current: { focus() { state.focused++; } } },
    window: { requestAnimationFrame(callback) { callback(); } },
    validateIdentityWithVeriff() { state.generated++; state.veriffSubmitting = true; },
    advanceToStep(step) { state.wizardStep = step; },
    ...overrides,
  };
  for (const name of ["IdentityValidationModalOpen", "IdentityValidationQrVisible", "IdentityValidationHandoffRequired"]) {
    state["set" + name] = value => { state[name[0].toLowerCase() + name.slice(1)] = value; };
  }
  const execute = code => runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, state);
  return { state, enter: () => execute("(" + entryEffect + ")()"), call: name => execute("(" + declarations.get(name) + ")()") };
}

test("entrar pendiente abre una vez; cerrar y recibir estados no abre ni genera sesiones", () => {
  const f = fixture(); f.enter();
  assert.equal(f.state.identityValidationModalOpen, true);
  assert.equal(f.state.identityValidationHandoffRequired, true);
  f.state.identityValidationModalOpen = false;
  f.state.veriffValidation = { ...f.state.veriffValidation, status: "REVIEW" }; f.enter();
  assert.equal(f.state.identityValidationModalOpen, false);
  f.state.veriffApproved = true; f.enter();
  assert.equal(f.state.identityValidationModalOpen, false);
  assert.equal(f.state.identityValidationHandoffRequired, true);
  assert.equal(f.state.generated, 0);
  f.call("resumeIdentityValidation");
  assert.equal(f.state.identityValidationModalOpen, true);
});

test("la aprobación conserva el modal hasta continuar; entrar ya aprobado lo omite", () => {
  const f = fixture(); f.enter(); f.state.veriffApproved = true; f.enter();
  assert.equal(f.state.identityValidationModalOpen, true);
  f.call("continueIdentityToSignature");
  assert.equal(f.state.identityValidationModalOpen, false);
  assert.equal(f.state.identityValidationHandoffRequired, false);
  assert.equal(f.state.focused, 1);
  assert.equal(f.state.generated, 0);
  const approved = fixture({ veriffApproved: true }); approved.enter();
  assert.equal(approved.state.identityValidationModalOpen, false);
  assert.equal(approved.state.identityValidationHandoffRequired, false);
  const pending = fixture(); pending.enter(); pending.call("continueIdentityToSignature");
  assert.equal(pending.state.identityValidationModalOpen, true);
  assert.equal(pending.state.identityValidationHandoffRequired, true);
});

test("abrir QR conserva la sesión vigente; generar requiere una acción y no se duplica", () => {
  const existing = fixture(); existing.enter(); existing.call("openIdentityValidationQr");
  assert.equal(existing.state.identityValidationQrVisible, true);
  assert.equal(existing.state.generated, 0);
  assert.equal(existing.state.veriffValidation.id, 91);
  const fresh = fixture({ veriffValidation: null }); fresh.enter();
  assert.equal(fresh.state.generated, 0);
  fresh.call("openIdentityValidationQr"); fresh.call("openIdentityValidationQr");
  assert.equal(fresh.state.generated, 1);
  const blocked = fixture({ veriffValidation: null, veriffCanGenerateNewQr: false });
  blocked.call("openIdentityValidationQr"); assert.equal(blocked.state.generated, 0);
});

test("espera restauración y confirmación; regresar o cambiar solicitud crea una entrada nueva", () => {
  for (const overrides of [{ draftResumeHydrating: true }, { draftResumeLoadFailed: true }, { veriffConfigLoaded: false }, { equipmentImeiConfirmed: false }, { draftId: null }]) {
    const f = fixture(overrides); f.enter(); assert.equal(f.state.identityValidationModalOpen, false);
  }
  const f = fixture(); f.enter(); f.state.identityValidationModalOpen = false;
  f.state.wizardStep = 2; f.enter(); f.state.wizardStep = 4; f.enter();
  assert.equal(f.state.identityValidationModalOpen, true);
  f.state.identityValidationModalOpen = false; f.state.draftId = 8; f.enter();
  assert.equal(f.state.identityValidationModalOpen, true);
  assert.equal(f.state.identityValidationQrVisible, false);
  const inspection = fixture({ equipmentImeiConfirmed: false });
  inspection.call("resumeIdentityValidation");
  assert.equal(inspection.state.wizardStep, 2);
  assert.equal(inspection.state.identityValidationModalOpen, false);
});
