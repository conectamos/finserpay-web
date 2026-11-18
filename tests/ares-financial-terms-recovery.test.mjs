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
  const events = { provider: 0, reservation: 0, reuse: 0, policy: 0, approvalReads: 0,
    draftReservations: 0, signatureReads: 0, locks: 0, released: 0, attached: [], marked: [] };
  const context = { id: 392, currentStep: 4, usuarioId: 1, vendedorId: null, sedeId: 3, aliadoId: 7,
    clienteDocumento: "12345678", clientePrimerApellido: "PEREZ", plataforma: "IPHONE", imei: "350000000000001",
    dataCreditoAssessmentId: "old-assessment", dataCreditoErrorCode: null, ...overrides.context };
  const assessment = { id: "old-assessment", status: "APROBADO", documentHash: "12345678", surnameHash: "PEREZ",
    platform: "IPHONE", userId: 1, sellerId: null, sedeId: 3, aliadoId: 7,
    providerEnvironment: "PRODUCTION", policyVersion: 2, policyRevisionId: "original-revision",
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
    "@/lib/solicitud-operation-access": { canOperateSolicitud: () => overrides.authorized !== false, canOriginateSolicitud: () => true, canActAsAllySalesAdmin: () => false },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "PRODUCTION" }),
      allowsDataCreditoNonProductionProvider: () => false, DataCreditoError: StubError,
      queryDataCreditoNaturalPerson: async () => { events.provider++; throw new Error("Paid provider must not run"); } },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: value => ["ANDROID", "IPHONE"].includes(value) ? value : null },
    "@/lib/datacredito/storage": {
      normalizeDataCreditoDocument: value => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: value => String(value || "").trim().toUpperCase(),
      isDataCreditoAuditConfigured: () => true,
      getDataCreditoAssessmentById: async () => assessment,
      dataCreditoAssessmentMatchesScope: (row, scope) => row.userId === scope.userId &&
        row.sellerId === scope.sellerId && row.sedeId === scope.sedeId && row.aliadoId === scope.aliadoId,
      getApprovedDataCreditoAssessmentForCredit: async input => {
        events.approvalReads++;
        assert.equal(input.assessmentId, assessment.id);
        assert.equal(input.solicitudId, context.id);
        assert.equal(input.documentNumber, assessment.documentHash);
        assert.equal(input.firstSurname, assessment.surnameHash);
        assert.equal(input.platform, assessment.platform);
        assert.equal(input.providerEnvironment, assessment.providerEnvironment);
        assert.equal(input.userId, context.usuarioId);
        assert.equal(input.sellerId, context.vendedorId);
        assert.equal(input.sedeId, context.sedeId);
        assert.equal(input.aliadoId, context.aliadoId);
        return overrides.approvalAvailable === false ? null : assessment;
      },
      buildDataCreditoIdentityHashes: input => ({ documentHash: input.documentNumber, surnameHash: input.firstSurname }),
      hashDataCreditoRequestMetadata: () => "hash",
      getAssignedDataCreditoPolicy: async () => { events.policy++; return { kind: "READY", policy: { version: 8, revisionId: "new-revision", financialSettings: settings } }; },
      reuseDataCreditoAssessment: async () => { events.reuse++; return Object.hasOwn(overrides, "cached") ? overrides.cached : { kind: "REUSED", assessment: { ...assessment, id: "new-assessment", offer: { financialSettings: settings } } }; },
      reserveDataCreditoAssessment: async () => { events.reservation++; throw new Error("Paid reservation must not run"); },
      serializeDataCreditoAssessment: value => ({ assessmentId: value.id, decision: value.status, offer: value.offer,
        policyVersion: value.policyVersion, policyRevisionId: value.policyRevisionId }),
      DataCreditoStorageConfigurationError: StubError,
    },
    "@/lib/datacredito/resume-gate": { canRecoverAssessmentIdentityMismatch: () => false, canRecoverPendingAssessment: () => false },
    "@/lib/datacredito/admin-rejection-storage": { findRecentDataCreditoAdministrativeRejection: async () => null },
    "@/lib/datacredito/customer-identity": { getDataCreditoCustomerIdentityForDisplay: async () => null },
    "@/lib/datacredito/secure-record": { DataCreditoSecureRecordConfigurationError: StubError, DataCreditoSecureRecordValidationError: StubError },
    "@/lib/firmaseguro-storage": {
      getLatestFirmaSeguroProcessByDraft: async () => { signatureReads++; events.signatureReads++; return overrides.signatureAfterLock && signatureReads > 1 ? overrides.signatureAfterLock : overrides.signature || null; },
      tryAcquireSolicitudOperationLock: async () => { events.locks++; return { release: async () => { events.released++; } }; },
    },
    "@/lib/solicitudes-storage": {
      getActiveSolicitudCreditContext: async () => overrides.draftAvailable === false ? null : context,
      reserveSolicitudForIdentity: async () => { events.draftReservations++; return { id: context.id }; },
      attachDataCreditoToSolicitud: async input => events.attached.push(input),
      markSolicitudDataCreditoTechnicalError: async input => events.marked.push(input),
      markSolicitudDataCreditoRecoverablePending: async input => events.marked.push(input),
      ActiveSolicitudConflictError: StubError, SolicitudDataCreditoLinkError: StubError,
    },
  };
  const exports = {};
  runInNewContext(transpile(routeSource), { exports, require: name => modules[name] || {}, Response, process: { env: { NODE_ENV: "test" } }, console });
  const body = { solicitudId: 392, documentNumber: "12345678", firstSurname: "PEREZ", platform: "IPHONE", consentAccepted: true, reuseOnly: true, refreshFinancialTerms: true, ...overrides.body };
  return { events, context, assessment, async submit() { const response = await exports.POST(new Request("http://localhost/api/creditos/datacredito/evaluaciones", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } })); return { status: response.status, body: await response.json() }; } };
}

