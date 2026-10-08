/** Shared, browser-independent rules for welcome-inbox reminders. */
export const WELCOME_ALERT_POLL_MS = 30_000;
export const WELCOME_ALERT_REMINDER_MS = 10 * 60_000;
export const WELCOME_ALERT_SOUND_COOLDOWN_MS = 60_000;

export type WelcomeAlertSummary = {
  pendingCount: number;
  attentionCount: number;
  fingerprint: string;
  href: "/dashboard/aprobaciones";
  checkedAt: string;
};
export type WelcomeAlertReceipt = { fingerprint: string; notifiedAt: number };

function fingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWelcomeAlertSummary(value: unknown): WelcomeAlertSummary | null {
  if (!record(value) || value.ok !== true || !Number.isSafeInteger(value.pendingCount)
    || !Number.isSafeInteger(value.attentionCount) || Number(value.pendingCount) < 0
    || Number(value.attentionCount) < 0 || Number(value.attentionCount) > Number(value.pendingCount)
    || !fingerprint(value.fingerprint) || value.href !== "/dashboard/aprobaciones"
    || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
  return {
    pendingCount: Number(value.pendingCount), attentionCount: Number(value.attentionCount),
    fingerprint: value.fingerprint, href: value.href, checkedAt: value.checkedAt,
  };
}

export function parseWelcomeAlertReceipt(value: unknown): WelcomeAlertReceipt | null {
  if (!record(value) || !fingerprint(value.fingerprint)
    || !Number.isSafeInteger(value.notifiedAt) || Number(value.notifiedAt) < 0) return null;
  return { fingerprint: value.fingerprint, notifiedAt: Number(value.notifiedAt) };
}

/** A changing queue can alert even if its size is unchanged; unchanged work is reminded sparingly. */
export function shouldNotifyWelcome(
  summary: Pick<WelcomeAlertSummary, "attentionCount" | "fingerprint">,
  receipt: WelcomeAlertReceipt | null,
  now: number,
): boolean {
  if (summary.attentionCount < 1 || !Number.isFinite(now)) return false;
  if (!receipt || receipt.notifiedAt > now + WELCOME_ALERT_SOUND_COOLDOWN_MS) return true;
  const elapsed = Math.max(0, now - receipt.notifiedAt);
  return summary.fingerprint !== receipt.fingerprint
    ? elapsed >= WELCOME_ALERT_SOUND_COOLDOWN_MS
    : elapsed >= WELCOME_ALERT_REMINDER_MS;
}
