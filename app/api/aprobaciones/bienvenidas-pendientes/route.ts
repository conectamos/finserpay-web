import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getApprovalWelcomeAlerts } from "@/lib/approval-welcome-alerts-read";
import { assertApprovalActorActive } from "@/lib/credit-approval-actor";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await getApprovalActor();
    const summary = await prisma.$transaction(async db => {
      await assertApprovalActorActive(db, actor);
      return getApprovalWelcomeAlerts(db);
    }, { isolationLevel: "RepeatableRead", timeout: 10_000 });
    return NextResponse.json({ ok: true, ...summary, checkedAt: new Date().toISOString() }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
