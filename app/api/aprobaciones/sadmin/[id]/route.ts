import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSadminCreditSummary, updateSadminRegistration } from "@/lib/credit-sadmin";
import { getSadminApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getSadminApprovalActor();
    const { id } = await context.params;
    const summary = await getSadminCreditSummary(prisma, actor, id);
    return NextResponse.json({ ok: true, summary }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getSadminApprovalActor();
    const { id } = await context.params;
    const body = await readApprovalRequest(request);
    const sadmin = await updateSadminRegistration(prisma, actor, id, body);
    return NextResponse.json({ ok: true, sadmin }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
