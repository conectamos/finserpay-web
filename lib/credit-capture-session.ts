import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import {
  sanitizeImageDataUrl,
  sanitizeSearch,
  sanitizeText,
  sanitizeVideoDataUrl,
  toNumber,
} from "@/lib/credit-factory";

export const CREDIT_CAPTURE_SESSION_TTL_MINUTES = 20;

export function generateCreditCaptureToken() {
  return randomBytes(24).toString("hex");
}

export function buildCreditCaptureExpiry(minutes = CREDIT_CAPTURE_SESSION_TTL_MINUTES) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

export function detectLocalIpv4Address() {
  const interfaces = networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        return item.address;
      }
    }
  }

  return null;
}

export function resolveCaptureSessionOrigin(request: Request) {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || url.host;
  const protocol = forwardedProto || url.protocol.replace(":", "");
  const hostname = host.split(":")[0] || url.hostname;

  if (hostname === "localhost" || hostname === "127.0.0.1") {
    const localIp = detectLocalIpv4Address();

    if (localIp) {
      const port = host.includes(":") ? host.split(":").slice(1).join(":") : url.port;
      return `${protocol}://${localIp}${port ? `:${port}` : ""}`;
    }
  }

  return `${protocol}://${host}`;
}

export function resolveCaptureSessionState(session: {
  estado?: string | null;
  expiresAt?: Date | string | null;
  selfieDataUrl?: string | null;
  cedulaFrenteDataUrl?: string | null;
  cedulaRespaldoDataUrl?: string | null;
  videoAprobacionDataUrl?: string | null;
}) {
  const expiresAt = session.expiresAt ? new Date(session.expiresAt) : null;

  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return "EXPIRADA";
  }

  const completed =
    Boolean(session.selfieDataUrl) &&
    Boolean(session.cedulaFrenteDataUrl) &&
    Boolean(session.cedulaRespaldoDataUrl) &&
    Boolean(session.videoAprobacionDataUrl);

  if (completed) {
    return "COMPLETA";
  }

  return sanitizeText(session.estado || "ABIERTA").toUpperCase() || "ABIERTA";
}

export function serializeCaptureSession(
  session: {
    token: string;
    estado?: string | null;
    expiresAt: Date | string;
    clienteNombre?: string | null;
    clienteDocumento?: string | null;
    clienteTelefono?: string | null;
    selfieDataUrl?: string | null;
    selfieCapturedAt?: Date | string | null;
    selfieSource?: string | null;
    cedulaFrenteDataUrl?: string | null;
    cedulaFrenteCapturedAt?: Date | string | null;
    cedulaFrenteSource?: string | null;
    cedulaRespaldoDataUrl?: string | null;
    cedulaRespaldoCapturedAt?: Date | string | null;
    cedulaRespaldoSource?: string | null;
    videoAprobacionDataUrl?: string | null;
    videoAprobacionCapturedAt?: Date | string | null;
    videoAprobacionSource?: string | null;
    videoAprobacionDuration?: number | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
  },
  origin: string
) {
  const estado = resolveCaptureSessionState(session);
  const expiresAt = new Date(session.expiresAt);

  return {
    token: session.token,
    estado,
    expiresAt: expiresAt.toISOString(),
    expired: expiresAt.getTime() <= Date.now(),
    mobileUrl: `${origin}/qr-captura/${session.token}`,
    clienteNombre: session.clienteNombre || null,
    clienteDocumento: session.clienteDocumento || null,
    clienteTelefono: session.clienteTelefono || null,
    createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : null,
    updatedAt: session.updatedAt ? new Date(session.updatedAt).toISOString() : null,
    evidence: {
      selfieReady: Boolean(session.selfieDataUrl),
      cedulaFrenteReady: Boolean(session.cedulaFrenteDataUrl),
      cedulaRespaldoReady: Boolean(session.cedulaRespaldoDataUrl),
      videoReady: Boolean(session.videoAprobacionDataUrl),
      selfieDataUrl: session.selfieDataUrl || null,
      selfieCapturedAt: session.selfieCapturedAt
        ? new Date(session.selfieCapturedAt).toISOString()
        : null,
      selfieSource: session.selfieSource || null,
      cedulaFrenteDataUrl: session.cedulaFrenteDataUrl || null,
      cedulaFrenteCapturedAt: session.cedulaFrenteCapturedAt
        ? new Date(session.cedulaFrenteCapturedAt).toISOString()
        : null,
      cedulaFrenteSource: session.cedulaFrenteSource || null,
      cedulaRespaldoDataUrl: session.cedulaRespaldoDataUrl || null,
      cedulaRespaldoCapturedAt: session.cedulaRespaldoCapturedAt
        ? new Date(session.cedulaRespaldoCapturedAt).toISOString()
        : null,
      cedulaRespaldoSource: session.cedulaRespaldoSource || null,
      videoAprobacionDataUrl: session.videoAprobacionDataUrl || null,
      videoAprobacionCapturedAt: session.videoAprobacionCapturedAt
        ? new Date(session.videoAprobacionCapturedAt).toISOString()
        : null,
      videoAprobacionSource: session.videoAprobacionSource || null,
      videoAprobacionDuration: toNumber(session.videoAprobacionDuration || 0) || null,
    },
  };
}

