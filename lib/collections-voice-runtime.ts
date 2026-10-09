import "server-only";
import { createCollectionsVoiceHandlers } from "@/lib/collections-voice-http";
import { collectionsVoiceStore, ensureCollectionsVoiceSchema } from "@/lib/collections-voice-store";

export const collectionsVoiceHandlers = createCollectionsVoiceHandlers({
  flowSecret: () => process.env.FINSERPAY_COLLECTIONS_VOICE_FLOW_TOKEN || "",
  tokenSecret: () => process.env.FINSERPAY_COLLECTIONS_VOICE_TOKEN_SECRET || "",
  agentId: () => process.env.FINSERPAY_COBRANZA_AGENT_ID || "",
  verifyIdentity: async input => { await ensureCollectionsVoiceSchema(); return collectionsVoiceStore.verifyIdentity(input); },
  saveResult: async input => { await ensureCollectionsVoiceSchema(); return collectionsVoiceStore.saveResult(input); },
  recordManagement: async (scope, input) => { await ensureCollectionsVoiceSchema(); return collectionsVoiceStore.recordManagement(scope, input); },
});
