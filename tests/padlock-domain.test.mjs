import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": projectRoot,
  },
});
const {
  decidePadlockAction,
  evaluatePadlockCredit,
  hasUnresolvedPadlockProviderAttempt,
  isPadlockProviderAttemptOpen,
  nextPadlockLockScheduleSlot,
  padlockLockScheduleSlot,
  planPadlockCommandMutation,
  shouldKeepPadlockProviderAttemptPending,
} = await jiti.import("../lib/padlock/engine.ts");
const {
  buildPadlockFinancialPosition,
  effectivePadlockLockThreshold,
} = await jiti.import("../lib/padlock/finance.ts");

function context(overrides = {}) {
  return {
    binding: {
      id: "11111111-1111-4111-8111-111111111111",
      creditId: 7,
      imei: "490154203237518",
      product: "IPHONE",
      status: "ACTIVE",
      verifiedAt: "2026-08-01T12:00:00.000Z",
      desiredState: "UNKNOWN",
      desiredVersion: 0,
      desiredLockCause: null,
      confirmedState: "UNKNOWN",
      confirmedLockCause: null,
      hasPendingAutoMoraLock: false,
      hasUnreconciledAutoMoraLockAttempt: false,
      hasActiveMoraBlockExemption: false,
      creditTheftLockActive: false,
      autoMoraLockDecisionAt: "2026-08-05T01:00:00.000Z",
      hasConfirmedPaymentAfterAutoMoraLockDecision: true,
      creditImei: "490154203237518",
      creditPlatform: "IPHONE",
      creditLifecycleState: "GENERADO",
      ...overrides.binding,
    },
    policy: {
      id: "22222222-2222-4222-8222-222222222222",
      scopeType: "GLOBAL",
      allyId: null,
      product: "IPHONE",
      version: 1,
      enabled: true,
      graceDays: 10,
      lockAfterDaysPastDue: 20,
      unlockCondition: "CURRENT",
      ...overrides.policy,
    },
    financial: {
      montoCredito: 200_000,
      valorCuota: 100_000,
      plazoMeses: 2,
      frecuenciaPago: "MENSUAL",
      fechaPrimerPago: "2026-08-02",
      abonos: [],
      ...overrides.financial,
    },
  };
}

test("el cutoff de lock es solo el minuto 20:00 de los dias 5 y 20 en Bogota", () => {
  assert.equal(
    padlockLockScheduleSlot("2026-09-06T00:59:59.999Z"),
    null,
    "19:59:59 del dia 5 aun no es el corte"
  );
  assert.equal(
    padlockLockScheduleSlot("2026-09-06T01:00:59.999Z")?.toISOString(),
    "2026-09-06T01:00:00.000Z"
  );
  assert.equal(
    padlockLockScheduleSlot("2026-09-06T01:01:00.000Z"),
    null,
    "20:01 no crea locks retroactivos"
  );
  assert.equal(padlockLockScheduleSlot("2026-09-05T01:00:00.000Z"), null);
  assert.equal(
    padlockLockScheduleSlot("2026-09-21T01:00:00.000Z")?.toISOString(),
    "2026-09-21T01:00:00.000Z"
  );
});

test("una transicion Padlock observada espera al equipo sin agotar la conciliacion", () => {
  assert.equal(
    shouldKeepPadlockProviderAttemptPending({
      providerAttemptCount: 1,
      providerTransitionObservedAt: null,
      outcomeKind: "PENDING",
    }),
    true
  );
  assert.equal(
    shouldKeepPadlockProviderAttemptPending({
      providerAttemptCount: 1,
      providerTransitionObservedAt: "2026-09-05T01:00:00.000Z",
      outcomeKind: "RETRY",
    }),
    true
  );
});

test("un timeout sin transicion observada conserva el limite y requiere revision", () => {
  assert.equal(
    shouldKeepPadlockProviderAttemptPending({
      providerAttemptCount: 1,
      providerTransitionObservedAt: null,
      outcomeKind: "RETRY",
    }),
    false
  );
  assert.equal(
    shouldKeepPadlockProviderAttemptPending({
      providerAttemptCount: 0,
      providerTransitionObservedAt: null,
      outcomeKind: "PENDING",
    }),
    false
  );
});

