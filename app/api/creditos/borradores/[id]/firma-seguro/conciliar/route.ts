import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { DraftDispatchError, getDraftDispatch } from "@/lib/firmaseguro-draft-dispatch-ledger";
import { reconcileDraftDispatchFromProvider } from "@/lib/firmaseguro-draft-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    if (!isAdminRole(user.rolNombre) || !isFinserPayCentralAlly(user.aliadoAccesoCodigo)) {
      return NextResponse.json({ ok: false, error: "Solo el administrador central puede conciliar este envío." }, { status: 403 });
    }
    const { id } = await context.params;
    const draftId = Number(id);
    const body = await request.json().catch(() => null);
    if (!Number.isSafeInteger(draftId) || draftId < 1 || !body ||
      typeof body.dispatchId !== "string" || typeof body.processUuid !== "string") {
      return NextResponse.json({ ok: false, error: "Indica la solicitud, el envío y el proceso que se deben conciliar." }, { status: 400 });
    }
    const dispatch = await getDraftDispatch(body.dispatchId);
    if (!dispatch || dispatch.draftId !== draftId) {
      return NextResponse.json({ ok: false, error: "El envío no pertenece a esta solicitud." }, { status: 404 });
    }
    const result = await reconcileDraftDispatchFromProvider({
      dispatchId: dispatch.id,
      processUuid: body.processUuid,
      actor: { id: user.id, nombre: user.nombre },
    });
    const requiresReview = result.status !== "AWAITING_SIGNATURE";
    return NextResponse.json({ ok: !requiresReview, recovered: true, requiresReview,
      status: result.status, processUuid: result.processUuid,
      ...(requiresReview ? { error: "Se recuperó la confirmación, pero el estado de la solicitud o de la firma requiere revisión." } : {}),
    }, { status: requiresReview ? 409 : 200 });
  } catch (error) {
    if (error instanceof DraftDispatchError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    console.error("ERROR CONCILIACION FIRMASEGURO:", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json({ ok: false, error: "No se pudo verificar la confirmación de FirmaSeguro. El envío sigue protegido contra duplicados." }, { status: 502 });
  }
}
