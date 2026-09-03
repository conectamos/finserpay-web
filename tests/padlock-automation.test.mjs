import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
    "server-only": require.resolve("next/dist/compiled/server-only/empty"),
  },
});
const {
  runPadlockAutomationCycle,
  runPadlockLockEvaluationCycle,
  runPadlockStartupRecovery,
  runPadlockUnlockEvaluationCycle,
} = await jiti.import("../lib/padlock/automation.ts");
const { canStartInternalCronTask } = await jiti.import(
  "../lib/internal-cron.ts"
);

const imei = "356938035643809";
const scheduledAt = new Date("2026-09-06T01:00:30.000Z");
const outsideWindow = new Date("2026-09-06T00:59:59.000Z");

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function activeGate(overrides = {}) {
  return {
    enabled: true,
    configured: true,
    environment: "sandbox",
    allowsCredit: () => true,
    allowsDevice: () => true,
    ...overrides,
  };
}

function device(status) {
  return {
    brand: "Apple",
    createdAt: null,
    identifier: imei,
    key1: imei,
    key2: null,
    model: "iPhone fixture",
    serial: null,
    status,
    transitionStartedAt: null,
    updatedAt: null,
  };
}

function claimedCommand(action = "LOCK") {
  return {
    id: uuid(1),
    bindingId: uuid(2),
    creditId: 42,
    action,
    desiredVersion: 3,
    attemptCount: 1,
    maxAttempts: 6,
    leaseOwner: "padlock-test-worker",
    leaseToken: uuid(3),
    leaseExpiresAt: new Date("2026-09-06T01:10:00.000Z"),
  };
}

function readyDispatch(action = "LOCK", hadProviderAttempt = false) {
  return {
    ready: true,
    command: {
      id: uuid(1),
      creditId: 42,
      bindingId: uuid(2),
      imei,
      action,
      lockCause: action === "LOCK" ? "AUTO_MORA" : null,
      desiredVersion: 3,
      idempotencyKey: `fixture-${action.toLowerCase()}`,
      correlationId: uuid(4),
      attemptCount: 1,
      hadProviderAttempt,
      reconciliationOnly: false,
      maxAttempts: 6,
      leaseOwner: "padlock-test-worker",
      leaseToken: uuid(3),
    },
  };
}

function commandResult(action, status, success = true) {
  return {
    action,
    brand: "Apple",
    message: null,
    model: "iPhone fixture",
    requestedDevice: imei,
    status,
    success,
  };
}

function recordedStatus(outcome) {
  if (outcome.kind === "CONFIRMED") return "CONFIRMED";
  if (outcome.kind === "PENDING" || outcome.kind === "RETRY") return "RETRY";
  if (outcome.kind === "ERROR") return "ERROR";
  return "REVIEW_REQUIRED";
}

