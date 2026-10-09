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

export const WELCOME_VOICE_FAST_ATTEMPTS = 5;
export const WELCOME_VOICE_FAST_INTERVAL_MS = 5 * 60_000;
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

function pendingPlan(now: number, completedAt: number | null, lastPendingSlot: string | null | undefined) {
  const previousSlot = lastPendingSlot == null ? null : slotMillis(lastPendingSlot);
  if (lastPendingSlot != null && previousSlot === null) return plan("HELD", "INVALID_PENDING_SLOT");
  const lowerBound = Math.max(completedAt ?? -Infinity, previousSlot ?? -Infinity);
  const today = colombiaDay(now);
  const slots = pendingSlots(today);
  const open = slots.find(slot => slot.time <= now && now < slot.time + WELCOME_VOICE_PENDING_WINDOW_MS
    && slot.time > lowerBound);
  if (open) return plan("PENDING", "PENDING_SLOT_DUE", open.time, true, open.slot);
  const tomorrow = new Date(new Date(today + "T12:00:00Z").getTime() + 24 * 60 * 60_000).toISOString().slice(0, 10);
  const next = [...slots, ...pendingSlots(tomorrow)].find(slot => slot.time > now && slot.time > lowerBound);
  return next ? plan("PENDING", "WAITING_PENDING_SLOT", next.time, false, next.slot) : plan("HELD", "INVALID_PENDING_SLOT");
}

/** Pure scheduling policy; this never claims events, authenticates callbacks or places calls. */
export function planCreditWelcomeVoiceFollowup(input: WelcomeVoiceFollowupInput): WelcomeVoiceFollowupPlan {
  const { phase, fastAttempts } = input;
  if (phase === "STOPPED") return plan("STOPPED", "ALREADY_STOPPED");
  const event = input.lastEvent?.source === "CONTROLLED_TEST" ? null : input.lastEvent;
  // A recorded refusal takes priority, including a refusal after an earlier conversation.
  if (event?.communicationOutcome === "OPT_OUT" || event?.resultCode === "RECORDING_DECLINED") return plan("STOPPED", "OPT_OUT");
  if (phase === "CONTACTED") return plan("CONTACTED", "ALREADY_CONTACTED");
  const now = dateMillis(input.now);
  if (now === null || !PHASES.has(phase) || !Number.isInteger(fastAttempts) || fastAttempts < 0 || fastAttempts > WELCOME_VOICE_FAST_ATTEMPTS ||
    (event?.retryPhase != null && !["FAST", "PENDING"].includes(event.retryPhase))) return plan("HELD", "INVALID_STATE");
  if (event?.identityVerifiedAt) {
    const verifiedAt = dateMillis(event.identityVerifiedAt);
    return verifiedAt !== null && verifiedAt <= now ? plan("CONTACTED", "IDENTITY_VERIFIED") : plan("HELD", "INVALID_RESULT_TIME");
  }
  if (event?.communicationOutcome === "HUMAN_CONTACT") return plan("CONTACTED", "HUMAN_CONTACT");
  if (phase === "HELD" && input.holdReason !== "UNKNOWN_CALL") return plan("HELD", input.holdReason ?? "HELD_FOR_REVIEW");
  let activePhase: "FAST" | "PENDING" = phase === "PENDING" ? "PENDING" : "FAST";
  if (phase === "HELD") activePhase = event?.retryPhase ?? (input.lastPendingSlot || fastAttempts >= WELCOME_VOICE_FAST_ATTEMPTS ? "PENDING" : "FAST");
  if (!event) return phase === "FAST" && fastAttempts === 0 ? plan("FAST", "INITIAL_CALL_DUE", now, true) : plan("HELD", "MISSING_RESULT");
  if (event.status === "UNKNOWN") return plan("HELD", "UNKNOWN_CALL");
  if (["DISPATCHING", "ACCEPTED"].includes(event.status)) return plan(activePhase, "CALL_IN_FLIGHT");
  if (event.status === "PENDING") {
    // Reuse the existing initial NORMAL/PENDING event; the store must not create another.
    return activePhase === "FAST" && fastAttempts === 0 && ["NORMAL", "INDIVIDUAL_IMPORT"].includes(event.source)
      ? plan("FAST", "INITIAL_CALL_DUE", now, true) : plan(activePhase, "CALL_ALREADY_QUEUED");
  }
  if (["CANCELLED", "SKIPPED"].includes(event.status)) return plan("STOPPED", "EVENT_EXCLUDED");
  if (event.status === "FAILED" && event.resultCode === "WINDOW_CLOSED_BEFORE_DISPATCH") {
    // This local failure proves that no request was made; it is not a sixth call.
    return activePhase === "PENDING" || fastAttempts === WELCOME_VOICE_FAST_ATTEMPTS
      ? pendingPlan(now, null, input.lastPendingSlot) : plan("FAST", "KNOWN_UNSENT", now, true);
  }
  if (!["COMPLETED", "FAILED"].includes(event.status) || event.communicationOutcome !== "NO_ANSWER") return plan("HELD", "UNCERTAIN_RESULT");
  const completedAt = dateMillis(event.completedAt);
  if (completedAt === null || completedAt > now) return plan("HELD", "INVALID_RESULT_TIME");
  if (activePhase === "PENDING" || fastAttempts === WELCOME_VOICE_FAST_ATTEMPTS) return pendingPlan(now, completedAt, input.lastPendingSlot);
  if (fastAttempts < 1) return plan("HELD", "INVALID_ATTEMPT_COUNT");
  const next = completedAt + WELCOME_VOICE_FAST_INTERVAL_MS;
  return plan("FAST", now >= next ? "FAST_RETRY_DUE" : "WAITING_FAST_RETRY", next, now >= next);
}
