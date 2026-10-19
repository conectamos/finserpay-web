import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const nativeRequire = createRequire(import.meta.url);
const actual = {};
for (const moduleName of ["credit-factory", "credit-client-validation", "credit-client-name",
  "credit-contact-phones", "credit-amortization", "credit-amortization-contract",
  "credit-policy-financial-settings", "credit-current-origination-terms", "signed-credit-close",
  "solicitud-operation-access", "veriff-access", "veriff-identity", "datacredito/policy",
  "credit-imei-confirmation", "datacredito/firmaseguro-identity"])
  actual[`@/lib/${moduleName}`] = await jiti.import(`../lib/${moduleName}.ts`);

const factory = actual["@/lib/credit-factory"];
const policy = actual["@/lib/datacredito/policy"];
const amortization = actual["@/lib/credit-amortization"];
const seals = actual["@/lib/credit-amortization-contract"];
const financial = actual["@/lib/credit-policy-financial-settings"];
const actor = { id: 7, rolNombre: "ADMIN", activo: true, aliadoAccesoCodigo: "ALIADO",
  sedeId: 31, sedeAccesoId: 31, aliadoId: 12, aliadoAccesoId: 12,
  sedeAccesoActiva: true, aliadoAccesoActivo: true };
const assessmentId = "bce3221f-d9f2-4116-ae72-cb6eb24f13b2";
const identity = { names: "MARIA JOSE", firstSurname: "PEREZ", secondSurname: "LOPEZ",
  fullName: "MARIA JOSE PEREZ LOPEZ", nameMode: "COMPONENTS", documentNumber: "001234567",
  documentType: "CEDULA_DE_CIUDADANIA", missing: [] };
const source = readFileSync(path.join(root, "app/api/creditos/route.ts"), "utf8");
const bodyBase = {
  clientePrimerNombre: identity.names, clientePrimerApellido: identity.firstSurname,
  clienteSegundoApellido: identity.secondSurname, clienteNombre: identity.fullName,
  clienteTipoDocumento: identity.documentType, clienteDocumento: identity.documentNumber,
  clienteDireccion: "Calle 1 # 2-3", clienteFechaNacimiento: "1995-05-02",
  clienteFechaExpedicion: "2014-06-03", clienteTelefono: "3001234567",
  clienteCorreo: "fixture@example.invalid", clienteDepartamento: "TOLIMA", clienteCiudad: "IBAGUE",
  clienteGenero: "FEMENINO", clienteEstadoCivil: "SOLTERO", clienteEstrato: "3",
  referenciaFamiliar1Nombre: "ANA LOPEZ", referenciaFamiliar1Parentesco: "Madre", referenciaFamiliar1Telefono: "3011234567",
  referenciaFamiliar2Nombre: "LUIS PEREZ", referenciaFamiliar2Parentesco: "Padre", referenciaFamiliar2Telefono: "3021234567",
  imei: "001234567890123", deviceUid: "001234567890123", valorEquipoTotal: 2_000_000,
  cuotaInicial: 700_000, plazoMeses: 24, dataCreditoAssessmentId: assessmentId,
  veriffValidationId: 56, equipoCatalogoId: 45,
};
const evidence = Object.fromEntries([
  "contratoCedulaFrenteDataUrl", "contratoCedulaRespaldoDataUrl", "iphoneSelfieCedulaDataUrl",
  "fotoEntregaDataUrl", "fotoRemisionDataUrl",
].map((key, index) => [key, `data:image/jpeg;base64,${Buffer.from(`distinct-test-image-${index}`).toString("base64")}`]));

