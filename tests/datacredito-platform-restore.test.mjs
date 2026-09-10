import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolveMissingAssessmentGateView } from "../lib/datacredito/resume-gate.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file) => readFile(path.join(projectRoot, file), "utf8");

const [storage, assessmentRoute, gate, factory] = await Promise.all([
  source("lib/datacredito/storage.ts"),
  source("app/api/creditos/datacredito/evaluaciones/[id]/route.ts"),
  source("app/dashboard/creditos/datacredito-prequalification-gate.tsx"),
  source("app/dashboard/creditos/credit-factory-console.tsx"),
]);

test("la evaluacion serializada conserva su plataforma autentica", () => {
  const serializer = storage.match(
    /export function serializeDataCreditoAssessment\([\s\S]*?\n\}/
  )?.[0];

  assert.ok(serializer);
  assert.match(serializer, /platform:\s*row\.platform/);
});

test("la restauracion valida la plataforma esperada", () => {
  assert.match(assessmentRoute, /normalizeDataCreditoPlatform/);
  assert.match(assessmentRoute, /searchParams\.get\("platform"\)/);
  assert.match(
    assessmentRoute,
    /expectedPlatform\s*&&\s*row\.platform\s*!==\s*expectedPlatform/
  );
  assert.match(assessmentRoute, /ASSESSMENT_PLATFORM_MISMATCH/);
});

test("el gate solicita, valida y entrega la plataforma sin reetiquetarla", () => {
  assert.match(gate, /platform:\s*DataCreditoPlatform/);
  assert.match(gate, /readPlatform\(source\.platform\)/);
  assert.match(gate, /new URLSearchParams\(\{ platform \}\)/);
  assert.match(gate, /\?\$\{assessmentParams\.toString\(\)\}/);
  assert.match(gate, /approved\.platform\s*!==\s*platform/);

  assert.match(factory, /setDataCreditoApproval\(approvedResult\)/);
  assert.doesNotMatch(
    factory,
    /setDataCreditoApproval\(\{\s*\.\.\.result,\s*platform:\s*dataCreditoPlatform\s*\}\)/
  );
});

test("restaura el cupo diario agotado como reintento recuperable de consulta nueva", () => {
  const recoveryDeclaration = gate.match(
    /const newQueryRetryRecovery = Boolean\([\s\S]*?\n  \);/
  )?.[0];
  assert.ok(recoveryDeclaration);
  assert.match(recoveryDeclaration, /"RATE_LIMITED"/);
  assert.match(
    recoveryDeclaration,
    /"ALLY_DAILY_QUERY_LIMIT_REACHED"/
  );

  const missingAssessmentStart = gate.indexOf("if (!initialAssessmentId)");
  const assessmentLookupStart = gate.indexOf(
    "const assessmentParams",
    missingAssessmentStart
  );
  const missingAssessmentFlow = gate.slice(
    missingAssessmentStart,
    assessmentLookupStart
  );

  assert.ok(missingAssessmentStart >= 0);
  assert.match(
    missingAssessmentFlow,
    /identityMismatchRecovery \|\| newQueryRetryRecovery/
  );
  assert.match(missingAssessmentFlow, /setView\("ready"\)/);
  assert.match(gate, /reuseOnly: identityMismatchRecovery/);
  assert.doesNotMatch(gate, /reuseOnly: newQueryRetryRecovery/);
});

