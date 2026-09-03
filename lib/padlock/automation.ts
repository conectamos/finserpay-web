import "server-only";

import { randomUUID } from "node:crypto";

import {
  lockPadlockDevice,
  queryPadlockDeviceByImei,
  unlockPadlockDevice,
} from "@/lib/padlock/client";
import {
  getPadlockRuntimeConfig,
  isPadlockSandboxCreditAllowed,
  resolvePadlockConfig,
} from "@/lib/padlock/config";
import {
  evaluatePadlockCredit,
  padlockLockScheduleSlot,
  type PadlockAction,
  type PadlockEvaluationTrigger,
  type PadlockLockCause,
} from "@/lib/padlock/engine";
import {
  claimPadlockCommands,
  listPadlockEvaluationCreditIds,
  padlockEngineRepository,
  preparePadlockCommandDispatch,
  recordPadlockCommandOutcome,
  type ClaimedPadlockCommand,
  type PadlockProviderOutcome,
  type PreparedPadlockDispatch,
} from "@/lib/padlock/storage";
import type {
  PadlockCommandResult,
  PadlockDevice,
  PadlockRequestOptions,
} from "@/lib/padlock/types";

const PADLOCK_EVALUATION_PAGE_SIZE = 500;
const PADLOCK_MAX_EVALUATION_PAGES = 10_000;
const PADLOCK_CLAIM_LIMIT = 3;
const PADLOCK_LEASE_MS = 600_000;
const DEFAULT_WORKER_ID = `padlock-${randomUUID()}`;

export type PadlockAutomationMode = "SCHEDULED" | "STARTUP";

export type PadlockAutomationGate = {
  enabled: boolean;
  configured: boolean;
  environment: "sandbox" | "production" | "not-configured";
  allowsCredit: (creditId: number) => boolean;
  allowsDevice: (imei: string) => boolean;
};

type PadlockEvaluationInput = {
  creditId: number;
  trigger: PadlockEvaluationTrigger;
  source: string;
  correlationId: string;
  now: Date;
};

type PadlockClaimInput = {
  workerId: string;
  limit: number;
  leaseMs: number;
  now: Date;
};

type PadlockPrepareInput = {
  commandId: string;
  workerId: string;
  leaseToken: string;
  now: Date;
  startProviderAttempt?: boolean;
};

type PadlockOutcomeInput = {
  commandId: string;
  workerId: string;
  leaseToken: string;
  outcome: PadlockProviderOutcome;
  now: Date;
};

export type PadlockAutomationDependencies = {
  now: () => Date;
  newCorrelationId: () => string;
  getGate: () => PadlockAutomationGate;
  listCreditIds: (input: {
    limit: number;
    purpose: "ALL" | "AUTO_UNLOCK";
    afterCreditId?: number;
  }) => Promise<number[]>;
  evaluateCredit: (input: PadlockEvaluationInput) => Promise<unknown>;
  claimCommands: (
    input: PadlockClaimInput
  ) => Promise<ClaimedPadlockCommand[]>;
  prepareDispatch: (
    input: PadlockPrepareInput
  ) => Promise<PreparedPadlockDispatch>;
  recordOutcome: (input: PadlockOutcomeInput) => Promise<unknown>;
  queryDevice: (
    imei: string,
    options?: PadlockRequestOptions
  ) => Promise<PadlockDevice | null>;
  lockDevice: (
    imei: string,
    options?: PadlockRequestOptions
  ) => Promise<PadlockCommandResult>;
  unlockDevice: (
    imei: string,
    options?: PadlockRequestOptions
  ) => Promise<PadlockCommandResult>;
};

export type PadlockAutomationReport = {
  mode: PadlockAutomationMode;
  enabled: boolean;
  configured: boolean;
  lockWindow: boolean;
  creditsSelected: number;
  creditsSkippedByAllowlist: number;
  financialEvaluations: number;
  lockEvaluations: number;
  evaluationErrors: number;
  commandsClaimed: number;
  commandsPrepared: number;
  providerQueries: number;
  providerCommands: number;
  confirmed: number;
  pending: number;
  retries: number;
  errors: number;
  reviewRequired: number;
  supersededOrSkipped: number;
  storageErrors: number;
};

