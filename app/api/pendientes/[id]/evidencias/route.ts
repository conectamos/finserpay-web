import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId } from "@/lib/credit-approval";
import { getPendingAllyActor } from "@/lib/credit-approval-novelty-http";
import { prepareNoveltyResponse, respondCreditApprovalNovelty, getPendingAllyEvidence } from "@/lib/credit-approval-novelties";
import { readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const actor = await getPendingAllyActor(); const id = approvalCreditId((await context.params).id);
    const input = await prepareNoveltyResponse(await readApprovalRequest(request, { maxBytes: 3_000_000 }), true);
    const result = await prisma.$transaction(db => respondCreditApprovalNovelty(db, id, input, actor), { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
export async function GET(request: Request, context: Context) {
  try {
    const actor = await getPendingAllyActor(); const id = approvalCreditId((await context.params).id);
    const key = new URL(request.url).searchParams.get("tipo") || "";
    const image = await prisma.$transaction(db => getPendingAllyEvidence(db, id, key, actor), { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return new NextResponse(new Uint8Array(image.bytes), { headers: { ...approvalPrivateHeaders, "Content-Type": image.mime, "Content-Disposition": "inline" } });
  } catch (error) { return approvalErrorResponse(error); }
}
