import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { planCreditWelcomeVoiceFollowup: decide, getCreditWelcomeVoicePendingSlot: currentSlot } = loadReissueModule("lib/credit-welcome-voice-followup-core.ts");
const iso = "2026-10-09T16:00:00.000Z";
const result = patches => ({ source: "NORMAL", status: "COMPLETED", communicationOutcome: "NO_ANSWER", completedAt: iso, ...patches });
const input = patches => ({ now: new Date(iso), phase: "FAST", fastAttempts: 1, lastEvent: result(), ...patches });
const safe = value => JSON.parse(JSON.stringify(value));

test("the prepare guard exposes only the current daily window and rejects its exact end", () => {
  for (const hour of [8, 10, 14, 17]) {
    const start = new Date(`2026-10-09T${String(hour + 5).padStart(2, "0")}:00:00.000Z`);
    const expected = `2026-10-09T${String(hour).padStart(2, "0")}:00`;
    assert.equal(currentSlot(new Date(start.getTime() - 1)), null);
    assert.equal(currentSlot(start), expected);
    assert.equal(currentSlot(new Date(start.getTime() + 599999)), expected);
    assert.equal(currentSlot(new Date(start.getTime() + 600000)), null);
  }
  assert.equal(currentSlot(new Date(NaN)), null);
});

test("a fresh welcome is immediately due, including an already queued initial event", () => {
  for (const lastEvent of [null, { source: "NORMAL", status: "PENDING" }, { source: "INDIVIDUAL_IMPORT", status: "PENDING" }]) {
    const plan = decide(input({ fastAttempts: 0, lastEvent }));
    assert.deepEqual(safe(plan), { phase: "FAST", shouldDispatch: true, nextAttemptAt: iso, pendingSlot: null, reason: "INITIAL_CALL_DUE" });
  }
});

test("the initial call counts among five and each later FAST attempt waits five minutes from its result", () => {
  for (let fastAttempts = 1; fastAttempts <= 4; fastAttempts++) {
    const before = decide(input({ fastAttempts, now: new Date("2026-10-09T16:04:59.999Z") }));
    assert.equal(before.shouldDispatch, false);
    assert.equal(before.nextAttemptAt, "2026-10-09T16:05:00.000Z");
    const due = decide(input({ fastAttempts, now: new Date("2026-10-09T16:05:00.000Z") }));
    assert.equal(due.shouldDispatch, true);
    assert.equal(due.phase, "FAST");
    // A delayed worker may perform one due retry; it never synthesizes missed calls.
    assert.equal(decide(input({ fastAttempts, now: new Date("2026-10-09T18:00:00Z") })).nextAttemptAt, due.nextAttemptAt);
  }
});

test("five real FAST calls move to PENDING without a sixth immediate attempt inside the same slot", () => {
  const plan = decide(input({ fastAttempts: 5, now: new Date("2026-10-09T19:03:00Z"),
    lastEvent: result({ completedAt: "2026-10-09T19:02:00Z" }) }));
  assert.equal(plan.phase, "PENDING");
  assert.equal(plan.shouldDispatch, false);
  assert.equal(plan.pendingSlot, "2026-10-09T17:00");
  assert.equal(plan.nextAttemptAt, "2026-10-09T22:00:00.000Z");
});

test("PENDING uses 08/10/14/17 in Colombia and every slot must be strictly after the last result", () => {
  for (const hour of [8, 10, 14, 17]) {
    const utc = hour + 5;
    const start = `2026-10-09T${String(utc).padStart(2, "0")}:00:00.000Z`;
    const plan = decide(input({ phase: "PENDING", fastAttempts: 5, now: new Date(start),
      lastEvent: result({ retryPhase: "PENDING", completedAt: new Date(new Date(start).getTime() - 1) }) }));
    assert.equal(plan.shouldDispatch, true);
    assert.equal(plan.pendingSlot, `2026-10-09T${String(hour).padStart(2, "0")}:00`);
    const equal = decide(input({ phase: "PENDING", fastAttempts: 5, now: new Date(start), lastEvent: result({ completedAt: start }) }));
    assert.equal(equal.shouldDispatch, false);
    assert.notEqual(equal.nextAttemptAt, start);
  }
});

