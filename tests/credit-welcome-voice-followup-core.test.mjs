import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { planCreditWelcomeVoiceFollowup: decide, getCreditWelcomeVoicePendingSlot: currentSlot } = loadReissueModule("lib/credit-welcome-voice-followup-core.ts");
const iso = "2026-10-20T15:00:00.000Z";
const input = patch => ({ now: new Date(iso), phase: "FAST", fastAttempts: 0, lastEvent: null, ...patch });
const safe = value => JSON.parse(JSON.stringify(value));

test("one fresh initial is due and reuses a queued NORMAL or INDIVIDUAL_IMPORT event", () => {
  for (const lastEvent of [null, { source: "NORMAL", status: "PENDING" }, { source: "INDIVIDUAL_IMPORT", status: "PENDING", attemptNumber: 7 }]) {
    assert.deepEqual(safe(decide(input({ lastEvent }))), {
      phase: "FAST", shouldDispatch: true, nextAttemptAt: iso, pendingSlot: null, reason: "INITIAL_CALL_DUE",
    });
  }
  assert.equal(decide(input({ phase: "PENDING", lastEvent: { source: "NORMAL", status: "PENDING" } })).shouldDispatch, true);
});

test("no-answer, voicemail, failure, unknown and uncertain results never schedule a second automatic call", () => {
  for (const phase of ["FAST", "PENDING", "HELD"]) for (const status of ["COMPLETED", "FAILED", "UNKNOWN", "CANCELLED", "SKIPPED"]) {
    for (const communicationOutcome of ["NO_ANSWER", "UNCERTAIN", null]) {
      const plan = decide(input({ phase, holdReason: "UNKNOWN_CALL", fastAttempts: 1,
        lastEvent: { source: "NORMAL", status, communicationOutcome, completedAt: iso, resultCode: "VOICEMAIL" } }));
      assert.equal(plan.shouldDispatch, false);
      assert.equal(plan.phase, "STOPPED");
      assert.equal(plan.nextAttemptAt, null);
      assert.equal(plan.pendingSlot, null);
    }
  }
});

test("legacy retry queues stop even with zero counter, a late no-answer or known-unsent local failure", () => {
  for (const phase of ["FAST", "PENDING", "HELD"]) for (const status of ["PENDING", "DISPATCHING", "ACCEPTED", "COMPLETED", "FAILED", "UNKNOWN"]) {
    const plan = decide(input({ phase, holdReason: "UNKNOWN_CALL", fastAttempts: 0,
      lastEvent: { source: "AUTOMATIC_RETRY", status, retryPhase: "FAST", communicationOutcome: "NO_ANSWER",
        completedAt: iso, resultCode: "WINDOW_CLOSED_BEFORE_DISPATCH" } }));
    assert.equal(plan.phase, "STOPPED");
    assert.equal(plan.shouldDispatch, false);
    assert.equal(plan.reason, "AUTOMATIC_CALL_LIMIT_REACHED");
  }
  for (const fastAttempts of [1, 2, 5]) assert.equal(decide(input({ fastAttempts })).shouldDispatch, false);
});

test("another worker cannot turn a still-running initial claim into a retry or cancel its prepare eligibility", () => {
  for (const status of ["DISPATCHING", "ACCEPTED"]) {
    const plan = decide(input({ fastAttempts: 1, lastEvent: { source: "NORMAL", status } }));
    assert.equal(plan.phase, "FAST");
    assert.equal(plan.shouldDispatch, false);
    assert.equal(plan.reason, "CALL_IN_FLIGHT");
    assert.equal(plan.nextAttemptAt, null);
  }
});

test("real contact and backend verification remain CONTACTED, refusals remain STOPPED", () => {
  for (const evidence of [{ communicationOutcome: "HUMAN_CONTACT" }, { identityVerifiedAt: iso }]) {
    assert.equal(decide(input({ fastAttempts: 1, lastEvent: { source: "NORMAL", status: "COMPLETED", ...evidence } })).phase, "CONTACTED");
  }
  for (const evidence of [{ communicationOutcome: "OPT_OUT" }, { resultCode: "RECORDING_DECLINED" }]) {
    assert.equal(decide(input({ phase: "CONTACTED", lastEvent: { source: "NORMAL", status: "COMPLETED", ...evidence } })).phase, "STOPPED");
  }
  assert.equal(decide(input({ phase: "STOPPED" })).phase, "STOPPED");
});

test("explicit manual calls and controlled tests do not consume the automatic initial quota", () => {
  for (const source of ["OPERATOR_REQUEST", "CONTROLLED_TEST"]) for (const communicationOutcome of ["NO_ANSWER", "HUMAN_CONTACT", "OPT_OUT"]) {
    const plan = decide(input({ lastEvent: { source, status: "COMPLETED", communicationOutcome } }));
    assert.equal(plan.shouldDispatch, true);
    assert.equal(plan.reason, "INITIAL_CALL_DUE");
  }
});

test("malformed state and prior safety holds fail closed and policy never mutates input", () => {
  for (const fastAttempts of [-1, 1.5, NaN, Infinity]) assert.equal(decide(input({ fastAttempts })).phase, "HELD");
  assert.equal(decide(input({ now: new Date(NaN) })).phase, "HELD");
  for (const holdReason of ["CONTACT_CHANGED", "CONDITIONS_CHANGED", "OPERATOR_EXCLUDED"]) {
    assert.equal(decide(input({ phase: "HELD", holdReason })).shouldDispatch, false);
  }
  const original = Object.freeze(input({ reviewStatus: "APPROVED" }));
  assert.equal(decide(original).shouldDispatch, true);
  assert.equal(original.fastAttempts, 0);
});

test("legacy slot helper remains bounded but passing a daily slot never authorizes a retry", () => {
  for (const hour of [8, 10, 14, 17]) {
    const start = new Date("2026-10-20T" + (hour + 5) + ":00:00Z");
    assert.equal(currentSlot(start), "2026-10-20T" + String(hour).padStart(2, "0") + ":00");
    assert.equal(currentSlot(new Date(start.getTime() + 600000)), null);
    assert.equal(decide(input({ now: start, phase: "PENDING", fastAttempts: 5,
      lastEvent: { source: "NORMAL", status: "COMPLETED", communicationOutcome: "NO_ANSWER", completedAt: "2026-10-19T13:00:00Z" } })).shouldDispatch, false);
  }
});
