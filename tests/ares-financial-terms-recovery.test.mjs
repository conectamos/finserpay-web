import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } });
const currentTerms = jiti("../lib/credit-current-origination-terms.ts");
const signatureStatuses = jiti("../lib/firmaseguro-status.ts");
const code = currentTerms.CREDIT_CURRENT_ORIGINATION_TERMS_ERROR_CODE;
const settings = { calculoVersion: "ARES_FRANCES_V2", tasaInteresEa: 29.24, fianzaTotalPorcentaje: 75,
  seguroCuotaPorcentaje: 0.03, tasaPeriodoDecimales: 6, redondeoComercial: { modo: "PISO", multiplo: 50 } };
const routeSource = readFileSync(new URL("../app/api/creditos/datacredito/evaluaciones/route.ts", import.meta.url), "utf8");
const gateSource = readFileSync(new URL("../app/dashboard/creditos/datacredito-prequalification-gate.tsx", import.meta.url), "utf8");
const consoleSource = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function routeFixture(overrides = {}) {
  const events = { provider: 0, reservation: 0, reuse: 0, released: 0, attached: [], marked: [] };
  const context = { id: 392, currentStep: 4, usuarioId: 1, vendedorId: null, sedeId: 3, aliadoId: 7,
    clienteDocumento: "12345678", clientePrimerApellido: "PEREZ", plataforma: "IPHONE", imei: "350000000000001",
    dataCreditoAssessmentId: "old-assessment", dataCreditoErrorCode: null, ...overrides.context };
  const assessment = { id: "old-assessment", status: "APROBADO", documentHash: "12345678", surnameHash: "PEREZ",
    platform: "IPHONE", userId: 1, sellerId: null, sedeId: 3, aliadoId: 7,
    offer: { financialSettings: { ...settings, calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66 } },
    ...overrides.assessment };
  let signatureReads = 0;
  class StubError extends Error {}
  const modules = {
    "node:crypto": require("node:crypto"),
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/credit-current-origination-terms": currentTerms,
    "@/lib/firmaseguro-status": signatureStatuses,
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => {} },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/auth": { getSessionUser: async () => ({ id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSER", sedeId: 3, aliadoId: 7 }) },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/solicitud-operation-access": { canOperateSolicitud: () => overrides.authorized !== false, isDirectSalesProfile: () => true },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "PRODUCTION" }),
      allowsDataCreditoNonProductionProvider: () => false, DataCreditoError: StubError,
      queryDataCreditoNaturalPerson: async () => { events.provider++; throw new Error("Paid provider must not run"); } },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: value => ["ANDROID", "IPHONE"].includes(value) ? value : null },
    "@/lib/datacredito/storage": {
      normalizeDataCreditoDocument: value => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: value => String(value || "").trim().toUpperCase(),
      isDataCreditoAuditConfigured: () => true,
      getDataCreditoAssessmentById: async () => assessment,
      buildDataCreditoIdentityHashes: input => ({ documentHash: input.documentNumber, surnameHash: input.firstSurname }),
      hashDataCreditoRequestMetadata: () => "hash",
      getAssignedDataCreditoPolicy: async () => ({ kind: "READY", policy: { version: 8, revisionId: "new-revision", financialSettings: settings } }),
      reuseDataCreditoAssessment: async () => { events.reuse++; return Object.hasOwn(overrides, "cached") ? overrides.cached : { kind: "REUSED", assessment: { ...assessment, id: "new-assessment", offer: { financialSettings: settings } } }; },
      reserveDataCreditoAssessment: async () => { events.reservation++; throw new Error("Paid reservation must not run"); },
      serializeDataCreditoAssessment: value => ({ assessmentId: value.id, decision: value.status, offer: value.offer }),
      DataCreditoStorageConfigurationError: StubError,
    },
    "@/lib/datacredito/resume-gate": { canRecoverAssessmentIdentityMismatch: () => false },
    "@/lib/datacredito/secure-record": { DataCreditoSecureRecordConfigurationError: StubError, DataCreditoSecureRecordValidationError: StubError },
    "@/lib/firmaseguro-storage": {
      getLatestFirmaSeguroProcessByDraft: async () => { signatureReads++; return overrides.signatureAfterLock && signatureReads > 1 ? overrides.signatureAfterLock : overrides.signature || null; },
      tryAcquireSolicitudOperationLock: async () => ({ release: async () => { events.released++; } }),
    },
    "@/lib/solicitudes-storage": {
      getActiveSolicitudCreditContext: async () => context,
      reserveSolicitudForIdentity: async () => ({ id: context.id }),
      attachDataCreditoToSolicitud: async input => events.attached.push(input),
      markSolicitudDataCreditoTechnicalError: async input => events.marked.push(input),
      markSolicitudDataCreditoRecoverablePending: async input => events.marked.push(input),
      ActiveSolicitudConflictError: StubError, SolicitudDataCreditoLinkError: StubError,
    },
  };
  const exports = {};
  runInNewContext(transpile(routeSource), { exports, require: name => modules[name] || {}, Response, process: { env: { NODE_ENV: "test" } }, console });
  const body = { solicitudId: 392, documentNumber: "12345678", firstSurname: "PEREZ", platform: "IPHONE", consentAccepted: true, reuseOnly: true, refreshFinancialTerms: true, ...overrides.body };
  return { events, context, async submit() { const response = await exports.POST(new Request("http://localhost/api/creditos/datacredito/evaluaciones", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })); return { status: response.status, body: await response.json() }; } };
}

