import { getMoraActor } from "@/lib/analyst-mora-access";
import { readApprovalRequest, approvalPrivateHeaders } from "@/lib/credit-approval-http";
import { collectionsVoiceStore, ensureCollectionsVoiceSchema } from "@/lib/collections-voice-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const actor = await getMoraActor();
    if (!actor.centralAdmin) return Response.json({ ok: false, code: "FORBIDDEN" }, { status: 403, headers: approvalPrivateHeaders });
    const data = await readApprovalRequest(request, { maxBytes: 4096 });
    if (!data || typeof data !== "object" || Array.isArray(data)
      || Object.keys(data).some(key => !["creditId", "phone", "sourceType", "sourceReference", "grantedAt"].includes(key))) {
      return Response.json({ ok: false, code: "INVALID_CONSENT" }, { status: 400, headers: approvalPrivateHeaders });
    }
    const input = data as Record<string, unknown>;
    if (typeof input.phone !== "string" || typeof input.sourceType !== "string" || typeof input.sourceReference !== "string" || typeof input.grantedAt !== "string") {
      return Response.json({ ok: false, code: "INVALID_CONSENT" }, { status: 400, headers: approvalPrivateHeaders });
    }
    await ensureCollectionsVoiceSchema();
    const result = await collectionsVoiceStore.recordConsent({ creditId: Number(input.creditId), phone: input.phone,
      sourceType: input.sourceType, sourceReference: input.sourceReference, grantedAt: input.grantedAt }, actor);
    return Response.json({ ok: true, ...result }, { headers: approvalPrivateHeaders });
  } catch { return Response.json({ ok: false, code: "CONSENT_UNAVAILABLE" }, { status: 503, headers: approvalPrivateHeaders }); }
}
