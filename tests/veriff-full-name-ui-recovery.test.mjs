import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const source = await readFile(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) result = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(result, name);
  if (ts.isFunctionDeclaration(result)) return result.getText(ast);
  const initializer = result.initializer;
  return "const " + name + " = " + (ts.isCallExpression(initializer) && initializer.expression.getText(ast) === "useCallback" ? initializer.arguments[0] : initializer).getText(ast) + ";";
}
function effectContaining(marker) {
  let result;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes(marker)) result = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(result, marker); return result.getText(ast);
}
const names = ["IdentityValidationDialog", "getDataCreditoClientDisplayName", "serializeCreditDraftSaveRequest", "VeriffDraftPreparationFailure", "cancelPendingDraftAutosave", "saveDraftPayloadForVeriff", "validateIdentityWithVeriff", "refreshVeriffValidation", "applyVeriffIdentityData", "veriffApprovalCanUnlockClient", "veriffIdentityHasAutofillData", "getDataCreditoVeriffDocumentRejectionMessage"];
const declarations = names.map(declaration).join("\n");
const autosaveEffect = effectContaining("closureFingerprintAtSchedule");
const pollingEffect = effectContaining("attempts >= VERIFF_POLL_MAX_ATTEMPTS");
const fullName = "María del Mar José De la Peña Muñoz del Río";
const effective = { fullName, nameMode: "FULL_NAME_ONLY", names: "", firstSurname: "", secondSurname: "", documentNumber: "123456789", documentType: "CEDULA_DE_CIUDADANIA", missing: [] };
const approval = { documentNumber: "123456789", identity: { original: effective, effective } };
const pending = { id: 42, draftId: 2883, status: "PENDING", sessionUrl: "https://test.invalid/veriff/42", veriffSessionId: "session-42", approved: false, pending: true, decidedAt: null, identityData: null };