function defaultGate(): PadlockAutomationGate {
  const runtime = getPadlockRuntimeConfig();

  if (!runtime.enabled || !runtime.configured) {
    return {
      enabled: runtime.enabled,
      configured: runtime.configured,
      environment: runtime.environment,
      allowsCredit: () => false,
      allowsDevice: () => false,
    };
  }

  try {
    const config = resolvePadlockConfig();
    return {
      enabled: true,
      configured: true,
      environment: config.environment,
      allowsCredit: (creditId) =>
        isPadlockSandboxCreditAllowed(config, String(creditId)),
      allowsDevice: (imei) =>
        config.environment !== "sandbox" ||
        config.sandboxAllowedDeviceIds.has(imei),
    };
  } catch {
    // Environment values can change between the public runtime check and the
    // strict resolution. Treat that race as unconfigured and do no work.
    return {
      enabled: true,
      configured: false,
      environment: runtime.environment,
      allowsCredit: () => false,
      allowsDevice: () => false,
    };
  }
}

const defaultDependencies: PadlockAutomationDependencies = {
  now: () => new Date(),
  newCorrelationId: () => randomUUID(),
  getGate: defaultGate,
  listCreditIds: listPadlockEvaluationCreditIds,
  evaluateCredit: (input) =>
    evaluatePadlockCredit({
      repository: padlockEngineRepository,
      ...input,
    }),
  claimCommands: claimPadlockCommands,
  prepareDispatch: preparePadlockCommandDispatch,
  recordOutcome: recordPadlockCommandOutcome,
  queryDevice: queryPadlockDeviceByImei,
  lockDevice: lockPadlockDevice,
  unlockDevice: unlockPadlockDevice,
};

function initialReport(
  mode: PadlockAutomationMode,
  gate: PadlockAutomationGate,
  lockWindow: boolean
): PadlockAutomationReport {
  return {
    mode,
    enabled: gate.enabled,
    configured: gate.configured,
    lockWindow,
    creditsSelected: 0,
    creditsSkippedByAllowlist: 0,
    financialEvaluations: 0,
    lockEvaluations: 0,
    evaluationErrors: 0,
    commandsClaimed: 0,
    commandsPrepared: 0,
    providerQueries: 0,
    providerCommands: 0,
    confirmed: 0,
    pending: 0,
    retries: 0,
    errors: 0,
    reviewRequired: 0,
    supersededOrSkipped: 0,
    storageErrors: 0,
  };
}

function safeErrorCode(error: unknown, fallback: string) {
  const value =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]/g, "_")
    .slice(0, 48);
  return normalized || fallback;
}

function providerFailureOutcome(
  error: unknown,
  stage: "QUERY" | "COMMAND" | "POST_QUERY"
): PadlockProviderOutcome {
  const code = safeErrorCode(error, "UNEXPECTED_PROVIDER_ERROR");
  const retryable =
    error && typeof error === "object" && "retryable" in error
      ? (error as { retryable?: unknown }).retryable === true
      : true;
  const prefixedCode = `${stage}_${code}`.slice(0, 64);

  if (
    [
      "AMBIGUOUS_DEVICE",
      "CONFIGURATION_ERROR",
      "INVALID_RESPONSE",
      "PRODUCTION_NOT_ALLOWED",
      "RESPONSE_TOO_LARGE",
      "SANDBOX_DEVICE_NOT_ALLOWED",
      "VALIDATION_ERROR",
    ].includes(code)
  ) {
    return { kind: "REVIEW", errorCode: prefixedCode };
  }

  if (
    retryable ||
    [
      "FEATURE_DISABLED",
      "NETWORK_ERROR",
      "PROVIDER_RATE_LIMITED",
      "PROVIDER_UNAVAILABLE",
      "TIMEOUT",
    ].includes(code)
  ) {
    return { kind: "RETRY", errorCode: prefixedCode };
  }

  return { kind: "ERROR", errorCode: prefixedCode };
}