function assertNoReevaluation(fixture) {
  assert.equal(fixture.events.policy, 0, "No se consulta la política actual del aliado");
  assert.equal(fixture.events.reuse, 0, "No se clona la evaluación con otra revisión");
  assert.equal(fixture.events.provider, 0);
  assert.equal(fixture.events.reservation, 0);
  assert.equal(fixture.events.draftReservations, 0);
  assert.equal(fixture.events.locks, 0);
  assert.deepEqual(fixture.events.attached, []);
  assert.deepEqual(fixture.events.marked, []);
}

test("POST conserva aprobación, oferta y revisión originales aunque el cliente solicite renovar condiciones", async () => {
  for (const body of [{}, { reuseOnly: false, refreshFinancialTerms: false }]) {
    const fixture = routeFixture({ body });
    const before = JSON.stringify({ context: fixture.context, assessment: fixture.assessment });
    const result = await fixture.submit();
    assert.equal(result.status, 200);
    assert.equal(result.body.reused, true);
    assert.equal(result.body.preserved, true);
    assert.equal(result.body.assessmentId, fixture.assessment.id);
    assert.equal(result.body.policyVersion, 2);
    assert.equal(result.body.policyRevisionId, "original-revision");
    assert.deepEqual(result.body.offer, fixture.assessment.offer);
    assert.equal(fixture.events.approvalReads, 1);
    assertNoReevaluation(fixture);
    assert.equal(JSON.stringify({ context: fixture.context, assessment: fixture.assessment }), before);
  }
});

test("una aprobación que el servidor ya no autoriza retorna conflicto sin reemplazarla ni generar consulta", async () => {
  const fixture = routeFixture({ approvalAvailable: false });
  const result = await fixture.submit();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "ASSESSMENT_DRAFT_NOT_AVAILABLE");
  assert.equal(fixture.events.approvalReads, 1);
  assertNoReevaluation(fixture);
});

test("consentimiento, borrador activo, propietario, identidad, ambiente y plataforma siguen siendo obligatorios", async () => {
  for (const invalid of [
    { body: { consentAccepted: false } }, { body: { solicitudId: null } }, { draftAvailable: false },
    { body: { reuseOnly: false, refreshFinancialTerms: true } },
    { authorized: false }, { body: { documentNumber: "87654321" } }, { body: { firstSurname: "GOMEZ" } },
    { body: { platform: "ANDROID" } }, { assessment: { platform: "ANDROID" } },
    { assessment: { userId: 99 } }, { assessment: { sellerId: 99 } },
    { assessment: { sedeId: 99 } }, { assessment: { aliadoId: 99 } },
    { assessment: { providerEnvironment: "TEST" } },
  ]) {
    const fixture = routeFixture(invalid);
    const result = await fixture.submit();
    assert.ok(result.status >= 400, JSON.stringify(invalid));
    assert.equal(fixture.events.approvalReads, 0);
    assertNoReevaluation(fixture);
  }
});

test("apellido ausente o distinto en payload no reemplaza la identidad consultada de la aprobación vinculada", async () => {
  for (const clientePrimerApellido of [null, "", "OTRO"]) {
    const fixture = routeFixture({ context: { clientePrimerApellido } });
    const result = await fixture.submit();
    assert.equal(result.status, 200);
    assert.equal(result.body.firstSurname, "PEREZ");
    assert.deepEqual(result.body.offer, fixture.assessment.offer);
    assertNoReevaluation(fixture);
  }
});

