import { after, NextResponse } from "next/server";
import { getAllyPaymentAccess } from "@/lib/ally-payment-access";
import { getAllyPaymentDetail, AllyPaymentNotFoundError } from "@/lib/ally-payments";
import { DeliveryConflictError } from "@/lib/ally-settlement-delivery-store";
import { runSettlementDeliveryQueue, settlementDeliveryStore } from "@/lib/ally-settlement-delivery-service";
import { DeliveryBodyTooLargeError, readDeliveryBody } from "@/lib/ally-settlement-delivery-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store, max-age=0" };
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });
type Context = { params: Promise<{ id: string }> };
async function authorize(context: Context, write: boolean) {
  const access = await getAllyPaymentAccess();
  if (!access.ok) return { error: reply({ ok: false, error: "Acceso no autorizado." }, access.status) };
  if (write && access.kind !== "CENTRAL_ADMIN") return { error: reply({ ok: false, error: "Solo el administrador central puede reenviar liquidaciones." }, 403) };
  const { id: value } = await context.params;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: reply({ ok: false, error: "Liquidación inválida." }, 400) };
  const settlement = await getAllyPaymentDetail({ id, allyId: access.kind === "CENTRAL_ADMIN" ? null : access.allyId });
  return { access, settlement };
}
function failure(error: unknown) {
  if (error instanceof DeliveryBodyTooLargeError) return reply({ ok: false, error: "Solicitud demasiado grande." }, 413);
  if (error instanceof AllyPaymentNotFoundError) return reply({ ok: false, error: "Liquidación no encontrada." }, 404);
  if (error instanceof DeliveryConflictError) return reply({ ok: false, error: error.message }, 409);
  return reply({ ok: false, error: "No se pudo consultar o programar el envío. La liquidación sigue guardada." }, 500);
}
export async function GET(_request: Request, context: Context) {
  try {
    const result = await authorize(context, false);
    if (result.error) return result.error;
    return reply({ ok: true, ...await settlementDeliveryStore.list(result.settlement!.id) });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const result = await authorize(context, true);
    if (result.error) return result.error;
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) return reply({ ok: false, error: "Origen no autorizado." }, 403);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return reply({ ok: false, error: "Se requiere JSON." }, 415);
    const raw = await readDeliveryBody(request, 2048);
    let body;
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!body || !["EMAIL", "WHATSAPP"].includes(body.channel) ||
        typeof body.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId)) {
      return reply({ ok: false, error: "Indica canal y requestId UUID válidos." }, 400);
    }
    // The recipient always comes from this settlement's ally, never from the caller.
    const settlement = result.settlement!;
    await settlementDeliveryStore.retry(settlement, body.channel, body.requestId, result.access!.user.id);
    after(async () => {
      try { await runSettlementDeliveryQueue(settlement.id); }
      catch { console.error("[settlement-delivery] Reintento guardado; pendiente de recuperación."); }
    });
    return reply({ ok: true, ...await settlementDeliveryStore.list(settlement.id) });
  } catch (error) { return failure(error); }
}
