import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { listSadminCredits } from "@/lib/credit-sadmin";
import { getApprovalActor, approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getApprovalActor();
    const params = new URL(request.url).searchParams;
    const result = await listSadminCredits(prisma, actor, {
      page: params.get("page"),
      q: params.get("q"),
      status: params.get("status"),
    });
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) { return approvalErrorResponse(error); }
}
