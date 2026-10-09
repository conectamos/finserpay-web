import "server-only";
import { getVoiceReviewCampaignConfig } from "@/lib/credit-voice-review-campaign-core";
import { dispatchCreditWelcomeVoice, getCreditWelcomeVoiceConfig } from "@/lib/credit-welcome-voice-dispatch";
import { createCreditWelcomeVoiceStore, ensureCreditWelcomeVoiceSchema } from "@/lib/credit-welcome-voice-store";

type CampaignDependencies = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  ensureSchema?: typeof ensureCreditWelcomeVoiceSchema;
  store?: ReturnType<typeof createCreditWelcomeVoiceStore>;
  dispatch?: typeof dispatchCreditWelcomeVoice;
};

/** Independent campaign switch: enabling this batch never enables new-credit calls. */
export async function runVoiceReviewCampaign(deps: CampaignDependencies = {}) {
  const env = deps.env ?? process.env;
  const campaign = getVoiceReviewCampaignConfig(env);
  const report = { enabled: Boolean(campaign), configured: false, inWindow: false,
    campaign: campaign?.id ?? null, cohortSize: campaign?.creditIds.length ?? 0,
    selected: 0, accepted: 0, unknown: 0, skipped: 0 };
  if (!campaign) return report;
  const config = getCreditWelcomeVoiceConfig({ ...env, DAPTA_WELCOME_VOICE_ENABLED: "true" });
  if (!config) return report;
  report.configured = true;
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? createCreditWelcomeVoiceStore({ enabled: () => true, now });
  await (deps.ensureSchema ?? ensureCreditWelcomeVoiceSchema)();
  // Persist and verify the immutable cohort even before the first scheduled call.
  await store.ensureVoiceReviewCampaign(campaign);
  const slot = await store.getVoiceReviewCampaignDispatchSlot(campaign.id);
  if (!slot) return report;
  report.inWindow = true;
  const result = await (deps.dispatch ?? dispatchCreditWelcomeVoice)({ limit: 3 }, {
    config,
    ensureSchema: async () => {},
    claim: () => store.claimVoiceReviewCampaign({ campaignId: campaign.id, slot, limit: 3 }),
    prepare: async eventId => {
      // Do not start an external call if a slow claim crossed the window boundary.
      if (await store.getVoiceReviewCampaignDispatchSlot(campaign.id) !== slot) {
        await store.markCreditWelcomeVoiceDispatchFailed(eventId, "WINDOW_CLOSED_BEFORE_DISPATCH");
        return null;
      }
      const prepared = await store.prepareVoiceReviewCampaign(eventId);
      if (prepared && await store.getVoiceReviewCampaignDispatchSlot(campaign.id) !== slot) {
        await store.markCreditWelcomeVoiceDispatchFailed(eventId, "WINDOW_CLOSED_BEFORE_DISPATCH");
        return null;
      }
      return prepared;
    },
    accepted: store.markCreditWelcomeVoiceDispatchAccepted,
    failed: store.markCreditWelcomeVoiceDispatchFailed,
    unknown: store.markCreditWelcomeVoiceDispatchUnknown,
  });
  return { ...report, selected: result.selected, accepted: result.accepted, unknown: result.unknown, skipped: result.skipped };
}
