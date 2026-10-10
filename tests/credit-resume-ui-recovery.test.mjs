import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  assert.ok(end > start, `No se encontró ${endMarker}`);
  return source.slice(start, end);
}

function autosaveBlock(source) {
  const fingerprint = source.indexOf("const closureFingerprintAtSchedule =");
  const start = source.lastIndexOf("useEffect(() => {", fingerprint);
  const end = source.indexOf("const handleDataCreditoBypass", fingerprint);
  assert.ok(fingerprint >= 0 && start >= 0 && end > fingerprint);
  return source.slice(start, end);
}

test("la expiración conserva el assessment canónico hasta que el gate la confirme", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const timer = sourceBlock(
    factory,
    "const invalidateExpiredAssessment = () => {",
    "const delay = Number.isFinite(expiresAt)"
  );
  const invalidated = sourceBlock(
    factory,
    "const handleDataCreditoAssessmentInvalidated = () => {",
    "const handleDataCreditoApproved = async"
  );

  assert.match(timer, /setDataCreditoApproval\(null\)/);
  assert.doesNotMatch(timer, /setDataCreditoAssessmentId\(null\)/);
  assert.match(invalidated, /setDataCreditoApproval\(null\)/);
  assert.doesNotMatch(invalidated, /setDataCreditoAssessmentId\(null\)/);
});

