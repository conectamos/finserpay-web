import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeAllyWhatsApp } from "./ally-contact";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^v1\.([1-9]\d{0,10})\.([a-f0-9]{64})$/;
const TTL_SECONDS = 30 * 60;
const SCOPE = "FINSER_PAY_SETTLEMENT_DAPTA_CALLBACK";

function secret(env: NodeJS.ProcessEnv) {
  const value = env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET;
  if (!value || Buffer.byteLength(value, "utf8") < 32 || Buffer.byteLength(value, "utf8") > 4096 ||
      value !== value.trim() || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("Falta configurar ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET con al menos 32 bytes.");
  }
  return value;
}

function target(eventId: string, recipient: string) {
  if (!UUID.test(eventId)) throw new Error("Identificador de intento inválido.");
  const normalized = normalizeAllyWhatsApp(recipient);
  if (!normalized) throw new Error("Destinatario inválido.");
  return { eventId: eventId.toLowerCase(), recipient: normalized };
}

function seconds(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Fecha de callback inválida.");
  return Math.floor(now / 1000);
}

function signature(eventId: string, recipient: string, expiry: string, key: string) {
  return createHmac("sha256", key).update(`${SCOPE}\nv1\n${eventId}\n${recipient}\n${expiry}`, "utf8").digest();
}

/** Dapta receives only this short-lived attempt-scoped token, never the secret. */
export function createSettlementDaptaToken(eventId: string, recipient: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  const normalized = target(eventId, recipient);
  const expiry = String(seconds(now) + TTL_SECONDS);
  return `v1.${expiry}.${signature(normalized.eventId, normalized.recipient, expiry, secret(env)).toString("hex")}`;
}

export function verifySettlementDaptaToken(token: string, eventId: string, recipient: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  try {
    const match = TOKEN.exec(token);
    if (!match) return false;
    const expiry = Number(match[1]);
    const current = seconds(now);
    if (!Number.isSafeInteger(expiry) || expiry <= current || expiry > current + TTL_SECONDS) return false;
    const normalized = target(eventId, recipient);
    const expected = signature(normalized.eventId, normalized.recipient, match[1], secret(env));
    return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
  } catch { return false; }
}
