import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root,
  "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { parseDaptaAttentionEvent } = await jiti.import("../lib/atencion-dapta-events.ts");
const { createDianaExtensionHandler } = await jiti.import("../lib/diana-extension-api.ts");
const asset = name => fs.readFileSync(path.join(root, "docs/integrations/diana-extensions", name), "utf8");
const gate = asset("event-gate.draft.js");
const normalizer = asset("normalize-action.js");
const flow = JSON.parse(asset("flow.draft.json"));
function run(code, body) {
  const context = { params: { trigger: { body } }, module: { exports: {} } };
  vm.runInNewContext(code, context);
  return JSON.parse(JSON.stringify(context.module.exports));
}
const scope = { workspaceId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222", agentChannelId: "33333333-3333-4333-8333-333333333333",
  phoneNumberId: "10987654321", wabaId: "10987654322" };
const now = new Date("2026-11-02T03:01:00Z");
function event(inbound, text) {
  return { event: inbound ? "new_message_received" : "new_message_sent", delivery_id: "artificial-delivery",
    created_at: "2026-11-02T03:00:00Z", workspace_id: scope.workspaceId, agent_id: scope.agentId,
    agent_channel_id: scope.agentChannelId, phone_number: scope.phoneNumberId,
    conversation: { id: "44444444-4444-4444-8444-444444444444", organization_id: scope.workspaceId,
      text_agent_id: scope.agentId, channel_type: "meta_whatsapp", channel_identifier: "+12025550123",
      metadata: { channel_id: scope.agentChannelId, organization_id: scope.workspaceId, agent_channel_type: "meta_whatsapp" },
      private: "PRIVATE_CONVERSATION" },
    message: { id: "55555555-5555-4555-8555-555555555555", conversation_id: "44444444-4444-4444-8444-444444444444",
      direction: inbound ? "inbound" : "outbound", content_type: "text", content: text,
      sender_identifier: inbound ? "+12025550123" : scope.phoneNumberId,
      recipient_identifier: inbound ? scope.phoneNumberId : "+12025550123",
      status: inbound ? "delivered" : "pending", created_at: "2026-11-02T03:00:00Z",
      metadata: inbound ? {} : { agent_attribution: { agent_id: scope.agentId }, private: "PRIVATE_METADATA" } } };
}
const proposal = { accion: "proponer", cedula: "001234567", folio: "TEST-1", dias: "2",
  valorCompromiso: "100.25", fechaCompromiso: "2026-11-05", motivo: "Motivo artificial de prueba" };

test("the event gate preserves outbound chat sync without forwarding customer text or private fields", () => {
  const result = run(gate, event(false, "PRIVATE_OUTBOUND_TEXT"));
  assert.equal(result.forward, "yes");
  for (const value of ["PRIVATE_OUTBOUND_TEXT", "PRIVATE_CONVERSATION", "PRIVATE_METADATA", '"content":']) {
    assert.equal(result.request_body.includes(value), false);
  }
  const parsed = parseDaptaAttentionEvent(JSON.parse(result.request_body), scope, now);
  assert.equal(parsed.event, "new_message_sent");
  assert.equal(parsed.messageId, "55555555-5555-4555-8555-555555555555");
});

test("padded exact confirmations wake the production parser without granting authority to forwarded text", () => {
  for (const text of ["CONFIRMO PR-0123456789ABCDEF", " CONFIRMO PR-0123456789ABCDEF ",
    "\nCONFIRMO PR-0123456789ABCDEF\r\n"]) {
    const result = run(gate, event(true, text));
    assert.equal(result.forward, "yes");
    assert.equal(result.request_body.includes("CONFIRMO"), false);
    assert.equal(result.request_body.includes('"content":'), false);
    const forwarded = JSON.parse(result.request_body);
    assert.equal(Object.hasOwn(forwarded.message, "metadata"), false);
    assert.equal(forwarded.message.sender_identifier, "+12025550123");
    const parsed = parseDaptaAttentionEvent(forwarded, scope, now, { allowInbound: true });
    assert.equal(parsed.event, "new_message_received");
    assert.throws(() => parseDaptaAttentionEvent(forwarded, scope, now), { code: "DAPTA_EVENT_UNSUPPORTED" });
  }
});

