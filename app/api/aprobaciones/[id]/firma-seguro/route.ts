import { NextResponse } from "next/server";
import { approvalCreditId } from "@/lib/credit-approval";
import { getApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { parseCreditApprovalReissue, requestCreditApprovalReissue, refreshCreditApprovalReissue } from "@/lib/credit-approval-reissue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const input = parseCreditApprovalReissue(await readApprovalRequest(request, { maxBytes: 4096 }));
    const reissue = input.action === "REQUEST"
      ? await requestCreditApprovalReissue(id, input, actor)
      : await refreshCreditApprovalReissue(id, input.operationId);
    return NextResponse.json({ ok: true, reissue }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
