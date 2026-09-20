import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { assertApprovalActorActive } from "@/lib/credit-approval-actor";
import { listApprovalEquipmentCatalog } from "@/lib/credit-approval-data";
import { approvalErrorResponse, approvalPrivateHeaders, getApprovalActor } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await getApprovalActor();
    const items = await prisma.$transaction(async (db) => {
      await assertApprovalActorActive(db, actor);
      return listApprovalEquipmentCatalog(db);
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, items }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
