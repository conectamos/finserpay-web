import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { parseControlledWelcomeVoiceTestArgs, runControlledWelcomeVoiceTest } from "../scripts/test-credit-welcome-voice.mjs";

const core = await createJiti(import.meta.url).import("../lib/credit-welcome-voice-core.ts");
const dispatch = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-store": {},
}, { AbortSignal });
const claim = { eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 72,
  snapshot: { phone: "573000000001", name: "TEST PERSON", document: "000123456" } };
const input = { creditId: 72, expectedPhone: "+573000000001" };
const safe = value => JSON.parse(JSON.stringify(value));
function fixture(overrides = {}) {
  const requests = [], changes = [], prepared = [];
  let attempted = false;
  const env = { DAPTA_WELCOME_VOICE_ENABLED: "false", DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://api.dapta.ai/test-private-flow",
    DAPTA_WELCOME_VOICE_TOKEN_SECRET: "synthetic-welcome-secret-32-bytes-or-more",
    DAPTA_WELCOME_VOICE_AGENT_ID: "923f7952-87bc-4f1f-a77d-1972302200ee" };
  const store = {
    claimPendingCreditWelcomeVoice: () => assert.fail("The global queue must never be selected"),
    prepareCreditWelcomeVoiceControlledTest: async value => {
      assert.deepEqual(value, input);
      if (attempted) throw Object.assign(new Error("Already attempted"), { code: "CONTROLLED_TEST_ALREADY_ATTEMPTED" });
      attempted = true; prepared.push(value); return claim;
    },
    prepareCreditWelcomeVoiceDispatch: async eventId => { assert.equal(eventId, claim.eventId); return claim; },
    markCreditWelcomeVoiceDispatchAccepted: async (...values) => { changes.push(["accepted", ...values]); },
    markCreditWelcomeVoiceDispatchFailed: async (...values) => { changes.push(["failed", ...values]); },
    markCreditWelcomeVoiceDispatchUnknown: async (...values) => { changes.push(["unknown", ...values]); },
  };
  const deps = { env, store, getConfig: dispatch.getCreditWelcomeVoiceConfig, dispatch: dispatch.dispatchCreditWelcomeVoice,
    ensureSchema: async () => {}, fetcher: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true, call_id: "controlled-call-1" });
    }, ...overrides };
  return { deps, store, env, requests, changes, prepared };
}

test("CLI requires exactly one chosen credit and expected number, never accepts secrets as arguments", () => {
  assert.deepEqual(parseControlledWelcomeVoiceTestArgs(["--credit-id", "72", "--expected-phone", "+573000000001"]), input);
  assert.equal(parseControlledWelcomeVoiceTestArgs(["--help"]), null);
  for (const args of [[], ["--credit-id", "0", "--expected-phone", "+573000000001"],
    ["--credit-id", "1e2", "--expected-phone", "+573000000001"],
    ["--credit-id", "72"], ["--credit-id", "72", "--credit-id", "73", "--expected-phone", "+573000000001"],
    ["--credit-id", "72", "--expected-phone", "+573000000001", "--secret", "synthetic"]]) {
    assert.throws(() => parseControlledWelcomeVoiceTestArgs(args), error => error.code === "INVALID_ARGUMENTS");
  }
});

test("directed helper signs and dispatches exactly the chosen event while the service flag remains disabled", async () => {
  const f = fixture();
  const result = await runControlledWelcomeVoiceTest(input, f.deps);
  assert.deepEqual(result, { eventId: claim.eventId, creditId: 72, status: "ACCEPTED" });
  assert.equal(f.env.DAPTA_WELCOME_VOICE_ENABLED, "false");
  assert.equal(f.requests.length, 1);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.requests[0].body.to_number, "+573000000001");
  const token = core.verifyWelcomeVoiceToken(f.requests[0].body.event_token, { secret: f.env.DAPTA_WELCOME_VOICE_TOKEN_SECRET });
  assert.equal(token.eventId, claim.eventId); assert.equal(token.creditId, 72);
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), ["credito_id", "event_id", "event_token", "to_number"]);
  assert.deepEqual(f.changes, [["accepted", claim.eventId, "controlled-call-1"]]);
  assert.deepEqual(Object.keys(result).sort(), ["creditId", "eventId", "status"]);
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  assert.equal(f.requests.length, 1);
});

test("invalid configuration stops before schema preparation, and wrong contact never reaches Dapta", async () => {
  for (const patch of [{ DAPTA_WELCOME_VOICE_ENABLED: "true" }, { DAPTA_WELCOME_VOICE_ENABLED: undefined },
    { DAPTA_WELCOME_VOICE_ENABLED: "FALSE" }, { DAPTA_WELCOME_VOICE_ENABLED: "off" },
    { DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://api.dapta.ai.evil.invalid/" },
    { DAPTA_WELCOME_VOICE_TOKEN_SECRET: "short" }]) {
    const f = fixture({ ensureSchema: () => assert.fail("No DB mutation expected") });
    Object.assign(f.env, patch);
    await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps));
    assert.equal(f.prepared.length, 0); assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  f.store.prepareCreditWelcomeVoiceControlledTest = async () => {
    throw Object.assign(new Error("Private contact mismatch"), { code: "CONTROLLED_TEST_PHONE_MISMATCH" });
  };
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_PHONE_MISMATCH");
  assert.equal(f.requests.length, 0);
});

test("postclaim cancellation or changed identity suppresses the one controlled HTTP request", async () => {
  const f = fixture();
  f.store.prepareCreditWelcomeVoiceDispatch = async () => null;
  assert.equal((await runControlledWelcomeVoiceTest(input, f.deps)).status, "SKIPPED");
  assert.equal(f.requests.length, 0);
  assert.equal(f.changes.length, 0);
});

test("the local helper refuses a mismatched credit/event returned by dependencies", async () => {
  for (const patch of [{ creditId: 73 }, { eventId: "d290173a-06f4-41a4-a7b0-728b0f07c1b9" },
    { snapshot: { phone: "573000000099" } }]) {
    const f = fixture();
    f.store.prepareCreditWelcomeVoiceDispatch = async () => ({ ...claim, ...patch });
    await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_SCOPE_MISMATCH");
    assert.equal(f.requests.length, 0);
  }
});

test("an ambiguous controlled request stays UNKNOWN and re-running never sends another request", async () => {
  const f = fixture({ fetcher: async () => { throw new Error("Synthetic timeout"); } });
  const first = await runControlledWelcomeVoiceTest(input, f.deps);
  assert.deepEqual(safe(first), { eventId: claim.eventId, creditId: 72, status: "UNKNOWN" });
  assert.deepEqual(f.changes, [["unknown", claim.eventId, undefined]]);
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  assert.equal(f.prepared.length, 1);
});
