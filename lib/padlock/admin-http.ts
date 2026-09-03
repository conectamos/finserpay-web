import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";

export const PADLOCK_ADMIN_RESPONSE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
} as const;

const PADLOCK_ADMIN_BODY_MAX_BYTES = 16_384;

export function padlockAdminJson(
  body: Record<string, unknown>,
  status = 200,
  headers: Record<string, string> = {}
) {
  return NextResponse.json(body, {
    status,
    headers: {
      ...PADLOCK_ADMIN_RESPONSE_HEADERS,
      ...headers,
    },
  });
}

export async function requirePadlockCentralAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: padlockAdminJson({ ok: false, error: "No autenticado" }, 401),
    };
  }

  if (
    !isAdminRole(user.rolNombre) ||
    !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  ) {
    return {
      ok: false as const,
      response: padlockAdminJson(
        { ok: false, error: "Acceso no autorizado" },
        403
      ),
    };
  }

  return { ok: true as const, user };
}

export function requirePadlockSameOrigin(request: Request) {
  const origin = request.headers.get("origin");

  // Non-browser callers still require a valid central-admin session. Browser
  // mutations carry Origin and must match the host serving this application.
  if (!origin) return null;

  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();

  try {
    const requestUrl = new URL(request.url);
    const requestHost = forwardedHost || requestUrl.host;
    const requestProtocol = forwardedProtocol
      ? `${forwardedProtocol.replace(/:$/, "")}:`
      : requestUrl.protocol;
    const originUrl = new URL(origin);
    if (
      requestHost &&
      originUrl.protocol.toLowerCase() === requestProtocol.toLowerCase() &&
      originUrl.host.toLowerCase() === requestHost.toLowerCase()
    ) {
      return null;
    }
  } catch {
    // An invalid Origin is rejected below.
  }

  return padlockAdminJson(
    { ok: false, error: "Origen de solicitud no autorizado" },
    403
  );
}

export function newPadlockCorrelationId() {
  return randomUUID();
}

export async function readPadlockAdminJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > PADLOCK_ADMIN_BODY_MAX_BYTES
  ) {
    return {
      ok: false as const,
      response: padlockAdminJson(
        { ok: false, error: "La solicitud supera el tamaño permitido" },
        413
      ),
    };
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > PADLOCK_ADMIN_BODY_MAX_BYTES) {
    return {
      ok: false as const,
      response: padlockAdminJson(
        { ok: false, error: "La solicitud supera el tamaño permitido" },
        413
      ),
    };
  }

  try {
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("PADLOCK_BODY_NOT_OBJECT");
    }
    return { ok: true as const, body: body as Record<string, unknown> };
  } catch {
    return {
      ok: false as const,
      response: padlockAdminJson(
        { ok: false, error: "El cuerpo JSON no es válido" },
        400
      ),
    };
  }
}
