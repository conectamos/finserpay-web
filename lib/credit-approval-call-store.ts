import "server-only";
import { randomUUID } from "node:crypto";
import { getCreditApprovalDetail, type ApprovalDatabase } from "@/lib/credit-approval";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalActorAudit, assertApprovalActorActive, assertApprovalActorCreditAccess, type ApprovalActor } from "@/lib/credit-approval-actor";
import { readCreditApprovalCallState } from "@/lib/credit-approval-call-state";
import type { prepareApprovalCallFile } from "@/lib/credit-approval-call-file";

type Upload = Awaited<ReturnType<typeof prepareApprovalCallFile>> & { revision: number; reviewHash: string; idempotencyKey: string };
type PreviousUpload = {
  id: string; creditoId: number; revision: number; reviewHash: string; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; actorKind: string; actorUserId: number | null; actorGrantId: string | null; actorSessionId: string | null;
};

/** Caller supplies a transaction; the locked credit serializes uploads, corrections and approval. */
export async function saveCreditApprovalCall(db: ApprovalDatabase, creditId: number, input: Upload, actor: ApprovalActor) {
  await assertApprovalActorActive(db, actor);
  const credit = await db.$queryRawUnsafe<Array<{ id: number }>>('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', creditId);
  if (!credit[0]) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
  await assertApprovalActorCreditAccess(db, creditId, actor);
  await db.$queryRawUnsafe('SELECT "creditoId" FROM "CreditApprovalReview" WHERE "creditoId"=$1 FOR UPDATE', creditId);
  const audit = approvalActorAudit(actor);
  const previous = await db.$queryRawUnsafe<PreviousUpload[]>(`SELECT "id"::text,"creditoId","revision","reviewHash",
    "fileName","mimeType","sizeBytes","sha256","actorKind","actorUserId","actorGrantId"::text,"actorSessionId"::text
    FROM "CreditApprovalCallRecording" WHERE "idempotencyKey"=$1::uuid`, input.idempotencyKey);
  if (previous[0]) {
    const saved = previous[0];
    if (saved.creditoId !== creditId || saved.revision !== input.revision || saved.reviewHash !== input.reviewHash ||
        saved.sha256 !== input.sha256 || saved.fileName !== input.fileName || saved.mimeType !== input.mimeType || saved.sizeBytes !== input.sizeBytes ||
        saved.actorKind !== audit.actorKind || saved.actorUserId !== audit.actorUserId ||
        saved.actorGrantId !== audit.actorGrantId || saved.actorSessionId !== audit.actorSessionId) {
      throw new CreditApprovalError("CALL_RECORDING_KEY_CONFLICT", "Esta confirmación corresponde a otra carga. Actualiza el expediente.", 409);
    }
    return { state: await readCreditApprovalCallState(db, creditId, saved.revision, saved.reviewHash, saved.id), unchanged: true };
  }
  const detail = await getCreditApprovalDetail(db, creditId);
  if (!detail.callRecording.available) throw new CreditApprovalError("CALL_RECORDING_UNAVAILABLE", "No se pudo verificar el almacenamiento de grabaciones. Intenta de nuevo en unos momentos.", 503);
  if (detail.review.revision !== input.revision || detail.review.reviewHash !== input.reviewHash) {
    throw new CreditApprovalError("REVIEW_CHANGED", "El expediente cambió. Actualiza antes de cargar la grabación.", 409);
  }
  if (detail.review.status !== "PENDING" || !detail.review.required || !detail.capabilities.canCorrectEvidence) {
    throw new CreditApprovalError("CALL_RECORDING_NOT_ALLOWED", detail.capabilities.correctionBlockedReason || "Este crédito no permite cargar una grabación.", 409);
  }
  const id = randomUUID();
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalCallRecording"
    ("id","creditoId","revision","reviewHash","fileName","mimeType","sizeBytes","sha256","bytes",
      "createdAt","actorUserId","actorName","actorKind","actorGrantId","actorSessionId","idempotencyKey")
    VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9::bytea,clock_timestamp() AT TIME ZONE 'UTC',$10,$11,$12,$13::uuid,$14::uuid,$15::uuid)`,
    id, creditId, input.revision, input.reviewHash, input.fileName, input.mimeType, input.sizeBytes, input.sha256, input.bytes,
    audit.actorUserId, audit.actorName, audit.actorKind, audit.actorGrantId, audit.actorSessionId, input.idempotencyKey);
  return { state: await readCreditApprovalCallState(db, creditId, input.revision, input.reviewHash, id), unchanged: false };
}

/** Caller authenticates and checks read scope in the same transaction before fetching bytes. */
export async function readCreditApprovalCallBytes(db: ApprovalDatabase, creditId: number, recordingId: string) {
  const rows = await db.$queryRawUnsafe<Array<{ bytes: Uint8Array; mimeType: string; fileName: string }>>(`SELECT recording."bytes",recording."mimeType",recording."fileName"
    FROM "CreditApprovalCallRecording" recording JOIN "Credito" credit ON credit."id"=recording."creditoId"
    JOIN "Sede" site ON site."id"=credit."sedeId" JOIN "Aliado" ally ON ally."id"=site."aliadoId"
    WHERE recording."id"=$1::uuid AND recording."creditoId"=$2 AND UPPER(BTRIM(COALESCE(ally."codigo",'')))<>'FINSERPAY'`, recordingId, creditId);
  if (!rows[0]) throw new CreditApprovalError("CALL_RECORDING_NOT_FOUND", "Grabación no disponible.", 404);
  return { ...rows[0], bytes: Buffer.from(rows[0].bytes) };
}