function harness(options = {}) {
  const calls = {
    claims: [],
    evaluations: [],
    lists: [],
    locks: [],
    outcomes: [],
    prepares: [],
    queries: [],
    unlocks: [],
  };
  let correlationSequence = 10;
  let prepareIndex = 0;
  let providerAttemptStarted = Boolean(options.hadProviderAttempt);
  const preparedValues = options.preparedValues || [
    readyDispatch(options.action || "LOCK"),
  ];
  const now = options.now || scheduledAt;
  const commands =
    options.commands === undefined
      ? options.withCommand
        ? [claimedCommand(options.action || "LOCK")]
        : []
      : options.commands;

  const dependencies = {
    now: () => now,
    newCorrelationId: () => uuid(correlationSequence++),
    getGate: () => options.gate || activeGate(),
    listCreditIds: async (input) => {
      calls.lists.push(input);
      return options.creditIds || [];
    },
    evaluateCredit: async (input) => {
      calls.evaluations.push(input);
      if (options.evaluationError) throw new Error("fixture evaluation failure");
      return { kind: "UNCHANGED" };
    },
    claimCommands: async (input) => {
      calls.claims.push(input);
      return commands;
    },
    prepareDispatch: async (input) => {
      calls.prepares.push(input);
      const value =
        preparedValues[Math.min(prepareIndex, preparedValues.length - 1)];
      prepareIndex += 1;
      if (!value.ready) return value;
      const hadProviderAttempt =
        providerAttemptStarted || Boolean(value.command.hadProviderAttempt);
      if (input.startProviderAttempt === true) {
        providerAttemptStarted = true;
      }
      return {
        ...value,
        command: {
          ...value.command,
          hadProviderAttempt:
            hadProviderAttempt || input.startProviderAttempt === true,
        },
      };
    },
    recordOutcome: async (input) => {
      calls.outcomes.push(input);
      return { status: recordedStatus(input.outcome), stale: false };
    },
    queryDevice: async (queriedImei, requestOptions) => {
      calls.queries.push({ imei: queriedImei, options: requestOptions });
      if (options.queryError) throw options.queryError;
      if (options.queryDevice) return options.queryDevice();
      return device(options.remoteStatus || "unlocked");
    },
    lockDevice: async (lockedImei, requestOptions) => {
      calls.locks.push({ imei: lockedImei, options: requestOptions });
      if (options.lockError) throw options.lockError;
      return commandResult("LOCK", options.commandStatus || "locking");
    },
    unlockDevice: async (unlockedImei, requestOptions) => {
      calls.unlocks.push({ imei: unlockedImei, options: requestOptions });
      if (options.unlockError) throw options.unlockError;
      return commandResult("UNLOCK", options.commandStatus || "unlocking");
    },
  };

  return { calls, dependencies };
}

test("el interruptor general corta evaluacion, outbox y proveedor", async () => {
  const fixture = harness({
    creditIds: [42],
    gate: activeGate({ enabled: false, configured: false }),
    withCommand: true,
  });

  const report = await runPadlockAutomationCycle({
    dependencies: fixture.dependencies,
    workerId: "padlock-test-worker",
  });

  assert.equal(report.enabled, false);
  assert.equal(fixture.calls.claims.length, 0);
  assert.equal(fixture.calls.evaluations.length, 0);
  assert.equal(fixture.calls.queries.length, 0);
  assert.equal(fixture.calls.locks.length, 0);
});

test("solo abre la evaluacion LOCK a las 20:00 Bogota de los dias 5 y 20", async () => {
  const atCutoff = harness({ creditIds: [42], now: scheduledAt });
  const cutoffReport = await runPadlockAutomationCycle({
    dependencies: atCutoff.dependencies,
  });

  assert.equal(cutoffReport.lockWindow, true);
  assert.deepEqual(
    atCutoff.calls.evaluations.map((item) => item.trigger),
    ["FINANCIAL_CHANGE", "LOCK_SCHEDULE"]
  );
  assert.deepEqual(
    atCutoff.calls.lists.map((item) => item.purpose),
    ["AUTO_UNLOCK", "ALL"]
  );

  const beforeCutoff = harness({ creditIds: [42], now: outsideWindow });
  const beforeReport = await runPadlockAutomationCycle({
    dependencies: beforeCutoff.dependencies,
  });

  assert.equal(beforeReport.lockWindow, false);
  assert.deepEqual(
    beforeCutoff.calls.evaluations.map((item) => item.trigger),
    ["FINANCIAL_CHANGE"]
  );
  assert.deepEqual(
    beforeCutoff.calls.lists.map((item) => item.purpose),
    ["AUTO_UNLOCK"]
  );
});

test("el arranque evalua unlock pero nunca crea LOCK retroactivo", async () => {
  const fixture = harness({ creditIds: [42], now: scheduledAt });

  const report = await runPadlockStartupRecovery({
    dependencies: fixture.dependencies,
  });

  assert.equal(report.mode, "STARTUP");
  assert.equal(report.lockWindow, false);
  assert.deepEqual(
    fixture.calls.evaluations.map((item) => item.trigger),
    ["FINANCIAL_CHANGE"]
  );
  assert.deepEqual(fixture.calls.lists.map((item) => item.purpose), [
    "AUTO_UNLOCK",
  ]);
});

