import { getAttentionAccess } from "@/lib/atencion-core";
import { attentionHttpError, attentionJson, attentionUuid } from "@/lib/atencion-http";
import { attentionFinancialRuntime } from "@/lib/atencion-financial-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getAttentionAccess(), id = attentionUuid((await context.params).id);
    const { financial } = await attentionFinancialRuntime();
    return attentionJson(await financial.get(actor, id));
  } catch (error) { return attentionHttpError(error); }
}
