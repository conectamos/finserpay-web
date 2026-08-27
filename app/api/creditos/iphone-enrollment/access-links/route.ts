import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  getIphoneEnrollmentPortalConfiguration,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
} from "@/lib/iphone-enrollment";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

async function requireCentralAdmin() {
  const user = await getSessionUser();
  if (!user) {
    return {
      ok: false as const,
      response: response({ ok: false, error: "No autenticado" }, 401),
    };
  }
  if (
    !isAdminRole(user.rolNombre) ||
    !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  ) {
    return {
      ok: false as const,
      response: response(
        {
          ok: false,
          error: "Solo el administrador central FINSER PAY puede consultar el acceso.",
        },
        403
      ),
    };
  }
  return { ok: true as const };
}

function accessOrigin(request: NextRequest) {
  const configured = String(
    process.env.IPHONE_ENROLLMENT_PUBLIC_ORIGIN ||
      process.env.NEXT_PUBLIC_APP_URL ||
      ""
  ).trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Usa el origen canónico de la solicitud si la variable opcional es inválida.
    }
  }
  return request.nextUrl.origin;
}

export async function GET(request: NextRequest) {
  const access = await requireCentralAdmin();
  if (!access.ok) return access.response;
  const configuration = getIphoneEnrollmentPortalConfiguration();
  if (!configuration.enabled || !configuration.configured) {
    return response(
      {
        ok: false,
        code: "IPHONE_ENROLLMENT_NOT_CONFIGURED",
        error:
          "El módulo debe estar habilitado y tener configurado el acceso compartido.",
      },
      503
    );
  }
  return response({
    ok: true,
    reusable: true,
    accessUrl: `${accessOrigin(request)}/enrolamiento-iphone#acceso=${encodeURIComponent(
      configuration.sharedAccessSecret
    )}`,
  });
}
