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
let imeiInvalidationEffect;
let signatureFailureBoundary;
function findAutosave(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("closureFingerprintAtSchedule")) autosaveEffect = node.arguments[0].getText(ast);
  if (ts.isCallExpression(node) && node.expression.getText(ast) === "useEffect" && node.arguments[0]?.getText(ast).includes("binding.draftId !== draftId || binding.imei !== imeiDigits")) imeiInvalidationEffect = node.arguments[0].getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "handleFirmaSeguroStepReady") {
    const boundary = node.initializer.body.statements.find(ts.isTryStatement);
    assert.ok(boundary?.catchClause && boundary.finallyBlock);
    signatureFailureBoundary = `async () => { try { await submitFirmaSeguroDraft(2887); } ${boundary.catchClause.getText(ast)} finally ${boundary.finallyBlock.getText(ast)} }`;
  }
  ts.forEachChild(node, findAutosave);
}
findAutosave(ast); assert.ok(autosaveEffect);
assert.ok(imeiInvalidationEffect);
assert.ok(signatureFailureBoundary);
const names = ["serializeCreditDraftSaveRequest", "formatCreditDraftSaveError", "cancelPendingDraftAutosave", "updateEquipmentImeiConfirmation", "synchronizeEquipmentImeiConfirmation", "resolvePersistedDraftStep", "recoverEquipmentImeiConfirmation", "saveDraftPayloadForVeriff", "saveCurrentDraft", "clampWizardStep", "persistWizardStep", "goToStep", "advanceToStep", "requestEquipmentImeiConfirmation", "confirmEquipmentImei", "submitFirmaSeguroDraft"];
const code = names.map(declaration).join("\n") + "\nconst submitWithActualSignatureFailureBoundary = " + signatureFailureBoundary + ";\nmodule.exports = { " + names.join(", ") + ", submitWithActualSignatureFailureBoundary };";
function fixture(overrides = {}) {
  const requests = []; const timers = new Map(); let nextTimer = 0;
  const payload = { clienteNombre: "WILMER GIOVANNY DÍAZ RUBIO", clientePrimerNombre: "", clientePrimerApellido: "", clienteSegundoApellido: "", clienteDocumento: "1110477922", clienteTipoDocumento: "CEDULA_DE_CIUDADANIA", clienteTelefono: "3001234567", clienteCorreo: "cliente@example.invalid", dataCreditoAssessmentId: "approved-test", wizardStep: 1 };
  const context = {
    Error, AbortController, JSON, draftId: 2887, wizardStep: 1, createClientMode: true, simulatorMode: false, deliveryMode: false,
    factoryDraftPayload: payload, currentIphoneClosureFingerprint: "closure", canAdminMoveFreelyInFactory: false, nextFactoryStep: { id: 2 },
    draftSaveConflictFingerprintRef: { current: null }, draftSaveTimerRef: { current: null }, draftSaveGenerationRef: { current: 0 }, draftExplicitSaveGenerationRef: { current: 0 }, draftSaveAbortControllerRef: { current: null },
    wizardStepTransitionInFlightRef: { current: false }, wizardStepTransitioning: false, activeSolicitudRedirectingRef: { current: false },
    draftResumeHydrationRef: { current: false }, draftResumeHydrating: false, draftResumeLoadFailed: false, applyingDraftRef: { current: false },
    firmaSeguroDraftCorrectionPending: false, firmaSeguroProcessSent: false, firmaSeguroProcessSigned: false, signedContractEditLocked: false, advisorSignedContractStep: 5,
    preflightNotice: null, firmaSeguroRequestInFlightRef: { current: false }, firmaSeguroSubmitting: false,
    analystDataSnapshotRef: { current: {} }, analystFinancialSnapshotRef: { current: { draftId: 2887 } }, analystEvidenceSnapshotRef: { current: {} },
    replaceDraftInUrl() {}, synchronizeAnalystDraftData() {}, resumeActiveSolicitudFromConflict: () => false,
    ACTIVE_SOLICITUD_RESUME_MESSAGE: "Retomando solicitud", DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
    dataCreditoVeriffDocumentRejected: false, stepEquipoReady: true, iphoneInstallmentLimitExceeded: false, FLEXIBLE_WIZARD_FOR_TESTING: false,
    contactPhoneValidation: { ok: true }, stepClienteReady: true, hideIdentityWizardStep: true, stepContratoReady: true, stepIdentityContractReady: true,
    identityStepReady: true, veriffRequired: true, veriffApproved: true, contractEvidenceReady: true, pagareAceptado: true,
    nextVisibleWizardStep: step => ({ 1: 2, 2: 4, 4: 5, 5: 5 }[step]), focusFirstInvalidClientField() {},
    dataCreditoFinancialTermsRecovery: false, draftHasMeaningfulData: true,
    stepTwoComplete: true, imeiConfirmationOpeningRef: { current: false }, imeiConfirmationInFlightRef: { current: false },
    currentEquipmentDraftIdRef: { current: 2887 }, currentEquipmentImeiRef: { current: "035809100123456" }, imeiConfirmationTargetStep: null,
    currentDraftDocumentRef: { current: JSON.stringify(["CEDULA_DE_CIUDADANIA", "1110477922"]) },
    imeiDigits: "035809100123456", equipmentImeiConfirmation: { draftId: 2887, imei: "035809100123456" },
    equipmentImeiConfirmationRef: { current: { draftId: 2887, imei: "035809100123456" } },
    window: { setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } },
    ...overrides,
  };
  let transport = async (_url, options) => ({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } });
  context.requestJson = async (url, options) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null, signal: options.signal });
    if (url === "/api/creditos/borradores/2887/confirmar-imei") return { ok: true, data: { ok: true, confirmation: { imei: JSON.parse(options.body).imei } } };
    if (url === "/api/creditos/borradores/2887/firma-seguro") return transport(url, options);
    assert.equal(url, "/api/creditos/borradores", "Navigation only saves the draft or its explicit IMEI confirmation");
    return transport(url, options);
  };
  for (const name of new Set((code + autosaveEffect).match(/\bset[A-Z]\w+/g) || [])) context[name] = value => {
    const key = name[3].toLowerCase() + name.slice(4); context[key] = typeof value === "function" ? value(context[key]) : value;
  };
  context.module = { exports: {} };
  runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, requests, timers, functions: context.module.exports, setTransport(value) { transport = value; }, mountAutosave() {
    return runInNewContext(ts.transpileModule("(" + autosaveEffect + ")()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  }, invalidateImei() {
    return runInNewContext(ts.transpileModule("(" + imeiInvalidationEffect + ")()", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
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
  for (const [from, to, action] of [[2, 1, "advanceToStep"], [4, 2, "goToStep"], [4, 5, "advanceToStep"]]) {
    const f = fixture({ wizardStep: from, firmaSeguroProcessSigned: from === 4 && to === 5 });
    await f.functions[action](to);
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.currentStep, to); assert.equal(f.requests[0].body.payload.wizardStep, to);
    assert.equal(f.requests[0].body.payloadScope, from === 4 && to === 5 ? "DELIVERY_EVIDENCE" : "FULL");
    assert.equal(f.context.wizardStep, to);
  }
  assert.match(source, /onClick=\{\(\) => void advanceToStep\(previousVisibleWizardStep\(wizardStep\)\)\}/);
});

test("Equipo guarda sus datos sin avanzar y exige confirmación explícita del IMEI", async () => {
  for (const action of ["advanceToStep", "goToStep"]) {
    const f = fixture({ wizardStep: 2 });
    await f.functions[action](4);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].body.currentStep, 2);
    assert.equal(f.context.wizardStep, 2);
    assert.equal(f.context.imeiConfirmationTargetStep, 4);
    await f.functions.confirmEquipmentImei("035809100123456");
    assert.equal(f.requests[1].url, "/api/creditos/borradores/2887/confirmar-imei");
    assert.equal(f.requests[1].body.imei, "035809100123456");
    assert.equal(f.requests[2].body.currentStep, 4);
    assert.equal(f.context.wizardStep, 4);
  }
});