function providerState(value: PadlockDevice["status"]) {
  switch (value) {
    case "locked":
      return "LOCKED" as const;
    case "unlocked":
      return "UNLOCKED" as const;
    case "locking":
      return "LOCKING" as const;
    case "unlocking":
      return "UNLOCKING" as const;
    case "not_enrolled":
      return "NOT_ENROLLED" as const;
    case "error":
      return "ERROR" as const;
    default:
      return "UNKNOWN" as const;
  }
}

function observedDeviceDecision(
  action: PadlockAction,
  device: PadlockDevice | null,
  command: {
    lockCause: PadlockLockCause | null;
    hadProviderAttempt: boolean;
  }
): { dispatch: boolean; outcome?: PadlockProviderOutcome } {
  if (!device) {
    return {
      dispatch: false,
      outcome: { kind: "REVIEW", errorCode: "DEVICE_NOT_FOUND" },
    };
  }
  if (device.status === "not_enrolled") {
    return {
      dispatch: false,
      outcome: { kind: "NOT_ENROLLED", providerState: "NOT_ENROLLED" },
    };
  }

  const state = providerState(device.status);
  const finalState = action === "LOCK" ? "LOCKED" : "UNLOCKED";
  const transitionState = action === "LOCK" ? "LOCKING" : "UNLOCKING";
  const oppositeTransitionState =
    action === "LOCK" ? "UNLOCKING" : "LOCKING";
  const dispatchableState = action === "LOCK" ? "UNLOCKED" : "LOCKED";

  if (state === finalState) {
    if (
      action === "LOCK" &&
      command.lockCause === "AUTO_MORA" &&
      !command.hadProviderAttempt
    ) {
      return {
        dispatch: false,
        outcome: {
          kind: "REVIEW",
          errorCode: "LOCKED_OBSERVED_WITHOUT_PROVIDER_ATTEMPT",
          providerState: "LOCKED",
        },
      };
    }
    return {
      dispatch: false,
      outcome: {
        kind: "CONFIRMED",
        providerState: finalState,
        confirmationSource: "OBSERVED",
      },
    };
  }
  if (state === transitionState || state === oppositeTransitionState) {
    return {
      dispatch: false,
      outcome: { kind: "PENDING", providerState: state },
    };
  }
  if (state === dispatchableState) {
    return { dispatch: true };
  }

  return {
    dispatch: false,
    outcome: {
      kind: "REVIEW",
      errorCode: `REMOTE_${state}_BLOCKS_${action}`,
      providerState: state,
    },
  };
}

function commandResultOutcome(
  action: PadlockAction,
  result: PadlockCommandResult
): PadlockProviderOutcome {
  const state = providerState(result.status);
  const finalState = action === "LOCK" ? "LOCKED" : "UNLOCKED";
  const transitionState = action === "LOCK" ? "LOCKING" : "UNLOCKING";
  const oppositeTransitionState =
    action === "LOCK" ? "UNLOCKING" : "LOCKING";

  if (state === "NOT_ENROLLED") {
    return { kind: "NOT_ENROLLED", providerState: "NOT_ENROLLED" };
  }
  if (!result.success) {
    return {
      kind: "REVIEW",
      errorCode: "PROVIDER_COMMAND_RESULT_REQUIRES_RECONCILIATION",
      providerState: state,
    };
  }
  if (state === finalState) {
    return {
      kind: "CONFIRMED",
      providerState: finalState,
      confirmationSource: "COMMAND_RESULT",
    };
  }
  if (state === transitionState || state === oppositeTransitionState) {
    // A successful HTTP response only accepted the transition; the next
    // attempt must query the device and prove the terminal state.
    return { kind: "PENDING", providerState: state };
  }

  return {
    kind: "REVIEW",
    errorCode: `COMMAND_RETURNED_${state}_FOR_${action}`,
    providerState: state,
  };
}

