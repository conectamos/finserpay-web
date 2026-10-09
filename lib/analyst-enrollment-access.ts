import "server-only";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { assertMoraActor, getMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { IphoneEnrollmentDiagnosticError } from "@/lib/iphone-enrollment-diagnostics";
import { CreditDeviceReplacementError } from "@/lib/credit-device-replacement-storage";
import {
  getIphoneEnrollmentPortalConfiguration,
  hashIphoneEnrollmentRateLimitKey,
  iphoneEnrollmentBodyErrorResponse,
  IphoneEnrollmentRequestBodyError,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  isSameOriginIphoneEnrollmentRequest,
  verifyIphoneEnrollmentPortalSession,
} from "@/lib/iphone-enrollment";
import {
  consumeIphoneEnrollmentRateLimit,
  IphoneEnrollmentApprovalError,
  IphoneEnrollmentGrantError,
  validateIphoneEnrollmentPortalSession,
  type IphoneEnrollmentGrantSession,
} from "@/lib/iphone-enrollment-storage";

export const ANALYST_ENROLLMENT_COOKIE_PATH = "/api/aprobaciones/enrolamiento";
export function analystEnrollmentCookieName() {
  return process.env.NODE_ENV === "production"
    ? "__Secure-finser-analyst-enrollment"
    : "finser-analyst-enrollment";
}

export function enrollmentResponse(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

export async function requireAnalystEnrollmentActor(request: NextRequest) {
  if (!isSameOriginIphoneEnrollmentRequest(request)) {
    throw new CreditApprovalError("INVALID_ORIGIN", "Solicitud no autorizada.", 403);
  }
  const actor = await getMoraActor();
  const verified = await prisma.$transaction((db) => assertMoraActor(db, actor));
  const configuration = getIphoneEnrollmentPortalConfiguration();
  if (!configuration.enabled || !configuration.configured) {
    throw new CreditApprovalError("ENROLLMENT_UNAVAILABLE", "Módulo no disponible.", 503);
  }
  return verified;
}

export function isAnalystEnrollmentGrant(grant: IphoneEnrollmentGrantSession, actor: MoraActor) {
  return grant.accessMode === "GRANT"
    && grant.issuedBy?.userId === actor.id
    && grant.analyst.externalId === `FINSER-USER:${actor.id}`;
}

export async function readAnalystEnrollmentGrant(request: NextRequest, actor: MoraActor) {
  const signed = verifyIphoneEnrollmentPortalSession(
    request.cookies.get(analystEnrollmentCookieName())?.value,
  );
  if (!signed || signed.accessMode !== "GRANT") return null;
  const grant = await validateIphoneEnrollmentPortalSession(signed);
  return grant && isAnalystEnrollmentGrant(grant, actor) ? grant : null;
}

export async function requireAnalystEnrollmentSession(request: NextRequest) {
  const actor = await requireAnalystEnrollmentActor(request);
  const grant = await readAnalystEnrollmentGrant(request, actor);
  if (!grant) {
    throw new CreditApprovalError("UNAUTHENTICATED", "Actualiza la página para verificar nuevamente tu acceso.", 401);
  }
  return { actor, grant, signedSession: grant.session };
}

export async function limitAnalystEnrollment(actor: MoraActor, action: "ACCESS" | "LOOKUP" | "APPROVE", maximum: number) {
  const result = await consumeIphoneEnrollmentRateLimit({
    subjectHash: hashIphoneEnrollmentRateLimitKey("session", `nominal-user:${actor.id}`),
    action,
    maximum,
  });
  if (result.allowed) return null;
  const response = enrollmentResponse({ ok: false, error: "Demasiados intentos. Intenta más tarde." }, 429);
  response.headers.set("Retry-After", String(result.retryAfterSeconds));
  return response;
}

export function analystEnrollmentErrorResponse(error: unknown) {
  if (error instanceof IphoneEnrollmentRequestBodyError) {
    const failure = iphoneEnrollmentBodyErrorResponse(error);
    return enrollmentResponse({ ok: false, error: failure.error }, failure.status);
  }
  if (error instanceof IphoneEnrollmentGrantError) {
    return enrollmentResponse({ ok: false, error: "La sesión ya no está activa. Actualiza la página." }, 401);
  }
  if (error instanceof IphoneEnrollmentApprovalError) {
    return enrollmentResponse({ ok: false, code: error.code, error: error.message }, 409);
  }
  if (error instanceof CreditApprovalError || error instanceof CreditDeviceReplacementError || error instanceof IphoneEnrollmentDiagnosticError) {
    return enrollmentResponse({ ok: false, code: error.code, error: error.message }, error.status);
  }
  console.error("ERROR EN ENROLAMIENTO NOMINAL:", error);
  return enrollmentResponse({ ok: false, error: "No se pudo consultar enrolamiento. Intenta nuevamente." }, 503);
}