function fixture({ platform = "IPHONE", ownerOverride = {}, changeOwnerAfterLock = false,
  enrollment = true, faceApproved = true, signed = true } = {}) {
  const calls = [];
  let created = null, finalized = false, ownerReads = 0;
  const body = { ...bodyBase, ...evidence, plataformaDispositivo: platform,
    equipoMarca: platform === "IPHONE" ? "IPHONE" : "SAMSUNG",
    equipoModelo: platform === "IPHONE" ? "IPHONE 13 128GB" : "GALAXY A55",
    solicitudId: 90, firmaSeguroPasoContratos: true, firmaSeguroProcessUuid: "test-signature-current" };
  body.referenciaEquipo = `${body.equipoMarca} ${body.equipoModelo}`;
  const settings = { ...policy.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS,
    fianzaCuotaPorcentaje: 75 / 24, cuotaInicialPorcentaje: 30, fianzaPorcentaje: 75,
    plazoCuotas: 24, plazoMaximoCuotas: 48, iphoneTopeFinanciado: 3_500_000, iphoneTopeCuota: 160_000 };
  const params = financial.resolveCreditPolicyFinancialSettings({ globalSettings: settings,
    policyFinancialSettings: policy.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS, numeroCuotas: 24 });
  const firstPayment = factory.resolveActivationFirstPaymentDate({ frequency: "QUINCENAL", activatedAt: new Date() });
  const plan = amortization.calculateFrenchAmortization({ ...params, valorVenta: body.valorEquipoTotal,
    cuotaInicial: body.cuotaInicial, numeroCuotas: 24, frecuenciaPago: "QUINCENAL", fechaPrimerPago: firstPayment.date });
  const seal = seals.createFinancingTermsSeal({ folio: "FC-ALLY-FIXTURE", documento: body.clienteDocumento,
    contrato: { tipoDocumento: body.clienteTipoDocumento, clienteNombre: body.clienteNombre,
      clienteTelefono: body.clienteTelefono, clienteCorreo: body.clienteCorreo, clienteDireccion: body.clienteDireccion,
      equipoMarca: body.equipoMarca, equipoModelo: body.equipoModelo, referenciaEquipo: body.referenciaEquipo, imei: body.imei },
    amortizacion: plan, parametros: { ...params, fianzaFuente: params.fianzaSource, policyVersion: 10, policyRevisionId: "revision-test" } });
  const signature = { id: 19, processUuid: body.firmaSeguroProcessUuid, draftId: 90, creditoId: null,
    status: signed ? "COMPLETED" : "PENDING", completedAt: signed ? new Date() : null,
    signedDocumentBase64: signed ? "original-signed-document" : null,
    signedDocumentFileName: "contrato-original.pdf", draftFolio: seal.snapshot.folio,
    draftPayload: { ...body, financialTermsSeal: seal } };
  const owner = { id: 90, usuarioId: actor.id, vendedorId: null, sedeId: actor.sedeId, aliadoId: actor.aliadoId,
    estado: "ABIERTO", imei: body.imei, plataforma: platform, clienteDocumento: body.clienteDocumento,
    dataCreditoAssessmentId: assessmentId, ...ownerOverride };
  const assessment = { id: assessmentId, status: "APPROVED", policyVersion: 10, policyRevisionId: "revision-test",
    providerEnvironment: "production", offer: { initialPaymentPercentage: 30, suretyPercentage: 75,
      maxFinancedAmount: 3_500_000, installmentCount: 24,
      maxInstallmentAmount: platform === "IPHONE" ? 160_000 : null,
      financialSettings: policy.DEFAULT_ARES_POLICY_FINANCIAL_SETTINGS } };
  const veriff = { id: 56, draftId: 90, creditoId: null, usuarioId: actor.id, vendedorId: null,
    sedeId: actor.sedeId, aliadoId: actor.aliadoId, clienteDocumento: body.clienteDocumento,
    status: faceApproved ? "APPROVED" : "PENDING", decision: faceApproved ? "approved" : null,
    decisionPayload: { documentNumber: body.clienteDocumento }, webhookPayload: null };
  const database = {
    credito: {
      findFirst: async () => null,
      findUnique: async ({ where }) => where.id ? created : null,
      create: async ({ data }) => { assert.equal(created, null, "one credit per request");
        created = { ...data, id: 92, createdAt: new Date() }; calls.push("create"); return created; },
    },
    $queryRawUnsafe: async sql => {
      if (sql.includes('FROM "VeriffIdentityValidation"')) return [veriff];
      throw new Error(`Unexpected database operation: ${sql.slice(0,120)}`);
    },
  };
  const noSideEffect = name => async () => { calls.push(name); };
  const dependencies = {
    ...actual,
    "next/server": { NextResponse: { json: (data, init) => Response.json(data, init) },
      after: () => assert.fail("No real welcome scheduling") },
    "@/lib/auth": { getSessionUser: async () => actor },
    "@/lib/roles": { isAdminRole: role => role === "ADMIN" },
    "@/lib/aliados": { isFinserPayCentralAlly: code => code === "FINSERPAY" },
    "@/lib/seller-auth": { getSellerSessionUser: async () => assert.fail("Ally admin is not a seller") },
    "@/lib/prisma": { __esModule: true, default: { ...database, $transaction: async work => { calls.push("transaction"); return work(database); } } },
    "@/lib/solicitudes-storage": {
      getActiveSolicitudCreditContext: async () => {
        if (finalized) return null;
        ownerReads += 1;
        return changeOwnerAfterLock && ownerReads >= 2 ? { ...owner, usuarioId: 999 } : owner;
      },
      ensureSolicitudSchema: async () => {},
      reserveSolicitudForIdentity: async input => {
        assert.equal(input.usuarioId, actor.id); assert.equal(input.vendedorId, null);
        assert.equal(input.sedeId, actor.sedeId); calls.push("reserve-own"); return { id: 90 };
      },
      completeSolicitudForCredit: async input => {
        assert.equal(input.usuarioId, actor.id); assert.equal(input.vendedorId, null);
        assert.equal(input.sedeId, actor.sedeId); assert.equal(input.creditoId, 92);
        calls.push("finalize-own"); finalized = true; return 90;
      }, ActiveSolicitudConflictError: class extends Error {},
    },
    "@/lib/firmaseguro-storage": {
      getFirmaSeguroProcessByUuid: async () => signature,
      getLatestFirmaSeguroProcessByDraft: async () => signature,
      hasFirmaSeguroDraftWorkflowStarted: async () => true,
      tryAcquireSolicitudOperationLock: async () => { calls.push("request-lock"); return { release: noSideEffect("release-request-lock") }; },
    },
    "@/lib/firmaseguro-credit": {
      linkFirmaSeguroProcessForCredit: async (uuid, creditId, draftId) => {
        assert.equal(uuid, signature.processUuid); assert.equal(creditId, 92); assert.equal(draftId, 90);
        calls.push("link-signature"); return signature;
      }, markCreditoFirmaSeguroCompleted: async () => true,
      refreshFirmaSeguroProcess: async () => signature,
    },
    "@/lib/credit-imei-confirmation-storage": { requireDraftImeiConfirmation: noSideEffect("check-current-imei") },
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: noSideEffect("blacklist") },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/second-credit-authorization": { ensureSecondCreditAuthorizationSchema: async () => {},
      assertSecondCreditEligibility: noSideEffect("eligibility"), SecondCreditAuthorizationError: class extends Error {} },
    "@/lib/credit-device-replacement-storage": { ensureCreditDeviceReplacementSchema: async () => {},
      lockCreditDeviceReplacementImeiForCreditCreation: noSideEffect("device-lock"), CreditDeviceReplacementError: class extends Error {} },
    "@/lib/equipment-catalog": {
      findEquipmentCatalogItemById: async () => ({ id: 45, marca: body.equipoMarca, modelo: body.equipoModelo, precioBaseVenta: 2_000_000, activo: true }),
    },
    "@/lib/credit-settings": { getEffectiveCreditSettings: async () => ({ globalSettings: settings }) },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, configured: true, productionReady: true, environment: "production" }) },
    "@/lib/datacredito/customer-identity": {
      getScopedDataCreditoQueryIdentity: async (_id, scope) => {
        assert.equal(scope.userId, actor.id); assert.equal(scope.sellerId, null); assert.equal(scope.aliadoId, actor.aliadoId);
        return { querySurname: identity.firstSurname, assessment };
      }, getDataCreditoCustomerIdentityForDisplay: async () => ({ original: identity, effective: identity, querySurname: identity.firstSurname }),
      enforceDataCreditoCustomerIdentity: async () => ({ original: identity, effective: identity, querySurname: identity.firstSurname }),
    },
    "@/lib/datacredito/storage": {
      isDataCreditoAuditConfigured: () => true,
      getApprovedDataCreditoAssessmentForCredit: async scope => {
        assert.equal(scope.userId, actor.id); assert.equal(scope.sellerId, null); calls.push("approved-assessment"); return assessment;
      },
      claimDataCreditoAssessment: async () => ({ assessment, claimToken: "claim-test" }),
      consumeDataCreditoAssessment: async () => { calls.push("consume-assessment"); return true; },
      releaseDataCreditoAssessment: noSideEffect("release-assessment"),
    },
    "@/lib/datacredito/manual-credit-limits": { resolveDataCreditoManualCreditLimit: async () => ({ maxFinancedAmount: 3_500_000, source: "POLICY" }) },
    "@/lib/iphone-delivery-evidence": { sanitizeIphoneDeliveryEvidenceDataUrl: async value => factory.sanitizeImageDataUrl(value) },
    "@/lib/iphone-enrollment-storage": { getIphoneEnrollmentReviewForSolicitud: async () => enrollment ? {
      id: 10, decision: "APPROVED", approvedAt: new Date(), analystName: "Analista fixture" } : null },
    "@/lib/veriff": { isVeriffRequired: () => true, getVeriffPublicSummary: () => ({ configured: true }),
      extractVeriffIdentityData: () => ({ documentNumber: identity.documentNumber }),
      extractVeriffIdentityDocumentEvidence: value => value ? { personNumbers: [identity.documentNumber],
        documents: [{ number: identity.documentNumber, type: "id_card", country: "CO" }] } : null },
    "@/lib/veriff-storage": { getVeriffValidationById: async () => veriff,
      isVeriffApproved: row => row.status === "APPROVED", buildVeriffSnapshot: row => row ? { id: row.id, status: row.status } : null,
      lockVeriffDraftAttempts: noSideEffect("identity-lock"),
      linkVeriffValidationToCredit: async () => { calls.push("link-identity"); return veriff; } },
    "@/lib/equality-zero-touch": { isEqualityConfigured: () => platform === "ANDROID",
      uploadEqualityInventoryDevice: noSideEffect("equality-upload-mock"),
      activateEqualityFinancingService: noSideEffect("equality-activate-mock"),
      queryEqualityDevices: async () => { calls.push("equality-query-mock"); return { fixture: true }; },
    },
    "@/lib/equality-device-meta": { getPayloadSummary: () => ({ configured: true }),
      getEqualityDeviceMeta: () => ({ deliveryStatus: { ready: true, label: "Entregable" }, deviceState: "ACTIVE" }) },
    "@/lib/credit-amortization-storage": { ensureCreditAmortizationSchema: async () => {}, persistCreditAmortization: async (_db, _id, persistedPlan) => {
      assert.equal(persistedPlan.numeroCuotas, 24); calls.push("persist-plan"); } },
    "@/lib/credit-welcome-voice-store": { enqueueCreditWelcomeVoice: async () => null },
    "@/lib/dapta-welcome": { sendDaptaWelcome: async () => { calls.push("welcome-mock"); return "disabled"; } },
  };
  const debug = [];
  const unexpected = new Proxy({}, { get(_target, name) {
    if (name === "__esModule") return true;
    return () => { debug.push(`Unexpected mocked dependency: ${String(name)}`); throw new Error(`Unexpected mocked dependency: ${String(name)}`); };
  } });
  const testModule = { exports: {} };
  runInNewContext(ts.transpileModule(source.replace('console.error("ERROR CREANDO CREDITO:", {', 'console.error("ERROR CREANDO CREDITO:", error.stack, {') + `\n
    serializeCredit = item => item;
    redactCreditForNonAdmin = item => ({ id: item.id, folio: item.folio, usuarioId: item.usuarioId, vendedorId: item.vendedorId, sedeId: item.sedeId });
    getFinalizedSolicitudCreditContext = async () => __finalizedSolicitud();
  `, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    module: testModule, exports: testModule.exports, Request, Response, URL, Headers, Buffer, Date,
    process: { env: { NODE_ENV: "test" } },
    console: { error: (...args) => debug.push(args), warn: (...args) => debug.push(args) },
    __finalizedSolicitud: () => finalized ? { ...owner, creditoId: 92 } : null,
    require: name => name.startsWith("node:") ? nativeRequire(name) : dependencies[name] || unexpected,
  });
  return { body, seal, calls, debug, get credit() { return created; }, async send(override = {}) {
    const response = await testModule.exports.POST(new Request("https://test.invalid/api/creditos", {
      method: "POST", body: JSON.stringify({ ...body, ...override }) }));
    const data = await response.json(); return { status: response.status, data };
  } };
}

