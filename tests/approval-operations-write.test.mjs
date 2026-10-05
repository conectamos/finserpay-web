import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canDispatchReservedVersion, exactImei, hasVerifiedDraftSignature, isVerifiedTerminalOperationalRetry,
  isVerifiedTerminalSignatureFailure, operationalCreditEligibility, operationalDraftCorrectionStatus,
  operationalImeiEligibility,
  operationalProcessToSupersede, operationalSignatureLineage,
  operationalFrozenCredit, signedPdfBytes,
} from "../lib/approval-operations-core.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const replacementSource = await readFile(path.join(root, "lib/credit-device-replacement-storage.ts"), "utf8");
const writerSource = await readFile(path.join(root, "lib/approval-operations-write.ts"), "utf8");
const completionSource = await readFile(path.join(root, "lib/approval-operational-signature-complete.ts"), "utf8");
const firmaSeguroSource = await readFile(path.join(root, "lib/firmaseguro-credit.ts"), "utf8");

test("el crédito operativo exige iPhone finalizado y ya liquidado al aliado", () => {
  const eligible = { estado: "ACTIVO", paidToAlly: true, finishedDraft: true,
    platform: "IPHONE", referenciaEquipo: "iPhone 15" };
  assert.equal(operationalCreditEligibility(eligible), null);
  assert.equal(operationalCreditEligibility({ ...eligible, paidToAlly: false }), "NOT_SETTLED");
  assert.equal(operationalCreditEligibility({ ...eligible, finishedDraft: false }), "NOT_FINALIZED");
  assert.equal(operationalCreditEligibility({ ...eligible, estado: "FINALIZADO", finishedDraft: false }), null);
  assert.equal(operationalCreditEligibility({ ...eligible, estado: "FINALIZADO", finishedDraft: false,
    paidToAlly: false }), "NOT_SETTLED");
  assert.equal(operationalCreditEligibility({ ...eligible, platform: "ANDROID", referenciaEquipo: "Samsung" }), "IPHONE_REQUIRED");
  assert.equal(operationalCreditEligibility({ ...eligible, estado: "ANULADO" }), "CANCELLED");
});

test("el cambio de IMEI acepta un iPhone firmado en aprobación sin abrir otros créditos", () => {
  const credit = { estado: "ACTIVO", paidToAlly: false, finishedDraft: true,
    hasApprovalReview: true, platform: "IPHONE", referenciaEquipo: "iPhone 15" };
  assert.equal(operationalImeiEligibility(credit), null);
  assert.equal(operationalImeiEligibility({ ...credit, hasApprovalReview: false }), "PRE_SETTLEMENT_REVIEW_REQUIRED");
  assert.equal(operationalImeiEligibility({ ...credit, finishedDraft: false }), "NOT_FINALIZED");
  assert.equal(operationalImeiEligibility({ ...credit, platform: "ANDROID", referenciaEquipo: "Samsung" }), "IPHONE_REQUIRED");
  assert.equal(operationalImeiEligibility({ ...credit, estado: "ANULADO" }), "CANCELLED");
});