test("renovar oferta usa revisión vigente y nunca reserva ni consulta al proveedor", async () => {
  const fixture = routeFixture();
  const before = JSON.stringify(fixture.context);
  const result = await fixture.submit();
  assert.equal(result.status, 200);
  assert.equal(result.body.reused, true);
  assert.equal(result.body.assessmentId, "new-assessment");
  assert.equal(fixture.events.reuse, 1);
  assert.equal(fixture.events.provider, 0);
  assert.equal(fixture.events.reservation, 0);
  assert.equal(fixture.events.attached.length, 1);
  assert.equal(fixture.events.attached[0].clientePrimerApellido, null);
  assert.equal(JSON.stringify(fixture.context), before);
  assert.deepEqual(fixture.events.marked, []);
});

test("consulta vencida conserva solicitud y retorna sin un fallback pagado", async () => {
  const fixture = routeFixture({ cached: null });
  const result = await fixture.submit();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ASSESSMENT_REUSE_NOT_FOUND");
  assert.equal(fixture.events.provider, 0);
  assert.equal(fixture.events.reservation, 0);
  assert.deepEqual(fixture.events.attached, []);
  assert.deepEqual(fixture.events.marked, []);
});

test("consentimiento, propietario, identidad, plataforma y términos antiguos son obligatorios", async () => {
  for (const invalid of [
    { body: { consentAccepted: false } }, { body: { reuseOnly: false } }, { body: { solicitudId: null } },
    { authorized: false }, { body: { documentNumber: "87654321" } }, { body: { firstSurname: "GOMEZ" } },
    { body: { platform: "ANDROID" } }, { assessment: { consumedAt: new Date() } },
    { assessment: { creditId: 1 } }, { assessment: { claimTokenHash: "claim" } },
    { assessment: { userId: 99 } }, { assessment: { offer: { financialSettings: settings } } },
  ]) {
    const fixture = routeFixture(invalid);
    const result = await fixture.submit();
    assert.ok(result.status >= 400, JSON.stringify(invalid));
    assert.equal(fixture.events.reuse, 0);
    assert.equal(fixture.events.provider, 0);
    assert.equal(fixture.events.reservation, 0);
    assert.deepEqual(fixture.events.attached, []);
  }
});

