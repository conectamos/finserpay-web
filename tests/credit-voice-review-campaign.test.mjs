import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const policy = loadReissueModule("lib/credit-voice-review-campaign-core.ts");
const identity = await createJiti(import.meta.url).import("../lib/credit-welcome-voice-core.ts");
const speech = loadReissueModule("lib/credit-welcome-voice-speech.ts", {
  "@/lib/credit-welcome-voice-core": identity,
});
const dispatcher = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": identity,
  "@/lib/credit-welcome-voice-speech": speech,
  "@/lib/credit-welcome-voice-store": {},
}, { AbortSignal });
const job = loadReissueModule("lib/credit-voice-review-campaign.ts", {
  "@/lib/credit-voice-review-campaign-core": policy,
  "@/lib/credit-welcome-voice-dispatch": dispatcher,
  "@/lib/credit-welcome-voice-store": {
    createCreditWelcomeVoiceStore: () => assert.fail("Tests must inject the store"),
    ensureCreditWelcomeVoiceSchema: () => assert.fail("Tests must inject schema setup"),
  },
});
const safe = value => JSON.parse(JSON.stringify(value));
const campaign = { id: "synthetic-pending-review", startDate: "2026-10-09",
  creditIds: Array.from({ length: 13 }, (_, index) => index + 1) };
const environment = patches => ({
  DAPTA_VOICE_REVIEW_CAMPAIGN_ENABLED: "true",
  DAPTA_VOICE_REVIEW_CAMPAIGN_JSON: JSON.stringify(campaign),
  DAPTA_WELCOME_VOICE_ENABLED: "false",
  DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://api.dapta.ai/synthetic-campaign",
  DAPTA_WELCOME_VOICE_TOKEN_SECRET: "synthetic-campaign-secret-at-least-32-bytes",
  DAPTA_WELCOME_VOICE_AGENT_ID: "923f7952-87bc-4f1f-a77d-1972302200ee",
  ...patches,
});
const claim = { eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 1,
  snapshot: { phone: "573000000001", name: "CLIENTE PRUEBA", document: "000123456",
    initialPayment: 200, installmentCount: 4, installmentAmount: 100,
    firstDueDate: "2026-10-17", calendar: ["2026-10-17"] } };

function fixture({ env = environment(), clock = () => new Date("2026-10-09T13:00:00.000Z"),
  prepare = async () => claim, claims = [claim], dispatch } = {}) {
  const operations = [];
  const store = {
    ensureVoiceReviewCampaign: async input => { operations.push(["cohort", safe(input)]); },
    claimVoiceReviewCampaign: async input => { operations.push(["claim", safe(input)]); return claims; },
    prepareVoiceReviewCampaign: async eventId => { operations.push(["prepare", eventId]); return prepare(eventId); },
    claimPendingCreditWelcomeVoice: () => assert.fail("The automatic global queue must stay untouched"),
    enqueueCreditWelcomeVoice: () => assert.fail("A campaign must not enqueue all new credits"),
    markCreditWelcomeVoiceDispatchAccepted: async (...args) => { operations.push(["accepted", ...args]); },
    markCreditWelcomeVoiceDispatchFailed: async (...args) => { operations.push(["failed", ...args]); },
    markCreditWelcomeVoiceDispatchUnknown: async (...args) => { operations.push(["unknown", ...args]); },
  };
  const simulatedDispatch = async (options, deps) => {
    operations.push(["dispatch", safe(options)]);
    await deps.ensureSchema();
    const selected = await deps.claim(options);
    const report = { configured: true, selected: selected.length, accepted: 0, unknown: 0, skipped: 0 };
    for (const selectedClaim of selected) {
      const prepared = await deps.prepare(selectedClaim.eventId);
      if (!prepared) { report.skipped++; continue; }
      await deps.accepted(prepared.eventId, "synthetic-call"); report.accepted++;
    }
    return report;
  };
  return { env, operations, store, deps: { env, now: clock, store,
    ensureSchema: async () => { operations.push(["schema"]); },
    dispatch: dispatch ?? simulatedDispatch } };
}