test("recorre una segunda pagina keyset sin cambiar el instante financiero", async () => {
  const firstPage = Array.from({ length: 500 }, (_, index) => index + 1);
  const fixture = harness({ now: outsideWindow });
  fixture.dependencies.listCreditIds = async (input) => {
    fixture.calls.lists.push(input);
    return input.afterCreditId === undefined ? firstPage : [501];
  };

  const report = await runPadlockUnlockEvaluationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(report.creditsSelected, 501);
  assert.equal(report.financialEvaluations, 501);
  assert.deepEqual(
    fixture.calls.lists.map((input) => input.afterCreditId),
    [undefined, 500]
  );
  assert.ok(fixture.calls.lists.every((input) => input.purpose === "AUTO_UNLOCK"));
  assert.ok(
    fixture.calls.evaluations.every(
      (input) => input.now.getTime() === outsideWindow.getTime()
    )
  );
});

test("corta una pagina keyset repetida y no reevalua creditos duplicados", async () => {
  const repeatedPage = Array.from({ length: 500 }, (_, index) => index + 1);
  const fixture = harness({ now: outsideWindow });
  fixture.dependencies.listCreditIds = async (input) => {
    fixture.calls.lists.push(input);
    return repeatedPage;
  };

  const report = await runPadlockUnlockEvaluationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(fixture.calls.lists.length, 2);
  assert.equal(report.financialEvaluations, 500);
  assert.equal(report.storageErrors, 1);
});

test("el evaluador de corte 20:00 inicia aunque un worker anterior siga activo", async () => {
  const running = new Set(["padlock-worker"]);

  const mayEvaluate = canStartInternalCronTask(
    running,
    "padlock-lock-evaluate"
  );
  assert.equal(mayEvaluate, true);
  assert.equal(
    canStartInternalCronTask(running, "padlock-unlock-evaluate"),
    true
  );
  assert.equal(canStartInternalCronTask(running, "padlock-worker"), false);

  const fixture = harness({ creditIds: [42], now: scheduledAt });
  const report = mayEvaluate
    ? await runPadlockLockEvaluationCycle({ dependencies: fixture.dependencies })
    : null;
  assert.equal(report?.lockWindow, true);
  assert.deepEqual(
    fixture.calls.evaluations.map((input) => input.trigger),
    ["LOCK_SCHEDULE"]
  );
});

test("aplica la allowlist de credito antes de evaluar o consultar Padlock", async () => {
  const fixture = harness({
    creditIds: [42],
    gate: activeGate({ allowsCredit: () => false }),
    now: outsideWindow,
    withCommand: true,
  });

  const report = await runPadlockAutomationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(report.creditsSkippedByAllowlist, 1);
  assert.equal(fixture.calls.evaluations.length, 0);
  assert.equal(fixture.calls.prepares.length, 0);
  assert.equal(fixture.calls.queries.length, 0);
  assert.equal(fixture.calls.outcomes[0].outcome.kind, "REVIEW");
  assert.equal(
    fixture.calls.outcomes[0].outcome.errorCode,
    "SANDBOX_CREDIT_NOT_ALLOWED"
  );
});

test("confirma por consulta si el IMEI ya esta bloqueado y no repite POST", async () => {
  const fixture = harness({
    hadProviderAttempt: true,
    remoteStatus: "locked",
    withCommand: true,
  });

  const report = await runPadlockAutomationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(fixture.calls.queries.length, 1);
  assert.equal(fixture.calls.locks.length, 0);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "CONFIRMED",
    providerState: "LOCKED",
    confirmationSource: "OBSERVED",
  });
  assert.equal(report.confirmed, 1);
  assert.ok(
    fixture.calls.evaluations.some((item) => item.trigger === "RECONCILIATION")
  );
});

