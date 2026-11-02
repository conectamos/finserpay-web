import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: {
  "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js"),
} });
const { createDaptaAttentionAdapter } = await jiti.import("../lib/atencion-dapta.ts");
const workspace = "00000000-0000-4000-8000-000000000001";
const agent = "00000000-0000-4000-8000-000000000002";
const externalConversationId = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";
const otherMessageId = "00000000-0000-4000-8000-000000000005";
const contactId = "12025550100";
const env = { DAPTA_MCP_API_KEY: "test-only-event-reader-secret", DAPTA_ATTENTION_WORKSPACE_ID: workspace, DAPTA_ATTENTION_AGENT_ID: agent };
const input = { externalConversationId, contactId, messageId };
const conversation = { id: externalConversationId, text_agent_id: agent,
  channel_type: "meta_whatsapp", channel_identifier: `+${contactId}` };
const message = { id: messageId, kind: "agent", direction: "outbound", content_type: "text",
  content: "Respuesta artificial de prueba", created_at: "2026-11-01 20:00:00.123456-05", status: "delivered" };
const detail = (messages = [message], extra = {}) => ({ workspace_id: workspace, conversation,
  messages, messages_next_cursor: null, fresh: { applied: true, source: "live", private: "PRIVATE_FRESH" }, ...extra });
function mock(onRead = () => detail(), direct) {
  const requests = [], closed = [];
  const transport = async (url, init) => {
    assert.equal(url, "https://mcp.dapta.ai/mcp");
    assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error");
    if (init.method === "DELETE") {
      closed.push(init.headers["Mcp-Session-Id"]);
      return new Response(null, { status: 204 });
    }
    assert.equal(init.method, "POST");
    const rpc = JSON.parse(init.body); requests.push(rpc);
    if (direct) { const response = await direct(rpc); if (response) return response; }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} } };
    else {
      assert.equal(rpc.method, "tools/call"); assert.equal(rpc.params.name, "get_conversation");
      assert.equal(rpc.params.arguments.workspace_id, undefined);
      result = { structuredContent: await onRead(rpc.params.arguments) };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }),
      { headers: { "content-type": "application/json", "Mcp-Session-Id": "test-event-session" } });
  };
  return { adapter: createDaptaAttentionAdapter({ env, fetch: transport }), requests, closed };
}

test("confirmed event reads only its exact conversation, fresh, without discovery or state/tool payloads", async () => {
  const f = mock(); const result = await f.adapter.fetchConfirmedEventMessage(input);
  assert.deepEqual(f.requests.map(r => r.method), ["initialize", "notifications/initialized", "tools/call"]);
  assert.deepEqual(f.requests[2].params.arguments, { agent_id: agent, conversation_id: externalConversationId,
    include_messages: true, include_state: false, include_tool_payloads: false, fresh: true, messages_limit: 100 });
  assert.deepEqual(result, { source: { workspaceId: workspace, agentId: agent, externalConversationId, contactId },
    state: "confirmed", historyCursor: null, historyTruncated: false,
    message: { id: messageId, text: message.content, sentAt: "2026-11-02T01:00:00.123Z", status: "delivered", direction: "outbound", contentType: "text" } });
  assert.deepEqual(f.closed, ["test-event-session"]);
  assert.equal(JSON.stringify(result).includes("PRIVATE_FRESH"), false);
});

test("invalid descriptors or configuration never make a network request", async () => {
  const disabled = createDaptaAttentionAdapter({ env: {}, fetch: () => assert.fail("must not call network") });
  await assert.rejects(disabled.fetchConfirmedEventMessage(input), { code: "NOT_CONFIGURED" });
  for (const changes of [{ externalConversationId: "not-a-uuid" }, { messageId: "not-a-uuid" },
    { contactId: "whatsapp:+12025550100" }, { contactId: "+1 (202) 555-0100" }, { contactId: "CO.bad_id" },
    { contactId: "++12025550100" }]) {
    const f = mock(); await assert.rejects(f.adapter.fetchConfirmedEventMessage({ ...input, ...changes }), { code: "SCOPE_MISMATCH", status: 400 });
    assert.equal(f.requests.length, 0);
  }
  const f = mock();
  await assert.rejects(f.adapter.fetchConfirmedEventMessage({ ...input, historyCursor: "bad\ncursor" }), { code: "INVALID_CURSOR" });
  assert.equal(f.requests.length, 0);
});

