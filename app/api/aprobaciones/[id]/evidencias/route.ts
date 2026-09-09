import { approvalCreditId, getApprovalEvidence } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const result = await getApprovalEvidence(prisma, id, new URL(request.url).searchParams.get("tipo") || "");
    return new Response(new Uint8Array(result.bytes), { headers: { ...approvalPrivateHeaders, "Content-Type": result.mime, "Content-Disposition": "inline" } });
  } catch (error) { return approvalErrorResponse(error); }
}
