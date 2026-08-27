import { NextRequest, NextResponse } from "next/server";
import {
  getIphoneEnrollmentPortalConfiguration,
  getIphoneEnrollmentPortalCookieName,
  getIphoneEnrollmentPortalCookiePath,
  hashIphoneEnrollmentGrantToken,
  hashIphoneEnrollmentRateLimitKey,
  iphoneEnrollmentSharedAccessSecretMatches,
  iphoneEnrollmentBodyErrorResponse,
  IphoneEnrollmentRequestBodyError,
  IPHONE_ENROLLMENT_RESPONSE_HEADERS,
  isSameOriginIphoneEnrollmentRequest,
  issueIphoneEnrollmentSharedPortalSession,
  normalizeIphoneEnrollmentGrantSecret,
  readLimitedIphoneEnrollmentJson,
} from "@/lib/iphone-enrollment";
import {
  consumeIphoneEnrollmentRateLimit,
  exchangeIphoneEnrollmentAccessGrant,
  IphoneEnrollmentGrantError,
} from "@/lib/iphone-enrollment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACCESS_INSTANCE_WINDOW_MS = 15 * 60_000;
const ACCESS_TOKEN_MAXIMUM = 8;
const SHARED_ACCESS_TOKEN_MAXIMUM = 120;
const ACCESS_MAX_TRACKED_TOKENS = 2_048;
type AccessTokenBucket = {
  windowStartedAt: number;
  count: number;
};
type AccessGuardGlobal = typeof globalThis & {
  __finserIphoneEnrollmentAccessTokenGuards?: {
    buckets: Map<string, AccessTokenBucket>;
    lastPrunedAt: number;
  };
};

function consumeInstanceAccessGuard(
  tokenHash: string,
  maximum = ACCESS_TOKEN_MAXIMUM,
  now = Date.now()
) {
  const shared = globalThis as AccessGuardGlobal;
  const state =
    shared.__finserIphoneEnrollmentAccessTokenGuards ||
    {
      buckets: new Map<string, AccessTokenBucket>(),
      lastPrunedAt: now,
    };
  shared.__finserIphoneEnrollmentAccessTokenGuards = state;
  if (
    now - state.lastPrunedAt >= 60_000 ||
    state.buckets.size >= ACCESS_MAX_TRACKED_TOKENS
  ) {
    for (const [key, bucket] of state.buckets) {
      if (now - bucket.windowStartedAt >= ACCESS_INSTANCE_WINDOW_MS) {
        state.buckets.delete(key);
      }
    }
    while (state.buckets.size >= ACCESS_MAX_TRACKED_TOKENS) {
      const oldestKey = state.buckets.keys().next().value;
      if (!oldestKey) break;
      state.buckets.delete(oldestKey);
    }
    state.lastPrunedAt = now;
  }

  const current = state.buckets.get(tokenHash);
  if (!current || now - current.windowStartedAt >= ACCESS_INSTANCE_WINDOW_MS) {
    state.buckets.set(tokenHash, {
      windowStartedAt: now,
      count: 1,
    });
    return {
      allowed: true,
      retryAfterSeconds: ACCESS_INSTANCE_WINDOW_MS / 1000,
    };
  }
  current.count += 1;
  return {
    allowed: current.count <= maximum,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        (ACCESS_INSTANCE_WINDOW_MS - (now - current.windowStartedAt)) / 1000
      )
    ),
  };
}

function response(body: object, status: number) {
  return NextResponse.json(body, {
    status,
    headers: { ...IPHONE_ENROLLMENT_RESPONSE_HEADERS, Vary: "Cookie" },
  });
}

