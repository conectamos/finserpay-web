import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";

type CallDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
export type ApprovalCallRecording = {
  id: string; revision: number; reviewHash: string; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; createdAt: string; actorName: string; href: string;
};
type RecordingRow = Omit<ApprovalCallRecording, "createdAt" | "href"> & { createdAt: Date | string };
export type ApprovalCallState = {
  available: boolean;
  recording: ApprovalCallRecording | null;
  validFor?: { revision: number; reviewHash: string };
};
export type ApprovalCallDocumentSource = {
  processUuid: string;
  missingPdfReviewHash: string;
  hashWithPreviousEvidence: (evidenceKey: string, previousDataUrl: string | null) => string | null;
};

export function approvalCallMetadata(creditId: number, row: RecordingRow): ApprovalCallRecording {
  return { id: row.id, revision: row.revision, reviewHash: row.reviewHash, fileName: row.fileName,
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, sha256: row.sha256,
    createdAt: new Date(row.createdAt).toISOString(), actorName: row.actorName,
    href: `/api/aprobaciones/${creditId}/grabaciones/${row.id}` };
}

/** null is an existing approval without audio; undefined resolves the current effective recording. */
export async function readCreditApprovalCallState(db: CallDatabase, creditId: number,
  revision: number, reviewHash: string, approvedRecordingId?: string | null,
  documentSource?: () => ApprovalCallDocumentSource): Promise<ApprovalCallState> {
  if (approvedRecordingId === null) return { available: true, recording: null };
  try {
    let rows = await db.$queryRawUnsafe<RecordingRow[]>(`SELECT "id"::text,"revision","reviewHash",
      "fileName","mimeType","sizeBytes","sha256","createdAt","actorName"
      FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1
        AND "id"=COALESCE($4::uuid,public.credit_approval_effective_call_recording($1,$2,$3))
      LIMIT 1`, creditId, revision, reviewHash, approvedRecordingId ?? null);
    if (!rows[0] && approvedRecordingId === undefined && documentSource) {
      const source = documentSource();
      // Evidence continuity alone does not bind the document hash. Reconstruct
      // the source tuple with the authorized previous photo AND no PDF, proving
      // that this audio predates the first PDF rather than a different PDF.
      const evidence = await db.$queryRawUnsafe<Array<{
        evidenceKey: string; previousDataUrl: string | null; sourceReviewHash: string;
      }>>(`SELECT evidence."evidenceKey",evidence."previousDataUrl",seal."sourceReviewHash"
        FROM public."CreditApprovalCallEvidenceSeal" seal
        JOIN public."CreditApprovalEvidenceRevision" evidence ON evidence."id"=seal."evidenceRevisionId"
        WHERE seal."creditoId"=$1 AND seal."sourceRevision"=$2-2
          AND seal."recordingId"=public.credit_approval_effective_call_recording($1,$2-1,$3)
          AND public.credit_approval_call_contract_hash($1)=seal."contractHash"
          AND public.credit_approval_call_evidence_transition_valid($1,seal."sourceRevision",$2-1)
          AND public.credit_approval_call_evidence_event_matches(evidence."id")
          AND public.credit_approval_call_evidence_hash($1,evidence."evidenceKey")=evidence."nextSha256"
          AND public.credit_approval_call_data_url_hash(evidence."previousDataUrl") IS NOT DISTINCT FROM evidence."previousSha256"
        LIMIT 2`, creditId, revision, source.missingPdfReviewHash);
      const evidenceSourceHash = evidence.length === 1 && source.hashWithPreviousEvidence(
        evidence[0].evidenceKey, evidence[0].previousDataUrl) === evidence[0].sourceReviewHash
        ? evidence[0].sourceReviewHash : null;
      // This narrow repair only appends a context-bound association after the
      // SQL guard proves a same-process audited PDF recovery. It never changes
      // audio bytes, approval decisions, financial terms or actor attribution.
      rows = await db.$queryRawUnsafe<RecordingRow[]>(`WITH restored AS MATERIALIZED (
        SELECT public.credit_approval_restore_document_call($1,$2,$3,$4,$5,$6) AS "id")
        SELECT recording."id"::text,recording."revision",recording."reviewHash",recording."fileName",recording."mimeType",
          recording."sizeBytes",recording."sha256",recording."createdAt",recording."actorName"
        FROM "CreditApprovalCallRecording" recording JOIN restored ON restored."id"=recording."id"
        WHERE recording."creditoId"=$1 LIMIT 1`, creditId, revision, reviewHash, source.missingPdfReviewHash,
        source.processUuid, evidenceSourceHash);
    }
    const recording = rows[0] ? approvalCallMetadata(creditId, rows[0]) : null;
    return { available: true, recording, ...(recording && approvedRecordingId === undefined
      ? { validFor: { revision, reviewHash } } : {}) };
  } catch {
    return { available: false, recording: null };
  }
}