test("el autosave central en Equipo completo no adelanta el paso ni exige confirmar sin pulsar Continuar", async () => {
  const f = fixture({ canAdminMoveFreelyInFactory: true, wizardStep: 2, nextFactoryStep: { id: 4 }, equipmentImeiConfirmationRef: { current: null } });
  f.setTransport(async (_url, options) => {
    const body = JSON.parse(options.body);
    return body.currentStep >= 3
      ? { ok: false, status: 409, data: { code: "IMEI_CONFIRMATION_REQUIRED", error: "Confirma el IMEI" } }
      : { ok: true, status: 200, data: { item: { id: 2887, payload: body.payload } } };
  });
  f.mountAutosave();
  assert.equal(f.timers.size, 1);
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.currentStep, 2);
  assert.equal(f.requests[0].body.payload.wizardStep, 2);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.draftStatus, "saved");
  assert.equal(f.context.draftErrorMessage, "");
  assert.equal(f.context.imeiConfirmationTargetStep, null);

  await Promise.all([f.functions.advanceToStep(4), f.functions.advanceToStep(4)]);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.imeiConfirmationTargetStep, 4);
  assert.equal(f.requests.length, 2, "Explicit Continue saves Equipo once before opening confirmation");
  assert.equal(f.requests[1].body.currentStep, 2);
  f.setTransport(async (_url, options) => ({ ok: true, status: 200,
    data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }));
  await Promise.all([
    f.functions.confirmEquipmentImei("035809100123456"),
    f.functions.confirmEquipmentImei("035809100123456"),
  ]);
  assert.equal(f.requests.filter(request => request.url.endsWith("/confirmar-imei")).length, 1);
  assert.equal(f.requests.filter(request => request.body.currentStep === 4).length, 1);
  assert.equal(f.context.wizardStep, 4);
});

