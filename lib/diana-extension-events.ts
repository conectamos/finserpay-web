import { isMetaPhoneRecipient, metaRecipientPhone } from "./atencion-meta-identity";
import { assertDaptaEventScope, daptaEventTimestamp, DaptaEventError, type DaptaEventScope } from "./atencion-dapta-events";
import type { DaptaEventJob } from "./atencion-dapta-event-storage";
import type { DaptaConfirmedEventMessageResult } from "./atencion-dapta";
import type { DianaExtensionMessageResult, DianaExtensionVerifiedMessage } from "./diana-extension-types";

type ConfirmedReply = Extract<DaptaConfirmedEventMessageResult, { state: "confirmed" }>;
export type DianaExtensionEventResult = { state: "ignored" | "complete" | "pending"; outcome?: DianaExtensionMessageResult["outcome"] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A code only selects a server proposal. It never authorizes a grant by itself. */
function candidate(text: string, direction: "inbound" | "outbound") {
  if (direction === "inbound") return /^CONFIRMO PR-[A-F0-9]{16}$/.test(text.trim());
  return new Set(text.match(/\bPR-[A-F0-9]{16}\b/g) || []).size === 1;
}

/** Only the worker's exact native identity + live MCP witness may enter the financial store. */
export function createDianaExtensionEventProcessor(deps: {
  scope: DaptaEventScope;
  enabled: () => boolean;
  consume: (proof: DianaExtensionVerifiedMessage) => Promise<DianaExtensionMessageResult>;
  afterGranted?: (creditId: number) => Promise<unknown>;
}) {
  assertDaptaEventScope(deps.scope);
  return async (job: DaptaEventJob, reply: ConfirmedReply, conversationId: string): Promise<DianaExtensionEventResult> => {
    if (!deps.enabled()) return { state: "ignored" };
    const message = reply.message, inbound = job.event === "new_message_received";
    const direction = inbound ? "inbound" : "outbound";
    if (!candidate(message.text, direction)) return { state: "ignored" };
    // Preserve ordinary history imports without turning an opaque profile or a
    // follow-up campaign into authority over a debtor's credit.
    if (!isMetaPhoneRecipient(job.contactId) || (!inbound && reply.verification?.kind === "followup")) return { state: "ignored" };
    if (Object.entries(deps.scope).some(([key, value]) => job[key as keyof DaptaEventScope] !== value)
      || !["new_message_received", "new_message_sent"].includes(job.event) || !UUID.test(conversationId)
      || !UUID.test(job.externalConversationId) || !UUID.test(job.messageId)
      || !isMetaPhoneRecipient(job.contactId) || job.phone !== metaRecipientPhone(job.contactId)
      || reply.source.workspaceId !== job.workspaceId || reply.source.agentId !== job.agentId
      || reply.source.externalConversationId !== job.externalConversationId || reply.source.contactId !== job.contactId
      || reply.verification?.fresh !== true || reply.verification.kind !== (inbound ? "lead" : "agent")
      || message.id !== job.messageId || message.direction !== direction || message.contentType !== "text"
      || !(inbound ? ["delivered", "read"] : ["sent", "delivered", "read"]).includes(message.status)
      || daptaEventTimestamp(message.sentAt) !== daptaEventTimestamp(job.messageAt)) {
      throw new DaptaEventError("DAPTA_EVENT_SCOPE_MISMATCH", 403);
    }
    const proof: DianaExtensionVerifiedMessage = {
      scope: { ...deps.scope }, direction, conversationId,
      externalConversationId: job.externalConversationId, contactId: job.contactId, phone: job.phone!,
      messageId: job.messageId, messageAt: daptaEventTimestamp(message.sentAt), text: message.text, deliveryId: job.deliveryId,
    };
    const result = await deps.consume(proof);
    if (result.outcome === "pending_offer") return { state: "pending", outcome: result.outcome };
    if (["granted", "already_granted"].includes(result.outcome) && Number.isSafeInteger(result.creditId) && result.creditId! > 0) {
      await deps.afterGranted?.(result.creditId!);
    }
    return { state: "complete", outcome: result.outcome };
  };
}
