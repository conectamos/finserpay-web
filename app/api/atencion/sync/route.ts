import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { getAttentionInbox, getAttentionHistoryCursors, importAttentionSnapshots } from "@/lib/atencion-storage";
import { fetchDaptaConversationSnapshots } from "@/lib/atencion-dapta";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionString, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    if (!actor.central) throw new AttentionError("Solo la administración central puede sincronizar Dapta.", 403);
    const body = await readAttentionJson(request);
    const cursor = body.cursor == null ? null : attentionString(body.cursor, "Página de sincronización", 4096);
    const inbox = await getAttentionInbox(actor, { search: "", filter: "all", page: 1 });
    if (!inbox.schemaReady) throw new AttentionError("La preparación de Atención está pendiente. Contacta al administrador.", 503);
    const historyCursors = await getAttentionHistoryCursors(actor);
    const page = await fetchDaptaConversationSnapshots({ cursor, historyCursors });
    const result = await importAttentionSnapshots(actor, page.snapshots);
    return attentionJson({ ...result, skipped: page.skipped, nextCursor: page.nextCursor });
  } catch (error) { return attentionHttpError(error); }
}
