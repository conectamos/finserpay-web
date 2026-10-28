import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { hashPassword, verifyPassword } from "@/lib/password";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<number, { count: number; resetAt: number }>();

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) return false;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    // Railway terminates TLS before Node; Host retains the public authority.
    const publicHost = request.headers.get("host");
    return publicHost
      ? parsed.host.toLowerCase() === publicHost.toLowerCase()
      : parsed.origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function consumeAttempt(userId: number) {
  const now = Date.now();
  for (const [id, bucket] of attempts) {
    if (bucket.resetAt <= now) attempts.delete(id);
  }
  const bucket = attempts.get(userId) ?? { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
  if (bucket.count >= MAX_ATTEMPTS) return Math.ceil((bucket.resetAt - now) / 1000);
  // Bound memory while following the existing per-process rate-limit pattern.
  if (!attempts.has(userId) && attempts.size >= 10000) return 60;
  bucket.count += 1;
  attempts.set(userId, bucket);
  return 0;
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export async function PATCH(request: Request) {
  try {
    if (!sameOrigin(request)) return json({ error: "Origen de solicitud no permitido." }, 403);
    const user = await getSessionUser();
    if (!user) return json({ error: "No autenticado." }, 401);
    if (!isAdminRole(user.rolNombre)) return json({ error: "Solo los administradores pueden cambiar su contraseña de ingreso." }, 403);
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json({ error: "Se requiere una solicitud JSON." }, 415);
    }

    const body = await readBody(request);
    const currentPassword = body?.currentPassword;
    const newPassword = body?.newPassword;
    const confirmPassword = body?.confirmPassword;
    if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 1024 ||
        typeof newPassword !== "string" || typeof confirmPassword !== "string") {
      return json({ error: "Completa la contraseña actual y la nueva contraseña dos veces." }, 400);
    }
    if (newPassword.length < 8 || newPassword.length > 128 || !newPassword.trim()) {
      return json({ error: "La nueva contraseña debe tener entre 8 y 128 caracteres." }, 400);
    }
    if (newPassword !== confirmPassword) return json({ error: "La confirmación de la nueva contraseña no coincide." }, 400);
    if (newPassword === currentPassword) return json({ error: "La nueva contraseña debe ser diferente a la actual." }, 400);

    const retryAfter = consumeAttempt(user.id);
    if (retryAfter) return json({ error: "Demasiados intentos. Espera unos minutos antes de volver a intentarlo." }, 429, { "Retry-After": String(retryAfter) });

    // The target always comes from the authenticated session, never from the body.
    const account = await prisma.usuario.findUnique({
      where: { id: user.id },
      select: { id: true, activo: true, claveHash: true, rolId: true, rol: { select: { nombre: true } } },
    });
    if (!account?.activo || !isAdminRole(account.rol.nombre)) return json({ error: "La cuenta ya no tiene acceso administrativo." }, 403);
    if (!verifyPassword(currentPassword, account.claveHash)) return json({ error: "La contraseña actual no coincide." }, 400);

    // A concurrent password reset, account deactivation or role change must not be overwritten.
    const updated = await prisma.usuario.updateMany({
      where: { id: account.id, activo: true, rolId: account.rolId, claveHash: account.claveHash },
      data: { claveHash: hashPassword(newPassword) },
    });
    if (updated.count !== 1) return json({ error: "La cuenta cambió durante la solicitud. Vuelve a ingresar e inténtalo nuevamente." }, 409);

    attempts.delete(user.id);
    return json({ ok: true, mensaje: "Contraseña actualizada correctamente." });
  } catch {
    // Database exceptions may include query parameters. Never log credentials or hashes.
    console.error("[cambio-contrasena] No se pudo completar la actualización.");
    return json({ error: "No se pudo actualizar la contraseña. Inténtalo nuevamente." }, 500);
  }
}
