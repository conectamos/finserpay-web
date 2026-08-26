import { NextRequest, NextResponse } from "next/server";
import {
  createIphoneEnrollmentCaseToken,
  getIphoneEnrollmentPortalConfiguration,
  getIphoneEnrollmentPortalCookieName,
  hashIphoneEnrollmentDocument,
  hashIphoneEnrollmentImei,
  hashIphoneEnrollmentRateLimitKey,
  iphoneEnrollmentBodyErrorResponse,
  IphoneEnrollmentRequestBodyError,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  isSameOriginIphoneEnrollmentRequest,
  normalizeIphoneEnrollmentDocument,
  normalizeIphoneEnrollmentImei,
  readLimitedIphoneEnrollmentJson,
  verifyIphoneEnrollmentPortalSession,
} from "@/lib/iphone-enrollment";
import {
  consumeIphoneEnrollmentRateLimit,
  findIphoneEnrollmentCase,
  validateIphoneEnrollmentPortalSession,
} from "@/lib/iphone-enrollment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const configuration = getIphoneEnrollmentPortalConfiguration();
    if (!configuration.enabled || !configuration.configured) {
      return response({ ok: false, error: "Modulo no disponible" }, 503);
    }
    if (!isSameOriginIphoneEnrollmentRequest(request)) {
      return response({ ok: false, error: "Solicitud no autorizada" }, 403);
    }
    const signedSession = verifyIphoneEnrollmentPortalSession(
      request.cookies.get(getIphoneEnrollmentPortalCookieName())?.value
    );
    const grantSession = signedSession
      ? await validateIphoneEnrollmentPortalSession(signedSession)
      : null;
    if (!signedSession || !grantSession) {
      return response({ ok: false, error: "Acceso no autorizado" }, 401);
    }

    const body = await readLimitedIphoneEnrollmentJson<{
      document?: unknown;
      imei?: unknown;
    }>(request);
    const rateLimit = await consumeIphoneEnrollmentRateLimit({
      subjectHash: hashIphoneEnrollmentRateLimitKey(
        "session",
        `${grantSession.grantId}:${signedSession.sessionId}`
      ),
      action: "LOOKUP",
      maximum: 30,
    });
    if (!rateLimit.allowed) {
      const limited = response(
        { ok: false, error: "Demasiadas consultas. Intenta mas tarde." },
        429
      );
      limited.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return limited;
    }

    const document = normalizeIphoneEnrollmentDocument(body.document);
    const imei = normalizeIphoneEnrollmentImei(body.imei);
    if (!document || !imei) {
      return response(
        {
          ok: false,
          error: "Ingresa una cedula valida y un IMEI de 15 digitos.",
        },
        400
      );
    }

    const result = await findIphoneEnrollmentCase({ document, imei });
    if (result.kind === "NOT_FOUND") {
      return response(
        {
          ok: false,
          error: "No se encontro una solicitud iPhone disponible con esos datos.",
        },
        404
      );
    }
    if (result.kind === "AMBIGUOUS") {
      return response(
        {
          ok: false,
          error:
            "No se pudo resolver una unica solicitud. Escala el caso a FINSER PAY.",
        },
        409
      );
    }

    const item = result.item;
    const caseToken = createIphoneEnrollmentCaseToken({
      solicitudId: item.solicitudId,
      documentHash: hashIphoneEnrollmentDocument(document),
      imeiHash: hashIphoneEnrollmentImei(imei),
      session: signedSession,
    });
    return response(
      {
        ok: true,
        caseToken,
        item: {
          solicitudId: item.solicitudId,
          solicitudNumero: item.solicitudNumero,
          clienteNombre: item.clienteNombre,
          documento: item.documentoMasked,
          imei: item.imeiMasked,
          equipo: item.equipo,
          sede: item.sede,
          aliado: item.aliado,
          review: item.review
            ? {
                id: item.review.id,
                decision: item.review.decision,
                analystName: item.review.analystName,
                analystExternalId: item.review.analystExternalId,
                approvedAt: item.review.approvedAt,
              }
            : null,
        },
      },
      200
    );
  } catch (error) {
    if (error instanceof IphoneEnrollmentRequestBodyError) {
      const failure = iphoneEnrollmentBodyErrorResponse(error);
      return response({ ok: false, error: failure.error }, failure.status);
    }
    console.error("ERROR CONSULTANDO CASO DE ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudo consultar la solicitud" }, 500);
  }
}
