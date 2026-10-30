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
const workspace = "00000000-0000-0000-0000-000000000001";
const agent = "00000000-0000-0000-0000-000000000002";
const env = { DAPTA_MCP_API_KEY: "test-only-secret", DAPTA_ATTENTION_WORKSPACE_ID: workspace, DAPTA_ATTENTION_AGENT_ID: agent };
const row = { id: "test-chat", text_agent_id: agent, channel_type: "meta_whatsapp", channel_identifier: "+1 (202) 555-0100", last_message_at: "2026-10-29T10:00:00Z", llmdisabled: true };
const message = { id: "test-message", created_at: "2026-10-29T10:00:00Z", direction: "inbound", kind: "lead", content_type: "text", content: "Consulta de prueba", status: "delivered" };
const list = (rows = [row], extras = {}) => ({ workspace_id: workspace, conversations: rows, next_cursor: null, ...extras });
const detail = (messages = [message], extras = {}) => ({ workspace_id: workspace, conversation: row, messages, messages_next_cursor: null, ...extras });
function mock({ onTool = (name) => name === "list_conversations" ? list() : detail(), sse = false, fallback = false, protocol = "2025-06-18", direct } = {}) {
  const requests = [];
  const transport = async (url, init) => {
    assert.equal(url, "https://mcp.dapta.ai/mcp");
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    const rpc = JSON.parse(init.body);
    requests.push({ rpc, headers: init.headers });
    if (direct) { const response = await direct(rpc); if (response) return response; }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (rpc.method === "initialize") result = { protocolVersion: protocol, capabilities: { tools: {} } };
    else {
      assert.equal(rpc.method, "tools/call");
      assert.ok(["list_conversations", "get_conversation"].includes(rpc.params.name));
      assert.equal(rpc.params.arguments.workspace_id, undefined);
      const payload = await onTool(rpc.params.name, rpc.params.arguments);
      result = fallback ? { content: [{ type: "text", text: "Workspace: test" }, { type: "text", text: JSON.stringify(payload) }] } : { structuredContent: payload };
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
    if (!sse) return new Response(body, { headers: { "content-type": "application/json", "Mcp-Session-Id": "test-session" } });
    const raw = `: keep-alive\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\r\n\r\nevent: message\r\ndata: ${body}\r\n\r\n`;
    const bytes = new TextEncoder().encode(raw);
    return new Response(new ReadableStream({ start(controller) {
      // Split both UTF-8 and SSE delimiters across chunks.
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    } }), { headers: { "content-type": "text/event-stream", "Mcp-Session-Id": "test-session" } });
  };
  return { adapter: createDaptaAttentionAdapter({ env, fetch: transport }), requests };
}

test("missing/invalid configuration fails closed without a network request", async () => {
  for (const configuration of [{}, { ...env, DAPTA_MCP_API_KEY: "" }, { ...env, DAPTA_ATTENTION_WORKSPACE_ID: "wrong" }, { ...env, DAPTA_MCP_API_KEY: "key\r\ninjection" }]) {
    const adapter = createDaptaAttentionAdapter({ env: configuration, fetch: () => assert.fail("network must remain unused") });
    const status = adapter.attentionIntegrationStatus();
    assert.equal(status.canSync, false);
    assert.equal(status.canSend, false);
    assert.equal(status.canHandoff, false);
    await assert.rejects(adapter.fetchDaptaConversationSnapshots(), { code: "NOT_CONFIGURED", status: 503 });
  }
});

test("initializes MCP then reads only scoped conversations, never enabling send or handover", async () => {
  const { adapter, requests } = mock();
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.deepEqual(requests.map((r) => r.rpc.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
  assert.deepEqual(requests[0].rpc.params.capabilities, {});
  assert.equal(requests[1].headers["Mcp-Session-Id"], "test-session");
  assert.equal(requests[1].headers["MCP-Protocol-Version"], "2025-06-18");
  assert.equal(requests[2].rpc.params.arguments.limit, 25);
  assert.equal(requests[3].rpc.params.arguments.fresh, false);
  assert.equal(requests[3].rpc.params.arguments.include_state, false);
  assert.equal(requests[3].rpc.params.arguments.include_tool_payloads, false);
  assert.equal(result.snapshots[0].phone, "12025550100");
  assert.equal(result.snapshots[0].mode, "unknown", "disabled AI does not prove human acceptance");
  assert.equal(result.snapshots[0].messages[0].author, null);
  assert.equal(result.snapshots[0].historyTruncated, false);
  assert.equal(result.snapshots[0].historyCursor, null);
  assert.equal(adapter.attentionIntegrationStatus().canSend, false);
});

test("accepts chunked SSE, notifications, text-content fallback and negotiated prior protocol", async () => {
  const { adapter, requests } = mock({ sse: true, fallback: true, protocol: "2025-03-26", onTool: (name) => name === "list_conversations" ? list() : detail([{ ...message, content: "Prueba de atención ☺" }]) });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.equal(result.snapshots[0].messages[0].text, "Prueba de atención ☺");
  assert.equal(requests[1].headers["MCP-Protocol-Version"], "2025-03-26");
});

test("rejects foreign workspace before persisting or following a conversation", async () => {
  const { adapter, requests } = mock({ onTool: () => list([row], { workspace_id: "other-workspace" }) });
  await assert.rejects(adapter.fetchDaptaConversationSnapshots(), { code: "SCOPE_MISMATCH" });
  assert.equal(requests.length, 3);
});

test("skips wrong agent, non-WhatsApp sessions, invalid phones and duplicate list rows", async () => {
  const rows = [row, row, { ...row, id: "foreign", text_agent_id: "other-agent" }, { ...row, id: "widget", channel_type: "widget" }, { ...row, id: "bad-phone", channel_identifier: "session-12345678" }];
  const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list(rows) : detail() });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.skipped, 4);
});

