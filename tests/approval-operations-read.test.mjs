import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/approval-operations-read.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const status = { isFirmaSeguroFailedStatus: value => /FAILED|ERROR|REJECTED/i.test(value || ""),
  isFirmaSeguroSuccessfulStatus: value => /SIGNED|COMPLETED/i.test(value || "") };
let remissionStatus = null;
const loaded = { exports: {} };
runInNewContext(compiled, {
  module: loaded, exports: loaded.exports, Date,
  require(name) {
    if (name === "server-only") return {};
    if (name === "@/lib/prisma") return { default: {} };
    if (name === "@/lib/credit-device-replacement-remission") return {
      getReplacementRemission: async () => remissionStatus ? { status: remissionStatus } : null,
    };
    if (name === "@/lib/ally-payments-core") return { resolveAllyPaymentPlatform: (_snapshot, brand) =>
      /iphone|apple/i.test(brand || "") ? "IPHONE" : "ANDROID" };
    if (name === "@/lib/firmaseguro-status") return status;
    if (name === "@/lib/approval-operations-core") return {
      isVerifiedTerminalSignatureFailure: value => /^(REJECTED|DECLINED|CANCELLED|EXPIRED|REVOKED)$/.test(value || ""),
    };
    throw new Error(`Unexpected import: ${name}`);
  },
}, { filename: "approval-operations-read.ts" });
const read = loaded.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const stamp = "2026-10-03T14:00:00.000Z";

test("la búsqueda operativa parametriza cédula, número e IMEI sin leer condiciones financieras", async () => {
  const calls = [];
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    calls.push({ sql, params });
    return sql.includes('FROM "Credito" credit') ? [{
      id: 8, folio: "FC-8", visibleNumber: "030000008", clienteNombre: "Persona",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      estado: "GENERADO", imei: "123456789012345", referenciaEquipo: "iPhone",
      equipoMarca: "APPLE", equipoModelo: "Modelo", updatedAt: stamp,
    }] : [];
  } };
  const query = "_%' OR 1=1 --";
  const items = await read.searchOperationalCases(query, db);
  assert.equal(items.length, 1);
  assert.equal(items[0].number, "030000008");
  assert.equal(items[0].document, "•••• 3456");
  assert.equal(items[0].imei, "");
  assert.equal(items[0].phone, null);
  assert.equal(items[0].email, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls.map(item => item.params)), [[query, "11"], [query, "11"]]);
  for (const { sql } of calls) {
    assert.ok(!sql.includes(query));
    assert.match(sql, /imei/);
    assert.doesNotMatch(sql, /valorCuota|montoCredito|saldoBaseFinanciado|INSERT|UPDATE|DELETE/);
  }
  for (const value of ["ab", "", "a".repeat(101), "123\n456", null]) {
    assert.throws(() => read.operationalSearchTerm(value), { code: "INVALID_SEARCH" });
  }
});

