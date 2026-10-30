import { getAttentionAccess } from "@/lib/atencion-core";
import { attentionHttpError, attentionUuid } from "@/lib/atencion-http";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
type Context = { params: Promise<{ id: string; messageId: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const actor = await getAttentionAccess();
    const params = await context.params;
    const id = attentionUuid(params.id), messageId = attentionUuid(params.messageId);
    const { service } = await attentionMetaRuntime();
    const media = await service.media(actor, id, messageId, request.headers.get("range"));
    const fileName = encodeURIComponent(media.fileName || `archivo-${messageId}`).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return new Response(Buffer.from(media.bytes), { status: media.status, headers: {
      "Content-Type": media.mimeType, "Content-Length": String(media.bytes.length),
      "Content-Disposition": `${media.kind === "document" ? "attachment" : "inline"}; filename*=UTF-8''${fileName}`,
      "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie, Range", "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer",
      ...(media.contentRange ? { "Content-Range": media.contentRange } : {}),
    } });
  } catch (error) { return attentionHttpError(error); }
}
