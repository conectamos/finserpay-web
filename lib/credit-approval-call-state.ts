import "server-only";
import type { Prisma } from "@/app/generated/prisma/client";

type CallDatabase = Pick<Prisma.TransactionClient, "$queryRawUnsafe">;
export type ApprovalCallRecording = {
  id: string; revision: number; reviewHash: string; fileName: string; mimeType: string;
  sizeBytes: number; sha256: string; createdAt: string; actorName: string; href: string;
};
type RecordingRow = Omit<ApprovalCallRecording, "createdAt" | "href"> & { createdAt: Date | string };
export type ApprovalCallState = { available: boolean; recording: ApprovalCallRecording | null };

export function approvalCallMetadata(creditId: number, row: RecordingRow): ApprovalCallRecording {
  return { id: row.id, revision: row.revision, reviewHash: row.reviewHash, fileName: row.fileName,
    mimeType: row.mimeType, sizeBytes: row.sizeBytes, sha256: row.sha256,
    createdAt: new Date(row.createdAt).toISOString(), actorName: row.actorName,
    href: `/api/aprobaciones/${creditId}/grabaciones/${row.id}` };
}

/** null is an existing approval without audio; undefined is a pending review. */
export async function readCreditApprovalCallState(db: CallDatabase, creditId: number,
  revision: number, reviewHash: string, approvedRecordingId?: string | null): Promise<ApprovalCallState> {
  if (approvedRecordingId === null) return { available: true, recording: null };
  try {
    const rows = await db.$queryRawUnsafe<RecordingRow[]>(`SELECT "id"::text,"revision","reviewHash",
      "fileName","mimeType","sizeBytes","sha256","createdAt","actorName"
      FROM "CreditApprovalCallRecording" WHERE "creditoId"=$1
        AND (($4::uuid IS NOT NULL AND "id"=$4::uuid)
          OR ($4::uuid IS NULL AND "revision"=$2 AND "reviewHash"=$3))
      ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`, creditId, revision, reviewHash, approvedRecordingId ?? null);
    return { available: true, recording: rows[0] ? approvalCallMetadata(creditId, rows[0]) : null };
  } catch {
    return { available: false, recording: null };
  }
}