test("configuration freezes only an explicit unique cohort and never enables global welcome calls", () => {
  const env = Object.freeze(environment());
  const config = policy.getVoiceReviewCampaignConfig(env);
  assert.deepEqual(safe(config), campaign);
  assert.equal(env.DAPTA_WELCOME_VOICE_ENABLED, "false");
  const unsorted = { ...campaign, creditIds: [3, 1, 2] };
  const parsed = policy.getVoiceReviewCampaignConfig(environment({ DAPTA_VOICE_REVIEW_CAMPAIGN_JSON: JSON.stringify(unsorted) }));
  assert.deepEqual(safe(parsed.creditIds), [1, 2, 3]);
  assert.deepEqual(unsorted.creditIds, [3, 1, 2]);
  assert.deepEqual(safe(policy.getVoiceReviewCampaignConfig(environment({
    DAPTA_VOICE_REVIEW_CAMPAIGN_JSON: JSON.stringify({ ...campaign, creditIds: [2_147_483_647] }),
  })).creditIds), [2_147_483_647]);
});

test("disabled, malformed or ambiguous campaign configuration fails closed", () => {
  for (const raw of ["", "{", "null", "[]", JSON.stringify({ ...campaign, unexpected: true }),
    JSON.stringify({ ...campaign, id: "unbounded campaign name" }),
    JSON.stringify({ ...campaign, startDate: "2026-02-30" }),
    JSON.stringify({ ...campaign, startDate: "09/10/2026" }),
    JSON.stringify({ ...campaign, creditIds: [] }), JSON.stringify({ ...campaign, creditIds: [1, 1] }),
    JSON.stringify({ ...campaign, creditIds: [0] }), JSON.stringify({ ...campaign, creditIds: ["1"] }),
    JSON.stringify({ ...campaign, creditIds: [2_147_483_648] }),
    JSON.stringify({ ...campaign, creditIds: [1.5] }), JSON.stringify({ ...campaign, creditIds: [Number.MAX_SAFE_INTEGER + 1] }),
    JSON.stringify({ ...campaign, creditIds: Array.from({ length: 101 }, (_, index) => index + 1) })]) {
    assert.equal(policy.getVoiceReviewCampaignConfig(environment({ DAPTA_VOICE_REVIEW_CAMPAIGN_JSON: raw })), null, raw);
  }
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    assert.equal(policy.getVoiceReviewCampaignConfig(environment({ DAPTA_VOICE_REVIEW_CAMPAIGN_ENABLED: flag })), null);
  }
});

test("first date has 08/10/14 Colombia slots; later dates only 10/14 without catch-up", () => {
  for (const [time, slot] of [
    ["2026-10-08T19:00:00Z", null],
    ["2026-10-09T12:59:59.999Z", null],
    ["2026-10-09T13:00:00Z", "2026-10-09T08:00"],
    ["2026-10-09T13:09:59.999Z", "2026-10-09T08:00"],
    ["2026-10-09T13:10:00Z", null],
    ["2026-10-09T14:59:59.999Z", null],
    ["2026-10-09T15:00:00Z", "2026-10-09T10:00"],
    ["2026-10-09T15:10:00Z", null],
    ["2026-10-09T19:00:00Z", "2026-10-09T14:00"],
    ["2026-10-09T19:10:00Z", null],
    ["2026-10-10T01:00:00Z", null],
    ["2026-10-10T13:00:00Z", null],
    ["2026-10-10T15:00:00Z", "2026-10-10T10:00"],
    ["2026-10-10T19:00:00Z", "2026-10-10T14:00"],
    ["2026-11-01T15:09:59Z", "2026-11-01T10:00"],
    ["2026-11-01T15:10:00Z", null],
  ]) assert.equal(policy.getVoiceReviewCampaignSlot(campaign, new Date(time)), slot, time);
  assert.equal(policy.getVoiceReviewCampaignSlot(campaign, new Date(NaN)), null);
});

