import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  FirmaSeguroApiError,
  firmaSeguroGetBalanceByNit,
  firmaSeguroSignIn,
  getFirmaSeguroConfig,
  isFirmaSeguroConfigured,
} from "@/lib/firmaseguro";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

function getHostName(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  }
}

function sanitizePayload(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizePayload(item));
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  const sanitized: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (/base64|token|password|authorization|document/i.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }

    sanitized[key] = sanitizePayload(item);
  }

  return sanitized;
}

function getTokenShape(token: string) {
  if (!token) {
    return "missing";
  }

  return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    ? "jwt"
    : "opaque";
}

function getDiagnosticBase() {
  const config = getFirmaSeguroConfig();

  return {
    configured: isFirmaSeguroConfigured(),
    baseHost: getHostName(config.baseUrl),
    authMode: config.authMode,
    accessTokenConfigured: Boolean(config.accessToken),
    emailConfigured: Boolean(config.email),
    passwordConfigured: Boolean(config.password),
    nitConfigured: Boolean(config.nit),
    nit: config.nit,
    useCompanyEndpoint: config.useCompanyEndpoint,
    callbackConfigured: Boolean(config.callbackUrl),
  };
}

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user || !isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { ok: false, error: "No autorizado" },
        { status: 401 }
      );
    }

    const diagnostic = getDiagnosticBase();
    if (!diagnostic.configured) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "FirmaSeguro no esta configurado. Falta token o usuario y clave.",
          ...diagnostic,
          authorized: false,
        },
        { status: 503 }
      );
    }

    const auth = await firmaSeguroSignIn();
    const authPayload =
      auth.payload && typeof auth.payload === "object"
        ? (auth.payload as JsonObject)
        : {};

    if (!diagnostic.nit) {
      return NextResponse.json({
        ok: true,
        ...diagnostic,
        authorized: true,
        authSource: String(authPayload.source || "desconocido"),
        tokenShape: getTokenShape(auth.token),
        balanceChecked: false,
        balanceMessage: "FIRMASEGURO_NIT no esta configurado.",
      });
    }

    const balance = await firmaSeguroGetBalanceByNit(auth.token, diagnostic.nit);

    return NextResponse.json({
      ok: true,
      ...diagnostic,
      authorized: true,
      authSource: String(authPayload.source || "desconocido"),
      tokenShape: getTokenShape(auth.token),
      balanceChecked: true,
      balanceOk: true,
      balance: sanitizePayload(balance),
    });
  } catch (error) {
    const diagnostic = getDiagnosticBase();

    if (error instanceof FirmaSeguroApiError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          providerStatus: error.status,
          ...diagnostic,
          authorized: false,
          balanceChecked: Boolean(diagnostic.nit),
          detail: sanitizePayload(error.detail),
        },
        { status: error.status || 500 }
      );
    }

    const message =
      error instanceof Error ? error.message : "No se pudo diagnosticar FirmaSeguro";

    return NextResponse.json(
      {
        ok: false,
        error: message,
        ...diagnostic,
        authorized: false,
      },
      { status: 500 }
    );
  }
}