test("rejects mismatching detail identities including later history pages", async () => {
  for (const changed of [{ id: "different" }, { channel_identifier: "+12025550101" }, { channel_type: "widget" }, { text_agent_id: "other" }]) {
    const { adapter } = mock({ onTool: (name, args) => name === "list_conversations" ? list() : args.messages_cursor ? detail([], { conversation: { ...row, ...changed } }) : detail([], { messages_next_cursor: "page-two" }) });
    await assert.rejects(adapter.fetchDaptaConversationSnapshots(), { code: "SCOPE_MISMATCH" });
  }
});

test("only external text survives; raw state/tool secrets and unsafe content are not returned", async () => {
  const messages = [message, { ...message, id: "tool", kind: "tool_result", content: "database-password-secret" },
    { ...message, id: "image", content_type: "image", content: "https://private.example/file" },
    { ...message, id: "credentials", content: "Bearer abc123 https://example.test/?x-api-key=provider-key test-only-secret contraseña: no-share OTP: 123456 PIN 4567 código de verificación es 987654 CVV: 987 tarjeta 4111 1111 1111 1111" },
    { ...message, id: "invalid", created_at: "bad date" }];
  const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list() : detail(messages, { state: { secret: "db-password" } }) });
  const result = await adapter.fetchDaptaConversationSnapshots();
  const serialized = JSON.stringify(result);
  for (const secret of ["database-password-secret", "private.example", "abc123", "provider-key", "test-only-secret", "no-share", "db-password", "123456", "4567", "987654", "987", "4111"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(result.snapshots[0].messages.length, 2);
  assert.equal(result.snapshots[0].historyTruncated, true);
});

test("paginates, de-duplicates and orders messages; preserves list continuation", async () => {
  const { adapter, requests } = mock({ onTool: (name, args) => name === "list_conversations" ? list([row], { next_cursor: "next-chats" }) : args.messages_cursor
    ? detail([message, { ...message, id: "earlier", created_at: "2026-10-29T09:00:00Z" }])
    : detail([message], { messages_next_cursor: "next-messages" }) });
  const result = await adapter.fetchDaptaConversationSnapshots({ cursor: "previous-chats" });
  assert.equal(requests[2].rpc.params.arguments.cursor, "previous-chats");
  assert.equal(result.nextCursor, "next-chats");
  assert.deepEqual(result.snapshots[0].messages.map((m) => m.id), ["earlier", "test-message"]);
  assert.equal(result.snapshots[0].historyTruncated, false);
});

