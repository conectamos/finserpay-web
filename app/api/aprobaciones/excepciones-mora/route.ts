import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import {
  createMoraExceptionRequest,
  listMoraExceptionRequests,
  parseMoraExceptionCreate,
  parseCentralMoraExceptionCreate,
} from "@/lib/mora-exception-requests";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { syncCreditMoraById } from "@/lib/credit-mora-sync";

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
    const body = await readApprovalRequest(request, { maxBytes: 10_000 });
    const input = actor.centralAdmin ? parseCentralMoraExceptionCreate(body) : parseMoraExceptionCreate(body);
    const result = await createMoraExceptionRequest(input, actor);
    let moraSync: { ok: boolean; action: string; message: string } | null = null;
    if (result.item.status === "APPROVED") {
      try {
        const synced = await syncCreditMoraById(result.item.creditoId, { forceRemoteAudit: true });
        moraSync = { ok: synced.action !== "FAILED", action: synced.action, message: synced.message };
      } catch (error) {
        console.error("MORA_EXCEPTION_SYNC_FAILED", {
          requestId: result.item.id, creditoId: result.item.creditoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        moraSync = { ok: false, action: "FAILED",
          message: "La excepción quedó registrada, pero no se pudo sincronizar el desbloqueo inmediato. La sincronización automática volverá a intentarlo." };
      }
    }
    return NextResponse.json({ ok: true, ...result, ...(moraSync ? { moraSync } : {}) }, { status: result.unchanged ? 200 : 201, headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
