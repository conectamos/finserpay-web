import { createHash, timingSafeEqual } from "node:crypto";

export const MERCHANT_APPLICATION_RECIPIENT = "comercial@finserpay.com";
export const MERCHANT_APPLICATION_CONFIRMATION =
  "Recibimos tu postulación. Nuestro equipo comercial revisará tus datos y se pondrá en contacto contigo.";
export const MERCHANT_APPLICATION_PRIVACY_VERSION = "2026-09-27";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_EMAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MerchantApplicationData = {
  nombreComercio: string;
  nit: string;
  nombreContacto: string;
  telefono: string;
  email: string;
  ciudad: string;
  direccion: string;
  presenciaDigital: string;
  mensaje: string;
  aceptaPrivacidad: true;
  privacyVersion: string;
};

export class MerchantApplicationError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "MerchantApplicationError";
  }
}

export function validateMerchantApplication(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new MerchantApplicationError("INVALID_INPUT", 422, "Revisa los datos del formulario.");
  }
  const source = input as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const clean = (key: string, min: number, max: number) => {
    const value = typeof source[key] === "string" ? source[key].trim() : "";
    if (value.length < min || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
      fields[key] = `Ingresa entre ${min} y ${max} caracteres válidos.`;
    }
    return value;
  };
  const requestId = clean("requestId", 36, 36).toLowerCase();
  if (!UUID.test(requestId)) fields.requestId = "Recarga la página e inténtalo de nuevo.";
  const nombreComercio = clean("nombreComercio", 2, 160);
  const nit = clean("nit", 0, 25);
  if (nit && (!/^[0-9.\-\s]{5,25}$/.test(nit) || nit.replace(/\D/g, "").length < 5)) fields.nit = "Ingresa un NIT o documento válido.";
  const nombreContacto = clean("nombreContacto", 3, 120);
  const telefono = clean("telefono", 7, 24);
  if (!/^\+?[0-9 ()\-]{7,24}$/.test(telefono) || !/^\d{7,15}$/.test(telefono.replace(/\D/g, ""))) {
    fields.telefono = "Ingresa un teléfono de contacto válido.";
  }
  const email = clean("email", 5, 254).toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) fields.email = "Ingresa un correo válido.";
  const ciudad = clean("ciudad", 2, 100);
  const direccion = clean("direccion", 0, 200);
  const presenciaDigital = clean("presenciaDigital", 3, 500);
  if (!/^@[a-zA-Z0-9_.]{2,50}$/.test(presenciaDigital)) {
    try {
      const url = new URL(/^https?:\/\//i.test(presenciaDigital) ? presenciaDigital : `https://${presenciaDigital}`);
      if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".") || url.username || url.password || /\s/.test(presenciaDigital)) throw new Error();
    } catch {
      fields.presenciaDigital = "Ingresa tu página web, enlace de Instagram o Facebook, o @usuario.";
    }
  }
  // The optional message may contain line breaks; all other fields are single-line.
  const mensaje = typeof source.mensaje === "string" ? source.mensaje.trim() : "";
  if (mensaje.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(mensaje)) fields.mensaje = "Usa máximo 2000 caracteres válidos.";
  if (source.aceptaPrivacidad !== true) fields.aceptaPrivacidad = "Autoriza el tratamiento de tus datos para enviar la postulación.";
  if (source.website !== undefined && source.website !== "") fields.website = "No se pudo validar el formulario.";
  if (Object.keys(fields).length) throw new MerchantApplicationError("INVALID_INPUT", 422, "Revisa los campos señalados.", fields);
  const data: MerchantApplicationData = {
    nombreComercio, nit, nombreContacto, telefono, email, ciudad, direccion,
    presenciaDigital, mensaje, aceptaPrivacidad: true, privacyVersion: MERCHANT_APPLICATION_PRIVACY_VERSION,
  };
  return { requestId, data, contentHash: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
}

export type MerchantMail = { from: string; to: string[]; reply_to: string; subject: string; text: string };
export type MerchantApplicationRecord = {
  id: string;
  data: MerchantApplicationData;
  createdAt: Date | string;
  notificationStatus: string;
};
export type MerchantMailClaim = MerchantApplicationRecord & {
  leaseToken: string;
  mailPayload: MerchantMail;
  attempts: number;
  hadAmbiguousAttempt: boolean;
};
export type MerchantApplicationStore = {
  receive(input: ReturnType<typeof validateMerchantApplication>): Promise<{ record: MerchantApplicationRecord; created: boolean }>;
  claim(id: string, from: string, force?: boolean): Promise<MerchantMailClaim | null>;
  accepted(claim: MerchantMailClaim, providerId: string): Promise<void>;
  failed(claim: MerchantMailClaim, code: string, ambiguous: boolean): Promise<void>;
  configurationPending(id: string): Promise<void>;
  pending(limit: number): Promise<string[]>;
};

export function getMerchantMailConfig(env: NodeJS.ProcessEnv = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.MERCHANT_APPLICATION_FROM?.trim();
  if (!apiKey || !from || /[\r\n]/.test(from)) return null;
  const address = (from.match(/<([^<>]+)>$/)?.[1] || from).trim();
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@finserpay\.com$/i.test(address)) return null;
  return { apiKey, from };
}