test("limits history to three pages and marks repeated or remaining cursors as incomplete", async () => {
  for (const repeated of [true, false]) {
    let calls = 0;
    const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list() : detail([message], { messages_next_cursor: repeated ? "repeated" : `page-${++calls}` }) });
    const result = await adapter.fetchDaptaConversationSnapshots();
    assert.equal(result.snapshots[0].historyTruncated, true);
    assert.ok(calls <= 3);
  }
});

test("invalid cursors, oversized responses and malformed JSON fail without exposing provider details", async () => {
  const { adapter } = mock();
  await assert.rejects(adapter.fetchDaptaConversationSnapshots({ cursor: "invalid\nvalue" }), { code: "INVALID_CURSOR" });
  for (const response of [
    () => new Response("{invalid provider-token", { headers: { "content-type": "application/json" } }),
    () => new Response("oversized", { headers: { "content-type": "application/json", "content-length": "999999999" } }),
    () => new Response("private-provider-details", { status: 401 }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
  ]) {
    const { adapter: broken } = mock({ direct: response });
    await assert.rejects(broken.fetchDaptaConversationSnapshots(), (error) => !/provider-token|private-provider-details|oversized/.test(error.message));
  }
});

test("remote tool errors and unsupported protocol fail closed with sanitized messages", async () => {
  const broken = mock({ direct: (rpc) => rpc.method === "tools/call" ? new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { isError: true, content: [{ type: "text", text: "secret-provider-error" }] } }), { headers: { "content-type": "application/json" } }) : null });
  await assert.rejects(broken.adapter.fetchDaptaConversationSnapshots(), (error) => error.code === "UNAVAILABLE" && !error.message.includes("secret-provider-error"));
  await assert.rejects(mock({ protocol: "2099-01-01" }).adapter.fetchDaptaConversationSnapshots(), { code: "INVALID_RESPONSE" });
});

test("failed or pending outbound messages are omitted instead of presented as sent", async () => {
  const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list() : detail([
    { ...message, id: "failed", direction: "outbound", status: "failed" },
    { ...message, id: "pending", direction: "outbound", status: "pending" },
    { ...message, id: "sent", direction: "outbound", status: "sent" },
  ]) });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.deepEqual(result.snapshots[0].messages.map((m) => m.id), ["sent"]);
  assert.equal(result.snapshots[0].historyTruncated, true);
});

test("a stalled HTTP call is bounded and cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const adapter = createDaptaAttentionAdapter({ env, fetch: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  const pending = assert.rejects(adapter.fetchDaptaConversationSnapshots(), { code: "UNAVAILABLE", status: 504 });
  t.mock.timers.tick(8000);
  await pending;
  assert.equal(signal.aborted, true);
});

test("an expired MCP session reinitializes and retries the read once", async () => {
  let expired = false;
  const { adapter, requests } = mock({ direct: (rpc) => {
    if (rpc.method === "tools/call" && !expired) { expired = true; return new Response(null, { status: 404 }); }
    return null;
  } });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.equal(result.snapshots.length, 1);
  assert.equal(requests.filter((r) => r.rpc.method === "initialize").length, 2);
  assert.equal(requests.filter((r) => r.rpc.method === "initialize")[1].headers["Mcp-Session-Id"], undefined);
  const alwaysExpired = mock({ direct: (rpc) => rpc.method === "tools/call" ? new Response(null, { status: 404 }) : null });
  await assert.rejects(alwaysExpired.adapter.fetchDaptaConversationSnapshots(), { code: "UNAVAILABLE" });
  assert.equal(alwaysExpired.requests.filter((r) => r.rpc.method === "initialize").length, 2);
});