test("inspeccionar Identidad sin IMEI confirmado guarda Equipo y no genera avisos ni consultas externas", async () => {
  const f = fixture({ canAdminMoveFreelyInFactory: true, wizardStep: 4, nextFactoryStep: { id: 4 },
    equipmentImeiConfirmationRef: { current: null }, equipmentImeiConfirmation: null });
  f.functions.synchronizeEquipmentImeiConfirmation({ id: 2887, imei: "035809100123456",
    payload: { imeiConfirmationRequired: true } });
  f.setTransport(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.currentStep, 2, "Inspection cannot persist an unconfirmed identity step");
    return { ok: true, status: 200, data: { item: { id: 2887, imei: "035809100123456",
      payload: { ...body.payload, imeiConfirmationRequired: true } } } };
  });
  f.mountAutosave();
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.draftStatus, "saved");
  assert.equal(f.context.draftErrorMessage, "");
  assert.equal(f.context.notice, undefined);
  assert.equal(f.context.imeiConfirmationTargetStep, null);
  await f.functions.saveCurrentDraft();
  assert.equal(f.requests[1].body.currentStep, 2);
  await assert.rejects(f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 4),
    error => error.code === "IMEI_CONFIRMATION_REQUIRED" && !error.message.includes("IMEI_CONFIRMATION_REQUIRED"));
  assert.equal(f.requests.length, 2, "Identity cannot attempt a provider call or forward save without confirmation");
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.draftErrorMessage, "");
  assert.doesNotMatch(f.context.notice.text, /IMEI_CONFIRMATION_REQUIRED|Código:/);
});

