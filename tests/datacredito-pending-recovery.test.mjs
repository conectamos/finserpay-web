import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const resumeGate = await jiti.import("../lib/datacredito/resume-gate.ts");
const routeSource = readFileSync(new URL("../app/api/creditos/datacredito/evaluaciones/route.ts", import.meta.url), "utf8");
const recoverable = {
  reuseOnly: true, solicitudId: 530, currentStep: 1,
  storedDocument: "1.193.536.562", submittedDocument: "1193536562",
  storedPlatform: "iphone", submittedPlatform: "IPHONE", assessmentId: null,
  imei: null, errorCode: "EVALUATION_IN_PROGRESS",
};

test("la recuperación pendiente exige borrador de paso 1 sin evaluación enlazada ni equipo", () => {
  assert.equal(resumeGate.canRecoverPendingAssessment(recoverable), true);
  for (const denied of [
    { reuseOnly: false }, { solicitudId: null }, { currentStep: 2 },
    { submittedDocument: "1193536563" }, { storedDocument: "" },
    { submittedPlatform: "ANDROID" }, { storedPlatform: "" },
    { assessmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { imei: "355909998071255" }, { errorCode: "" },
    { errorCode: "UNKNOWN" }, { errorCode: "PROVIDER_OUTCOME_AMBIGUOUS" },
    { errorCode: "ASSESSMENT_REQUIRES_REVIEW" }, { errorCode: "ASSESSMENT_IDENTITY_MISMATCH" },
  ]) assert.equal(resumeGate.canRecoverPendingAssessment({ ...recoverable, ...denied }), false, JSON.stringify(denied));
});

function fixture(overrides = {}) {
  const events = { provider: 0, reservation: 0, reuse: 0, released: 0, attached: [], marked: [] };
  const context = {
    id: 530, currentStep: 1, usuarioId: 1, vendedorId: null, sedeId: 3, aliadoId: 7,
    clienteDocumento: "1193536562", clientePrimerApellido: "PEREZ", plataforma: "IPHONE",
    imei: null, dataCreditoAssessmentId: null, dataCreditoErrorCode: "EVALUATION_IN_PROGRESS",
    ...overrides.context,
  };
  const assessment = { id: "approved-assessment", status: "APROBADO", offer: {} };
  let contextReads = 0;
  class StubError extends Error {}
  const modules = {
    "node:crypto": require("node:crypto"),
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/datacredito/resume-gate": resumeGate,
    "@/lib/datacredito/customer-identity": { getDataCreditoCustomerIdentityForDisplay: async () => null },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => {} },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/auth": { getSessionUser: async () => ({ id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSER", sedeId: 3, aliadoId: 7 }) },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/solicitud-operation-access": { canOperateSolicitud: () => overrides.authorized !== false, isDirectSalesProfile: () => true },
    "@/lib/datacredito": {
      getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "PRODUCTION" }),
      allowsDataCreditoNonProductionProvider: () => false, DataCreditoError: StubError,
      queryDataCreditoNaturalPerson: async () => { events.provider++; throw new Error("Paid provider must not run"); },
    },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: value => ["ANDROID", "IPHONE"].includes(value) ? value : null },
    "@/lib/datacredito/storage": {
      normalizeDataCreditoDocument: value => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: value => String(value || "").trim().toUpperCase(),
      isDataCreditoAuditConfigured: () => true,
      buildDataCreditoIdentityHashes: input => ({ documentHash: input.documentNumber, surnameHash: input.firstSurname }),
      hashDataCreditoRequestMetadata: () => "hash",
      getAssignedDataCreditoPolicy: async () => ({ kind: "READY", policy: { version: 8, revisionId: "current-revision" } }),
      reuseDataCreditoAssessment: async () => { events.reuse++; return Object.hasOwn(overrides, "cached") ? overrides.cached : { kind: "REUSED", assessment }; },
      reserveDataCreditoAssessment: async () => { events.reservation++; throw new Error("Paid reservation must not run"); },
      serializeDataCreditoAssessment: value => ({ assessmentId: value.id, status: value.status, offer: value.offer }),
      DataCreditoStorageConfigurationError: StubError,
    },
    "@/lib/datacredito/secure-record": { DataCreditoSecureRecordConfigurationError: StubError, DataCreditoSecureRecordValidationError: StubError },
    "@/lib/firmaseguro-storage": { tryAcquireSolicitudOperationLock: async () => ({ release: async () => { events.released++; } }) },
    "@/lib/solicitudes-storage": {
      getActiveSolicitudCreditContext: async () => { contextReads++; return contextReads > 1 && overrides.contextAfterLock ? { ...context, ...overrides.contextAfterLock } : context; },
      reserveSolicitudForIdentity: async () => ({ id: context.id }),
      attachDataCreditoToSolicitud: async input => events.attached.push(input),
      markSolicitudDataCreditoTechnicalError: async input => events.marked.push({ ...input, status: "NO_EVALUADO" }),
      markSolicitudDataCreditoRecoverablePending: async input => events.marked.push({ ...input, status: "PENDING" }),
      ActiveSolicitudConflictError: StubError, SolicitudDataCreditoLinkError: StubError,
    },
  };
  const exports = {};
  const compiled = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(compiled, { exports, require: name => modules[name] || {}, Response, process: { env: { NODE_ENV: "test" } }, console: { warn() {}, error() {} } });
  const body = { solicitudId: 530, documentNumber: "1193536562", firstSurname: "PEREZ", platform: "IPHONE", consentAccepted: true, reuseOnly: true, ...overrides.body };
  return { events, async submit() {
    const response = await exports.POST(new Request("https://finser.test/api/creditos/datacredito/evaluaciones", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() };
  } };
}

