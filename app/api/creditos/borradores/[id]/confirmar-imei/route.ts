import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isDirectSalesProfile } from "@/lib/solicitud-operation-access";
import { ImeiConfirmationError } from "@/lib/credit-imei-confirmation";
import { confirmDraftImei } from "@/lib/credit-imei-confirmation-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    const admin = isAdminRole(user.rolNombre);
    const central = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const seller = admin ? null : await getSellerSessionUser(user);
    if (!central && !isDirectSalesProfile(seller?.tipoPerfil)) {
      return NextResponse.json({ ok: false, error: "Acción no autorizada" }, { status: 403 });
    }
    const { id } = await context.params;
    const draftId = Number(id);
    if (!Number.isSafeInteger(draftId) || draftId <= 0 || draftId > 2_147_483_647) return NextResponse.json({ ok: false, error: "Solicitud inválida" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const result = await confirmDraftImei({ draftId, enteredImei: body?.imei, userId: user.id, central, seller, viewerAllyId: user.aliadoId });
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ImeiConfirmationError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    if (error instanceof Error && error.message === "SOLICITUD_NO_AUTORIZADA") return NextResponse.json({ ok: false, error: "Solicitud no autorizada" }, { status: 403 });
    console.error("IMEI_CONFIRMATION_FAILED", { type: error instanceof Error ? error.name : "Unknown" });
    return NextResponse.json({ ok: false, error: "No se pudo guardar la confirmación del IMEI. Conserva los datos y reintenta." }, { status: 500 });
  }
}