test("una reconsulta expirada no permite cambiar la identidad del borrador", async () => {
  const gate = await readProjectFile(
    "app/dashboard/creditos/datacredito-prequalification-gate.tsx"
  );

  assert.match(
    gate,
    /disabled=\{[\s\S]{0,120}isSubmitting \|\|[\s\S]{0,120}initialSolicitudId && normalizedInitialDocument/
  );
  assert.match(
    gate,
    /disabled=\{[\s\S]{0,120}isSubmitting \|\|[\s\S]{0,120}initialSolicitudId && normalizedInitialSurname/
  );
});

test("un error al cargar la solicitud reintenta el borrador y no DataCrédito", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const loadDraft = sourceBlock(
    factory,
    "const loadDraft = async () => {",
    "void loadDraft();"
  );
  const loadErrorPanel = sourceBlock(
    factory,
    "{dataCreditoDraftLoadFailed ? (",
    ") : dataCreditoDraftLoading ? ("
  );
  const autosave = autosaveBlock(factory);

  assert.match(loadDraft, /setDraftResumeLoadFailed\(false\)/);
  assert.match(loadDraft, /setDraftResumeLoadFailed\(true\)/);
  assert.match(factory, /draftLoadRetryKey, initialDraftId/);
  assert.match(loadErrorPanel, /No se pudo cargar la solicitud/);
  assert.match(loadErrorPanel, /setDraftLoadRetryKey\(\(current\) => current \+ 1\)/);
  assert.match(loadErrorPanel, /no realiza una[\s\S]*nueva consulta a DataCrédito/);
  assert.doesNotMatch(loadErrorPanel, /DatacreditoPrequalificationGate/);
  assert.match(autosave, /draftResumeLoadFailed/);
});

test("si Veriff no se restaura, conserva los pasos previos y vuelve al paso interno 4", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const restore = sourceBlock(
    factory,
    "if (restoredDraftSnapshot.veriffValidationId) {",
    "} finally {"
  );
  const retry = sourceBlock(
    factory,
    "const retryRestoredVeriffValidation = async () => {",
    "const goToStep ="
  );

  assert.match(
    restore,
    /if \(!restoredValidation\) \{[\s\S]*restoredDraftSnapshot\.wizardStep >= 4[\s\S]*\? 4[\s\S]*: restoredDraftSnapshot\.wizardStep/
  );
  assert.match(restore, /setVeriffRestoreFailure\(\{/);
  assert.match(
    restore,
    /!veriffApprovalCanUnlockClient\([\s\S]*restoredDraftSnapshot\.wizardStep >= 4[\s\S]*\? 4[\s\S]*: restoredDraftSnapshot\.wizardStep/
  );
  assert.match(
    restore,
    /dataCreditoCreditCreationMode &&[\s\S]*restoredDraftSnapshot\.wizardStep >= 4[\s\S]*setWizardStep\(4\)/
  );
  assert.doesNotMatch(restore, /setWizardStep\(1\)/);
  assert.doesNotMatch(restore, /dataCreditoRequiresVeriff/);
  assert.match(retry, /refreshVeriffValidation\(failure\.validationId/);
  assert.match(
    retry,
    /approvalRecovered[\s\S]*\? clampWizardStep\(failure\.targetStep\)[\s\S]*: clampWizardStep\(failure\.targetStep >= 4 \? 4 : failure\.targetStep\)/
  );
  assert.match(factory, /paso 3: identidad y firma/);
  assert.match(factory, /Reintentar validación facial/);
});

test("requestJson cancela esperas colgadas sin recortar cargas ni el cierre", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const requestJson = sourceBlock(
    factory,
    "type RequestJsonInit = RequestInit & {",
    "const CREDIT_CREATE_RECOVERY_DELAYS_MS"
  );
  const loadDraft = sourceBlock(
    factory,
    "const loadDraft = async () => {",
    "void loadDraft();"
  );

  assert.match(requestJson, /timeoutMs\?: number/);
  assert.match(requestJson, /new AbortController\(\)/);
  assert.match(requestJson, /callerSignal\?\.addEventListener\("abort"/);
  assert.match(requestJson, /REQUEST_JSON_UPLOAD_TIMEOUT_MS = 180_000/);
  assert.match(requestJson, /requestInit\.body instanceof FormData/);
  assert.match(requestJson, /timedOut = true;[\s\S]*requestController\.abort\(\)/);
  assert.match(loadDraft, /timeoutMs: 20_000/);
  assert.match(factory, /requestJson<CreateCreditResponse>[\s\S]*?timeoutMs: 120_000/);
});

test("la actualización Veriff es single-flight y descarta respuestas obsoletas", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const refresh = sourceBlock(
    factory,
    "const refreshVeriffValidation = (",
    "const validateIdentityWithVeriff = async"
  );

  assert.match(refresh, /activeFlight\?\.validationId === validationId/);
  assert.match(refresh, /return activeFlight\.promise/);
  assert.match(refresh, /veriffRefreshGenerationRef\.current !== refreshGeneration/);
  assert.match(refresh, /timeoutMs: VERIFF_REQUEST_TIMEOUT_MS/);
  assert.doesNotMatch(refresh, /refreshVeriffMedia\(/);
  assert.ok(
    (factory.match(/veriffRefreshGenerationRef\.current \+= 1/g) || []).length >= 6,
    "crear, limpiar o cambiar de solicitud debe invalidar cualquier respuesta pendiente"
  );
});

test("el polling Veriff tiene backoff, límite y se pausa con la pestaña oculta", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const polling = sourceBlock(
    factory,
    "const refreshVeriffValidationRef = useRef(refreshVeriffValidation);",
    "const clampWizardStep ="
  );

  assert.match(factory, /VERIFF_POLL_BACKOFF_MS = \[4_000, 6_000, 10_000, 15_000, 30_000\]/);
  assert.match(factory, /VERIFF_POLL_MAX_ATTEMPTS = 12/);
  assert.match(polling, /document\.hidden/);
  assert.match(polling, /attempts >= VERIFF_POLL_MAX_ATTEMPTS/);
  assert.match(polling, /window\.setTimeout/);
  assert.match(polling, /visibilitychange/);
  assert.doesNotMatch(polling, /window\.setInterval/);
  assert.doesNotMatch(polling, /refreshVeriffMedia\(/);
});

test("la evidencia Veriff solo se consulta para admin central y tras un estado final", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const mediaRefresh = sourceBlock(
    factory,
    "const refreshVeriffMedia = useCallback",
    "const saveDraftPayloadForVeriff"
  );

  assert.match(mediaRefresh, /if \(!canAdminMoveFreelyInFactory\)/);
  assert.match(mediaRefresh, /!veriffHasFinalDecision/);
  assert.match(mediaRefresh, /void refreshVeriffMedia\(veriffValidation\)/);
});

test("el conflicto canónico recarga una sola vez la solicitud indicada por el servidor", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const redirect = sourceBlock(
    factory,
    "const resumeActiveSolicitudFromConflict = useCallback(",
    "const clienteTipoDocumentoLabel ="
  );

  assert.match(redirect, /result\.status !== 409/);
  assert.match(
    redirect,
    /result\.data\?\.code !== ACTIVE_SOLICITUD_CONFLICT_CODE/
  );
  assert.match(redirect, /!Number\.isSafeInteger\(resumeSolicitudId\)/);
  assert.match(redirect, /resumeSolicitudId <= 0/);
  assert.match(redirect, /resumeSolicitudId === attemptedId/);
  assert.match(
    redirect,
    /if \(activeSolicitudRedirectingRef\.current\) return true;[\s\S]*activeSolicitudRedirectingRef\.current = true;/
  );
  assert.match(redirect, /cancelPendingDraftAutosave\(\)/);
  assert.match(redirect, /params\.set\("draft", String\(resumeSolicitudId\)\)/);
  assert.match(redirect, /window\.location\.replace\(/);
  assert.equal(
    (redirect.match(/window\.location\.replace\(/g) || []).length,
    1,
    "el helper debe ordenar una sola navegación aunque coincidan varios guardados"
  );
});

test("Veriff y autosave entregan el conflicto al redirect canónico y el guardado manual comparte ese flujo", async () => {
  const factory = await readProjectFile(
    "app/dashboard/creditos/credit-factory-console.tsx"
  );
  const veriffSave = sourceBlock(
    factory,
    "const saveDraftPayloadForVeriff = async (",
    "const refreshVeriffValidation = ("
  );
  const currentSave = sourceBlock(
    factory,
    "const saveCurrentDraft = async (",
    "const retryStepTwoDraftSave = async ("
  );
  const autosave = sourceBlock(
    factory,
    "const saveDraft = async () => {",
    "const handleDataCreditoBypass ="
  );
  const expectedCalls = [
    [veriffSave, "currentDraftId"],
    [autosave, "canonicalDraftId"],
  ];

  for (const [flow, attemptedId] of expectedCalls) {
    assert.equal(
      (flow.match(/resumeActiveSolicitudFromConflict\(/g) || []).length,
      1,
      `el flujo ${attemptedId} debe evaluar el redirect exactamente una vez`
    );
    assert.match(flow, /method:\s*"POST"/);
    assert.match(
      flow,
      new RegExp(
        `resumeActiveSolicitudFromConflict\\(result, ${attemptedId}\\)`
      )
    );
    assert.ok(
      flow.indexOf("resumeActiveSolicitudFromConflict(result") <
        flow.indexOf("if (!result.ok || !result.data?.item)"),
      `el flujo ${attemptedId} debe redirigir antes de convertir el 409 en error genérico`
    );
  }

  assert.equal(
    (factory.match(/if \(resumeActiveSolicitudFromConflict\(result,/g) || [])
      .length,
    2,
    "solo el helper compartido y el autosave deben iniciar la retoma canónica"
  );
  assert.match(
    autosave,
    /resumeActiveSolicitudFromConflict\(result, canonicalDraftId\)[\s\S]{0,80}return;/
  );
  assert.doesNotMatch(currentSave, /requestJson|resumeActiveSolicitudFromConflict/);
  const calls = [];
  const persisted = [];
  let fail = false;
  const loaded = { exports: {} };
  const payload = { clienteDocumento: "123456789" };
  runInNewContext(ts.transpileModule(currentSave + "\nmodule.exports = saveCurrentDraft;", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module: loaded, currentIphoneClosureFingerprint: "current-closure",
    canAdminMoveFreelyInFactory: false, nextFactoryStep: { id: 2 }, wizardStep: 4,
    factoryDraftPayload: payload, draftId: 91, firmaSeguroProcessSigned: true,
    setPersistedIphoneClosureFingerprint: (value) => persisted.push(value),
    saveDraftPayloadForVeriff: async (...args) => {
      calls.push(args);
      if (fail) throw new Error("ACTIVE_SOLICITUD_RESUME");
      return { id: 91 };
    },
  });
  assert.equal(await loaded.exports(5), 91);
  assert.equal(calls[0][0], payload);
  assert.deepEqual(calls[0].slice(1), [5, 91, "DELIVERY_EVIDENCE", undefined]);
  assert.deepEqual(persisted, ["current-closure"]);
  fail = true;
  await assert.rejects(loaded.exports(4), /ACTIVE_SOLICITUD_RESUME/);
  assert.deepEqual(calls[1].slice(1), [4, 91, "FULL", undefined]);
  assert.equal(persisted.length, 1, "un conflicto no confirma que el cierre quedó guardado");
  fail = false;
  assert.equal(await loaded.exports(2, true), 91);
  assert.equal(calls[2][0], payload);
  assert.deepEqual(calls[2].slice(1), [2, 91, "FULL", "ADVANCE_CLIENT"]);
  assert.deepEqual(persisted, ["current-closure", "current-closure"]);
});


async function customerExitDialog() {
  const source = await readProjectFile("app/dashboard/creditos/credit-factory-console.tsx");
  const ast = ts.createSourceFile("factory.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const dialogs = [];
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node)) dialogs.push(node);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const attributeExpression = (node, name) => node.attributes.properties.find(
    attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === name,
  )?.initializer?.expression;
  const exit = dialogs.find(node => node.tagName.getText(ast) === "ConfirmDialog" &&
    attributeExpression(node, "open")?.getText(ast).includes("customerExitIntent"));
  const imei = dialogs.find(node => node.tagName.getText(ast) === "ImeiConfirmationDialog");
  const clearEquipment = dialogs.find(node => node.tagName.getText(ast) === "ConfirmDialog" &&
    attributeExpression(node, "open")?.getText(ast) === "stepTwoClearConfirmOpen");
  assert.ok(exit, "Cancelar/Limpiar debe tener un diálogo de confirmación");
  assert.ok(imei);
  assert.ok(clearEquipment);
  return { ast, exit, imei, clearEquipment, attributeExpression };
}

async function customerExitFixture(intent = "cancel") {
  const { ast, exit, attributeExpression } = await customerExitDialog();
  const calls = { reset: 0, cancelAutosave: 0, save: [], busy: [], intents: [], notices: [], navigation: [] };
  let finishSave;
  let failSave;
  const saved = new Promise((resolve, reject) => { finishSave = resolve; failSave = reject; });
  const context = {
    Error,
    customerExitIntent: intent,
    customerExitBusy: false,
    module: { exports: {} },
    resetForm: () => { calls.reset += 1; },
    cancelPendingDraftAutosave: () => { calls.cancelAutosave += 1; },
    saveCurrentDraft: (...args) => { calls.save.push(args); return saved; },
    setCustomerExitBusy: value => { context.customerExitBusy = value; calls.busy.push(value); },
    setCustomerExitIntent: value => { context.customerExitIntent = value; calls.intents.push(value); },
    setNotice: value => calls.notices.push(value),
    window: { location: { assign: href => calls.navigation.push(href) } },
  };
  const callbackSource = ["onCancel", "onConfirm"].map(name => {
    const expression = attributeExpression(exit, name);
    assert.ok(expression, name);
    return name + ": " + expression.getText(ast);
  }).join(",\n");
  runInNewContext(ts.transpileModule("module.exports = {" + callbackSource + "};", {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { callbacks: context.module.exports, calls, context, finishSave, failSave };
}

const flushCustomerExit = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

test("Cancelar y Limpiar se confirman desde Nueva venta fuera de la vista de pagos", async () => {
  const { exit, imei, clearEquipment, ast } = await customerExitDialog();
  assert.ok(ts.isJsxElement(exit.parent), "El diálogo debe montarse en el contenedor global");
  assert.equal(exit.parent, imei.parent, "Debe compartir contenedor con el diálogo global de IMEI");
  assert.equal(exit.parent, clearEquipment.parent, "Debe compartir contenedor con la limpieza global del equipo");
  for (let ancestor = exit.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isBinaryExpression(ancestor) && ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      assert.doesNotMatch(ancestor.left.getText(ast), /paymentsView|selectedCredit/,
        "El diálogo de Nueva venta no debe depender de un crédito seleccionado o de la vista de pagos");
    }
  }
});

test("descartar la confirmación conserva los datos y Limpiar sólo reinicia tras confirmar", async () => {
  const dismissed = await customerExitFixture("clear");
  dismissed.callbacks.onCancel();
  assert.deepEqual(dismissed.calls.intents, [null]);
  assert.equal(dismissed.calls.reset, 0);
  assert.equal(dismissed.calls.save.length, 0);
  assert.equal(dismissed.calls.navigation.length, 0);

  const confirmed = await customerExitFixture("clear");
  assert.equal(confirmed.calls.reset, 0);
  confirmed.callbacks.onConfirm();
  assert.equal(confirmed.calls.reset, 1);
  assert.deepEqual(confirmed.calls.intents, [null]);
  assert.equal(confirmed.calls.save.length, 0);
  assert.equal(confirmed.calls.navigation.length, 0);
});

test("Cancelar espera al borrador antes de navegar y evita envíos duplicados mientras guarda", async () => {
  const fixture = await customerExitFixture();
  fixture.callbacks.onConfirm();
  assert.equal(fixture.calls.cancelAutosave, 1);
  assert.deepEqual(fixture.calls.save, [[1]]);
  assert.deepEqual(fixture.calls.busy, [true]);
  assert.equal(fixture.calls.navigation.length, 0, "No debe salir con el guardado aún pendiente");
  fixture.callbacks.onConfirm();
  assert.equal(fixture.calls.save.length, 1);
  fixture.finishSave(91);
  await flushCustomerExit();
  assert.deepEqual(fixture.calls.navigation, ["/dashboard/creditos"]);
  assert.deepEqual(fixture.calls.busy, [true, false]);
  assert.equal(fixture.calls.reset, 0);
});

test("si falla Guardar y salir se conservan los datos, no se navega y se habilita reintentar", async () => {
  const fixture = await customerExitFixture();
  fixture.callbacks.onConfirm();
  fixture.failSave(new Error("No se pudo guardar la solicitud"));
  await flushCustomerExit();
  assert.equal(fixture.calls.navigation.length, 0);
  assert.equal(fixture.calls.reset, 0);
  assert.equal(fixture.context.customerExitIntent, "cancel");
  assert.deepEqual(fixture.calls.busy, [true, false]);
  assert.equal(fixture.context.customerExitBusy, false);
  assert.equal(fixture.calls.notices.length, 1);
  assert.equal(fixture.calls.notices[0].text, "No se pudo guardar la solicitud");
  assert.equal(fixture.calls.notices[0].tone, "red");
});