test("crédito con reemplazo aprobado habilita finalizar, conserva historia y muestra falla técnica de firma", async () => {
  const calls = [];
  let signedDocument = false;
  let providerCompletedWithoutPdf = false;
  let historicalFinalized = false;
  let allySettlement = true;
  let hasApprovalReview = true;
  let replacementStatus = "ENROLLMENT_APPROVED";
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM "Credito" credit')) return [{
      id: 8, folio: "FC-8", visibleNumber: "030000008", clienteNombre: "Persona",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      estado: historicalFinalized ? "FINALIZADO" : "GENERADO", imei: "123456789012345", referenciaEquipo: "iPhone",
      equipoMarca: "APPLE", equipoModelo: "Modelo", contratoSnapshot: {},
      hasFinishedDraft: !historicalFinalized, hasAllySettlement: allySettlement, hasApprovalReview,
      createdAt: stamp, updatedAt: stamp,
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 9, processUuid: "process-9", status: signedDocument ? "SIGNED" : providerCompletedWithoutPdf ? "COMPLETED" : "REJECTED",
      draftPayload: {}, requestPayload: {},
      lastError: signedDocument || providerCompletedWithoutPdf ? null : "internal upstream error",
      hasSignedDocument: signedDocument,
      createdAt: stamp, completedAt: signedDocument || providerCompletedWithoutPdf ? stamp : null,
      supersededAt: null,
    }];
    if (sql.includes('to_regclass(')) return [{ present: true }];
    if (sql.includes('FROM "ApprovalOperationalContractVersion"')) return [];
    if (sql.includes('FROM "CreditDeviceReplacement" WHERE')) return replacementStatus ? [{
      id: "replacement-1", status: replacementStatus, previousImei: "123456789012345",
      newImei: "490154203237518", reason: "Garantía", createdAt: stamp,
    }] : [];
    if (sql.includes('FROM "CreditDeviceReplacementEvent"')) return [{
      id: "event-1", eventType: "ENROLLMENT_APPROVED", actorName: "Analista", createdAt: stamp,
    }];
    if (sql.includes('FROM "CreditDeviceReplacementRemissionEvent"')) return [{
      id: "remission-event-1", eventType: "UPLOADED", actorName: "Aliado", note: null,
      createdAt: stamp,
    }];
    if (sql.includes('FROM "ApprovalOperationalAction"')) return [{
      id: "action-1", eventType: "IMEI_CHANGED", actorName: "Analista", reason: "Garantía",
      status: "PENDING", evidenceSha256: "hash", createdAt: stamp,
    }];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const detail = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(detail.signature.status, "TECHNICAL_ERROR");
  assert.equal(detail.signature.rawStatus, null);
  assert.equal(detail.capabilities.canFinalizeImei, false);
  assert.equal(detail.capabilities.canChangeImei, false);
  assert.match(detail.capabilities.reason, /Error técnico: requiere revisión/);
  assert.equal(detail.replacement.newImei, "490154203237518");
  assert.ok(detail.timeline.some(event => event.label === "Error técnico: requiere revisión"));
  assert.ok(detail.timeline.some(event => event.evidenceHref?.endsWith("/action-1")));
  assert.ok(detail.timeline.some(event => event.label === "Remisión firmada recibida" && event.actor === "Aliado"));
  assert.deepEqual(plain(calls[0].params), [8]);
  assert.ok(calls.every(item => !/evidenceData|SELECT\s+"signedDocumentBase64"/.test(item.sql)));
  assert.ok(calls.some(item => item.sql.includes("LEFT(COALESCE(\"signedDocumentBase64\",''),7)='JVBERi0'")));
  providerCompletedWithoutPdf = true;
  const missingPdf = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(missingPdf.signature.status, "TECHNICAL_ERROR");
  assert.equal(missingPdf.signature.signedAt, null);
  assert.equal(missingPdf.capabilities.canFinalizeImei, false);
  assert.ok(!missingPdf.timeline.some(event => event.label === "Firma firmada"));
  assert.ok(missingPdf.timeline.some(event => event.label === "Error técnico: requiere revisión"));
  signedDocument = true;
  const signed = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(signed.signature.status, "SIGNED");
  assert.equal(signed.capabilities.canFinalizeImei, true);
  historicalFinalized = true;
  const historical = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(historical.capabilities.canFinalizeImei, true);
  assert.equal(historical.capabilities.preSettlementApprovalCreditId, null);
  historicalFinalized = false;
  allySettlement = false;
  remissionStatus = "PENDING_UPLOAD";
  const preSettlement = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(preSettlement.capabilities.preSettlementApprovalCreditId, 8);
  assert.equal(preSettlement.capabilities.canChangeImei, false);
  assert.equal(preSettlement.capabilities.canFinalizeImei, false);
  assert.match(preSettlement.capabilities.reason, /remisión firmada/);
  remissionStatus = "VERIFIED";
  const verified = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(verified.capabilities.canFinalizeImei, true);
  assert.equal(preSettlement.capabilities.canUpdateContact, false);
  assert.equal(preSettlement.capabilities.canResendSignature, false);
  replacementStatus = null;
  const initial = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(initial.capabilities.canChangeImei, true);
  remissionStatus = null;
  hasApprovalReview = false;
  const withoutReview = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(withoutReview.capabilities.preSettlementApprovalCreditId, null);
  assert.equal(withoutReview.capabilities.canChangeImei, false);
  assert.match(withoutReview.capabilities.reason, /revisión vigente/);
  hasApprovalReview = true;
  signedDocument = false;
  const withoutSignedDocument = await read.getOperationalCase("CREDIT", "8", db);
  assert.equal(withoutSignedDocument.capabilities.preSettlementApprovalCreditId, null);
  assert.ok(calls.some(item => item.sql.includes('FROM "CreditApprovalReview" review')));
});