export function buildMerchantMail(record: MerchantApplicationRecord, from: string): MerchantMail {
  const data = record.data;
  return {
    from,
    to: [MERCHANT_APPLICATION_RECIPIENT],
    reply_to: data.email,
    subject: `Nueva postulación de comercio FINSER PAY · ${record.id}`,
    text: [
      "Nueva postulación de comercio aliado FINSER PAY", "",
      `Solicitud: ${record.id}`, `Fecha de recepción: ${new Date(record.createdAt).toISOString()}`,
      `Nombre del comercio: ${data.nombreComercio}`, `NIT / documento: ${data.nit || "No indicó."}`,
      `Persona de contacto: ${data.nombreContacto}`, `Teléfono / WhatsApp: ${data.telefono}`,
      `Correo: ${data.email}`, `Ciudad: ${data.ciudad}`, `Dirección: ${data.direccion || "No indicó."}`,
      `Página web, Instagram o Facebook: ${data.presenciaDigital}`,
      `Mensaje: ${data.mensaje || "No indicó un mensaje adicional."}`,
      `Autorizó tratamiento de datos: Sí`, `Versión de autorización: ${data.privacyVersion}`,
    ].join("\n"),
  };
}

export async function notifyMerchantApplication(
  store: MerchantApplicationStore,
  id: string,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; force?: boolean } = {},
) {
  const config = getMerchantMailConfig(options.env);
  if (!config) {
    await store.configurationPending(id);
    return "PENDING";
  }
  const claim = await store.claim(id, config.from, options.force);
  if (!claim) return "SKIPPED";
  let response: Response;
  try {
    response = await (options.fetch || fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `merchant-application/${claim.id}`,
      },
      // JSONB can reorder object keys: serialize in a fixed order on every attempt.
      body: JSON.stringify({
        from: claim.mailPayload.from, to: claim.mailPayload.to,
        reply_to: claim.mailPayload.reply_to, subject: claim.mailPayload.subject,
        text: claim.mailPayload.text,
      }),
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    await store.failed(claim, "PROVIDER_NETWORK_ERROR", true);
    return "PENDING";
  }
  if (!response.ok) {
    // Never persist provider error bodies: they can contain addresses or credentials.
    const ambiguous = response.status >= 500 || response.status === 408 || response.status === 409;
    await store.failed(claim, `PROVIDER_HTTP_${response.status}`, ambiguous);
    return "PENDING";
  }
  const payload = await response.json().catch(() => null) as { id?: unknown } | null;
  if (!payload || typeof payload.id !== "string" || !PROVIDER_EMAIL_UUID.test(payload.id)) {
    await store.failed(claim, "PROVIDER_INVALID_RESPONSE", true);
    return "PENDING";
  }
  // A crash here leaves a leased record recoverable with the SAME provider key and payload.
  await store.accepted(claim, payload.id);
  return "ACCEPTED";
}

export async function receiveMerchantApplication(
  input: unknown,
  store: MerchantApplicationStore,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
) {
  const validated = validateMerchantApplication(input);
  const { record, created } = await store.receive(validated);
  // A notification failure must never turn a durably saved application into a form error.
  await notifyMerchantApplication(store, record.id, options).catch(() => undefined);
  return { created, solicitudId: record.id, message: MERCHANT_APPLICATION_CONFIRMATION };
}

export function merchantRetryAuthorized(request: Request, env: NodeJS.ProcessEnv = process.env) {
  const expected = String(env.MERCHANT_APPLICATION_RETRY_TOKEN || env.CRON_SECRET || "").trim();
  const received = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return expectedBytes.length >= 32 && receivedBytes.length === expectedBytes.length &&
    timingSafeEqual(receivedBytes, expectedBytes);
}

async function readBoundedJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new MerchantApplicationError("INVALID_CONTENT_TYPE", 415, "Envía el formulario en formato JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new MerchantApplicationError("INVALID_JSON", 400, "El formulario está vacío.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 16_384) {
      await reader.cancel();
      throw new MerchantApplicationError("PAYLOAD_TOO_LARGE", 413, "El formulario excede el tamaño permitido.");
    }
    chunks.push(chunk.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MerchantApplicationError("INVALID_JSON", 400, "No pudimos leer el formulario."); }
}

export function createMerchantApplicationHandler(
  store: MerchantApplicationStore,
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
) {
  return async (request: Request) => {
    const headers = { "Cache-Control": "no-store" };
    try {
      const origin = request.headers.get("origin");
      const requestUrl = new URL(request.url);
      const allowed = new Set([requestUrl.origin, "https://finserpay.com", "https://www.finserpay.com"]);
      // Next dev may normalize 127.0.0.1 to localhost in Request.url. Treat only
      // loopback aliases with the same protocol and port as equivalent in dev.
      if ((options.env || process.env).NODE_ENV === "development" && origin) {
        const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
        try {
          const originUrl = new URL(origin);
          if (loopbackHosts.has(requestUrl.hostname) && loopbackHosts.has(originUrl.hostname) &&
            originUrl.protocol === requestUrl.protocol && originUrl.port === requestUrl.port) {
            allowed.add(originUrl.origin);
          }
        } catch { /* The normal origin check below rejects malformed values. */ }
      }
      if (origin && !allowed.has(origin)) throw new MerchantApplicationError("INVALID_ORIGIN", 403, "Envía tu postulación desde FINSER PAY.");
      const result = await receiveMerchantApplication(await readBoundedJson(request), store, options);
      return Response.json({ ok: true, solicitudId: result.solicitudId, message: result.message }, { status: result.created ? 201 : 200, headers });
    } catch (error) {
      if (error instanceof MerchantApplicationError) {
        return Response.json({ ok: false, code: error.code, error: error.message, fields: error.fields }, {
          status: error.status, headers: { ...headers, ...(error.status === 429 ? { "Retry-After": "3600" } : {}) },
        });
      }
      console.error("[merchant-applications] No se pudo persistir la postulación.");
      return Response.json({ ok: false, error: "No pudimos guardar tu postulación. Inténtalo de nuevo en unos minutos." }, { status: 503, headers });
    }
  };
}