function statusFromRecordResult(value: unknown) {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return null;
  }
  const status = String((value as { status?: unknown }).status || "");
  return [
    "CONFIRMED",
    "RETRY",
    "ERROR",
    "REVIEW_REQUIRED",
    "SUPERSEDED",
  ].includes(status)
    ? status
    : null;
}

function countRecordedOutcome(
  report: PadlockAutomationReport,
  result: unknown,
  outcome: PadlockProviderOutcome
) {
  const status = statusFromRecordResult(result);
  if (status === "CONFIRMED") report.confirmed += 1;
  else if (status === "RETRY") report.retries += 1;
  else if (status === "ERROR") report.errors += 1;
  else if (status === "REVIEW_REQUIRED") report.reviewRequired += 1;
  else if (status === "SUPERSEDED") report.supersededOrSkipped += 1;
  else if (outcome.kind === "CONFIRMED") report.confirmed += 1;
  else if (outcome.kind === "PENDING") report.pending += 1;
  else if (outcome.kind === "RETRY") report.retries += 1;
  else if (outcome.kind === "ERROR") report.errors += 1;
  else report.reviewRequired += 1;

  if (status === "RETRY" && outcome.kind === "PENDING") {
    report.pending += 1;
  }
}

async function recordOutcomeSafely(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  command: ClaimedPadlockCommand;
  outcome: PadlockProviderOutcome;
}) {
  try {
    const result = await input.dependencies.recordOutcome({
      commandId: input.command.id,
      workerId: input.command.leaseOwner,
      leaseToken: input.command.leaseToken,
      outcome: input.outcome,
      now: input.dependencies.now(),
    });
    countRecordedOutcome(input.report, result, input.outcome);
  } catch {
    input.report.storageErrors += 1;
  }
}

async function reevaluateAfterDispatch(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  creditId: number;
  source: string;
}) {
  let gate: PadlockAutomationGate;
  try {
    gate = input.dependencies.getGate();
  } catch {
    input.report.evaluationErrors += 1;
    return;
  }
  if (
    !gate.enabled ||
    !gate.configured ||
    !gate.allowsCredit(input.creditId)
  ) {
    return;
  }

  try {
    await input.dependencies.evaluateCredit({
      creditId: input.creditId,
      trigger: "RECONCILIATION",
      source: input.source,
      correlationId: input.dependencies.newCorrelationId(),
      now: input.dependencies.now(),
    });
  } catch {
    input.report.evaluationErrors += 1;
  }
}

async function handleNotReady(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  prepared: Extract<PreparedPadlockDispatch, { ready: false }>;
}) {
  input.report.supersededOrSkipped += 1;
  if (input.prepared.reevaluateCreditId === undefined) return;

  await reevaluateAfterDispatch({
    dependencies: input.dependencies,
    report: input.report,
    creditId: input.prepared.reevaluateCreditId,
    source: "PADLOCK_COMMAND_RECONCILIATION",
  });
}

async function currentCommandGate(
  dependencies: PadlockAutomationDependencies,
  command: ClaimedPadlockCommand,
  imei?: string
): Promise<PadlockProviderOutcome | null> {
  let gate: PadlockAutomationGate;
  try {
    gate = dependencies.getGate();
  } catch {
    return { kind: "RETRY", errorCode: "AUTOMATION_GATE_UNAVAILABLE" };
  }

  if (!gate.enabled) {
    return { kind: "RETRY", errorCode: "FEATURE_DISABLED" };
  }
  if (!gate.configured) {
    return { kind: "REVIEW", errorCode: "CONFIGURATION_ERROR" };
  }
  if (!gate.allowsCredit(command.creditId)) {
    return { kind: "REVIEW", errorCode: "SANDBOX_CREDIT_NOT_ALLOWED" };
  }
  if (imei !== undefined && !gate.allowsDevice(imei)) {
    return { kind: "REVIEW", errorCode: "SANDBOX_DEVICE_NOT_ALLOWED" };
  }
  return null;
}

