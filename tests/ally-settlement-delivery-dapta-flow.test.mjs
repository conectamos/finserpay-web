import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const flow = JSON.parse(await readFile(new URL("../docs/integrations/ally-settlement-dapta/flow.json", import.meta.url), "utf8"));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createSettlementDaptaToken } = await jiti.import("../lib/ally-settlement-delivery-dapta-auth.ts");
const { parseDaptaCallback } = await jiti.import("../lib/ally-settlement-delivery-dapta-callback.ts");
const { settlementDaptaReceipt } = await jiti.import("../lib/ally-settlement-delivery-provider.ts");
const eventId = "11111111-1111-4111-8111-111111111111";
const recipient = "573000000000";
const sender = "573124085562";
const env = { ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "fixture-secret-for-offline-tests-only-12345" };
const input = () => ({ event_id: eventId, recipient, callback_token: createSettlementDaptaToken(eventId, recipient, env) });
const claim = () => ({
  ok: true, authorized: true, event_id: eventId, recipient, sender,
  ally_name: "Aliado de prueba", period_start: "01/10/2026", period_end: "15/10/2026",
  net_amount: "$123.456", filename: "liquidacion-prueba.pdf",
  pdf_url: `https://finserpay.com/api/integraciones/liquidaciones/documento?attempt=${eventId}&expires=1792778000&signature=fixture`,
});
// Shape observed from the authorized fictitious PDF delivery on 2026-10-23.
// The provider id stays synthetic so no test-recipient identifier is committed.
const nativeAccepted = () => ({
  success: true, status: "sent", message: "Template sent successfully",
  template_id: "71f2b7b4-64de-494b-91d8-6db523276c32",
  scheduled: false, workflow_id: null, send_at: null,
  suppressed: false, suppression_reason: null, provider_message_id: "wamid.fixture123==",
});
const nodeKey = node => node.name.trim().replace(/ /g, "_").toLowerCase();
const lookup = (params, path) => path.split(".").reduce((value, key) => value?.[key], params);
function interpolate(value, params) {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([^}]+)\}\}$/);
    if (exact) return lookup(params, exact[1]);
    return value.replace(/\{\{([^}]+)\}\}/g, (_, path) => String(lookup(params, path) ?? ""));
  }
  if (Array.isArray(value)) return value.map(item => interpolate(item, params));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, params)]));
  return value;
}

// Executes the saved graph's actual Code nodes in a VM without fetch, process or
// require. Every HTTP/native operation below is an injected in-memory fixture.
function execute({ body = input(), claimResult = claim(), nativeResult = nativeAccepted(), receiptFails = false } = {}) {
  const nodes = new Map(flow.api_nodes.map(node => [node.id, node]));
  const params = { trigger: { body } }, visited = [], nativeCalls = [], callbacks = [];
  let current = flow.api_nodes.find(node => node.type === "trigger").id;
  for (let step = 0; step < 30; step += 1) {
    const node = nodes.get(current);
    assert.ok(node, `graph target exists: ${current}`);
    visited.push(node.id);
    if (node.type === "trigger") { current = node.childRef; continue; }
    if (node.type === "response") return { response: Object.fromEntries(node.api_response.response_params.map(({ key, value }) => [key, interpolate(value, params)])), visited, nativeCalls, callbacks };
    if (node.type === "conditional") {
      const condition = node.api_conditional.conditionalGroups[0].conditionals[0];
      assert.equal(condition.operator, "eq");
      current = interpolate(condition.partOne, params) === condition.partTwo ? node.childTrue : node.childFalse;
      continue;
    }
    const action = node.api_action;
    let output;
    if (action.action_type === "code") {
      const context = { params, module: { exports: {} } };
      new vm.Script(action.code_action.code).runInNewContext(context, { timeout: 1000 });
      output = structuredClone(context.module.exports);
    } else if (action.action_type === "api") {
      const api = action.external_api_action;
      assert.equal(api.request_type, "post");
      assert.equal(api.url, "https://finserpay.com/api/integraciones/liquidaciones/dapta");
      const request = JSON.parse(interpolate(api.body, params));
      callbacks.push({ body: request, authorization: interpolate(api.authorization.token, params), authorizationType: api.authorization.type });
      output = { response: request.action === "claim" ? claimResult : receiptFails ? { error: "fixture network ambiguity" } : { ok: true, reconciled: true } };
    } else if (action.action_type === "custom.dapta_send_whatsapp_templatev2") {
      nativeCalls.push(interpolate(action.custom_action.values, params));
      output = { response: nativeResult };
    } else assert.fail(`unexpected action: ${action.action_type}`);
    params[nodeKey(node)] = Object.fromEntries(action.response.map(({ variable_name, response_value_path }) => [variable_name, lookup(output, response_value_path)]));
    current = node.childRef;
  }
  assert.fail("flow did not terminate");
}

test("the real flow blocks disabled, duplicate or malformed claim responses before WhatsApp", () => {
  for (const response of [{ ok: true, authorized: false }, { error: "fixture unavailable" }, null, {}, { ok: true, authorized: "true" }]) {
    const result = execute({ claimResult: response });
    assert.equal(result.nativeCalls.length, 0);
    assert.equal(result.callbacks.length, 1);
    assert.equal(result.response.accepted, false);
    assert.equal(result.response.code, "CLAIM_DENIED");
    assert.ok(!result.visited.includes("sndWa"));
  }
});