test("un pendiente puede recuperar la aprobación terminada sin reserva ni llamada paga", async () => {
  const f = fixture();
  const response = await f.submit();
  assert.equal(response.status, 200);
  assert.equal(response.body.assessmentId, "approved-assessment");
  assert.equal(response.body.reused, true);
  assert.equal(f.events.attached.length, 1);
  assert.equal(f.events.attached[0].clientePrimerApellido, null, "La recuperación pendiente no cambia el apellido");
  assert.equal(f.events.provider, 0);
  assert.equal(f.events.reservation, 0);
  assert.equal(f.events.released, 1);
});

test("sin resultado, en proceso o en revisión devuelve el estado sin fallback pagado", async () => {
  for (const [cached, code, status] of [
    [null, "ASSESSMENT_REUSE_NOT_FOUND", "NO_EVALUADO"],
    [{ kind: "IN_PROGRESS" }, "EVALUATION_IN_PROGRESS", "PENDING"],
    [{ kind: "REQUIRES_REVIEW" }, "ASSESSMENT_REQUIRES_REVIEW", "NO_EVALUADO"],
  ]) {
    const f = fixture({ cached });
    const response = await f.submit();
    assert.equal(response.status, 409);
    assert.equal(response.body.code, code);
    assert.equal(response.body.solicitudId, 530);
    assert.equal(f.events.marked[0].status, status);
    assert.equal(f.events.provider, 0);
    assert.equal(f.events.reservation, 0);
    assert.deepEqual(f.events.attached, []);
  }
});

test("la recuperación pendiente mantiene consentimiento, propietario, apellido y validación bajo lock", async () => {
  for (const invalid of [
    { body: { consentAccepted: false } }, { authorized: false },
    { body: { documentNumber: "1193536563" } }, { body: { firstSurname: "GOMEZ" } },
    { body: { platform: "ANDROID" } }, { context: { currentStep: 2 } },
    { context: { dataCreditoAssessmentId: "linked-assessment" } },
    { context: { dataCreditoErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS" } },
    { contextAfterLock: { dataCreditoErrorCode: "UNKNOWN" } },
    { contextAfterLock: { clientePrimerApellido: "GOMEZ" } },
    { contextAfterLock: { currentStep: 2 } },
  ]) {
    const f = fixture(invalid);
    const response = await f.submit();
    assert.ok(response.status >= 400, JSON.stringify(invalid));
    assert.equal(f.events.reuse, 0, JSON.stringify(invalid));
    assert.equal(f.events.provider, 0);
    assert.equal(f.events.reservation, 0);
    assert.deepEqual(f.events.attached, []);
  }
});
