import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { updateSadminRegistration } from "@/lib/credit-sadmin";
import { getApprovalActor, readApprovalRequest, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getApprovalActor();
    const { id } = await context.params;
    const body = await readApprovalRequest(request);
    const sadmin = await updateSadminRegistration(prisma, actor, id, body);
    return NextResponse.json({ ok: true, sadmin }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