test("PENDING has a ten-minute window, no catch-up, one attempt per slot and rolls over dates", () => {
  const base = input({ phase: "PENDING", fastAttempts: 5, lastEvent: result({ completedAt: "2026-10-09T14:59:00Z" }) });
  assert.equal(decide({ ...base, now: new Date("2026-10-09T15:09:59.999Z") }).shouldDispatch, true);
  const closed = decide({ ...base, now: new Date("2026-10-09T15:10:00Z") });
  assert.equal(closed.shouldDispatch, false);
  assert.equal(closed.nextAttemptAt, "2026-10-09T19:00:00.000Z");
  const duplicate = decide({ ...base, now: new Date("2026-10-09T15:05:00Z"), lastPendingSlot: "2026-10-09T10:00" });
  assert.equal(duplicate.shouldDispatch, false);
  assert.equal(duplicate.pendingSlot, "2026-10-09T14:00");
  const nextDay = decide({ ...base, now: new Date("2026-10-09T23:00:00Z") });
  assert.equal(nextDay.pendingSlot, "2026-10-10T08:00");
  assert.equal(nextDay.nextAttemptAt, "2026-10-10T13:00:00.000Z");
  const nextYear = decide({ ...base, now: new Date("2026-12-31T23:00:00Z") });
  assert.equal(nextYear.pendingSlot, "2027-01-01T08:00");
});

test("inflight events do not redial and retain their recoverable phase", () => {
  for (const phase of ["FAST", "PENDING"]) for (const status of ["DISPATCHING", "ACCEPTED"]) {
    const plan = decide(input({ phase, lastEvent: result({ status, completedAt: null, communicationOutcome: null }) }));
    assert.equal(plan.phase, phase);
    assert.equal(plan.shouldDispatch, false);
    assert.equal(plan.nextAttemptAt, null);
  }
  assert.equal(decide(input({ lastEvent: { source: "AUTOMATIC_RETRY", status: "PENDING" } })).shouldDispatch, false);
});

test("UNKNOWN never ages into NO_ANSWER and a late authenticated result can restore only its provider hold", () => {
  const unknown = decide(input({ now: new Date("2026-10-30T18:00:00Z"), lastEvent: result({ status: "UNKNOWN" }) }));
  assert.equal(unknown.phase, "HELD");
  assert.equal(unknown.reason, "UNKNOWN_CALL");
  assert.equal(unknown.shouldDispatch, false);
  const recovered = decide(input({ phase: "HELD", holdReason: "UNKNOWN_CALL", now: new Date("2026-10-09T16:05:00Z"),
    lastEvent: result({ retryPhase: null }) }));
  assert.equal(recovered.phase, "FAST");
  assert.equal(recovered.shouldDispatch, true);
  const pending = decide(input({ phase: "HELD", holdReason: "UNKNOWN_CALL", fastAttempts: 5,
    now: new Date("2026-10-09T19:00:00Z"), lastEvent: result({ retryPhase: null }) }));
  assert.equal(pending.phase, "PENDING");
  assert.equal(pending.shouldDispatch, true);
  const pendingSlot = decide(input({ phase: "HELD", holdReason: "UNKNOWN_CALL", fastAttempts: 4,
    lastPendingSlot: "2026-10-09T10:00", lastEvent: result({ retryPhase: null }), now: new Date("2026-10-09T19:00:00Z") }));
  assert.equal(pendingSlot.phase, "PENDING");
  for (const holdReason of [null, "CONTACT_CHANGED", "CONDITIONS_CHANGED", "UNCERTAIN_RESULT"]) {
    assert.equal(decide(input({ phase: "HELD", holdReason })).shouldDispatch, false);
  }
});

test("verified identity and human contact stop retries permanently; a refusal always takes priority", () => {
  for (const fields of [{ identityVerifiedAt: new Date(iso) }, { communicationOutcome: "HUMAN_CONTACT" }]) {
    const plan = decide(input({ lastEvent: result(fields) }));
    assert.equal(plan.phase, "CONTACTED");
    assert.equal(plan.shouldDispatch, false);
  }
  assert.equal(decide(input({ phase: "CONTACTED" })).phase, "CONTACTED");
  assert.equal(decide(input({ phase: "STOPPED", lastEvent: result({ communicationOutcome: "HUMAN_CONTACT" }) })).phase, "STOPPED");
  for (const fields of [{ communicationOutcome: "OPT_OUT" }, { resultCode: "RECORDING_DECLINED" }]) {
    const plan = decide(input({ phase: "CONTACTED", lastEvent: result({ ...fields, identityVerifiedAt: new Date(iso) }) }));
    assert.equal(plan.phase, "STOPPED");
    assert.equal(plan.shouldDispatch, false);
  }
});

