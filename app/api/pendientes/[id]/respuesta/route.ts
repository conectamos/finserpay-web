import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId } from "@/lib/credit-approval";
import { getPendingAllyActor } from "@/lib/credit-approval-novelty-http";
import { prepareNoveltyResponse, respondCreditApprovalNovelty } from "@/lib/credit-approval-novelties";
import { readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const actor = await getPendingAllyActor(); const id = approvalCreditId((await context.params).id);
    const input = await prepareNoveltyResponse(await readApprovalRequest(request, { maxBytes: 16_000 }), false);
    const result = await prisma.$transaction(db => respondCreditApprovalNovelty(db, id, input, actor), { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
