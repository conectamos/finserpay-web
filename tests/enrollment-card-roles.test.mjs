import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const jsx = (type, props, key) => ({ type, props: props || {}, key });
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : [];
const component = name => Object.defineProperty(() => null, "name", { value: name });

// Execute the real enrollment card and its enclosing wizard-step condition.
// The rest of the factory has unrelated effects and integrations.
const fileName = "app/dashboard/creditos/credit-factory-console.tsx";
const source = readFileSync(new URL(`../${fileName}`, import.meta.url), "utf8");
const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let heading;
function visit(node) {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === "h4" && node.children.some(child => ts.isJsxText(child) && child.text.trim() === "2. Enrolamiento")) heading = node;
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(heading, "La tarjeta operativa 2. Enrolamiento debe existir");
let card = heading;
while (card && !(ts.isJsxElement(card) && card.openingElement.tagName.getText(ast) === "article")) card = card.parent;
assert.ok(card, "Enrolamiento debe conservar su tarjeta propia");
let step = card.parent;
while (step && !(ts.isJsxExpression(step) && step.expression && ts.isBinaryExpression(step.expression) && step.expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isBinaryExpression(step.expression.left) && step.expression.left.left.getText(ast) === "wizardStep")) step = step.parent;
assert.ok(step, "La tarjeta de enrolamiento debe pertenecer a su paso del wizard");
assert.equal(step.expression.left.operatorToken.kind, ts.SyntaxKind.EqualsEqualsEqualsToken);
assert.equal(step.expression.left.right.getText(ast), "5");
const compiled = ts.transpileModule(`export default function renderCard() { return (${step.expression.left.getText(ast)} && (${card.getText(ast)})); }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.length, 0);

function render(overrides = {}) {
  const statuses = [], errors = [], saves = [];
  const context = {
    wizardStep: 5, iphoneFactory: true, deliveryEnrollmentReady: false, iphoneEnrollmentReview: null,
    createClientMode: true, canSeeInternalPricing: true, canAdmin: true, initialSeller: null,
    initialSession: { id: 1, sedeId: 2, role: "ADMIN" }, draftId: 12,
    clienteDocumento: "DOCUMENTO-DE-PRUEBA", imeiDigits: "000000000000000",
    stepIdentityContractReady: true, firmaSeguroProcessSigned: true, equipmentImeiConfirmed: true,
    draftResumeHydrating: false, draftResumeLoadFailed: false, draftStatus: "saved", creating: false,
    completedCredit: null, firmaSeguroSubmitting: false, signedTermsCorrectionBusy: false, wizardStepTransitioning: false,
    currentDraftDocumentRef: { current: "DOCUMENTO-DE-PRUEBA" }, currentEquipmentImeiRef: { current: "000000000000000" }, currentEquipmentDraftIdRef: { current: 12 },
    setDraftStatus: value => statuses.push(value), setDraftErrorMessage: value => errors.push(value), setEnrollmentRequestBusy() {},
    saveCurrentDraft: async stepNumber => { saves.push(stepNumber); return 12; },
    dateTime: value => value, stepFourStyles: new Proxy({}, { get: (_, key) => String(key) }),
    CreditEnrollmentRequest: component("CreditEnrollmentRequest"), ShieldCheck: component("ShieldCheck"), Check: component("Check"), Clock3: component("Clock3"),
    ...overrides,
  };
  const loaded = { exports: {} };
  runInNewContext(compiled.outputText, {
    ...context, Error, module: loaded, exports: loaded.exports,
    require(name) { assert.equal(name, "react/jsx-runtime"); return { jsx, jsxs: jsx, Fragment: "Fragment" }; },
  });
  const tree = loaded.exports.default();
  return { tree, context, statuses, errors, saves, request: nodes(tree).find(node => node.type?.name === "CreditEnrollmentRequest") };
}

test("el ADMIN central ve Solicitar enrolamiento en la tarjeta 2 aunque no tenga perfil de asesor", () => {
  let result;
  assert.doesNotThrow(() => { result = render(); });
  assert.equal(result.tree.type, "article");
  assert.equal(result.request.props.mode, "attention");
  assert.equal(result.request.props.draftId, 12);
  assert.equal(result.request.props.ready, true);
  assert.equal(result.request.props.disabled, false);
});

test("el asesor nominal conserva la solicitud por su API comercial", () => {
  const result = render({ canSeeInternalPricing: false, canAdmin: false, initialSeller: { id: 7 } });
  assert.equal(result.request.props.mode, "seller");
  assert.equal(result.request.props.draftId, 12);
});

test("el administrador aliado y un usuario sin perfil nominal no reciben el CTA central", () => {
  assert.equal(render({ canSeeInternalPricing: false, canAdmin: true, initialSeller: { id: 7 } }).request, undefined);
  assert.equal(render({ canSeeInternalPricing: false, canAdmin: false, initialSeller: null }).request, undefined);
});

test("el CTA no aparece fuera de creación de cliente ni de Enrolamiento y entrega", () => {
  assert.equal(render({ createClientMode: false }).request, undefined);
  assert.equal(render({ wizardStep: 4 }).request, undefined);
});

test("la acción guarda el mismo borrador en el paso histórico 5 antes de solicitar", async () => {
  const result = render();
  assert.equal(await result.request.props.beforeCreate(), 12);
  assert.deepEqual(result.saves, [5]);
  assert.deepEqual(result.statuses, ["saving"]);
  assert.deepEqual(result.errors, []);
});

test("el guardado previo rechaza otro borrador o cambios de cédula e IMEI", async () => {
  for (const mismatch of ["savedId", "draftRef", "documentRef", "imeiRef"]) {
    let result;
    result = render({ saveCurrentDraft: async () => {
      if (mismatch === "draftRef") result.context.currentEquipmentDraftIdRef.current = 13;
      if (mismatch === "documentRef") result.context.currentDraftDocumentRef.current = "OTRO-DOCUMENTO-DE-PRUEBA";
      if (mismatch === "imeiRef") result.context.currentEquipmentImeiRef.current = "111111111111111";
      return mismatch === "savedId" ? 13 : 12;
    } });
    await assert.rejects(result.request.props.beforeCreate(), /cambiaron durante el guardado/);
    assert.deepEqual(result.statuses, ["saving", "error"]);
    assert.equal(result.errors.length, 1);
  }
});