test("devolver la aprobación original no modifica ni consulta firmas pendientes o exitosas", async () => {
  for (const state of [
    { signature: { status: "PENDING" } }, { signature: { status: "COMPLETED", completedAt: new Date() } },
    { signature: { status: "FAILED", signedDocumentBase64: "signed" } },
    { signatureAfterLock: { status: "PENDING" } },
  ]) {
    const fixture = routeFixture(state);
    const result = await fixture.submit();
    assert.equal(result.status, 200);
    assert.equal(result.body.preserved, true);
    assert.equal(result.body.assessmentId, fixture.assessment.id);
    assert.equal(fixture.events.signatureReads, 0);
    assertNoReevaluation(fixture);
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

test("un marcador financiero antiguo retoma primero la aprobación vinculada con su oferta original", async () => {
  const calls = [];
  const views = [];
  const approvals = [];
  const noop = () => {};
  const original = { assessmentId: "old", solicitudId: 392, status: "APROBADO", platform: "IPHONE",
    documentNumber: "12345678", firstSurname: "PEREZ", offer: { policyVersion: 2,
      financialSettings: { ...settings, calculoVersion: "ARES_FRANCES_V1", tasaInteresEa: 29.66 } } };
  const context = { useCallback: fn => fn, financialTermsRecovery: true, initialAssessmentId: "old", initialSolicitudId: 392,
    normalizedInitialDocument: "12345678", normalizedInitialSurname: "PEREZ", normalizedInitialErrorCode: code,
    identityMismatchRecovery: false, newQueryRetryRecovery: false, pendingAssessmentRecovery: false, platform: "IPHONE",
    fetch: async url => { calls.push(url); assert.match(url, /\/evaluaciones\/old\?/); return { ok: true, json: async () => ({ ok: true, ...original }) }; },
    readJson: response => response.json(), readString: value => typeof value === "string" ? value : null,
    CONSENT_ATTESTATION: "consent", setView: value => views.push(value), setCorrelationId: noop, setConsumedCreditId: noop,
    setConflictMessage: noop, setConflictCode: noop, setConflictSolicitudId: noop, setDailyQueryLimitReached: noop, setRetryMode: noop, setConsentText: noop,
    setDailyQuotaModalOpen: noop, setDailyQuotaCheckError: noop, setCheckingDailyQuota: noop,
    setDocumentNumber: noop, setFirstSurname: noop, URLSearchParams, DOMException,
    normalizeDecision: value => value.status, normalizeApprovedAssessment: value => value,
    quotaRefreshAbortRef: { current: null },
    setApprovedResult: noop, setConsentAccepted: noop, setFormErrors: noop, finishBypass: () => assert.fail("No bypass"),
    showApproved: () => assert.fail("Linked approval resumes its existing draft"), onApprovedRef: { current: value => approvals.push(value) },
    expiredRequerySolicitudIdRef: { current: null }, approvedAssessmentIdsRef: { current: new Set() },
  };
  await runInNewContext(transpile(declarations(gateSource, ["loadInitialState"]) + "\nloadInitialState();"), context);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/evaluaciones\/old\?.*draftId=392/);
  assert.equal(views.at(-1), "bypassing");
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].offer, original.offer);
});

test("UI recovery conserva validación/equipo y recupera exactamente la cuota elegida", () => {
  const recovery = declarations(consoleSource, ["handleDataCreditoFinancialTermsOutdated"]);
  assert.match(recovery, /signatureState === "waiting" \|\| signatureState === "signed"/);
  assert.doesNotMatch(recovery, /setVeriffValidation|setEquipo|setCuotaInicial|setPlazoMeses|setDataCreditoApproval\(null\)|resetForm/);
  assert.match(consoleSource, /deliveryMode \|\|\s*dataCreditoFinancialTermsRecovery \|\|\s*draftResumeHydrating/);
  assert.match(consoleSource, /sameAssessment \|\| refreshingFinancialTerms\s*\? parseCreditInstallmentSelection\(plazoMeses/);
  assert.match(gateSource, /reuseOnly: identityMismatchRecovery \|\| financialTermsRecovery \|\| pendingAssessmentRecovery,\s*refreshFinancialTerms: financialTermsRecovery/);
  assert.match(gateSource, /if \(financialTermsRecovery && financialReuseUnavailable\) return/);
  assert.match(gateSource, /Renovar oferta sin nueva consulta/);
  assert.match(gateSource, /esta pantalla no la realizará automáticamente/);
});
