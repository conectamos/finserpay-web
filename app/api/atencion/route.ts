import { getAttentionAccess, parseAttentionFilters } from "@/lib/atencion-core";
import { createAttentionCase, getAttentionInbox } from "@/lib/atencion-storage";
import { attentionIntegrationStatus } from "@/lib/atencion-dapta";
import { assertAttentionOrigin, attentionHttpError, attentionId, attentionJson, attentionString, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getAttentionAccess();
    const inbox = await getAttentionInbox(actor, parseAttentionFilters(new URL(request.url).searchParams));
    return attentionJson({ ...inbox, integration: attentionIntegrationStatus() });
  } catch (error) { return attentionHttpError(error); }
}

export async function POST(request: Request) {
  try {
    assertAttentionOrigin(request);
    const actor = await getAttentionAccess();
    const body = await readAttentionJson(request);
    const result = await createAttentionCase(actor, {
      phone: attentionString(body.phone, "Teléfono", 40),
      name: attentionString(body.name, "Nombre", 120),
      sedeId: attentionId(body.sedeId), requestId: attentionUuid(body.requestId),
    });
    return attentionJson(result, 201);
  } catch (error) { return attentionHttpError(error); }
}
