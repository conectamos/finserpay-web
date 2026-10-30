import "server-only";
import { createHash } from "node:crypto";
import { AttentionError } from "./atencion-core";
import { createAttentionFinancialStore } from "./atencion-financial-storage";
import { createMetaAttentionAdapter, getMetaAttentionScope } from "./atencion-meta";
import { attentionMetaReplyMessage, createAttentionMetaStore } from "./atencion-meta-storage";
import { createAttentionMetaService } from "./atencion-meta-service";
import { buildClientPaymentReceiptPdf } from "./client-payment-receipt-pdf";
import type { MetaScope } from "./atencion-meta";
import type { AttentionActor } from "./atencion-types";
import type { AttentionDatabase } from "./atencion-storage";
import type { AttentionReceiptSendInput } from "./atencion-financial-types";

const caption = "Comprobante del último pago registrado en FINSER PAY.";

/** The PDF is built on the server. A retry only reports its existing outbox; it never silently regenerates or sends another receipt. */
export function createAttentionFinancialReceiptSender(database: AttentionDatabase, financial: ReturnType<typeof createAttentionFinancialStore>, adapter = createMetaAttentionAdapter(), settings: { scope?: MetaScope; now?: () => Date; render?: typeof buildClientPaymentReceiptPdf } = {}) {
  return async (actor: AttentionActor, conversationId: string, input: AttentionReceiptSendInput) => {
    const scope = settings.scope || getMetaAttentionScope();
    if (!scope) throw new AttentionError("La conexión de Meta para Atención está pendiente de configurar.", 503);
    const status = adapter.status();
    const store = createAttentionMetaStore(database, { scope, sendingEnabled: status.canSend, cutoverConfirmed: status.cutoverConfirmed, now: settings.now,
      beforeReplySend: (db, currentActor, row) => financial.revalidateReceiptSend(db, currentActor, row, input.creditId, input.paymentId) });
    const prior = await store.findReply(actor, conversationId, input.requestId);
    if (prior) {
      if (prior.conversationVersion !== input.version || prior.attachment?.fileName !== `recibo-pago-${input.creditId}-${input.paymentId}.pdf` || prior.attachment?.kind !== "document" || prior.text !== caption) throw new AttentionError("La solicitud ya corresponde a otro envío.", 409);
      return { message: attentionMetaReplyMessage(prior), uncertain: ["queued", "sending", "uncertain"].includes(prior.status) };
    }
    await store.getMessaging(actor, conversationId);
    const receipt = await financial.receipt(actor, conversationId, input.creditId, input.paymentId, input.version);
    const bytes = new Uint8Array(await (settings.render || buildClientPaymentReceiptPdf)(receipt.pdf));
    return createAttentionMetaService(store, adapter).send(actor, conversationId, { requestId: input.requestId, version: input.version, text: caption, bytes,
      attachment: { kind: "document", fileName: receipt.fileName, mimeType: "application/pdf", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
  };
}
export async function attentionFinancialRuntime() {
  const { default: prisma } = await import("./prisma");
  const database = prisma as unknown as AttentionDatabase;
  const financial = createAttentionFinancialStore(database);
  return { financial, sendReceipt: createAttentionFinancialReceiptSender(database, financial) };
}
