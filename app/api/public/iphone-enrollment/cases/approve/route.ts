import { NextRequest, NextResponse } from "next/server";
import {
  buildIphoneEnrollmentChecklist,
  getIphoneEnrollmentPortalConfiguration,
  getIphoneEnrollmentPortalCookieName,
  hashIphoneEnrollmentRateLimitKey,
  iphoneEnrollmentBodyErrorResponse,
  IphoneEnrollmentRequestBodyError,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  isIphoneEnrollmentCaseTokenForSession,
  isSameOriginIphoneEnrollmentRequest,
  readLimitedIphoneEnrollmentJson,
  verifyIphoneEnrollmentCaseToken,
  verifyIphoneEnrollmentPortalSession,
} from "@/lib/iphone-enrollment";
import {
  approveIphoneEnrollmentCase,
  consumeIphoneEnrollmentRateLimit,
  IphoneEnrollmentApprovalError,
  IphoneEnrollmentGrantError,
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
      caseToken?: unknown;
      enrollmentApproved?: unknown;
    }>(request);
    const rateLimit = await consumeIphoneEnrollmentRateLimit({
      subjectHash: hashIphoneEnrollmentRateLimitKey(
        "session",
        `${grantSession.grantId}:${signedSession.sessionId}`
      ),
      action: "APPROVE",
      maximum: 15,
    });
    if (!rateLimit.allowed) {
      const limited = response(
        { ok: false, error: "Demasiadas aprobaciones. Intenta mas tarde." },
        429
      );
      limited.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return limited;
    }
    if (grantSession.accessMode === "SHARED") {
      const sharedRateLimit = await consumeIphoneEnrollmentRateLimit({
        subjectHash: hashIphoneEnrollmentRateLimitKey(
          "grant",
          grantSession.accessFingerprint
        ),
        action: "APPROVE",
        maximum: 300,
      });
      if (!sharedRateLimit.allowed) {
        const limited = response(
          { ok: false, error: "Demasiadas aprobaciones. Intenta mas tarde." },
          429
        );
        limited.headers.set(
          "Retry-After",
          String(sharedRateLimit.retryAfterSeconds)
        );
        return limited;
      }
    }

    const caseToken = verifyIphoneEnrollmentCaseToken(body.caseToken);
    const checklist = buildIphoneEnrollmentChecklist(body.enrollmentApproved);
    if (
      !caseToken ||
      !checklist ||
      !isIphoneEnrollmentCaseTokenForSession(caseToken, signedSession)
    ) {
      return response(
        {
          ok: false,
          error: "La consulta vencio o falta confirmar el enrolamiento.",
        },
        400
      );
    }

    const result = await approveIphoneEnrollmentCase({
      caseToken,
      grant: grantSession,
      checklist,
    });
    return response(
      {
        ok: true,
        alreadyApproved: result.alreadyApproved,
        review: {
          id: result.review.id,
          decision: result.review.decision,
          analystName: result.review.analystName,
          analystExternalId: result.review.analystExternalId,
          approvedAt: result.review.approvedAt,
        },
      },
      200
    );
  } catch (error) {
    if (error instanceof IphoneEnrollmentRequestBodyError) {
      const failure = iphoneEnrollmentBodyErrorResponse(error);
      return response({ ok: false, error: failure.error }, failure.status);
    }
    if (error instanceof IphoneEnrollmentGrantError) {
      return response({ ok: false, error: "La sesion ya no esta activa." }, 401);
    }
    if (error instanceof IphoneEnrollmentApprovalError) {
      return response({ ok: false, code: error.code, error: error.message }, 409);
    }
    console.error("ERROR APROBANDO ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudo aprobar el enrolamiento" }, 500);
  }
}
