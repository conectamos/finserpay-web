import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { saveAttentionQuickReply } from "@/lib/atencion-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionString, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    if (!actor.central) throw new AttentionError("Solo la administración central puede aprobar respuestas rápidas.", 403);
    const body = await readAttentionJson(request);
    await saveAttentionQuickReply(actor, {
      title: attentionString(body.title, "Título", 80),
      text: attentionString(body.text, "Respuesta", 2000), requestId: attentionUuid(body.requestId),
    });
    return attentionJson({ ok: true }, 201);
  } catch (error) { return attentionHttpError(error); }
}
