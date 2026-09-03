import {
  newPadlockCorrelationId,
  padlockAdminJson,
  readPadlockAdminJson,
  requirePadlockCentralAdmin,
  requirePadlockSameOrigin,
} from "@/lib/padlock/admin-http";
import { consumePadlockAdminRateLimit } from "@/lib/padlock/admin-rate-limit";
import {
  publicPadlockAdminError,
  verifyAndBindPadlockIphone,
} from "@/lib/padlock/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const access = await requirePadlockCentralAdmin();
  if (!access.ok) return access.response;
  const originError = requirePadlockSameOrigin(request);
  if (originError) return originError;

  const correlationId = newPadlockCorrelationId();
  const rateLimit = consumePadlockAdminRateLimit({
    actorUserId: access.user.id,
    mutation: "binding",
  });
  if (!rateLimit.allowed) {
    return padlockAdminJson(
      {
        ok: false,
        error: "Demasiadas verificaciones. Espere antes de intentar nuevamente.",
        correlationId,
      },
      429,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  }

  const parsed = await readPadlockAdminJson(request);
  if (!parsed.ok) return parsed.response;
  const creditId = Number(parsed.body.creditId);
  const imei = String(parsed.body.imei || "").trim();

  if (!Number.isInteger(creditId) || creditId <= 0) {
    return padlockAdminJson(
      { ok: false, error: "El crédito no es válido." },
      400
    );
  }
  if (!/^\d{15}$/.test(imei)) {
    return padlockAdminJson(
      { ok: false, error: "El IMEI debe contener exactamente 15 dígitos." },
      400
    );
  }

  try {
    const binding = await verifyAndBindPadlockIphone({
      creditId,
      imei,
      actorUserId: access.user.id,
      correlationId,
    });
    return padlockAdminJson(
      {
        ok: true,
        message: "iPhone verificado y vinculado correctamente.",
        binding,
        correlationId,
      },
      201,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  } catch (error) {
    const safe = publicPadlockAdminError(error);
    console.error("PADLOCK_ADMIN_BINDING_ERROR", {
      correlationId,
      code: safe.code,
    });
    return padlockAdminJson(
      { ok: false, error: safe.message, code: safe.code, correlationId },
      safe.status,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  }
}