test("only explicit no-answer on a terminal event is retryable; uncertain and model claims remain held", () => {
  for (const status of ["PENDING", "DISPATCHING", "ACCEPTED", "UNKNOWN"]) {
    assert.equal(policy.classifyVoiceCampaignResult({ status, communicationOutcome: "NO_ANSWER" }), "HELD");
  }
  for (const status of ["COMPLETED", "FAILED"]) {
    assert.equal(policy.classifyVoiceCampaignResult({ status, communicationOutcome: "NO_ANSWER" }), "RETRY");
    for (const resultCode of ["CALL_COMPLETED", "TERMS_REVIEWED", "CALL_FAILED", "VOICEMAIL", "NO_ANSWER", null]) {
      assert.equal(policy.classifyVoiceCampaignResult({ status, resultCode, terms_confirmed: true,
        customer_agreed: true, durationSeconds: 200 }), "HELD");
    }
  }
});

test("only the local known-unsent window failure is retryable without a provider no-answer", () => {
  assert.equal(policy.classifyVoiceCampaignResult({ status: "FAILED", resultCode: "WINDOW_CLOSED_BEFORE_DISPATCH" }), "RETRY");
  for (const status of ["DISPATCHING", "ACCEPTED", "UNKNOWN", "COMPLETED"]) {
    assert.equal(policy.classifyVoiceCampaignResult({ status, resultCode: "WINDOW_CLOSED_BEFORE_DISPATCH" }), "HELD");
  }
  for (const resultCode of ["DISPATCH_REJECTED", "DISPATCH_OUTCOME_UNKNOWN", "CALL_FAILED", "INVALID_DISPATCH_CONFIG"]) {
    assert.equal(policy.classifyVoiceCampaignResult({ status: "FAILED", resultCode }), "HELD");
  }
  assert.equal(policy.classifyVoiceCampaignResult({ status: "FAILED", resultCode: "WINDOW_CLOSED_BEFORE_DISPATCH",
    communicationOutcome: "OPT_OUT" }), "STOPPED");
});

test("refusal and exclusions stop while verified contact ends retries without implying approval", () => {
  for (const event of [{ status: "CANCELLED" }, { status: "SKIPPED" },
    { status: "COMPLETED", communicationOutcome: "OPT_OUT" },
    { status: "FAILED", resultCode: "RECORDING_DECLINED", identityVerifiedAt: new Date() }]) {
    assert.equal(policy.classifyVoiceCampaignResult(event), "STOPPED");
  }
  for (const event of [{ status: "COMPLETED", identityVerifiedAt: "2026-10-09T13:01:00Z" },
    { status: "FAILED", communicationOutcome: "HUMAN_CONTACT" },
    { status: "COMPLETED", identityVerifiedAt: new Date(), communicationOutcome: "NO_ANSWER" }]) {
    assert.equal(policy.classifyVoiceCampaignResult(event), "CONTACTED");
  }
});

