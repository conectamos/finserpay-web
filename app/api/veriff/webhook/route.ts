import { NextResponse } from "next/server";
import {
  extractVeriffSessionId,
  VeriffApiError,
  verifyVeriffSignature,
} from "@/lib/veriff";
import {
  getVeriffValidationBySessionId,
  serializeVeriffValidation,
  updateVeriffValidationFromDecision,
} from "@/lib/veriff-storage";
import { enforceVeriffRetryPolicy } from "@/lib/veriff-retry-policy";
import { tryAcquireSolicitudOperationLock } from "@/lib/firmaseguro-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature =
    request.headers.get("x-hmac-signature") ||
    request.headers.get("vrf-hmac-signature") ||
    request.headers.get("x-veriff-signature");

  let validSignature = false;

  try {
    validSignature = verifyVeriffSignature(rawBody, signature);
  } catch (error) {
    const message =
      error instanceof VeriffApiError
        ? error.message
        : "No se pudo validar la firma de Veriff";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }

  if (!validSignature) {
    return NextResponse.json(
      { ok: false, error: "Firma Veriff invalida" },
      { status: 401 }
    );
  }

  let payload: unknown;

  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Payload Veriff invalido" },
      { status: 400 }
    );
  }

  const sessionId = extractVeriffSessionId(payload);

  if (!sessionId) {
    return NextResponse.json(
      { ok: false, error: "Webhook Veriff sin session id" },
      { status: 400 }
    );
  }

  const current = await getVeriffValidationBySessionId(sessionId);

  if (!current) {
    return NextResponse.json({
      ok: true,
      ignored: true,
      message: "Sesion Veriff no encontrada en FINSER PAY",
    });
  }

  const operationLock = current.draftId
    ? await tryAcquireSolicitudOperationLock(current.draftId)
    : null;
  if (current.draftId && !operationLock) {
    return NextResponse.json(
      {
        ok: false,
        code: "SOLICITUD_OPERACION_EN_PROCESO",
        error:
          "La solicitud está finalizando. Reintenta la entrega del evento en unos segundos.",
        retryable: true,
      },
      { status: 409, headers: { "Retry-After": "2" } }
    );
  }

  try {
    const lockedCurrent = await getVeriffValidationBySessionId(sessionId);
    if (!lockedCurrent) {
      return NextResponse.json({
        ok: true,
        ignored: true,
        message: "Sesion Veriff no encontrada en FINSER PAY",
      });
    }
    const updated = await updateVeriffValidationFromDecision(
      lockedCurrent.id,
      payload,
      "webhookPayload"
    );

    const retryPolicy = await enforceVeriffRetryPolicy(updated);
    return NextResponse.json({
      ok: true,
      retryPolicy,
      validation: serializeVeriffValidation(updated),
    });
  } finally {
    await operationLock?.release();
  }
}
