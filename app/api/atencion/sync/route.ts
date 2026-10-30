import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { getAttentionInbox, getAttentionHistoryCursors, importAttentionSnapshots } from "@/lib/atencion-storage";
import { fetchDaptaConversationSnapshots } from "@/lib/atencion-dapta";
import { assertAttentionOrigin, attentionHttpError, attentionId, attentionJson, attentionString, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    if (!actor.central) throw new AttentionError("Solo la administración central puede sincronizar Dapta.", 403);
    const body = await readAttentionJson(request);
    const sedeId = attentionId(body.sedeId);
    const cursor = body.cursor == null ? null : attentionString(body.cursor, "Página de sincronización", 4096);
    const inbox = await getAttentionInbox(actor, { search: "", filter: "all", page: 1 });
    if (!inbox.schemaReady) throw new AttentionError("La preparación de Atención está pendiente. Contacta al administrador.", 503);
    if (!inbox.branches.some(branch => branch.id === sedeId)) throw new AttentionError("Sede no autorizada.", 403);
    const historyCursors = await getAttentionHistoryCursors(actor, sedeId);
    const page = await fetchDaptaConversationSnapshots({ cursor, historyCursors });
    const result = await importAttentionSnapshots(actor, sedeId, page.snapshots);
    return attentionJson({ ...result, skipped: page.skipped, nextCursor: page.nextCursor });
  } catch (error) { return attentionHttpError(error); }
}
