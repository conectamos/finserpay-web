import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const core = await createJiti(import.meta.url).import("../lib/credit-welcome-voice-core.ts");
const dispatch = loadReissueModule("lib/credit-welcome-voice-dispatch.ts", {
  "@/lib/credit-welcome-voice-core": core, "@/lib/credit-welcome-voice-store": {},
}, { AbortSignal });
const config = { webhookUrl: "https://api.dapta.ai/test-private-flow", secret: "synthetic-welcome-secret-32-bytes-or-more",
  agentId: "923f7952-87bc-4f1f-a77d-1972302200ee" };
const claim = { eventId: "25ea074e-a7e5-4f2c-8c8e-e64258fe345d", creditId: 72,
  snapshot: { phone: "573000000001", name: "TEST PERSON", document: "000123456", initialPayment: 123 } };
function fixture(overrides = {}) {
  const received = []; const states = [];
  const deps = { config, ensureSchema: async () => {}, claim: async () => [claim], prepare: async () => claim,
    accepted: async (...args) => { states.push(["accepted", ...args]); },
    failed: async (...args) => { states.push(["failed", ...args]); },
    unknown: async (...args) => { states.push(["unknown", ...args]); },
    fetcher: async (url, options) => {
      received.push({ url, options, body: JSON.parse(options.body) });
      return Response.json({ ok: true, call_id: "call-test-123" });
    }, ...overrides };
  return { deps, received, states };
}
test("configuration is restricted to the private Dapta origin and complete credentials", () => {
  const env = { DAPTA_WELCOME_VOICE_ENABLED: "true", DAPTA_WELCOME_VOICE_WEBHOOK_URL: config.webhookUrl,
    DAPTA_WELCOME_VOICE_TOKEN_SECRET: config.secret, DAPTA_WELCOME_VOICE_AGENT_ID: config.agentId };
  assert.deepEqual(JSON.parse(JSON.stringify(dispatch.getCreditWelcomeVoiceConfig(env))), config);
  for (const patch of [{ DAPTA_WELCOME_VOICE_ENABLED: "false" }, { DAPTA_WELCOME_VOICE_TOKEN_SECRET: "short" },
    { DAPTA_WELCOME_VOICE_AGENT_ID: "existing-unknown-agent" },
    { DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://api.dapta.ai.evil.invalid/" },
    { DAPTA_WELCOME_VOICE_WEBHOOK_URL: "https://user:secret@api.dapta.ai/" }]) {
    assert.equal(dispatch.getCreditWelcomeVoiceConfig({ ...env, ...patch }), null);
  }
});
test("disabled or incomplete configuration does not query the queue or place calls", async () => {
  const f = fixture({ config: null, ensureSchema: async () => assert.fail("Must not touch DB") });
  const result = await dispatch.dispatchCreditWelcomeVoice({}, f.deps);
  assert.equal(result.selected, 0); assert.equal(f.received.length, 0);
});
test("dispatch sends destination plus scoped token, withholding identity and financial conditions", async () => {
  const f = fixture();
  const result = await dispatch.dispatchCreditWelcomeVoice({}, f.deps);
  assert.equal(result.accepted, 1);
  assert.deepEqual(Object.keys(f.received[0].body).sort(), ["credito_id", "event_id", "event_token", "to_number"]);
  assert.equal(f.received[0].body.to_number, "+573000000001");
  assert.equal(f.received[0].options.redirect, "error");
  const token = core.verifyWelcomeVoiceToken(f.received[0].body.event_token, { secret: config.secret });
  assert.equal(token.creditId, 72); assert.equal(token.eventId, claim.eventId);
  assert.deepEqual(f.states, [["accepted", claim.eventId, "call-test-123"]]);
});
test("credit cancelled or contact changed after claim never reaches Dapta", async () => {
  const f = fixture({ prepare: async () => null });
  const result = await dispatch.dispatchCreditWelcomeVoice({}, f.deps);
  assert.equal(result.skipped, 1); assert.equal(f.received.length, 0); assert.equal(f.states.length, 0);
});
test("timeout, HTTP errors, empty receipts and execution errors become unknown with one request only", async () => {
  for (const response of [null, { ok: false }, { ok: true }, { error: "native action failed", ok: true, call_id: "wrong" },
    { ok: false, response: { ok: true, call_id: "wrong" } },
    { ok: true, call_id: "wrong", enviar_llamada: { error: "native failure" } },
    { response: { ok: true, call_id: "native-id" }, error: "outer execution failed" }, "not-json", 500]) {
    let requests = 0;
    const f = fixture({ fetcher: async () => {
      requests++;
      if (response === null) throw new Error("timeout with private URL");
      if (response === 500) return Response.json({ ok: true, call_id: "maybe-placed" }, { status: 500 });
      return Response.json(response);
    } });
    const result = await dispatch.dispatchCreditWelcomeVoice({}, f.deps);
    assert.equal(result.unknown, 1); assert.equal(result.accepted, 0); assert.equal(requests, 1);
    assert.deepEqual(f.states, [["unknown", claim.eventId]]);
  }
});
test("receipt accepts only explicit call ids in supported wrappers", () => {
  assert.equal(dispatch.welcomeVoiceReceipt({ response: { result: { ok: true, call_id: "call-native" } } }), "call-native");
  for (const value of [[], "accepted", { ok: true, call_id: "" }, { ok: true, call_id: "https://public.invalid/" },
    { variables: { ok: true, call_id: "invented" } }]) assert.equal(dispatch.welcomeVoiceReceipt(value), null);
});
