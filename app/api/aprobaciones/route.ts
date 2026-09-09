import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalDocumentNumber, listCreditApprovals } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await getApprovalActor();
    const documento = approvalDocumentNumber(new URL(request.url).searchParams.get("documento"));
    const items = await listCreditApprovals(prisma, documento);
    return NextResponse.json({ ok: true, items }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
