import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { welcomeVoicePresentation, orderedWelcomeVoiceCalls, welcomeVoiceHistoryPage,
  formatWelcomeVoiceCallDate, formatWelcomeVoiceCallDuration } = await createJiti(import.meta.url)
  .import("../lib/credit-welcome-voice-presentation.ts");
const call = (patch = {}) => ({ id: "event-one", creditId: 72, status: "COMPLETED", source: "NORMAL",
  providerCallId: "provider-one", createdAt: "2026-10-10T10:00:00Z", dispatchedAt: "2026-10-10T10:01:00Z",
  completedAt: "2026-10-10T10:02:00Z", durationSeconds: 85, identityVerified: false,
  summary: null, doubts: null, recordingUrl: null, audioStorage: "UNAVAILABLE", resultCode: "CALL_COMPLETED", ...patch });

test("progress separates provider acceptance from confirmed human contact", () => {
  for (const status of ["PENDING", "DISPATCHING"]) assert.deepEqual(welcomeVoicePresentation(call({ status })),
    { label: "Solicitada", tone: "warning", active: true });
  assert.deepEqual(welcomeVoicePresentation(call({ status: "ACCEPTED" })), { label: "En curso", tone: "warning", active: true });
  assert.deepEqual(welcomeVoicePresentation(call({ communicationOutcome: "HUMAN_CONTACT" })),
    { label: "Contestada", tone: "neutral", active: false });
  assert.equal(welcomeVoicePresentation(call({ communicationOutcome: "OPT_OUT" })).label, "Contestada");
});

test("actual voicemail, no-answer and technical failure evidence remain distinct", () => {
  for (const patch of [{ resultCode: "VOICEMAIL" }, { disconnectionReason: "voicemail_reached" }]) {
    assert.equal(welcomeVoicePresentation(call(patch)).label, "Buzón de voz");
  }
  for (const patch of [{ communicationOutcome: "NO_ANSWER" }, { disconnectionReason: "dial_no_answer", status: "FAILED" },
    { disconnectionReason: "dial_busy", status: "FAILED" }]) {
    assert.equal(welcomeVoicePresentation(call(patch)).label, "Sin respuesta");
  }
  for (const patch of [{ status: "FAILED", communicationOutcome: "NO_ANSWER" }, { disconnectionReason: "dial_failed" },
    { disconnectionReason: "error_provider" }]) assert.equal(welcomeVoicePresentation(call(patch)).label, "Fallida");
});

test("finished or long calls do not claim welcome completion, human contact or verified identity", () => {
  for (const patch of [{}, { durationSeconds: 1800 }, { resultCode: "TERMS_REVIEWED" },
    { summary: "Cliente verificado y bienvenida completada" }, { identityVerified: true, communicationOutcome: "UNCERTAIN" }]) {
    assert.deepEqual(welcomeVoicePresentation(call(patch)), { label: "Finalizada", tone: "neutral", active: false });
  }
  assert.equal(welcomeVoicePresentation(call({ status: "CANCELLED" })).label, "Cancelada");
  assert.equal(welcomeVoicePresentation(call({ status: "SKIPPED" })).label, "No realizada");
  assert.equal(welcomeVoicePresentation(call({ status: "UNKNOWN" })).active, true);
});

test("history isolates the requested credit, keeps one row per event and sorts by actual attempt creation", () => {
  const earlier = call({ id: "earlier", createdAt: "2026-10-09T10:00:00Z", status: "ACCEPTED", completedAt: null });
  const earlierUpdate = { ...earlier, status: "COMPLETED", completedAt: "2026-10-10T11:00:00Z", summary: "latest provider update" };
  const latest = call({ id: "latest", createdAt: "2026-10-10T10:00:00Z" });
  const wrongCredit = call({ id: "elsewhere", creditId: 99, summary: "Other customer private data" });
  const input = [earlierUpdate, wrongCredit, latest, earlier];
  const untouched = structuredClone(input);
  const actual = orderedWelcomeVoiceCalls(input, 72);
  assert.deepEqual(actual.map(item => item.id), ["latest", "earlier"]);
  assert.equal(actual[1].summary, "latest provider update");
  assert.deepEqual(input, untouched);
  assert.deepEqual(orderedWelcomeVoiceCalls(input, 101), []);
});

test("repeated webhook representations replace one existing visible event", () => {
  const initial = call({ status: "ACCEPTED", completedAt: null, summary: null });
  const completed = call({ communicationOutcome: "HUMAN_CONTACT", summary: "Actual conversation" });
  assert.equal(orderedWelcomeVoiceCalls([initial, completed, { ...completed }], 72).length, 1);
  assert.equal(orderedWelcomeVoiceCalls([initial, completed], 72)[0].summary, "Actual conversation");
});

test("history pagination covers all attempts in pages of at most ten and clamps stale page indexes", () => {
  const items = Array.from({ length: 23 }, (_, index) => call({ id: `event-${index}` }));
  const one = welcomeVoiceHistoryPage(items, 1);
  assert.equal(one.items.length, 10); assert.equal(one.total, 23); assert.equal(one.pageCount, 3);
  assert.equal(one.start, 1); assert.equal(one.end, 10);
  const two = welcomeVoiceHistoryPage(items, 2);
  assert.equal(two.items.length, 10); assert.equal(two.start, 11); assert.equal(two.end, 20);
  const last = welcomeVoiceHistoryPage(items, 99);
  assert.equal(last.page, 3); assert.equal(last.start, 21); assert.equal(last.end, 23); assert.equal(last.items.length, 3);
  for (const page of [-1, 0, NaN, Infinity]) assert.equal(welcomeVoiceHistoryPage(items, page).page, 1);
  assert.deepEqual(welcomeVoiceHistoryPage([], 99), { items: [], page: 1, pageCount: 1, total: 0, start: 0, end: 0 });
});

test("date and duration formatters use Colombia and retain zero-duration calls", () => {
  assert.match(formatWelcomeVoiceCallDate("2026-10-10T03:00:00Z"), /9/);
  assert.equal(formatWelcomeVoiceCallDate("not-a-date"), "Sin registro");
  assert.equal(formatWelcomeVoiceCallDate(null), "Sin registro");
  assert.equal(formatWelcomeVoiceCallDuration(85), "1 min 25 s");
  assert.equal(formatWelcomeVoiceCallDuration(0), "0 min 0 s");
  for (const value of [null, NaN, -1, Infinity]) assert.equal(formatWelcomeVoiceCallDuration(value), "Sin registro");
});
