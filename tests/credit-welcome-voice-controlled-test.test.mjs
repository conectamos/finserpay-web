import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { parseControlledWelcomeVoiceTestArgs, runControlledWelcomeVoiceTest } from "../scripts/test-credit-welcome-voice.mjs";

const core = await createJiti(import.meta.url).import("../lib/credit-welcome-voice-core.ts");
const speech = loadReissueModule("lib/credit-welcome-voice-speech.ts", { "@/lib/credit-welcome-voice-core": core });
const { normalizeColombianMobile } = await createJiti(import.meta.url).import("../lib/dapta-welcome.ts");
const dispatch = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-store": {}, "@/lib/credit-welcome-voice-speech": speech,
}, { AbortSignal });
const claim = Object.freeze({ eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 72,
  snapshot: Object.freeze({ phone: "573000000001", name: "TEST PERSON", document: "000123456" }) });
const input = { creditId: 72, expectedPhone: "+573000000001", testPhone: "+573000000099" };
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
      assert.deepEqual(value, { creditId: input.creditId, expectedPhone: input.expectedPhone });
      if (attempted) throw Object.assign(new Error("Already attempted"), { code: "CONTROLLED_TEST_ALREADY_ATTEMPTED" });
      attempted = true; prepared.push(value); return claim;
    },
    prepareCreditWelcomeVoiceDispatch: async eventId => { assert.equal(eventId, claim.eventId); return claim; },
    markCreditWelcomeVoiceDispatchAccepted: async (...values) => { changes.push(["accepted", ...values]); },
    markCreditWelcomeVoiceDispatchFailed: async (...values) => { changes.push(["failed", ...values]); },
    markCreditWelcomeVoiceDispatchUnknown: async (...values) => { changes.push(["unknown", ...values]); },
  };
  const deps = { env, store, getConfig: dispatch.getCreditWelcomeVoiceConfig, dispatch: dispatch.dispatchCreditWelcomeVoice,
    normalizePhone: normalizeColombianMobile,
    ensureSchema: async () => {}, fetcher: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return Response.json({ ok: true, call_id: "controlled-call-1" });
    }, ...overrides };
  return { deps, store, env, requests, changes, prepared };
}

test("CLI requires one credit, its expected contact and an explicit test destination, never secret arguments", () => {
  assert.deepEqual(parseControlledWelcomeVoiceTestArgs(["--credit-id", "72", "--expected-phone", "+573000000001", "--test-phone", "+573000000099"]), input);
  assert.equal(parseControlledWelcomeVoiceTestArgs(["--help"]), null);
  for (const args of [[], ["--credit-id", "0", "--expected-phone", "+573000000001", "--test-phone", "+573000000099"],
    ["--credit-id", "1e2", "--expected-phone", "+573000000001", "--test-phone", "+573000000099"],
    ["--credit-id", "72", "--expected-phone", "+573000000001"],
    ["--credit-id", "72", "--test-phone", "+573000000099"],
    ["--credit-id", "72"], ["--credit-id", "72", "--credit-id", "73", "--expected-phone", "+573000000001"],
    ["--credit-id", "72", "--expected-phone", "+573000000001", "--secret", "synthetic"]]) {
    assert.throws(() => parseControlledWelcomeVoiceTestArgs(args), error => error.code === "INVALID_ARGUMENTS");
  }
});

test("CLI accepts repeat-of only as an explicit strict event UUID and leaves default calls unchanged", () => {
  const args = ["--credit-id", "72", "--expected-phone", "+573000000001", "--test-phone", "+573000000099"];
  assert.equal("repeatOf" in parseControlledWelcomeVoiceTestArgs(args), false);
  assert.deepEqual(parseControlledWelcomeVoiceTestArgs([...args, "--repeat-of", claim.eventId]), { ...input, repeatOf: claim.eventId });
  assert.deepEqual(parseControlledWelcomeVoiceTestArgs([...args, "--repeat-of", claim.eventId.toUpperCase()]),
    { ...input, repeatOf: claim.eventId.toUpperCase() });
  for (const repeatOf of ["", "not-a-uuid", "call_" + claim.eventId, " " + claim.eventId, claim.eventId + " ",
    "00000000-0000-0000-0000-000000000000", "25ea074e-a7e5-0f2c-8c8e-e64258fe345d", "25ea074e-a7e5-4f2c-0c8e-e64258fe345d"]) {
    assert.throws(() => parseControlledWelcomeVoiceTestArgs([...args, "--repeat-of", repeatOf]), error => error.code === "INVALID_ARGUMENTS");
  }
  for (const trailing of [["--repeat-of"], ["--repeat-of", claim.eventId, "--repeat-of", claim.eventId],
    ["--repeat-of", claim.eventId, "--secret", "synthetic"]]) {
    assert.throws(() => parseControlledWelcomeVoiceTestArgs([...args, ...trailing]), error => error.code === "INVALID_ARGUMENTS");
  }
});

