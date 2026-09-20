import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { approvalCreditId } from "@/lib/credit-approval";
import { parseApprovalDataCorrection } from "@/lib/credit-approval-data-core";
import { correctCreditApprovalData, getCreditApprovalDataDetail } from "@/lib/credit-approval-data";
import { assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import {
  approvalErrorResponse,
  approvalPrivateHeaders,
  getApprovalActor,
  readApprovalRequest,
} from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const result = await prisma.$transaction(async (db) => {
      await assertApprovalActorCreditReadAccess(db, id, actor);
      return getCreditApprovalDataDetail(db, id, actor);
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const input = parseApprovalDataCorrection(await readApprovalRequest(request, { maxBytes: 16_384 }));
    const result = await prisma.$transaction(
      (db) => correctCreditApprovalData(db, id, input, actor),
      { isolationLevel: "ReadCommitted", timeout: 20_000 },
    );
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
