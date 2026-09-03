import {
  buildPadlockFinancialPosition,
  effectivePadlockLockThreshold,
  positionSatisfiesUnlockCondition,
  type PadlockCreditFinancialInput,
  type PadlockFinancialPosition,
  type PadlockUnlockCondition,
} from "@/lib/padlock/finance";

export const PADLOCK_PRODUCT = "IPHONE" as const;
export const PADLOCK_TIME_ZONE = "America/Bogota" as const;
export const PADLOCK_LOCK_DAYS = [5, 20] as const;
export const PADLOCK_LOCK_HOUR = 20;
export const PADLOCK_DEFAULT_MAX_ATTEMPTS = 6;

export type PadlockAction = "LOCK" | "UNLOCK";
export type PadlockDesiredState = "UNKNOWN" | "LOCKED" | "UNLOCKED";
export type PadlockLockCause = "AUTO_MORA" | "MANUAL" | "ROBO" | "FRAUDE";
export type PadlockBindingStatus = "ACTIVE" | "RETIRED";
export type PadlockPolicyScope = "GLOBAL" | "ALLY";
export type PadlockEvaluationTrigger =
  | "LOCK_SCHEDULE"
  | "FINANCIAL_CHANGE"
  | "RECONCILIATION";

export type PadlockProviderAttemptState = {
  status: string;
  providerAttemptCount: number;
  lastProviderAttemptStartedAt: Date | string | null;
  lastProviderAttemptCompletedAt: Date | string | null;
};

export function hasUnresolvedPadlockProviderAttempt(
  input: PadlockProviderAttemptState
) {
  if (
    Number(input.providerAttemptCount || 0) < 1 ||
    !input.lastProviderAttemptStartedAt
  ) {
    return false;
  }
  const startedAt = new Date(input.lastProviderAttemptStartedAt).getTime();
  const completedAt = input.lastProviderAttemptCompletedAt
    ? new Date(input.lastProviderAttemptCompletedAt).getTime()
    : Number.NEGATIVE_INFINITY;
  return Number.isFinite(startedAt) && completedAt < startedAt;
}

export function isPadlockProviderAttemptOpen(
  input: PadlockProviderAttemptState
) {
  return (
    input.status === "PROCESSING" &&
    hasUnresolvedPadlockProviderAttempt(input)
  );
}

export function shouldKeepPadlockProviderAttemptPending(input: {
  providerAttemptCount: number;
  providerTransitionObservedAt?: Date | string | null;
  outcomeKind:
    | "CONFIRMED"
    | "PENDING"
    | "RETRY"
    | "ERROR"
    | "REVIEW"
    | "NOT_ENROLLED";
}) {
  const transitionWasObserved =
    Boolean(input.providerTransitionObservedAt) ||
    (input.outcomeKind === "PENDING" &&
      Number(input.providerAttemptCount || 0) > 0);
  return (
    transitionWasObserved &&
    (input.outcomeKind === "PENDING" || input.outcomeKind === "RETRY")
  );
}

export type PadlockPolicyRevision = {
  id: string;
  scopeType: PadlockPolicyScope;
  allyId: number | null;
  product: typeof PADLOCK_PRODUCT;
  version: number;
  enabled: boolean;
  graceDays: number;
  lockAfterDaysPastDue: number;
  unlockCondition: PadlockUnlockCondition;
};

export type PadlockBindingContext = {
  id: string;
  creditId: number;
  imei: string;
  product: string;
  status: PadlockBindingStatus;
  verifiedAt: Date | string | null;
  desiredState: PadlockDesiredState;
  desiredVersion: number;
  desiredLockCause: PadlockLockCause | null;
  confirmedState: PadlockDesiredState;
  confirmedLockCause: PadlockLockCause | null;
  hasPendingAutoMoraLock: boolean;
  hasUnreconciledAutoMoraLockAttempt: boolean;
  hasActiveMoraBlockExemption: boolean;
  creditTheftLockActive: boolean;
  autoMoraLockDecisionAt: Date | string | null;
  hasConfirmedPaymentAfterAutoMoraLockDecision: boolean;
  creditImei: string;
  creditPlatform: string | null;
  creditLifecycleState: string;
};

export type PadlockEvaluationContext = {
  binding: PadlockBindingContext;
  policy: PadlockPolicyRevision | null;
  financial: PadlockCreditFinancialInput;
};