test("solicitar reemplazo reabre el OK previo dentro de la transacción o aborta", async () => {
  const start = writerSource.indexOf("async function invalidatePreSettlementImeiApproval(");
  const end = writerSource.indexOf("\nexport async function mutateOperationalImei(", start);
  assert.ok(start >= 0 && end > start);
  const statement = stripTypeScriptTypes(writerSource.slice(start, end));
  const ErrorType = class extends Error {
    constructor(code, message, status) { super(message); this.code = code; this.status = status; }
  };
  const invalidate = new Function("ApprovalOperationalError",
    `${statement}\nreturn invalidatePreSettlementImeiApproval;`)(ErrorType);
  const queries = [];
  let review = { status: "APPROVED", approvedRevision: 4 };
  const db = { $queryRawUnsafe: async (sql, creditId) => {
    queries.push({ sql, creditId });
    if (sql.includes("credit_approval_invalidate")) {
      review = { status: "PENDING", approvedRevision: null };
      return [{ credit_approval_invalidate: null }];
    }
    return [review];
  } };
  await invalidate(db, { id: 17, paidToAlly: false });
  assert.equal(review.status, "PENDING");
  assert.equal(review.approvedRevision, null);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map((query) => query.creditId), [17, 17]);
  queries.length = 0;
  await invalidate(db, { id: 17, paidToAlly: true });
  assert.equal(queries.length, 0);
  await assert.rejects(() => invalidate({ $queryRawUnsafe: async sql =>
    sql.includes("credit_approval_invalidate") ? [{}] : [{ status: "APPROVED", approvedRevision: 4 }]
  }, { id: 17, paidToAlly: false }), { code: "APPROVAL_INVALIDATION_FAILED" });
});

test("IMEI exacto y PDF firmado verificable son prerrequisitos", () => {
  assert.equal(exactImei("355063664500617"), true);
  for (const value of ["35506366450061", "3550636645006170", "35506366450061A", 355063664500617])
    assert.equal(exactImei(value), false);
  const pdf = Buffer.from("%PDF-1.7\nexample").toString("base64");
  assert.equal(signedPdfBytes(pdf)?.subarray(0, 5).toString(), "%PDF-");
  assert.equal(signedPdfBytes(Buffer.from("<html>not signed</html>").toString("base64")), null);
  assert.equal(signedPdfBytes(null), null);
});

test("el borrador no corrige IMEI desde un fallo técnico sin PDF firmado", () => {
  const pdf = Buffer.from("%PDF-1.7\nexample").toString("base64");
  assert.equal(hasVerifiedDraftSignature(pdf, true), true);
  assert.equal(hasVerifiedDraftSignature(pdf, false), false);
  assert.equal(hasVerifiedDraftSignature(null, true), false);
  assert.equal(hasVerifiedDraftSignature(Buffer.from("error técnico").toString("base64"), true), false);
});

test("la corrección del borrador comunica la etapa real de aprobación", () => {
  assert.equal(operationalDraftCorrectionStatus(true), "PENDING_REAPPROVAL");
  assert.equal(operationalDraftCorrectionStatus(false), "PENDING_REISSUE");
});

test("solo una terminación definitiva verificada permite recuperar firma; error incierto no", () => {
  for (const status of ["REJECTED", "DECLINED", "CANCELLED", "EXPIRED", "REVOKED"])
    assert.equal(isVerifiedTerminalSignatureFailure(status), true, status);
  for (const status of ["ERROR", "FAILED", "PENDING", "CREATED", "SIGNED", "NOT_REJECTED"])
    assert.equal(isVerifiedTerminalSignatureFailure(status), false, status);
  const version = { status: "TECHNICAL_ERROR", newProcessUuid: "process-2", lastCheckedAt: new Date() };
  const process = { processUuid: "process-2", status: "REJECTED", completedAt: null,
    signedDocumentBase64: null };
  assert.equal(isVerifiedTerminalOperationalRetry(version, process), true);
  assert.equal(isVerifiedTerminalOperationalRetry({ ...version, status: "AWAITING_SIGNATURE" }, process), false);
  assert.equal(isVerifiedTerminalOperationalRetry({ ...version, lastCheckedAt: null }, process), false);
  assert.equal(isVerifiedTerminalOperationalRetry(version, { ...process, status: "ERROR" }), false);
  assert.equal(isVerifiedTerminalOperationalRetry(version, { ...process, status: "SIGNED",
    signedDocumentBase64: Buffer.from("%PDF-1.7").toString("base64") }), false);
  assert.equal(isVerifiedTerminalOperationalRetry(version, { ...process, processUuid: "process-3" }), false);
});

