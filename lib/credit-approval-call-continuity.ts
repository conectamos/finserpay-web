import "server-only";
import { randomUUID } from "node:crypto";
import { getCreditApprovalDetail, type ApprovalDatabase } from "@/lib/credit-approval";

type ApprovalCallContinuityDetail = {
  id: number;
  review: { revision: number; reviewHash: string; status: string };
  callRecording?: { available: boolean; recording: { id: string } | null };
};

export type ApprovalCallContinuitySource = {
  recordingId: string;
  revision: number;
  reviewHash: string;
};

export type ApprovalCallContinuityEvent = {
  noveltyId: string;
  noveltyEventId: string;
};

export type ApprovalCallEvidenceSeal = {
  evidenceRevisionId: string;
};

export type ApprovalCallReissueSeal = {
  operationId: string;
};

/**
 * Captures the recording that is valid for the review tuple immediately before
 * an authorised novelty mutation. A stale recording has already been filtered
 * out by getCreditApprovalDetail and therefore cannot become valid again here.
 */
export function captureCreditApprovalCallContinuity(
  detail: ApprovalCallContinuityDetail,
): ApprovalCallContinuitySource | null {
  const recording = detail.callRecording?.available ? detail.callRecording.recording : null;
  if (!recording) return null;
  return {
    recordingId: recording.id,
    revision: detail.review.revision,
    reviewHash: detail.review.reviewHash,
  };
}

/**
 * Associates the same immutable audio with the tuple produced by an authorised
 * novelty event. The database trigger validates the complete transition; this
 * helper never copies or edits the recording bytes.
 */
export async function continueCreditApprovalCall(
  db: ApprovalDatabase,
  creditId: number,
  source: ApprovalCallContinuitySource | null,
  event: ApprovalCallContinuityEvent,
  currentDetail?: ApprovalCallContinuityDetail,
) {
  if (!source) return false;
  const target = currentDetail || await getCreditApprovalDetail(db, creditId);
  if (target.id !== creditId || target.review.status !== "PENDING") return false;
  if (source.revision === target.review.revision && source.reviewHash === target.review.reviewHash) return false;

  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalCallContinuation"
    ("id","creditoId","recordingId","noveltyId","noveltyEventId","sourceRevision","sourceReviewHash","targetRevision","targetReviewHash","createdAt")
    VALUES ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
    randomUUID(), creditId, source.recordingId, event.noveltyId, event.noveltyEventId,
    source.revision, source.reviewHash, target.review.revision, target.review.reviewHash);
  return true;
}

/**
 * Seals an evidence replacement before the credit row changes. PostgreSQL
 * derives and verifies the contractual fingerprint; the immutable audio bytes
 * are only referenced by id.
 */
export async function sealCreditApprovalEvidenceCall(
  db: ApprovalDatabase,
  creditId: number,
  source: ApprovalCallContinuitySource | null,
  event: ApprovalCallEvidenceSeal,
) {
  if (!source) return false;
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalCallEvidenceSeal"
    ("evidenceRevisionId","creditoId","recordingId","sourceRevision","sourceReviewHash","captureKind","createdAt")
    VALUES ($1::uuid,$2,$3::uuid,$4,$5,'LIVE',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
    event.evidenceRevisionId, creditId, source.recordingId, source.revision, source.reviewHash);
  return true;
}

/**
 * Seals the audio source immediately after the reissue request is audited.
 * The SQL guard accepts only the request invalidation produced by that same
 * operation and records the pre-existing contractual fingerprint.
 */
export async function sealCreditApprovalReissueCall(
  db: ApprovalDatabase,
  creditId: number,
  source: ApprovalCallContinuitySource | null,
  event: ApprovalCallReissueSeal,
) {
  if (!source) return false;
  await db.$executeRawUnsafe(`INSERT INTO "CreditApprovalCallReissueSeal"
    ("operationId","creditoId","recordingId","sourceRevision","sourceReviewHash","captureKind","createdAt")
    VALUES ($1::uuid,$2,$3::uuid,$4,$5,'LIVE',CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
    event.operationId, creditId, source.recordingId, source.revision, source.reviewHash);
  return true;
}
