import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(name) {
  let found;
  function visit(node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(found, name);
  if (ts.isFunctionDeclaration(found)) return found.getText(ast);
  const value = found.initializer;
  return "const " + name + " = " + (ts.isCallExpression(value) && value.expression.getText(ast) === "useCallback" ? value.arguments[0] : value).getText(ast) + ";";
}
let autosaveEffect;
function findAutosave(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("closureFingerprintAtSchedule")) autosaveEffect = node.arguments[0].getText(ast);
  ts.forEachChild(node, findAutosave);
}
findAutosave(ast); assert.ok(autosaveEffect);
const names = ["serializeCreditDraftSaveRequest", "formatCreditDraftSaveError", "cancelPendingDraftAutosave", "saveDraftPayloadForVeriff", "saveCurrentDraft", "clampWizardStep", "persistWizardStep", "goToStep", "advanceToStep"];
const code = names.map(declaration).join("\n") + "\nmodule.exports = { " + names.join(", ") + " };";
function fixture(overrides = {}) {
  const requests = []; const timers = new Map(); let nextTimer = 0;
  const payload = { clienteNombre: "WILMER GIOVANNY DÍAZ RUBIO", clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "", clienteDocumento: "1110477922", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", clienteTelefono: "3001234567", clienteCorreo: "cliente@example.invalid", dataCreditoAssessmentId: "approved-test", wizardStep: 1 };
  const context = {
    Error, AbortController, JSON, draftId: 2887, wizardStep: 1, createClientMode: true, simulatorMode: false, deliveryMode: false,
    factoryDraftPayload: payload, currentIphoneClosureFingerprint: "closure", canAdminMoveFreelyInFactory: false, nextFactoryStep: { id: 2 },
    draftSaveConflictFingerprintRef: { current: null }, draftSaveTimerRef: { current: null }, draftSaveGenerationRef: { current: 0 }, draftSaveAbortControllerRef: { current: null },
    wizardStepTransitionInFlightRef: { current: false }, wizardStepTransitioning: false, activeSolicitudRedirectingRef: { current: false },
    draftResumeHydrationRef: { current: false }, draftResumeHydrating: false, draftResumeLoadFailed: false, applyingDraftRef: { current: false },
    firmaSeguroDraftCorrectionPending: false, firmaSeguroProcessSent: false, firmaSeguroProcessSigned: false, signedContractEditLocked: false, advisorSignedContractStep: 5,
    analystDataSnapshotRef: { current: {} }, analystFinancialSnapshotRef: { current: { draftId: 2887 } }, analystEvidenceSnapshotRef: { current: {} },
    replaceDraftInUrl() {}, synchronizeAnalystDraftData() {}, resumeActiveSolicitudFromConflict: () => false,
    ACTIVE_SOLICITUD_RESUME_MESSAGE: "Retomando solicitud", DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
    dataCreditoVeriffDocumentRejected: false, stepEquipoReady: true, iphoneInstallmentLimitExceeded: false, FLEXIBLE_WIZARD_FOR_TESTING: false,
    contactPhoneValidation: { ok: true }, stepClienteReady: true, hideIdentityWizardStep: true, stepContratoReady: true, stepIdentityContractReady: true,
    identityStepReady: true, veriffRequired: true, veriffApproved: true, contractEvidenceReady: true, pagareAceptado: true,
    nextVisibleWizardStep: step => ({ 1: 2, 2: 4, 4: 5, 5: 5 }[step]), focusFirstInvalidClientField() {},
    dataCreditoFinancialTermsRecovery: false, draftHasMeaningfulData: true,
    window: { setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    ...overrides,
  };
  let transport = async (_url, options) => ({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } });
  context.requestJson = async (url, options) => {
    assert.equal(url, "/api/creditos/borradores", "Step navigation must only save the draft");
    requests.push({ url, body: JSON.parse(options.body), signal: options.signal });
    return transport(url, options);
  };
  for (const name of new Set((code + autosaveEffect).match(/\bset[A-Z]\w+/g) || [])) context[name] = value => {
    const key = name[3].toLowerCase() + name.slice(4); context[key] = typeof value === "function" ? value(context[key]) : value;
  };
  context.module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, requests, timers, functions: context.module.exports, setTransport(value) { transport = value; }, mountAutosave() {
    return runInNewContext(ts.transpileModule("(" + autosaveEffect + ")()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  } };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("Cliente completo guarda el nombre íntegro y espera al servidor antes de pasar a Equipo", async () => {
  const f = fixture(); let finish;
  f.setTransport((_url, options) => new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }); }));
  const oldController = new AbortController(); f.context.draftSaveAbortControllerRef.current = oldController;
  f.context.draftSaveTimerRef.current = f.context.window.setTimeout(() => assert.fail("Cancelled autosave ran"), 1200);
  const pending = f.functions.advanceToStep(2);
  assert.equal(f.context.wizardStep, 1); assert.equal(f.context.wizardStepTransitioning, true);
  assert.equal(oldController.signal.aborted, true); assert.equal(f.timers.size, 0);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.currentStep, 2); assert.equal(f.requests[0].body.payload.wizardStep, 2);
  assert.equal(f.requests[0].body.payload.clienteNombre, "WILMER GIOVANNY DÍAZ RUBIO");
  assert.equal(f.requests[0].body.payload.clientePrimerNombre, ""); assert.equal(f.requests[0].body.payload.clientePrimerApellido, "");
  await f.functions.advanceToStep(2); assert.equal(f.requests.length, 1);
  finish(); await pending;
  assert.equal(f.context.wizardStep, 2); assert.equal(f.context.draftStatus, "saved"); assert.equal(f.context.wizardStepTransitioning, false);
});

