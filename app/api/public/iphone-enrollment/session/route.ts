import { NextRequest, NextResponse } from "next/server";
import {
  getIphoneEnrollmentPortalConfiguration,
  getIphoneEnrollmentPortalCookieName,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  verifyIphoneEnrollmentPortalSession,
} from "@/lib/iphone-enrollment";
import { validateIphoneEnrollmentPortalSession } from "@/lib/iphone-enrollment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

export async function GET(request: NextRequest) {
  try {
    const configuration = getIphoneEnrollmentPortalConfiguration();
    if (!configuration.enabled || !configuration.configured) {
      return response(
        {
          ok: false,
          enabled: configuration.enabled,
          configured: configuration.configured,
          authorized: false,
        },
        503
      );
    }
    const signedSession = verifyIphoneEnrollmentPortalSession(
      request.cookies.get(getIphoneEnrollmentPortalCookieName())?.value
    );
    const grantSession = signedSession
      ? await validateIphoneEnrollmentPortalSession(signedSession)
      : null;
    if (!grantSession) {
      return response(
        {
          ok: false,
          enabled: true,
          configured: true,
          authorized: false,
        },
        401
      );
    }
    return response(
      {
        ok: true,
        enabled: true,
        configured: true,
        authorized: true,
        analyst: grantSession.analyst,
        expiresAt: grantSession.expiresAt.toISOString(),
      },
      200
    );
  } catch (error) {
    console.error("ERROR VALIDANDO SESION DE ENROLAMIENTO IPHONE:", error);
    return response(
      {
        ok: false,
        enabled: true,
        configured: true,
        authorized: false,
      },
      500
    );
  }
}