test("una versión PREPARING del reemplazo aplicado se expone para reanudar con el mismo id", async () => {
  let versionStatus = "PREPARING";
  const db = { $queryRawUnsafe: async sql => {
    if (sql.includes('FROM "Credito" credit')) return [{
      id: 18, folio: "FC-18", visibleNumber: "030000018", clienteNombre: "Persona",
      clienteDocumento: "987654", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      estado: "GENERADO", imei: "490154203237518", referenciaEquipo: "iPhone",
      equipoMarca: "APPLE", equipoModelo: "Modelo", contratoSnapshot: {},
      hasFinishedDraft: true, hasAllySettlement: true,
      createdAt: stamp, updatedAt: stamp,
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 19, processUuid: "signed-process-19", status: "SIGNED",
      draftPayload: {}, requestPayload: {}, lastError: null, hasSignedDocument: true,
      createdAt: stamp, completedAt: stamp, supersededAt: null,
    }];
    if (sql.includes('to_regclass(')) return [{ present: true }];
    if (sql.includes('FROM "ApprovalOperationalContractVersion"')) return [{
      id: "version-19", version: 2, status: versionStatus,
      replacementId: "replacement-19", previousProcessUuid: "signed-process-19",
      actorName: "Analista", reason: "Garantía", previousImei: "123456789012345",
      newImei: "490154203237518", newProcessUuid: null,
      sentPhone: null, sentEmail: null, requestedAt: stamp, completedAt: null,
    }];
    if (sql.includes('FROM "CreditDeviceReplacement" WHERE')) return [{
      id: "replacement-19", status: "COMPLETED", previousImei: "123456789012345",
      newImei: "490154203237518", reason: "Garantía", createdAt: stamp,
    }];
    return [];
  } };
  const preparing = await read.getOperationalCase("CREDIT", "18", db);
  assert.equal(preparing.pendingVersion.id, "version-19");
  assert.equal(preparing.pendingVersion.replacementId, "replacement-19");
  assert.equal(preparing.capabilities.canFinalizeImei, true);
  assert.ok(preparing.timeline.some(event => event.label === "Preparando nueva versión del contrato"));
  versionStatus = "FAILED_SAFE";
  const retryable = await read.getOperationalCase("CREDIT", "18", db);
  assert.equal(retryable.pendingVersion.id, "version-19");
  assert.equal(retryable.capabilities.canConfirmReplacement, true);
  versionStatus = "UNCERTAIN";
  const uncertain = await read.getOperationalCase("CREDIT", "18", db);
  assert.equal(uncertain.pendingVersion.status, "UNCERTAIN");
  assert.equal(uncertain.capabilities.canFinalizeImei, false);
  assert.match(uncertain.capabilities.reason, /Error técnico: requiere revisión/);
});