test("un rechazo autoritativo de confirmación vuelve a Equipo sin repetir consultas ni perder datos", async () => {
  const f = fixture({ wizardStep: 4, canAdminMoveFreelyInFactory: true, nextFactoryStep: { id: 4 },
    identityValidationModalOpen: true });
  const originalPayload = JSON.stringify(f.context.factoryDraftPayload);
  f.setTransport(async () => ({ ok: false, status: 409,
    data: { code: "IMEI_CONFIRMATION_REQUIRED", error: "Confirma nuevamente los 15 dígitos del IMEI en Equipo y plan antes de continuar." } }));
  f.mountAutosave();
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.currentStep, 4);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.identityValidationModalOpen, false);
  assert.equal(f.context.equipmentImeiConfirmationRef.current, null);
  assert.equal(f.context.draftErrorMessage, "");
  assert.equal(f.context.draftStatus, "idle");
  assert.equal(f.context.notice.tone, "amber");
  assert.match(f.context.notice.text, /Equipo y plan.*Continuar/);
  assert.doesNotMatch(f.context.notice.text, /IMEI_CONFIRMATION_REQUIRED|Código:/);
  assert.equal(JSON.stringify(f.context.factoryDraftPayload), originalPayload);
  assert.equal(f.context.imeiConfirmationTargetStep, null);
  f.setTransport(async (_url, options) => ({ ok: true, status: 200,
    data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }));
  await f.functions.advanceToStep(4);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.imeiConfirmationTargetStep, 4);
  assert.equal(f.requests.filter(request => request.url.endsWith("/confirmar-imei")).length, 0);
  await f.functions.confirmEquipmentImei("035809100123456");
  assert.equal(f.context.wizardStep, 4);
  assert.equal(f.context.notice, null);
  assert.equal(f.requests.filter(request => request.url.endsWith("/confirmar-imei")).length, 1);
});

test("la confirmación restaurada sólo habilita guardar la solicitud y el IMEI a los que pertenece", async () => {
  const f = fixture({ wizardStep: 4 });
  for (const saved of [
    { id: 9999, imei: "035809100123456", payload: { imeiConfirmationRequired: false } },
    { id: 2887, imei: "035809100123457", payload: { imeiConfirmationRequired: false } },
    { id: 2887, imei: "035809100123456", payload: { imeiConfirmationRequired: true } },
  ]) {
    f.functions.synchronizeEquipmentImeiConfirmation(saved);
    await f.functions.saveCurrentDraft();
    assert.equal(f.requests.at(-1).body.currentStep, 2);
  }
  f.functions.synchronizeEquipmentImeiConfirmation({ id: 2887, imei: "035809100123456",
    payload: { imeiConfirmationRequired: false } });
  await f.functions.saveCurrentDraft();
  assert.equal(f.requests.at(-1).body.currentStep, 4);
  assert.equal(f.requests.filter(request => request.url.endsWith("/confirmar-imei")).length, 0);
});

test("cambiar el IMEI invalida la confirmación incluso si luego se vuelve a escribir el número anterior", () => {
  const f = fixture();
  assert.equal(f.functions.resolvePersistedDraftStep(4), 4);
  f.context.imeiDigits = "035809100123457";
  f.invalidateImei();
  assert.equal(f.context.equipmentImeiConfirmationRef.current, null);
  assert.equal(f.functions.resolvePersistedDraftStep(4), 2);
  f.context.imeiDigits = "035809100123456";
  f.invalidateImei();
  assert.equal(f.functions.resolvePersistedDraftStep(4), 2);
  assert.equal(f.requests.length, 0);
});

