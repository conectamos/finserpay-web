import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  isVerifiedPendingSignatureStatus,
  isVerifiedTerminalDraftImeiRetry,
  isVerifiedTerminalSignatureFailure,
} from "../lib/approval-operations-core.ts";
import {
  isFirmaSeguroFailedStatus,
  isFirmaSeguroSuccessfulStatus,
} from "../lib/firmaseguro-status.ts";

const source = readFileSync(new URL("../lib/approval-operations-read.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const status = { isFirmaSeguroFailedStatus, isFirmaSeguroSuccessfulStatus };
let remissionStatus = null;
const loaded = { exports: {} };
runInNewContext(compiled, {
  module: loaded, exports: loaded.exports, Date,
  require(name) {
    if (name === "server-only") return {};
    if (name === "@/lib/prisma") return { default: {} };
    if (name === "@/lib/credit-amortization-contract") return {
      readFinancingTermsSeal: value => value ? { checksum: "a".repeat(64) } : null,
    };
    if (name === "@/lib/credit-device-replacement-remission") return {
      getReplacementRemission: async () => remissionStatus ? { status: remissionStatus } : null,
    };
    if (name === "@/lib/ally-payments-core") return { resolveAllyPaymentPlatform: (_snapshot, brand) =>
      /iphone|apple/i.test(brand || "") ? "IPHONE" : "ANDROID" };
    if (name === "@/lib/firmaseguro-status") return status;
    if (name === "@/lib/approval-operations-core") return {
      isVerifiedPendingSignatureStatus,
      isVerifiedTerminalDraftImeiRetry,
      isVerifiedTerminalSignatureFailure,
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
    if (sql.includes('FROM "CreditApprovalReissue"')) return [];
    if (sql.includes('FROM "CreditApprovalInitialSignature"')) return [];
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
  assert.equal(initial.capabilities.canUpdateContact, true);
  assert.equal(initial.capabilities.canResendSignature, true);
  assert.equal(initial.capabilities.canSendSignature, false);
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

test("crédito iPhone sin firma permite primer envío solo con origen verificado y sin operación pendiente", async () => {
  let hasReview = true;
  let hasSeal = true;
  let initialPending = false;
  let historicalSigned = false;
  const db = { $queryRawUnsafe: async sql => {
    if (sql.includes('FROM "Credito" credit')) return [{
      id: 81, folio: "FC-81", visibleNumber: null, clienteNombre: "Cliente",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: "a@example.com",
      estado: "GENERADO", imei: "123456789012345", referenciaEquipo: "iPhone",
      equipoMarca: "APPLE", equipoModelo: "Modelo",
      contratoSnapshot: { financiero: { selloFinanciero: hasSeal ? { checksum: "a".repeat(64) } : null } },
      hasFinishedDraft: false, hasAllySettlement: false, hasApprovalReview: hasReview,
      createdAt: stamp, updatedAt: stamp,
    }];
    if (sql.includes('SELECT EXISTS (SELECT 1 FROM "FirmaSeguroProcess" process'))
      return [{ signed: historicalSigned }];
    if (sql.includes('FROM "FirmaSeguroProcess" WHERE')) return [];
    if (sql.includes('to_regclass(')) return [{ present: true }];
    if (sql.includes('FROM "CreditApprovalReissue"')) return [];
    if (sql.includes('FROM "CreditApprovalInitialSignature"')) return initialPending ? [{
      id: "initial-1", status: "AWAITING_SIGNATURE", reason: "Firma inicial",
      actorName: "Analista", requestedAt: stamp, completedAt: null,
    }] : [];
    return [];
  } };
  const ready = await read.getOperationalCase("CREDIT", "81", db);
  assert.equal(ready.signature.status, "NOT_SENT");
  assert.equal(ready.capabilities.preSettlementApprovalCreditId, 81);
  assert.equal(ready.capabilities.canUpdateContact, true);
  assert.equal(ready.capabilities.canSendSignature, true);
  assert.equal(ready.capabilities.canResendSignature, false);
  initialPending = true;
  const pending = await read.getOperationalCase("CREDIT", "81", db);
  assert.equal(pending.capabilities.canSendSignature, false);
  assert.match(pending.capabilities.signatureReason, /en curso/);
  assert.ok(pending.timeline.some(event => event.label === "Primera firma enviada"));
  initialPending = false;
  historicalSigned = true;
  const historical = await read.getOperationalCase("CREDIT", "81", db);
  assert.equal(historical.capabilities.canSendSignature, false);
  assert.match(historical.capabilities.signatureReason, /contrato firmado anterior/);
  historicalSigned = false;
  hasSeal = false;
  const missingSeal = await read.getOperationalCase("CREDIT", "81", db);
  assert.equal(missingSeal.capabilities.canSendSignature, false);
  assert.match(missingSeal.capabilities.signatureReason, /origen contractual/);
  hasSeal = true;
  hasReview = false;
  const withoutReview = await read.getOperationalCase("CREDIT", "81", db);
  assert.equal(withoutReview.capabilities.canUpdateContact, false);
  assert.equal(withoutReview.capabilities.canSendSignature, false);
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

test("una solicitud firmada en entrega se puede buscar para corregir identidad sin habilitar otras mutaciones", async () => {
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    if (sql.includes('FROM "Credito" credit')) return [];
    if (sql.includes('FROM "CreditoBorrador" draft')) {
      assert.match(sql, /"currentStep" IN \(3,4,5\)/);
      return [{
        id: 23, estado: "ABIERTO", currentStep: 5, clienteNombre: "Nombre anterior",
        clienteDocumento: "1234567890", clienteTelefono: "3000000000", clienteCorreo: null,
        imei: "490154203237518", plataforma: "IPHONE", payload: { referenciaEquipo: "iPhone" },
        createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
      }];
    }
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 7, processUuid: "process-7", status: "SIGNED", draftPayload: {}, requestPayload: {},
      lastError: null, hasSignedDocument: true, createdAt: stamp, completedAt: stamp, supersededAt: null,
    }];
    if (sql.includes('FROM "SolicitudNombreCorrectionAudit"')) return [{
      id: "name-audit", eventType: "CORRECTED", previousName: "Nombre anterior",
      newName: "Nombre corregido", reason: "Nombre verificado", actorName: "Analista",
      createdAt: stamp,
    }];
    if (sql.includes('to_regclass(')) return [{
      present: String(params[0]).includes('SolicitudNombreCorrectionAudit'),
    }];
    return [];
  } };
  const search = await read.searchOperationalCases("1234567890", db);
  assert.equal(search[0]?.id, 23);
  const detail = await read.getOperationalCase("DRAFT", "23", db);
  assert.equal(detail.signature.status, "SIGNED");
  assert.equal(detail.capabilities.canChangeImei, false);
  assert.equal(detail.capabilities.canResendSignature, false);
  assert.equal(detail.timeline.some(event => event.label === "Identidad corregida; nueva firma requerida"), true);
});

test("una única firma pendiente de borrador habilita redirección solo mientras el envío sigue seguro", async () => {
  let unresolved = false;
  let status = "CREATED";
  let hasSignedDocument = false;
  let completedAt = null;
  let duplicateActive = false;
  const process = () => ({
    id: 30, processUuid: "20000000-0000-4000-8000-000000000002", status,
    draftPayload: { financialTermsSeal: { snapshot: {} } },
    requestPayload: { signers: [{ number: "3218928117", email: "cliente@example.com" }] },
    lastError: null, hasSignedDocument, createdAt: stamp, completedAt, supersededAt: null,
  });
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 30, estado: "ABIERTO", currentStep: 4, clienteNombre: "Cliente",
      clienteDocumento: "1052962070", clienteTelefono: "3218928117", clienteCorreo: "cliente@example.com",
      imei: "358015864286170", plataforma: "IPHONE",
      payload: { referenciaEquipo: "iPhone" },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return duplicateActive
      ? [process(), { ...process(), id: 31, processUuid: "30000000-0000-4000-8000-000000000003" }]
      : [process()];
    if (sql.includes('to_regclass(')) return [{ present: params[0].includes('FirmaSeguroDraftDispatch') }];
    if (sql.includes('FROM "FirmaSeguroDraftDispatch"')) return unresolved ? [{ id: "pending" }] : [];
    if (sql.includes('FROM "IphoneEnrollmentReview"')) return [];
    if (sql.includes('FROM "SolicitudImeiCorrectionAudit"')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };

  const ready = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(ready.signature.status, "PENDING");
  assert.equal(ready.capabilities.canRedirectPendingSignature, true);
  assert.equal(ready.capabilities.pendingSignatureRedirectReason, null);

  unresolved = true;
  const dispatching = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(dispatching.capabilities.canRedirectPendingSignature, false);
  assert.match(dispatching.capabilities.pendingSignatureRedirectReason, /envío|preparación|conciliación/i);
  unresolved = false;

  hasSignedDocument = true;
  completedAt = stamp;
  status = "SIGNED";
  const signed = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(signed.signature.status, "SIGNED");
  assert.equal(signed.capabilities.canRedirectPendingSignature, false);

  hasSignedDocument = false;
  completedAt = null;
  for (const terminal of ["REJECTED", "DECLINED", "CANCELLED", "EXPIRED", "REVOKED"]) {
    status = terminal;
    const blocked = await read.getOperationalCase("DRAFT", "30", db);
    assert.equal(blocked.signature.status, "TECHNICAL_ERROR", terminal);
    assert.equal(blocked.capabilities.canRedirectPendingSignature, false,
      `${terminal} no permite editar y reenviar el mismo proceso`);
    assert.match(blocked.capabilities.pendingSignatureRedirectReason, /no está pendiente|actualiza/i);
  }

  for (const ambiguousFailure of ["ERROR", "FAILED", "FAILURE"]) {
    status = ambiguousFailure;
    const blocked = await read.getOperationalCase("DRAFT", "30", db);
    assert.equal(blocked.signature.status, "TECHNICAL_ERROR", ambiguousFailure);
    assert.equal(blocked.capabilities.canRedirectPendingSignature, false,
      `${ambiguousFailure} no demuestra una terminación recuperable`);
    assert.match(blocked.capabilities.pendingSignatureRedirectReason, /no está pendiente|actualiza/i);
  }

  status = "CREATED";
  duplicateActive = true;
  const ambiguous = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(ambiguous.capabilities.canRedirectPendingSignature, false,
    "dos procesos activos no permiten identificar el destinatario vigente");
});

test("el reenvío conserva contacto contractual y refleja solo la entrega confirmada del mismo proceso", async () => {
  const calls = [];
  let deliveryPending = false;
  let deliveryStatus = "RESEND_UNCERTAIN";
  let confirmedContact = { phone: "3101234567", email: "nuevo@example.com" };
  let resentAt = "2026-10-09T16:05:00.000Z";
  let requestPayload = { endpoint: "create-full-by-company", payload: {
    signers: [{ number: "3218928117", email: "original@example.com" }],
  } };
  let correctionPending = false;
  const processUuid = "20000000-0000-4000-8000-000000000002";
  let deliveryProcessUuid = processUuid;
  let signed = false;
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 30, estado: "ABIERTO", currentStep: 4, clienteNombre: "Cliente",
      clienteDocumento: "1052962070", clienteTelefono: "3218928117", clienteCorreo: "original@example.com",
      imei: "358015864286170", plataforma: "IPHONE",
      payload: { referenciaEquipo: "iPhone", firmaSeguroClientCorrectionPending: correctionPending },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 30, processUuid, status: signed ? "SIGNED" : "PENDING", draftPayload: {}, requestPayload,
      lastError: null, hasSignedDocument: signed, createdAt: stamp, completedAt: signed ? stamp : null, supersededAt: null,
    }];
    if (sql.includes('to_regclass(')) return [{ present: params[0].includes('FirmaSeguroRecipientDelivery') }];
    if (sql.includes('SELECT "id"::text,"status","processUuid","afterContact","reason","actorName"')) {
      assert.deepEqual(plain(params), [30, processUuid]);
      assert.match(sql, /"draftId"=\$1 AND "processUuid"=\$2/,
        "un reenvío histórico incierto no bloquea otro proceso vigente");
      return deliveryPending && deliveryProcessUuid === params[1] ? [{ id: "60000000-0000-4000-8000-000000000006",
        status: deliveryStatus, processUuid: deliveryProcessUuid, afterContact: { phone: "3101234567", email: "nuevo@example.com" },
        reason: "El número original no tiene WhatsApp", actorName: "Analista nominal" }] : [];
    }
    if (sql.includes('SELECT delivery."afterContact"')) {
      assert.deepEqual(plain(params), [30, processUuid]);
      assert.match(sql, /"editedAt" IS NOT NULL/);
      assert.match(sql, /MAX\(previous\."resentAt"\)/, "la última edición no borra la fecha del último reenvío confirmado");
      return confirmedContact ? [{ afterContact: confirmedContact, resentAt }] : [];
    }
    if (sql.includes('FROM "FirmaSeguroRecipientDeliveryEvent"')) return [{
      id: "delivery-event", status: deliveryPending ? "RESEND_UNCERTAIN" : "RESENT",
      actorName: "Analista nominal", reason: "El número original no tiene WhatsApp",
      beforeContact: { phone: "3218928117", email: "original@example.com" },
      afterContact: confirmedContact || {}, createdAt: "2026-10-09T16:05:00.000Z",
    }];
    return [];
  } };
  const ready = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(ready.signature.processUuid, processUuid);
  assert.equal(ready.phone, "3218928117", "el teléfono contractual del cliente permanece intacto");
  assert.equal(ready.email, "original@example.com");
  assert.equal(ready.signature.sentPhone, "3101234567");
  assert.equal(ready.signature.sentEmail, "nuevo@example.com");
  assert.equal(ready.signature.sentAt, resentAt);
  assert.equal(ready.capabilities.canRedirectPendingSignature, true, "no se exige sello para reenviar el documento existente");
  assert.ok(ready.timeline.some(event => event.label === "Mismo documento reenviado" &&
    event.actor === "Analista nominal" && event.detail.includes("3218928117 → 3101234567")));
  assert.ok(calls.every(call => !/\b(INSERT|UPDATE|DELETE)\b/.test(call.sql)), "la consulta no altera ningún registro");

  correctionPending = true;
  assert.equal((await read.getOperationalCase("DRAFT", "30", db)).capabilities.canRedirectPendingSignature, true,
    "el nuevo contrato pendiente de una corrección también admite reenviar su documento vigente");
  correctionPending = false;
  deliveryPending = true;
  resentAt = null;
  const uncertain = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(uncertain.signature.sentPhone, "3101234567", "una edición confirmada persiste aunque el reenvío sea incierto");
  assert.equal(uncertain.signature.sentAt, stamp, "no se declara un envío nuevo sin confirmación");
  assert.equal(uncertain.capabilities.canRedirectPendingSignature, false);
  assert.match(uncertain.capabilities.pendingSignatureRedirectReason, /conciliación/i);
  assert.equal(uncertain.pendingRecipientDelivery.retryable, false);
  for (const retryable of ["PREPARING", "EDITING", "RECIPIENT_UPDATED", "RESEND_FAILED", "EDIT_UNCERTAIN"]) {
    deliveryStatus = retryable;
    const resumed = await read.getOperationalCase("DRAFT", "30", db);
    assert.equal(resumed.capabilities.canRedirectPendingSignature, true, retryable);
    assert.deepEqual(plain(resumed.pendingRecipientDelivery), {
      id: "60000000-0000-4000-8000-000000000006", status: retryable, processUuid,
      phone: "3101234567", email: "nuevo@example.com", reason: "El número original no tiene WhatsApp",
      actorName: "Analista nominal", retryable: true,
    }, "la recarga conserva el id durable, contacto y motivo para reintentar la misma operación");
  }
  for (const blocked of ["RESENDING", "RESEND_UNCERTAIN"]) {
    deliveryStatus = blocked;
    const ongoing = await read.getOperationalCase("DRAFT", "30", db);
    assert.equal(ongoing.capabilities.canRedirectPendingSignature, false, blocked);
    assert.equal(ongoing.pendingRecipientDelivery.retryable, false, blocked);
  }

  deliveryStatus = "RESEND_UNCERTAIN";
  signed = true;
  const completedWithUncertainNotice = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(completedWithUncertainNotice.capabilities.canRedirectPendingSignature, false,
    "una firma completada nunca se vuelve a reenviar");
  assert.equal(completedWithUncertainNotice.capabilities.canChangeImei, true,
    "la incertidumbre de la notificación no bloquea una corrección contractual tras firmar");
  assert.equal(completedWithUncertainNotice.pendingRecipientDelivery.status, "RESEND_UNCERTAIN",
    "se conserva la trazabilidad sin inventar confirmación de entrega");
  signed = false;
  deliveryProcessUuid = "historical-superseded-process";
  confirmedContact = null;
  const oldUncertain = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(oldUncertain.pendingRecipientDelivery, null);
  assert.equal(oldUncertain.capabilities.canRedirectPendingSignature, true,
    "un proceso archivado no bloquea reenviar el documento actual");
  assert.ok(oldUncertain.timeline.some(event => event.label === "Reenvío pendiente de conciliación"),
    "el resultado histórico incierto permanece en la trazabilidad");

  deliveryPending = false;
  confirmedContact = null;
  const unedited = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(unedited.signature.sentPhone, "3218928117", "una edición no confirmada no reemplaza el destinatario");
  assert.equal(unedited.signature.sentEmail, "original@example.com");
  assert.equal(unedited.signature.sentAt, stamp);
  requestPayload = { endpoint: "create-full-by-company", payload: {
    signers: [{ number: "3218928117" }, { number: "3101234567" }],
  } };
  const multipleSigners = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(multipleSigners.capabilities.canRedirectPendingSignature, false);
  assert.match(multipleSigners.capabilities.pendingSignatureRedirectReason, /único firmante/i);
  requestPayload = { endpoint: "create-full", payload: { signatures: [{ contactInformation: {
    phone: { number: "3218928117" }, email: "original@example.com",
  } }] } };
  const standard = await read.getOperationalCase("DRAFT", "30", db);
  assert.equal(standard.capabilities.canRedirectPendingSignature, true,
    "el requestPayload envuelto real de company y estándar comparten el permiso");
  assert.equal(standard.signature.sentPhone, "3218928117");
  assert.equal(standard.signature.sentEmail, "original@example.com");
  requestPayload = { endpoint: "create-full", payload: {
    signers: [{ number: "3218928117" }], signatures: [{ contactInformation: { phone: { number: "3218928117" } } }],
  } };
  assert.equal((await read.getOperationalCase("DRAFT", "30", db)).capabilities.canRedirectPendingSignature, false,
    "dos estructuras simultáneas no identifican inequívocamente el firmante");
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

test("un IMEI corregido permite reintentar solo una firma terminada sin PDF y con fuente firmada", async () => {
  const correctionId = "10000000-0000-4000-8000-000000000001";
  let status = "REJECTED";
  let pointer = "failed-imei";
  let unresolved = false;
  let sourceSigned = true;
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 23, estado: "ABIERTO", currentStep: 4, clienteNombre: "Cliente",
      clienteDocumento: "123456", clienteTelefono: "3000000000", clienteCorreo: null,
      imei: "490154203237518", plataforma: "IPHONE",
      payload: { imei: "490154203237518", referenciaEquipo: "iPhone",
        firmaSeguroReissueProcessUuid: pointer },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 3, processUuid: "failed-imei", status,
      draftPayload: { imei: "490154203237518", firmaSeguroCorrectionId: correctionId,
        financialTermsSeal: { snapshot: {} } }, requestPayload: {},
      lastError: null, hasSignedDocument: false, createdAt: stamp,
      completedAt: null, supersededAt: null,
    }, {
      id: 2, processUuid: "signed-original", status: "SIGNED",
      draftPayload: { financialTermsSeal: { snapshot: {} } }, requestPayload: {},
      lastError: null, hasSignedDocument: sourceSigned, createdAt: stamp,
      completedAt: stamp, supersededAt: stamp,
    }];
    if (sql.includes('to_regclass(')) return [{ present: params[0].includes('FirmaSeguroDraftDispatch') }];
    if (sql.includes('FROM "FirmaSeguroDraftDispatch"')) return unresolved ? [{ id: "uncertain" }] : [];
    if (sql.includes('FROM "IphoneEnrollmentReview"')) return [];
    if (sql.includes('FROM "SolicitudImeiCorrectionAudit"')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const ready = await read.getOperationalCase("DRAFT", "23", db);
  assert.equal(ready.signature.status, "TECHNICAL_ERROR");
  assert.equal(ready.capabilities.canResendSignature, true);
  status = "ERROR";
  assert.equal((await read.getOperationalCase("DRAFT", "23", db)).capabilities.canResendSignature, false);
  status = "PENDING";
  assert.equal((await read.getOperationalCase("DRAFT", "23", db)).capabilities.canResendSignature, false);
  status = "REJECTED";
  unresolved = true;
  assert.equal((await read.getOperationalCase("DRAFT", "23", db)).capabilities.canResendSignature, false);
  unresolved = false;
  pointer = "other-process";
  assert.equal((await read.getOperationalCase("DRAFT", "23", db)).capabilities.canResendSignature, false);
  pointer = "failed-imei";
  sourceSigned = false;
  assert.equal((await read.getOperationalCase("DRAFT", "23", db)).capabilities.canResendSignature, false);
});

test("permite reintentar una firma de identidad fallida solo con contrato anterior verificable", async () => {
  let archivedPdf = true;
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    if (sql.includes('FROM "CreditoBorrador" draft')) return [{
      id: 24, estado: "ABIERTO", currentStep: 4, clienteNombre: "Nombre corregido",
      clienteDocumento: "1234567890", clienteTelefono: "3000000000", clienteCorreo: null,
      imei: "490154203237518", plataforma: "IPHONE",
      payload: { plataformaDispositivo: "IPHONE", firmaSeguroCorrectionPending: true,
        firmaSeguroIdentityCorrectionPending: true },
      createdAt: stamp, updatedAt: stamp, expiresAt: "2030-01-01T00:00:00.000Z",
    }];
    if (sql.includes('FROM "FirmaSeguroProcess"')) return [{
      id: 3, processUuid: "failed-new", status: "FAILED", draftPayload: {}, requestPayload: {},
      lastError: "provider rejected", hasSignedDocument: false, createdAt: stamp,
      completedAt: null, supersededAt: null,
    }, {
      id: 2, processUuid: "signed-old", status: "SIGNED",
      draftPayload: { financialTermsSeal: { snapshot: {} } }, requestPayload: {},
      lastError: null, hasSignedDocument: archivedPdf, createdAt: stamp,
      completedAt: stamp, supersededAt: stamp,
    }];
    if (sql.includes('to_regclass(')) return [{ present: false }];
    if (sql.includes('FROM "IphoneEnrollmentReview"')) return [];
    if (sql.includes('FROM "SolicitudImeiCorrectionAudit"')) return [];
    throw new Error(`Unexpected SQL: ${sql} ${params.length}`);
  } };
  const ready = await read.getOperationalCase("DRAFT", "24", db);
  assert.equal(ready.signature.status, "TECHNICAL_ERROR");
  assert.equal(ready.capabilities.canResendSignature, true);
  archivedPdf = false;
  const blocked = await read.getOperationalCase("DRAFT", "24", db);
  assert.equal(blocked.capabilities.canResendSignature, false);
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
