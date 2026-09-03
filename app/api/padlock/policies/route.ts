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
  savePadlockPolicy,
} from "@/lib/padlock/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function integerBetween(value: unknown, minimum: number, maximum: number) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : null;
}

export async function PUT(request: Request) {
  const access = await requirePadlockCentralAdmin();
  if (!access.ok) return access.response;
  const originError = requirePadlockSameOrigin(request);
  if (originError) return originError;

  const correlationId = newPadlockCorrelationId();
  const rateLimit = consumePadlockAdminRateLimit({
    actorUserId: access.user.id,
    mutation: "policy",
  });
  if (!rateLimit.allowed) {
    return padlockAdminJson(
      {
        ok: false,
        error: "Demasiados cambios de regla. Espere antes de intentar nuevamente.",
        correlationId,
      },
      429,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  }

  const parsed = await readPadlockAdminJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const scopeType = body.scopeType;
  const allyId =
    scopeType === "ALLY" ? integerBetween(body.allyId, 1, 2_147_483_647) : null;
  const graceDays = integerBetween(body.graceDays, 0, 365);
  const lockAfterDaysPastDue = integerBetween(
    body.lockAfterDaysPastDue,
    0,
    365
  );
  const unlockCondition = body.unlockCondition;
  const reason = String(body.reason || "").trim();

  if (scopeType !== "GLOBAL" && scopeType !== "ALLY") {
    return padlockAdminJson(
      { ok: false, error: "El alcance de la regla no es válido." },
      400
    );
  }
  if (scopeType === "ALLY" && !allyId) {
    return padlockAdminJson(
      { ok: false, error: "Seleccione un aliado válido." },
      400
    );
  }
  if (body.productCode !== undefined && body.productCode !== "IPHONE") {
    return padlockAdminJson(
      { ok: false, error: "Padlock solo admite reglas del producto iPhone." },
      400
    );
  }
  if (typeof body.enabled !== "boolean") {
    return padlockAdminJson(
      { ok: false, error: "Indique si la regla está activa o inactiva." },
      400
    );
  }
  if (graceDays === null || lockAfterDaysPastDue === null) {
    return padlockAdminJson(
      { ok: false, error: "Los días deben ser enteros entre 0 y 365." },
      400
    );
  }
  if (unlockCondition !== "CURRENT" && unlockCondition !== "SETTLED") {
    return padlockAdminJson(
      { ok: false, error: "La condición de desbloqueo no es válida." },
      400
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    return padlockAdminJson(
      { ok: false, error: "El motivo debe tener entre 10 y 500 caracteres." },
      400
    );
  }

  try {
    const result = await savePadlockPolicy({
      scopeType,
      allyId,
      enabled: body.enabled,
      graceDays,
      lockAfterDaysPastDue,
      unlockCondition,
      reason,
      actorUserId: access.user.id,
      correlationId,
    });
    return padlockAdminJson(
      {
        ok: true,
        message: `Regla iPhone guardada como versión ${result.version}.`,
        policy: result,
        correlationId,
      },
      200,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  } catch (error) {
    const safe = publicPadlockAdminError(error);
    console.error("PADLOCK_ADMIN_POLICY_ERROR", {
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
