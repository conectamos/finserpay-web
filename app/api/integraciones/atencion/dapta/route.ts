import { attentionDaptaEventConfig, attentionDaptaEventRuntime, createAttentionDaptaEventHandler } from "@/lib/atencion-dapta-event-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createAttentionDaptaEventHandler({
  config: attentionDaptaEventConfig,
  ingest: async event => (await attentionDaptaEventRuntime()).store.ingest(event),
});