test("solo fallo terminal verificado con contrato original firmado ofrece reenvío", async () => {
  let originalPdf = true;
  let previousRetryFailedSafely = false;
  let secondRetryFailed = false;
  const db = { $queryRawUnsafe: async sql => {
    if (sql.includes('FROM "Credito" credit')) return [{
      id: 19, folio: "FC-19", visibleNumber: "030000019", clienteNombre: "Persona",
      clienteDocumento: "987654", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      estado: "FINALIZADO", imei: "490154203237518", referenciaEquipo: "iPhone",
      equipoMarca: "APPLE", equipoModelo: "Modelo", contratoSnapshot: {},
      hasFinishedDraft: false, hasAllySettlement: true, createdAt: stamp, updatedAt: stamp,
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: secondRetryFailed ? 24 : 22, processUuid: secondRetryFailed ? "failed-24" : "failed-22",
      status: "DECLINED", draftPayload: {}, requestPayload: {},
      lastError: "upstream", hasSignedDocument: false,
      createdAt: stamp, completedAt: null, supersededAt: null,
    }, {
      id: 21, processUuid: "signed-21", status: "SIGNED",
      draftPayload: { financialTermsSeal: { snapshot: {} } }, requestPayload: {},
      lastError: null, hasSignedDocument: originalPdf,
      createdAt: stamp, completedAt: stamp, supersededAt: stamp,
    }];
    if (sql.includes('to_regclass(')) return [{ present: true }];
    if (sql.includes('originalVersion') && sql.includes('SELECT EXISTS')) return [{ signed: originalPdf }];
    if (sql.includes('FROM "ApprovalOperationalContractVersion"')) return [...(previousRetryFailedSafely ? [{
      id: "version-23", version: 3, status: "FAILED_SAFE", replacementId: null,
      previousProcessUuid: "signed-21", supersededProcessUuid: "failed-22", newProcessUuid: null,
      actorName: "Analista", reason: "Reintento de firma",
      previousImei: "490154203237518", newImei: "490154203237518",
      sentPhone: "3000000000", sentEmail: "a@example.com",
      requestedAt: stamp, lastCheckedAt: stamp, completedAt: null,
    }] : secondRetryFailed ? [{
      id: "version-23", version: 3, status: "TECHNICAL_ERROR", replacementId: null,
      previousProcessUuid: "signed-21", supersededProcessUuid: "failed-22", newProcessUuid: "failed-24",
      actorName: "Analista", reason: "Segundo reintento de firma",
      previousImei: "490154203237518", newImei: "490154203237518",
      sentPhone: "3000000000", sentEmail: "a@example.com",
      requestedAt: stamp, lastCheckedAt: stamp, completedAt: null,
    }] : []), {
      id: "version-22", version: 2, status: "TECHNICAL_ERROR", replacementId: null,
      previousProcessUuid: "signed-21", newProcessUuid: "failed-22",
      actorName: "Analista", reason: "Corrección de contacto",
      previousImei: "490154203237518", newImei: "490154203237518",
      sentPhone: "3000000000", sentEmail: "a@example.com",
      requestedAt: stamp, lastCheckedAt: stamp, completedAt: null,
    }];
    if (sql.includes('FROM "CreditDeviceReplacement" WHERE')) return [];
    return [];
  } };
  const retryable = await read.getOperationalCase("CREDIT", "19", db);
  assert.equal(retryable.signature.status, "TECHNICAL_ERROR");
  assert.equal(retryable.capabilities.canResendSignature, true);
  assert.equal(retryable.capabilities.canUpdateContact, true);
  assert.equal(retryable.capabilities.canChangeImei, false);
  previousRetryFailedSafely = true;
  const safeRetry = await read.getOperationalCase("CREDIT", "19", db);
  assert.equal(safeRetry.capabilities.canResendSignature, true);
  previousRetryFailedSafely = false;
  secondRetryFailed = true;
  const secondRetry = await read.getOperationalCase("CREDIT", "19", db);
  assert.equal(secondRetry.capabilities.canResendSignature, true);
  secondRetryFailed = false;
  originalPdf = false;
  const unsafe = await read.getOperationalCase("CREDIT", "19", db);
  assert.equal(unsafe.capabilities.canResendSignature, false);
  assert.match(unsafe.capabilities.reason, /Error técnico: requiere revisión/);
});

test("solicitud del paso 3 expone revisión de enrolamiento sin afirmar envío automático", async () => {
  const db = { $queryRawUnsafe: async sql => {
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 21, estado: "ABIERTO", currentStep: 3, clienteNombre: "Cliente",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      imei: "490154203237518", plataforma: "IPHONE", payload: { referenciaEquipo: "iPhone" },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 2, processUuid: "process-2", status: "SIGNED", draftPayload: {}, requestPayload: {},
      lastError: null, hasSignedDocument: true, createdAt: stamp, completedAt: stamp, supersededAt: null,
    }];
    if (sql.includes('FROM "IphoneEnrollmentReview"')) return [{ id: "review-1" }];
    if (sql.includes('to_regclass(')) return [{ present: false }];
    return [];
  } };
  const detail = await read.getOperationalCase("DRAFT", "21", db);
  assert.equal(detail.enrollmentReviewId, "review-1");
  assert.equal(detail.requiresEnrollmentReapproval, true);
  assert.equal(detail.capabilities.canChangeImei, true);
  assert.equal(detail.capabilities.canDispatchSignatureWithImei, false);
  assert.equal(detail.signature.status, "SIGNED");
  assert.equal(detail.number, "SOL-000021");
  assert.throws(() => read.operationalCaseIdentity("CREDIT", "8;DROP"), { code: "INVALID_CASE" });
});