export function sanitizeCaptureSessionPatch(body: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};

  if ("selfieDataUrl" in body) {
    patch.selfieDataUrl = sanitizeImageDataUrl(body.selfieDataUrl);
  }

  if ("selfieCapturedAt" in body) {
    patch.selfieCapturedAt = sanitizeText(body.selfieCapturedAt) || null;
  }

  if ("selfieSource" in body) {
    patch.selfieSource = sanitizeText(body.selfieSource).slice(0, 20) || null;
  }

  if ("cedulaFrenteDataUrl" in body) {
    patch.cedulaFrenteDataUrl = sanitizeImageDataUrl(body.cedulaFrenteDataUrl);
  }

  if ("cedulaFrenteCapturedAt" in body) {
    patch.cedulaFrenteCapturedAt = sanitizeText(body.cedulaFrenteCapturedAt) || null;
  }

  if ("cedulaFrenteSource" in body) {
    patch.cedulaFrenteSource = sanitizeText(body.cedulaFrenteSource).slice(0, 20) || null;
  }

  if ("cedulaRespaldoDataUrl" in body) {
    patch.cedulaRespaldoDataUrl = sanitizeImageDataUrl(body.cedulaRespaldoDataUrl);
  }

  if ("cedulaRespaldoCapturedAt" in body) {
    patch.cedulaRespaldoCapturedAt =
      sanitizeText(body.cedulaRespaldoCapturedAt) || null;
  }

  if ("cedulaRespaldoSource" in body) {
    patch.cedulaRespaldoSource =
      sanitizeText(body.cedulaRespaldoSource).slice(0, 20) || null;
  }

  if ("videoAprobacionDataUrl" in body) {
    patch.videoAprobacionDataUrl = sanitizeVideoDataUrl(body.videoAprobacionDataUrl);
  }

  if ("videoAprobacionCapturedAt" in body) {
    patch.videoAprobacionCapturedAt =
      sanitizeText(body.videoAprobacionCapturedAt) || null;
  }

  if ("videoAprobacionSource" in body) {
    patch.videoAprobacionSource =
      sanitizeText(body.videoAprobacionSource).slice(0, 20) || null;
  }

  if ("videoAprobacionDuration" in body) {
    const duration = Math.max(0, Math.round(toNumber(body.videoAprobacionDuration)));
    patch.videoAprobacionDuration = duration || null;
  }

  if ("clienteNombre" in body) {
    patch.clienteNombre = sanitizeSearch(body.clienteNombre).slice(0, 120) || null;
  }

  if ("clienteDocumento" in body) {
    patch.clienteDocumento = sanitizeSearch(body.clienteDocumento).slice(0, 40) || null;
  }

  if ("clienteTelefono" in body) {
    patch.clienteTelefono = sanitizeSearch(body.clienteTelefono).slice(0, 40) || null;
  }

  return patch;
}