for (const platform of ["IPHONE", "ANDROID"]) test(`POST completo ${platform}: administrador aliado cierra su venta firmada y conserva titular, sello y cinco evidencias`, async () => {
  const f = fixture({ platform }); const result = await f.send();
  assert.equal(result.status, 200, JSON.stringify({ result, debug: f.debug }));
  assert.equal(result.data.solicitud.creditoId, 92);
  assert.equal(f.credit.usuarioId, actor.id); assert.equal(f.credit.vendedorId, null); assert.equal(f.credit.sedeId, actor.sedeId);
  assert.equal(f.credit.contratoSnapshot.financiero.selloFinanciero.checksum, f.seal.checksum);
  for (const field of Object.keys(evidence)) assert.equal(f.credit[field], evidence[field], field);
  for (const operation of ["approved-assessment", "request-lock", "check-current-imei", "eligibility", "identity-lock",
    "link-identity", "link-signature", "persist-plan", "consume-assessment", "finalize-own"])
    assert.ok(f.calls.includes(operation), operation);
  const before = f.calls.slice(); const replay = await f.send();
  assert.equal(replay.status, 200); assert.equal(replay.data.recovered, true);
  assert.deepEqual(f.calls, before, "a retry only reads the existing credit");
  assert.equal(f.calls.filter(item => item === "create").length, 1);
  if (platform === "ANDROID") for (const operation of ["equality-upload-mock", "equality-activate-mock", "equality-query-mock"])
    assert.ok(f.calls.includes(operation), operation);
});

test("el cierre completo revalida titular bajo lock y no crea tras reasignación", async () => {
  const f = fixture({ changeOwnerAfterLock: true }); const result = await f.send();
  assert.equal(result.status, 409); assert.equal(f.credit, null);
  assert.ok(f.calls.includes("release-request-lock")); assert.ok(!f.calls.includes("consume-assessment"));
});

test("ser administrador aliado no omite identidad aprobada, enrolamiento ni las cinco fotografías", async () => {
  for (const options of [{ faceApproved: false }, { enrollment: false }, { signed: false }]) {
    const f = fixture(options); const result = await f.send();
    assert.ok([400,409].includes(result.status), JSON.stringify({ options, result, debug: f.debug }));
    assert.equal(f.credit, null);
  }
  const f = fixture(); const result = await f.send({ fotoEntregaDataUrl: "" });
  assert.equal(result.status, 400, JSON.stringify({ result, debug: f.debug })); assert.equal(f.credit, null);
});