test("un LOCK AUTO_MORA observado locked sin POST previo exige revision", async () => {
  const fixture = harness({
    remoteStatus: "locked",
    withCommand: true,
  });

  const report = await runPadlockAutomationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(fixture.calls.locks.length, 0);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "REVIEW",
    errorCode: "LOCKED_OBSERVED_WITHOUT_PROVIDER_ATTEMPT",
    providerState: "LOCKED",
  });
  assert.equal(report.reviewRequired, 1);
});

test("las transiciones remotas quedan pendientes y se concilian sin POST", async () => {
  const sameTransition = harness({
    remoteStatus: "locking",
    withCommand: true,
  });
  await runPadlockAutomationCycle({ dependencies: sameTransition.dependencies });
  assert.equal(sameTransition.calls.locks.length, 0);
  assert.deepEqual(sameTransition.calls.outcomes[0].outcome, {
    kind: "PENDING",
    providerState: "LOCKING",
  });

  const oppositeTransition = harness({
    remoteStatus: "unlocking",
    withCommand: true,
  });
  await runPadlockAutomationCycle({
    dependencies: oppositeTransition.dependencies,
  });
  assert.equal(oppositeTransition.calls.locks.length, 0);
  assert.deepEqual(oppositeTransition.calls.outcomes[0].outcome, {
    kind: "PENDING",
    providerState: "UNLOCKING",
  });
});

test("pago que pide UNLOCK mientras remoto LOCKING conserva la compensacion", async () => {
  let queryCount = 0;
  const fixture = harness({ action: "UNLOCK", withCommand: true });
  fixture.dependencies.queryDevice = async (queriedImei, requestOptions) => {
    fixture.calls.queries.push({ imei: queriedImei, options: requestOptions });
    queryCount += 1;
    return device(queryCount === 1 ? "locking" : "locked");
  };

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });
  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.unlocks.length, 1);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "PENDING",
    providerState: "LOCKING",
  });
  assert.deepEqual(fixture.calls.outcomes[1].outcome, {
    kind: "PENDING",
    providerState: "UNLOCKING",
  });
});

test("not_enrolled, unknown y error fallan cerrados sin enviar comandos", async () => {
  for (const remoteStatus of ["not_enrolled", "unknown", "error"]) {
    const fixture = harness({ remoteStatus, withCommand: true });
    await runPadlockAutomationCycle({ dependencies: fixture.dependencies });
    assert.equal(fixture.calls.locks.length, 0);
    assert.ok(
      ["NOT_ENROLLED", "REVIEW"].includes(
        fixture.calls.outcomes[0].outcome.kind
      )
    );
  }
});

test("una busqueda exacta sin coincidencia requiere revision, no finge not_enrolled", async () => {
  const fixture = harness({
    queryDevice: () => null,
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.locks.length, 0);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "REVIEW",
    errorCode: "DEVICE_NOT_FOUND",
  });
});

test("aplica la allowlist de IMEI antes de cualquier consulta remota", async () => {
  const fixture = harness({
    gate: activeGate({ allowsDevice: () => false }),
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.prepares.length, 1);
  assert.equal(fixture.calls.queries.length, 0);
  assert.equal(fixture.calls.outcomes[0].outcome.kind, "REVIEW");
  assert.equal(
    fixture.calls.outcomes[0].outcome.errorCode,
    "SANDBOX_DEVICE_NOT_ALLOWED"
  );
});

test("revalida despues del GET y no hace POST si finanzas cambiaron", async () => {
  const fixture = harness({
    preparedValues: [
      readyDispatch("LOCK"),
      {
        ready: false,
        code: "COMMAND_NO_LONGER_ELIGIBLE",
        reevaluateCreditId: 42,
      },
    ],
    remoteStatus: "unlocked",
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.prepares.length, 2);
  assert.equal(fixture.calls.prepares[0].startProviderAttempt, undefined);
  assert.equal(fixture.calls.prepares[1].startProviderAttempt, true);
  assert.equal(fixture.calls.locks.length, 0);
  assert.ok(
    fixture.calls.evaluations.some((item) => item.trigger === "RECONCILIATION")
  );
});

test("un HTTP 200 locking no confirma y reevalua una compensacion", async () => {
  const fixture = harness({
    commandStatus: "locking",
    remoteStatus: "unlocked",
    withCommand: true,
  });

  const report = await runPadlockAutomationCycle({
    dependencies: fixture.dependencies,
  });

  assert.equal(fixture.calls.locks.length, 1);
  assert.equal(fixture.calls.locks[0].imei, imei);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "PENDING",
    providerState: "LOCKING",
  });
  assert.equal(report.confirmed, 0);
  assert.equal(report.pending, 1);
  assert.ok(
    fixture.calls.evaluations.some((item) => item.trigger === "RECONCILIATION")
  );
});

