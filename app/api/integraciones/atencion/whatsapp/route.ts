import { createMetaAttentionAdapter, META_ATTENTION_MAX_WEBHOOK_BYTES } from "@/lib/atencion-meta";
import { attentionHttpError, attentionJson } from "@/lib/atencion-http";
import { readAttentionBody } from "@/lib/atencion-meta-http";
import { attentionMetaRuntime } from "@/lib/atencion-meta-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const challenge = createMetaAttentionAdapter().verifyWebhookChallenge(new URL(request.url).searchParams);
    return new Response(challenge, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return attentionHttpError(error); }
}

export async function POST(request: Request) {
  try {
    const adapter = createMetaAttentionAdapter();
    const raw = await readAttentionBody(request, META_ATTENTION_MAX_WEBHOOK_BYTES);
    const events = adapter.parseWebhook(raw, request.headers.get("x-hub-signature-256"));
    if (!events.messages.length && !events.statuses.length) return attentionJson({ ok: true });
    const { store } = await attentionMetaRuntime();
    await store.ingest(events);
    return attentionJson({ ok: true });
  } catch (error) { return attentionHttpError(error); }
}