test("calcula el proximo slot sin reutilizar un corte que ya paso", () => {
  assert.equal(
    nextPadlockLockScheduleSlot("2026-09-06T01:00:30.000Z").toISOString(),
    "2026-09-21T01:00:00.000Z"
  );
  assert.equal(
    nextPadlockLockScheduleSlot("2026-09-21T01:00:00.000Z").toISOString(),
    "2026-10-06T01:00:00.000Z"
  );
});

test("la posicion oficial excluye abonos ANULADO y usa paz y salvo", () => {
  const withActivePayment = buildPadlockFinancialPosition(
    {
      montoCredito: 200_000,
      valorCuota: 100_000,
      plazoMeses: 2,
      frecuenciaPago: "MENSUAL",
      fechaPrimerPago: "2026-08-02",
      abonos: [
        { valor: 100_000, estado: "ACTIVO" },
        { valor: 100_000, estado: "ANULADO" },
      ],
    },
    "2026-08-10T12:00:00.000Z"
  );
  assert.equal(withActivePayment.state, "AL_DIA");
  assert.equal(withActivePayment.totalPaid, 100_000);

  const settled = buildPadlockFinancialPosition(
    {
      montoCredito: 200_000,
      valorCuota: 100_000,
      plazoMeses: 2,
      fechaPrimerPago: "2026-08-02",
      pazYSalvoEmitidoAt: "2026-08-09T12:00:00.000Z",
    },
    "2026-08-10T12:00:00.000Z"
  );
  assert.equal(settled.state, "SETTLED");
  assert.equal(settled.outstandingBalance, 0);
  assert.equal(settled.reliable, true);
});

