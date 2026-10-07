import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { searchMoraExceptionCredits } from "@/lib/mora-exception-requests";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getMoraActor();
    const result = await searchMoraExceptionCredits(new URL(request.url).searchParams, actor);
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
