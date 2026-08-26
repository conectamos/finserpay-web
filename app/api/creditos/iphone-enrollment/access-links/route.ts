import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import {
  getIphoneEnrollmentPortalConfiguration,
  iphoneEnrollmentBodyErrorResponse,
  IphoneEnrollmentRequestBodyError,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  isSameOriginIphoneEnrollmentRequest,
  normalizeIphoneEnrollmentAnalystExternalId,
  normalizeIphoneEnrollmentAnalystName,
  readLimitedIphoneEnrollmentJson,
} from "@/lib/iphone-enrollment";
import {
  createIphoneEnrollmentAccessGrant,
  listIphoneEnrollmentAccessGrants,
  revokeIphoneEnrollmentAccessGrant,
} from "@/lib/iphone-enrollment-storage";
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
          error: "Solo el administrador central FINSER PAY puede gestionar enlaces.",
        },
        403
      ),
    };
  }
  return { ok: true as const, user };
}

function accessOrigin(request: NextRequest) {
  const configured = String(process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // Usa el origen canónico de la solicitud si la variable opcional es inválida.
    }
  }
  return request.nextUrl.origin;
}

export async function GET() {
  const access = await requireCentralAdmin();
  if (!access.ok) return access.response;
  try {
    return response({
      ok: true,
      items: await listIphoneEnrollmentAccessGrants(),
    });
  } catch (error) {
    console.error("ERROR LISTANDO GRANTS DE ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudieron cargar los enlaces" }, 500);
  }
}

export async function POST(request: NextRequest) {
  const access = await requireCentralAdmin();
  if (!access.ok) return access.response;
  if (!isSameOriginIphoneEnrollmentRequest(request)) {
    return response({ ok: false, error: "Solicitud no autorizada" }, 403);
  }
  const configuration = getIphoneEnrollmentPortalConfiguration();
  if (!configuration.enabled || !configuration.configured) {
    return response(
      {
        ok: false,
        code: "IPHONE_ENROLLMENT_NOT_CONFIGURED",
        error:
          "El modulo debe estar habilitado y tener secretos validos antes de emitir enlaces.",
      },
      503
    );
  }
  try {
    const body = await readLimitedIphoneEnrollmentJson<{
      analystName?: unknown;
      analystExternalId?: unknown;
      expiresInMinutes?: unknown;
    }>(request);
    const analystName = normalizeIphoneEnrollmentAnalystName(body.analystName);
    const analystExternalId = normalizeIphoneEnrollmentAnalystExternalId(
      body.analystExternalId
    );
    const expiresInMinutes = Number(body.expiresInMinutes);
    if (
      !analystName ||
      !analystExternalId ||
      !Number.isInteger(expiresInMinutes) ||
      expiresInMinutes < 5 ||
      expiresInMinutes > 8 * 60
    ) {
      return response(
        {
          ok: false,
          error:
            "Indica nombre, identificador del analista y una vigencia entre 5 y 480 minutos.",
        },
        400
      );
    }

    const created = await createIphoneEnrollmentAccessGrant({
      analystName,
      analystExternalId,
      expiresInMinutes,
      issuedByUserId: access.user.id,
      issuedByName: access.user.nombre,
    });
    return response(
      {
        ok: true,
        item: created.item,
        accessUrl: `${accessOrigin(request)}/enrolamiento-iphone#acceso=${encodeURIComponent(created.token)}`,
      },
      201
    );
  } catch (error) {
    if (error instanceof IphoneEnrollmentRequestBodyError) {
      const failure = iphoneEnrollmentBodyErrorResponse(error);
      return response({ ok: false, error: failure.error }, failure.status);
    }
    console.error("ERROR CREANDO GRANT DE ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudo crear el enlace" }, 500);
  }
}

async function revoke(request: NextRequest) {
  const access = await requireCentralAdmin();
  if (!access.ok) return access.response;
  if (!isSameOriginIphoneEnrollmentRequest(request)) {
    return response({ ok: false, error: "Solicitud no autorizada" }, 403);
  }
  try {
    const body = await readLimitedIphoneEnrollmentJson<{ id?: unknown }>(
      request
    );
    const id = String(body.id || "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return response({ ok: false, error: "Enlace invalido" }, 400);
    }
    const item = await revokeIphoneEnrollmentAccessGrant({
      id,
      revokedByUserId: access.user.id,
      revokedByName: access.user.nombre,
    });
    if (!item) {
      return response({ ok: false, error: "Enlace no encontrado" }, 404);
    }
    return response({ ok: true, item });
  } catch (error) {
    if (error instanceof IphoneEnrollmentRequestBodyError) {
      const failure = iphoneEnrollmentBodyErrorResponse(error);
      return response({ ok: false, error: failure.error }, failure.status);
    }
    console.error("ERROR REVOCANDO GRANT DE ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudo revocar el enlace" }, 500);
  }
}

export async function DELETE(request: NextRequest) {
  return revoke(request);
}

export async function PATCH(request: NextRequest) {
  return revoke(request);
}
