import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createJiti } from "jiti";
import ts from "typescript";
import { loadReissueModule, seals } from "./credit-approval-reissue-fixture.mjs";

// One persisted request crosses the production identity, wizard save, Veriff,
// signature ledger/callback and closing-storage boundaries. External provider
// I/O, session authentication and unrelated financial settings are fixtures.
// This is not a browser/HTTP credit-creation test, nor a multi-connection race.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const modules = [];
for (const file of [
  "datacredito/identity", "solicitudes", "credit-factory", "credit-amortization",
  "credit-contact-phones", "delivery-evidence-draft", "veriff", "veriff-identity",
  "firmaseguro", "datacredito/firmaseguro-identity", "firmaseguro-folio-pdf", "signed-credit-close",
]) modules.push(await jiti.import(`../lib/${file}.ts`));
const [identity, canonical, factory, amortization, phones, evidence, veriffCore,
  veriffIdentity, firmaCore, firmaIdentity, pdf, signedClose] = modules;
const read = file => readFileSync(path.join(root, file), "utf8");
const unexpectedNetwork = () => assert.fail("This regression test must never access a live provider");
const load = (file, dependencies, globals) => loadReissueModule(file, dependencies,
  { Error, fetch: unexpectedNetwork, ...globals });
function evaluate(source, globals = {}) {
  const module = { exports: {} };
  runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, Error, Buffer, Date, AbortController,
    ...globals, require: name => assert.fail(`Unexpected dependency: ${name}`) });
  return module.exports;
}
function section(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}
function declarations(file, names) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return names.map(name => {
    let found;
    function visit(node) {
      if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(ast) === name) found = node;
      ts.forEachChild(node, visit);
    }
    visit(ast); assert.ok(found, name);
    if (ts.isFunctionDeclaration(found)) return found.getText(ast).replace(/^export /, "");
    const value = found.initializer;
    return `const ${name} = ${(ts.isCallExpression(value) && value.expression.getText(ast) === "useCallback" ? value.arguments[0] : value).getText(ast)};`;
  }).join("\n");
}
const dataCorrections = load("lib/approval-request-correction-core.ts", {
  "./credit-client-name": load("lib/credit-client-name.ts"),
  "./credit-contact-phones": phones,
});
const statuses = load("lib/firmaseguro-status.ts");
const blacklistLocks = load("lib/solicitud-blacklist-locks.ts", {
  "@/lib/document-blacklist-core": load("lib/document-blacklist-core.ts"),
});
const assessmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const documentNumber = "1110178524";
const fullName = "María del Mar  De la Peña Muñoz del Río";
const scope = { userId: 4, sellerId: 8, sedeId: 3, aliadoId: 7 };
const draftId = 2887; // Synthetic ID: this test does not read the production request.
const imei = "123456789012345";