test("tras timeout no reenvia a ciegas: el siguiente intento consulta primero", async () => {
  let remoteStatus = "unlocked";
  let commandAttempts = 0;
  const fixture = harness({
    queryDevice: () => device(remoteStatus),
    withCommand: true,
  });
  fixture.dependencies.queryDevice = async (queriedImei, requestOptions) => {
    fixture.calls.queries.push({ imei: queriedImei, options: requestOptions });
    return device(remoteStatus);
  };
  fixture.dependencies.lockDevice = async (lockedImei, requestOptions) => {
    fixture.calls.locks.push({ imei: lockedImei, options: requestOptions });
    commandAttempts += 1;
    remoteStatus = "locked";
    const timeout = new Error("fixture timeout");
    timeout.code = "TIMEOUT";
    timeout.retryable = true;
    throw timeout;
  };

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });
  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(commandAttempts, 1);
  assert.equal(fixture.calls.queries.length, 2);
  assert.equal(fixture.calls.outcomes[0].outcome.kind, "RETRY");
  assert.equal(fixture.calls.outcomes[1].outcome.kind, "CONFIRMED");
  assert.equal(
    fixture.calls.outcomes[1].outcome.confirmationSource,
    "OBSERVED"
  );
});

test("pago entre marca y POST conserva UNLOCK compensatorio tras outcome stale", async () => {
  let phase = "LOCK";
  let remoteStatus = "unlocked";
  const lockCommand = claimedCommand("LOCK");
  const unlockCommand = {
    ...claimedCommand("UNLOCK"),
    id: uuid(21),
    desiredVersion: 4,
  };
  const firstUnlockPrepare = readyDispatch("UNLOCK");
  firstUnlockPrepare.command.id = unlockCommand.id;
  firstUnlockPrepare.command.desiredVersion = 4;
  const secondUnlockPrepare = readyDispatch("UNLOCK");
  secondUnlockPrepare.command.id = unlockCommand.id;
  secondUnlockPrepare.command.desiredVersion = 4;
  const fixture = harness({
    commands: [],
    preparedValues: [
      readyDispatch("LOCK"),
      readyDispatch("LOCK"),
      firstUnlockPrepare,
      secondUnlockPrepare,
    ],
  });
  fixture.dependencies.claimCommands = async (input) => {
    fixture.calls.claims.push(input);
    return [phase === "LOCK" ? lockCommand : unlockCommand];
  };
  fixture.dependencies.queryDevice = async (queriedImei, requestOptions) => {
    fixture.calls.queries.push({ imei: queriedImei, options: requestOptions });
    return device(remoteStatus);
  };
  fixture.dependencies.lockDevice = async (lockedImei, requestOptions) => {
    fixture.calls.locks.push({ imei: lockedImei, options: requestOptions });
    // Simula pago confirmado que supersede la version LOCK mientras el POST
    // ya va en vuelo, seguido por el efecto remoto tardio del bloqueo.
    phase = "UNLOCK";
    assert.equal(fixture.calls.unlocks.length, 0);
    remoteStatus = "locked";
    return commandResult("LOCK", "locked", true);
  };
  fixture.dependencies.unlockDevice = async (unlockedImei, requestOptions) => {
    fixture.calls.unlocks.push({ imei: unlockedImei, options: requestOptions });
    remoteStatus = "unlocked";
    return commandResult("UNLOCK", "unlocked", true);
  };
  fixture.dependencies.recordOutcome = async (input) => {
    fixture.calls.outcomes.push(input);
    return {
      status: input.commandId === lockCommand.id ? "SUPERSEDED" : "CONFIRMED",
      stale: input.commandId === lockCommand.id,
    };
  };

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });
  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.locks.length, 1);
  assert.equal(fixture.calls.unlocks.length, 1);
  assert.equal(remoteStatus, "unlocked");
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "CONFIRMED",
    providerState: "LOCKED",
    confirmationSource: "COMMAND_RESULT",
  });
  assert.deepEqual(fixture.calls.outcomes[1].outcome, {
    kind: "CONFIRMED",
    providerState: "UNLOCKED",
    confirmationSource: "COMMAND_RESULT",
  });
});

