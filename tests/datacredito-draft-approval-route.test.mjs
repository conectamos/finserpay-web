import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../app/api/creditos/datacredito/evaluaciones/[id]/route.ts", import.meta.url), "utf8");
const id = "a1111111-1111-4111-8111-111111111111";
const originalOffer = { initialPaymentPercentage: 20, suretyPercentage: 10, maxFinancedAmount: 2000000,
  installmentCount: 16, policyVersion: 3, financialSettings: { historical: "unchanged" } };

function fixture(overrides = {}) {
  const inquiryExpiry = new Date(Date.now() - 86400000);
  const draftExpiry = new Date(Date.now() + 3 * 86400000);
  const row = { id, platform: "IPHONE", status: "APROBADO", documentHash: "1000000001", surnameHash: "ROJAS",
    userId: 7, sellerId: 8, sedeId: 9, aliadoId: 10, providerEnvironment: "PRODUCTION", consumedAt: null,
    expiresAt: inquiryExpiry, offer: originalOffer, policyVersion: 3, correlationId: "original", ...overrides.row };
  const draft = { id: 51, usuarioId: 7, vendedorId: 8, sedeId: 9, aliadoId: 10,
    clienteDocumento: "1000000001", clientePrimerApellido: null, dataCreditoAssessmentId: id,
    plataforma: "IPHONE", ...overrides.draft };
  const reads = [];
  const modules = {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/auth": { getSessionUser: async () => ({ id: 1, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSER", aliadoId: 10, sedeId: 9 }) },
    "@/lib/roles": { isAdminRole: () => true },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/solicitud-operation-access": { canOperateSolicitud: () => overrides.authorized !== false, canActAsAllySalesAdmin: () => false },
    "@/lib/solicitudes-storage": { getActiveSolicitudCreditContext: async () => draft },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async () => {} },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ environment: "PRODUCTION" }) },
    "@/lib/datacredito/policy": { normalizeDataCreditoPlatform: value => ["ANDROID", "IPHONE"].includes(value) ? value : null },
    "@/lib/datacredito/customer-identity": { getDataCreditoCustomerIdentityForDisplay: async () => ({ effective: { nameMode: "FULL_NAME_ONLY" } }) },
    "@/lib/datacredito/storage": {
      getDataCreditoAssessmentById: async () => row,
      dataCreditoAssessmentMatchesScope: (value, scope) => value.userId === scope.userId && value.sellerId === scope.sellerId && value.sedeId === scope.sedeId && value.aliadoId === scope.aliadoId,
      buildDataCreditoIdentityHashes: input => ({ documentHash: input.documentNumber, surnameHash: input.firstSurname }),
      normalizeDataCreditoDocument: value => String(value || "").replace(/\D/g, ""),
      normalizeDataCreditoSurname: value => String(value || "").trim().toUpperCase(),
      getDataCreditoAssessmentResumeIdentity: async () => overrides.resumeIdentity === null ? null : { documentNumber: "1000000001", firstSurname: "ROJAS", ...overrides.resumeIdentity },
      getDataCreditoAssessmentDocumentState: async () => ({ consumedElsewhere: false, inProgress: false, ...overrides.documentState }),
      getApprovedDataCreditoAssessmentForCredit: async input => {
        reads.push(input);
        return overrides.bound === false ? null : { ...row, draftApprovalExpiresAt: draftExpiry };
      },
      serializeDataCreditoAssessment: value => ({ assessmentId: value.id, status: value.status, offer: value.offer,
        expiresAt: (value.draftApprovalExpiresAt || value.expiresAt).toISOString(), assessmentExpiresAt: value.expiresAt.toISOString() }),
      getAssignedDataCreditoPolicy: () => assert.fail("Retomar no lee la política actual"),
      reuseDataCreditoAssessment: () => assert.fail("Retomar no clona la evaluación"),
    },
  };
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => modules[name] || {}, Date, URL, Response, console: { error() {} } });
  return { reads, inquiryExpiry, draftExpiry, async get(query = "draftId=51&platform=IPHONE") {
    const response = await exports.GET(new Request(`https://finser.test/evaluaciones/${id}?${query}`), { params: Promise.resolve({ id }) });
    return { status: response.status, body: await response.json() };
  } };
}

test("retomar conserva la oferta original del borrador vigente aunque venza la consulta y falte apellido de presentación", async () => {
  const f = fixture();
  const r = await f.get();
  assert.equal(r.status, 200);
  assert.equal(r.body.assessmentId, id);
  assert.deepEqual(r.body.offer, originalOffer);
  assert.equal(r.body.expiresAt, f.draftExpiry.toISOString());
  assert.equal(r.body.assessmentExpiresAt, f.inquiryExpiry.toISOString());
  assert.equal(r.body.firstSurname, "ROJAS");
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].solicitudId, 51);
  assert.equal(f.reads[0].userId, 7, "Usa propietario del borrador y no el administrador que consulta");
});

test("una consulta vencida sin el borrador vinculado sigue vencida", async () => {
  const f = fixture({ row: { userId: 1, sellerId: null } });
  const r = await f.get("platform=IPHONE&documentNumber=1000000001&firstSurname=ROJAS");
  assert.equal(r.status, 410);
  assert.equal(r.body.code, "ASSESSMENT_EXPIRED");
  assert.equal(f.reads.length, 0);
});

test("no conserva aprobación ante vínculo inválido, consumo, otra identidad, plataforma o propietario", async () => {
  for (const [change, status, code] of [
    [{ bound: false }, 409, "ASSESSMENT_DRAFT_NOT_AVAILABLE"],
    [{ authorized: false }, 404, undefined],
    [{ row: { sellerId: 999 } }, 404, undefined],
    [{ resumeIdentity: { firstSurname: "OTRO" } }, 409, "ASSESSMENT_IDENTITY_MISMATCH"],
    [{ row: { platform: "ANDROID" } }, 409, "ASSESSMENT_PLATFORM_MISMATCH"],
    [{ row: { consumedAt: new Date(), creditId: 42 } }, 409, "ASSESSMENT_CONSUMED"],
    [{ documentState: { consumedElsewhere: true } }, 409, "ASSESSMENT_CONSUMED_ELSEWHERE"],
    [{ documentState: { inProgress: true } }, 409, "EVALUATION_IN_PROGRESS"],
  ]) {
    const r = await fixture(change).get();
    assert.equal(r.status, status, JSON.stringify(change));
    assert.equal(r.body.code, code);
    assert.equal(r.body.offer, undefined);
  }
});