test("FirmaSeguro conserva el guard IMEI y devuelve a Equipo sin exponer códigos internos", async () => {
  const f = fixture({ wizardStep: 4, equipmentImeiConfirmationRef: { current: null } });
  const required = error => error.code === "IMEI_CONFIRMATION_REQUIRED" && !error.message.includes("IMEI_CONFIRMATION_REQUIRED");
  await assert.rejects(f.functions.submitFirmaSeguroDraft(2887), required);
  assert.equal(f.requests.length, 0, "No signature dispatch without the explicit IMEI confirmation");
  assert.equal(f.context.wizardStep, 2);
  f.context.wizardStep = 4;
  f.functions.updateEquipmentImeiConfirmation({ draftId: 2887, imei: "035809100123456" });
  f.setTransport(async () => ({ ok: false, status: 409,
    data: { code: "IMEI_CONFIRMATION_REQUIRED", error: "Confirma el IMEI" } }));
  await assert.rejects(f.functions.submitFirmaSeguroDraft(2887), required);
  assert.equal(f.requests.length, 1);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.draftErrorMessage, "");
  assert.doesNotMatch(f.context.notice.text, /IMEI_CONFIRMATION_REQUIRED|Código:/);
});

test("el catch real de envío conserva la recuperación IMEI y siempre libera el bloqueo en finally", async () => {
  for (const confirmed of [false, true]) {
    const f = fixture({ wizardStep: 4, firmaSeguroSubmitting: true,
      firmaSeguroRequestInFlightRef: { current: true },
      equipmentImeiConfirmationRef: { current: confirmed ? { draftId: 2887, imei: "035809100123456" } : null } });
    f.setTransport(async () => ({ ok: false, status: 409,
      data: { code: "IMEI_CONFIRMATION_REQUIRED", error: "Confirma el IMEI" } }));
    // Execute the production submit handler inside its actual outer catch and
    // finally, isolating unrelated signature preflight and success rendering.
    await f.functions.submitWithActualSignatureFailureBoundary();
    assert.equal(f.requests.length, confirmed ? 1 : 0);
    assert.equal(f.context.wizardStep, 2);
    assert.equal(f.context.draftStatus, "idle");
    assert.equal(f.context.draftErrorMessage, "");
    assert.equal(f.context.notice.tone, "amber");
    assert.match(f.context.notice.text, /Equipo y plan.*Continuar/);
    assert.doesNotMatch(f.context.notice.text, /No se pudo enviar|IMEI_CONFIRMATION_REQUIRED|Código:/);
    assert.equal(f.context.firmaSeguroRequestInFlightRef.current, false);
    assert.equal(f.context.firmaSeguroSubmitting, false);
  }
});

test("el autosave de Equipo conserva un IMEI de 14 dígitos como borrador sin abrir la confirmación", async () => {
  const f = fixture({ canAdminMoveFreelyInFactory: true, wizardStep: 2,
    nextFactoryStep: { id: 2 }, stepEquipoReady: false });
  f.context.factoryDraftPayload = { ...f.context.factoryDraftPayload,
    imei: "03580910012345", deviceUid: "03580910012345" };
  f.mountAutosave();
  const [timerId, timer] = [...f.timers][0]; f.timers.delete(timerId); timer.callback(); await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.currentStep, 2);
  assert.equal(f.requests[0].body.payload.imei, "03580910012345");
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.draftStatus, "saved");
  assert.equal(f.context.imeiConfirmationTargetStep, null);
  await f.functions.advanceToStep(4);
  assert.equal(f.requests.length, 1, "Incomplete Equipo still cannot advance");
  assert.equal(f.context.imeiConfirmationTargetStep, null);
  assert.equal(f.context.wizardStep, 2);
});

test("la corrección reconfirma el IMEI sin reconstruir términos históricos ni habilitar Entrega", async () => {
  const f = fixture({ wizardStep: 2, firmaSeguroDraftCorrectionPending: true, canAdminMoveFreelyInFactory: true, nextFactoryStep: { id: 5 }, stepTwoComplete: false, stepEquipoReady: false });
  assert.equal(await f.functions.persistWizardStep(5), false);
  assert.equal(f.requests.length, 0);
  await f.functions.advanceToStep(4);
  assert.equal(f.context.wizardStep, 2);
  assert.equal(f.context.imeiConfirmationTargetStep, 4);
  assert.equal(f.requests.length, 0, "no aplica política actual al contrato congelado");
  await f.functions.confirmEquipmentImei("035809100123456");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, "/api/creditos/borradores/2887/confirmar-imei");
  assert.equal(f.context.wizardStep, 4);
  assert.equal(await f.functions.persistWizardStep(5), false);
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
  f.functions.cancelPendingDraftAutosave(true); f.context.draftId = 9999;
  f.context.currentEquipmentDraftIdRef.current = 9999;
  finish(); await pending;
  assert.equal(f.context.draftId, 9999); assert.equal(f.context.wizardStep, 1);
  assert.match(f.context.draftErrorMessage, /solicitud cambió/);
});

