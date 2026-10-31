import { AttentionError, getAttentionAccess, normalizeAttentionPhone } from "@/lib/atencion-core";
import { findAttentionConversationsByPhone } from "@/lib/atencion-storage";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getAttentionAccess();
    const params = new URL(request.url).searchParams, value = params.get("phone");
    if (params.getAll("phone").length !== 1 || [...params.keys()].some(key => key !== "phone") || !value || value.length > 40) {
      throw new AttentionError("Indica un único teléfono válido con indicativo de país.");
    }
    return attentionJson(await findAttentionConversationsByPhone(actor, normalizeAttentionPhone(value)));
  } catch (error) { return attentionHttpError(error); }
}
