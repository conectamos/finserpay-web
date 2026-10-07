import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import {
  actOnMoraExceptionRequest,
  getMoraExceptionRequest,
  parseMoraExceptionDecision,
  parseCentralMoraExceptionDecision,
} from "@/lib/mora-exception-requests";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { syncCreditMoraById } from "@/lib/credit-mora-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getMoraActor();
    const { id } = await context.params;
    return NextResponse.json({ ok: true, ...await getMoraExceptionRequest(id, actor) }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await getMoraActor();
    const { id } = await context.params;
    const body = await readApprovalRequest(request, { maxBytes: 5_000 });
    const input = actor.centralAdmin ? parseCentralMoraExceptionDecision(body) : parseMoraExceptionDecision(body);
    const result = await actOnMoraExceptionRequest(id, input, actor);
    let moraSync: { ok: boolean; action: string; message: string } | null = null;
    if (input.action === "APPROVE" && result.item.status === "APPROVED") {
      try {
        const synced = await syncCreditMoraById(result.item.creditoId, { forceRemoteAudit: true });
        moraSync = { ok: synced.action !== "FAILED", action: synced.action, message: synced.message };
      } catch (error) {
        console.error("MORA_EXCEPTION_SYNC_FAILED", {
          requestId: id,
          creditoId: result.item.creditoId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        moraSync = {
          ok: false,
          action: "FAILED",
          message: "La excepción quedó aprobada, pero no se pudo sincronizar el desbloqueo inmediato. La sincronización automática volverá a intentarlo.",
        };
      }
    }
    return NextResponse.json({ ok: true, ...result, ...(moraSync ? { moraSync } : {}) }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