function authorizedResponse(session: {
  value: string;
  expiresAt: Date;
  payload: {
    analystName: string;
    analystExternalId: string;
  };
}) {
  const authorized = response(
    {
      ok: true,
      authorized: true,
      analyst: {
        name: session.payload.analystName,
        externalId: session.payload.analystExternalId,
      },
      expiresAt: session.expiresAt.toISOString(),
    },
    200
  );
  authorized.cookies.set({
    name: getIphoneEnrollmentPortalCookieName(),
    value: session.value,
    expires: session.expiresAt,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: getIphoneEnrollmentPortalCookiePath(),
  });
  return authorized;
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
    const body = await readLimitedIphoneEnrollmentJson<{ token?: unknown }>(
      request
    );
    if (iphoneEnrollmentSharedAccessSecretMatches(body.token)) {
      const sharedTokenHash = hashIphoneEnrollmentGrantToken(
        String(body.token || "").trim()
      );
      const instanceGuard = consumeInstanceAccessGuard(
        sharedTokenHash,
        SHARED_ACCESS_TOKEN_MAXIMUM
      );
      if (!instanceGuard.allowed) {
        const limited = response(
          { ok: false, error: "Demasiados intentos. Intenta mas tarde." },
          429
        );
        limited.headers.set(
          "Retry-After",
          String(instanceGuard.retryAfterSeconds)
        );
        return limited;
      }
      const durableGuard = await consumeIphoneEnrollmentRateLimit({
        subjectHash: hashIphoneEnrollmentRateLimitKey(
          "grant",
          sharedTokenHash
        ),
        action: "ACCESS",
        maximum: SHARED_ACCESS_TOKEN_MAXIMUM,
      });
      if (!durableGuard.allowed) {
        const limited = response(
          { ok: false, error: "Demasiados intentos. Intenta mas tarde." },
          429
        );
        limited.headers.set(
          "Retry-After",
          String(durableGuard.retryAfterSeconds)
        );
        return limited;
      }
      return authorizedResponse(issueIphoneEnrollmentSharedPortalSession());
    }

    const token = normalizeIphoneEnrollmentGrantSecret(body.token);
    if (!token) {
      return response(
        { ok: false, error: "El enlace no es valido, ya fue usado o vencio." },
        401
      );
    }

    // Defensa local por token, acotada en memoria y previa a la BD. Un token
    // aleatorio no puede agotar el cupo de los enlaces legítimos. Storage
    // añade un límite durable solo después de encontrar un grant real.
    // La firma HMAC ya rechazó tokens inventados antes de este punto. El
    // edge/WAF de Railway queda como defensa operativa adicional.
    const instanceGuard = consumeInstanceAccessGuard(
      hashIphoneEnrollmentGrantToken(token)
    );
    if (!instanceGuard.allowed) {
      const limited = response(
        { ok: false, error: "Demasiados intentos. Intenta mas tarde." },
        429
      );
      limited.headers.set(
        "Retry-After",
        String(instanceGuard.retryAfterSeconds)
      );
      return limited;
    }

    const exchange = await exchangeIphoneEnrollmentAccessGrant(token);
    return authorizedResponse(exchange.session);
  } catch (error) {
    if (error instanceof IphoneEnrollmentRequestBodyError) {
      const failure = iphoneEnrollmentBodyErrorResponse(error);
      return response({ ok: false, error: failure.error }, failure.status);
    }
    if (error instanceof IphoneEnrollmentGrantError) {
      if (error.code === "GRANT_RATE_LIMITED") {
        const limited = response(
          { ok: false, error: "Demasiados intentos. Intenta mas tarde." },
          429
        );
        limited.headers.set(
          "Retry-After",
          String(error.retryAfterSeconds || 15 * 60)
        );
        return limited;
      }
      return response(
        { ok: false, error: "El enlace no es valido, ya fue usado o vencio." },
        401
      );
    }
    console.error("ERROR HABILITANDO PORTAL DE ENROLAMIENTO IPHONE:", error);
    return response({ ok: false, error: "No se pudo habilitar el modulo" }, 500);
  }
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginIphoneEnrollmentRequest(request)) {
    return response({ ok: false, error: "Solicitud no autorizada" }, 403);
  }
  const closed = response({ ok: true, authorized: false }, 200);
  closed.cookies.set({
    name: getIphoneEnrollmentPortalCookieName(),
    value: "",
    expires: new Date(0),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: getIphoneEnrollmentPortalCookiePath(),
  });
  return closed;
}
