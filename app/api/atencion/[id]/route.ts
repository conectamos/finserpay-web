import { getAttentionAccess, parseAttentionMutation } from "@/lib/atencion-core";
import { getAttentionDetail, mutateAttentionConversation } from "@/lib/atencion-storage";
import { attentionReadDetail } from "@/lib/atencion-read-model";
import { attentionWorkStore } from "@/lib/atencion-work-storage";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor = await getAttentionAccess();
    const detail = await getAttentionDetail(actor, attentionUuid((await context.params).id));
    if(detail.conversation.channel === "internal"){
      const work=await(await attentionWorkStore()).forConversation({type:"attention",actor},detail.conversation.id);
      if(work)return attentionJson({...detail,messages:work.messages,historyTruncated:work.historyTruncated,
        workRequest:{id:work.item.id,kind:work.item.kind,state:work.item.state,advisor:work.item.advisor,ally:work.item.ally,target:work.item.target},
        permissions:{manage:false,claim:false,assign:false,canSend:false}});
    }
    return attentionJson(await attentionReadDetail(actor, detail));
  } catch (error) { return attentionHttpError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const work=await(await attentionWorkStore()).forConversation({type:"attention",actor},id);
    if(work)return attentionJson({error:"Gestiona esta solicitud desde su bandeja de Enrolamientos o Aprobaciones."},409);
    await mutateAttentionConversation(actor, id, parseAttentionMutation(await readAttentionJson(request)));
    return attentionJson({ ok: true });
  } catch (error) { return attentionHttpError(error); }
}
