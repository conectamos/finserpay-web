import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import {
  createMoraExceptionRequest,
  listMoraExceptionRequests,
  parseMoraExceptionCreate,
} from "@/lib/mora-exception-requests";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getMoraActor();
    const result = await listMoraExceptionRequests(new URL(request.url).searchParams, actor);
    return NextResponse.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getMoraActor();
    const input = parseMoraExceptionCreate(await readApprovalRequest(request, { maxBytes: 10_000 }));
    const result = await createMoraExceptionRequest(input, actor);
    return NextResponse.json({ ok: true, ...result }, { status: result.unchanged ? 200 : 201, headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
