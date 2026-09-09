import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getPendingAllyActor } from "@/lib/credit-approval-novelty-http";
import { listPendingAllyCredits } from "@/lib/credit-approval-novelties";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const actor = await getPendingAllyActor(); const query = new URL(request.url).searchParams;
    const page = await prisma.$transaction(db => listPendingAllyCredits(db, actor, { limit: query.get("limit"), cursor: query.get("cursor"), status: query.get("status") }), { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...page }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
