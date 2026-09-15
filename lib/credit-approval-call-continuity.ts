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
