import "server-only";
import { AttentionError } from "./atencion-core";
import { AttentionMetaError, createMetaAttentionAdapter, getMetaAttentionScope } from "./atencion-meta";
import { attentionMetaReplyMessage, createAttentionMetaStore } from "./atencion-meta-storage";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDatabase } from "./atencion-storage";
import type { readAttentionMetaReply } from "./atencion-meta-http";

type Adapter = ReturnType<typeof createMetaAttentionAdapter>;
type Store = ReturnType<typeof createAttentionMetaStore>;
type ReplyInput = Awaited<ReturnType<typeof readAttentionMetaReply>>;

/** A request owns one durable outbox lease; an ambiguous provider POST is never repeated. */
export function createAttentionMetaService(store: Store, adapter: Adapter) {
  return {
    async send(actor: AttentionActor, conversationId: string, input: ReplyInput) {
      const queued = await store.queueReply(actor, conversationId, input);
      if (queued.status !== "queued") return { message: attentionMetaReplyMessage(queued), uncertain: ["sending", "uncertain"].includes(queued.status) };
      const claim = await store.claimReply(actor, conversationId, input.requestId);
      let row = claim.reply;
      if (!claim.claimed || !row.leaseToken) return { message: attentionMetaReplyMessage(row), uncertain: ["queued", "sending", "uncertain"].includes(row.status) };
      const leaseToken = row.leaseToken;
      let sendingStarted = false;
      try {
        if (!claim.lastInboundAt) throw new AttentionError("Hace falta un mensaje reciente del contacto para responder.", 409);
        if (row.attachment && !row.uploadedMediaId) {
          if (!input.bytes) throw new AttentionError("Adjunta nuevamente el archivo de este mensaje.", 400);
          const uploaded = await adapter.uploadMedia({ bytes: input.bytes, mimeType: row.attachment.mimeType,
            fileName: row.attachment.fileName || "archivo", kind: row.attachment.kind });
          row = await store.setUploadedMedia(actor, row.id, leaseToken, uploaded.mediaId);
        }
        const beforeSend = async () => { await store.beforeSend(actor, row.id, leaseToken); sendingStarted = true; };
        const send = { recipient: row.contactId, attemptId: row.id, lastInboundAt: claim.lastInboundAt,
          cutoverConfirmed: adapter.status().cutoverConfirmed };
        const receipt = row.attachment
          ? await adapter.sendMedia({ ...send, mediaId: row.uploadedMediaId!, kind: row.attachment.kind,
            ...(row.text ? { caption: row.text } : {}), ...(row.attachment.kind === "document" && row.attachment.fileName ? { fileName: row.attachment.fileName } : {}) }, beforeSend)
          : await adapter.sendText({ ...send, text: row.text }, beforeSend);
        const accepted = await store.acceptReply(row.id, leaseToken, receipt.providerMessageId);
        return { message: attentionMetaReplyMessage(accepted), uncertain: false };
      } catch (error) {
        // A confirmed provider rejection is definitive. A lost response or failed
        // database ACK after the POST stays uncertain until its signed callback.
        const uncertain = error instanceof AttentionMetaError ? error.uncertain : sendingStarted;
        const code = error instanceof AttentionMetaError ? error.code : uncertain ? "ACK_PENDING" : "SEND_PRECONDITION_FAILED";
        const failed = await store.failReply(row.id, leaseToken, { code, uncertain });
        return { message: attentionMetaReplyMessage(failed), uncertain: failed.status === "uncertain" || failed.status === "sending" };
      }
    },
    async find(actor: AttentionActor, conversationId: string, requestId: string) {
      const reply = await store.findReply(actor, conversationId, requestId);
      return { message: reply ? attentionMetaReplyMessage(reply) : null };
    },
    async cancel(actor: AttentionActor, conversationId: string, requestId: string) {
      return store.cancelReply(actor, conversationId, requestId);
    },
    async media(actor: AttentionActor, conversationId: string, messageId: string, range?: string | null) {
      const descriptor = await store.getMedia(actor, conversationId, messageId);
      const result = await adapter.downloadMedia({ mediaId: descriptor.mediaId, range });
      // Re-check assignment after network I/O before returning private bytes.
      const current = await store.getMedia(actor, conversationId, messageId);
      if (current.mediaId !== descriptor.mediaId || current.mimeType !== result.mimeType) throw new AttentionError("El archivo cambió. Actualiza la conversación.", 409);
      return { ...result, fileName: current.fileName, kind: current.kind };
    },
  };
}

export async function attentionMetaRuntime() {
  const adapter = createMetaAttentionAdapter();
  const scope = getMetaAttentionScope();
  if (!scope) throw new AttentionError("La conexión de Meta para Atención está pendiente de configurar.", 503);
  const status = adapter.status();
  const { default: prisma } = await import("./prisma");
  const store = createAttentionMetaStore(prisma as unknown as AttentionDatabase, { scope,
    sendingEnabled: status.canSend, cutoverConfirmed: status.cutoverConfirmed });
  return { adapter, store, service: createAttentionMetaService(store, adapter) };
}