async function fixture(t, providerType) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (4);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (3,7);
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "clienteNombre" TEXT,
      "clienteDocumento" TEXT, "contratoSnapshot" JSONB);
    CREATE TABLE "DataCreditoAssessment" ("id" UUID PRIMARY KEY, "status" TEXT);
    INSERT INTO "DataCreditoAssessment" VALUES ('${assessmentId}', 'APROBADO');
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "usuarioId" INTEGER, "vendedorId" INTEGER,
      "sedeId" INTEGER, "currentStep" INTEGER DEFAULT 1, "clienteNombre" TEXT,
      "clienteDocumento" TEXT, "clienteTelefono" TEXT, "imei" TEXT,
      "plataforma" TEXT DEFAULT 'IPHONE', "dataCreditoAssessmentId" UUID,
      "payload" JSONB, "estado" TEXT DEFAULT 'ABIERTO', "creditoId" INTEGER,
      "closedReason" TEXT, "closedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP + INTERVAL '15 days'
    );
  `);
  const adapter = connection => ({
    $queryRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await connection.query(sql, values)).affectedRows,
  });
  const prisma = { ...adapter(db),
    $transaction: callback => db.transaction(connection => callback(adapter(connection))) };
  let trustedVeriff = true;
  const veriff = load("lib/veriff-storage.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/veriff-identity": veriffIdentity,
    "@/lib/veriff": { ...veriffCore, areVeriffDecisionsTrusted: () => trustedVeriff },
  });
  const firmaStorage = load("lib/firmaseguro-storage.ts", {
    "@/lib/prisma": { default: prisma },
    pg: { Client: class { constructor() { unexpectedNetwork(); } } },
  });
  await veriff.ensureVeriffSchema(); await firmaStorage.ensureFirmaSeguroSchema();
  const providerPayload = { content: { respuesta: { validacion: { datosBasicos: {
    conInformacion: true, nombreCompleto: fullName,
    numeroDocumento: Number(documentNumber), tipoDocumento: providerType,
  } } } } };
  let sourceReads = 0;
  const customer = load("lib/datacredito/customer-identity.ts", {
    "@/lib/prisma": { default: prisma }, "./identity": identity,
    "./storage": {
      getDataCreditoAssessmentById: async id => (await db.query('SELECT * FROM "DataCreditoAssessment" WHERE "id"=$1::uuid', [id])).rows[0],
      dataCreditoAssessmentMatchesScope: (_row, input) => Object.entries(scope).every(([key, value]) => input[key] === value),
      readDataCreditoIdentitySource: async () => { sourceReads++; return {
        documentNumber, firstSurname: "PATINO", providerPayload,
      }; },
    },
  });
  let ledger;
  const review = load("lib/datacredito/firmaseguro-identity-review.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/solicitudes-storage": { ensureSolicitudSchema: async () => {} },
    "@/lib/firmaseguro-storage": firmaStorage,
    "@/lib/firmaseguro-status": statuses,
    "@/lib/firmaseguro": firmaCore,
    "@/lib/firmaseguro-draft-dispatch-ledger": { getUnresolvedDraftDispatch: (...args) => ledger?.getUnresolvedDraftDispatch(...args) || null },
    "@/lib/veriff-storage": veriff, "@/lib/veriff": veriffCore, "@/lib/veriff-identity": veriffIdentity,
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, environment: "production" }) },
    "./storage": { getApprovedDataCreditoAssessmentForCredit: async input => input.assessmentId === assessmentId && input.documentNumber === documentNumber ? { id: assessmentId } : null },
    "./customer-identity": customer, "./firmaseguro-identity": firmaIdentity,
  });
  const bridge = load("lib/datacredito/firmaseguro-identity-server.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/veriff": veriffCore,
    "@/lib/veriff-storage": veriff, "@/lib/veriff-identity": veriffIdentity,
    "./firmaseguro-identity": firmaIdentity, "./firmaseguro-identity-review": review,
  });
  const storageSource = read("lib/solicitudes-storage.ts");
  const selectedStorage = section(storageSource, "function sameOwner(", "async function lockIdentity(") + "\n" +
    section(storageSource, "const FIRMASEGURO_SIGNED_DRAFT_FIELDS =", "function imeiReissueSignedAt(") + "\n" +
    section(storageSource, "function firmaSeguroTermsAreLocked(", "type BlockingSolicitudIdentityRow") + "\n" +
    section(storageSource, "export async function saveSolicitudDraft(", "export class SolicitudDataCreditoLinkError") + "\n" +
    section(storageSource, "export async function completeSolicitudForCredit(", "function addWhere(");
  const requestsStorage = evaluate(selectedStorage, {
    prisma, ...canonical, ...dataCorrections, ...blacklistLocks, ...evidence,
    normalizeDigits: value => String(value || "").replace(/\D/g, ""),
    normalizePlatform: value => value || null,
    normalizeDraftStep: (value, fallback = 1) => value == null ? fallback : Math.max(1, Math.min(5, Number(value))),
    isUuid: value => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value),
    isCompleteImei: value => /^\d{15}$/.test(String(value || "")),
    ensureSolicitudSchema: async () => {}, ...firmaStorage,
    expireStaleWith: async () => {}, assertDocumentNotBlacklisted: async () => {},
    assertImeiNotReservedByActiveDeviceReplacement: async () => {},
    lockIdentity: async () => {}, getUnresolvedDraftDispatch: (...args) => ledger?.getUnresolvedDraftDispatch(...args) || null,
    supersedeLowerPrioritySameOwnerDrafts: async () => 0, findActiveByIdentity: async () => null,
    preserveAnalystFinancialCorrectionAutosave: (_stored, payload) => payload,
    preserveAnalystEvidenceCorrectionAutosave: (_stored, payload) => payload,
    imeiReissueSignedAt: () => null, isFirmaSeguroSuccessfulStatus: statuses.isFirmaSeguroSuccessfulStatus,
    isFirmaSeguroFailedStatus: statuses.isFirmaSeguroFailedStatus,
  });
  const row = async () => ({ ...(await db.query('SELECT * FROM "CreditoBorrador" WHERE "id"=$1', [draftId])).rows[0], sedeAliadoId: scope.aliadoId });
  const storedPayload = {
    solicitudOrigen: "DATACREDITO", dataCreditoAssessmentId: assessmentId,
    clienteDocumento: documentNumber, clienteTipoDocumento: "CEDULA_DE_CIUDADANIA",
    clienteNombre: "PATINO", clientePrimerNombre: "", clientePrimerApellido: "PATINO", clienteSegundoApellido: "",
    clienteTelefono: "3001234567", clienteCorreo: "cliente@example.invalid", clienteDireccion: "Calle 1 # 2-3",
    referenciaFamiliar1Nombre: "Ana", referenciaFamiliar1Telefono: "3101234567", referenciaFamiliar2Telefono: "3201234567",
    equipoMarca: "Apple", equipoModelo: "iPhone 15", plataformaDispositivo: "IPHONE", imei, deviceUid: imei,
    valorEquipoTotal: "1500000", cuotaInicial: "300000", plazoMeses: "12", frecuenciaPago: "MENSUAL", wizardStep: 1,
  };
  await db.query(`INSERT INTO "CreditoBorrador" ("id","usuarioId","vendedorId","sedeId",
    "clienteDocumento","clienteNombre","clienteTelefono","imei","dataCreditoAssessmentId","payload")
    VALUES ($1,4,8,3,$2,'PATINO',$3,$4,$5::uuid,$6::jsonb)`,
  [draftId, documentNumber, storedPayload.clienteTelefono, imei, assessmentId, JSON.stringify(storedPayload)]);
  async function save(payload, step, payloadScope = "FULL") {
    const recovered = await customer.enforceDataCreditoCustomerIdentity(payload, scope);
    await requestsStorage.saveSolicitudDraft({
      id: draftId, usuarioId: 4, vendedorId: 8, sedeId: 3, currentStep: step,
      clienteDocumento: payload.clienteDocumento, clienteNombre: payload.clienteNombre,
      clienteTelefono: payload.clienteTelefono, imei, plataforma: "IPHONE", payload,
      dataCreditoAssessmentId: assessmentId, verifiedDataCreditoFirstSurname: recovered.effective.firstSurname,
      payloadScope,
    });
    return row();
  }
  const builder = evaluate(read("lib/firmaseguro-draft-credit-builder.ts").replace(/^import\b[^;]*;\r?\n/gm, ""), {
    process, ...factory, ...amortization, ...phones, ...customer, ...bridge, ...firmaIdentity,
    getDataCreditoPublicConfig: () => ({ enabled: false }),
    getEffectiveCreditSettings: async () => ({ globalSettings: {
      cuotaInicialPorcentaje: 20, iphoneTopeFinanciado: 3500000, iphoneTopeCuota: 160000, plazoCuotas: 12, plazoMaximoCuotas: 48,
    } }),
    findEquipmentCatalogItem: async () => null, findEquipmentCatalogItemById: async () => null,
    resolveCreditPolicyFinancialSettings: () => ({ calculoVersion: "ARES_FRANCES_V2", tasaPeriodoDecimales: 6,
      redondeoComercial: { modo: "PISO", multiplo: 50 }, tasaInteresEa: 20,
      fianzaCuotaPorcentaje: 0, fianzaTotalPorcentaje: 0, fianzaModalidad: "TOTAL_CREDITO", fianzaSource: "GLOBAL",
      seguroCuotaPorcentaje: 0, frecuenciaPago: "MENSUAL" }),
    hasCurrentCreditOriginationTerms: () => true,
  });
  let sends = 0; const sentPayloads = []; const processUuid = randomUUID();
  const signedPdf = Buffer.from("%PDF-1.4\nSIMULATED SIGNED RESULT\n%%EOF").toString("base64");
  const firmaProvider = {
    ...firmaCore, isFirmaSeguroConfigured: () => true,
    buildFirmaSeguroCallbackUrl: () => "https://example.invalid/api/firma-seguro/callback",
    getFirmaSeguroConfig: () => ({ email: "sender@example.invalid", callbackSecret: "test-secret",
      nit: null, useCompanyEndpoint: false, processTypeId: 1, signatureMethodId: 1, authMethodId: 1,
      balanceTypeId: 1, identificationTypeId: 1, typePersonId: 1, deadlineDays: 7,
      notifyByEmail: false, notifyByWhatsApp: true }),
    firmaSeguroSignIn: async () => ({ token: "mock-token" }),
    firmaSeguroGetAuthenticationTypes: async () => [{ id: 1, name: "OTP WhatsApp" }],
    firmaSeguroCreateFull: async (token, payload, options) => {
      assert.equal(token, "mock-token"); assert.equal(options.retryAuthorization, false);
      sends++; sentPayloads.push(payload); return { uuid: processUuid, status: "CREATED" };
    },
    firmaSeguroCreateFullByCompany: unexpectedNetwork,
    firmaSeguroGetProcessStatus: async () => ({ uuid: processUuid, status: "COMPLETED" }),
    firmaSeguroGetSignaturesStatus: async () => ({ status: "COMPLETED" }),
    firmaSeguroGetDocumentsByUuid: async () => ({ base64: signedPdf, fileName: "signed-fixture.pdf" }),
    firmaSeguroGetDocumentByUuid: unexpectedNetwork, firmaSeguroGetAuraQuanticDocumentByUuid: unexpectedNetwork,
  };
  const firmaCredit = load("lib/firmaseguro-credit.ts", {
    "@/lib/datacredito/firmaseguro-identity": firmaIdentity, "@/lib/datacredito/identity": identity,
    "@/lib/auth": {}, "@/lib/aliados": {}, "@/lib/credit-route-lookup": {},
    "@/lib/firmaseguro": firmaProvider, "@/lib/firmaseguro-folio-pdf": pdf,
    "@/lib/firmaseguro-storage": firmaStorage, "@/lib/prisma": { default: prisma },
    "@/lib/roles": {}, "@/lib/seller-auth": {},
    "@/lib/approval-operational-signature-complete": {}, "@/lib/approval-initial-signature": {},
  });
  ledger = load("lib/firmaseguro-draft-dispatch-ledger.ts", {
    "@/lib/approval-operations-core": load("lib/approval-operations-core.ts"),
    "@/lib/approval-request-correction-core": dataCorrections,
    "@/lib/firmaseguro-draft-client-correction-frozen": { verifiesFrozenClientCorrectionSource: () => false },
    "@/lib/prisma": { default: prisma }, "@/lib/firmaseguro-storage": firmaStorage,
    "@/lib/firmaseguro-credit": firmaCredit, "@/lib/firmaseguro": firmaProvider,
    "@/lib/firmaseguro-status": statuses, "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true }) },
    "@/lib/veriff": { isVeriffRequired: () => true }, "@/lib/veriff-storage": veriff,
    "@/lib/credit-amortization-contract": seals, "@/lib/credit-factory": factory,
    "@/lib/firmaseguro-draft-frozen": { readFrozenCorrectionDateSource: () => null, verifiesFrozenCorrectionDateSource: () => false },
    "@/lib/ventas-utils": { getTodayBogotaDateKey: () => new Date().toISOString().slice(0, 10) },
    "@/lib/approval-operations-schema": { ensureApprovalOperationalSchema: async () => {} },
  });
  await ledger.ensureDraftDispatchSchema();
  const callback = load("app/api/firma-seguro/callback/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/firmaseguro": firmaProvider, "@/lib/firmaseguro-credit": firmaCredit,
    "@/lib/firmaseguro-storage": firmaStorage, "@/lib/firmaseguro-draft-dispatch-ledger": ledger,
  });
  const guardCode = declarations("app/api/creditos/borradores/[id]/firma-seguro/route.ts", ["payloadObject", "requireApprovedVeriffBeforeFirmaSeguro"]);
  const guard = evaluate(guardCode + "\nmodule.exports = requireApprovedVeriffBeforeFirmaSeguro;", {
    ...factory, ...veriffCore, ...veriffIdentity, ...veriff, ...builder, prisma,
    getDataCreditoPublicConfig: () => ({ enabled: true }),
  });
  return { db, prisma, row, save, requestsStorage, storedPayload, customer, veriff, bridge, builder,
    firmaStorage, firmaCredit, ledger, callback, guard, signedPdf, processUuid, sentPayloads,
    sourceReads: () => sourceReads, sends: () => sends, trustVeriff: value => { trustedVeriff = value; } };
}

function wizard(f, payload, step = 1) {
  const names = ["serializeCreditDraftSaveRequest", "formatCreditDraftSaveError", "cancelPendingDraftAutosave",
    "saveDraftPayloadForVeriff", "saveCurrentDraft", "clampWizardStep", "persistWizardStep", "goToStep", "advanceToStep"];
  const code = declarations("app/dashboard/creditos/credit-factory-console.tsx", names);
  const requests = [];
  const context = {
    Error, AbortController, JSON, draftId, wizardStep: step, createClientMode: true, simulatorMode: false, deliveryMode: false,
    factoryDraftPayload: payload, currentIphoneClosureFingerprint: "closure", canAdminMoveFreelyInFactory: false,
    nextFactoryStep: { id: 2 }, draftSaveConflictFingerprintRef: { current: null }, draftSaveTimerRef: { current: null },
    draftSaveGenerationRef: { current: 0 }, draftSaveAbortControllerRef: { current: null },
    wizardStepTransitionInFlightRef: { current: false }, wizardStepTransitioning: false, activeSolicitudRedirectingRef: { current: false },
    draftResumeHydrationRef: { current: false }, draftResumeHydrating: false, draftResumeLoadFailed: false, applyingDraftRef: { current: false },
    firmaSeguroDraftCorrectionPending: false, firmaSeguroProcessSent: false, firmaSeguroProcessSigned: false,
    signedContractEditLocked: false, advisorSignedContractStep: 5,
    analystDataSnapshotRef: { current: {} }, analystFinancialSnapshotRef: { current: { draftId } }, analystEvidenceSnapshotRef: { current: {} },
    replaceDraftInUrl() {}, synchronizeAnalystDraftData() {}, resumeActiveSolicitudFromConflict: () => false,
    ACTIVE_SOLICITUD_RESUME_MESSAGE: "Retomando solicitud", DRAFT_REQUIRES_DATACREDITO_CODE: "SOLICITUD_REQUIERE_CONSULTA_DATACREDITO",
    dataCreditoVeriffDocumentRejected: false, stepEquipoReady: true, iphoneInstallmentLimitExceeded: false,
    FLEXIBLE_WIZARD_FOR_TESTING: false, contactPhoneValidation: { ok: true }, stepClienteReady: true,
    hideIdentityWizardStep: true, stepContratoReady: true, stepIdentityContractReady: true, identityStepReady: true,
    veriffRequired: true, veriffApproved: true, contractEvidenceReady: true, pagareAceptado: true,
    nextVisibleWizardStep: value => ({ 1: 2, 2: 4, 4: 5, 5: 5 }[value]), focusFirstInvalidClientField() {},
    window: { clearTimeout() {} },
    requestJson: async (url, options) => {
      assert.equal(url, "/api/creditos/borradores");
      const body = JSON.parse(options.body); requests.push(body);
      try {
        const item = await f.save(body.payload, body.currentStep, body.payloadScope);
        return { ok: true, status: 200, data: { item } };
      } catch (error) { context.transportError = error; throw error; }
    },
  };
  for (const name of new Set(code.match(/\bset[A-Z]\w+/g) || [])) context[name] = value => {
    const key = name[3].toLowerCase() + name.slice(4);
    context[key] = typeof value === "function" ? value(context[key]) : value;
  };
  context.module = { exports: {} }; context.exports = context.module.exports;
  runInNewContext(ts.transpileModule(code + `\nmodule.exports = {${names.join(",")}};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, requests, actions: context.module.exports };
}

