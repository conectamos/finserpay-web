import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { attentionJson, attentionHttpError, assertAttentionOrigin, readAttentionJson } from "@/lib/atencion-http";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";
import { attentionStickerLibrary } from "@/lib/atencion-sticker-library";
import { saveAttentionMessageSticker } from "@/lib/atencion-sticker-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const input = await readAttentionJson(request, { maxBytes: 1024 });
    const [{ service, store }, library] = await Promise.all([attentionMetaRuntime(), attentionStickerLibrary()]);
    const sticker = await saveAttentionMessageSticker(actor, input, { media: async (who, conversationId, messageId) => {
      const source = await store.getMedia(who, conversationId, messageId);
      if (source.kind !== "sticker" || source.mimeType !== "image/webp") throw new AttentionError("Este mensaje no contiene un sticker de WhatsApp disponible.", 409);
      return service.media(who, conversationId, messageId);
    }, save: library.save });
    return attentionJson({ sticker });
  } catch (error) { return attentionHttpError(error); }
}
