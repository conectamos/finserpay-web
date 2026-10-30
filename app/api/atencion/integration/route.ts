import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";
import { createMetaAttentionAdapter } from "@/lib/atencion-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const actor = await getAttentionAccess();
    if (!actor.central) throw new AttentionError("Solo administración central puede revisar la conexión de Meta.", 403);
    const adapter = createMetaAttentionAdapter(), status = adapter.status();
    const connection = status.configured ? await adapter.verifyConnection() : null;
    return attentionJson({ provider: "meta", ...status, connection });
  } catch (error) { return attentionHttpError(error); }
}