test("ordinary inbound chats, forged variants, media and unrelated events never leave the event gate", () => {
  for (const text of ["Hola", "confirmo PR-0123456789ABCDEF", "CONFIRMO PR-0123456789abcdef",
    "CONFIRMO PR-0123456789ABCDEFX", "CONFIRMO PR-0123456789ABCDEF más texto",
    "CONFIRMO\nPR-0123456789ABCDEF", "CONFIRMO PR-0123456789ABCDEF\nCONFIRMO PR-0123456789ABCDEF"]) {
    assert.deepEqual(run(gate, event(true, text)),
      { ok: true, ignored: true, forward: "no", request_body: "" }, JSON.stringify(text));
  }
  for (const input of [
    { ...event(true, "CONFIRMO PR-0123456789ABCDEF"), event: "conversation_opened" },
    { ...event(true, ""), message: { ...event(true, "").message, content_type: "image", content: "CONFIRMO PR-0123456789ABCDEF" } },
    { ...event(false, "PRIVATE"), message: { ...event(false, "PRIVATE").message, direction: "inbound" } },
    { event: "new_message_received" },
    null,
  ]) assert.equal(run(gate, input).forward, "no");
});

test("the action normalizer accepts direct and body.args payloads and preserves document zeroes", () => {
  const direct = JSON.parse(run(normalizer, proposal).request_body);
  assert.equal(direct.dias, 2);
  assert.equal(direct.valorCompromiso, 100.25);
  assert.equal(direct.cedula, "001234567");
  assert.deepEqual(JSON.parse(run(normalizer, { args: proposal }).request_body), direct);
  const lookup = { accion: "consultar", codigo: "PR-0123456789ABCDEF" };
  assert.deepEqual(JSON.parse(run(normalizer, lookup).request_body), lookup);
  assert.deepEqual(JSON.parse(run(normalizer, { args: lookup }).request_body), lookup);
});

test("the action normalizer rejects mixed envelopes, a model confirmation and unparseable terms", () => {
  for (const input of [
    { args: proposal, accion: "proponer" }, { args: null }, { ...proposal, dias: "5" },
    { ...proposal, valorCompromiso: "1,000" }, { ...proposal, confirmed: true },
    { accion: "consultar", codigo: "PR-0123456789abcdef" },
    { accion: "aprobar", codigo: "PR-0123456789ABCDEF" },
  ]) assert.throws(() => run(normalizer, input));
});

test("the saved flow embeds the reviewed normalizer and uses the native credit response path contract", async () => {
  const http = flow.api_nodes.find(node => node.id === "qryPr");
  const response = flow.api_nodes.find(node => node.id === "rspPr");
  assert.equal(flow.api_nodes.find(node => node.id === "nrmPr").api_action.code_action.code.trim(), normalizer.trim());
  assert.equal(http.api_action.external_api_action.authorization.token, "__DIANA_EXTENSION_API_TOKEN__");
  assert.equal(http.api_action.external_api_action.url, "https://finserpay.com/api/integraciones/diana/prorrogas");
  assert.equal(http.api_action.on_error, "stop");
  assert.deepEqual(http.api_action.response.map(item => item.response_value_path),
    http.api_action.response.map(item => "response." + item.variable_name));
  const token = "test-only-extension-api-token-0123456789";
  const view = { code: "PR-0123456789ABCDEF", status: "PENDING", approved: false, offerText: "Oferta artificial",
    expiresAt: "2026-11-02T03:15:00Z", days: 2, installmentNumber: 1, installmentDueDate: "2026-11-02",
    expiresOn: "2026-11-04", promiseAmount: 100.25, promiseDate: "2026-11-04" };
  const handler = createDianaExtensionHandler({ token: () => token, enabled: () => true,
    propose: async () => view, status: async () => view });
  const backend = await handler(new Request("https://finserpay.test/api/integraciones/diana/prorrogas", {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: run(normalizer, proposal).request_body }));
  assert.equal(backend.status, 200);
  const publicFields = Object.keys(await backend.json()).sort();
  assert.deepEqual(http.api_action.response.map(item => item.variable_name).sort(), publicFields);
  assert.deepEqual(response.api_response.response_params.map(item => item.key).sort(), publicFields);
  for (const item of response.api_response.response_params) {
    assert.equal(item.value, "{{gestionar_prorroga." + item.key + "}}");
  }
});

