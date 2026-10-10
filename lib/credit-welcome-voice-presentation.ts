import type { WelcomeVoiceCallView } from "@/lib/credit-welcome-voice-http";

type CallEvidence = Pick<WelcomeVoiceCallView, "status" | "resultCode"> & {
  communicationOutcome?: string | null;
  disconnectionReason?: string | null;
};
export type WelcomeVoicePresentation = {
  label: string;
  tone: "neutral" | "positive" | "warning" | "danger";
  active: boolean;
};
const activeStates = new Set(["PENDING", "DISPATCHING", "ACCEPTED", "UNKNOWN"]);
const closedStates = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
const callDates = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short",
});

/** Call progress describes contact only; it never establishes welcome completion or identity. */
export function welcomeVoicePresentation(call: CallEvidence): WelcomeVoicePresentation {
  const status = call.status.toUpperCase();
  const outcome = call.communicationOutcome?.toUpperCase();
  const reason = call.disconnectionReason?.toLowerCase();
  const active = activeStates.has(status);
  if (status === "PENDING" || status === "DISPATCHING") return { label: "Solicitada", tone: "warning", active };
  // Provider acceptance starts the call lifecycle, without asserting that a person answered.
  if (status === "ACCEPTED") return { label: "En curso", tone: "warning", active };
  if (status === "UNKNOWN") return { label: "Por confirmar", tone: "warning", active };
  if (status === "CANCELLED") return { label: "Cancelada", tone: "neutral", active };
  if (status === "SKIPPED") return { label: "No realizada", tone: "neutral", active };
  if (call.resultCode === "VOICEMAIL" || reason === "voicemail_reached") {
    return { label: "Buzón de voz", tone: "neutral", active };
  }
  if (["dial_no_answer", "dial_busy"].includes(reason || "") || call.resultCode === "NO_ANSWER") {
    return { label: "Sin respuesta", tone: "neutral", active };
  }
  if (status === "FAILED" || reason === "dial_failed" || reason === "concurrency_limit_reached" || reason?.startsWith("error_")) {
    return { label: "Fallida", tone: "danger", active };
  }
  if (outcome === "HUMAN_CONTACT" || outcome === "OPT_OUT") return { label: "Contestada", tone: "neutral", active };
  if (outcome === "NO_ANSWER") return { label: "Sin respuesta", tone: "neutral", active };
  // A finished provider call without contact evidence could have reached an answering service.
  if (status === "COMPLETED") return { label: "Finalizada", tone: "neutral", active };
  return { label: "Por confirmar", tone: "neutral", active: false };
}

function timestamp(value: string | null | undefined): number {
  const result = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(result) ? result : 0;
}
function observedAt(call: WelcomeVoiceCallView & { updatedAt?: string | null }): number {
  return Math.max(timestamp(call.updatedAt), timestamp(call.completedAt), timestamp(call.dispatchedAt), timestamp(call.createdAt));
}

/** Each event belongs to exactly one credit, and provider updates replace that event's visible row. */
export function orderedWelcomeVoiceCalls(items: readonly WelcomeVoiceCallView[], creditId: number): WelcomeVoiceCallView[] {
  const calls = new Map<string, WelcomeVoiceCallView>();
  for (const item of items) {
    if (item.creditId !== creditId || typeof item.id !== "string" || !item.id) continue;
    const previous = calls.get(item.id);
    if (!previous || observedAt(item) > observedAt(previous)
      || (observedAt(item) === observedAt(previous)
        && (!closedStates.has(previous.status) || closedStates.has(item.status)))) calls.set(item.id, item);
  }
  return [...calls.values()].sort((left, right) =>
    timestamp(right.createdAt) - timestamp(left.createdAt) || right.id.localeCompare(left.id));
}

/** History rows are always capped at ten; all totals use the entire scoped history. */
export function welcomeVoiceHistoryPage<T>(items: readonly T[], requestedPage: number) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / 10));
  const page = Math.min(pageCount, Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1));
  const offset = (page - 1) * 10;
  return { items: items.slice(offset, offset + 10), page, pageCount, total,
    start: total ? offset + 1 : 0, end: Math.min(total, offset + 10) };
}

export function formatWelcomeVoiceCallDate(value: string | null): string {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? callDates.format(date) : "Sin registro";
}

export function formatWelcomeVoiceCallDuration(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "Sin registro";
  const seconds = Math.round(value);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