export type PadlockNoActionReason =
  | "BINDING_NOT_ACTIVE"
  | "BINDING_NOT_VERIFIED"
  | "BINDING_NOT_IPHONE"
  | "BINDING_IMEI_MISMATCH"
  | "CREDIT_NOT_ACTIVE"
  | "POLICY_MISSING"
  | "POLICY_DISABLED"
  | "FINANCIAL_POSITION_INCOMPLETE"
  | "OUTSIDE_LOCK_WINDOW"
  | "LOCK_THRESHOLD_NOT_REACHED"
  | "WAITING_SETTLEMENT"
  | "NO_AUTO_MORA_LOCK_TO_RELEASE"
  | "PROTECTED_LOCK_CAUSE"
  | "THEFT_LOCK_ACTIVE"
  | "ACTIVE_MORA_BLOCK_EXEMPTION"
  | "CONFIRMED_PAYMENT_AFTER_LOCK_REQUIRED"
  | "DESIRED_STATE_ALREADY_SET";

export type PadlockDecision =
  | {
      kind: "NONE";
      reason: PadlockNoActionReason;
      position: PadlockFinancialPosition;
      requiresReview: boolean;
    }
  | {
      kind: "QUEUE";
      action: PadlockAction;
      targetState: Exclude<PadlockDesiredState, "UNKNOWN">;
      reason:
        | "OVERDUE_THRESHOLD_REACHED"
        | "FINANCIAL_POSITION_CURRENT"
        | "ACTIVE_MORA_BLOCK_EXEMPTION_CANCELLED_PENDING_LOCK";
      policyRevisionId: string;
      lockCause: "AUTO_MORA";
      scheduleSlotAt: Date | null;
      position: PadlockFinancialPosition;
    };

export type PadlockDecisionCommitResult =
  | { kind: "ENQUEUED"; commandId: string; desiredVersion: number }
  | { kind: "UNCHANGED"; commandId: string | null; desiredVersion: number }
  | { kind: "STALE"; desiredVersion: number };

export interface PadlockEngineRepository {
  loadEvaluationContext(
    creditId: number,
    effectiveAt?: Date
  ): Promise<PadlockEvaluationContext | null>;
  commitDecision(input: {
    creditId: number;
    bindingId: string;
    expectedDesiredVersion: number;
    trigger: PadlockEvaluationTrigger;
    decision: Extract<PadlockDecision, { kind: "QUEUE" }>;
    evaluatedAt: Date;
    source: string;
    correlationId: string;
  }): Promise<PadlockDecisionCommitResult>;
}

type BogotaClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const bogotaClockFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PADLOCK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function validInstant(value: Date | string) {
  const instant = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new Error("PADLOCK_INVALID_INSTANT");
  }
  return instant;
}