async function processClaimedCommand(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  command: ClaimedPadlockCommand;
}) {
  const { dependencies, report, command } = input;
  let gateOutcome = await currentCommandGate(dependencies, command);
  if (gateOutcome) {
    await recordOutcomeSafely({ dependencies, report, command, outcome: gateOutcome });
    return;
  }

  let prepared: PreparedPadlockDispatch;
  try {
    prepared = await dependencies.prepareDispatch({
      commandId: command.id,
      workerId: command.leaseOwner,
      leaseToken: command.leaseToken,
      now: dependencies.now(),
    });
  } catch {
    report.storageErrors += 1;
    return;
  }
  if (!prepared.ready) {
    await handleNotReady({ dependencies, report, prepared });
    return;
  }
  report.commandsPrepared += 1;

  gateOutcome = await currentCommandGate(
    dependencies,
    command,
    prepared.command.imei
  );
  if (gateOutcome) {
    await recordOutcomeSafely({ dependencies, report, command, outcome: gateOutcome });
    return;
  }

  let device: PadlockDevice | null;
  try {
    report.providerQueries += 1;
    device = await dependencies.queryDevice(prepared.command.imei, {
      correlationId: prepared.command.correlationId,
    });
  } catch (error) {
    await recordOutcomeSafely({
      dependencies,
      report,
      command,
      outcome: providerFailureOutcome(error, "QUERY"),
    });
    return;
  }

  const observed = observedDeviceDecision(prepared.command.action, device, {
    lockCause: prepared.command.lockCause,
    hadProviderAttempt: prepared.command.hadProviderAttempt,
  });
  if (prepared.command.reconciliationOnly) {
    const reconciliationOutcome: PadlockProviderOutcome = observed.dispatch
      ? {
          // Seeing the old, opposite stable state does not prove that a
          // timed-out POST was rejected. Padlock may still apply it later.
          // Keep the provider-attempt barrier open and never replay the POST;
          // an operator must review it if the target state is never observed.
          kind: "RETRY",
          errorCode: "PROVIDER_ATTEMPT_OUTCOME_UNPROVEN",
          providerState:
            prepared.command.action === "LOCK" ? "UNLOCKED" : "LOCKED",
        }
      : observed.outcome!;
    await recordOutcomeSafely({
      dependencies,
      report,
      command,
      outcome: reconciliationOutcome,
    });
    await reevaluateAfterDispatch({
      dependencies,
      report,
      creditId: prepared.command.creditId,
      source: "PADLOCK_STALE_ATTEMPT_RECONCILIATION",
    });
    return;
  }
  if (!observed.dispatch) {
    await recordOutcomeSafely({
      dependencies,
      report,
      command,
      outcome: observed.outcome!,
    });
    if (prepared.command.action === "LOCK") {
      await reevaluateAfterDispatch({
        dependencies,
        report,
        creditId: prepared.command.creditId,
        source: "PADLOCK_LOCK_OBSERVED_RECONCILIATION",
      });
    }
    return;
  }

  gateOutcome = await currentCommandGate(
    dependencies,
    command,
    prepared.command.imei
  );
  if (gateOutcome) {
    await recordOutcomeSafely({ dependencies, report, command, outcome: gateOutcome });
    return;
  }

  // The provider query can take seconds. Re-read the desired version, binding
  // and official financial position, then durably mark this exact leased
  // attempt immediately before POST.
  let revalidated: PreparedPadlockDispatch;
  try {
    revalidated = await dependencies.prepareDispatch({
      commandId: command.id,
      workerId: command.leaseOwner,
      leaseToken: command.leaseToken,
      now: dependencies.now(),
      startProviderAttempt: true,
    });
  } catch {
    report.storageErrors += 1;
    return;
  }
  if (!revalidated.ready) {
    await handleNotReady({ dependencies, report, prepared: revalidated });
    return;
  }
  if (
    revalidated.command.action !== prepared.command.action ||
    revalidated.command.imei !== prepared.command.imei ||
    revalidated.command.desiredVersion !== prepared.command.desiredVersion
  ) {
    await recordOutcomeSafely({
      dependencies,
      report,
      command,
      outcome: {
        kind: "REVIEW",
        errorCode: "COMMAND_CHANGED_DURING_DISPATCH",
      },
    });
    return;
  }

  let outcome: PadlockProviderOutcome;
  report.providerCommands += 1;
  try {
    const options = { correlationId: revalidated.command.correlationId };
    const result =
      revalidated.command.action === "LOCK"
        ? await dependencies.lockDevice(revalidated.command.imei, options)
        : await dependencies.unlockDevice(revalidated.command.imei, options);
    if (result.success) {
      outcome = commandResultOutcome(revalidated.command.action, result);
    } else {
      // A per-device success=false can still accompany a final-looking status.
      // Prove the remote state with a new GET instead of trusting either field.
      try {
        report.providerQueries += 1;
        const reconciledDevice = await dependencies.queryDevice(
          revalidated.command.imei,
          options
        );
        const reconciled = observedDeviceDecision(
          revalidated.command.action,
          reconciledDevice,
          {
            lockCause: revalidated.command.lockCause,
            hadProviderAttempt: revalidated.command.hadProviderAttempt,
          }
        );
        outcome = reconciled.dispatch
          ? {
              kind: "ERROR",
              errorCode: "PROVIDER_COMMAND_REJECTED",
              providerState: reconciledDevice
                ? providerState(reconciledDevice.status)
                : null,
            }
          : reconciled.outcome!;
      } catch (error) {
        outcome = providerFailureOutcome(error, "POST_QUERY");
      }
    }
  } catch (error) {
    // A timeout or network error is ambiguous: the provider may have accepted
    // the command. We schedule a retry whose next attempt always starts with a
    // device query, never a blind replay.
    outcome = providerFailureOutcome(error, "COMMAND");
  }

  await recordOutcomeSafely({ dependencies, report, command, outcome });

  if (revalidated.command.action === "LOCK") {
    await reevaluateAfterDispatch({
      dependencies,
      report,
      creditId: revalidated.command.creditId,
      source: "PADLOCK_LOCK_DISPATCH_RECONCILIATION",
    });
  }
}