test("invalid repeat IDs stop before schema, event preparation and HTTP", async () => {
  for (const repeatOf of [null, "", "not-a-uuid", 1, [], {}, claim.eventId + " ", "00000000-0000-0000-0000-000000000000"]) {
    const f = fixture({ ensureSchema: () => assert.fail("Must stop before schema preparation") });
    await assert.rejects(runControlledWelcomeVoiceTest({ ...input, repeatOf }, f.deps), error => error.code === "INVALID_ARGUMENTS");
    assert.equal(f.prepared.length, 0); assert.equal(f.requests.length, 0);
  }
});

test("an explicit repeat passes only its parent to storage, dispatches one fresh event and signs only the new event", async () => {
  const f = fixture();
  const fresh = { ...claim, eventId: "df3b0367-fcee-4ed8-b0a5-559ae3e7b299" };
  const repeatInput = { ...input, repeatOf: claim.eventId };
  let repeated = false;
  f.store.prepareCreditWelcomeVoiceControlledTest = async value => {
    assert.deepEqual(value, { creditId: input.creditId, expectedPhone: input.expectedPhone, repeatOf: claim.eventId });
    if (repeated) throw Object.assign(new Error("Parent already repeated"), { code: "CONTROLLED_TEST_ALREADY_REPEATED" });
    repeated = true; f.prepared.push(safe(value)); return fresh;
  };
  f.store.prepareCreditWelcomeVoiceDispatch = async eventId => { assert.equal(eventId, fresh.eventId); return fresh; };
  const result = await runControlledWelcomeVoiceTest(repeatInput, f.deps);
  assert.deepEqual(result, { eventId: fresh.eventId, creditId: input.creditId, status: "ACCEPTED" });
  assert.equal(f.env.DAPTA_WELCOME_VOICE_ENABLED, "false");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.event_id, fresh.eventId);
  assert.equal(f.requests[0].body.to_number, input.testPhone);
  assert.equal("repeatOf" in f.requests[0].body, false);
  assert.equal("repeat_of" in f.requests[0].body, false);
  const token = core.verifyWelcomeVoiceToken(f.requests[0].body.event_token, { secret: f.env.DAPTA_WELCOME_VOICE_TOKEN_SECRET });
  assert.equal(token.eventId, fresh.eventId); assert.notEqual(token.eventId, repeatInput.repeatOf);
  assert.equal(token.creditId, input.creditId);
  assert.deepEqual(f.changes, [["accepted", fresh.eventId, "controlled-call-1"]]);
  assert.deepEqual(safe(claim.snapshot), { phone: "573000000001", name: "TEST PERSON", document: "000123456" });
  await assert.rejects(runControlledWelcomeVoiceTest(repeatInput, f.deps), error => error.code === "CONTROLLED_TEST_ALREADY_REPEATED");
  assert.equal(f.requests.length, 1); assert.equal(f.prepared.length, 1);
});

test("repeat cannot reuse its parent event or cross the credit/contact boundary", async () => {
  for (const repeatedClaim of [claim, { ...claim, eventId: claim.eventId.toUpperCase() },
    { ...claim, eventId: "df3b0367-fcee-4ed8-b0a5-559ae3e7b299", creditId: 73 },
    { ...claim, eventId: "df3b0367-fcee-4ed8-b0a5-559ae3e7b299", snapshot: { ...claim.snapshot, phone: "573000000088" } }]) {
    const f = fixture();
    f.store.prepareCreditWelcomeVoiceControlledTest = async () => repeatedClaim;
    await assert.rejects(runControlledWelcomeVoiceTest({ ...input, repeatOf: claim.eventId }, f.deps),
      error => error.code === "CONTROLLED_TEST_SCOPE_MISMATCH");
    assert.equal(f.requests.length, 0); assert.equal(f.changes.length, 0);
  }
});