test("replaying one event with a denied second claim never invokes WhatsApp twice", () => {
  const first = execute();
  const duplicate = execute({ claimResult: { ok: true, authorized: false } });
  assert.equal(first.nativeCalls.length + duplicate.nativeCalls.length, 1);
  assert.equal(duplicate.response.accepted, false);
});

test("only the configured fixed line/template and the database claim supply PDF and four variables", () => {
  const result = execute({ body: { ...input(), ally_name: "Untrusted input", pdf_url: "https://example.invalid/wrong.pdf", template_id: "wrong", filename: "wrong.pdf" } });
  assert.equal(result.nativeCalls.length, 1);
  const request = result.nativeCalls[0];
  assert.equal(request.agent_channel_id, "6933b28b-b0a1-400c-aa1e-54f75bfbbd91");
  assert.equal(request.template_id, "71f2b7b4-64de-494b-91d8-6db523276c32");
  assert.equal(request.to_number, `+${recipient}`);
  assert.equal(request.header_media_url, claim().pdf_url);
  assert.deepEqual(request.variables, [
    { key: "var_1", value: claim().ally_name }, { key: "var_2", value: claim().period_start },
    { key: "var_3", value: claim().period_end }, { key: "var_4", value: claim().net_amount },
  ]);
});

test("claim correlation, official sender and PDF origin mismatches stop the graph", () => {
  for (const patch of [
    { event_id: "22222222-2222-4222-8222-222222222222" }, { recipient: "573000000001" },
    { sender: "573000000001" }, { pdf_url: "https://example.invalid/wrong.pdf" },
    { ally_name: "" }, { net_amount: "100\n" },
  ]) assert.throws(() => execute({ claimResult: { ...claim(), ...patch } }), /Autorizacion inconsistente/);
});

test("malformed event, recipient or token stops before the first callback", () => {
  for (const patch of [{ event_id: "bad" }, { recipient: "email@example.invalid" }, { callback_token: "bad" }, { callback_token: `${input().callback_token}\r\nInjected: yes` }]) {
    assert.throws(() => execute({ body: { ...input(), ...patch } }), /no valid/);
  }
});

test("real provider receipt is compatible with both application parsers and reuses scoped authorization", () => {
  const body = input();
  const result = execute({ body });
  assert.equal(result.response.accepted, true);
  assert.deepEqual(settlementDaptaReceipt({ response: result.response }, eventId, recipient), { status: "ACCEPTED", providerId: "wamid.fixture123==" });
  const receipt = result.callbacks.find(callback => callback.body.action === "receipt");
  assert.equal(parseDaptaCallback(receipt.body).outcome, "SENT");
  assert.equal(receipt.body.status, "accepted");
  assert.equal(receipt.body.sender, sender);
  assert.equal(receipt.body.provider_message_id, "wamid.fixture123==");
  assert.ok(result.callbacks.every(callback => callback.authorization === body.callback_token && callback.authorizationType === "bearer"));
  assert.ok(!JSON.stringify(result.response).includes(body.callback_token));
  assert.ok(!JSON.stringify(receipt.body).includes(body.callback_token));
});

test("missing or ambiguous provider receipts never report success or permit a blind resend", () => {
  for (const nativeResult of [
    { success: true, status: "sent", suppressed: false },
    { ...nativeAccepted(), provider_message_id: "internal-job-id" },
    { ...nativeAccepted(), suppressed: true }, { ...nativeAccepted(), scheduled: true },
    { ...nativeAccepted(), error: "fixture ambiguity" }, { success: false, status: "failed" },
    [nativeAccepted(), { ...nativeAccepted(), provider_message_id: "wamid.other123==" }],
  ]) {
    const result = execute({ nativeResult });
    assert.equal(result.response.accepted, false);
    assert.equal(result.response.provider_message_id, null);
    assert.equal(result.response.code, "PROVIDER_RECEIPT_UNCONFIRMED");
    const receipt = result.callbacks.find(callback => callback.body.action === "receipt").body;
    assert.equal(receipt.status, "uncertain");
    assert.equal(parseDaptaCallback(receipt).outcome, "UNCERTAIN");
  }
});

test("a receipt callback failure still returns the real synchronous acknowledgement for persistence", () => {
  const result = execute({ receiptFails: true });
  assert.equal(result.response.accepted, true);
  assert.deepEqual(settlementDaptaReceipt(result.response, eventId, recipient), { status: "ACCEPTED", providerId: "wamid.fixture123==" });
  assert.equal(result.nativeCalls.length, 1);
});

test("the versioned definition carries no static credential, trigger secret or real settlement", () => {
  assert.equal(flow.api_key, undefined);
  assert.equal(flow.end_point, undefined);
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["token", "password", "username", "credential"].includes(key)) assert.ok(child === "" || child === "{{normalizar_evento.callback_token}}");
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(flow);
  assert.equal(flow.api_nodes.filter(node => node.api_action?.action_type === "custom.dapta_send_whatsapp_templatev2").length, 1);
});
