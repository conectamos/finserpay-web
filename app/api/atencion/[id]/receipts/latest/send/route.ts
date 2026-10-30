import { getAttentionAccess } from "@/lib/atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";
import { parseAttentionReceiptSend } from "@/lib/atencion-financial-core";
import { attentionFinancialRuntime } from "@/lib/atencion-financial-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess(), id = attentionUuid((await context.params).id);
    const input = parseAttentionReceiptSend(await readAttentionJson(request)), { sendReceipt } = await attentionFinancialRuntime();
    const result = await sendReceipt(actor, id, input);
    return attentionJson(result, result.uncertain ? 202 : 200);
  } catch (error) { return attentionHttpError(error); }
}