test("un guardado pendiente conserva el aislamiento de solicitud, documento, IMEI y correcciones", async () => {
  const changes = [
    ["solicitud", context => { context.currentEquipmentDraftIdRef.current = 9999; context.draftId = 9999; }],
    ["documento", context => { context.currentDraftDocumentRef.current = JSON.stringify(["CEDULA_DE_CIUDADANIA", "99990000"]); }],
    ["IMEI", context => { context.currentEquipmentImeiRef.current = "035809100123457"; }],
    ["datos del analista", context => { context.analystDataSnapshotRef.current = { draftId: 2887, revision: 1 }; }],
    ["plan del analista", context => { context.analystFinancialSnapshotRef.current = { draftId: 2887, revision: 1 }; }],
    ["evidencias del analista", context => { context.analystEvidenceSnapshotRef.current = { draftId: 2887, revision: 1 }; }],
  ];
  for (const [label, change] of changes) {
    const f = fixture(); let finish;
    f.setTransport((_url, options) => new Promise(resolve => {
      finish = () => resolve({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } });
    }));
    const saving = f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 1, 2887);
    const rejected = assert.rejects(saving, /solicitud cambió/, label);
    change(f.context);
    finish(); await rejected;
    assert.notEqual(f.context.draftStatus, "saved", label);
    assert.equal(f.context.draftId, label === "solicitud" ? 9999 : 2887, label);
    assert.equal(f.requests.length, 1, label);
  }
});

test("un guardado anterior no reemplaza otro guardado explícito ni acepta un ID de respuesta distinto", async () => {
  const f = fixture(); const completions = [];
  f.setTransport((_url, options) => new Promise(resolve => {
    completions.push(() => resolve({ ok: true, status: 200, data: { item: { id: 2887, payload: JSON.parse(options.body).payload } } }));
  }));
  const previous = f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 1, 2887);
  const rejected = assert.rejects(previous, /solicitud cambió/);
  const current = f.functions.saveDraftPayloadForVeriff({ ...f.context.factoryDraftPayload, clienteTelefono: "3011234567" }, 1, 2887);
  completions[1]();
  assert.equal((await current).payload.clienteTelefono, "3011234567");
  completions[0](); await rejected;
  assert.equal(f.context.draftStatus, "saved");
  f.setTransport(async () => ({ ok: true, status: 200, data: { item: { id: 9999, payload: f.context.factoryDraftPayload } } }));
  await assert.rejects(f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 1, 2887), /solicitud cambió/);
  assert.equal(f.context.draftId, 2887);
});

test("crear un borrador mantiene su vinculación antes de un segundo guardado explícito", async () => {
  const f = fixture({ draftId: null, currentEquipmentDraftIdRef: { current: null } });
  const created = await f.functions.saveDraftPayloadForVeriff(f.context.factoryDraftPayload, 1, null);
  assert.equal(created.id, 2887);
  assert.equal(f.context.currentEquipmentDraftIdRef.current, 2887);
  const saved = await f.functions.saveDraftPayloadForVeriff({ ...created.payload, clienteTelefono: "3011234567" }, 2, created.id);
  assert.equal(saved.id, created.id);
  assert.equal(f.requests[0].body.id, null);
  assert.equal(f.requests[1].body.id, 2887);
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
