import { createHash, timingSafeEqual } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { isMetaBusinessUserId, isMetaPhoneRecipient, metaRecipientPhone } from "./atencion-meta-identity";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const DAPTA_ATTENTION_EVENT_MAX_BYTES = 64 * 1024;
export type DaptaAttentionEventKind = "new_message_sent" | "new_message_received";
export type DaptaEventScope = {
  workspaceId: string; agentId: string; agentChannelId: string;
  phoneNumberId: string; wabaId: string;
};
/** No message body, customer name, document or tool payload is retained here. */
export type DaptaAttentionEvent = DaptaEventScope & {
  event: DaptaAttentionEventKind; deliveryId: string; eventAt: string;
  externalConversationId: string; contactId: string; phone: string | null;
  messageId: string; messageAt: string; fingerprint: string;
};
export class DaptaEventError extends AttentionError {
  constructor(public code: string, status = 400) {
    super("No se pudo validar el evento de Diana.", status);
    this.name = "DaptaEventError";
  }
}
function invalid(code = "DAPTA_EVENT_INVALID", status = 400): never { throw new DaptaEventError(code, status); }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid();
  return value.toLowerCase();
}
export function canonicalDaptaEventContact(value: unknown): string {
  if (isMetaBusinessUserId(value)) return value;
  if (typeof value === "string") {
    const digits = value.startsWith("+") ? value.slice(1) : value;
    if (isMetaPhoneRecipient(digits)) return digits;
  }
  return invalid("DAPTA_EVENT_CONTACT_INVALID");
}
export function daptaEventTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 50 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) return invalid("DAPTA_EVENT_DATE_INVALID");
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return invalid("DAPTA_EVENT_DATE_INVALID");
  return new Date(value).toISOString();
}
export function assertDaptaEventScope(scope: DaptaEventScope) {
  if (!scope || ![scope.workspaceId, scope.agentId, scope.agentChannelId].every(value => typeof value === "string" && UUID.test(value))
      || !/^\d{5,32}$/.test(scope.phoneNumberId) || !/^\d{5,32}$/.test(scope.wabaId)) invalid("DAPTA_EVENT_NOT_CONFIGURED", 503);
}
export function getDaptaEventScope(env: NodeJS.ProcessEnv = process.env): DaptaEventScope | null {
  const scope: DaptaEventScope = {
    workspaceId: env.DAPTA_ATTENTION_WORKSPACE_ID?.trim() || "",
    agentId: env.DAPTA_ATTENTION_AGENT_ID?.trim() || "",
    agentChannelId: env.DAPTA_ATTENTION_AGENT_CHANNEL_ID?.trim() || "",
    phoneNumberId: env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID?.trim() || "",
    wabaId: env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID?.trim() || "",
  };
  try { assertDaptaEventScope(scope); return scope; } catch { return null; }
}
/** Dedicated server-to-server token; never reuse the credit-read or human session token. */
export function assertDaptaEventAuthorization(authorization: string | null, configuredToken: string | undefined) {
  const expected = configuredToken?.trim() || "";
  if (expected.length < 32 || expected.length > 4096 || /\s/.test(expected)) invalid("DAPTA_EVENT_NOT_CONFIGURED", 503);
  const received = /^Bearer ([^\s]+)$/i.exec(authorization || "")?.[1] || "";
  const a = Buffer.from(received), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) invalid("DAPTA_EVENT_UNAUTHORIZED", 401);
}
export function daptaEventFingerprint(event: Omit<DaptaAttentionEvent, "fingerprint"> | DaptaAttentionEvent): string {
  return createHash("sha256").update(JSON.stringify([
    event.event, event.workspaceId, event.agentId, event.agentChannelId, event.phoneNumberId, event.wabaId,
    event.externalConversationId, event.contactId, event.messageId, event.messageAt,
  ])).digest("hex");
}
/** Incoming confirmations are opt-in; neither event kind carries customer text into the queue. */
export function parseDaptaAttentionEvent(value: unknown, scope: DaptaEventScope, now = new Date(), options: { allowInbound?: boolean } = {}): DaptaAttentionEvent {
  assertDaptaEventScope(scope);
  const input = record(value), conversation = record(input?.conversation), message = record(input?.message);
  const metadata = record(conversation?.metadata), attribution = record(record(message?.metadata)?.agent_attribution);
  const inbound = input?.event === "new_message_received";
  if (!input || !conversation || !message || (!inbound && input.event !== "new_message_sent")
      || (inbound && options.allowInbound !== true) || message.direction !== (inbound ? "inbound" : "outbound")
      || message.content_type !== "text" || !(inbound ? ["delivered", "read"] : ["pending", "sent", "delivered", "read"]).includes(String(message.status))) invalid("DAPTA_EVENT_UNSUPPORTED");
  if (input.workspace_id !== scope.workspaceId || input.agent_id !== scope.agentId || input.agent_channel_id !== scope.agentChannelId
      || input.phone_number !== scope.phoneNumberId || conversation.organization_id !== scope.workspaceId
      || conversation.text_agent_id !== scope.agentId || conversation.channel_type !== "meta_whatsapp"
      || metadata?.channel_id !== scope.agentChannelId || metadata.organization_id !== scope.workspaceId
      || metadata.agent_channel_type !== "meta_whatsapp" || (!inbound && attribution?.agent_id !== scope.agentId)
      || (inbound && attribution !== null)) invalid("DAPTA_EVENT_SCOPE_MISMATCH", 403);
  const externalConversationId = uuid(conversation.id), messageId = uuid(message.id);
  if (message.conversation_id !== externalConversationId) invalid("DAPTA_EVENT_SCOPE_MISMATCH", 403);
  const contactId = canonicalDaptaEventContact(conversation.channel_identifier);
  if (canonicalDaptaEventContact(inbound ? message.sender_identifier : message.recipient_identifier) !== contactId
      || (inbound && message.recipient_identifier !== scope.phoneNumberId)) invalid("DAPTA_EVENT_SCOPE_MISMATCH", 403);
  if (typeof input.delivery_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(input.delivery_id)) invalid();
  const eventAt = daptaEventTimestamp(input.created_at), messageAt = daptaEventTimestamp(message.created_at);
  const clock = now.getTime();
  if (!Number.isFinite(clock) || [eventAt, messageAt].some(date => Date.parse(date) < clock - MAX_AGE_MS || Date.parse(date) > clock + FUTURE_SKEW_MS)
      || Date.parse(messageAt) > Date.parse(eventAt) + FUTURE_SKEW_MS) invalid("DAPTA_EVENT_EXPIRED");
  // The event itself is only a wake-up signal. Its text and pending status are
  // not evidence of a delivered response and never enter the queue.
  const event = { ...scope, event: input.event as DaptaAttentionEventKind, deliveryId: input.delivery_id, eventAt,
    externalConversationId, contactId, phone: metaRecipientPhone(contactId), messageId, messageAt };
  return { ...event, fingerprint: daptaEventFingerprint(event) };
}
