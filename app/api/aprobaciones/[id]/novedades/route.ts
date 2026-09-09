import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId } from "@/lib/credit-approval";
import { assertApprovalActorActive, assertApprovalActorCreditAccess } from "@/lib/credit-approval-actor";
import { getApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { createCreditApprovalNovelty, getCreditApprovalNoveltyHistory, parseCreateNovelty } from "@/lib/credit-approval-novelties";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getApprovalActor(); const id = approvalCreditId((await context.params).id);
    const result = await prisma.$transaction(async db => {
      await assertApprovalActorActive(db, actor); await assertApprovalActorCreditAccess(db, id, actor);
      return getCreditApprovalNoveltyHistory(db, id);
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = await getApprovalActor(); const id = approvalCreditId((await context.params).id);
    const input = parseCreateNovelty(await readApprovalRequest(request, { maxBytes: 16_000 }));
    const result = await prisma.$transaction(db => createCreditApprovalNovelty(db, id, input, actor), { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