test("cada avance, retroceso y navegación del stepper persiste su paso antes de mostrarlo", async () => {
  for (const [from, to, action] of [[2, 1, "advanceToStep"], [2, 4, "advanceToStep"], [4, 2, "goToStep"], [4, 5, "advanceToStep"]]) {
    const f = fixture({ wizardStep: from, firmaSeguroProcessSigned: from === 4 && to === 5 });
    await f.functions[action](to);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.currentStep, to); assert.equal(f.requests[0].body.payload.wizardStep, to);
    assert.equal(f.requests[0].body.payloadScope, from === 4 && to === 5 ? "DELIVERY_EVIDENCE" : "FULL");
    assert.equal(f.context.wizardStep, to);
  }
  assert.match(source, /onClick=\{\(\) => void advanceToStep\(previousVisibleWizardStep\(wizardStep\)\)\}/);
});

test("la inspección central guarda el avance real y conserva el paso inspeccionado sólo en pantalla", async () => {
  const f = fixture({ canAdminMoveFreelyInFactory: true, wizardStep: 1, nextFactoryStep: { id: 2 } });
  await f.functions.advanceToStep(5);
  assert.equal(f.requests[0].body.currentStep, 2); assert.equal(f.requests[0].body.payload.wizardStep, 2); assert.equal(f.context.wizardStep, 5);
});

test("un conflicto conserva el paso y los cambios y presenta el error y código reales; reintentar puede guardar", async () => {
  const f = fixture();
  f.setTransport(async () => ({ ok: false, status: 409, data: { code: "DATACREDITO_IDENTITY_INCOMPLETE", error: "Faltan datos del proveedor." } }));
  await f.functions.advanceToStep(2);
  assert.equal(f.context.wizardStep, 1); assert.equal(f.context.draftStatus, "error");
  assert.equal(f.context.draftErrorMessage, "Faltan datos del proveedor. Código: DATACREDITO_IDENTITY_INCOMPLETE.");
  assert.equal(f.context.factoryDraftPayload.clienteNombre, "WILMER GIOVANNY DÍAZ RUBIO");
  f.mountAutosave(); assert.equal(f.timers.size, 1);
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await flush();
  assert.equal(f.requests[1].body.currentStep, 1);
  f.mountAutosave(); assert.equal(f.timers.size, 0);
  f.setTransport(async (_url, options) => ({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }));
  await f.functions.advanceToStep(2);
  assert.equal(f.context.wizardStep, 2); assert.equal(f.context.draftSaveConflictFingerprintRef.current, null);
  assert.equal(f.functions.formatCreditDraftSaveError({ error: "Error", code: "123456789 <script>" }), "Error");
});

test("restauración, firma enviada y contrato firmado conservan sus bloqueos sin escribir", async () => {
  for (const overrides of [ { draftResumeHydrationRef: { current: true } }, { draftResumeLoadFailed: true }, { firmaSeguroDraftCorrectionPending: true }, { firmaSeguroProcessSent: true }, { signedContractEditLocked: true } ]) {
    const f = fixture({ wizardStep: 2, ...overrides });
    await f.functions.advanceToStep(1);
    assert.equal(f.requests.length, 0); assert.equal(f.context.wizardStep, 2);
  }
});

test("una respuesta anterior no cambia de solicitud o paso después de invalidar su generación", async () => {
  const f = fixture(); let finish;
  f.setTransport((_url, options) => new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }); }));
  const pending = f.functions.advanceToStep(2);
  f.functions.cancelPendingDraftAutosave(); f.context.draftId = 9999;
  finish(); await pending;
  assert.equal(f.context.draftId, 9999); assert.equal(f.context.wizardStep, 1);
  assert.match(f.context.draftErrorMessage, /solicitud cambió/);
});

test("los cambios de cliente durante el guardado se guardan al terminar sin abortar la transición", async () => {
  const f = fixture(); let finish;
  f.setTransport((_url, options) => new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }); }));
  const pending = f.functions.advanceToStep(2); const generation = f.context.draftSaveGenerationRef.current;
  f.context.factoryDraftPayload = { ...f.context.factoryDraftPayload, clienteTelefono: "3011234567", clienteDireccion: "Calle 2 # 3-4" };
  f.mountAutosave(); assert.equal(f.timers.size, 0); assert.equal(f.context.draftSaveGenerationRef.current, generation);
  finish(); await pending;
  f.setTransport(async (_url, options) => ({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }));
  const cleanup = f.mountAutosave(); const [id, timer] = [...f.timers][0]; f.timers.delete(id); timer.callback(); await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].body.currentStep, 2);
  assert.equal(f.requests[1].body.payload.clienteTelefono, "3011234567"); assert.equal(f.requests[1].body.payload.clienteDireccion, "Calle 2 # 3-4");
  assert.equal(f.context.draftStatus, "saved"); cleanup();
});
