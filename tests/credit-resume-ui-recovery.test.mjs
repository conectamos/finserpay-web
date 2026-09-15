import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readProjectFile = (file) => readFile(path.join(projectRoot, file), "utf8");

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `No se encontró ${startMarker}`);
  assert.ok(end > start, `No se encontró ${endMarker}`);
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
  const autosave = sourceBlock(
    factory,
    "if (draftResumeHydrationRef.current) {",
    "const saveGeneration = draftSaveGenerationRef.current"
  );

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

test("los tres POST de borrador entregan el conflicto al redirect canónico", async () => {
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
    "const submitFirmaSeguroDraft = async ("
  );
  const autosave = sourceBlock(
    factory,
    "const saveDraft = async () => {",
    "const handleDataCreditoBypass ="
  );
  const expectedCalls = [
    [veriffSave, "currentDraftId"],
    [currentSave, "draftId"],
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
    3,
    "solo los tres POST de guardado deben iniciar la retoma canónica"
  );
  assert.match(
    autosave,
    /resumeActiveSolicitudFromConflict\(result, canonicalDraftId\)[\s\S]{0,80}return;/
  );
});
