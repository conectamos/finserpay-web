import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryDb } from "./ally-settlement-delivery-store";

const MEDIA_ENDPOINT = "https://finserpay.com/api/integraciones/liquidaciones/documento";
const MEDIA_TTL_SECONDS = 30 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,149}\.pdf$/i;

function mediaSecret(env: NodeJS.ProcessEnv) {
  const secret = env.ALLY_SETTLEMENT_MEDIA_SECRET;
  if (!secret || Buffer.byteLength(secret, "utf8") < 32 || Buffer.byteLength(secret, "utf8") > 4096 ||
      secret !== secret.trim() || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("Falta configurar ALLY_SETTLEMENT_MEDIA_SECRET con al menos 32 bytes.");
  }
  return secret;
}

function nowSeconds(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Fecha inválida para el documento temporal.");
  return Math.floor(now / 1000);
}

function signature(attemptId: string, expires: string, secret: string) {
  // Domain separation prevents this signature being reused for another purpose.
  return createHmac("sha256", secret)
    .update(`${MEDIA_ENDPOINT}\nv1\n${attemptId}\n${expires}`, "utf8")
    .digest();
}

/** Pure signing helper. The recipient can only fetch an already-started attempt. */
export function createSettlementMediaUrl(attemptId: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()) {
  if (!UUID.test(attemptId)) throw new Error("El identificador del intento no es válido.");
  const expires = String(nowSeconds(now) + MEDIA_TTL_SECONDS);
  const token = signature(attemptId, expires, mediaSecret(env)).toString("hex");
  const url = new URL(MEDIA_ENDPOINT);
  url.searchParams.set("attemptId", attemptId);
  url.searchParams.set("expires", expires);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Return only the authenticated attempt id; all malformed/expired links fail closed. */
export function verifySettlementMediaUrl(input: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): string | null {
  try {
    const url = new URL(input);
    if (`${url.origin}${url.pathname}` !== MEDIA_ENDPOINT || url.username || url.password || url.hash) return null;
    const params = url.searchParams;
    if ([...params.keys()].length !== 3 ||
        ["attemptId", "expires", "token"].some(key => params.getAll(key).length !== 1)) return null;
    const attemptId = params.get("attemptId")!;
    const expires = params.get("expires")!;
    const token = params.get("token")!;
    if (!UUID.test(attemptId) || !/^[1-9]\d{0,10}$/.test(expires) || !SIGNATURE.test(token)) return null;
    const expirySeconds = Number(expires);
    const currentSeconds = nowSeconds(now);
    if (!Number.isSafeInteger(expirySeconds) || expirySeconds <= currentSeconds ||
        expirySeconds > currentSeconds + MEDIA_TTL_SECONDS) return null;
    const expected = signature(attemptId, expires, mediaSecret(env));
    return timingSafeEqual(expected, Buffer.from(token, "hex")) ? attemptId : null;
  } catch {
    return null;
  }
}

/** SELECT only: downloading cannot create a PDF, enqueue work or change delivery state. */
export async function readSettlementMediaDocument(db: Pick<DeliveryDb, "$queryRawUnsafe">, attemptId: string) {
  if (!UUID.test(attemptId)) return null;
  const [stored] = await db.$queryRawUnsafe<Array<{ pdf: Uint8Array; filename: string }>>(
    `SELECT document."pdf", document."filename"
      FROM public."AllySettlementDocument" document
      JOIN public."AllySettlementDeliveryAttempt" attempt ON attempt."settlementId"=document."settlementId"
      WHERE attempt."id"=$1::uuid AND attempt."channel"='WHATSAPP'
        AND attempt."sendStartedAt" IS NOT NULL
        AND attempt."status" IN ('PROCESSING','SENT','UNCERTAIN')`,
    attemptId,
  );
  if (!stored) return null;
  const pdf = Buffer.from(stored.pdf);
  if (pdf.length < 5 || pdf.length > 20 * 1024 * 1024 || pdf.subarray(0, 5).toString("ascii") !== "%PDF-") return null;
  return { pdf, filename: SAFE_FILENAME.test(stored.filename) ? stored.filename : "liquidacion-aliado.pdf" };
}
