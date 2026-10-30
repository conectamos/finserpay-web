import { getAttentionAccess, parseAttentionAgendaFilters } from "@/lib/atencion-core";
import { getAttentionAgenda } from "@/lib/atencion-storage";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getAttentionAccess();
    return attentionJson(await getAttentionAgenda(actor,parseAttentionAgendaFilters(new URL(request.url).searchParams)));
  } catch (error) { return attentionHttpError(error); }
}