async function evaluateCredits(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  creditIds: number[];
  now: Date;
  trigger: "FINANCIAL_CHANGE" | "LOCK_SCHEDULE";
  source: string;
}) {
  for (const creditId of [...new Set(input.creditIds)]) {
    if (!Number.isSafeInteger(creditId) || creditId <= 0) {
      input.report.evaluationErrors += 1;
      continue;
    }

    let gate: PadlockAutomationGate;
    try {
      gate = input.dependencies.getGate();
    } catch {
      input.report.evaluationErrors += 1;
      continue;
    }
    if (!gate.enabled || !gate.configured) return false;
    if (!gate.allowsCredit(creditId)) {
      input.report.creditsSkippedByAllowlist += 1;
      continue;
    }

    try {
      await input.dependencies.evaluateCredit({
        creditId,
        trigger: input.trigger,
        source: input.source,
        correlationId: input.dependencies.newCorrelationId(),
        now: input.now,
      });
      if (input.trigger === "LOCK_SCHEDULE") {
        input.report.lockEvaluations += 1;
      } else {
        input.report.financialEvaluations += 1;
      }
    } catch {
      input.report.evaluationErrors += 1;
    }
  }
  return true;
}

async function evaluateCreditPages(input: {
  dependencies: PadlockAutomationDependencies;
  report: PadlockAutomationReport;
  now: Date;
  purpose: "ALL" | "AUTO_UNLOCK";
  trigger: "FINANCIAL_CHANGE" | "LOCK_SCHEDULE";
  source: string;
}) {
  const seenCreditIds = new Set<number>();
  let afterCreditId: number | undefined;

  for (let pageNumber = 0; pageNumber < PADLOCK_MAX_EVALUATION_PAGES; pageNumber += 1) {
    let page: number[];
    try {
      page = await input.dependencies.listCreditIds({
        limit: PADLOCK_EVALUATION_PAGE_SIZE,
        purpose: input.purpose,
        afterCreditId,
      });
    } catch {
      input.report.storageErrors += 1;
      return;
    }

    if (!Array.isArray(page)) {
      input.report.storageErrors += 1;
      return;
    }
    if (page.length > PADLOCK_EVALUATION_PAGE_SIZE) {
      input.report.storageErrors += 1;
    }

    const cursorFloor = afterCreditId ?? 0;
    const nextCreditIds: number[] = [];
    let highestCreditId = cursorFloor;
    for (const rawCreditId of page.slice(0, PADLOCK_EVALUATION_PAGE_SIZE)) {
      const creditId = Number(rawCreditId);
      if (!Number.isSafeInteger(creditId) || creditId <= 0) {
        input.report.evaluationErrors += 1;
        continue;
      }
      highestCreditId = Math.max(highestCreditId, creditId);
      if (creditId <= cursorFloor || seenCreditIds.has(creditId)) continue;
      seenCreditIds.add(creditId);
      nextCreditIds.push(creditId);
    }
    input.report.creditsSelected = seenCreditIds.size;

    const keepGoing = await evaluateCredits({
      dependencies: input.dependencies,
      report: input.report,
      creditIds: nextCreditIds,
      now: input.now,
      trigger: input.trigger,
      source: input.source,
    });
    if (!keepGoing) return;

    if (page.length < PADLOCK_EVALUATION_PAGE_SIZE) return;
    if (highestCreditId <= cursorFloor) {
      // A broken/repeated page must never create an infinite loop.
      input.report.storageErrors += 1;
      return;
    }
    afterCreditId = highestCreditId;
  }

  input.report.storageErrors += 1;
}

