import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readAttentionSticker } from "./atencion-meta-sticker";
import { compileMetaTemplate, readMetaManualTemplate, type MetaManualTemplate, type MetaTemplateSnapshot } from "./atencion-meta-templates";
import { metaAutomationHeaderUrl } from "./whatsapp-automation-meta-config";

// Dedicated Attention credentials. Never fall back to OTP or settlement tokens.
// Meta contracts: https://www.postman.com/meta/whatsapp-business-platform
// Signature contract: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/
export const META_ATTENTION_LINE = Object.freeze({
  phoneNumberId: "1162059967000416", wabaId: "2148284059050848", displayPhone: "+573124085562",
});
export const META_ATTENTION_MAX_MEDIA_BYTES = 16 * 1024 * 1024;
export const META_ATTENTION_MAX_WEBHOOK_BYTES = 1024 * 1024;
export type MetaScope = { phoneNumberId: string; wabaId: string };
export type MetaMediaKind = "image" | "audio" | "video" | "document" | "sticker";
export type MetaInboundMessage = {
  id: string; from: string; phone: string | null; name: string | null; timestamp: string;
  type: "text" | MetaMediaKind; text?: string; replyToId?: string;
  media?: { id: string; mimeType: string; sha256?: string; fileName?: string; caption?: string };
};
/** A message sent from the business app, not a customer message or a CRM actor. */
export type MetaMessageEcho = Omit<MetaInboundMessage, "phone" | "name"> & {
  to: string; phone: string; name: null;
};
export type MetaDeliveryStatus = {
  id: string; recipient: string; timestamp: string;
  status: "sent" | "delivered" | "read" | "failed"; errorCodes: number[]; requestId?: string;
};
export type MetaWebhookEvents = { scope: MetaScope; messages: MetaInboundMessage[]; echoes?: MetaMessageEcho[]; statuses: MetaDeliveryStatus[]; ignored: number };
export type MetaSendInput = {
  recipient: string; attemptId: string; cutoverConfirmed: boolean; lastInboundAt: string;
};
export type MetaSendReceipt = { providerMessageId: string; recipient: string };
export type MetaMediaDownload = { bytes: Uint8Array; mimeType: string; totalBytes: number; status: 200 | 206; contentRange?: string };
type Env = Record<string, string | undefined>;
type Dict = Record<string, unknown>;
type Config = MetaScope & { token: string; version: string };
type BeforeSend = () => Promise<void>;
type Options = { env?: Env; fetch?: typeof fetch; now?: () => number; timeoutMs?: number };
export function getMetaAttentionScope(env: Env = process.env): MetaScope | null {
  return env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID === META_ATTENTION_LINE.phoneNumberId && env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID === META_ATTENTION_LINE.wabaId
    ? { phoneNumberId: META_ATTENTION_LINE.phoneNumberId, wabaId: META_ATTENTION_LINE.wabaId } : null;
}
const GRAPH = "https://graph.facebook.com";
const ID = /^\d{5,30}$/;
const PHONE = /^[1-9]\d{6,14}$/;
const WAMID = /^wamid\.[A-Za-z0-9_+/=.-]{1,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON = 1024 * 1024;
const MIME: Record<string, { kind: MetaMediaKind; extensions: string[]; max: number }> = {
  "image/jpeg": { kind: "image", extensions: ["jpg", "jpeg"], max: 5 * 1024 * 1024 },
  "image/png": { kind: "image", extensions: ["png"], max: 5 * 1024 * 1024 },
  "image/webp": { kind: "sticker", extensions: ["webp"], max: 500 * 1024 },
  "audio/aac": { kind: "audio", extensions: ["aac"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "audio/mp4": { kind: "audio", extensions: ["m4a", "mp4"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "audio/mpeg": { kind: "audio", extensions: ["mp3"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "audio/amr": { kind: "audio", extensions: ["amr"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "audio/ogg": { kind: "audio", extensions: ["ogg", "opus"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "video/mp4": { kind: "video", extensions: ["mp4"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  "video/3gpp": { kind: "video", extensions: ["3gp"], max: META_ATTENTION_MAX_MEDIA_BYTES },
  // Deliberately narrower than Meta: no executable, HTML, SVG or Office archive.
  "application/pdf": { kind: "document", extensions: ["pdf"], max: META_ATTENTION_MAX_MEDIA_BYTES },
};
// Receive-only: Meta supports Excel documents. Do not expand the CRM's upload/send formats.
// https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/document/
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const RECEIVED_MIME = { [XLSX_MIME]: { kind: "document" as const, extensions: ["xlsx"], max: META_ATTENTION_MAX_MEDIA_BYTES } };

export class AttentionMetaError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 502,
    public readonly uncertain = false, public readonly retryable = false) {
    super(message); this.name = "AttentionMetaError";
  }
}
function fail(code: string, message: string, status = 400): never { throw new AttentionMetaError(code, message, status); }
function dict(value: unknown): Dict { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Dict : {}; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function validSecret(value: string | undefined): value is string {
  return Boolean(value && value.length >= 8 && value.length <= 8192 && !/[\s\u0000-\u001f\u007f]/.test(value));
}
function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest(); const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}
function mime(value: unknown): string {
  const type=str(value).split(";")[0].trim().toLowerCase();
  const aliases:Record<string,string>={"audio/mp3":"audio/mpeg","audio/x-m4a":"audio/mp4","audio/m4a":"audio/mp4","application/ogg":"audio/ogg"};
  return Object.hasOwn(aliases,type)?aliases[type]:type;
}
function mediaRule(type: string) { return Object.hasOwn(MIME, type) ? MIME[type] : undefined; }
function receivedMediaRule(type: string) { return mediaRule(type) ?? (Object.hasOwn(RECEIVED_MIME, type) ? RECEIVED_MIME[type as keyof typeof RECEIVED_MIME] : undefined); }
function recipient(value: unknown): string {
  const result = str(value).replace(/^\+/, "");
  if (!PHONE.test(result)) fail("INVALID_RECIPIENT", "El destinatario de WhatsApp no es válido.");
  return result;
}
function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > max) return undefined;
  // Best effort display redaction, not a guarantee that arbitrary text contains no secret.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[oculto]")
    .replace(/\b((?:api[-_ ]?key|contrase[ñn]a|password|otp|pin|c[oó]digo(?: de (?:verificaci[oó]n|seguridad|acceso))?)\s*[:=]?\s*)[^\s,;]{3,}/gi, "$1[oculto]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[dato protegido]");
}
function fileName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 150 || !/^[\p{L}\p{N} _().-]+$/u.test(value) || value.startsWith(".")) return undefined;
  return value;
}
function isoTimestamp(value: unknown, now: number): string | undefined {
  if (typeof value !== "string" || !/^\d{10}$/.test(value)) return undefined;
  const ms = Number(value) * 1000;
  return ms >= Date.UTC(2020, 0, 1) && ms <= now + 5 * 60_000 ? new Date(ms).toISOString() : undefined;
}
function mediaHash(value: unknown): string | undefined {
  const hash = str(value);
  return /^(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/i.test(hash) ? hash : undefined;
}
function messageContent(message: Dict): Pick<MetaInboundMessage, "type" | "text" | "media" | "replyToId"> | null {
  const context = WAMID.test(str(dict(message.context).id)) ? { replyToId: str(dict(message.context).id) } : {};
  if (message.type === "text") {
    const text = safeText(dict(message.text).body, 16_000);
    return text ? { ...context, type: "text", text } : null;
  }
  // Display the customer's visible reply only. Button payloads/IDs never become
  // commands, actor identity or application actions.
  if (message.type === "button" || message.type === "interactive") {
    const interactive=dict(message.interactive),kind=str(interactive.type);
    const label=message.type === "button" ? dict(message.button).text
      : ["button_reply","list_reply"].includes(kind) ? dict(interactive[kind]).title : undefined;
    const text=safeText(label,4096);
    return text ? {...context,type:"text",text} : null;
  }
  if (!["image", "audio", "video", "document", "sticker"].includes(str(message.type))) return null;
  const type = message.type as MetaMediaKind, media = dict(message[type]), mimeType = mime(media.mime_type);
  if (!ID.test(str(media.id))) return null;
  const name = fileName(media.filename), rule = receivedMediaRule(mimeType);
  if (rule?.kind !== type || (mimeType === XLSX_MIME && media.filename !== undefined && (!name || !name.toLowerCase().endsWith(".xlsx")))) {
    if (type !== "document") return null;
    // Preserve the actual message ID, sender and caption without inventing a downloadable attachment.
    const caption = safeText(media.caption, 1024);
    return { ...context, type: "text", text: `${caption ? `${caption}\n\n` : ""}[Documento recibido no compatible${name ? `: ${name}` : ""}]` };
  }
  return { ...context, type, media: { id: str(media.id), mimeType,
    ...(mediaHash(media.sha256) ? { sha256: mediaHash(media.sha256) } : {}),
    ...(fileName(media.filename) ? { fileName: fileName(media.filename) } : {}),
    ...(safeText(media.caption, 1024) ? { caption: safeText(media.caption, 1024) } : {}) } };
}
/** Inspect ZIP records only: never inflate, parse worksheets, render Office or execute workbook content. */
function isReceivedXlsx(b: Buffer): boolean {
  if (b.length < 22 || b.readUInt32LE(0) !== 0x04034b50) return false;
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--) {
    if (b.readUInt32LE(p) === 0x06054b50 && p + 22 + b.readUInt16LE(p + 20) === b.length) { end = p; break; }
  }
  if (end < 0 || b.readUInt16LE(end + 4) || b.readUInt16LE(end + 6)) return false;
  const count = b.readUInt16LE(end + 10), central = b.readUInt32LE(end + 16), size = b.readUInt32LE(end + 12);
  if (!count || count > 4096 || b.readUInt16LE(end + 8) !== count || central + size !== end) return false;
  const names = new Set<string>(), ranges: {start: number; end: number}[] = [];
  let p = central, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || b.readUInt32LE(p) !== 0x02014b50) return false;
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), crc = b.readUInt32LE(p + 16);
    const compressed = b.readUInt32LE(p + 20), uncompressed = b.readUInt32LE(p + 24), length = b.readUInt16LE(p + 28);
    const extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), offset = b.readUInt32LE(p + 42);
    if ((flags & ~0x080e) || ![0, 8].includes(method) || !length || length > 1024 || p + 46 + length + extra + comment > end || b.readUInt16LE(p + 34)) return false;
    const rawName = b.subarray(p + 46, p + 46 + length), name = rawName.toString("utf8"), lower = name.toLowerCase();
    const parts = name.replace(/\/$/, "").split("/");
    if (!/^[A-Za-z0-9_().\[\] /-]+$/.test(name) || parts.some(part => !part || part === "." || part === "..") || names.has(lower)) return false;
    if (!(name === "[Content_Types].xml" || /^(?:_rels|docProps|xl)\//.test(name)) || /(?:^|\/)(?:vba[^/]*|macrosheets|dialogsheets|activex|embeddings|customui)(?:\/|\.|$)/i.test(name)) return false;
    const printerSettings = /^xl\/printerSettings\/printerSettings[1-9]\d*\.bin$/i.test(name);
    const drawing = /^xl\/(?:media\/[^/]+\.(?:emf|wmf)|drawings\/vmlDrawing[1-9]\d*\.vml)$/i.test(name);
    if (!name.endsWith("/") && !/\.(?:xml|rels|png|jpe?g|gif|bmp|tiff?)$/i.test(name) && !printerSettings && !drawing) return false;
    if (((b.readUInt32LE(p + 38) >>> 16) & 0xf000) === 0xa000) return false;
    expanded += uncompressed;
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || expanded > 64 * 1024 * 1024 || uncompressed > Math.max(1024 * 1024, compressed * 200) || (method === 0 && compressed !== uncompressed)) return false;
    if (offset + 30 > central || b.readUInt32LE(offset) !== 0x04034b50 || b.readUInt16LE(offset + 6) !== flags || b.readUInt16LE(offset + 8) !== method || b.readUInt16LE(offset + 26) !== length) return false;
    const data = offset + 30 + length + b.readUInt16LE(offset + 28);
    if (data + compressed > central || !b.subarray(offset + 30, offset + 30 + length).equals(rawName)) return false;
    let stop = data + compressed;
    if (flags & 8) {
      if (stop + 12 > central) return false;
      if (b.readUInt32LE(stop) === 0x08074b50) stop += 4;
      if (stop + 12 > central || b.readUInt32LE(stop) !== crc || b.readUInt32LE(stop + 4) !== compressed || b.readUInt32LE(stop + 8) !== uncompressed) return false;
      stop += 12;
    } else if (b.readUInt32LE(offset + 14) !== crc || b.readUInt32LE(offset + 18) !== compressed || b.readUInt32LE(offset + 22) !== uncompressed) return false;
    names.add(lower); ranges.push({start: offset, end: stop}); p += 46 + length + extra + comment;
  }
  ranges.sort((a, c) => a.start - c.start);
  if (p !== end || ranges[0]?.start !== 0 || ranges.at(-1)?.end !== central || ranges.some((range, index) => index > 0 && range.start !== ranges[index - 1].end)) return false;
  return names.has("[content_types].xml") && names.has("_rels/.rels") && names.has("xl/workbook.xml") && [...names].some(name => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
}
function validateMagic(bytes: Uint8Array, type: string): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const head = b.subarray(0, 32).toString("latin1");
  switch (type) {
    case XLSX_MIME: return isReceivedXlsx(b);
    case "image/jpeg": return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/png": return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/webp": return head.startsWith("RIFF") && head.slice(8, 12) === "WEBP";
    case "application/pdf": return head.startsWith("%PDF-") && b.subarray(Math.max(0, b.length - 2048)).includes(Buffer.from("%%EOF"));
    case "audio/ogg": return head.startsWith("OggS") && b.subarray(0, 8192).includes(Buffer.from("OpusHead"));
    case "audio/amr": return head.startsWith("#!AMR\n") || head.startsWith("#!AMR-WB\n");
    case "audio/aac": return b.length > 7 && b[0] === 0xff && (b[1] & 0xf6) === 0xf0;
    case "audio/mpeg": return head.startsWith("ID3") || (b.length > 4 && b[0] === 0xff && (b[1] & 0xe6) === 0xe2);
    case "audio/mp4": case "video/mp4": case "video/3gpp": {
      if (head.slice(4, 8) !== "ftyp") return false;
      const handlers = new Set<string>(); let visited = 0;
      function boxes(start: number, end: number, depth: number): boolean {
        if (depth > 8) return false;
        for (let p = start; p < end;) {
          if (p + 8 > end || ++visited > 4096) return false;
          let size = b.readUInt32BE(p); const name = b.toString("ascii", p + 4, p + 8); let header = 8;
          if (size === 1) { if (p + 16 > end) return false; const wide = b.readBigUInt64BE(p + 8); if (wide > BigInt(b.length)) return false; size = Number(wide); header = 16; }
          if (size === 0) size = end - p;
          if (size < header || p + size > end) return false;
          if (["moov", "trak", "mdia"].includes(name) && !boxes(p + header, p + size, depth + 1)) return false;
          if (name === "hdlr" && size >= header + 12) handlers.add(b.toString("ascii", p + header + 8, p + header + 12));
          p += size;
        }
        return true;
      }
      if (!boxes(0, b.length, 0)) return false;
      return type === "audio/mp4" ? handlers.has("soun") && !handlers.has("vide") : handlers.has("vide");
    }
    default: return false;
  }
}
function validateMedia(input: { bytes: Uint8Array; mimeType: string; fileName?: string; kind?: MetaMediaKind }, received = false) {
  const type = mime(input.mimeType); const rule = received ? receivedMediaRule(type) : mediaRule(type);
  if (!rule || (input.kind && input.kind !== rule.kind)) fail("UNSUPPORTED_MEDIA", "Este formato de archivo no está habilitado.", 415);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0 || input.bytes.length > rule.max) fail("MEDIA_TOO_LARGE", "El archivo está vacío o excede el límite permitido.", 413);
  if (input.fileName !== undefined && (!fileName(input.fileName) || !rule.extensions.includes(input.fileName.split(".").pop()?.toLowerCase() || ""))) fail("INVALID_MEDIA_NAME", "El nombre y la extensión del archivo no corresponden al formato.");
  if (!validateMagic(input.bytes, type)) fail("INVALID_MEDIA_CONTENT", "El contenido del archivo no corresponde al formato declarado.", 415);
  if (type === "image/webp") {
    const sticker=readAttentionSticker(input.bytes);
    if(!sticker)fail("INVALID_MEDIA_CONTENT","El archivo no contiene un sticker WebP válido.",415);
    if(sticker.width!==512 || sticker.height!==512)fail("INVALID_STICKER_DIMENSIONS","El sticker debe medir 512 × 512 píxeles.",415);
    if(input.bytes.length>(sticker.animated?500:100)*1024)fail("MEDIA_TOO_LARGE",sticker.animated?"El sticker animado excede 500 KB.":"El sticker estático excede 100 KB.",413);
  }
  return { mimeType: type, kind: rule.kind, size: input.bytes.length };
}
export function validateMetaAttentionMedia(input: { bytes: Uint8Array; mimeType: string; fileName?: string; kind?: MetaMediaKind }) { return validateMedia(input); }

export function createMetaAttentionAdapter(options: Options = {}) {
  const env = options.env ?? process.env; const transport = options.fetch ?? fetch; const now = options.now ?? Date.now;
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 20_000, 30_000));
  type VerifiedConnection = MetaScope & { displayPhone: string };
  // A runtime owns one adapter per HTTP request. Reuse only the same private
  // configuration for a few seconds (e.g. upload + send), never across runtimes.
  let verified: { config: Config; checkedAt: number; value: VerifiedConnection } | null = null;
  let verifying: { config: Config; promise: Promise<VerifiedConnection> } | null = null;
  const sameConfig = (a: Config, b: Config) => a.token === b.token && a.version === b.version && a.phoneNumberId === b.phoneNumberId && a.wabaId === b.wabaId;
  function scope(): MetaScope {
    const selected = getMetaAttentionScope(env);
    if (!selected) fail("META_SCOPE_CONFIG", "La línea de Atención no coincide con la autorizada.", 503);
    return selected;
  }
  function config(): Config {
    const selected = scope();
    if (!validSecret(env.WHATSAPP_ATTENTION_ACCESS_TOKEN)) fail("META_NOT_CONFIGURED", "Falta la credencial privada de Atención.", 503);
    const version = env.WHATSAPP_GRAPH_API_VERSION;
    if (!version || !/^v\d{2}\.0$/.test(version)) fail("META_NOT_CONFIGURED", "Falta una versión válida de Graph API.", 503);
    return { ...selected, token: env.WHATSAPP_ATTENTION_ACCESS_TOKEN, version };
  }
  function enabled() {
    if (env.WHATSAPP_ATTENTION_SEND_ENABLED !== "true") fail("META_SEND_DISABLED", "El envío desde Atención todavía no está habilitado.", 503);
    if (env.WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED !== "true") fail("META_CUTOVER_REQUIRED", "Falta confirmar la coordinación de la IA antes de responder.", 409);
  }
  function status() {
    const missing: string[] = [];
    for (const key of ["WHATSAPP_ATTENTION_ACCESS_TOKEN", "WHATSAPP_ATTENTION_APP_SECRET", "WHATSAPP_ATTENTION_VERIFY_TOKEN"]) if (!validSecret(env[key])) missing.push(key);
    if (env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID !== META_ATTENTION_LINE.phoneNumberId) missing.push("WHATSAPP_ATTENTION_PHONE_NUMBER_ID");
    if (env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID !== META_ATTENTION_LINE.wabaId) missing.push("WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID");
    if (!/^v\d{2}\.0$/.test(env.WHATSAPP_GRAPH_API_VERSION ?? "")) missing.push("WHATSAPP_GRAPH_API_VERSION");
    return { configured: missing.length === 0, webhookReady: !missing.some(k => k !== "WHATSAPP_ATTENTION_ACCESS_TOKEN" && k !== "WHATSAPP_GRAPH_API_VERSION"),
      sendEnabled: env.WHATSAPP_ATTENTION_SEND_ENABLED === "true", cutoverConfirmed: env.WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED === "true",
      canSend: missing.length === 0 && env.WHATSAPP_ATTENTION_SEND_ENABLED === "true" && env.WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED === "true", missing };
  }
  function verifyWebhookChallenge(params: URLSearchParams): string {
    scope(); const token = env.WHATSAPP_ATTENTION_VERIFY_TOKEN;
    if (!validSecret(token)) fail("META_NOT_CONFIGURED", "La verificación de Atención no está configurada.", 503);
    for (const key of ["hub.mode", "hub.verify_token", "hub.challenge"]) if (params.getAll(key).length !== 1) fail("INVALID_CHALLENGE", "Verificación no válida.", 403);
    if (params.get("hub.mode") !== "subscribe" || !safeEqual(params.get("hub.verify_token") ?? "", token)) fail("INVALID_CHALLENGE", "Verificación no válida.", 403);
    const challenge = params.get("hub.challenge") ?? "";
    if (!/^\d{1,128}$/.test(challenge)) fail("INVALID_CHALLENGE", "Verificación no válida.", 403);
    return challenge;
  }
  function parseWebhook(rawBody: Uint8Array, signature: string | null): MetaWebhookEvents {
    const selected = scope(); const secret = env.WHATSAPP_ATTENTION_APP_SECRET;
    if (!validSecret(secret)) fail("META_NOT_CONFIGURED", "La firma de Atención no está configurada.", 503);
    if (!(rawBody instanceof Uint8Array) || rawBody.length === 0 || rawBody.length > META_ATTENTION_MAX_WEBHOOK_BYTES) fail("WEBHOOK_TOO_LARGE", "El evento excede el límite permitido.", 413);
    if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) fail("INVALID_SIGNATURE", "Firma de evento no válida.", 401);
    const digest = createHmac("sha256", secret).update(rawBody).digest();
    if (!timingSafeEqual(digest, Buffer.from(signature.slice(7), "hex"))) fail("INVALID_SIGNATURE", "Firma de evento no válida.", 401);
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)); } catch { fail("INVALID_WEBHOOK", "El evento no tiene un formato válido."); }
    const body = dict(parsed); const events: MetaWebhookEvents & { echoes: MetaMessageEcho[] } = { scope: selected, messages: [], echoes: [], statuses: [], ignored: 0 };
    if (body.object !== "whatsapp_business_account") { events.ignored++; return events; }
    for (const item of list(body.entry)) {
      const entry = dict(item);
      if (entry.id !== selected.wabaId) { events.ignored++; continue; }
      for (const changeRaw of list(entry.changes)) {
        const change = dict(changeRaw); const value = dict(change.value);
        if (!["messages", "smb_message_echoes"].includes(str(change.field)) || value.messaging_product !== "whatsapp" || dict(value.metadata).phone_number_id !== selected.phoneNumberId) { events.ignored++; continue; }
        if (change.field === "smb_message_echoes") {
          const businessPhone = META_ATTENTION_LINE.displayPhone.slice(1);
          for (const raw of list(value.message_echoes)) {
            const message = dict(raw), from = str(message.from), to = str(message.to), id = str(message.id), timestamp = isoTimestamp(message.timestamp, now());
            if (from !== businessPhone || !PHONE.test(to) || to === businessPhone || !WAMID.test(id) || !timestamp
              || (message.recipient_type !== undefined && message.recipient_type !== "individual")
              || message.group_id !== undefined || value.group_id !== undefined) { events.ignored++; continue; }
            const content = messageContent(message);
            if (!content) { events.ignored++; continue; }
            events.echoes.push({ id, from, to, phone: `+${to}`, name: null, timestamp, ...content });
          }
          continue;
        }
        for (const raw of list(value.messages)) {
          const message = dict(raw); const from = str(message.from); const id = str(message.id); const timestamp = isoTimestamp(message.timestamp, now());
          if (!PHONE.test(from) || !WAMID.test(id) || !timestamp) { events.ignored++; continue; }
          const matching = list(value.contacts).map(dict).find(contact => contact.wa_id === from);
          const content = messageContent(message);
          if (content) events.messages.push({ id, from, phone: `+${from}`, name: safeText(dict(matching?.profile).name, 120) ?? null, timestamp, ...content });
          else events.ignored++;
        }
        for (const raw of list(value.statuses)) {
          const event = dict(raw); const timestamp = isoTimestamp(event.timestamp, now());
          if (!WAMID.test(str(event.id)) || !PHONE.test(str(event.recipient_id)) || !timestamp || !["sent", "delivered", "read", "failed"].includes(str(event.status))) { events.ignored++; continue; }
          events.statuses.push({ id: str(event.id), recipient: str(event.recipient_id), timestamp, status: event.status as MetaDeliveryStatus["status"],
            errorCodes: list(event.errors).map(error => dict(error).code).filter((code): code is number => Number.isSafeInteger(code) && Number(code) >= 0).slice(0, 20),
            ...(UUID.test(str(event.biz_opaque_callback_data)) ? { requestId: str(event.biz_opaque_callback_data) } : {}) });
        }
      }
    }
    return events;
  }
  async function readBytes(response: Response, max: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) { await response.body?.cancel(); fail("RESPONSE_TOO_LARGE", "Meta devolvió un contenido que excede el límite.", 502); }
    if (!response.body) fail("INVALID_RESPONSE", "Meta devolvió una respuesta vacía.", 502);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true });
    try { for (;;) {
      if (signal.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      const { done, value } = await reader.read();
      if (signal.aborted) throw Object.assign(new Error("Request aborted"), { name: "AbortError" });
      if (done) break; total += value.length; if (total > max) { await reader.cancel(); fail("RESPONSE_TOO_LARGE", "Meta devolvió un contenido que excede el límite.", 502); } chunks.push(value);
    } }
    finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
    return Buffer.concat(chunks, total);
  }
  function requestOperation(url: URL, sending: boolean) {
    return sending ? "send" : url.origin !== GRAPH ? "private_media" : url.pathname.endsWith("/message_templates") ? "templates"
      : url.pathname.endsWith("/phone_numbers") ? "waba_phones" : url.pathname.endsWith(`/${META_ATTENTION_LINE.phoneNumberId}`) ? "phone" : "graph";
  }
  async function requestOnce(url: URL, init: RequestInit, max: number, sending: boolean, budgetMs: number): Promise<{ response: Response; bytes: Uint8Array }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error("Request deadline"), { name: "AbortError" }));
        controller.abort();
      }, budgetMs);
    });
    try {
      const work = (async () => {
        const response = await transport(url, { ...init, redirect: "error", cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) { void response.body?.cancel().catch(() => undefined); throw Object.assign(new Error("Request aborted"), { name: "AbortError" }); }
        const bytes = await readBytes(response, max, controller.signal);
        return { response, bytes };
      })();
      const { response, bytes } = await Promise.race([work, deadline]);
      if (!response.ok) {
        // Only a structured Graph rejection proves a send was not accepted.
        let graphError = false;
        try { graphError = Number.isInteger(dict(dict(JSON.parse(Buffer.from(bytes).toString("utf8"))).error).code); } catch { /* no raw provider payload in errors */ }
        throw new AttentionMetaError("META_HTTP_ERROR", "Meta no pudo completar la solicitud.", response.status === 401 || response.status === 403 ? 503 : 502,
          sending && !(response.status >= 400 && response.status < 500 && graphError), !sending && (response.status === 429 || response.status >= 500));
      }
      return { response, bytes };
    } catch (error) {
      if (error instanceof AttentionMetaError) {
        if (sending && !error.uncertain && error.code !== "META_HTTP_ERROR") throw new AttentionMetaError(error.code, error.message, error.status, true, false);
        throw error;
      }
      // Transport diagnostics must never include raw errors, signed URLs,
      // headers, credentials or customer identifiers.
      const cause=dict(dict(error).cause),code=str(cause.code)||str(dict(error).code);
      const safeCodes=new Set(["ENOTFOUND","EAI_AGAIN","ENETUNREACH","EHOSTUNREACH","ECONNRESET","ECONNREFUSED","ETIMEDOUT","EPIPE","ERR_INVALID_URL","ERR_INVALID_ARG_TYPE",
        "ERR_INVALID_CHAR","ERR_INVALID_HTTP_TOKEN","ERR_SSL_WRONG_VERSION_NUMBER","ERR_TLS_CERT_ALTNAME_INVALID","CERT_HAS_EXPIRED","DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","UND_ERR_SOCKET"]);
      const name=str(dict(error).name),operation=requestOperation(url,sending);
      console.warn("[attention-meta-transport]",JSON.stringify({operation,error:["TypeError","ReferenceError","AbortError","TimeoutError","Error"].includes(name)?name:"UnknownError",
        cause:safeCodes.has(code)?code:"UNKNOWN",aborted:controller.signal.aborted}));
      throw new AttentionMetaError("META_UNAVAILABLE", "No fue posible completar la conexión con Meta.", 502, sending, !sending);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function request(url: URL, init: RequestInit, max: number, sending = false): Promise<{ response: Response; bytes: Uint8Array }> {
    // Reads may recover once from a transient connection failure. Uploads and
    // message/template POSTs are never repeated, even when no response arrives.
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try { return await requestOnce(url, init, max, sending, Math.max(1, timeoutMs - (Date.now() - started))); }
      catch (error) {
        if (init.method !== "GET" || sending || attempt !== 1 || !(error instanceof AttentionMetaError) || !error.retryable || Date.now() - started + 250 >= timeoutMs) throw error;
        console.warn("[attention-meta-read-retry]", JSON.stringify({ operation: requestOperation(url, false), attempt: 2,
          code: /^[A-Z0-9_:-]{1,80}$/.test(error.code) ? error.code : "UNKNOWN", delayMs: 250 }));
        await new Promise<void>(resolve => setTimeout(resolve, 250));
        if (Date.now() - started >= timeoutMs) throw error;
      }
    }
  }
  async function graph(path: string, query: Record<string, string> = {}, body?: Dict | FormData, sending = false): Promise<Dict> {
    const cfg = config(); const url = new URL(`${GRAPH}/${cfg.version}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
    if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const { bytes } = await request(url, { method: body ? "POST" : "GET", headers, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) }, MAX_JSON, sending);
    try { const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.error) throw new Error(); return parsed; }
    catch { throw new AttentionMetaError("INVALID_RESPONSE", "Meta devolvió una respuesta no válida.", 502, sending); }
  }
  async function verifyConnection() {
    const cfg = config(), checkedAt = now();
    if (verified && sameConfig(verified.config, cfg) && checkedAt >= verified.checkedAt && checkedAt - verified.checkedAt < 5_000) return { ...verified.value };
    if (verifying && sameConfig(verifying.config, cfg)) return { ...await verifying.promise };
    verified = null;
    const promise = (async (): Promise<VerifiedConnection> => {
      const [phone, firstPage] = await Promise.all([
        graph(cfg.phoneNumberId, { fields: "id,display_phone_number" }),
        graph(`${cfg.wabaId}/phone_numbers`, { fields: "id,display_phone_number", limit: "100" }),
      ]);
      const matches = (item: Dict) => item.id === cfg.phoneNumberId && str(item.display_phone_number).replace(/[+\s()-]/g, "") === META_ATTENTION_LINE.displayPhone.slice(1);
      if (!matches(phone)) fail("META_SCOPE_MISMATCH", "Meta no confirmó la línea autorizada de Atención.", 503);
      let result = firstPage; const seen = new Set<string>();
      for (let page = 0; page < 10; page++) {
        if (list(result.data).some(item => matches(dict(item)))) {
          if (!sameConfig(cfg, config())) fail("META_SCOPE_CONFIG", "La configuración del canal cambió. Vuelve a verificar la conexión.", 503);
          const value = { phoneNumberId: cfg.phoneNumberId, wabaId: cfg.wabaId, displayPhone: META_ATTENTION_LINE.displayPhone };
          verified = { config: cfg, checkedAt: now(), value }; return value;
        }
        const paging = dict(result.paging), next = str(dict(paging.cursors).after);
        if (page === 9 || !paging.next || !next || next.length > 2048 || seen.has(next)) break;
        seen.add(next);
        result = await graph(`${cfg.wabaId}/phone_numbers`, { fields: "id,display_phone_number", limit: "100", after: next });
      }
      fail("META_SCOPE_MISMATCH", "Meta no confirmó que la línea pertenezca a la cuenta autorizada.", 503);
    })();
    verifying = { config: cfg, promise };
    try { return { ...await promise }; }
    finally { if (verifying?.promise === promise) verifying = null; }
  }
  function validateSendBase(input: Omit<MetaSendInput,"lastInboundAt">, beforeSend: BeforeSend) {
    config(); enabled();
    if (!status().configured) fail("META_NOT_CONFIGURED", "Falta completar la configuración privada del canal de Atención.", 503);
    if (input.cutoverConfirmed !== true) fail("META_CUTOVER_REQUIRED", "La conversación no está habilitada para respuesta humana.", 409);
    if (!UUID.test(input.attemptId) || typeof beforeSend !== "function") fail("INVALID_ATTEMPT", "Falta un intento de envío autorizado.");
    return recipient(input.recipient);
  }
  function validateSend(input: MetaSendInput, beforeSend: BeforeSend) {
    const to=validateSendBase(input,beforeSend);
    if (typeof input.lastInboundAt !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.lastInboundAt)) fail("SERVICE_WINDOW_CLOSED", "La conversación no tiene una ventana de respuesta válida.", 409);
    const incoming = Date.parse(input.lastInboundAt); const age = now() - incoming;
    if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) fail("SERVICE_WINDOW_CLOSED", "La ventana de 24 horas está cerrada; se necesita una plantilla aprobada.", 409);
    return to;
  }
  async function listManualTemplates(name?: string): Promise<MetaManualTemplate[]> {
    config(); await verifyConnection();
    let after=""; const seen=new Set<string>(), templates:MetaManualTemplate[]=[];
    for(let page=0;page<10;page++){
      const result=await graph(`${scope().wabaId}/message_templates`,{fields:"id,name,status,language,category,parameter_format,components",limit:"100",...(name?{name}:{}),...(after?{after}:{})});
      for(const raw of list(result.data)){const template=readMetaManualTemplate(raw);if(template){
        if(template.headerImageUrl && !metaAutomationHeaderUrl(env.WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL||"","2dias")){
          template.available=false;template.reason="La imagen aprobada de esta plantilla todavía no está configurada.";
        }
        templates.push(template);
      }}
      const paging=dict(result.paging),next=str(dict(paging.cursors).after);
      if(!paging.next)return templates.sort((a,b)=>a.name.localeCompare(b.name)||a.language.localeCompare(b.language));
      if(!next||next.length>2048||seen.has(next))break;seen.add(next);after=next;
    }
    fail("TEMPLATE_CATALOGUE_INCOMPLETE","No fue posible obtener el catálogo completo de plantillas. Inténtalo nuevamente.",503);
  }
  async function prepareTemplateMedia(snapshot:MetaTemplateSnapshot){
    compileMetaTemplate(snapshot);config();enabled();
    if(snapshot.definition.name!=="2dias" || snapshot.definition.headerImageUrl!=="/whatsapp/templates/2dias.png" || snapshot.financial?.templateName!=="2dias")
      fail("INVALID_TEMPLATE_IMAGE","Esta plantilla no admite una imagen manual.",409);
    const url=metaAutomationHeaderUrl(env.WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL||"","2dias");
    if(!url)fail("INVALID_TEMPLATE_IMAGE","La imagen aprobada de esta plantilla todavía no está configurada.",503);
    // Fixed first-party asset, no Authorization header and no redirects.
    const downloaded=await request(new URL(url),{method:"GET"},5*1024*1024);
    const mimeType=mime(downloaded.response.headers.get("content-type"));
    const validated=validateMetaAttentionMedia({bytes:downloaded.bytes,mimeType,fileName:"2dias.png",kind:"image"});
    const uploaded=await uploadMedia({bytes:downloaded.bytes,mimeType:validated.mimeType,fileName:"2dias.png",kind:"image"});
    return {mediaId:uploaded.mediaId,attachment:{kind:"image" as const,mimeType:validated.mimeType,fileName:"2dias.png",
      sha256:createHash("sha256").update(downloaded.bytes).digest("hex"),size:downloaded.bytes.length}};
  }
  async function sendTemplate(input: Omit<MetaSendInput,"lastInboundAt"> & {snapshot:MetaTemplateSnapshot;headerMediaId?:string},beforeSend:BeforeSend,
    withSendGuard?:<T>(send:()=>Promise<T>)=>Promise<T>,onPost?:()=>void): Promise<MetaSendReceipt> {
    const to=validateSendBase(input,beforeSend), expected=input.snapshot.definition;
    const matches=(await listManualTemplates(expected.name)).filter(t=>t.key===expected.key);
    if(matches.length!==1||matches[0].revision!==expected.revision)fail("TEMPLATE_CHANGED","La plantilla cambió o dejó de estar aprobada. Actualiza el catálogo y revísala antes de confirmar.",409);
    const compiled=compileMetaTemplate({...input.snapshot,definition:matches[0]});
    if(matches[0].headerImageUrl){
      if(!ID.test(input.headerMediaId||""))fail("INVALID_TEMPLATE_IMAGE","Hace falta la imagen aprobada de la plantilla.",409);
      compiled.template.components=[{type:"header",parameters:[{type:"image",image:{id:input.headerMediaId}}]},...(compiled.template.components||[])];
    }else if(input.headerMediaId)fail("INVALID_TEMPLATE_IMAGE","Esta plantilla no admite una imagen.",409);
    if(input.snapshot.financial&&!withSendGuard)fail("FINANCIAL_GUARD_REQUIRED","Falta validar el crédito antes del envío.",409);
    validateSendBase(input,beforeSend);await beforeSend();validateSendBase(input,beforeSend);
    let attempted=false;
    const send=async()=>{
      if(attempted)fail("SEND_ALREADY_STARTED","Este envío ya se inició.",409);attempted=true;
      validateSendBase(input,beforeSend);
      onPost?.();
      return graph(`${scope().phoneNumberId}/messages`,{},{messaging_product:"whatsapp",recipient_type:"individual",to,
        type:"template",template:compiled.template,biz_opaque_callback_data:input.attemptId},true);
    };
    const result=withSendGuard?await withSendGuard(send):await send();
    if(!attempted)fail("FINANCIAL_GUARD_REQUIRED","No se confirmó la validación financiera del envío.",409);
    const message=dict(list(result.messages)[0]),contact=dict(list(result.contacts)[0]);
    if(result.messaging_product!=="whatsapp"||!WAMID.test(str(message.id))||str(contact.wa_id)!==to||str(contact.input).replace(/^\+/,"")!==to)
      throw new AttentionMetaError("INVALID_SEND_RECEIPT","Meta no confirmó de forma verificable el envío. No lo reenvíes automáticamente.",502,true);
    return {providerMessageId:str(message.id),recipient:to};
  }
  async function send(input: MetaSendInput, body: Dict, beforeSend: BeforeSend): Promise<MetaSendReceipt> {
    const to = validateSend(input, beforeSend); await verifyConnection();
    // Last check and persisted outbox claim are immediately before the only POST.
    validateSend(input, beforeSend); await beforeSend(); validateSend(input, beforeSend);
    const result = await graph(`${scope().phoneNumberId}/messages`, {}, { messaging_product: "whatsapp", recipient_type: "individual", to,
      biz_opaque_callback_data: input.attemptId, ...body }, true);
    const message = dict(list(result.messages)[0]); const contact = dict(list(result.contacts)[0]);
    if (result.messaging_product !== "whatsapp" || !WAMID.test(str(message.id)) || str(contact.wa_id) !== to || str(contact.input).replace(/^\+/, "") !== to) throw new AttentionMetaError("INVALID_SEND_RECEIPT", "Meta no confirmó de forma verificable el envío. No lo reenvíes automáticamente.", 502, true);
    return { providerMessageId: str(message.id), recipient: to };
  }
  async function sendText(input: MetaSendInput & { text: string }, beforeSend: BeforeSend) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) fail("INVALID_TEXT", "El mensaje debe contener entre 1 y 4096 caracteres válidos.");
    return send(input, { type: "text", text: { body: input.text, preview_url: false } }, beforeSend);
  }
  async function uploadMedia(input: { bytes: Uint8Array; mimeType: string; fileName: string; kind?: MetaMediaKind }) {
    config(); enabled(); const validated = validateMetaAttentionMedia(input); await verifyConnection();
    const form = new FormData(); form.set("messaging_product", "whatsapp"); form.set("type", validated.mimeType);
    form.set("file", new Blob([new Uint8Array(input.bytes)], { type: validated.mimeType }), input.fileName);
    const result = await graph(`${scope().phoneNumberId}/media`, {}, form);
    if (!ID.test(str(result.id))) fail("INVALID_MEDIA_RECEIPT", "Meta no confirmó la carga del archivo.", 502);
    return { mediaId: str(result.id) };
  }
  async function mediaMetadata(mediaId: string, received = false) {
    if (!ID.test(mediaId)) fail("INVALID_MEDIA_ID", "El identificador del archivo no es válido.");
    const result = await graph(mediaId, { phone_number_id: scope().phoneNumberId });
    const type = mime(result.mime_type); const rule = received ? receivedMediaRule(type) : mediaRule(type); const size = result.file_size;
    if (result.id !== mediaId || !rule || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > rule.max) fail("UNSUPPORTED_MEDIA", "El archivo de Meta excede los límites o no tiene un formato habilitado.", 415);
    let url: URL;
    try { url = new URL(str(result.url)); } catch { fail("INVALID_MEDIA_URL", "Meta no devolvió una ubicación válida para el archivo.", 502); }
    // Exact host and path; neither user URLs nor redirects can receive the token.
    if (url.protocol !== "https:" || url.hostname !== "lookaside.fbsbx.com" || url.port || url.username || url.password || url.hash || !url.pathname.startsWith("/whatsapp_business/attachments/")) fail("INVALID_MEDIA_URL", "La ubicación del archivo no pertenece al servicio autorizado de Meta.", 502);
    return { url, mimeType: type, size, kind: rule.kind, sha256: mediaHash(result.sha256) };
  }
  async function sendMedia(input: MetaSendInput & { mediaId: string; kind: MetaMediaKind; caption?: string; fileName?: string }, beforeSend: BeforeSend) {
    validateSend(input, beforeSend); const metadata = await mediaMetadata(input.mediaId);
    if (metadata.kind !== input.kind) fail("UNSUPPORTED_MEDIA", "El archivo no corresponde al tipo de mensaje.", 415);
    if (input.caption !== undefined && (typeof input.caption !== "string" || input.caption.length > 1024 || !["image", "video", "document"].includes(input.kind))) fail("INVALID_CAPTION", "La descripción del archivo no es válida.");
    if (input.fileName !== undefined && (input.kind !== "document" || !fileName(input.fileName) || !MIME[metadata.mimeType].extensions.includes(input.fileName.split(".").pop()?.toLowerCase() || ""))) fail("INVALID_MEDIA_NAME", "El nombre del archivo no es válido.");
    return send(input, { type: input.kind, [input.kind]: { id: input.mediaId, ...(input.caption ? { caption: input.caption } : {}), ...(input.fileName ? { filename: input.fileName } : {}) } }, beforeSend);
  }
  async function downloadMedia(input: { mediaId: string; range?: string | null }): Promise<MetaMediaDownload> {
    const cfg = config();
    if (input.range != null && (input.range.length > 100 || !/^bytes=(?:\d+-\d*|-\d+)$/.test(input.range))) fail("INVALID_RANGE", "El rango solicitado no es válido.", 416);
    const metadata = await mediaMetadata(input.mediaId, true);
    const { bytes, response } = await request(metadata.url, { method: "GET", headers: { Authorization: `Bearer ${cfg.token}` } }, Math.min(metadata.size, receivedMediaRule(metadata.mimeType)!.max));
    if (response.status !== 200 || bytes.length !== metadata.size || mime(response.headers.get("content-type")) !== metadata.mimeType) fail("INVALID_MEDIA_CONTENT", "El archivo recibido no coincide con los metadatos de Meta.", 502);
    validateMedia({ bytes, mimeType: metadata.mimeType }, true);
    if (metadata.sha256) {
      const expected = Buffer.from(metadata.sha256, /^[a-f0-9]{64}$/i.test(metadata.sha256) ? "hex" : "base64");
      if (!timingSafeEqual(createHash("sha256").update(bytes).digest(), expected)) fail("INVALID_MEDIA_HASH", "El archivo recibido no pasó la verificación de integridad.", 502);
    }
    if (!input.range) return { bytes, mimeType: metadata.mimeType, totalBytes: bytes.length, status: 200 };
    const [a, b] = input.range.slice(6).split("-");
    const start = a ? Number(a) : Math.max(0, bytes.length - Number(b));
    const end = a ? (b ? Math.min(Number(b), bytes.length - 1) : bytes.length - 1) : bytes.length - 1;
    if (![start, end].every(Number.isSafeInteger) || start >= bytes.length || end < start || (!a && Number(b) === 0)) fail("INVALID_RANGE", "El rango solicitado está fuera del archivo.", 416);
    return { bytes: bytes.slice(start, end + 1), mimeType: metadata.mimeType, totalBytes: bytes.length, status: 206, contentRange: `bytes ${start}-${end}/${bytes.length}` };
  }
  return { status, verifyWebhookChallenge, parseWebhook, verifyConnection, sendText, uploadMedia, sendMedia, downloadMedia, listManualTemplates, prepareTemplateMedia, sendTemplate };
}