test("repeat retains disabled-feature and explicit test-number guards before storage", async () => {
  for (const patch of [{ testPhone: undefined }, { testPhone: "+12025550123" }, { expectedPhone: "not-a-phone" }]) {
    const f = fixture({ ensureSchema: () => assert.fail("Must stop before schema preparation") });
    await assert.rejects(runControlledWelcomeVoiceTest({ ...input, repeatOf: claim.eventId, ...patch }, f.deps),
      error => error.code === "INVALID_ARGUMENTS");
    assert.equal(f.requests.length, 0); assert.equal(f.prepared.length, 0);
  }
  const f = fixture({ ensureSchema: () => assert.fail("Must stop before schema preparation") });
  f.env.DAPTA_WELCOME_VOICE_ENABLED = "true";
  await assert.rejects(runControlledWelcomeVoiceTest({ ...input, repeatOf: claim.eventId }, f.deps),
    error => error.code === "GLOBAL_FEATURE_MUST_BE_DISABLED");
  assert.equal(f.requests.length, 0); assert.equal(f.prepared.length, 0);
});

test("directed helper calls only the distinct test phone, retaining the real immutable snapshot and disabled service flag", async () => {
  const f = fixture();
  const savedSnapshot = safe(claim.snapshot);
  const result = await runControlledWelcomeVoiceTest(input, f.deps);
  assert.deepEqual(result, { eventId: claim.eventId, creditId: 72, status: "ACCEPTED" });
  assert.equal(f.env.DAPTA_WELCOME_VOICE_ENABLED, "false");
  assert.equal(f.requests.length, 1);
  assert.equal(f.prepared.length, 1);
  assert.equal(f.requests[0].body.to_number, input.testPhone);
  assert.equal(JSON.stringify(f.requests[0].body).includes(claim.snapshot.phone), false);
  assert.deepEqual(safe(claim.snapshot), savedSnapshot);
  assert.deepEqual(f.prepared, [{ creditId: 72, expectedPhone: "+573000000001" }]);
  const token = core.verifyWelcomeVoiceToken(f.requests[0].body.event_token, { secret: f.env.DAPTA_WELCOME_VOICE_TOKEN_SECRET });
  assert.equal(token.eventId, claim.eventId); assert.equal(token.creditId, 72);
  assert.deepEqual(Object.keys(f.requests[0].body).sort(), ["credito_id", "customer_document", "customer_document_spoken", "customer_name", "customer_name_spoken", "event_id", "event_token", "to_number"]);
  assert.deepEqual(f.changes, [["accepted", claim.eventId, "controlled-call-1"]]);
  assert.deepEqual(Object.keys(result).sort(), ["creditId", "eventId", "status"]);
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  assert.equal(f.requests.length, 1);
});

test("missing or invalid test destination blocks before schema, claim and HTTP without using the real phone", async () => {
  for (const testPhone of [undefined, null, "", "not-a-phone", "+12025550123", "+57300000009", "x".repeat(81)]) {
    const f = fixture({ ensureSchema: () => assert.fail("Must stop before schema preparation") });
    await assert.rejects(runControlledWelcomeVoiceTest({ ...input, testPhone }, f.deps), error => error.code === "INVALID_ARGUMENTS");
    assert.equal(f.prepared.length, 0);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(safe(claim.snapshot), { phone: "573000000001", name: "TEST PERSON", document: "000123456" });
  }
});

test("test destination is normalized separately and is never passed to persisted-event preparation", async () => {
  const f = fixture();
  const result = await runControlledWelcomeVoiceTest({ ...input, testPhone: "300 000 0099" }, f.deps);
  assert.equal(result.status, "ACCEPTED");
  assert.equal(f.requests[0].body.to_number, "+573000000099");
  assert.deepEqual(f.prepared, [{ creditId: 72, expectedPhone: "+573000000001" }]);
  assert.equal(claim.snapshot.phone, "573000000001");
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
  const f = fixture();
  f.store.prepareCreditWelcomeVoiceControlledTest = async () => ({ ...claim, snapshot: { ...claim.snapshot, phone: "573000000088" } });
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_SCOPE_MISMATCH");
  assert.equal(f.requests.length, 0);
});

test("an ambiguous controlled request stays UNKNOWN and re-running never sends another request", async () => {
  const f = fixture({ fetcher: async () => { throw new Error("Synthetic timeout"); } });
  const first = await runControlledWelcomeVoiceTest(input, f.deps);
  assert.deepEqual(safe(first), { eventId: claim.eventId, creditId: 72, status: "UNKNOWN" });
  assert.deepEqual(f.changes, [["unknown", claim.eventId, undefined]]);
  await assert.rejects(runControlledWelcomeVoiceTest(input, f.deps), error => error.code === "CONTROLLED_TEST_ALREADY_ATTEMPTED");
  assert.equal(f.prepared.length, 1);
});
