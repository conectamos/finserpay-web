import "server-only";
import { readCreditApprovalCallState, type ApprovalCallState } from "@/lib/credit-approval-call-state";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalActorAudit, assertApprovalActorActive, assertApprovalActorCreditAccess, type ApprovalActor } from "@/lib/credit-approval-actor";
import { getCreditApprovalNoveltyState, resolveCreditApprovalNoveltyForApproval } from "@/lib/credit-approval-novelty-state";

import { createHash, randomUUID } from "node:crypto";
import { PAYMENT_FREQUENCY_OPTIONS } from "@/lib/credit-factory";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditApprovalRequiredSql } from "@/lib/credit-approval-policy";
import { normalizeBlacklistedDocument } from "@/lib/document-blacklist-core";
import { resolveAllyPaymentPlatform } from "@/lib/ally-payments-core";
import { getCreditApprovalReissueState } from "@/lib/credit-approval-reissue-state";
import { isFirmaSeguroCompletedStatus } from "@/lib/firmaseguro";

export type ApprovalDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
export type { ApprovalActor } from "@/lib/credit-approval-actor";
export { CreditApprovalError } from "@/lib/credit-approval-errors";

export const APPROVAL_EVIDENCE = [
  { key: "cedula-frente", label: "Cédula frontal", field: "contratoCedulaFrenteDataUrl" },
  { key: "cedula-posterior", label: "Cédula posterior", field: "contratoCedulaRespaldoDataUrl" },
  { key: "selfie-cedula", label: "Selfie con cédula", field: "iphoneSelfieCedulaDataUrl" },
  { key: "foto-entrega", label: "Foto de entrega", field: "fotoEntregaDataUrl" },
  { key: "foto-remision", label: "Remisión", field: "fotoRemisionDataUrl" },
] as const;
type EvidenceField = (typeof APPROVAL_EVIDENCE)[number]["field"];

export type ApprovalCredit = Record<EvidenceField, string | null> & {
  id: number; folio: string; clienteNombre: string; clienteDocumento: string | null;
  clienteCorreo: string | null; clienteTelefono: string | null; clienteDireccion: string | null;
  plazoMeses: number | null; frecuenciaPago: string | null; valorCuota: number | null;
  cuotaComercialGuardada: string | null; fechaPrimerPago: Date | null;
  fechaCredito: Date; createdAt: Date; estado: string; aliadoId: number;
  aliadoNombre: string; aliadoCodigo: string; valorEquipoTotal: number;
  cuotaInicial: number; saldoBaseFinanciado: number; contratoSnapshot: unknown;
  imei: string; referenciaEquipo: string | null; equipoMarca: string | null; equipoModelo: string | null;
  required: boolean; paid: boolean;
};
export type ApprovalReview = {
  status: "PENDING" | "APPROVED"; revision: number; approvedRevision: number | null;
  approvedAt: Date | null; approvedByName: string | null; reviewHash: string | null; callRecordingId?: string | null;
};
export type ApprovalAssessment = {
  id: string; score: number | null; offer: unknown; status: string;
};
export type ApprovalDocument = {
  id: number; processUuid: string; status: string; signedDocumentBase64: string | null;
  signedDocumentFileName: string | null; completedAt: Date | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function numeric(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function iso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}
function contact(value: unknown) {
  return typeof value === "string" ? value.trim() || null : null;
}
function positiveAmount(value: unknown) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const amount = numeric(value);
  return amount !== null && amount > 0 ? amount : null;
}
function storedCalendarDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function approvalCreditId(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) {
    throw new CreditApprovalError("INVALID_CREDIT", "Selecciona un crédito válido.");
  }
  return Number(value);
}
export function approvalDocumentNumber(value: unknown) {
  try { return normalizeBlacklistedDocument(value); }
  catch { throw new CreditApprovalError("INVALID_DOCUMENT", "Ingresa una cédula válida de 3 a 13 dígitos."); }
}
export function parseCreditApproval(input: unknown) {
  const body = record(input);
  const keys = Object.keys(body).sort().join(",");
  if (!["reviewHash,revision", "recordingId,reviewHash,revision"].includes(keys) ||
      ("recordingId" in body && (typeof body.recordingId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.recordingId))) ||
      typeof body.revision !== "number" || !Number.isSafeInteger(body.revision) || body.revision < 1 ||
      typeof body.reviewHash !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewHash)) {
    throw new CreditApprovalError("INVALID_REVIEW", "Actualiza y revisa el expediente antes de dar el OK.");
  }
  return { revision: body.revision, reviewHash: body.reviewHash, ...(typeof body.recordingId === "string" ? { recordingId: body.recordingId } : {}) };
}