test("same approved CC survives legacy saves, trusted Veriff, one mocked signature and closing without changing the whole name", async t => {
  for (const providerType of [1, "  cédula de ciudadanía  "]) await t.test(String(providerType), async t => {
    const f = await fixture(t, providerType);
    // Legacy query surname is replaced by the whole provider name, not promoted
    // to a verified surname. Repeated page saves keep a single persisted request.
    let ui = wizard(f, { ...f.storedPayload });
    await ui.actions.advanceToStep(2);
    assert.equal(ui.context.draftStatus, "saved", ui.context.transportError?.stack || ui.context.draftErrorMessage);
    let saved = await f.row();
    assert.equal(saved.currentStep, 2); assert.equal(saved.clienteNombre, fullName);
    assert.equal(saved.payload.clientePrimerApellido ?? "", "");
    assert.equal(saved.payload.clienteTipoDocumento, "CEDULA_DE_CIUDADANIA");
    assert.equal(saved.payload.clienteDocumento, documentNumber);
    assert.equal(saved.payload.clienteTelefono, f.storedPayload.clienteTelefono);
    assert.equal(saved.payload.referenciaFamiliar1Nombre, "Ana");
    ui = wizard(f, { ...saved.payload }, 2); // Real save callbacks after reload.
    await ui.actions.goToStep(1); await ui.actions.advanceToStep(2); await ui.actions.advanceToStep(4);
    assert.equal((await f.row()).currentStep, 4);
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "CreditoBorrador"')).rows[0].n, 1);
    assert.equal(f.sends(), 0);
    const strictPayload = { ...(await f.row()).payload };
    const recovered = await f.customer.enforceDataCreditoCustomerIdentityForVeriff(strictPayload, scope);
    assert.equal(recovered.original.fullName, fullName); assert.equal(recovered.original.documentNumber, documentNumber);
    assert.equal(recovered.original.documentType, "CEDULA_DE_CIUDADANIA");
    await assert.rejects(f.customer.enforceDataCreditoCustomerIdentityForVeriff({ ...strictPayload, clienteDocumento: "999999999" }, scope), /DOCUMENT_MISMATCH/);
    await assert.rejects(f.customer.enforceDataCreditoCustomerIdentityForVeriff({ ...strictPayload, clienteTipoDocumento: "PASAPORTE" }, scope), /LOCKED_FIELDS/);
    await assert.rejects(f.customer.enforceDataCreditoCustomerIdentityForVeriff(strictPayload, { ...scope, sedeId: 99 }), /UNAUTHORIZED/);

    const sessionInput = { draftId, clienteDocumento: documentNumber, clienteNombre: fullName,
      usuarioId: 4, vendedorId: 8, sedeId: 3, aliadoId: 7, captureToken: randomUUID() };
    const created = await f.veriff.createVeriffValidation(sessionInput);
    assert.equal(created.created, true);
    const reused = await f.veriff.createVeriffValidation(sessionInput);
    assert.equal(reused.created, false); assert.equal(reused.row.id, created.row.id);
    const validationId = created.row.id;
    const decision = { status: "success", verification: { id: "mock-session", status: "approved", code: 9001,
      person: { idNumber: documentNumber, firstName: "María del Mar", lastName: "De la Peña Muñoz del Río" },
      document: { number: documentNumber, type: "ID_CARD", country: "CO" },
    } };
    await f.veriff.updateVeriffValidationFromDecision(validationId, decision, "decisionPayload");
    await f.veriff.updateVeriffValidationFromDecision(validationId, decision, "decisionPayload");
    const approved = await f.veriff.getVeriffValidationById(validationId);
    assert.equal(f.veriff.isVeriffApproved(approved), true);
    assert.equal(f.veriff.serializeVeriffValidation(approved).identityDocumentStatus, "match");
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "VeriffIdentityValidationEvent"')).rows[0].n, 1);
    saved = await f.save({ ...(await f.row()).payload, veriffValidationId: validationId }, 4);
    f.trustVeriff(false); await assert.rejects(f.guard(saved)); f.trustVeriff(true); await f.guard(saved);
    const metadata = await f.bridge.getFirmaSeguroFullNameIdentityForDraft({ fullName, documentNumber, validationId, draftId });
    assert.equal(metadata.source, "VERIFF"); assert.equal(metadata.canonicalFullName, fullName);
    assert.equal(metadata.firstName, "María del Mar"); assert.equal(metadata.firstLastName, "De la Peña Muñoz del Río");

    const built = await f.builder.buildDraftCredit(saved, { requireFirmaSeguroIdentity: true });
    assert.equal(built.credit.clienteNombre, fullName);
    assert.equal(built.credit.clientePrimerApellido, "");
    const seal = seals.createFinancingTermsSeal({ folio: built.credit.folio, documento: documentNumber,
      contrato: { ...built.credit, tipoDocumento: built.credit.clienteTipoDocumento },
      amortizacion: built.amortizationPlan, parametros: built.financingParameters });
    const sealedName = fullName.replace(/\s+/g, " ").toUpperCase();
    assert.equal(seal.snapshot.clienteNombre, sealedName);
    built.credit.contratoSnapshot.financiero.selloFinanciero = seal;
    const contractPdf = await pdf.buildFirmaSeguroCreditPdf(built.credit);
    assert.equal(contractPdf.subarray(0, 5).toString(), "%PDF-");
    const operationId = randomUUID();
    const input = { id: operationId, draftId, actor: { id: 4, nombre: "Asesor de prueba" },
      reason: "Firma simulada de integración", expectedProcessUuid: null, sourcePayload: saved.payload,
      updatedPayload: saved.payload, draftPayload: { ...saved.payload, financialTermsSeal: seal, firmaSeguroIdentity: metadata },
      draftFolio: built.credit.folio, frozenCredit: built.credit, document: contractPdf, supersedeActive: false };
    assert.deepEqual(saved.payload, (await f.row()).payload, "Preparing a request must not change the persisted source snapshot");
    await f.ledger.reserveDraftDispatch(input);
    await assert.rejects(f.ledger.reserveDraftDispatch({ ...input, id: randomUUID() }), error => error.status === 409);
    assert.equal(f.sends(), 0);
    await f.ledger.dispatchReservedDraft(operationId);
    await f.ledger.reserveDraftDispatch(input); await f.ledger.dispatchReservedDraft(operationId);
    assert.equal(f.sends(), 1);
    assert.equal((await f.ledger.getDraftDispatch(operationId)).status, "AWAITING_SIGNATURE");
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "FirmaSeguroDraftDispatchReceipt"')).rows[0].n, 1);
    const signer = f.sentPayloads[0].signatures[0].contactInformation.person;
    assert.equal(signer.firstName, "María del Mar"); assert.equal(signer.firstLastName, "De la Peña Muñoz del Río");
    assert.equal(signer.identification, documentNumber);
    assert.equal(f.sentPayloads[0].documents.base64String, contractPdf.toString("base64"));

    const callback = token => new Request("https://example.invalid/api/firma-seguro/callback", {
      method: "POST", headers: { "Content-Type": "application/json", "x-firmaseguro-token": token },
      body: JSON.stringify({ uuid: f.processUuid, status: "COMPLETED" }),
    });
    assert.equal((await f.callback.POST(callback("wrong-secret"))).status, 401);
    const response = await f.callback.POST(callback("test-secret"));
    const callbackBody = await response.json(); assert.equal(response.status, 200, JSON.stringify(callbackBody));
    assert.equal(callbackBody.ok, true);
    let signed = await f.firmaStorage.getLatestFirmaSeguroProcessByDraft(draftId);
    assert.equal(signed.status, "COMPLETED"); assert.equal(signed.signedDocumentBase64, f.signedPdf);
    assert.equal(signed.draftPayload.clienteNombre, fullName);
    assert.equal(signed.draftPayload.firmaSeguroIdentity.canonicalFullName, fullName);
    assert.equal((await f.callback.POST(callback("test-secret"))).status, 200);
    assert.equal(f.sends(), 1);

    ui = wizard(f, { ...(await f.row()).payload }, 4);
    ui.context.firmaSeguroProcessSigned = true;
    await ui.actions.advanceToStep(5);
    assert.equal(ui.requests[0].payloadScope, "DELIVERY_EVIDENCE");
    assert.equal((await f.row()).currentStep, 5);
    signed = await f.firmaStorage.getLatestFirmaSeguroProcessByDraft(draftId);
    const closePayload = signedClose.buildSignedCreditClosePayload(signed.draftPayload,
      { solicitudId: draftId, clienteNombre: "NOMBRE ALTERADO", clienteDocumento: "999999999",
        firmaSeguroProcessUuid: f.processUuid, fotoEntregaDataUrl: "data:image/jpeg;base64,fixture" }, seal.snapshot);
    assert.equal(closePayload.clienteNombre, fullName); assert.equal(closePayload.clienteDocumento, documentNumber);
    const signedIdentity = firmaIdentity.readFirmaSeguroFullNameIdentity(signed.draftPayload.firmaSeguroIdentity,
      { fullName: closePayload.clienteNombre, documentNumber: closePayload.clienteDocumento });
    assert.equal(signedIdentity.canonicalFullName, fullName); assert.equal(signedIdentity.source, "VERIFF");
    const closing = { solicitudId: draftId, assessmentId, clienteDocumento: documentNumber, imei, plataforma: "IPHONE",
      usuarioId: 4, vendedorId: 8, sedeId: 3, creditoId: 100 };
    assert.equal(await f.requestsStorage.completeSolicitudForCredit({ ...closing, clienteDocumento: "999999999" }, f.prisma), null);
    assert.equal(await f.requestsStorage.completeSolicitudForCredit({ ...closing, sedeId: 99 }, f.prisma), null);
    assert.equal((await f.row()).estado, "ABIERTO");
    await f.prisma.$transaction(async transaction => {
      await transaction.$executeRawUnsafe('INSERT INTO "Credito" ("id","clienteNombre","clienteDocumento","contratoSnapshot") VALUES (100,$1,$2,$3::jsonb)',
        closePayload.clienteNombre, closePayload.clienteDocumento, JSON.stringify({ ...built.credit.contratoSnapshot,
          firmaSeguroIdentity: signedIdentity, firmaSeguro: { uuid: f.processUuid } }));
      assert.ok(await f.firmaStorage.linkFirmaSeguroProcessToCredit(f.processUuid, 100, draftId, transaction));
      assert.ok(await f.veriff.linkVeriffValidationToCredit(validationId, 100, transaction));
      assert.equal(await f.requestsStorage.completeSolicitudForCredit(closing, transaction), draftId);
    });
    saved = await f.row(); assert.equal(saved.estado, "CERRADO"); assert.equal(saved.closedReason, "FINALIZADA");
    assert.equal(saved.creditoId, 100); assert.equal(saved.clienteNombre, fullName);
    const credit = (await f.db.query('SELECT * FROM "Credito" WHERE "id"=100')).rows[0];
    assert.equal(credit.clienteNombre, fullName);
    assert.equal(credit.contratoSnapshot.dataCreditoIdentity.effective.fullName, fullName);
    assert.equal(credit.contratoSnapshot.firmaSeguroIdentity.canonicalFullName, fullName);
    assert.equal(credit.contratoSnapshot.financiero.selloFinanciero.snapshot.clienteNombre, sealedName);
    assert.equal((await f.firmaStorage.getLatestFirmaSeguroProcessByCredit(100)).signedDocumentBase64, f.signedPdf);
    assert.equal(await f.requestsStorage.completeSolicitudForCredit(closing, f.prisma), null);
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "Credito"')).rows[0].n, 1);
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "FirmaSeguroProcess"')).rows[0].n, 1);
    assert.equal((await f.db.query('SELECT COUNT(*)::integer AS n FROM "DataCreditoIdentityCorrection"')).rows[0].n, 0);
    assert.ok(f.sourceReads() > 1); assert.equal(f.sends(), 1);
  });
});