test("rejects wrong workspace, agent, conversation, channel and contact on every page", async () => {
  for (const update of [
    d => { d.workspace_id = "foreign"; }, d => { d.conversation.text_agent_id = "foreign"; },
    d => { d.conversation.id = otherMessageId; }, d => { d.conversation.channel_type = "twilio_whatsapp"; },
    d => { d.conversation.channel_identifier = "12025550101"; },
    d => { d.conversation.channel_identifier = "+1 (202) 555-0100"; },
  ]) {
    const bad = structuredClone(detail()); update(bad);
    const f = mock(() => bad);
    await assert.rejects(f.adapter.fetchConfirmedEventMessage(input), { code: "SCOPE_MISMATCH" });
    assert.deepEqual(f.closed, ["test-event-session"]);
    const later = mock(args => args.messages_cursor ? bad : detail([], { messages_next_cursor: "second-page" }));
    await assert.rejects(later.adapter.fetchConfirmedEventMessage(input), { code: "SCOPE_MISMATCH" });
  }
});

test("contact identity permits one leading plus only and never infers Colombia from a national number", async () => {
  const f = mock(() => detail([message], { conversation: { ...conversation, channel_identifier: contactId } }));
  assert.equal((await f.adapter.fetchConfirmedEventMessage({ ...input, contactId: `+${contactId}` })).source.contactId, contactId);
  const national = mock(() => detail([message], { conversation: { ...conversation, channel_identifier: "3001234567" } }));
  await assert.rejects(national.adapter.fetchConfirmedEventMessage({ ...input, contactId: "573001234567" }), { code: "SCOPE_MISMATCH" });
});

test("BSUID stays opaque and requires an exact contact match across pagination", async () => {
  const bsuid = "CO.1234567890123456", seen = [];
  const f = mock(args => { seen.push(args.messages_cursor); return detail(args.messages_cursor ? [message] : [],
    { conversation: { ...conversation, channel_identifier: bsuid }, messages_next_cursor: args.messages_cursor ? null : "page-two" }); });
  const result = await f.adapter.fetchConfirmedEventMessage({ ...input, contactId: bsuid });
  assert.equal(result.state, "confirmed"); assert.equal(result.source.contactId, bsuid);
  assert.equal(result.historyCursor, "page-two"); assert.deepEqual(seen, [undefined, "page-two"]);
  for (const other of ["1234567890123456", "CO.1234567890123457", "co.1234567890123456"]) {
    const wrong = mock(() => detail([message], { conversation: { ...conversation, channel_identifier: other } }));
    await assert.rejects(wrong.adapter.fetchConfirmedEventMessage({ ...input, contactId: bsuid }), { code: "SCOPE_MISMATCH" });
  }
});

test("only the requested UUID can produce a confirmed message", async () => {
  const f = mock(() => detail([{ ...message, id: otherMessageId }]));
  const result = await f.adapter.fetchConfirmedEventMessage(input);
  assert.equal(result.state, "pending"); assert.equal(result.reason, "MESSAGE_NOT_FOUND");
  assert.equal(Object.hasOwn(result, "message"), false);
});

test("pending, queued and unknown delivery states never return text as confirmed", async () => {
  for (const status of ["pending", "queued", "sending", "unknown", null]) {
    const f = mock(() => detail([{ ...message, status, content: "PRIVATE_PENDING" }]));
    const result = await f.adapter.fetchConfirmedEventMessage(input);
    assert.equal(result.state, "pending"); assert.equal(result.reason, "DELIVERY_PENDING");
    assert.equal(JSON.stringify(result).includes("PRIVATE_PENDING"), false); assert.equal(Object.hasOwn(result, "message"), false);
  }
});

test("failed and error sends have a fixed safe failure reason without content or provider errors", async () => {
  for (const status of ["failed", "error"]) {
    const f = mock(() => detail([{ ...message, status, content: "PRIVATE_FAILURE", error: "PRIVATE_PROVIDER" }]));
    const result = await f.adapter.fetchConfirmedEventMessage(input);
    assert.equal(result.state, "failed"); assert.equal(result.reason, "DELIVERY_FAILED");
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false); assert.equal(Object.hasOwn(result, "message"), false);
  }
});

test("sent, delivered and read agent/followup text are accepted but internal, inbound and non-text are not", async () => {
  for (const status of ["sent", "delivered", "read"]) for (const kind of ["agent", "followup"]) {
    const f = mock(() => detail([{ ...message, status, kind }]));
    const result = await f.adapter.fetchConfirmedEventMessage(input);
    assert.equal(result.state, "confirmed"); assert.equal(result.message.status, status);
  }
  for (const changes of [{ kind: "lead" }, { kind: "tool_result" }, { direction: "inbound" }, { content_type: "image" }, { content_type: "template" }]) {
    const f = mock(() => detail([{ ...message, ...changes }]));
    const result = await f.adapter.fetchConfirmedEventMessage(input);
    assert.equal(result.state, "failed"); assert.equal(result.reason, "UNSUPPORTED_MESSAGE");
    assert.equal(Object.hasOwn(result, "message"), false);
  }
});