export function approvalImage(value: string | null) {
  const match = value?.match(/^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  const mime = match[1].toLowerCase().replace("image/jpg", "image/jpeg");
  const valid = mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  return valid ? { bytes, mime } : null;
}
export function approvalPdf(value: string | null) {
  const raw = value?.replace(/^data:application\/pdf;base64,/i, "").replace(/\s/g, "");
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64");
  return bytes.subarray(0, 5).toString() === "%PDF-" ? bytes : null;
}

const requiredSql = buildCreditApprovalRequiredSql("credit");
const scopeSql = `UPPER(BTRIM(COALESCE(ally."codigo", ''))) <> 'FINSERPAY'`;

async function requirePolicy(db: ApprovalDatabase) {
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "CreditApprovalPolicy" WHERE "id" = 1');
  if (!rows.length) throw new CreditApprovalError("APPROVAL_UNAVAILABLE", "La revisión de créditos aún no está activada.", 503);
}

export async function listCreditApprovals(db: ApprovalDatabase, documento: string) {
  await requirePolicy(db);
  return db.$queryRawUnsafe<Array<{
    id: number; folio: string; clienteDocumento: string | null; clienteNombre: string;
    aliadoNombre: string; fechaCredito: Date; required: boolean; status: string;
  }>>(`SELECT credit."id", credit."folio", credit."clienteDocumento", credit."clienteNombre",
      ally."nombre" AS "aliadoNombre", credit."fechaCredito", ${requiredSql} AS required,
      CASE WHEN NOT ${requiredSql} THEN 'NOT_REQUIRED'
        WHEN review."status" = 'APPROVED' AND review."approvedRevision" = review."revision" THEN 'APPROVED'
        ELSE 'PENDING' END AS status
    FROM "Credito" credit JOIN "Sede" site ON site."id" = credit."sedeId"
    JOIN "Aliado" ally ON ally."id" = site."aliadoId"
    LEFT JOIN "CreditApprovalReview" review ON review."creditoId" = credit."id"
    WHERE ${scopeSql} AND credit."clienteDocumento" = $1
    ORDER BY credit."createdAt" DESC, credit."id" DESC LIMIT 100`, documento);
}

async function readCredit(db: ApprovalDatabase, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<ApprovalCredit[]>(`SELECT credit."id", credit."folio",
      credit."clienteNombre", credit."clienteDocumento", credit."fechaCredito", credit."createdAt",
      credit."clienteCorreo", credit."clienteTelefono", credit."clienteDireccion", credit."plazoMeses", credit."frecuenciaPago",
      credit."valorCuota", credit."fechaPrimerPago", amortization."cuotaComercial"::text AS "cuotaComercialGuardada",
      credit."estado", credit."valorEquipoTotal", credit."cuotaInicial", credit."saldoBaseFinanciado",
      credit."contratoSnapshot", credit."imei", credit."referenciaEquipo", credit."equipoMarca", credit."equipoModelo",
      ${APPROVAL_EVIDENCE.map(({ field }) => `credit."${field}"`).join(", ")},
      ally."id" AS "aliadoId", ally."nombre" AS "aliadoNombre", ally."codigo" AS "aliadoCodigo",
      ${requiredSql} AS required,
      EXISTS (SELECT 1 FROM "LiquidacionAliadoCredito" paid WHERE paid."creditoId" = credit."id") AS paid
    FROM "Credito" credit JOIN "Sede" site ON site."id" = credit."sedeId"
    JOIN "Aliado" ally ON ally."id" = site."aliadoId"
    LEFT JOIN "CreditoAmortizacion" amortization ON amortization."creditoId" = credit."id"
    WHERE credit."id" = $1 AND ${scopeSql}${lock ? " FOR UPDATE OF credit" : ""}`, id);
  if (!rows[0]) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  return rows[0];
}
async function readReview(db: ApprovalDatabase, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<ApprovalReview[]>(`SELECT "status", "revision", "approvedRevision",
      "approvedAt", "approvedByName", "reviewHash", "callRecordingId"::text FROM "CreditApprovalReview"
    WHERE "creditoId" = $1${lock ? " FOR UPDATE" : ""}`, id);
  return rows[0] || null;
}
async function readAssessment(db: ApprovalDatabase, credit: ApprovalCredit) {
  const assessmentId = record(record(record(credit.contratoSnapshot).financiero).dataCredito).assessmentId;
  const rows = await db.$queryRawUnsafe<ApprovalAssessment[]>(`SELECT "id", "score", "offer", "status"
    FROM "DataCreditoAssessment" WHERE "creditId" = $1 AND "consumedAt" IS NOT NULL
      AND "retainedUntil" > CURRENT_TIMESTAMP AND ($2::text IS NULL OR "id"::text = $2)
    ORDER BY "consumedAt" DESC, "id" DESC LIMIT 1`, credit.id, typeof assessmentId === "string" ? assessmentId : null);
  return rows[0] || null;
}
async function readDocument(db: ApprovalDatabase, id: number) {
  const rows = await db.$queryRawUnsafe<ApprovalDocument[]>(`SELECT "id", "processUuid", "status",
      "signedDocumentBase64", "signedDocumentFileName", "completedAt"
    FROM "FirmaSeguroProcess" WHERE "creditoId" = $1 AND "supersededAt" IS NULL
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`, id);
  return rows[0] || null;
}

function creditApprovalReviewHash(credit: ApprovalCredit, assessment: ApprovalAssessment | null, document: ApprovalDocument | null) {
  return digest({
    creditId: credit.id, document: credit.clienteDocumento, name: credit.clienteNombre,
    allyId: credit.aliadoId, imei: credit.imei, marca: credit.equipoMarca, modelo: credit.equipoModelo,
    valorVenta: credit.valorEquipoTotal, inicial: credit.cuotaInicial, principal: credit.saldoBaseFinanciado,
    financial: record(credit.contratoSnapshot).financiero,
    evidence: APPROVAL_EVIDENCE.map(({ field }) => digest(credit[field])),
    assessment: assessment ? [assessment.id, assessment.score, assessment.offer, assessment.status] : null,
    firmaSeguro: document ? [document.id, document.processUuid, document.status, iso(document.completedAt), digest(document.signedDocumentBase64)] : null,
  });
}

export function buildCreditApprovalDetail(credit: ApprovalCredit, review: ApprovalReview | null, assessment: ApprovalAssessment | null, document: ApprovalDocument | null, reissue: Awaited<ReturnType<typeof getCreditApprovalReissueState>> = { available: true, blocked: false, operation: null }, novelties: Awaited<ReturnType<typeof getCreditApprovalNoveltyState>> = { available: true, blocksApproval: false, blocksSettlement: false, pendingCount: 0, answeredCount: 0, novelty: null }, callState: ApprovalCallState = { available: true, recording: null }, reviewHash = creditApprovalReviewHash(credit, assessment, document)) {
  const evidence = APPROVAL_EVIDENCE.map((item) => ({
    key: item.key, label: item.label, available: Boolean(approvalImage(credit[item.field])),
    href: `/api/aprobaciones/${credit.id}/evidencias?tipo=${item.key}`,
  }));
  const documentAvailable = Boolean(document && approvalPdf(document.signedDocumentBase64) &&
    (document.completedAt || isFirmaSeguroCompletedStatus(document.status)));
  const offer = record(assessment?.offer);
  const savedTerms = record(record(record(credit.contratoSnapshot).financiero).dataCredito);
  const score = numeric(assessment?.score);
  const validScore = score !== null && Number.isInteger(score) && score >= -1 && score <= 950;
  const approved = review?.status === "APPROVED" && review.approvedRevision === review.revision;

  // Same stored commercial installment precedence used by the credit factory.
  const financial = record(credit.contratoSnapshot).financiero;
  const valorCuota = positiveAmount(credit.cuotaComercialGuardada)
    ?? positiveAmount(record(financial).cuotaComercial) ?? positiveAmount(credit.valorCuota);
  const installments = positiveAmount(credit.plazoMeses);
  const frequency = contact(credit.frecuenciaPago)?.toUpperCase();
  const equipmentFallback = [contact(credit.equipoMarca), contact(credit.equipoModelo)].filter(Boolean).join(" ");
  const referenciaEquipo = contact(credit.referenciaEquipo) || equipmentFallback || null;
  const cancelled = ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"].includes(credit.estado.trim().toUpperCase());
  const correctionBlockedReason = !credit.required ? "Este crédito conserva las reglas anteriores a la activación."
    : credit.paid ? "Este crédito ya está incluido en una liquidación pagada."
    : cancelled ? "El crédito está anulado o cancelado."
    : reissue.blocked ? "Resuelve el reenvío de firma en curso antes de corregir o aprobar este expediente."
    : !reissue.available ? "No se pudo verificar el estado de la firma. Actualiza el expediente." : null;
  const recordingRequired = credit.required && !approved;
  const currentRecording = callState.recording && (!recordingRequired || (
    callState.recording.revision === (review?.revision || 1) && callState.recording.reviewHash === reviewHash
  )) ? callState.recording : null;
  const recordingBlockedReason = recordingRequired && (!callState.available || !currentRecording)
    ? !callState.available ? "No se pudo verificar la grabación de la llamada. Actualiza el expediente."
      : "Realiza la llamada y adjunta su grabación antes de confirmar el OK para liquidación."
    : null;
  const blockingReasons: string[] = [];
  if (!novelties.available) blockingReasons.push("No se pudo verificar el estado de las novedades. Actualiza el expediente.");
  else if (novelties.blocksApproval) blockingReasons.push("Hay novedades pendientes de corrección. Revisa las respuestas antes de confirmar el OK.");
  if (reissue.blocked || !reissue.available) blockingReasons.push(correctionBlockedReason || "La firma está pendiente de verificación.");
  if (!credit.required) blockingReasons.push("Este crédito conserva las reglas anteriores a la activación.");
  if (credit.paid) blockingReasons.push("Este crédito ya está incluido en una liquidación pagada.");
  if (cancelled) blockingReasons.push("El crédito está anulado o cancelado.");
  if (!resolveAllyPaymentPlatform(credit.contratoSnapshot, credit.equipoMarca)) blockingReasons.push("La plataforma del crédito no está identificada.");
  if (!(credit.valorEquipoTotal > credit.cuotaInicial && credit.cuotaInicial >= 0)) blockingReasons.push("Los valores del crédito no permiten liquidación.");
  if (!assessment || !validScore || assessment.status !== "APROBADO") blockingReasons.push("La evaluación de DataCrédito vinculada al crédito no está disponible para revisión.");
  for (const item of evidence) if (!item.available) blockingReasons.push(`Falta evidencia válida: ${item.label}.`);
  if (!documentAvailable) blockingReasons.push("El documento firmado de FirmaSeguro aún no está disponible.");
  if (recordingBlockedReason) blockingReasons.push(recordingBlockedReason);
  return {
    id: credit.id, folio: credit.folio, clienteDocumento: credit.clienteDocumento,
    clienteNombre: credit.clienteNombre, aliadoNombre: credit.aliadoNombre, fechaCredito: iso(credit.fechaCredito),
    clienteCorreo: contact(credit.clienteCorreo), clienteTelefono: contact(credit.clienteTelefono),
    clienteDireccion: contact(credit.clienteDireccion), referenciaEquipo,
    numeroCuotas: installments !== null && Number.isSafeInteger(installments) ? installments : null,
    frecuenciaPago: frequency && PAYMENT_FREQUENCY_OPTIONS.some((option) => option.value === frequency) ? frequency : null,
    valorCuota, fechaPrimerPago: storedCalendarDate(credit.fechaPrimerPago),
    score: validScore && score !== -1 ? score : null,
    scoreLabel: validScore ? score === -1 ? "Sin información" : String(score) : "No disponible",
    initialPaymentPercentage: numeric(offer.initialPaymentPercentage), cuotaInicial: Number(credit.cuotaInicial),
    creditoAutorizado: Number(credit.saldoBaseFinanciado || Math.max(0, credit.valorEquipoTotal - credit.cuotaInicial)),
    approvedLimit: numeric(savedTerms.resolvedMaxFinancedAmount ?? savedTerms.maxFinancedAmount ?? offer.maxFinancedAmount),
    valorVenta: Number(credit.valorEquipoTotal),
    review: { required: credit.required, status: !credit.required ? "NOT_REQUIRED" : approved ? "APPROVED" : "PENDING",
      revision: review?.revision || 1, reviewHash, approvedAt: approved ? iso(review?.approvedAt || null) : null,
      approvedByName: approved ? review?.approvedByName || null : null },
    callRecording: { available: callState.available, recording: currentRecording, required: recordingRequired,
      canUpload: recordingRequired && correctionBlockedReason === null && callState.available,
      blockedReason: recordingBlockedReason || (recordingRequired ? correctionBlockedReason : null) },
    canApprove: blockingReasons.length === 0 && !approved, blockingReasons, evidence: evidence.map((item) => ({ ...item, href: `${item.href}&revision=${reviewHash}` })), reissue, novelties,
    capabilities: { canCreateNovelty: correctionBlockedReason === null && novelties.available, canCorrectEvidence: correctionBlockedReason === null, canReissueSignature: correctionBlockedReason === null && documentAvailable && Boolean(document?.processUuid?.trim()), correctionBlockedReason },
    document: { processUuid: document?.processUuid || null, available: documentAvailable, href: `/api/aprobaciones/${credit.id}/documento`, fileName: document?.signedDocumentFileName || null },
  };
}

export async function getCreditApprovalDetail(db: ApprovalDatabase, id: number) {
  await requirePolicy(db);
  const credit = await readCredit(db, id);
  const review = await readReview(db, id);
  const assessment = await readAssessment(db, credit);
  const document = await readDocument(db, id);
  const reissue = await getCreditApprovalReissueState(db, id);
  const novelties = await getCreditApprovalNoveltyState(db, id);
  const reviewHash = creditApprovalReviewHash(credit, assessment, document);
  const approved = review?.status === "APPROVED" && review.approvedRevision === review.revision;
  const callState = await readCreditApprovalCallState(db, id, review?.revision || 1, reviewHash, approved ? review.callRecordingId ?? null : undefined);
  return buildCreditApprovalDetail(credit, review, assessment, document, reissue, novelties, callState, reviewHash);
}

/** Caller supplies a transaction. Lock order matches corrections and ally payments. */
export async function approveCredit(db: ApprovalDatabase, id: number, input: ReturnType<typeof parseCreditApproval>, actor: ApprovalActor) {
  await assertApprovalActorActive(db, actor);
  await requirePolicy(db);
  const credit = await readCredit(db, id, true);
  await assertApprovalActorCreditAccess(db, id, actor);
  const review = await readReview(db, id, true);
  const assessment = await readAssessment(db, credit);
  const document = await readDocument(db, id);
  const reissue = await getCreditApprovalReissueState(db, id);
  const novelties = await getCreditApprovalNoveltyState(db, id);
  const reviewHash = creditApprovalReviewHash(credit, assessment, document);
  const approved = review?.status === "APPROVED" && review.approvedRevision === review.revision;
  const callState = await readCreditApprovalCallState(db, id, review?.revision || 1, reviewHash, approved ? review.callRecordingId ?? null : undefined);
  const item = buildCreditApprovalDetail(credit, review, assessment, document, reissue, novelties, callState, reviewHash);
  if (!novelties.available || novelties.blocksApproval) throw new CreditApprovalError("NOVELTY_PENDING", "Hay novedades que deben corregirse antes de confirmar el OK.", 409);
  if (reissue.blocked || !reissue.available) throw new CreditApprovalError("SIGNATURE_REISSUE_PENDING", "La nueva firma debe quedar completa antes de confirmar el OK.", 409);
  if (input.revision !== item.review.revision || input.reviewHash !== item.review.reviewHash) {
    throw new CreditApprovalError("REVIEW_CHANGED", "El expediente cambió. Actualiza y vuelve a revisar los documentos antes de dar el OK.", 409);
  }
  // A retry of the same confirmed revision produces no second event or actor change.
  if (item.review.status === "APPROVED" && review?.reviewHash === input.reviewHash) {
    if (input.recordingId && input.recordingId !== review.callRecordingId) throw new CreditApprovalError("CALL_RECORDING_CHANGED", "La aprobación conserva una grabación diferente. Actualiza el expediente.", 409);
    return { item, unchanged: true };
  }
  if (!callState.available) throw new CreditApprovalError("CALL_RECORDING_UNAVAILABLE", "No se pudo verificar la grabación de la llamada. Actualiza el expediente.", 503);
  if (!item.callRecording.recording) throw new CreditApprovalError("CALL_RECORDING_REQUIRED", "Realiza la llamada y adjunta su grabación antes de confirmar el OK para liquidación.", 409);
  if (!input.recordingId || input.recordingId !== item.callRecording.recording.id) throw new CreditApprovalError("CALL_RECORDING_CHANGED", "Revisa la grabación vigente antes de confirmar el OK para liquidación.", 409);
  if (!item.canApprove) throw new CreditApprovalError("REVIEW_NOT_READY", item.blockingReasons[0] || "El crédito no permite esta aprobación.", 409);
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalReview" ("creditoId", "status", "revision", "createdAt", "updatedAt")
    VALUES ($1, 'PENDING', 1, CURRENT_TIMESTAMP AT TIME ZONE 'UTC', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') ON CONFLICT ("creditoId") DO NOTHING`, id);
  await resolveCreditApprovalNoveltyForApproval(db, id, actor);
  const audit = approvalActorAudit(actor);
  const updated = await db.$executeRawUnsafe(`UPDATE "CreditApprovalReview" SET "status" = 'APPROVED',
    "approvedRevision" = "revision", "approvedByUserId" = $2, "approvedByName" = $3,
    "approvedByKind" = $6, "approvedByGrantId" = $7::uuid, "approvedBySessionId" = $8::uuid, "callRecordingId" = $9::uuid,
    "approvedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC', "reviewHash" = $4, "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    WHERE "creditoId" = $1 AND "revision" = $5`, id, audit.actorUserId, audit.actorName, input.reviewHash, input.revision, audit.actorKind, audit.actorGrantId, audit.actorSessionId, input.recordingId);
  if (updated !== 1) throw new CreditApprovalError("REVIEW_CHANGED", "La revisión cambió. Actualiza el expediente.", 409);
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalEvent"
    ("id", "creditoId", "eventType", "revision", "actorUserId", "actorName", "reason", "reviewHash", "createdAt", "actorKind", "actorGrantId", "actorSessionId", "callRecordingId")
    VALUES ($1::uuid, $2, 'APPROVED', $3, $4, $5, 'Documentación revisada para liquidación al aliado', $6, CURRENT_TIMESTAMP AT TIME ZONE 'UTC', $7, $8::uuid, $9::uuid, $10::uuid)`,
    randomUUID(), id, input.revision, audit.actorUserId, audit.actorName, input.reviewHash, audit.actorKind, audit.actorGrantId, audit.actorSessionId, input.recordingId);
  const confirmedReview = await readReview(db, id);
  return { item: buildCreditApprovalDetail(credit, confirmedReview, assessment, document, reissue, await getCreditApprovalNoveltyState(db, id), callState, reviewHash), unchanged: false };
}

export async function getApprovalEvidence(db: ApprovalDatabase, id: number, key: string) {
  const config = APPROVAL_EVIDENCE.find((item) => item.key === key);
  if (!config) throw new CreditApprovalError("INVALID_EVIDENCE", "Evidencia no válida.");
  const rows = await db.$queryRawUnsafe<Array<{ value: string | null }>>(`SELECT credit."${config.field}" AS value
    FROM "Credito" credit JOIN "Sede" site ON site."id" = credit."sedeId"
    JOIN "Aliado" ally ON ally."id" = site."aliadoId" WHERE credit."id" = $1 AND ${scopeSql}`, id);
  const image = approvalImage(rows[0]?.value || null);
  if (!image) throw new CreditApprovalError("EVIDENCE_NOT_FOUND", "Evidencia no disponible.", 404);
  return image;
}
export async function getApprovalDocument(db: ApprovalDatabase, id: number) {
  await readCredit(db, id);
  const document = await readDocument(db, id);
  const bytes = approvalPdf(document?.signedDocumentBase64 || null);
  if (!bytes || !document || !(document.completedAt || isFirmaSeguroCompletedStatus(document.status))) {
    throw new CreditApprovalError("DOCUMENT_NOT_READY", "El documento firmado aún no está disponible.", 409);
  }
  return { bytes, fileName: (document.signedDocumentFileName || `firmaseguro-${id}.pdf`).replace(/[\r\n"\\/]/g, "_") };
}
