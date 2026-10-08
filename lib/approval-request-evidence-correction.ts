import "server-only";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { ensureApprovalOperationalSchema } from "@/lib/approval-operations-schema";
import { ensureFirmaSeguroSchema, lockSolicitudOperationMutation } from "@/lib/firmaseguro-storage";
import { ensureSolicitudSchema } from "@/lib/solicitudes-storage";
import { ensureVeriffSchema, lockVeriffDraftAttempts } from "@/lib/veriff-storage";
import { isFirmaSeguroSuccessfulStatus } from "@/lib/firmaseguro-status";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";
import { correctionRecord, RequestDataCorrectionError } from "@/lib/approval-request-correction-core";
import { applyRequestEvidenceCorrection, REQUEST_EVIDENCE_CONFIG, requestEvidenceBytes,
  requestEvidenceEligibility, requestEvidenceHash, requestEvidenceRevision, requestEvidenceValue,
  type RequestEvidenceCorrectionInput } from "@/lib/approval-request-evidence-correction-core";

type Database = Prisma.TransactionClient;
type Actor = { id: number; nombre: string };
type Draft = { id: number; estado: string; creditoId: number | null; expired: boolean; payload: unknown };

async function ensureReadSchemas() {
  await Promise.all([ensureSolicitudSchema(), ensureFirmaSeguroSchema(), ensureVeriffSchema()]);
}
async function readDraft(db: Database, id: number, lock = false) {
  const rows = await db.$queryRawUnsafe<Draft[]>(`SELECT "id","estado","creditoId","payload",
    COALESCE("expiresAt", "createdAt" + INTERVAL '15 days') <= CURRENT_TIMESTAMP AS "expired"
    FROM "CreditoBorrador" WHERE "id"=$1 LIMIT 1${lock ? " FOR UPDATE" : ""}`, id);
  if (!rows[0]) throw new RequestDataCorrectionError("REQUEST_NOT_FOUND", "Solicitud no disponible.", 404);
  return { row: rows[0], payload: correctionRecord(rows[0].payload) };
}
async function readState(db: Database, id: number, row: Draft, payload: Record<string, unknown>) {
  const history = (await db.$queryRawUnsafe<Array<{
    identityStarted: boolean; signatureStarted: boolean; dispatchTablePresent: boolean;
  }>>(`SELECT EXISTS(SELECT 1 FROM "VeriffIdentityValidation" WHERE "draftId"=$1) AS "identityStarted",
    EXISTS(SELECT 1 FROM "FirmaSeguroProcess" WHERE "draftId"=$1) AS "signatureStarted",
    to_regclass('public."FirmaSeguroDraftDispatch"') IS NOT NULL AS "dispatchTablePresent"`, id))[0];
  const signature = (await db.$queryRawUnsafe<Array<{
    processUuid: string; status: string; completedAt: Date | null; hasSignedDocument: boolean;
  }>>(`SELECT "processUuid","status","completedAt",
    LEFT(COALESCE("signedDocumentBase64",''),7)='JVBERi0' AS "hasSignedDocument"
    FROM "FirmaSeguroProcess" WHERE "draftId"=$1 AND "supersededAt" IS NULL
    ORDER BY "id" DESC LIMIT 1`, id))[0];
  let dispatchPending = false;
  if (history?.dispatchTablePresent) dispatchPending = (await db.$queryRawUnsafe<Array<{ pending: boolean }>>(`SELECT EXISTS(
    SELECT 1 FROM "FirmaSeguroDraftDispatch" WHERE "draftId"=$1
      AND "status" IN ('PREPARING','DISPATCHING','UNCERTAIN')) AS "pending"`, id))[0]?.pending === true;
  const reissue = String(payload.firmaSeguroReissueProcessUuid || "").trim();
  const signatureCompleted = Boolean(signature?.completedAt && signature.hasSignedDocument &&
    isFirmaSeguroSuccessfulStatus(signature.status) && (!reissue || reissue === signature.processUuid));
  const correctionPending = payload.firmaSeguroCorrectionPending === true ||
    payload.firmaSeguroIdentityCorrectionPending === true || payload.firmaSeguroFinancialCorrectionPending === true ||
    payload.firmaSeguroContactCorrectionPending === true || Boolean(reissue && !signatureCompleted);
  const eligibility = requestEvidenceEligibility({ open: row.estado === "ABIERTO" && row.creditoId === null,
    expired: row.expired, identityStarted: history?.identityStarted === true,
    signatureStarted: history?.signatureStarted === true, signatureCompleted, dispatchPending, correctionPending });
  return { ...eligibility, signature, reissue };
}
function view(payload: Record<string, unknown>, state: Awaited<ReturnType<typeof readState>>) {
  return { revision: requestEvidenceRevision(payload), documents: state.documents.map((doc) => {
    const value = requestEvidenceValue(payload, doc.key);
    return { ...doc, available: Boolean(value), sha256: requestEvidenceHash(value) };
  }), canManageContract: state.canManageContract,
    signedDocument: { available: state.signature?.hasSignedDocument === true, editable: false,
      reason: "El documento firmado se conserva desde FirmaSeguro y no puede reemplazarse con un archivo." } };
}
export async function getAnalystRequestEvidence(id: number) {
  await ensureReadSchemas();
  return prisma.$transaction(async (db) => {
    const { row, payload } = await readDraft(db, id);
    return view(payload, await readState(db, id, row, payload));
  }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
}
export async function correctAnalystRequestEvidence(id: number, input: RequestEvidenceCorrectionInput, actor: Actor) {
  if (!Number.isSafeInteger(actor.id) || actor.id <= 0 || !actor.nombre.trim())
    throw new RequestDataCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  const validated = await sanitizeIphoneDeliveryEvidenceDataUrl(input.dataUrl);
  if (!validated) throw new RequestDataCorrectionError("INVALID_FILE", "Adjunta una foto JPG o PNG válida, de hasta 1,8 MB y 12 megapíxeles.", 400);
  await ensureReadSchemas();
  await ensureApprovalOperationalSchema();
  return prisma.$transaction(async (db) => {
    await lockSolicitudOperationMutation(db, id);
    await lockVeriffDraftAttempts(db, id);
    const { row, payload } = await readDraft(db, id, true);
    const state = await readState(db, id, row, payload);
    const selected = state.documents.find((doc) => doc.key === input.key);
    if (!selected?.editable) throw new RequestDataCorrectionError("EVIDENCE_LOCKED", selected?.reason || "Esta evidencia no permite correcciones.");
    if (state.reissue && (input.key === "foto-entrega" || input.key === "foto-remision")) {
      const archived = await db.$queryRawUnsafe<Array<{ matchesArchived: boolean }>>(`SELECT EXISTS(
        SELECT 1 FROM "SolicitudImeiCorrectionAudit" WHERE "draftId"=$1 AND "eventType"='CORRECTED'
          AND "archivedEvidence"->'fields'->>$2::text=$3) AS "matchesArchived"`, id,
      REQUEST_EVIDENCE_CONFIG[input.key].field, validated);
      if (archived[0]?.matchesArchived) throw new RequestDataCorrectionError("STALE_IMEI_EVIDENCE", "Adjunta una foto nueva del equipo y la remisión correspondientes al IMEI corregido.");
    }
    const correction = applyRequestEvidenceCorrection(payload, { ...input, dataUrl: validated },
      state.documents.filter((doc) => doc.editable).map((doc) => doc.key), actor.nombre);
    const previousMedia = requestEvidenceBytes(correction.previous);
    if (previousMedia && previousMedia.bytes.length > 10_485_760)
      throw new RequestDataCorrectionError("ARCHIVE_UNAVAILABLE", "La evidencia anterior requiere revisión para conservar su historial antes del reemplazo.");
    const config = REQUEST_EVIDENCE_CONFIG[input.key];
    const previousDetails = { evidenceKey: input.key, field: config.field,
      sha256: correction.previousSha256, available: Boolean(correction.previous),
      capturedAt: payload[`${config.prefix}CapturedAt`] ?? null, source: payload[`${config.prefix}Source`] ?? null,
      analystEvidenceRevision: requestEvidenceRevision(payload) };
    const nextDetails = { evidenceKey: input.key, field: config.field, sha256: correction.nextSha256, available: true,
      capturedAt: correction.payload[`${config.prefix}CapturedAt`], source: correction.payload[`${config.prefix}Source`],
      analystEvidenceRevision: correction.revision };
    await db.$executeRawUnsafe(`UPDATE "CreditoBorrador" SET "payload"=$2::jsonb,"updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"=$1 AND "estado"='ABIERTO' AND "creditoId" IS NULL`, id, JSON.stringify(correction.payload));
    await db.$executeRawUnsafe(`INSERT INTO "ApprovalOperationalAction"
      ("id","targetKind","targetId","eventType","actorUserId","actorName","reason",
        "evidenceMime","evidenceName","evidenceData","evidenceSha256","beforeContact","afterContact","status")
      VALUES ($1::uuid,'DRAFT',$2,'CONTACT_UPDATED',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,'EVIDENCE_CORRECTED')`,
    randomUUID(), id, actor.id, actor.nombre, input.reason,
    previousMedia?.mime ?? null, previousMedia ? `anterior-${input.key}.${previousMedia.mime === "image/png" ? "png" : previousMedia.mime === "image/webp" ? "webp" : "jpg"}` : null,
    previousMedia?.bytes ?? null, previousMedia ? correction.previousSha256 : null,
    JSON.stringify(previousDetails), JSON.stringify(nextDetails));
    return view(correction.payload, state);
  }, { isolationLevel: "ReadCommitted", timeout: 20_000 });
}