test("el umbral efectivo suma gracia y dias de mora configurados", () => {
  assert.equal(
    effectivePadlockLockThreshold({
      graceDays: 10,
      lockAfterDaysPastDue: 20,
    }),
    30
  );
  const eligible = decidePadlockAction({
    context: context(),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(eligible.kind, "QUEUE");
  assert.equal(eligible.action, "LOCK");
  assert.equal(eligible.lockCause, "AUTO_MORA");
  assert.equal(eligible.position.daysPastDue, 34);

  const waiting = decidePadlockAction({
    context: context({ policy: { graceDays: 15, lockAfterDaysPastDue: 20 } }),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(waiting.kind, "NONE");
  assert.equal(waiting.reason, "LOCK_THRESHOLD_NOT_REACHED");
});

test("no genera lock fuera del cutoff ni para un binding que dejo de ser iPhone", () => {
  const outside = decidePadlockAction({
    context: context(),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:01:00.000Z",
  });
  assert.equal(outside.kind, "NONE");
  assert.equal(outside.reason, "OUTSIDE_LOCK_WINDOW");

  const wrongPlatform = decidePadlockAction({
    context: context({ binding: { creditPlatform: "ANDROID" } }),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(wrongPlatform.kind, "NONE");
  assert.equal(wrongPlatform.reason, "BINDING_NOT_IPHONE");
  assert.equal(wrongPlatform.requiresReview, true);
});

test("un credito cancelado no recibe LOCK pero un AUTO_MORA puede liberarse", () => {
  const cancelledLock = decidePadlockAction({
    context: context({ binding: { creditLifecycleState: "CANCELADO" } }),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(cancelledLock.kind, "NONE");
  assert.equal(cancelledLock.reason, "CREDIT_NOT_ACTIVE");

  const cancelledUnlock = decidePadlockAction({
    context: context({
      binding: {
        creditLifecycleState: "CANCELADO",
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
      },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(cancelledUnlock.kind, "QUEUE");
  assert.equal(cancelledUnlock.action, "UNLOCK");
});

test("unlock automatico es inmediato pero solo revierte AUTO_MORA", () => {
  const currentFinancial = {
    abonos: [{ valor: 100_000, estado: "ACTIVO" }],
  };
  const automatic = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredVersion: 4,
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
      },
      policy: { enabled: false },
      financial: currentFinancial,
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(automatic.kind, "QUEUE");
  assert.equal(automatic.action, "UNLOCK");
  assert.equal(automatic.scheduleSlotAt, null);

  const protectedManual = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "MANUAL",
        confirmedState: "LOCKED",
        confirmedLockCause: "MANUAL",
      },
      financial: currentFinancial,
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(protectedManual.kind, "NONE");
  assert.equal(protectedManual.reason, "PROTECTED_LOCK_CAUSE");

  const mixedProtected = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "MANUAL",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
      },
      financial: currentFinancial,
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(mixedProtected.kind, "NONE");
  assert.equal(mixedProtected.reason, "PROTECTED_LOCK_CAUSE");
});

test("unlock automatico exige pago ACTIVO creado despues de la decision LOCK", () => {
  const decision = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
        hasConfirmedPaymentAfterAutoMoraLockDecision: false,
      },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });

  assert.equal(decision.kind, "NONE");
  assert.equal(decision.reason, "CONFIRMED_PAYMENT_AFTER_LOCK_REQUIRED");
});

test("un intento LOCK AUTO_MORA superseded conserva provenance para compensar", () => {
  const decision = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "UNLOCKED",
        desiredLockCause: null,
        confirmedState: "UNLOCKED",
        confirmedLockCause: null,
        hasUnreconciledAutoMoraLockAttempt: true,
      },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
    ignoreDesiredState: true,
  });

  assert.equal(decision.kind, "QUEUE");
  assert.equal(decision.action, "UNLOCK");
  assert.equal(decision.reason, "FINANCIAL_POSITION_CURRENT");
});

test("la barrera de proveedor permanece tras vencer el lease hasta una conciliacion posterior", () => {
  const startedAt = new Date("2026-09-06T01:00:10.000Z");
  const unresolved = {
    status: "PROCESSING",
    providerAttemptCount: 1,
    lastProviderAttemptStartedAt: startedAt,
    lastProviderAttemptCompletedAt: null,
  };
  assert.equal(hasUnresolvedPadlockProviderAttempt(unresolved), true);
  assert.equal(isPadlockProviderAttemptOpen(unresolved), true);

  assert.equal(
    hasUnresolvedPadlockProviderAttempt({
      ...unresolved,
      status: "RETRY",
    }),
    true
  );
  assert.equal(
    isPadlockProviderAttemptOpen({
      ...unresolved,
      status: "RETRY",
    }),
    false
  );
  assert.equal(
    hasUnresolvedPadlockProviderAttempt({
      ...unresolved,
      status: "SUPERSEDED",
      lastProviderAttemptCompletedAt: new Date("2026-09-06T01:00:30.000Z"),
    }),
    false
  );
});

test("una excepcion vigente impide LOCK y solo cancela un LOCK AUTO_MORA no confirmado", () => {
  const exemptLock = decidePadlockAction({
    context: context({
      binding: { hasActiveMoraBlockExemption: true },
    }),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(exemptLock.kind, "NONE");
  assert.equal(exemptLock.reason, "ACTIVE_MORA_BLOCK_EXEMPTION");

  const pendingLock = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "UNLOCKED",
        confirmedLockCause: null,
        hasPendingAutoMoraLock: true,
        hasActiveMoraBlockExemption: true,
      },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-09-06T01:02:00.000Z",
  });
  assert.equal(pendingLock.kind, "QUEUE");
  assert.equal(pendingLock.action, "UNLOCK");
  assert.equal(
    pendingLock.reason,
    "ACTIVE_MORA_BLOCK_EXEMPTION_CANCELLED_PENDING_LOCK"
  );

  const confirmedLockWithoutPayment = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
        hasActiveMoraBlockExemption: true,
        hasConfirmedPaymentAfterAutoMoraLockDecision: false,
      },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(confirmedLockWithoutPayment.kind, "NONE");
  assert.equal(
    confirmedLockWithoutPayment.reason,
    "CONFIRMED_PAYMENT_AFTER_LOCK_REQUIRED"
  );
});

test("bloqueoRobo canonico protege tanto LOCK como UNLOCK automaticos", () => {
  const theftProtectedLock = decidePadlockAction({
    context: context({
      binding: { creditTheftLockActive: true },
    }),
    trigger: "LOCK_SCHEDULE",
    now: "2026-09-06T01:00:00.000Z",
  });
  assert.equal(theftProtectedLock.kind, "NONE");
  assert.equal(theftProtectedLock.reason, "THEFT_LOCK_ACTIVE");

  const theftProtectedUnlock = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
        creditTheftLockActive: true,
      },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(theftProtectedUnlock.kind, "NONE");
  assert.equal(theftProtectedUnlock.reason, "THEFT_LOCK_ACTIVE");
});

