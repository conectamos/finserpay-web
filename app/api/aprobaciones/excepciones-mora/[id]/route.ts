import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import {
  actOnMoraExceptionRequest,
  amendMoraExceptionRequest,
  getMoraExceptionRequest,
  parseCentralMoraExceptionAmendment,
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
    const action = body && typeof body === "object" && "action" in body ? body.action : null;
    const isAmendment = action === "EDIT" || action === "CANCEL";
    const result = isAmendment
      ? await amendMoraExceptionRequest(id, parseCentralMoraExceptionAmendment(body), actor)
      : await actOnMoraExceptionRequest(id, actor.centralAdmin ? parseCentralMoraExceptionDecision(body) : parseMoraExceptionDecision(body), actor);
    let moraSync: { ok: boolean; action: string; message: string } | null = null;
    if ((action === "APPROVE" && result.item.status === "APPROVED") || ("affectsMora" in result && result.affectsMora)) {
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
          message: isAmendment
            ? "El cambio quedó guardado, pero no se pudo sincronizar el estado del equipo de inmediato. La sincronización automática volverá a intentarlo."
            : "La excepción quedó aprobada, pero no se pudo sincronizar el desbloqueo inmediato. La sincronización automática volverá a intentarlo.",
        };
      }
    }
    return NextResponse.json({ ok: true, ...result, ...(moraSync ? { moraSync } : {}) }, { headers: approvalPrivateHeaders });
  } catch (error) {
    return approvalErrorResponse(error);
  }
}
