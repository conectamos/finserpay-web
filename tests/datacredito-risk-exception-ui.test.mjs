import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../app/api/creditos/datacredito/evaluaciones/[id]/route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const assessmentId = "b13a8110-bd5c-4307-9d0e-deed918fdbe5";
const exceptionId = "a710d188-4f94-44ef-94cd-42f8807f4daf";
const offer = { initialPaymentPercentage: 20, suretyPercentage: 10, maxFinancedAmount: 1_000_000, installmentCount: 16, maxInstallmentAmount: null };
const identity = { original: { fullName: "NOMBRE DE PRUEBA" }, effective: { fullName: "NOMBRE DE PRUEBA" } };

function fixture(options = {}) {
  const calls = { grants: [], identities: [], blacklists: [], providerQueries: 0 };
  const scope = { userId: 10, sellerId: null, sedeId: 2, aliadoId: 3 };
  const row = { id: assessmentId, status: options.status || "NO_EVALUADO", errorCode: "NO_EVALUABLE_INFORMATION", correlationId: "technical-tracking", platform: "IPHONE", providerEnvironment: "production", expiresAt: new Date("2099-10-25T05:00:00Z"), consumedAt: null, creditId: null, documentHash: "document:123456789", surnameHash: "surname:PRUEBA", ...scope, ...options.row };
  const draft = { id: 12, usuarioId: 10, vendedorId: null, sedeId: 2, aliadoId: 3, clienteDocumento: "123456789", clientePrimerApellido: "PRUEBA", dataCreditoAssessmentId: assessmentId, ...options.draft };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { getSessionUser: async () => options.unauthenticated ? null : ({ id: 10, sedeId: 2, aliadoId: 3, rolNombre: "ADMIN", aliadoAccesoCodigo: options.central === false ? "OTHER" : "FINSERPAY" }) },
    "@/lib/aliados": { isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/seller-auth": { getSellerSessionUser: async () => null },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async document => { calls.blacklists.push(document); } },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/solicitud-operation-access": { canOperateSolicitud: ({ owner }) => !!owner && options.authorized !== false, canActAsAllySalesAdmin: () => false, isDirectSalesProfile: () => false },
    "@/lib/solicitudes-storage": { getActiveSolicitudCreditContext: async id => id === 12 ? draft : null },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ environment: "production" }) },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: value => ["IPHONE", "ANDROID"].includes(value) ? value : null },
    "@/lib/datacredito/storage": {
      buildDataCreditoIdentityHashes: ({ documentNumber, firstSurname }) => ({ documentHash: `document:${documentNumber}`, surnameHash: `surname:${firstSurname}` }),
      dataCreditoAssessmentMatchesScope: (value, expected) => Object.keys(scope).every(key => value[key] === expected[key]),
      getDataCreditoAssessmentById: async id => id === assessmentId ? row : null,
      getDataCreditoAssessmentDocumentState: async () => ({ consumedElsewhere: false, inProgress: false }),
      getDataCreditoAssessmentResumeIdentity: async () => null,
      normalizeDataCreditoDocument: value => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: value => String(value || "").trim().toUpperCase(),
      serializeDataCreditoAssessment: value => ({ assessmentId: value.id, platform: value.platform, status: value.status, expiresAt: value.expiresAt.toISOString(), offer: null }),
    },
    "@/lib/datacredito/customer-identity": {
      getDataCreditoCustomerIdentityForDisplay: async () => identity,
      completeMissingDataCreditoIdentity: async (...args) => { calls.identities.push(args); return identity; },
    },
    "@/lib/datacredito/risk-exception": {
      getCreditRiskAuthorizationForDraft: async input => { calls.grants.push(input); return options.grant === false ? null : ({ source: "INTERNAL_EXCEPTION", assessment: row, offer, policyVersion: 4, exceptionId, expiresAt: new Date("2099-10-24T05:00:00Z") }); },
      getActiveCreditRiskExceptionForDraft: async input => { calls.grants.push(input); return options.grant === false ? null : ({ id: exceptionId }); },
    },
  };
  const loaded = { exports: {} };
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, URL, Date, console: { error() {} }, require(name) { assert.ok(name in dependencies, `Unexpected dependency: ${name}`); return dependencies[name]; } });
  return { calls, row, draft, get: (params = "draftId=12&platform=IPHONE") => loaded.exports.GET(new Request(`https://test.invalid/api/creditos/datacredito/evaluaciones/${assessmentId}?${params}`), { params: Promise.resolve({ id: assessmentId }) }),
    patch: body => loaded.exports.PATCH(new Request(`https://test.invalid/api/creditos/datacredito/evaluaciones/${assessmentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: assessmentId }) }) };
}

test("GET restores only the independent internal authority while preserving NO_EVALUADO and a null provider offer", async () => {
  const api = fixture(); const response = await api.get(); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.status, "NO_EVALUADO"); assert.equal(body.offer, null);
  assert.equal(body.creditAuthorization.source, "INTERNAL_EXCEPTION"); assert.equal(body.creditAuthorization.exceptionId, exceptionId);
  assert.equal(body.creditAuthorization.solicitudId, 12); assert.equal(body.creditAuthorization.assessmentId, assessmentId);
  assert.equal(body.creditAuthorization.offer.maxFinancedAmount, offer.maxFinancedAmount);
  assert.equal(api.row.status, "NO_EVALUADO"); assert.equal(api.calls.providerQueries, 0);
  assert.equal(api.calls.grants.length, 1); assert.equal(api.calls.grants[0].solicitudId, api.draft.id);
  assert.equal(api.calls.grants[0].documentNumber, api.draft.clienteDocumento);
  assert.deepEqual(api.calls.blacklists, ["123456789", "123456789"]);
});

test("GET fails closed without an active grant and cannot restore one for an unbound or altered request", async () => {
  for (const [options, params, status] of [
    [{ grant: false }, "draftId=12&platform=IPHONE", 422],
    [{}, "draftId=13&platform=IPHONE", 404],
    [{ draft: { dataCreditoAssessmentId: null } }, "draftId=12&platform=IPHONE", 404],
    [{ authorized: false }, "draftId=12&platform=IPHONE", 404],
    [{ draft: { clienteDocumento: "987654321" } }, "draftId=12&platform=IPHONE", 409],
    [{}, "draftId=12&platform=ANDROID", 409],
  ]) {
    const api = fixture(options); const response = await api.get(params); const body = await response.json();
    assert.equal(response.status, status); assert.equal(body.creditAuthorization, undefined);
    assert.equal(api.calls.providerQueries, 0);
  }
  const api = fixture(); assert.equal((await api.get("platform=IPHONE&documentNumber=123456789&firstSurname=PRUEBA")).status, 422);
  assert.equal(api.calls.grants.length, 0, "a requestless GET cannot restore an exception");
});

test("administrative completion is restricted to the central administrator and the exact live draft grant", async () => {
  const body = { draftId: 12, creditRiskExceptionId: exceptionId, firstSurname: "De la Peña" };
  const api = fixture(); const response = await api.patch(body);
  assert.equal(response.status, 200); assert.equal(api.calls.identities.length, 1);
  assert.equal(api.calls.identities[0][3], 12); assert.equal(api.calls.identities[0][2].userId, 10);
  assert.equal(api.calls.grants[0].documentNumber, "123456789");
  for (const [options, altered, status] of [
    [{ central: false }, body, 403],
    [{ grant: false }, body, 409],
    [{}, { ...body, draftId: 13 }, 404],
    [{}, { ...body, creditRiskExceptionId: "another-grant" }, 409],
    [{}, { ...body, draftId: null }, 403],
  ]) {
    const denied = fixture(options); assert.equal((await denied.patch(altered)).status, status); assert.equal(denied.calls.identities.length, 0);
  }
});


test("FirmaSeguro readiness binds the current saved structured name while preserving an unsplit provider name", () => {
  const factory = readFileSync(new URL("../app/dashboard/creditos/credit-factory-console.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("factory.tsx", factory, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let helper, nameExpression;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.getText(ast) === "getDataCreditoClientDisplayName") helper = node.getText(ast);
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "useFirmaSeguroIdentityReadiness") {
      const field = node.arguments[0].properties.find(property => property.name?.getText(ast) === "fullName");
      nameExpression = field.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.ok(helper && nameExpression);
  const js = ts.transpileModule(`${helper}; (dataCreditoApproval, clienteNombre) => ${nameExpression}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const binding = runInNewContext(js, {});
  const structured = { creditAuthorizationSource: "INTERNAL_EXCEPTION", identity: { original: { fullName: "" }, effective: { fullName: "De la Peña" } } };
  assert.equal(binding(structured, "María del Mar De la Peña"), "María del Mar De la Peña");
  const whole = { identity: { original: { fullName: "María del Mar De la Peña" }, effective: { fullName: "María del Mar De la Peña", nameMode: "FULL_NAME_ONLY" } } };
  assert.equal(binding(whole, "Otro nombre"), "María del Mar De la Peña");
});
