import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import {
  changeMoraExceptionPermission,
  listMoraExceptionPermissions,
  parseMoraPermissionMutation,
} from "@/lib/mora-exception-permissions";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await getMoraActor();
    return NextResponse.json({ ok: true, ...await listMoraExceptionPermissions(actor) }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getMoraActor();
    const input = parseMoraPermissionMutation(await readApprovalRequest(request, { maxBytes: 3_000 }));
    return NextResponse.json({ ok: true, ...await changeMoraExceptionPermission(input, actor) }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
