import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionUuid } from "@/lib/atencion-http";
import { convertAttentionRecording, readAttentionRecording } from "@/lib/atencion-audio";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const { store } = await attentionMetaRuntime();
    const capability = await store.getMessaging(actor, id);
    if (!capability.canReply) throw new AttentionError(capability.reason || "No puedes responder este chat.", 409);
    const bytes = await convertAttentionRecording(await readAttentionRecording(request), request.signal);
    const current = await store.getMessaging(actor, id);
    if (!current.canReply) throw new AttentionError(current.reason || "No puedes responder este chat.", 409);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": "audio/ogg", "Content-Disposition": 'attachment; filename="audio.ogg"',
      "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return attentionHttpError(error); }
}
