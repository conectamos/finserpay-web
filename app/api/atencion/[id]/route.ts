import { getAttentionAccess, parseAttentionMutation } from "@/lib/atencion-core";
import { getAttentionDetail, mutateAttentionConversation } from "@/lib/atencion-storage";
import { attentionReadDetail } from "@/lib/atencion-read-model";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getAttentionAccess();
    const detail = await getAttentionDetail(actor, attentionUuid((await context.params).id));
    return attentionJson(await attentionReadDetail(actor, detail));
  } catch (error) { return attentionHttpError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    await mutateAttentionConversation(actor, id, parseAttentionMutation(await readAttentionJson(request)));
    return attentionJson({ ok: true });
  } catch (error) { return attentionHttpError(error); }
}
