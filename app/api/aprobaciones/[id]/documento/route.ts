import { assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import { approvalCreditId, getApprovalDocument } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const result = await prisma.$transaction(async (db) => {
      await assertApprovalActorCreditReadAccess(db, id, actor);
      return getApprovalDocument(db, id);
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return new Response(new Uint8Array(result.bytes), { headers: { ...approvalPrivateHeaders, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${result.fileName}"` } });
  } catch (error) { return approvalErrorResponse(error); }
}
