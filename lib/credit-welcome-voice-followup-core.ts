export type WelcomeVoiceFollowupPhase = "FAST" | "PENDING" | "CONTACTED" | "STOPPED" | "HELD";
export type WelcomeVoiceFollowupEvent = {
  source: string;
  status: string;
  retryPhase?: "FAST" | "PENDING" | null;
  communicationOutcome?: string | null;
  identityVerifiedAt?: Date | string | null;
  completedAt?: Date | string | null;
  resultCode?: string | null;
};
export type WelcomeVoiceFollowupPlan = {
  phase: WelcomeVoiceFollowupPhase;
  shouldDispatch: boolean;
  nextAttemptAt: string | null;
  pendingSlot: string | null;
  reason: string | null;
};
export type WelcomeVoiceFollowupInput = {
  now: Date;
  phase: WelcomeVoiceFollowupPhase;
  /** Real FAST requests, including the initial call; excludes tests and known-unsent failures. */
  fastAttempts: number;
  /** Server-owned ledger data. Outcomes and completedAt must come from authenticated callbacks. */
  lastEvent?: WelcomeVoiceFollowupEvent | null;
  lastPendingSlot?: string | null;
  holdReason?: string | null;
};

export const WELCOME_VOICE_FAST_ATTEMPTS = 1;
export const WELCOME_VOICE_AUTOMATIC_LIMIT_REASON = "AUTOMATIC_CALL_LIMIT_REACHED";
export const WELCOME_VOICE_PENDING_WINDOW_MS = 10 * 60_000;
const HOURS = [8, 10, 14, 17];
const PHASES = new Set<WelcomeVoiceFollowupPhase>(["FAST", "PENDING", "CONTACTED", "STOPPED", "HELD"]);

function dateMillis(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const calendar = new Date(value.slice(0, 10) + "T12:00:00Z");
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function slotMillis(slot: string | null | undefined): number | null {
  if (typeof slot !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:08|10|14|17):00$/.test(slot)) return null;
  return dateMillis(slot + ":00-05:00");
}

function colombiaDay(time: number): string {
  // Colombia uses UTC-05:00 with no seasonal clock changes.
  return new Date(time - 5 * 60 * 60_000).toISOString().slice(0, 10);
}

function pendingSlots(day: string): Array<{ slot: string; time: number }> {
  return HOURS.map(hour => {
    const slot = day + "T" + String(hour).padStart(2, "0") + ":00";
    return { slot, time: slotMillis(slot)! };
  });
}

/** Current daily contact window only; this does not authorize or claim a contact. */
export function getCreditWelcomeVoicePendingSlot(now: Date): string | null {
  const time = dateMillis(now);
  if (time === null) return null;
  return pendingSlots(colombiaDay(time)).find(slot => slot.time <= time && time < slot.time + WELCOME_VOICE_PENDING_WINDOW_MS)?.slot ?? null;
}

function plan(phase: WelcomeVoiceFollowupPhase, reason: string | null,
  nextAttemptAt: number | null = null, shouldDispatch = false, pendingSlot: string | null = null): WelcomeVoiceFollowupPlan {
  return { phase, shouldDispatch, nextAttemptAt: nextAttemptAt === null ? null : new Date(nextAttemptAt).toISOString(), pendingSlot, reason };
}

/** One initial automatic call only. Terminal or ambiguous outcomes never authorize another. */
export function planCreditWelcomeVoiceFollowup(input: WelcomeVoiceFollowupInput): WelcomeVoiceFollowupPlan {
  const { phase, fastAttempts } = input;
  if (phase === "STOPPED") return plan("STOPPED", "ALREADY_STOPPED");
  const event = input.lastEvent && ["CONTROLLED_TEST", "OPERATOR_REQUEST"].includes(input.lastEvent.source) ? null : input.lastEvent;
  // A recorded refusal takes priority, including a refusal after an earlier conversation.
  if (event?.communicationOutcome === "OPT_OUT" || event?.resultCode === "RECORDING_DECLINED") return plan("STOPPED", "OPT_OUT");
  if (phase === "CONTACTED") return plan("CONTACTED", "ALREADY_CONTACTED");
  const now = dateMillis(input.now);
  // Historical queues may contain the old five-attempt counter. Stop them,
  // rather than treating those persisted counters as a new initial call.
  if (now === null || !PHASES.has(phase) || !Number.isSafeInteger(fastAttempts) || fastAttempts < 0 ||
    (event?.retryPhase != null && !["FAST", "PENDING"].includes(event.retryPhase))) return plan("HELD", "INVALID_STATE");
  if (event?.identityVerifiedAt) {
    const verifiedAt = dateMillis(event.identityVerifiedAt);
    return verifiedAt !== null && verifiedAt <= now ? plan("CONTACTED", "IDENTITY_VERIFIED") : plan("HELD", "INVALID_RESULT_TIME");
  }
  if (event?.communicationOutcome === "HUMAN_CONTACT") return plan("CONTACTED", "HUMAN_CONTACT");
  if (phase === "HELD" && input.holdReason !== "UNKNOWN_CALL") return plan("HELD", input.holdReason ?? "HELD_FOR_REVIEW");
  if (event?.source === "AUTOMATIC_RETRY") return plan("STOPPED", WELCOME_VOICE_AUTOMATIC_LIMIT_REASON);
  // A second worker must not stop the first owner's still-unsent initial claim.
  if (event && ["DISPATCHING", "ACCEPTED"].includes(event.status)) return plan(phase === "PENDING" ? "PENDING" : "FAST", "CALL_IN_FLIGHT");
  if (fastAttempts >= WELCOME_VOICE_FAST_ATTEMPTS) return plan("STOPPED", WELCOME_VOICE_AUTOMATIC_LIMIT_REASON);
  if (!event) return phase === "FAST" ? plan("FAST", "INITIAL_CALL_DUE", now, true) : plan("HELD", "MISSING_RESULT");
  // Reuse an initial event, including a legacy queue with a nonzero event
  // attemptNumber. The store verifies actual prior automatic dispatch evidence.
  if (event.status === "PENDING" && ["NORMAL", "INDIVIDUAL_IMPORT"].includes(event.source)) {
    return plan("FAST", "INITIAL_CALL_DUE", now, true);
  }
  return plan("STOPPED", WELCOME_VOICE_AUTOMATIC_LIMIT_REASON);
}