function bogotaClock(value: Date | string): BogotaClock {
  const parts = bogotaClockFormatter.formatToParts(validInstant(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((item) => item.type === type)?.value || 0);

  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function lockSlotInstant(year: number, month: number, day: number) {
  return new Date(
    `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T20:00:00.000-05:00`
  );
}

/**
 * A decision is admitted only during the 20:00 minute. The worker may dispatch
 * a command created in that minute later; startup or reconciliation at 20:01
 * must not create a retroactive lock.
 */
export function padlockLockScheduleSlot(
  value: Date | string = new Date()
): Date | null {
  const clock = bogotaClock(value);
  if (
    !PADLOCK_LOCK_DAYS.includes(clock.day as (typeof PADLOCK_LOCK_DAYS)[number]) ||
    clock.hour !== PADLOCK_LOCK_HOUR ||
    clock.minute !== 0
  ) {
    return null;
  }
  return lockSlotInstant(clock.year, clock.month, clock.day);
}

export function nextPadlockLockScheduleSlot(
  value: Date | string = new Date()
) {
  const instant = validInstant(value);
  const clock = bogotaClock(instant);

  for (let monthOffset = 0; monthOffset < 18; monthOffset += 1) {
    const monthCursor = new Date(Date.UTC(clock.year, clock.month - 1 + monthOffset, 1));
    const year = monthCursor.getUTCFullYear();
    const month = monthCursor.getUTCMonth() + 1;

    for (const day of PADLOCK_LOCK_DAYS) {
      const candidate = lockSlotInstant(year, month, day);
      if (candidate.getTime() > instant.getTime()) return candidate;
    }
  }

  throw new Error("PADLOCK_NEXT_LOCK_SLOT_NOT_FOUND");
}

function inactiveDecision(
  position: PadlockFinancialPosition,
  reason: PadlockNoActionReason,
  requiresReview = false
): PadlockDecision {
  return { kind: "NONE", position, reason, requiresReview };
}

export function decidePadlockAction(input: {
  context: PadlockEvaluationContext;
  trigger: PadlockEvaluationTrigger;
  now?: Date | string;
  lockScheduleSlotAt?: Date | string | null;
  ignoreDesiredState?: boolean;
}): PadlockDecision {
  const now = validInstant(input.now || new Date());
  const { binding, policy } = input.context;
  const position = buildPadlockFinancialPosition(input.context.financial, now);

  if (binding.status !== "ACTIVE") {
    return inactiveDecision(position, "BINDING_NOT_ACTIVE");
  }
  if (!binding.verifiedAt) {
    return inactiveDecision(position, "BINDING_NOT_VERIFIED", true);
  }
  if (
    binding.product !== PADLOCK_PRODUCT ||
    String(binding.creditPlatform || "").trim().toUpperCase() !== PADLOCK_PRODUCT
  ) {
    return inactiveDecision(position, "BINDING_NOT_IPHONE", true);
  }
  if (
    !/^\d{15}$/.test(binding.imei) ||
    binding.imei !== String(binding.creditImei || "").trim()
  ) {
    return inactiveDecision(position, "BINDING_IMEI_MISMATCH", true);
  }
  if (!policy || policy.product !== PADLOCK_PRODUCT) {
    return inactiveDecision(position, "POLICY_MISSING", true);
  }
  if (!position.reliable) {
    return inactiveDecision(position, "FINANCIAL_POSITION_INCOMPLETE", true);
  }

  const hasProtectedLockCause =
    (binding.desiredState === "LOCKED" &&
      binding.desiredLockCause !== null &&
      binding.desiredLockCause !== "AUTO_MORA") ||
    (binding.confirmedState === "LOCKED" &&
      binding.confirmedLockCause !== null &&
      binding.confirmedLockCause !== "AUTO_MORA");
  const isAutoMoraControlled =
    (binding.desiredState === "LOCKED" &&
      binding.desiredLockCause === "AUTO_MORA") ||
    (binding.confirmedState === "LOCKED" &&
      binding.confirmedLockCause === "AUTO_MORA") ||
    binding.hasPendingAutoMoraLock ||
    binding.hasUnreconciledAutoMoraLockAttempt;
  const hasConfirmedAutoMoraLock =
    binding.confirmedState === "LOCKED" &&
    binding.confirmedLockCause === "AUTO_MORA";

  if (binding.creditTheftLockActive) {
    return inactiveDecision(position, "THEFT_LOCK_ACTIVE", true);
  }

  if (positionSatisfiesUnlockCondition(position, policy.unlockCondition)) {
    if (hasProtectedLockCause) {
      return inactiveDecision(position, "PROTECTED_LOCK_CAUSE");
    }
    if (!isAutoMoraControlled) {
      return inactiveDecision(position, "NO_AUTO_MORA_LOCK_TO_RELEASE");
    }
    if (!binding.hasConfirmedPaymentAfterAutoMoraLockDecision) {
      return inactiveDecision(position, "CONFIRMED_PAYMENT_AFTER_LOCK_REQUIRED");
    }
    if (!input.ignoreDesiredState && binding.desiredState === "UNLOCKED") {
      return inactiveDecision(position, "DESIRED_STATE_ALREADY_SET");
    }
    return {
      kind: "QUEUE",
      action: "UNLOCK",
      targetState: "UNLOCKED",
      reason: "FINANCIAL_POSITION_CURRENT",
      policyRevisionId: policy.id,
      lockCause: "AUTO_MORA",
      scheduleSlotAt: null,
      position,
    };
  }

  if (position.state !== "MORA") {
    return inactiveDecision(position, "WAITING_SETTLEMENT");
  }
  if (
    ["ANULADO", "CANCELADO", "CANCELLED"].includes(
      String(binding.creditLifecycleState || "").trim().toUpperCase()
    )
  ) {
    return inactiveDecision(position, "CREDIT_NOT_ACTIVE", true);
  }
  if (hasProtectedLockCause) {
    return inactiveDecision(position, "PROTECTED_LOCK_CAUSE");
  }
  if (binding.hasActiveMoraBlockExemption) {
    if (
      isAutoMoraControlled &&
      !hasConfirmedAutoMoraLock &&
      (input.ignoreDesiredState || binding.desiredState !== "UNLOCKED")
    ) {
      return {
        kind: "QUEUE",
        action: "UNLOCK",
        targetState: "UNLOCKED",
        reason: "ACTIVE_MORA_BLOCK_EXEMPTION_CANCELLED_PENDING_LOCK",
        policyRevisionId: policy.id,
        lockCause: "AUTO_MORA",
        scheduleSlotAt: null,
        position,
      };
    }
    return inactiveDecision(position, "ACTIVE_MORA_BLOCK_EXEMPTION");
  }
  if (!policy.enabled) {
    return inactiveDecision(position, "POLICY_DISABLED");
  }

  const scheduleSlotAt =
    input.trigger === "LOCK_SCHEDULE"
      ? padlockLockScheduleSlot(input.lockScheduleSlotAt || now)
      : null;
  if (!scheduleSlotAt) {
    return inactiveDecision(position, "OUTSIDE_LOCK_WINDOW");
  }

  const threshold = effectivePadlockLockThreshold(policy);
  if (position.daysPastDue < threshold) {
    return inactiveDecision(position, "LOCK_THRESHOLD_NOT_REACHED");
  }
  if (!input.ignoreDesiredState && binding.desiredState === "LOCKED") {
    return inactiveDecision(position, "DESIRED_STATE_ALREADY_SET");
  }

  return {
    kind: "QUEUE",
    action: "LOCK",
    targetState: "LOCKED",
    reason: "OVERDUE_THRESHOLD_REACHED",
    policyRevisionId: policy.id,
    lockCause: "AUTO_MORA",
    scheduleSlotAt,
    position,
  };
}

export function planPadlockCommandMutation(input: {
  currentDesiredState: PadlockDesiredState;
  currentDesiredLockCause: PadlockLockCause | null;
  currentDesiredVersion: number;
  expectedDesiredVersion: number;
  targetState: Exclude<PadlockDesiredState, "UNKNOWN">;
  targetLockCause: PadlockLockCause | null;
  activeCommandIds: string[];
  forceNewVersion?: boolean;
}) {
  if (input.currentDesiredVersion !== input.expectedDesiredVersion) {
    return {
      kind: "STALE" as const,
      desiredVersion: input.currentDesiredVersion,
      supersedeCommandIds: [] as string[],
    };
  }
  if (
    !input.forceNewVersion &&
    input.currentDesiredState === input.targetState &&
    input.currentDesiredLockCause === input.targetLockCause
  ) {
    return {
      kind: "UNCHANGED" as const,
      desiredVersion: input.currentDesiredVersion,
      supersedeCommandIds: [] as string[],
    };
  }
  return {
    kind: "ENQUEUE" as const,
    desiredVersion: input.currentDesiredVersion + 1,
    supersedeCommandIds: [...new Set(input.activeCommandIds)],
  };
}

export async function evaluatePadlockCredit(input: {
  repository: PadlockEngineRepository;
  creditId: number;
  trigger: PadlockEvaluationTrigger;
  source: string;
  correlationId: string;
  now?: Date;
}) {
  const now = validInstant(input.now || new Date());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const context = await input.repository.loadEvaluationContext(input.creditId, now);
    if (!context) {
      return { kind: "NONE" as const, reason: "BINDING_NOT_FOUND" as const };
    }

    const decision = decidePadlockAction({
      context,
      trigger: input.trigger,
      now,
    });
    if (decision.kind === "NONE") return decision;

    const committed = await input.repository.commitDecision({
      creditId: input.creditId,
      bindingId: context.binding.id,
      expectedDesiredVersion: context.binding.desiredVersion,
      trigger: input.trigger,
      decision,
      evaluatedAt: now,
      source: input.source,
      correlationId: input.correlationId,
    });
    if (committed.kind !== "STALE") {
      return { ...committed, decision };
    }
  }

  return { kind: "STALE" as const, reason: "CONCURRENT_DESIRED_STATE_CHANGE" as const };
}

export async function evaluatePadlockCredits(input: {
  repository: PadlockEngineRepository;
  creditIds: number[];
  trigger: PadlockEvaluationTrigger;
  source: string;
  correlationIdForCredit: (creditId: number) => string;
  now?: Date;
}) {
  const results = [];
  for (const creditId of [...new Set(input.creditIds)]) {
    results.push(
      await evaluatePadlockCredit({
        repository: input.repository,
        creditId,
        trigger: input.trigger,
        source: input.source,
        correlationId: input.correlationIdForCredit(creditId),
        now: input.now,
      })
    );
  }
  return results;
}