function resolvedDependencies(
  dependencies?: Partial<PadlockAutomationDependencies>
): PadlockAutomationDependencies {
  return {
    ...defaultDependencies,
    ...dependencies,
  };
}

function resolvedGate(dependencies: PadlockAutomationDependencies) {
  let gate: PadlockAutomationGate;
  try {
    gate = dependencies.getGate();
  } catch {
    gate = {
      enabled: true,
      configured: false,
      environment: "not-configured",
      allowsCredit: () => false,
      allowsDevice: () => false,
    };
  }
  return gate;
}

export async function runPadlockUnlockEvaluationCycle(options: {
  mode?: PadlockAutomationMode;
  dependencies?: Partial<PadlockAutomationDependencies>;
} = {}): Promise<PadlockAutomationReport> {
  const dependencies = resolvedDependencies(options.dependencies);
  const mode = options.mode ?? "SCHEDULED";
  const cycleStartedAt = dependencies.now();
  const gate = resolvedGate(dependencies);
  const report = initialReport(mode, gate, false);

  if (!gate.enabled || !gate.configured) return report;

  await evaluateCreditPages({
    dependencies,
    report,
    now: cycleStartedAt,
    purpose: "AUTO_UNLOCK",
    trigger: "FINANCIAL_CHANGE",
    source: "PADLOCK_PERIODIC_FINANCIAL_EVALUATION",
  });
  return report;
}

