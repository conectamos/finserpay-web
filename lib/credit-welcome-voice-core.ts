import { createHmac, timingSafeEqual } from "node:crypto";
import { matchesRegisteredWelcomeVoiceName } from "./credit-welcome-voice-name";

const TOKEN_PURPOSE = "credit-welcome-voice";
const TOKEN_MAX_SECONDS = 24 * 60 * 60;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export type WelcomeVoiceToken = {
  eventId: string;
  creditId: number;
  issuedAt: number;
  expiresAt: number;
};

/** The identity flow keeps this credential in its HTTP node, never in model arguments. */
export function verifyWelcomeVoiceIdentityFlowAuthorization(value: unknown, options: { secret?: string } = {}): boolean {
  const secret = options.secret ?? process.env.DAPTA_WELCOME_VOICE_IDENTITY_FLOW_TOKEN;
  if (typeof secret !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(secret) || typeof value !== "string") return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value);
  if (!match) return false;
  const supplied = Buffer.from(match[1]), expected = Buffer.from(secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function getTokenSecret(secret?: string) {
  const configured = secret ?? process.env.DAPTA_WELCOME_VOICE_TOKEN_SECRET;
  return typeof configured === "string" && configured.length >= 32 ? configured : null;
}

export function createWelcomeVoiceToken(
  identity: { eventId: string; creditId: number },
  options: { secret?: string; now?: Date; ttlSeconds?: number } = {},
) {
  const secret = getTokenSecret(options.secret);
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const ttlSeconds = options.ttlSeconds ?? TOKEN_MAX_SECONDS;
  if (!secret || !UUID_PATTERN.test(identity.eventId) || !Number.isSafeInteger(identity.creditId)
    || identity.creditId < 1 || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1 || ttlSeconds > TOKEN_MAX_SECONDS) {
    throw new Error("Invalid welcome voice token configuration");
  }
  const payload = Buffer.from(JSON.stringify({
    v: 1, purpose: TOKEN_PURPOSE, ...identity, issuedAt, expiresAt: issuedAt + ttlSeconds,
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyWelcomeVoiceToken(
  value: unknown,
  options: { secret?: string; now?: Date } = {},
): WelcomeVoiceToken | null {
  const secret = getTokenSecret(options.secret);
  if (!secret || typeof value !== "string" || value.length > 1000) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const received = Buffer.from(parts[1], "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (payload.v !== 1 || payload.purpose !== TOKEN_PURPOSE || !UUID_PATTERN.test(payload.eventId)
      || !Number.isSafeInteger(payload.creditId) || payload.creditId < 1
      || !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
      || !Number.isSafeInteger(now) || payload.issuedAt > now + 30 || payload.expiresAt <= now
      || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > TOKEN_MAX_SECONDS) return null;
    return { eventId: payload.eventId, creditId: payload.creditId, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

export function normalizeWelcomeVoiceDocument(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  // Formatting separators are harmless; letters/unknown digits are never guessed.
  const normalized = value.trim().replace(/[\s.,-]/g, "");
  return /^\d{5,15}$/.test(normalized) ? normalized : null;
}

export function normalizeWelcomeVoiceName(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 240) return null;
  const normalized = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO").replace(/[’']/g, "").replace(/[.,-\s]+/g, " ").trim();
  return /^[a-z]+(?: [a-z]+)*$/.test(normalized) ? normalized : null;
}

export function matchWelcomeVoiceIdentity(
  expected: { name: unknown; document: unknown },
  provided: { name: unknown; document: unknown },
) {
  const expectedName = normalizeWelcomeVoiceName(expected.name);
  const providedName = normalizeWelcomeVoiceName(provided.name);
  const expectedDocument = normalizeWelcomeVoiceDocument(expected.document);
  const providedDocument = normalizeWelcomeVoiceDocument(provided.document);
  return !!expectedName && !!providedName && !!expectedDocument && !!providedDocument
    && matchesRegisteredWelcomeVoiceName(providedName, expectedName) && expectedDocument === providedDocument;
}

export function safeDaptaWelcomeVoiceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    // Private call details require the operator's existing Dapta workspace session.
    if (url.protocol !== "https:" || url.hostname !== "app.dapta.ai"
      || url.username || url.password || (url.port && url.port !== "443")) return null;
    return url.href;
  } catch {
    return null;
  }
}
