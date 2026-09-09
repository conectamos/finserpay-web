import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId } from "@/lib/credit-approval";
import { getPendingAllyActor } from "@/lib/credit-approval-novelty-http";
import { getPendingAllyCredit } from "@/lib/credit-approval-novelties";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getPendingAllyActor(); const id = approvalCreditId((await context.params).id);
    const item = await prisma.$transaction(db => getPendingAllyCredit(db, id, actor), { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, item }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
