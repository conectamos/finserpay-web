import { merchantRetryAuthorized } from "@/lib/merchant-applications";
import { retryMerchantApplications } from "@/lib/merchant-applications-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!merchantRetryAuthorized(request)) return Response.json({ ok: false, error: "No autorizado" }, { status: 401, headers });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    (body.solicitudId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.solicitudId)) ||
    (body.limit !== undefined && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 10))) {
    return Response.json({ ok: false, error: "Indica un límite entre 1 y 10 o un identificador de solicitud válido." }, { status: 400, headers });
  }
  try {
    const summary = await retryMerchantApplications(body.limit || 10, body.solicitudId);
    return Response.json({ ok: summary.errors === 0, summary }, { status: summary.errors ? 503 : 200, headers });
  } catch {
    return Response.json({ ok: false, error: "No se pudo procesar la cola de notificaciones." }, { status: 503, headers });
  }
}
