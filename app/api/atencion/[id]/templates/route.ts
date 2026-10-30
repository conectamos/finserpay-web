import { getAttentionAccess } from "@/lib/atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";
import { parseAttentionTemplateIntent } from "@/lib/atencion-meta-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{id: string}> };

export async function GET(_request: Request, context: Context) {
  try {
    const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id);
    const {service}=await attentionMetaRuntime();
    return attentionJson(await service.templates(actor,id));
  } catch(error){return attentionHttpError(error);}
}

export async function POST(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor=await getAttentionAccess(),id=attentionUuid((await context.params).id);
    const {service,store}=await attentionMetaRuntime();
    await store.getTemplateAccess(actor,id);
    const input=parseAttentionTemplateIntent(await readAttentionJson(request));
    const result=await service.sendTemplate(actor,id,input);
    return attentionJson(result,result.uncertain?202:200);
  } catch(error){return attentionHttpError(error);}
}
