import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getActiveSolicitudCreditContext } from "@/lib/solicitudes-storage";
import { canOperateSolicitud } from "@/lib/solicitud-operation-access";
import { getFirmaSeguroIdentityReviewDetail, saveFirmaSeguroIdentityReview, FirmaSeguroIdentityReviewError } from "@/lib/datacredito/firmaseguro-identity-review";
import { FirmaSeguroFullNameIdentityError } from "@/lib/datacredito/firmaseguro-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
async function access(context: Context) {
  const user = await getSessionUser();
  if (!user) return { response: NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 }) };
  const { id } = await context.params;
  const draftId = /^\d+$/.test(id) ? Number(id) : 0;
  if (!Number.isSafeInteger(draftId) || draftId <= 0 || draftId > 2147483647) return { response: NextResponse.json({ ok: false, error: "Solicitud no encontrada" }, { status: 404 }) };
  const owner = await getActiveSolicitudCreditContext(draftId);
  const admin = isAdminRole(user.rolNombre);
  const central = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  const seller = admin ? null : await getSellerSessionUser(user);
  const authorized = owner && (admin
    ? central || (user.aliadoId !== null && user.aliadoId === owner.aliadoId)
    : canOperateSolicitud({ central: false, seller, viewerAllyId: user.aliadoId, owner }));
  if (!authorized) return { response: NextResponse.json({ ok: false, error: "Solicitud no encontrada" }, { status: 404 }) };
  return { draftId, actor: { id: user.id, nombre: user.nombre, admin, central, aliadoId: user.aliadoId } };
}
function errorResponse(error: unknown) {
  if (error instanceof FirmaSeguroIdentityReviewError || error instanceof FirmaSeguroFullNameIdentityError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (error instanceof Error && /^DATACREDITO_IDENTITY_[A-Z_]+$/.test(error.message)) {
    return NextResponse.json({ ok: false, code: error.message, error: "La identidad de la consulta no corresponde a los datos guardados. Actualiza la solicitud sin repetir la consulta." }, { status: 409 });
  }
  return NextResponse.json({ ok: false, code: "FIRMASEGURO_REVIEW_UNAVAILABLE", error: "No se pudo cargar la revisión del firmante. Intenta nuevamente." }, { status: 500 });
}
export async function GET(_request: Request, context: Context) {
  try {
    const allowed = await access(context);
    if (allowed.response) return allowed.response;
    return NextResponse.json({ ok: true, item: await getFirmaSeguroIdentityReviewDetail(allowed.draftId!, allowed.actor!) });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const allowed = await access(context);
    if (allowed.response) return allowed.response;
    if (!allowed.actor!.admin) return NextResponse.json({ ok: false, code: "FIRMASEGURO_REVIEW_FORBIDDEN", error: "Sólo un administrador puede completar los componentes del firmante." }, { status: 403 });
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ ok: false, code: "FIRMASEGURO_REVIEW_INPUT_INVALID", error: "Revisa los datos enviados." }, { status: 400 });
    const item = await saveFirmaSeguroIdentityReview(allowed.draftId!, body as Record<string, unknown>, allowed.actor!);
    return NextResponse.json({ ok: true, item });
  } catch (error) { return errorResponse(error); }
}