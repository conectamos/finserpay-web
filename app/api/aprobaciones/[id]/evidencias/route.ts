import { assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import { NextResponse } from "next/server";
import { prepareEvidenceCorrection, replaceApprovalEvidence } from "@/lib/credit-approval-evidence";
import { approvalCreditId, getApprovalEvidence } from "@/lib/credit-approval";
import { getApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const result = await prisma.$transaction(async (db) => {
      await assertApprovalActorCreditReadAccess(db, id, actor);
      return getApprovalEvidence(db, id, new URL(request.url).searchParams.get("tipo") || "");
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return new Response(new Uint8Array(result.bytes), { headers: { ...approvalPrivateHeaders, "Content-Type": result.mime, "Content-Disposition": "inline" } });
  } catch (error) { return approvalErrorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const input = await prepareEvidenceCorrection(await readApprovalRequest(request, { maxBytes: 3_000_000 }));
    const result = await prisma.$transaction((db) => replaceApprovalEvidence(db, id, input, actor), { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