test("model flags, completion alone, cancelled and uncertain events never authorize another call", () => {
  for (const communicationOutcome of [null, "UNCERTAIN", "TERMS_REVIEWED"]) {
    const plan = decide(input({ lastEvent: result({ communicationOutcome, call_successful: true, identity_confirmed: true, terms_confirmed: true }) }));
    assert.equal(plan.phase, "HELD");
    assert.equal(plan.shouldDispatch, false);
  }
  for (const status of ["CANCELLED", "SKIPPED"]) assert.equal(decide(input({ lastEvent: result({ status }) })).phase, "STOPPED");
  // Backend verification wins even when the model says identity_confirmed=false.
  assert.equal(decide(input({ lastEvent: result({ identityVerifiedAt: new Date(iso), identity_confirmed: false }) })).phase, "CONTACTED");
});

test("controlled owner tests neither create contact nor change the initial eligibility", () => {
  for (const fields of [{ communicationOutcome: "HUMAN_CONTACT", identityVerifiedAt: new Date(iso) }, { communicationOutcome: "OPT_OUT" }, { status: "UNKNOWN" }]) {
    const plan = decide(input({ fastAttempts: 0, lastEvent: result({ source: "CONTROLLED_TEST", ...fields }) }));
    assert.equal(plan.phase, "FAST");
    assert.equal(plan.shouldDispatch, true);
  }
  assert.equal(decide(input({ lastEvent: result({ source: "CONTROLLED_TEST" }) })).reason, "MISSING_RESULT");
});

test("malformed, missing or future result times and corrupt counters fail closed", () => {
  for (const completedAt of [null, "not-a-date", "2026-10-09", "2026-02-30T10:00:00Z", "2026-10-09T16:00:00.001Z"]) {
    assert.equal(decide(input({ lastEvent: result({ completedAt }) })).shouldDispatch, false);
  }
  assert.equal(decide(input({ lastEvent: result({ completedAt: "2026-10-09T11:00:00-05:00" }) })).nextAttemptAt, "2026-10-09T16:05:00.000Z");
  for (const fastAttempts of [-1, 1.5, 6, NaN, Infinity]) assert.equal(decide(input({ fastAttempts })).phase, "HELD");
  assert.equal(decide(input({ now: new Date(NaN) })).phase, "HELD");
  assert.equal(decide(input({ fastAttempts: 0 })).reason, "INVALID_ATTEMPT_COUNT");
  assert.equal(decide(input({ phase: "PENDING", lastPendingSlot: "2026-10-09T11:00" })).phase, "HELD");
});

test("known-unsent local window failures do not require invented callbacks or cause a sixth FAST call", () => {
  const lastEvent = result({ status: "FAILED", communicationOutcome: null, completedAt: null, resultCode: "WINDOW_CLOSED_BEFORE_DISPATCH" });
  assert.equal(decide(input({ fastAttempts: 4, lastEvent })).reason, "KNOWN_UNSENT");
  const exhausted = decide(input({ fastAttempts: 5, lastEvent }));
  assert.equal(exhausted.phase, "PENDING");
  assert.equal(exhausted.shouldDispatch, false);
  const pending = decide(input({ phase: "PENDING", fastAttempts: 5, lastEvent, lastPendingSlot: "2026-10-09T10:00",
    now: new Date("2026-10-09T15:11:00Z") }));
  assert.equal(pending.shouldDispatch, false);
  assert.equal(pending.pendingSlot, "2026-10-09T14:00");
});

test("review approval does not gate the welcome and inputs are not mutated", () => {
  const data = Object.freeze(input({ fastAttempts: 0, lastEvent: null, reviewStatus: "APPROVED" }));
  assert.equal(decide(data).shouldDispatch, true);
  assert.equal(data.reviewStatus, "APPROVED");
  assert.equal(data.fastAttempts, 0);
});
