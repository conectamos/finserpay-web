import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { DraftDispatchError } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { recoverUncertainDraftDispatch } from "@/lib/firmaseguro-draft-administration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "no-store, private" };
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401, headers });
    if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo))
      return NextResponse.json({ ok: false, error: "Solo el administrador central puede autorizar esta recuperación." }, { status: 403, headers });
    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const result = await recoverUncertainDraftDispatch({
      draftId: Number(id), dispatchId: body?.dispatchId, reason: body?.reason,
      providerReviewConfirmed: body?.providerReviewConfirmed, remoteOutcomeUnknownAccepted: body?.remoteOutcomeUnknownAccepted,
      actor: { id: user.id, nombre: user.nombre },
    });
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof DraftDispatchError)
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
    console.error("ERROR RECUPERACION ADMINISTRATIVA FIRMASEGURO", { errorType: error instanceof Error ? error.name : "UnknownError" });
    return NextResponse.json({ ok: false, error: "No se pudo reservar la recuperación. Actualiza la solicitud antes de intentar de nuevo." }, { status: 502, headers });
  }
}
