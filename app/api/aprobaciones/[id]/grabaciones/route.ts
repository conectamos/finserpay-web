import { NextResponse } from "next/server";
import { approvalCreditId, getCreditApprovalDetail } from "@/lib/credit-approval";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { assertApprovalActorActive, assertApprovalActorCreditAccess, assertApprovalActorCreditReadAccess } from "@/lib/credit-approval-actor";
import { approvalCallRequestHeaders, readApprovalCallBytes } from "@/lib/credit-approval-call-http";
import { prepareApprovalCallFile } from "@/lib/credit-approval-call-file";
import { saveCreditApprovalCall } from "@/lib/credit-approval-call-store";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const state = await prisma.$transaction(async (db) => {
      await assertApprovalActorActive(db, actor);
      await assertApprovalActorCreditReadAccess(db, id, actor);
      return (await getCreditApprovalDetail(db, id)).callRecording;
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 });
    return NextResponse.json({ ok: true, state }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const actor = await getApprovalActor();
    const id = approvalCreditId((await context.params).id);
    const metadata = approvalCallRequestHeaders(request);
    await prisma.$transaction(async (db) => {
      await assertApprovalActorActive(db, actor);
      await assertApprovalActorCreditAccess(db, id, actor);
    }, { isolationLevel: "ReadCommitted", timeout: 20_000 });
    const file = await prepareApprovalCallFile(await readApprovalCallBytes(request), metadata.fileName);
    const result = await prisma.$transaction((db) => saveCreditApprovalCall(db, id, { ...file, ...metadata }, actor),
      { isolationLevel: "ReadCommitted", timeout: 20_000 });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
