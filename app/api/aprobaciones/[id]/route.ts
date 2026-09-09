import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId, getCreditApprovalDetail, approveCredit, parseCreditApproval } from "@/lib/credit-approval";
import { getApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const item = await prisma.$transaction((db) => getCreditApprovalDetail(db, id), { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, item }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const input = parseCreditApproval(await readApprovalRequest(request));
    const result = await prisma.$transaction((db) => approveCredit(db, id, input, actor), { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