test("SETTLED no desbloquea por una simple puesta al dia", () => {
  const decision = decidePadlockAction({
    context: context({
      binding: {
        desiredState: "LOCKED",
        desiredLockCause: "AUTO_MORA",
        confirmedState: "LOCKED",
        confirmedLockCause: "AUTO_MORA",
      },
      policy: { unlockCondition: "SETTLED" },
      financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
    }),
    trigger: "FINANCIAL_CHANGE",
    now: "2026-08-10T12:34:00.000Z",
  });
  assert.equal(decision.kind, "NONE");
  assert.equal(decision.reason, "WAITING_SETTLEMENT");
});

test("la mutacion deseada es idempotente, supersede el opuesto y detecta carreras", () => {
  assert.deepEqual(
    planPadlockCommandMutation({
      currentDesiredState: "LOCKED",
      currentDesiredLockCause: "AUTO_MORA",
      currentDesiredVersion: 3,
      expectedDesiredVersion: 3,
      targetState: "LOCKED",
      targetLockCause: "AUTO_MORA",
      activeCommandIds: ["a"],
    }),
    { kind: "UNCHANGED", desiredVersion: 3, supersedeCommandIds: [] }
  );
  assert.deepEqual(
    planPadlockCommandMutation({
      currentDesiredState: "LOCKED",
      currentDesiredLockCause: "AUTO_MORA",
      currentDesiredVersion: 3,
      expectedDesiredVersion: 3,
      targetState: "UNLOCKED",
      targetLockCause: null,
      activeCommandIds: ["a", "a", "b"],
    }),
    { kind: "ENQUEUE", desiredVersion: 4, supersedeCommandIds: ["a", "b"] }
  );
  assert.deepEqual(
    planPadlockCommandMutation({
      currentDesiredState: "UNLOCKED",
      currentDesiredLockCause: null,
      currentDesiredVersion: 4,
      expectedDesiredVersion: 3,
      targetState: "LOCKED",
      targetLockCause: "AUTO_MORA",
      activeCommandIds: [],
    }),
    { kind: "STALE", desiredVersion: 4, supersedeCommandIds: [] }
  );
  assert.deepEqual(
    planPadlockCommandMutation({
      currentDesiredState: "UNLOCKED",
      currentDesiredLockCause: null,
      currentDesiredVersion: 4,
      expectedDesiredVersion: 4,
      targetState: "UNLOCKED",
      targetLockCause: null,
      activeCommandIds: [],
      forceNewVersion: true,
    }),
    { kind: "ENQUEUE", desiredVersion: 5, supersedeCommandIds: [] }
  );
});

test("el evaluador relee una carrera de version y no duplica la orden", async () => {
  let loads = 0;
  let commits = 0;
  const repository = {
    async loadEvaluationContext() {
      loads += 1;
      return context({
        binding: {
          desiredState: loads === 1 ? "LOCKED" : "UNLOCKED",
          desiredVersion: loads === 1 ? 2 : 3,
          desiredLockCause: loads === 1 ? "AUTO_MORA" : null,
          confirmedState: "LOCKED",
          confirmedLockCause: "AUTO_MORA",
        },
        financial: { abonos: [{ valor: 100_000, estado: "ACTIVO" }] },
      });
    },
    async commitDecision() {
      commits += 1;
      return { kind: "STALE", desiredVersion: 3 };
    },
  };
  const result = await evaluatePadlockCredit({
    repository,
    creditId: 7,
    trigger: "FINANCIAL_CHANGE",
    source: "PAYMENT",
    correlationId: "33333333-3333-4333-8333-333333333333",
    now: new Date("2026-08-10T12:34:00.000Z"),
  });
  assert.equal(result.kind, "NONE");
  assert.equal(result.reason, "DESIRED_STATE_ALREADY_SET");
  assert.equal(loads, 2);
  assert.equal(commits, 1);
});

