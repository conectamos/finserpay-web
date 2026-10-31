import { AttentionError, getAttentionAccess } from "@/lib/atencion-core";
import { markAttentionTeamRead } from "@/lib/atencion-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const body = await readAttentionJson(request, { maxBytes: 1024 });
    if (Object.keys(body).some(key => !["version", "requestId"].includes(key)) ||
        !Number.isSafeInteger(body.version) || Number(body.version) < 1 || Number(body.version) > 2147483647) {
      throw new AttentionError("Revisa la conversación antes de marcarla como leída.");
    }
    const input = { version: Number(body.version), requestId: attentionUuid(body.requestId) };
    return attentionJson(await markAttentionTeamRead(actor, id, input));
  } catch (error) { return attentionHttpError(error); }
}