async function bootstrapRestoredGate(overrides = {}, policyOverrides = {}) {
  const normalizationStart = gate.indexOf("  const normalizedInitialDocument =");
  const normalizationEnd = gate.indexOf("  const [view, setView]", normalizationStart);
  const bootstrapStart = gate.indexOf("  const loadInitialState = useCallback(");
  const bootstrapEnd = gate.indexOf("\n  useEffect(", bootstrapStart);
  assert.ok(normalizationStart >= 0 && normalizationEnd > normalizationStart);
  assert.ok(bootstrapStart >= 0 && bootstrapEnd > bootstrapStart);
  const { outputText } = ts.transpileModule(
    `(async () => {
      ${gate.slice(normalizationStart, normalizationEnd)}
      ${gate.slice(bootstrapStart, bootstrapEnd)}
      await loadInitialState();
    })()`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  );
  const state = { consentAccepted: true, view: "loading" };
  const requests = [];
  let approvals = 0;
  let bypasses = 0;
  const setters = Object.fromEntries(
    ["View", "CorrelationId", "ConsumedCreditId", "DailyQueryLimitReached", "DailyQuotaModalOpen", "DailyQuotaCheckError",
      "CheckingDailyQuota", "ApprovedResult", "RetryMode", "ConsentText", "ConsentAccepted", "FormErrors"]
      .map((name) => [`set${name}`, (value) => {
        state[name[0].toLowerCase() + name.slice(1)] = value;
      }])
  );
  await runInNewContext(outputText, {
    initialSolicitudId: 37,
    initialAssessmentId: null,
    initialDocumentNumber: "123456789",
    initialFirstSurname: "APELLIDO PRUEBA",
    initialErrorCode: "ASSESSMENT_RETRY_AUTHORIZED",
    platform: "IPHONE",
    ...overrides,
    ...setters,
    useCallback: (callback) => callback,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method || "GET" });
      assert.equal(url, overrides.initialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED"
        ? "/api/creditos/datacredito/politica?solicitudId=37"
        : "/api/creditos/datacredito/politica");
      return Response.json({
        ok: true, enabled: true, configured: true, hasPolicy: true,
        policy: { version: 1 }, ...policyOverrides,
      });
    },
    readJson: (response) => response.json(),
    readString: (value) => typeof value === "string" ? value : null,
    normalizeDailyQueryLimitReached: () => null,
    CONSENT_ATTESTATION: "Autorización del titular requerida",
    resolveMissingAssessmentGateView,
    expiredRequerySolicitudIdRef: { current: null },
    quotaRefreshAbortRef: { current: null },
    getCorrelationId: () => null,
    finishBypass: () => { bypasses++; },
    showApproved: () => { approvals++; },
    onApprovedRef: { current: () => { approvals++; } },
    DOMException,
  }, { timeout: 1000 });
  return { state, requests, approvals, bypasses };
}

test("un reintento autorizado abre el formulario con consentimiento nuevo y no consulta ni aprueba automáticamente", async () => {
  for (const initialErrorCode of ["ASSESSMENT_RETRY_AUTHORIZED", "RATE_LIMITED", "ALLY_DAILY_QUERY_LIMIT_REACHED"]) {
    const result = await bootstrapRestoredGate({ initialErrorCode });
    assert.equal(result.state.view, "ready");
    assert.equal(result.state.consentAccepted, false);
    assert.equal(result.state.retryMode, "form");
    assert.deepEqual(result.requests, [{
      url: initialErrorCode === "ALLY_DAILY_QUERY_LIMIT_REACHED"
        ? "/api/creditos/datacredito/politica?solicitudId=37"
        : "/api/creditos/datacredito/politica",
      method: "GET",
    }]);
    assert.equal(result.approvals, 0);
    assert.equal(result.bypasses, 0);
  }
});

test("el reintento no abre una solicitud incompleta, un error no autorizado o un proveedor sin configurar", async () => {
  for (const overrides of [
    { initialErrorCode: "PROVIDER_RESPONSE_ERROR" },
    { initialErrorCode: null },
    { initialDocumentNumber: "" },
    { initialFirstSurname: "" },
  ]) {
    const result = await bootstrapRestoredGate(overrides);
    assert.equal(result.state.view, "technical-error");
    assert.equal(result.approvals, 0);
    assert.equal(result.bypasses, 0);
    assert.equal(result.requests.length, 1);
  }
  const unavailable = await bootstrapRestoredGate({}, { configured: false });
  assert.equal(unavailable.state.view, "unavailable");
  assert.equal(unavailable.approvals, 0);
  assert.equal(unavailable.bypasses, 0);
});