test("el callback solo cierra la versión de una firma fallida verificada sin PDF ni cierre", async () => {
  const start = completionSource.indexOf("export async function markOperationalSignatureTerminalFailure(");
  assert.ok(start >= 0);
  const end = completionSource.indexOf("export async function isSupersededTerminalOperationalProcess(", start);
  assert.ok(end > start);
  const statement = stripTypeScriptTypes(completionSource.slice(start, end).replace(/^export /, ""));
  const mark = new Function("isVerifiedTerminalSignatureFailure",
    `${statement}\nreturn markOperationalSignatureTerminalFailure;`)(isVerifiedTerminalSignatureFailure);
  const calls = [];
  const db = {
    $queryRawUnsafe: async () => [{ installed: "ApprovalOperationalContractVersion" }],
    $executeRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return 1; },
  };
  assert.equal(await mark(db, 42, "process-2", "ERROR"), false);
  assert.equal(calls.length, 0);
  assert.equal(await mark(db, 42, "process-2", "REJECTED"), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [42, "process-2", "REJECTED"]);
  assert.match(calls[0].sql, /"status"='AWAITING_SIGNATURE'/);
  assert.match(calls[0].sql, /"signedDocumentBase64" IS NULL/);
  assert.match(calls[0].sql, /"completedAt" IS NULL/);
});

test("el reintento referencia el PDF firmado y archiva aparte el proceso fallido", () => {
  assert.deepEqual(operationalSignatureLineage("fallido", "firmado", true), {
    previousProcessUuid: "firmado", supersededProcessUuid: "fallido",
  });
  assert.deepEqual(operationalSignatureLineage("firmado", "firmado", false), {
    previousProcessUuid: "firmado", supersededProcessUuid: null,
  });
  assert.equal(operationalProcessToSupersede({ previousProcessUuid: "firmado",
    supersededProcessUuid: "fallido" }), "fallido");
  assert.equal(operationalProcessToSupersede({ previousProcessUuid: "firmado",
    supersededProcessUuid: null }), "firmado");
});

test("un PDF tardío archivado se registra sin reactivar el crédito", async () => {
  const start = completionSource.indexOf("export async function recordLateSupersededOperationalSignature(");
  assert.ok(start >= 0);
  const statement = stripTypeScriptTypes(completionSource.slice(start).replace(/^export /, ""));
  const calls = [];
  const db = {
    $queryRawUnsafe: async (sql, ...args) => {
      calls.push({ sql, args });
      if (sql.includes('FROM "ApprovalOperationalContractVersion" failed')) return [{ id: "version-1" }];
      if (sql.includes('UPDATE "FirmaSeguroProcess"')) return [{ processUuid: "fallido" }];
      return [{ id: 1 }];
    },
    $executeRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return 1; },
  };
  const record = new Function("prisma", "signedPdfBytes",
    `${statement}\nreturn recordLateSupersededOperationalSignature;`)(
      { $transaction: async (callback) => callback(db) }, signedPdfBytes);
  const input = { creditId: 42, processUuid: "fallido", status: "SIGNED",
    signedDocumentBase64: Buffer.from("%PDF-1.7\nlate").toString("base64"),
    signedDocumentFileName: "firmado.pdf", statusPayload: {}, signaturesPayload: {}, documentsPayload: {} };
  assert.equal((await record(input))?.processUuid, "fallido");
  assert.match(calls.find((call) => call.sql.includes('UPDATE "FirmaSeguroProcess"')).sql,
    /"supersededAt" IS NOT NULL/);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE "Credito"')), false);
  calls.length = 0;
  assert.equal(await record({ ...input, signedDocumentBase64: "bm90IGEgcGRm" }), null);
  assert.equal(calls.length, 0);
  const refresh = firmaSeguroSource.slice(firmaSeguroSource.indexOf("export async function refreshFirmaSeguroProcess("));
  const update = refresh.indexOf("const updated = await updateFirmaSeguroProcess(");
  const late = refresh.indexOf("if (updated?.supersededAt && updated.creditoId && completed && signedDocumentBase64)");
  const completion = refresh.indexOf("if (updated && completed && updated.creditoId)");
  assert.ok(update >= 0 && late > update && completion > late,
    "el PDF descargado durante la carrera ACK debe reconciliarse antes de completar el crédito");
});

