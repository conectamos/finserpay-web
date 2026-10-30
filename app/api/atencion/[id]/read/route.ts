import { getAttentionAccess, parseAttentionRead } from "@/lib/atencion-core";
import { markAttentionRead } from "@/lib/atencion-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    return attentionJson(await markAttentionRead(actor,id,parseAttentionRead(await readAttentionJson(request,{maxBytes:24000}))));
  } catch (error) { return attentionHttpError(error); }
}
