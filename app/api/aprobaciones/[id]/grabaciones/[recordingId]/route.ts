import { approvalCreditId } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse } from "@/lib/credit-approval-http";
import { assertApprovalActorActive, assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import { approvalCallAudioResponse, approvalCallId } from "@/lib/credit-approval-call-http";
import { readCreditApprovalCallBytes } from "@/lib/credit-approval-call-store";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; recordingId: string }> }) {
  try {
    const actor = await getApprovalActor();
    const params = await context.params;
    const id = approvalCreditId(params.id), recordingId = approvalCallId(params.recordingId);
    const recording = await prisma.$transaction(async (db) => {
      await assertApprovalActorActive(db, actor);
      await assertApprovalActorCreditReadAccess(db, id, actor);
      return readCreditApprovalCallBytes(db, id, recordingId);
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return approvalCallAudioResponse(request, recording);
  } catch (error) { return approvalErrorResponse(error); }
}
