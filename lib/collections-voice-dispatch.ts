import "server-only";
import { COLLECTIONS_VOICE_FROM, createCollectionsVoiceToken, getCollectionsVoiceConfig, getCollectionsVoiceSlot, type CollectionsVoiceConfig } from "@/lib/collections-voice-core";
import { collectionsVoiceStore, ensureCollectionsVoiceSchema, type CollectionsVoiceClaim } from "@/lib/collections-voice-store";
import { welcomeVoiceReceipt } from "@/lib/credit-welcome-voice-dispatch";

export async function runCollectionsVoiceCampaign(deps: { env?: Record<string, string | undefined>; now?: () => Date;
  store?: typeof collectionsVoiceStore; ensureSchema?: typeof ensureCollectionsVoiceSchema; fetcher?: typeof fetch } = {}) {
  const config = getCollectionsVoiceConfig(deps.env), now = deps.now ?? (() => new Date());
  const report = { enabled: Boolean(config), inWindow: false, selected: 0, accepted: 0, unknown: 0, skipped: 0 };
  if (!config) return report;
  const slot = getCollectionsVoiceSlot(config.campaign, now()); if (!slot) return report;
  report.inWindow = true;
  await (deps.ensureSchema ?? ensureCollectionsVoiceSchema)();
  const store = deps.store ?? collectionsVoiceStore;
  if (config.fromNumber !== COLLECTIONS_VOICE_FROM) throw new Error("INVALID_COLLECTIONS_ORIGIN");
  await store.ensureCampaign(config.campaign);
  const claims = await store.claim(config.campaign, slot, 3); report.selected = claims.length;
  for (const claim of claims) {
    const result = await dispatchCollectionsVoiceEvent(claim, config, { store, fetcher: deps.fetcher, now });
    if (result === "ACCEPTED") report.accepted++; else if (result === "SKIPPED") report.skipped++; else report.unknown++;
  }
  return report;
}

/** Server-only controlled callers must obtain a scoped store claim first. */
export async function dispatchCollectionsVoiceEvent(claim: CollectionsVoiceClaim, config: CollectionsVoiceConfig,
  deps: { store?: typeof collectionsVoiceStore; fetcher?: typeof fetch; now?: () => Date } = {}) {
  const store = deps.store ?? collectionsVoiceStore;
  const now = deps.now ?? (() => new Date());
  if (config.fromNumber !== COLLECTIONS_VOICE_FROM) throw new Error("INVALID_COLLECTIONS_ORIGIN");
  const slot = claim.source === "CAMPAIGN" ? getCollectionsVoiceSlot(config.campaign, now()) : null;
  const prepared = await store.prepare(claim.eventId, claim.source === "CAMPAIGN" ? config.campaign : undefined);
  if (!prepared) return "SKIPPED" as const;
  if (prepared.source === "CAMPAIGN" && (!slot || getCollectionsVoiceSlot(config.campaign, now()) !== slot)) {
    await store.windowClosedBeforeDispatch(prepared.eventId); return "SKIPPED" as const;
  }
  const token = createCollectionsVoiceToken(prepared, config.secret, now());
  let callId: string | null = null;
  try {
    const response = await (deps.fetcher ?? fetch)(config.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(20000), cache: "no-store",
      body: JSON.stringify({ event_id: prepared.eventId, credito_id: String(prepared.creditId), event_token: token,
        to_number: `+${prepared.destination}`, from_number: COLLECTIONS_VOICE_FROM, agent_id: config.agentId }) });
    if (response.ok && (!response.headers.get("content-length") || Number(response.headers.get("content-length")) <= 131072)) {
      const value = await response.text();
      if (Buffer.byteLength(value) <= 131072) try { callId = welcomeVoiceReceipt(JSON.parse(value)); } catch { /* Hold uncertain provider receipt. */ }
    }
  } catch { /* A network error can occur after a call was placed. Never redial. */ }
  if (callId) { await store.accepted(claim.eventId, callId); return "ACCEPTED" as const; }
  await store.unknown(claim.eventId); return "UNKNOWN" as const;
}