export async function runPadlockLockEvaluationCycle(options: {
  dependencies?: Partial<PadlockAutomationDependencies>;
} = {}): Promise<PadlockAutomationReport> {
  const dependencies = resolvedDependencies(options.dependencies);
  const cycleStartedAt = dependencies.now();
  const gate = resolvedGate(dependencies);
  const lockWindow = padlockLockScheduleSlot(cycleStartedAt) !== null;
  const report = initialReport("SCHEDULED", gate, lockWindow);

  if (!gate.enabled || !gate.configured || !lockWindow) return report;

  await evaluateCreditPages({
    dependencies,
    report,
    now: cycleStartedAt,
    purpose: "ALL",
    trigger: "LOCK_SCHEDULE",
    source: "PADLOCK_SCHEDULED_LOCK_EVALUATION",
  });
  return report;
}

/**
 * Processes one bounded outbox batch. Provider I/O happens only after the
 * short prepare transaction has committed and before the outcome transaction.
 */
export async function runPadlockWorkerCycle(options: {
  mode?: PadlockAutomationMode;
  workerId?: string;
  dependencies?: Partial<PadlockAutomationDependencies>;
} = {}): Promise<PadlockAutomationReport> {
  const dependencies = resolvedDependencies(options.dependencies);
  const mode = options.mode ?? "SCHEDULED";
  const gate = resolvedGate(dependencies);
  const report = initialReport(mode, gate, false);

  if (!gate.enabled || !gate.configured) return report;

  let claimed: ClaimedPadlockCommand[] = [];
  try {
    claimed = await dependencies.claimCommands({
      workerId: options.workerId || DEFAULT_WORKER_ID,
      limit: PADLOCK_CLAIM_LIMIT,
      leaseMs: PADLOCK_LEASE_MS,
      now: dependencies.now(),
    });
    report.commandsClaimed = claimed.length;
  } catch {
    report.storageErrors += 1;
    return report;
  }

  // Process a small batch sequentially until Padlock publishes rate limits.
  // A ten-minute lease covers the bounded query + command timeouts per item.
  for (const command of claimed) {
    await processClaimedCommand({ dependencies, report, command });
  }

  return report;
}

function mergedReport(
  mode: PadlockAutomationMode,
  reports: PadlockAutomationReport[]
): PadlockAutomationReport {
  const [first] = reports;
  const merged = initialReport(
    mode,
    {
      enabled: reports.every((report) => report.enabled),
      configured: reports.every((report) => report.configured),
      environment: "not-configured",
      allowsCredit: () => false,
      allowsDevice: () => false,
    },
    reports.some((report) => report.lockWindow)
  );
  if (!first) return merged;

  for (const report of reports) {
    for (const key of [
      "creditsSelected",
      "creditsSkippedByAllowlist",
      "financialEvaluations",
      "lockEvaluations",
      "evaluationErrors",
      "commandsClaimed",
      "commandsPrepared",
      "providerQueries",
      "providerCommands",
      "confirmed",
      "pending",
      "retries",
      "errors",
      "reviewRequired",
      "supersededOrSkipped",
      "storageErrors",
    ] as const) {
      merged[key] += report[key];
    }
  }
  return merged;
}

/** Convenience pass used by tests and explicit invocations, not cron guards. */
export async function runPadlockAutomationCycle(options: {
  mode?: PadlockAutomationMode;
  workerId?: string;
  dependencies?: Partial<PadlockAutomationDependencies>;
} = {}) {
  const mode = options.mode ?? "SCHEDULED";
  const reports = [
    await runPadlockUnlockEvaluationCycle({
      mode,
      dependencies: options.dependencies,
    }),
  ];
  if (mode === "SCHEDULED") {
    reports.push(
      await runPadlockLockEvaluationCycle({
        dependencies: options.dependencies,
      })
    );
  }
  reports.push(
    await runPadlockWorkerCycle({
      mode,
      workerId: options.workerId,
      dependencies: options.dependencies,
    })
  );
  return mergedReport(mode, reports);
}

/** Startup recovery intentionally cannot create a lock for a historical slot. */
export async function runPadlockStartupRecovery(options: {
  workerId?: string;
  dependencies?: Partial<PadlockAutomationDependencies>;
} = {}) {
  return runPadlockAutomationCycle({ ...options, mode: "STARTUP" });
}
