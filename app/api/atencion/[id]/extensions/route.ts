import { getAttentionAccess } from "@/lib/atencion-core";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionUuid, readAttentionJson } from "@/lib/atencion-http";
import { parseAttentionExtension } from "@/lib/atencion-financial-core";
import { attentionFinancialRuntime } from "@/lib/atencion-financial-runtime";
import { syncCreditMoraById } from "@/lib/credit-mora-sync";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess(), id = attentionUuid((await context.params).id);
    const input = parseAttentionExtension(await readAttentionJson(request)), { financial } = await attentionFinancialRuntime();
    const result = await financial.grant(actor, id, input);
    // The financial change is already committed. Provider failures cannot erase approval or audit.
    if (!result.unchanged) {
      try {
        const sync = await syncCreditMoraById(result.extension.creditId, { forceRemoteAudit: true, preventNewMoraBlock: true });
        result.moraSync = { ok: sync.action !== "FAILED", message: sync.message };
      } catch {
        result.moraSync = { ok: false, message: "La prórroga quedó aprobada. La sincronización automática volverá a intentar actualizar el estado del equipo." };
      }
    }
    return attentionJson(result, result.unchanged ? 200 : 201);
  } catch (error) { return attentionHttpError(error); }
}