test("tras corregir el IMEI solo permite nueva firma desde fuente firmada y sin despacho incierto", async () => {
  let unresolved = false;
  let signedSource = true;
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 22, estado: "ABIERTO", currentStep: 4, clienteNombre: "Cliente",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      imei: "490154203237518", plataforma: "IPHONE",
      payload: { referenciaEquipo: "iPhone", firmaSeguroCorrectionPending: true },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 2, processUuid: "process-2", status: "SIGNED",
      draftPayload: { financialTermsSeal: { snapshot: {} } }, requestPayload: {},
      lastError: null, hasSignedDocument: signedSource,
      createdAt: stamp, completedAt: stamp, supersededAt: stamp,
    }];
    if (sql.includes('to_regclass(')) return [{ present: params[0].includes('FirmaSeguroDraftDispatch') }];
    if (sql.includes('FROM "FirmaSeguroDraftDispatch"')) return unresolved ? [{ id: "pending" }] : [];
    if (sql.includes('FROM "IphoneEnrollmentReview"')) return [];
    if (sql.includes('FROM "SolicitudImeiCorrectionAudit"')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const ready = await read.getOperationalCase("DRAFT", "22", db);
  assert.equal(ready.signature.status, "NOT_SENT");
  assert.equal(ready.capabilities.canResendSignature, true);
  unresolved = true;
  const sending = await read.getOperationalCase("DRAFT", "22", db);
  assert.equal(sending.capabilities.canResendSignature, false);
  assert.match(sending.capabilities.reason, /envío de firma/);
  unresolved = false;
  signedSource = false;
  const unsafe = await read.getOperationalCase("DRAFT", "22", db);
  assert.equal(unsafe.capabilities.canResendSignature, false);
  assert.match(unsafe.capabilities.reason, /Error técnico: requiere revisión/);
});

test("encuentra crédito finalizado por IMEI completo sin exponerlo en resultados", async () => {
  const imei = "490154203237518";
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    assert.deepEqual(plain(params), [imei, imei]);
    if (sql.includes('FROM "Credito" credit')) return [{
      id: 31, folio: "FC-31", visibleNumber: "030000031", clienteNombre: "Cliente",
      clienteDocumento: "111111", clienteTelefono: null, clienteCorreo: null,
      estado: "FINALIZADO", imei, referenciaEquipo: "Equipo", equipoMarca: "APPLE",
      equipoModelo: "iPhone", updatedAt: stamp,
    }];
    return [];
  } };
  const result = await read.searchOperationalCases(imei, db);
  assert.equal(result[0].status, "FINALIZADO");
  assert.equal(result[0].imei, "");
  assert.equal(result[0].kind, "CREDIT");
});

test("las rutas operativas niegan lectura sin sesión nominal y no exponen caché", async () => {
  let databaseReads = 0;
  for (const path of [
    "app/api/aprobaciones/operativo/route.ts",
    "app/api/aprobaciones/operativo/[kind]/[id]/route.ts",
  ]) {
    const routeSource = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const routeCompiled = ts.transpileModule(routeSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const routeModule = { exports: {} };
    runInNewContext(routeCompiled, {
      module: routeModule, exports: routeModule.exports, Request, Response, URL,
      require(name) {
        if (name === "next/server") return { NextResponse: { json: Response.json } };
        if (name === "@/lib/auth") return { getCreditApprovalSessionUser: async () => null };
        if (name === "@/lib/approval-shared-session") return { getApprovalSharedRequestActor: async () => undefined };
        if (name === "@/lib/approval-operations-read") return {
          OperationalCaseReadError: read.OperationalCaseReadError,
          searchOperationalCases: async () => { databaseReads++; return []; },
          getOperationalCase: async () => { databaseReads++; return null; },
        };
        throw new Error(`Unexpected import: ${name}`);
      },
    }, { filename: path });
    const response = await routeModule.exports.GET(
      new Request("https://example.test/api/aprobaciones/operativo?q=490154203237518"),
      { params: Promise.resolve({ kind: "credit", id: "8" }) },
    );
    assert.equal(response.status, 401);
    assert.match(response.headers.get("cache-control"), /private, no-store/);
    const sharedModule = { exports: {} };
    runInNewContext(routeCompiled, {
      module: sharedModule, exports: sharedModule.exports, Request, Response, URL,
      require(name) {
        if (name === "next/server") return { NextResponse: { json: Response.json } };
        if (name === "@/lib/auth") return { getCreditApprovalSessionUser: async () => ({ id: 1 }) };
        if (name === "@/lib/approval-shared-session") return {
          getApprovalSharedRequestActor: async () => ({ kind: "SHARED_LINK" }),
        };
        if (name === "@/lib/approval-operations-read") return {
          OperationalCaseReadError: read.OperationalCaseReadError,
          searchOperationalCases: async () => { databaseReads++; return []; },
          getOperationalCase: async () => { databaseReads++; return null; },
        };
        throw new Error(`Unexpected import: ${name}`);
      },
    }, { filename: path });
    const sharedResponse = await sharedModule.exports.GET(
      new Request("https://example.test/api/aprobaciones/operativo?q=490154203237518"),
      { params: Promise.resolve({ kind: "credit", id: "8" }) },
    );
    assert.equal(sharedResponse.status, 403);
    assert.match(sharedResponse.headers.get("cache-control"), /private, no-store/);
  }
  assert.equal(databaseReads, 0);
});
