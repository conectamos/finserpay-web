import { getAttentionAccess } from "@/lib/atencion-core";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";
import { attentionRealtimeSchemaReady, authorizeAttentionRealtime, createAttentionRealtimeStream, getAttentionRealtimeBroker } from "@/lib/atencion-realtime";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const actor = await getAttentionAccess();
    await authorizeAttentionRealtime(prisma, actor);
    if (!await attentionRealtimeSchemaReady(prisma)) return attentionJson({ error: "La actualización en vivo está pendiente de preparación. La actualización periódica continúa disponible." }, 503);
    const stream = createAttentionRealtimeStream({ actor, signal: request.signal, broker: getAttentionRealtimeBroker(),
      authorize: changes => authorizeAttentionRealtime(prisma, actor, changes) });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store, no-cache, max-age=0, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", Vary: "Cookie",
    } });
  } catch (error) { return attentionHttpError(error); }
}
