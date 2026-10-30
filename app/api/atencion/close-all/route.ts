import { getAttentionAccess } from "@/lib/atencion-core";
import { closeAttentionConversations, parseAttentionBulkCloseCutoff, parseAttentionBulkCloseInput, previewAttentionBulkClose } from "@/lib/atencion-bulk-close";
import { assertAttentionOrigin, attentionHttpError, attentionJson, readAttentionJson } from "@/lib/atencion-http";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  try {
    const actor=await getAttentionAccess();
    return attentionJson(await previewAttentionBulkClose(actor,parseAttentionBulkCloseCutoff(new URL(request.url).searchParams)));
  } catch(error) { return attentionHttpError(error); }
}
export async function POST(request:Request) {
  try {
    assertAttentionOrigin(request);
    const actor=await getAttentionAccess();
    return attentionJson(await closeAttentionConversations(actor,parseAttentionBulkCloseInput(await readAttentionJson(request))));
  } catch(error) { return attentionHttpError(error); }
}
