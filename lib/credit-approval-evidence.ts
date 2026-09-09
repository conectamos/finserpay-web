import "server-only";
import { assertApprovalActorActive, assertApprovalActorCreditAccess } from "@/lib/credit-approval-actor";
import { markNoveltyPhotoCorrected } from "@/lib/credit-approval-novelty-state";
import { APPROVAL_EVIDENCE, CreditApprovalError, getCreditApprovalDetail, parseCreditApproval, type ApprovalActor, type ApprovalDatabase } from "@/lib/credit-approval";
import { sanitizeIphoneDeliveryEvidenceDataUrl } from "@/lib/iphone-delivery-evidence";
import { archiveEvidenceRevision, correctedEvidenceSnapshot, evidenceSha256 } from "@/lib/credit-approval-evidence-history";

export function parseEvidenceCorrection(input: unknown) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const config = APPROVAL_EVIDENCE.find(({ key }) => key === body.key);
  if (Object.keys(body).sort().join(",") !== "dataUrl,key,reviewHash,revision" || !config || typeof body.dataUrl !== "string") {
    throw new CreditApprovalError("INVALID_EVIDENCE", "Selecciona una de las cinco fotografías y una imagen PNG o JPEG válida.");
  }
  return { key: config.key, dataUrl: body.dataUrl, ...parseCreditApproval({ revision: body.revision, reviewHash: body.reviewHash }) };
}

export async function prepareEvidenceCorrection(input: unknown) {
  const parsed = parseEvidenceCorrection(input);
  const dataUrl = await sanitizeIphoneDeliveryEvidenceDataUrl(parsed.dataUrl);
  if (!dataUrl) throw new CreditApprovalError("INVALID_EVIDENCE", "La fotografía debe ser PNG o JPEG válida y estar dentro del tamaño permitido.");
  return { ...parsed, dataUrl };
}

type EvidenceRow = { id: number; contratoSnapshot: unknown } & Record<(typeof APPROVAL_EVIDENCE)[number]["field"], string | null>;

/** Caller supplies a transaction. All corrections lock Credit before Review. */
export async function replaceApprovalEvidence(db: ApprovalDatabase, id: number,
  input: Awaited<ReturnType<typeof prepareEvidenceCorrection>>, actor: ApprovalActor) {
  await assertApprovalActorActive(db, actor);
  const rows = await db.$queryRawUnsafe<EvidenceRow[]>(`SELECT "id", "contratoSnapshot",
    ${APPROVAL_EVIDENCE.map(({ field }) => `"${field}"`).join(", ")}
    FROM "Credito" WHERE "id" = $1 FOR UPDATE`, id);
  if (!rows[0]) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  await assertApprovalActorCreditAccess(db, id, actor);
  await db.$queryRawUnsafe('SELECT "creditoId" FROM "CreditApprovalReview" WHERE "creditoId" = $1 FOR UPDATE', id);
  const item = await getCreditApprovalDetail(db, id);
  if (!item.capabilities.canCorrectEvidence) {
    throw new CreditApprovalError("CORRECTION_NOT_ALLOWED", item.capabilities.correctionBlockedReason || "Este crédito no permite corregir fotografías.", 409);
  }
  if (item.review.revision !== input.revision || item.review.reviewHash !== input.reviewHash) {
    throw new CreditApprovalError("REVIEW_CHANGED", "El expediente cambió. Revisa la fotografía actual antes de reemplazarla.", 409);
  }
  const config = APPROVAL_EVIDENCE.find(({ key }) => key === input.key);
  if (!config) throw new CreditApprovalError("INVALID_EVIDENCE", "Fotografía no válida.");
  const credit = rows[0];
  const previousDataUrl = credit[config.field];
  const previousSha256 = evidenceSha256(previousDataUrl);
  const nextSha256 = evidenceSha256(input.dataUrl)!;
  if (previousSha256 === nextSha256) return { item, unchanged: true };
  if (["cedula-frente", "cedula-posterior", "selfie-cedula"].includes(input.key) &&
    APPROVAL_EVIDENCE.slice(0, 3).some(({ key, field }) => key !== input.key && evidenceSha256(credit[field]) === nextSha256)) {
    throw new CreditApprovalError("DUPLICATE_IDENTITY_EVIDENCE", "Las fotos de la cédula y la selfie deben ser imágenes diferentes.");
  }
  const snapshot = correctedEvidenceSnapshot(credit.contratoSnapshot, {
    key: input.key, field: config.field, previousSha256, nextSha256,
    correctedAt: new Date().toISOString(), actor, source: "CORRECCION_ANALISTA_APROBACION",
  });
  await archiveEvidenceRevision(db, {
    creditId: id, key: input.key, previousDataUrl, previousSha256, nextSha256, actor,
    source: "ANALISTA_APROBACION", reviewRevision: item.review.revision, reviewHash: item.review.reviewHash,
  });
  await db.$executeRawUnsafe(`UPDATE "Credito" SET "${config.field}" = $2, "contratoSnapshot" = $3::jsonb,
    "updatedAt" = CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "id" = $1`, id, input.dataUrl, JSON.stringify(snapshot));
  await markNoveltyPhotoCorrected(db, id, input.key, nextSha256, actor);
  return { item: await getCreditApprovalDetail(db, id), unchanged: false };
}
