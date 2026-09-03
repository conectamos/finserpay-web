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
  queueManualPadlockCommand,
} from "@/lib/padlock/admin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const access = await requirePadlockCentralAdmin();
  if (!access.ok) return access.response;
  const originError = requirePadlockSameOrigin(request);
  if (originError) return originError;

  const correlationId = newPadlockCorrelationId();
  const rateLimit = consumePadlockAdminRateLimit({
    actorUserId: access.user.id,
    mutation: "command",
  });
  if (!rateLimit.allowed) {
    return padlockAdminJson(
      {
        ok: false,
        error: "Demasiados comandos manuales. Espere antes de intentar nuevamente.",
        correlationId,
      },
      429,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  }

  const parsed = await readPadlockAdminJson(request);
  if (!parsed.ok) return parsed.response;
  const bindingId = String(parsed.body.bindingId || "").trim();
  const action = parsed.body.action;
  const reason = String(parsed.body.reason || "").trim();

  if (!UUID_PATTERN.test(bindingId)) {
    return padlockAdminJson(
      { ok: false, error: "El dispositivo vinculado no es válido." },
      400
    );
  }
  if (action !== "LOCK" && action !== "UNLOCK") {
    return padlockAdminJson(
      { ok: false, error: "La acción manual no es válida." },
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
    const command = await queueManualPadlockCommand({
      bindingId,
      action,
      reason,
      actorUserId: access.user.id,
      correlationId,
    });
    return padlockAdminJson(
      {
        ok: true,
        message:
          command.outcome === "UNCHANGED"
            ? "El dispositivo ya tenía ese estado deseado; no se duplicó el comando."
            : "Comando manual validado y encolado.",
        command,
        correlationId,
      },
      command.outcome === "ENQUEUED" ? 201 : 200,
      { ...rateLimit.headers, "X-Correlation-Id": correlationId }
    );
  } catch (error) {
    const safe = publicPadlockAdminError(error);
    console.error("PADLOCK_ADMIN_COMMAND_ERROR", {
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
