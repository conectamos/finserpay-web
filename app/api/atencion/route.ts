import { getAttentionAccess, parseAttentionFilters } from "@/lib/atencion-core";
import { createAttentionCase, getAttentionInbox } from "@/lib/atencion-storage";
import { attentionReadIntegration } from "@/lib/atencion-read-model";
import { assertAttentionOrigin, attentionHttpError, attentionJson, attentionString, attentionUuid, readAttentionJson } from "@/lib/atencion-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getAttentionAccess();
    const inbox = await getAttentionInbox(actor, parseAttentionFilters(new URL(request.url).searchParams));
    return attentionJson({ ...inbox, integration: await attentionReadIntegration(inbox.schemaReady) });
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
      requestId: attentionUuid(body.requestId),
    });
    return attentionJson(result, 201);
  } catch (error) { return attentionHttpError(error); }
}