test("solo PREPARING permite reclamar el POST de FirmaSeguro", () => {
  assert.equal(canDispatchReservedVersion("PREPARING"), true);
  for (const state of ["DISPATCHING", "UNCERTAIN", "AWAITING_SIGNATURE", "COMPLETED", "FAILED_SAFE", "TECHNICAL_ERROR"])
    assert.equal(canDispatchReservedVersion(state), false, state);
});

test("la nueva versión conserva todas las cifras y solo sustituye identidad operativa/contacto", () => {
  const signed = Object.freeze({ imei: "111111111111111", deviceUid: "111111111111111",
    clienteTelefono: "3000000000", clienteCorreo: "antes@example.com", folio: "FC-1",
    montoCredito: 2_000_000, valorCuota: 155_550, plazoMeses: 34,
    tasaInteresEa: 0.27, fechaPrimerPago: "2026-10-17", financiero: { sello: "inalterado" } });
  const next = operationalFrozenCredit(signed, "355063664500617", "3180000000", "ahora@example.com");
  assert.deepEqual(Object.fromEntries(Object.entries(next).filter(([key]) =>
    !["imei", "deviceUid", "clienteTelefono", "clienteCorreo"].includes(key))),
  Object.fromEntries(Object.entries(signed).filter(([key]) =>
    !["imei", "deviceUid", "clienteTelefono", "clienteCorreo"].includes(key))));
  assert.equal(signed.imei, "111111111111111");
  assert.equal(next.imei, "355063664500617");
  assert.equal(next.deviceUid, next.imei);
});

test("la reserva de IMEI rechaza duplicados en créditos, borradores y reemplazos", async () => {
  const start = replacementSource.indexOf("async function assertImeiAvailable(");
  const end = replacementSource.indexOf("export async function lockCreditDeviceReplacementImeiForCreditCreation", start);
  assert.ok(start >= 0 && end > start);
  class Conflict extends Error { constructor(code, message) { super(message); this.code = code; } }
  const assertAvailable = new Function("CreditDeviceReplacementError",
    `${stripTypeScriptTypes(replacementSource.slice(start, end))}\nreturn assertImeiAvailable;`)(Conflict);
  for (const row of [
    { creditConflict: "FC-17", draftConflict: null, replacementConflict: null },
    { creditConflict: null, draftConflict: 18, replacementConflict: null },
    { creditConflict: null, draftConflict: null, replacementConflict: "replacement-1" },
  ]) {
    const database = { $queryRawUnsafe: async () => [row] };
    await assert.rejects(assertAvailable(database, { imei: "355063664500617", creditId: 1, solicitudId: 1 }),
      (error) => error.code === "IMEI_CONFLICT");
  }
});

test("el apply y la reserva del contrato comparten una sola transacción", () => {
  const start = replacementSource.indexOf("export async function completeCreditDeviceReplacement(");
  const end = replacementSource.indexOf("export async function cancelCreditDeviceReplacement(", start);
  const completion = replacementSource.slice(start, end);
  assert.match(completion, /return prisma\.\$transaction\(async \(transaction\) =>/);
  assert.ok(completion.indexOf("await applyApprovedReplacement(transaction") > 0);
  assert.ok(completion.indexOf("await input.onCompleted?.(transaction") > completion.indexOf("await applyApprovedReplacement(transaction"));
  assert.ok(completion.indexOf("return { id: row.id, status: \"COMPLETED\"") > completion.indexOf("await input.onCompleted?.(transaction"));
});