test("oversized and redaction-expanded messages are omitted at the storage limit", async () => {
  const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list() : detail([
    { ...message, id: "boundary", content: "a".repeat(16000) },
    { ...message, id: "too-long", content: "b".repeat(16001) },
    { ...message, id: "expanded", content: "c".repeat(15990) + " OTP: 1234" },
  ]) });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.deepEqual(result.snapshots[0].messages.map((m) => m.id), ["boundary"]);
  assert.equal(result.snapshots[0].messages[0].text.length, 16000);
  assert.equal(result.snapshots[0].historyTruncated, true);
});

test("accepts explicit ISO/PostgreSQL offsets and omits ambiguous or invalid timestamps", async () => {
  const valid = [
    ["utc", "2026-10-29T10:00:00Z", "2026-10-29T10:00:00.000Z"],
    ["pg", "2026-10-29 10:00:00.123456+00:00", "2026-10-29T10:00:00.123Z"],
    ["pg-short-offset", "2026-10-29 10:00:00+00", "2026-10-29T10:00:00.000Z"],
    ["negative", "2026-10-29T05:00:00-05:00", "2026-10-29T10:00:00.000Z"],
    ["compact-offset", "2026-10-29T12:00:00+0200", "2026-10-29T10:00:00.000Z"],
  ];
  const invalid = ["2026-10-29T10:00:00", "2026-10-29 10:00:00", "2026-10-29", "2026-02-30T10:00:00Z", "2026-10-29T24:00:00Z", "2026-10-29T10:00:00+25:00"];
  const messages = [...valid.map(([id, created_at]) => ({ ...message, id, created_at })), ...invalid.map((created_at, index) => ({ ...message, id: `invalid-${index}`, created_at }))];
  const noZoneRow = { ...row, last_message_at: "2026-10-29T10:00:00" };
  const { adapter } = mock({ onTool: (name) => name === "list_conversations" ? list([noZoneRow]) : detail(messages, { conversation: noZoneRow }) });
  const result = await adapter.fetchDaptaConversationSnapshots();
  assert.equal(result.snapshots[0].lastContactAt, null);
  assert.deepEqual(Object.fromEntries(result.snapshots[0].messages.map((m) => [m.id, m.sentAt])), Object.fromEntries(valid.map(([id, , expected]) => [id, expected])));
  assert.equal(result.snapshots[0].historyTruncated, true);
});

test("resumes long oldest-first histories and retains a tail checkpoint for new messages", async () => {
  let count = 650;
  const visited = [];
  const { adapter } = mock({ onTool: (name, args) => {
    if (name === "list_conversations") return list();
    const start = args.messages_cursor ? Number(args.messages_cursor.slice("test-page-".length)) : 0;
    visited.push(start);
    const end = Math.min(start + args.messages_limit, count);
    const messages = Array.from({ length: end - start }, (_, offset) => ({ ...message,
      id: `message-${start + offset}`, created_at: new Date(Date.UTC(2026, 9, 29) + (start + offset) * 1000).toISOString(),
    }));
    return detail(messages, { messages_next_cursor: end < count ? `test-page-${end}` : null });
  } });
  const persisted = new Map();
  let checkpoint = null;
  async function sync() {
    const result = await adapter.fetchDaptaConversationSnapshots({ historyCursors: { [row.id]: checkpoint } });
    const snapshot = result.snapshots[0];
    for (const item of snapshot.messages) persisted.set(item.id, item);
    checkpoint = snapshot.historyCursor;
    return snapshot;
  }
  assert.equal((await sync()).historyTruncated, true);
  assert.equal(checkpoint, "test-page-300");
  assert.equal((await sync()).historyTruncated, true);
  assert.equal(checkpoint, "test-page-600");
  assert.equal((await sync()).historyTruncated, false);
  assert.equal(checkpoint, "test-page-600", "EOF retains the last input cursor, not a restart");
  assert.equal(persisted.size, 650);
  count = 725;
  assert.equal((await sync()).historyTruncated, false);
  assert.equal(checkpoint, "test-page-700");
  assert.equal(persisted.size, 725);
  assert.ok(persisted.has("message-724"));
  assert.deepEqual(visited, [0, 100, 200, 300, 400, 500, 600, 600, 700]);
});
