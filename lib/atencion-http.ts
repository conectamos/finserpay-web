import { AttentionError } from "./atencion-core";
import { AttentionDaptaError } from "./atencion-dapta";

export function attentionJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
  } });
}

export function attentionHttpError(error: unknown) {
  if (error instanceof AttentionError || error instanceof AttentionDaptaError) return attentionJson({ error: error.message,
    ...(error instanceof AttentionDaptaError && error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}) }, error.status);
  // Never send SQL, provider payloads, tokens or customer data to logs/the browser.
  return attentionJson({ error: "No fue posible completar la operación de atención. Intenta nuevamente." }, 500);
}

export function assertAttentionOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (!origin || (site && site !== "same-origin" && site !== "none")) {
    throw new AttentionError("Origen de solicitud no permitido.", 403);
  }
  try {
    const parsed = new URL(origin);
    const target = new URL(request.url);
    const host = request.headers.get("host") || target.host;
    const protocol = request.headers.get("x-forwarded-proto") || target.protocol.replace(":", "");
    if (origin !== parsed.origin || parsed.username || parsed.password ||
        parsed.host !== host || !["http", "https"].includes(protocol) ||
        (parsed.protocol !== `${protocol}:` && !(target.protocol === "http:" && parsed.protocol === "https:" && !request.headers.has("x-forwarded-proto")))) {
      throw new Error("origin");
    }
  } catch { throw new AttentionError("Origen de solicitud no permitido.", 403); }
}

export async function readAttentionJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AttentionError("Envía los datos en formato JSON.", 415);
  }
  const maxBytes = 16384;
  const reader = request.body?.getReader();
  if (!reader) throw new AttentionError("Solicitud vacía.", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AttentionError("La solicitud es demasiado grande.", 413);
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AttentionError("Los datos enviados no son válidos.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttentionError("Los datos enviados no son válidos.", 400);
  return value as Record<string, unknown>;
}

export function attentionString(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AttentionError(`${label} no válido.`, 400);
  return value.trim();
}
export function attentionId(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new AttentionError("Identificador no válido.", 400);
  return value;
}
export function attentionUuid(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new AttentionError("Identificador no válido.", 400);
  return value;
}
