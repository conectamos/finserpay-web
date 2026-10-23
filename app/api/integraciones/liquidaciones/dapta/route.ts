import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DeliveryBodyTooLargeError, readDeliveryBody } from "@/lib/ally-settlement-delivery-body";
import {
  createDaptaSettlementCallbackStore, daptaCallbackAuthorized, parseDaptaCallback,
  DaptaCallbackConflictError, DaptaCallbackInputError,
} from "@/lib/ally-settlement-delivery-dapta-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
});

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return response({ ok: false, error: "Se requiere JSON." }, 415);
  }
  try {
    const raw = await readDeliveryBody(request, 16 * 1024);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new DaptaCallbackInputError("JSON inválido."); }
    const input = parseDaptaCallback(body);
    if (!daptaCallbackAuthorized(request, input)) return response({ ok: false, error: "Callback no autorizado." }, 401);
    const store = createDaptaSettlementCallbackStore(prisma);
    return response(input.action === "claim" ? await store.claim(input) : await store.receipt(input));
  } catch (error) {
    if (error instanceof DeliveryBodyTooLargeError) return response({ ok: false, error: "Callback demasiado grande." }, 413);
    if (error instanceof DaptaCallbackInputError) return response({ ok: false, error: error.message }, 400);
    if (error instanceof DaptaCallbackConflictError) return response({ ok: false, error: error.message }, 409);
    // Bodies can include a signed document URL or recipient. Never log them.
    console.error("[settlement-dapta] No se pudo persistir la autorización o conciliación.");
    return response({ ok: false, error: "No se pudo procesar el callback." }, 500);
  }
}
