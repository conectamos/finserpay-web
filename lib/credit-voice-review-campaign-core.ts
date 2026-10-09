export type VoiceReviewCampaignConfig = {
  id: string;
  startDate: string;
  creditIds: number[];
};

const TIME_ZONE = "America/Bogota";
export const VOICE_REVIEW_WINDOW_MINUTES = 10;

/** A frozen, explicitly configured cohort; never discover new customers at dispatch time. */
export function getVoiceReviewCampaignConfig(env: Record<string, string | undefined> = process.env): VoiceReviewCampaignConfig | null {
  if (env.DAPTA_VOICE_REVIEW_CAMPAIGN_ENABLED !== "true") return null;
  const raw = env.DAPTA_VOICE_REVIEW_CAMPAIGN_JSON;
  if (!raw || raw.length > 8192) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !["id", "startDate", "creditIds"].includes(key))
      || typeof value.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value.id)
      || typeof value.startDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.startDate)
      || !Array.isArray(value.creditIds) || value.creditIds.length < 1 || value.creditIds.length > 100
      || value.creditIds.some((id: unknown) => !Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > 2_147_483_647)
      || new Set(value.creditIds).size !== value.creditIds.length) return null;
    const day = new Date(`${value.startDate}T12:00:00Z`);
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.startDate) return null;
    return { id: value.id, startDate: value.startDate, creditIds: [...value.creditIds].sort((a: number, b: number) => a - b) };
  } catch { return null; }
}

/** Only the currently open slot is eligible; a restart never replays earlier slots. */
export function getVoiceReviewCampaignSlot(config: VoiceReviewCampaignConfig, now = new Date()): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = `${fields.year}-${fields.month}-${fields.day}`;
  if (date < config.startDate) return null;
  const hours = date === config.startDate ? [8, 10, 14] : [10, 14];
  const hour = Number(fields.hour), minute = Number(fields.minute);
  return hours.includes(hour) && minute >= 0 && minute < VOICE_REVIEW_WINDOW_MINUTES
    ? `${date}T${String(hour).padStart(2, "0")}:00` : null;
}

export type VoiceCampaignResultDecision = "RETRY" | "CONTACTED" | "STOPPED" | "HELD";
export function classifyVoiceCampaignResult(event: {
  status: string;
  resultCode?: string | null;
  identityVerifiedAt?: Date | string | null;
  communicationOutcome?: string | null;
}): VoiceCampaignResultDecision {
  // Acceptance, duration and model terms_confirmed flags are not proof of contact.
  if (!["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"].includes(event.status)) return "HELD";
  if (["CANCELLED", "SKIPPED"].includes(event.status) || event.communicationOutcome === "OPT_OUT"
    || event.resultCode === "RECORDING_DECLINED") return "STOPPED";
  if (event.identityVerifiedAt || event.communicationOutcome === "HUMAN_CONTACT") return "CONTACTED";
  if (event.status === "FAILED" && event.resultCode === "WINDOW_CLOSED_BEFORE_DISPATCH") return "RETRY";
  if (event.communicationOutcome === "NO_ANSWER") return "RETRY";
  return "HELD";
}