test("firmas pendientes, exitosas y carrera de envío bajo lock no se renuevan", async () => {
  for (const state of [
    { signature: { status: "PENDING" } }, { signature: { status: "COMPLETED", completedAt: new Date() } },
    { signature: { status: "FAILED", signedDocumentBase64: "signed" } },
    { signatureAfterLock: { status: "PENDING" } },
  ]) {
    const fixture = routeFixture(state);
    const result = await fixture.submit();
    assert.equal(result.status, 409);
    assert.equal(fixture.events.reuse, 0);
    assert.deepEqual(fixture.events.attached, []);
  }
});

function declarations(source, names) {
  const parsed = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return names.map(name => {
    const nodes = [];
    function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) nodes.push(node); ts.forEachChild(node, visit); }
    visit(parsed);
    assert.equal(nodes.length, 1, name);
    return `const ${nodes[0].getText(parsed)};`;
  }).join("\n");
}

test("gate de recuperación no carga ni reacepta el GET de una oferta antigua", async () => {
  const calls = [];
  const views = [];
  const noop = () => {};
  const context = { useCallback: fn => fn, financialTermsRecovery: true, initialAssessmentId: "old", initialSolicitudId: 392,
    normalizedInitialDocument: "12345678", normalizedInitialSurname: "PEREZ", normalizedInitialErrorCode: code,
    identityMismatchRecovery: false, newQueryRetryRecovery: false, platform: "IPHONE",
    fetch: async url => { calls.push(url); return { ok: true, json: async () => ({ ok: true, enabled: true, configured: true, hasPolicy: true, policy: { version: 8 } }) }; },
    readJson: response => response.json(), readString: value => typeof value === "string" ? value : null,
    CONSENT_ATTESTATION: "consent", setView: value => views.push(value), setCorrelationId: noop, setConsumedCreditId: noop,
    setConflictMessage: noop, setDailyQueryLimitReached: noop, setRetryMode: noop, setConsentText: noop,
    setDailyQuotaModalOpen: noop, setDailyQuotaCheckError: noop, setCheckingDailyQuota: noop,
    quotaRefreshAbortRef: { current: null },
    setApprovedResult: noop, setConsentAccepted: noop, setFormErrors: noop, finishBypass: () => assert.fail("No bypass"),
    showApproved: () => assert.fail("No old approval"), onApprovedRef: { current: () => assert.fail("No auto approval") },
    expiredRequerySolicitudIdRef: { current: null }, approvedAssessmentIdsRef: { current: new Set() },
  };
  await runInNewContext(transpile(declarations(gateSource, ["loadInitialState"]) + "\nloadInitialState();"), context);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /politica/);
  assert.equal(views.at(-1), "ready");
});

test("UI recovery conserva validación/equipo y recupera exactamente la cuota elegida", () => {
  const recovery = declarations(consoleSource, ["handleDataCreditoFinancialTermsOutdated"]);
  assert.match(recovery, /signatureState === "waiting" \|\| signatureState === "signed"/);
  assert.doesNotMatch(recovery, /setVeriffValidation|setEquipo|setCuotaInicial|setPlazoMeses|setDataCreditoApproval\(null\)|resetForm/);
  assert.match(consoleSource, /deliveryMode \|\|\s*dataCreditoFinancialTermsRecovery \|\|\s*draftResumeHydrating/);
  assert.match(consoleSource, /sameAssessment \|\| refreshingFinancialTerms\s*\? parseCreditInstallmentSelection\(plazoMeses/);
  assert.match(gateSource, /reuseOnly: identityMismatchRecovery \|\| financialTermsRecovery,\s*refreshFinancialTerms: financialTermsRecovery/);
  assert.match(gateSource, /if \(financialTermsRecovery && financialReuseUnavailable\) return/);
  assert.match(gateSource, /Renovar oferta sin nueva consulta/);
  assert.match(gateSource, /esta pantalla no la realizará automáticamente/);
});