test("disabled or incomplete Dapta configuration never touches schema, cohort or dispatcher", async () => {
  for (const patch of [{ DAPTA_VOICE_REVIEW_CAMPAIGN_ENABLED: "false" },
    { DAPTA_VOICE_REVIEW_CAMPAIGN_JSON: "{}" }, { DAPTA_WELCOME_VOICE_TOKEN_SECRET: "short" },
    { DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://api.dapta.ai.attacker.invalid/" }]) {
    const f = fixture({ env: environment(patch) });
    const result = await job.runVoiceReviewCampaign(f.deps);
    assert.equal(result.selected, 0); assert.deepEqual(f.operations, []);
  }
});

test("outside a current slot only persists the frozen cohort and does not catch up calls", async () => {
  for (const date of ["2026-10-08T15:00:00Z", "2026-10-09T13:10:00Z", "2026-10-10T13:00:00Z"]) {
    const f = fixture({ clock: () => new Date(date) });
    const result = await job.runVoiceReviewCampaign(f.deps);
    assert.equal(result.configured, true); assert.equal(result.inWindow, false); assert.equal(result.selected, 0);
    assert.deepEqual(f.operations, [["schema"], ["cohort", campaign]]);
  }
});

test("job delegates only the configured campaign and current slot, preserving global false and private report", async () => {
  const f = fixture({ env: Object.freeze(environment()) });
  const result = await job.runVoiceReviewCampaign(f.deps);
  assert.equal(result.enabled, true); assert.equal(result.inWindow, true); assert.equal(result.cohortSize, 13);
  assert.equal(result.accepted, 1); assert.equal(f.env.DAPTA_WELCOME_VOICE_ENABLED, "false");
  assert.deepEqual(f.operations, [["schema"], ["cohort", campaign], ["dispatch", { limit: 3 }],
    ["claim", { campaignId: campaign.id, slot: "2026-10-09T08:00", limit: 3 }],
    ["prepare", claim.eventId], ["accepted", claim.eventId, "synthetic-call"]]);
  assert.equal(JSON.stringify(result).includes(claim.snapshot.phone), false);
  assert.equal(JSON.stringify(result).includes(claim.snapshot.document), false);
  assert.equal(JSON.stringify(result).includes(claim.snapshot.name), false);
  assert.equal("reviewStatus" in result, false);
});

test("a claim that crosses the slot boundary cannot prepare or start an external call", async () => {
  let reads = 0;
  const f = fixture({ clock: () => new Date(reads++ === 0 ? "2026-10-09T13:09:59Z" : "2026-10-09T13:10:00Z") });
  const result = await job.runVoiceReviewCampaign(f.deps);
  assert.equal(result.selected, 1); assert.equal(result.accepted, 0); assert.equal(result.skipped, 1);
  assert.equal(f.operations.some(([operation]) => operation === "prepare" || operation === "accepted"), false);
  assert.deepEqual(f.operations.at(-1), ["failed", claim.eventId, "WINDOW_CLOSED_BEFORE_DISPATCH"]);
});

test("fresh exclusion skips dispatch and unknown provider outcomes use the held marker", async () => {
  const excluded = fixture({ prepare: async () => null });
  const skipped = await job.runVoiceReviewCampaign(excluded.deps);
  assert.equal(skipped.accepted, 0); assert.equal(skipped.skipped, 1);
  const f = fixture({ dispatch: async (options, deps) => {
    const selected = await deps.claim(options);
    await deps.unknown(selected[0].eventId, "DISPATCH_OUTCOME_UNKNOWN");
    return { selected: selected.length, accepted: 0, unknown: 1, skipped: 0 };
  } });
  const result = await job.runVoiceReviewCampaign(f.deps);
  assert.equal(result.unknown, 1);
  assert.deepEqual(f.operations.at(-1), ["unknown", claim.eventId, "DISPATCH_OUTCOME_UNKNOWN"]);
});

test("campaign uses the real dispatcher with the revalidated customer and a scoped signed token", async () => {
  const requests = [];
  const prepared = { ...claim, snapshot: { ...claim.snapshot, phone: "573000000002", name: "OTRO CLIENTE PRUEBA", document: "000654321" } };
  const f = fixture({ prepare: async () => prepared, dispatch: (options, deps) => dispatcher.dispatchCreditWelcomeVoice(options, {
    ...deps, fetcher: async (url, request) => {
      requests.push({ url, request, body: JSON.parse(request.body) });
      return Response.json({ ok: true, call_id: "campaign-native-call" });
    },
  }) });
  const result = await job.runVoiceReviewCampaign(f.deps);
  assert.equal(result.accepted, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].body.to_number, "+" + prepared.snapshot.phone);
  assert.equal(requests[0].body.customer_name, prepared.snapshot.name);
  assert.equal(requests[0].body.customer_document, prepared.snapshot.document);
  assert.equal(JSON.stringify(requests[0].body).includes(claim.snapshot.phone), false);
  const token = identity.verifyWelcomeVoiceToken(requests[0].body.event_token, { secret: f.env.DAPTA_WELCOME_VOICE_TOKEN_SECRET });
  assert.equal(token.eventId, claim.eventId); assert.equal(token.creditId, claim.creditId);
  for (const field of ["snapshot", "initialPayment", "installmentCount", "installmentAmount", "calendar"]) {
    assert.equal(field in requests[0].body, false);
  }
  assert.deepEqual(f.operations.at(-1), ["accepted", claim.eventId, "campaign-native-call"]);
  assert.equal(f.env.DAPTA_WELCOME_VOICE_ENABLED, "false");
});