test("un intento con lease vencido se concilia solo por GET y nunca repite el POST obsoleto", async () => {
  const staleAttempt = readyDispatch("LOCK", true);
  staleAttempt.command.reconciliationOnly = true;
  const fixture = harness({
    preparedValues: [staleAttempt],
    remoteStatus: "locking",
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.prepares.length, 1);
  assert.equal(fixture.calls.queries.length, 1);
  assert.equal(fixture.calls.locks.length, 0);
  assert.equal(fixture.calls.unlocks.length, 0);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "PENDING",
    providerState: "LOCKING",
  });
});

test("un estado opuesto no cierra un POST ambiguo ni permite reenviar LOCK", async () => {
  const staleAttempt = readyDispatch("LOCK", true);
  staleAttempt.command.reconciliationOnly = true;
  const fixture = harness({
    preparedValues: [staleAttempt],
    remoteStatus: "unlocked",
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.prepares.length, 1);
  assert.equal(fixture.calls.locks.length, 0);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "RETRY",
    errorCode: "PROVIDER_ATTEMPT_OUTCOME_UNPROVEN",
    providerState: "UNLOCKED",
  });
  assert.ok(
    fixture.calls.evaluations.some(
      (item) =>
        item.trigger === "RECONCILIATION" &&
        item.source === "PADLOCK_STALE_ATTEMPT_RECONCILIATION"
    )
  );
});

test("success=false con estado final solo confirma despues de reconsultar", async () => {
  let queryCount = 0;
  const fixture = harness({ withCommand: true });
  fixture.dependencies.queryDevice = async (queriedImei, requestOptions) => {
    fixture.calls.queries.push({ imei: queriedImei, options: requestOptions });
    queryCount += 1;
    return device(queryCount === 1 ? "unlocked" : "locked");
  };
  fixture.dependencies.lockDevice = async (lockedImei, requestOptions) => {
    fixture.calls.locks.push({ imei: lockedImei, options: requestOptions });
    return commandResult("LOCK", "locked", false);
  };

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.queries.length, 2);
  assert.equal(fixture.calls.locks.length, 1);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "CONFIRMED",
    providerState: "LOCKED",
    confirmationSource: "OBSERVED",
  });
});

test("UNLOCK consulta, revalida y usa solo el IMEI vinculado", async () => {
  const fixture = harness({
    action: "UNLOCK",
    commandStatus: "unlocked",
    remoteStatus: "locked",
    withCommand: true,
  });

  await runPadlockAutomationCycle({ dependencies: fixture.dependencies });

  assert.equal(fixture.calls.locks.length, 0);
  assert.equal(fixture.calls.unlocks.length, 1);
  assert.equal(fixture.calls.unlocks[0].imei, imei);
  assert.deepEqual(fixture.calls.outcomes[0].outcome, {
    kind: "CONFIRMED",
    providerState: "UNLOCKED",
    confirmationSource: "COMMAND_RESULT",
  });
});