function fixture() {
  const requests = []; const timers = new Map(); let timerId = 0;
  const payload = { clienteNombre: fullName, clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "", clienteDocumento: "123456789", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", dataCreditoAssessmentId: "saved-assessment", clienteTelefono: "3001234567" };
  const context = { Error, AbortController, JSON, React, createPortal: children => children, X: () => null,
    factoryDraftPayload: payload, clienteNombre: fullName, clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "",
    dataCreditoApproval: approval, dataCreditoAssessmentId: "saved-assessment", dataCreditoRequiresVeriff: true,
    draftId: 2883, wizardStep: 4, createClientMode: true, simulatorMode: false, deliveryMode: false,
    mobileCaptureSession: null, veriffConfig: { configured: true }, veriffValidation: null, veriffExpectedDraftId: 2883,
    veriffInlineMessage: "", veriffPreparationError: null, veriffSubmitting: false,
    veriffRequestInFlightRef: { current: false }, veriffRefreshGenerationRef: { current: 0 }, veriffRefreshFlightRef: { current: null },
    draftSaveConflictFingerprintRef: { current: null }, draftSaveTimerRef: { current: null }, draftSaveGenerationRef: { current: 0 }, draftSaveAbortControllerRef: { current: null },
    analystDataSnapshotRef: { current: {} }, analystFinancialSnapshotRef: { current: { draftId: 2883 } }, analystEvidenceSnapshotRef: { current: {} },
    auditedIdentityCorrectionRef: { current: false }, applyingVeriffIdentityRef: { current: false },
    resumeActiveSolicitudFromConflict: () => false, replaceDraftInUrl() {}, synchronizeAnalystDraftData() {},
    dateOnly: value => value || "", normalizeVeriffGender: () => "", normalizeVeriffDocumentType: value => value,
    compareStrictIdentityDocuments: (actual, expected) => ({ ok: actual === expected }),
    veriffIdentityMatchesExpectedDocument: (actual, expected) => actual === expected,
    canAdminMoveFreelyInFactory: false, veriffMissingIdentityMessage: "Aprobada sin datos para autocompletar.", veriffRejectedMessage: "Validación rechazada.",
    VERIFF_REQUEST_TIMEOUT_MS: 15000, VERIFF_IDENTITY_CONFLICT_MESSAGE: "Conflicto de identidad", VERIFF_IDENTITY_MISSING_MESSAGE: "Falta identidad", veriffStatusLabel: validation => validation.status,
    ACTIVE_SOLICITUD_RESUME_MESSAGE: "Retomando solicitud", DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
    draftResumeHydrationRef: { current: false }, dataCreditoFinancialTermsRecovery: false, draftResumeHydrating: false, draftResumeLoadFailed: false,
    firmaSeguroDraftCorrectionPending: false, firmaSeguroProcessSent: false, firmaSeguroProcessSigned: false, draftHasMeaningfulData: true,
    applyingDraftRef: { current: false }, nextFactoryStep: { id: 4 }, currentIphoneClosureFingerprint: "closure-fingerprint",
    veriffIdentityFlowEnabled: true, veriffHasFinalDecision: false, VERIFF_POLL_MAX_ATTEMPTS: 12, VERIFF_POLL_BACKOFF_MS: [4000, 6000],
    document: { hidden: false, body: { children: [], style: { overflow: "" } }, activeElement: null, addEventListener() {}, removeEventListener() {} },
    window: { setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() { return 1; }, cancelAnimationFrame() {} },
  };
  const code = declarations + "\nmodule.exports = { " + names.join(", ") + " };";
  for (const name of new Set((code + autosaveEffect).match(/\bset[A-Z]\w+/g) || [])) {
    context[name] = value => { const key = name[3].toLowerCase() + name.slice(4); context[key] = typeof value === "function" ? value(context[key]) : value; };
  }
  let transport = async (url, options) => {
    if (url === "/api/creditos/borradores") return { ok: true, status: 200, data: { item: { id: 2883, payload: JSON.parse(options.body).payload } } };
    if (url === "/api/creditos/veriff") return { ok: true, status: 200, data: { validation: pending } };
    if (url === "/api/creditos/veriff/42") return { ok: true, status: 200, data: { validation: { ...pending, status: "APPROVED", approved: true, pending: false, decidedAt: "2026-10-10T00:00:00Z", identityDocumentStatus: "match", identityDocumentNumber: "123456789", identityDataAvailable: true, identityData: { firstName: "Otro nombre", lastName: "Otro apellido", documentNumber: "123456789" } } } };
    assert.fail("Unexpected request: " + url);
  };
  context.requestJson = async (url, options = {}) => { requests.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null }); return transport(url, options); };
  const vmContext = { ...context, module: { exports: {} }, require: name => { assert.equal(name, "react/jsx-runtime"); return jsxRuntime; } };
  vmContext.exports = vmContext.module.exports;
  for (const name of new Set((code + autosaveEffect).match(/\bset[A-Z]\w+/g) || [])) vmContext[name] = value => { const key = name[3].toLowerCase() + name.slice(4); vmContext[key] = typeof value === "function" ? value(vmContext[key]) : value; };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, vmContext);
  const functions = vmContext.module.exports;
  vmContext.refreshVeriffValidationRef = { current: functions.refreshVeriffValidation };
  function mount(effect) { return runInNewContext(ts.transpileModule("(" + effect + ")()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, vmContext); }
  return { context: vmContext, functions, requests, timers, mount, evaluate(name) { return runInNewContext(ts.transpileModule("(() => {" + declaration(name) + "\nreturn " + name + ";})()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, vmContext); }, setTransport(value) { transport = value; } };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

test("full provider name saves before Veriff and polling preserves it without creating another session", async () => {
  const f = fixture();
  await f.functions.validateIdentityWithVeriff();
  assert.deepEqual(f.requests.map(item => item.url), ["/api/creditos/borradores", "/api/creditos/veriff", "/api/creditos/borradores"]);
  assert.equal(f.requests[0].body.payload.clienteNombre, fullName);
  assert.equal(f.requests[0].body.payload.clientePrimerNombre, ""); assert.equal(f.requests[0].body.payload.clientePrimerApellido, "");
  assert.equal(f.requests[1].body.draftId, 2883); assert.equal(f.requests[2].body.payload.veriffValidationId, 42);
  assert.equal(f.context.veriffPreparationError, null);
  const cleanup = f.mount(pollingEffect);
  const [timer, poll] = [...f.timers][0]; f.timers.delete(timer); await poll.callback();
  assert.equal(f.requests.at(-1).url, "/api/creditos/veriff/42");
  assert.equal(f.context.veriffValidation.approved, true);
  assert.equal(f.context.clienteNombre, fullName); assert.equal(f.context.clientePrimerNombre, ""); assert.equal(f.context.clientePrimerApellido, "");
  assert.equal(f.requests.filter(item => item.url === "/api/creditos/veriff").length, 1);
  assert.equal(f.requests.some(item => item.url.includes("datacredito")), false);
  cleanup(); assert.equal(f.timers.size, 0);
});

test("a draft409 is a save failure with the actual message and no Veriff session or query", async () => {
  const f = fixture(); const message = "La identidad de esta solicitud requiere revisión.";
  f.setTransport(async () => ({ ok: false, status: 409, data: { code: "SOLICITUD_IDENTIDAD_INMUTABLE", error: message } }));
  await f.functions.validateIdentityWithVeriff();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, "/api/creditos/borradores");
  assert.equal(f.context.veriffPreparationError, message); assert.equal(f.context.veriffInlineMessage, "");
  assert.equal(f.context.draftStatus, "error"); assert.equal(f.context.draftErrorMessage, message);
  const html = renderToStaticMarkup(React.createElement(f.functions.VeriffDraftPreparationFailure, { message, onRetry() {}, onBack() {} }));
  assert.ok(html.includes(message)); assert.ok(html.includes("Reintentar guardado"));
  assert.ok(!html.includes("Conexion interrumpida")); assert.ok(!html.includes("Regenerar QR"));
  f.mount(autosaveEffect); assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, 1);
});

test("autosave does not retry an unchanged409 but a changed payload, step, scope or manual save can retry", async () => {
  const f = fixture();
  f.setTransport(async () => ({ ok: false, status: 409, data: { error: "Conflicto de guardado" } }));
  const rejected = f.functions.serializeCreditDraftSaveRequest({ draftId: 2883, currentStep: 4, payload: f.context.factoryDraftPayload });
  f.context.draftSaveConflictFingerprintRef.current = rejected;
  f.mount(autosaveEffect); assert.equal(f.timers.size, 0);
  f.context.factoryDraftPayload = { ...f.context.factoryDraftPayload, clienteTelefono: "3011234567" };
  f.mount(autosaveEffect); assert.equal(f.timers.size, 1);
  const [id, timer] = [...f.timers][0]; f.timers.delete(id); timer.callback(); await flush();
  assert.equal(f.requests.length, 1); assert.equal(f.context.draftStatus, "error");
  f.mount(autosaveEffect); assert.equal(f.timers.size, 0);
  assert.notEqual(f.functions.serializeCreditDraftSaveRequest({ draftId: 2883, currentStep: 5, payload: f.context.factoryDraftPayload }), f.context.draftSaveConflictFingerprintRef.current);
  assert.notEqual(f.functions.serializeCreditDraftSaveRequest({ draftId: 2883, currentStep: 4, payloadScope: "DELIVERY_EVIDENCE", payload: f.context.factoryDraftPayload }), f.context.draftSaveConflictFingerprintRef.current);
  f.setTransport(async (_url, options) => ({ ok: true, status: 200, data: { item: { id: 2883, payload: JSON.parse(options.body).payload } } }));
  await f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 4, 2883);
  assert.equal(f.requests.length, 2); assert.equal(f.context.draftSaveConflictFingerprintRef.current, null);
});


test("document-only trusted approval unlocks the same draft and cedula without name autofill", () => {
  const f = fixture();
  const validation = { ...pending, approved: true, trusted: true, decidedAt: "2026-10-10T00:00:00Z", identityData: null,
    identityDataAvailable: false, identityDocumentStatus: "match", identityDocumentNumber: "123456789" };
  assert.equal(f.functions.veriffApprovalCanUnlockClient(validation, 2883, "123456789"), true);
  for (const invalid of [ { ...validation, trusted: false }, { ...validation, draftId: 9999 },
    { ...validation, identityDocumentNumber: "987654321" }, { ...validation, approved: false },
    { ...validation, decidedAt: null }, { ...validation, identityDocumentStatus: "missing" } ]) {
    assert.equal(f.functions.veriffApprovalCanUnlockClient(invalid, 2883, "123456789"), false);
  }
});

test("save and connection errors expose the actual dialog close button and Escape without making requests", () => {
  const f = fixture();
  f.context.veriffApproved = false; f.context.veriffHasFinalDecision = false; f.context.veriffConnectionError = false;
  assert.equal(f.evaluate("identityValidationLocked"), true);
  f.context.veriffPreparationError = "Revisa la solicitud.";
  assert.equal(f.evaluate("identityValidationLocked"), false);
  f.context.veriffPreparationError = null; f.context.veriffConnectionError = true;
  assert.equal(f.evaluate("identityValidationLocked"), false);
  const effects = []; const listeners = new Map(); let closed = 0;
  f.context.useRef = value => ({ current: value }); f.context.useEffect = callback => effects.push(callback);
  f.context.document.addEventListener = (name, callback) => listeners.set(name, callback);
  f.context.document.removeEventListener = name => listeners.delete(name);
  const element = f.functions.IdentityValidationDialog({ open: true, dismissible: !f.evaluate("identityValidationLocked"), onClose: () => closed++, children: "Error recuperable" });
  function find(node) {
    if (!node || typeof node !== "object") return null;
    if (node.props?.["aria-label"] === "Cerrar ventana de validacion") return node;
    return React.Children.toArray(node.props?.children).map(find).find(Boolean);
  }
  assert.ok(find(element)); find(element).props.onClick(); assert.equal(closed, 1);
  effects[0](); const cleanup = effects[1]();
  listeners.get("keydown")({ key: "Escape", preventDefault() {} }); assert.equal(closed, 2);
  cleanup(); assert.equal(f.requests.length, 0);
});
