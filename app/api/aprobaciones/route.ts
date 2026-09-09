import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalDocumentNumber, listCreditApprovals } from "@/lib/credit-approval";
import { listCreditApprovalQueue, approvalQueueLimit } from "@/lib/credit-approval-queue";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await getApprovalActor();
    const params = new URL(request.url).searchParams;
    const document = params.get("documento");
    const documento = document ? approvalDocumentNumber(document) : null;
    if (documento && params.get("view") !== "pending" && actor.kind !== "SHARED_LINK") {
      const items = await listCreditApprovals(prisma, documento);
      return NextResponse.json({ ok: true, items }, { headers: approvalPrivateHeaders });
    }
    const page = await listCreditApprovalQueue(prisma, { documento, cursor: params.get("cursor"), limit: approvalQueueLimit(params.get("limit")) });
    return NextResponse.json({ ok: true, ...page }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