test("confirmed text retains existing redaction and requires an explicit valid timestamp zone", async () => {
  const f = mock(() => detail([{ ...message, content: `Respuesta real de prueba. Bearer PRIVATE_ACCESS ${env.DAPTA_MCP_API_KEY} OTP: 123456` }]));
  const result = await f.adapter.fetchConfirmedEventMessage(input);
  assert.equal(result.state, "confirmed"); assert.match(result.message.text, /Respuesta real de prueba/);
  for (const value of ["PRIVATE_ACCESS", env.DAPTA_MCP_API_KEY, "123456"]) assert.equal(result.message.text.includes(value), false);
  for (const created_at of ["2026-11-01T20:00:00", "2026-02-30T20:00:00Z", "not-a-date"]) {
    const bad = mock(() => detail([{ ...message, created_at }]));
    const actual = await bad.adapter.fetchConfirmedEventMessage(input);
    assert.equal(actual.state, "failed"); assert.equal(actual.reason, "INVALID_MESSAGE");
  }
  const empty = mock(() => detail([{ ...message, content: "   " }]));
  assert.equal((await empty.adapter.fetchConfirmedEventMessage(input)).reason, "INVALID_MESSAGE");
});

test("at most three history pages are searched and the pending job can resume without skipping its cursor", async () => {
  const cursors = [];
  const f = mock(args => { cursors.push(args.messages_cursor); const n = Number(args.messages_cursor?.split("-")[1] || 0);
    return detail([], { messages_next_cursor: `page-${n + 1}` }); });
  const result = await f.adapter.fetchConfirmedEventMessage({ ...input, historyCursor: "page-7" });
  assert.equal(result.state, "pending"); assert.equal(result.reason, "HISTORY_REMAINING");
  assert.equal(result.historyCursor, "page-10"); assert.equal(result.historyTruncated, true);
  assert.deepEqual(cursors, ["page-7", "page-8", "page-9"]);
});

test("finding a live-tail target on an early page does not jump to later history pages", async () => {
  const f = mock(() => detail([message], { messages_next_cursor: "later-history" }));
  const result = await f.adapter.fetchConfirmedEventMessage({ ...input, historyCursor: "current-page" });
  assert.equal(result.state, "confirmed"); assert.equal(result.historyCursor, "current-page");
  assert.equal(result.historyTruncated, true); assert.equal(f.requests.filter(r => r.method === "tools/call").length, 1);
});

test("a 200-message replica/live response is bounded and cannot silently drop the target in its tail", async () => {
  const messages = Array.from({ length: 199 }, (_, index) => ({ ...message, id: `other-${index}` }));
  messages.push(message);
  assert.equal((await mock(() => detail(messages)).adapter.fetchConfirmedEventMessage(input)).state, "confirmed");
  await assert.rejects(mock(() => detail([...messages, { ...message, id: "too-many" }])).adapter.fetchConfirmedEventMessage(input), { code: "INVALID_RESPONSE" });
});

test("malformed pages, looping cursors and contradictory duplicate target IDs fail closed", async () => {
  for (const payload of [detail(null), detail([message], { messages_next_cursor: "bad\ncursor" }),
    detail([{ ...message }, { ...message, content: "Different text" }])]) {
    await assert.rejects(mock(() => payload).adapter.fetchConfirmedEventMessage(input), { code: "INVALID_RESPONSE" });
  }
  const looping = mock(() => detail([], { messages_next_cursor: "same" }));
  await assert.rejects(looping.adapter.fetchConfirmedEventMessage({ ...input, historyCursor: "same" }), { code: "INVALID_RESPONSE" });
  const duplicate = await mock(() => detail([message, { ...message }])).adapter.fetchConfirmedEventMessage(input);
  assert.equal(duplicate.state, "confirmed");
});

test("network and provider errors remain sanitized and close only the MCP read session", async () => {
  for (const response of [() => { throw new Error("PRIVATE_TRANSPORT_TOKEN"); },
    () => new Response("PRIVATE_PROVIDER_RESPONSE", { status: 503 })]) {
    const f = mock(undefined, rpc => rpc.method === "tools/call" ? response() : undefined);
    await assert.rejects(f.adapter.fetchConfirmedEventMessage(input), error => error.code === "UNAVAILABLE" && !/PRIVATE/.test(error.message));
    assert.deepEqual(f.closed, ["test-event-session"]);
  }
});
