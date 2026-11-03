import "server-only";
import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import type { AttentionActor } from "./atencion-types";
import type { AttentionSavedSticker } from "./atencion-sticker-library";

type SourceInput = { requestId: string; name: string; conversationId: string; messageId: string };
type Dependencies = {
  media: (actor: AttentionActor, conversationId: string, messageId: string) => Promise<{
    bytes: Uint8Array; kind: string; mimeType: string; status: number;
  }>;
  save: (actor: AttentionActor, input: { requestId: string; name: string; content: Uint8Array }) => Promise<AttentionSavedSticker>;
};

export function readAttentionStickerSource(input: Record<string, unknown>): SourceInput {
  if (Object.keys(input).some(key => !["requestId", "name", "conversationId", "messageId"].includes(key))) {
    throw new AttentionError("La solicitud de sticker contiene campos no admitidos.", 400);
  }
  return { requestId: attentionUuid(input.requestId), name: attentionText(input.name, 60),
    conversationId: attentionUuid(input.conversationId), messageId: attentionUuid(input.messageId) };
}

/** Only the authenticated native-media service can supply bytes. No client URL,
 * media ID, MIME, kind or file content is accepted by this endpoint. The service
 * rechecks the source assignment after its network read; save rechecks the actor. */
export async function saveAttentionMessageSticker(actor: AttentionActor, raw: Record<string, unknown>, deps: Dependencies) {
  const input = readAttentionStickerSource(raw);
  const media = await deps.media(actor, input.conversationId, input.messageId);
  if (media.kind !== "sticker" || media.mimeType !== "image/webp" || media.status !== 200) {
    throw new AttentionError("Este mensaje no contiene un sticker de WhatsApp disponible.", 409);
  }
  return deps.save(actor, { requestId: input.requestId, name: input.name, content: media.bytes });
}