test("persistencia declara lease SKIP LOCKED, auditoria inmutable y ningun payload remoto", async () => {
  const [storage, ensure, schema, predeploy, dockerfile] = await Promise.all([
    readFile(path.join(projectRoot, "lib/padlock/storage.ts"), "utf8"),
    readFile(path.join(projectRoot, "scripts/ensure-padlock-schema.mjs"), "utf8"),
    readFile(path.join(projectRoot, "prisma/schema.prisma"), "utf8"),
    readFile(path.join(projectRoot, "scripts/railway-predeploy.mjs"), "utf8"),
    readFile(path.join(projectRoot, "Dockerfile"), "utf8"),
  ]);
  assert.match(storage, /FOR UPDATE SKIP LOCKED/);
  assert.match(
    storage,
    /binding\.desiredState === "LOCKED"[\s\S]*binding\.confirmedState === "LOCKED"[\s\S]*"PADLOCK_BINDING_LOCKED"/
  );
  assert.match(storage, /purpose\?: "ALL" \| "AUTO_UNLOCK"/);
  assert.match(storage, /afterCreditId\?: number/);
  assert.match(
    storage,
    /afterCreditId = asInteger\([\s\S]*"PADLOCK_AFTER_CREDIT_ID_INVALID"[\s\S]*\{ min: 0 \}/
  );
  assert.match(storage, /binding\."creditId" > \$4/);
  assert.match(
    storage,
    /ORDER BY binding\."creditId"\s+LIMIT \$1[\s\S]*\[\.\.\.ACTIVE_COMMAND_STATUSES\],\s+afterCreditId/
  );
  assert.match(
    storage,
    /binding\."desiredState" = 'LOCKED'[\s\S]*binding\."desiredLockCause" = 'AUTO_MORA'/
  );
  assert.match(
    storage,
    /binding\."confirmedState" = 'LOCKED'[\s\S]*binding\."confirmedLockCause" = 'AUTO_MORA'/
  );
  assert.match(
    storage,
    /active_lock\."action" = 'LOCK'[\s\S]*active_lock\."lockCause" = 'AUTO_MORA'[\s\S]*active_lock\."status" = ANY/
  );
  assert.match(storage, /credit\."bloqueoRobo" AS "creditTheftLockActive"/);
  assert.match(
    storage,
    /FROM "ExcepcionBloqueoMora" exemption[\s\S]*exemption\."activa" = TRUE[\s\S]*exemption\."fechaFin" >= \$3::timestamp/
  );
  assert.match(
    storage,
    /confirmed_payment\."estado" = 'ACTIVO'[\s\S]*confirmed_payment\."createdAt" > relevant_auto_lock\."decisionAt"/
  );
  assert.doesNotMatch(
    storage,
    /confirmed_payment\."fechaAbono" > relevant_auto_lock\."decisionAt"/
  );
  assert.match(
    storage,
    /candidate\."attemptCount" < candidate\."maxAttempts"[\s\S]*CASE WHEN candidate\."action" = 'UNLOCK' THEN 0 ELSE 1 END[\s\S]*LIMIT \$2[\s\S]*FOR UPDATE SKIP LOCKED/
  );
  assert.match(
    storage,
    /"attemptCount" >= "maxAttempts"[\s\S]*"providerTransitionObservedAt" IS NULL[\s\S]*candidate\."providerTransitionObservedAt" IS NOT NULL/
  );
  assert.match(
    storage,
    /shouldKeepPadlockProviderAttemptPending\(\{[\s\S]*providerTransitionObservedAt: command\.providerTransitionObservedAt[\s\S]*outcomeKind: outcome\.kind/
  );
  assert.match(
    storage,
    /const waitingForDeviceConnectivity = waitsForPadlockDeviceConnectivity\([\s\S]*!waitingForDeviceConnectivity[\s\S]*"REVIEW_REQUIRED"/
  );
  assert.equal(
    storage.match(/"providerTransitionObservedAt" = CASE/g)?.length,
    2
  );
  assert.match(storage, /COALESCE\("providerTransitionObservedAt"/);
  assert.match(
    storage,
    /prior_attempt\."bindingId" = candidate\."bindingId"[\s\S]*prior_attempt\."lastProviderAttemptCompletedAt" IS NULL[\s\S]*prior_attempt\."lastProviderAttemptStartedAt"/
  );
  assert.match(
    storage,
    /COMMAND_SUPERSESSION_DEFERRED[\s\S]*PROVIDER_ATTEMPT_OUTCOME_UNPROVEN/
  );
  assert.match(
    storage,
    /LATE_PROVIDER_OUTCOME_RECORDED[\s\S]*lastProviderAttemptCompletedAt/
  );
  assert.match(
    storage,
    /const definitiveProviderObservation = validExpectedConfirmation/
  );
  assert.match(
    storage,
    /COALESCE\(\s*attempted_lock\."lastProviderAttemptCompletedAt",\s*attempted_lock\."lastProviderAttemptStartedAt"\s*\)/
  );
  assert.match(
    storage,
    /const reconciliationOnly = hasUnresolvedPadlockProviderAttempt\(command\)/
  );
  assert.match(
    storage,
    /!context && !reconciliationOnly[\s\S]*imei: context\?\.binding\.imei \|\| binding\.imei/
  );
  assert.match(
    storage,
    /"providerAttemptCount" > 0[\s\S]*"lastProviderAttemptCompletedAt" IS NULL[\s\S]*PADLOCK_BINDING_PROVIDER_OUTCOME_UNRESOLVED/
  );
  assert.match(storage, /"PADLOCK_THEFT_LOCK_ACTIVE"/);
  assert.match(storage, /MANUAL_COMMAND_NOOP/);
  assert.match(
    storage,
    /credit\."bloqueoRobo" AS "creditTheftLockActive"[\s\S]*credit\."bloqueoMora" AS "creditMoraLockActive"[\s\S]*PADLOCK_ROBBERY_LOCK_REQUIRES_REVIEW[\s\S]*PADLOCK_EXISTING_MORA_LOCK_REQUIRES_REVIEW/
  );
  assert.match(
    storage,
    /"providerAttemptCount" = "providerAttemptCount" \+ 1[\s\S]*"leaseToken" = \$3::uuid[\s\S]*PROVIDER_COMMAND_ATTEMPT_STARTED/
  );
  assert.match(
    storage,
    /LOCKED_OBSERVED_WITHOUT_PROVIDER_ATTEMPT[\s\S]*REMOTE_STATE_OBSERVED_CONFIRMED[\s\S]*PROVIDER_COMMAND_RESULT_CONFIRMED/
  );
  assert.match(ensure, /PadlockAuditEvent_immutable/);
  assert.match(ensure, /PadlockDeviceBinding_active_credit_key/);
  assert.match(ensure, /Padlock command identity is immutable/);
  assert.match(schema, /decisionOutstandingBalance\s+Decimal/);
  assert.match(schema, /operatorReason\s+String\?/);
  assert.match(
    schema,
    /model PadlockAuditEvent[\s\S]*operatorReason\s+String\?\s+@db\.VarChar\(500\)/
  );
  assert.match(schema, /providerAttemptCount\s+Int\s+@default\(0\)/);
  assert.match(schema, /lastProviderAttemptCompletedAt\s+DateTime\?/);
  assert.match(schema, /providerTransitionObservedAt\s+DateTime\?/);
  assert.match(ensure, /ADD COLUMN IF NOT EXISTS "providerAttemptCount"/);
  assert.match(
    ensure,
    /ADD COLUMN IF NOT EXISTS "providerTransitionObservedAt" TIMESTAMP\(3\)/
  );
  assert.match(
    ensure,
    /ALTER TABLE public\."PadlockAuditEvent"[\s\S]*ADD COLUMN IF NOT EXISTS "operatorReason" VARCHAR\(500\)/
  );
  assert.doesNotMatch(storage, /remotePayload|rawPayload|responsePayload/);
  assert.doesNotMatch(schema, /remotePayload|rawPayload|responsePayload/);
  assert.match(predeploy, /ensure-padlock-schema\.mjs/);
  assert.match(dockerfile, /ensure-padlock-schema\.mjs/);
});
