import { getAttentionAccess } from "@/lib/atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid } from "@/lib/atencion-http";
import { readAttentionMetaReply } from "@/lib/atencion-meta-http";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const { service, store } = await attentionMetaRuntime();
    // Verify account and conversation scope before accepting a file into memory.
    await store.getMessaging(actor, id);
    const input = await readAttentionMetaReply(request);
    const result = await service.send(actor, id, input);
    return attentionJson(result, result.uncertain ? 202 : 200);
  } catch (error) { return attentionHttpError(error); }
}

export async function GET(request: Request, context: Context) {
  try {
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const params = new URL(request.url).searchParams;
    if (params.getAll("requestId").length !== 1) return attentionJson({ error: "Identificador de solicitud inválido." }, 400);
    const requestId = attentionUuid(params.get("requestId"));
    const { service } = await attentionMetaRuntime();
    return attentionJson(await service.find(actor, id, requestId));
  } catch (error) { return attentionHttpError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const id = attentionUuid((await context.params).id);
    const params = new URL(request.url).searchParams;
    if (params.getAll("requestId").length !== 1) return attentionJson({ error: "Identificador de solicitud inválido." }, 400);
    const requestId = attentionUuid(params.get("requestId"));
    const { service } = await attentionMetaRuntime();
    // A durable cancellation record blocks a late POST with this request ID.
    return attentionJson(await service.cancel(actor, id, requestId));
  } catch (error) { return attentionHttpError(error); }
}
