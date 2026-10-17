import { assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import { NextResponse } from "next/server";
import { approvalCreditId, CreditApprovalError, getApprovalDocument } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
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

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const body = await readApprovalRequest(request);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 1 || !("expectedProcessUuid" in body))
      throw new CreditApprovalError("INVALID_REQUEST", "Actualiza el expediente antes de consultar su documento.", 400);
    const { refreshCreditApprovalDocument } = await import("@/lib/credit-approval-document-refresh");
    const result = await refreshCreditApprovalDocument(id, { expectedProcessUuid: body.expectedProcessUuid }, actor);
    return NextResponse.json({ ok: true, ...result },
      { headers: { ...approvalPrivateHeaders, Vary: "Cookie" } });
  } catch (error) { return approvalErrorResponse(error); }
}
