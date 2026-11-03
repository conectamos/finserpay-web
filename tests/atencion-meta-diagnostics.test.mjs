import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createMetaAttentionAdapter, META_ATTENTION_LINE } = await jiti.import("../lib/atencion-meta.ts");
const now = Date.parse("2026-11-03T15:00:00Z");
const env = {
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "synthetic-private-diagnostic-token", WHATSAPP_ATTENTION_APP_SECRET: "synthetic-private-app-secret",
  WHATSAPP_ATTENTION_VERIFY_TOKEN: "synthetic-private-verify-token", WHATSAPP_ATTENTION_PHONE_NUMBER_ID: META_ATTENTION_LINE.phoneNumberId,
  WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: META_ATTENTION_LINE.wabaId, WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_ATTENTION_SEND_ENABLED: "true", WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true",
};
const input = { recipient: "12025550100", attemptId: "00000000-0000-4000-8000-000000000001", cutoverConfirmed: true,
  lastInboundAt: new Date(now - 60_000).toISOString(), text: "Prueba artificial" };
const mediaId = "999888777666";
const privateUrl = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?signed=synthetic-private-signed-url";
const contamination = { message: `${env.WHATSAPP_ATTENTION_ACCESS_TOKEN} ${input.recipient} ${mediaId} ${privateUrl}`,
  type: "synthetic-private-type", error_user_title: "synthetic-private-title", error_user_msg: "synthetic-private-description",
  error_data: { details: "synthetic-private-details", recipient: input.recipient }, fbtrace_id: "synthetic-private-trace" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// These transports never call the network or use real WhatsApp contacts.
function network(reject) {
  const calls = [];
  const fetch = async (url, init) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, method: init.method });
    const rejected = reject(parsed, init);
    if (rejected) return rejected;
    if (parsed.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] });
    if (parsed.pathname === `/v25.0/${META_ATTENTION_LINE.phoneNumberId}`) return json({ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone });
    if (parsed.pathname.endsWith(`/${mediaId}`)) return json({ id: mediaId, mime_type: "application/pdf", file_size: 12, url: privateUrl });
    assert.fail("Unexpected synthetic request");
  };
  return { calls, adapter: createMetaAttentionAdapter({ env, fetch, now: () => now }) };
}
function captured(t) {
  const logs = [];
  t.mock.method(console, "warn", (...args) => logs.push(args));
  return logs;
}
function httpLogs(logs) { return logs.filter(([prefix]) => prefix === "[attention-meta-http]").map(([, body]) => JSON.parse(body)); }
function assertPrivate(logs) {
  const output = JSON.stringify(logs);
  for (const secret of [env.WHATSAPP_ATTENTION_ACCESS_TOKEN, input.recipient, mediaId, privateUrl, META_ATTENTION_LINE.phoneNumberId,
    META_ATTENTION_LINE.wabaId, "synthetic-private", "Authorization", "Bearer", "graph.facebook.com", "lookaside.fbsbx.com"])
    assert.ok(!output.includes(secret), `Diagnostic leaked ${secret}`);
}

test("structured send4xx logs numeric diagnostics but keeps a definitive rejection and a single POST", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith("/messages")
    ? json({ error: { ...contamination, code: 131000, error_subcode: 2494010, is_transient: false } }, 400) : null);
  let guarded = 0;
  await assert.rejects(wire.adapter.sendText(input, async () => { guarded++; }),
    { code: "META_HTTP_ERROR", message: "Meta no pudo completar la solicitud.", status: 502, uncertain: false, retryable: false });
  assert.equal(guarded, 1); assert.equal(wire.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(httpLogs(logs), [{ operation: "send", httpStatus: 400, graphCode: 131000, graphSubcode: 2494010, isTransient: false }]);
  assertPrivate(logs);
});

test("send5xx stays uncertain even with structured Graph details and never retries the POST", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith("/messages")
    ? json({ error: { ...contamination, code: 2, error_subcode: 0, is_transient: true } }, 503) : null);
  await assert.rejects(wire.adapter.sendText(input, async () => {}), { code: "META_HTTP_ERROR", uncertain: true, retryable: false });
  assert.equal(wire.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(httpLogs(logs), [{ operation: "send", httpStatus: 503, graphCode: 2, graphSubcode: 0, isTransient: true }]);
  assertPrivate(logs);
});

test("read authorization4xx remains definite and nonretryable without exposing provider descriptions", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith("/phone_numbers")
    ? json({ error: { ...contamination, code: 190, error_subcode: 463, is_transient: false } }, 401) : null);
  await assert.rejects(wire.adapter.verifyConnection(), { code: "META_HTTP_ERROR", status: 503, uncertain: false, retryable: false });
  assert.equal(wire.calls.filter(call => call.path.endsWith("/phone_numbers")).length, 1);
  assert.ok(wire.calls.every(call => call.method === "GET"));
  assert.deepEqual(httpLogs(logs), [{ operation: "waba_phones", httpStatus: 401, graphCode: 190, graphSubcode: 463, isTransient: false }]);
  assertPrivate(logs);
});

test("transient metadata read retains its bounded retry and emits only a fixed stage", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith(`/${mediaId}`)
    ? json({ error: { ...contamination, code: 2, is_transient: true } }, 500) : null);
  await assert.rejects(wire.adapter.sendMedia({ ...input, mediaId, kind: "document" }, async () => assert.fail("No send guard after failed read")),
    { code: "META_HTTP_ERROR", uncertain: false, retryable: true });
  assert.equal(wire.calls.filter(call => call.path.endsWith(`/${mediaId}`)).length, 2);
  assert.ok(wire.calls.every(call => call.method === "GET"));
  assert.deepEqual(httpLogs(logs), Array.from({ length: 2 }, () => ({ operation: "metadata", httpStatus: 500, graphCode: 2, isTransient: true })));
  assertPrivate(logs);
});

test("upload HTTP failure is distinguished from metadata and never retries its POST", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith("/media")
    ? json({ error: { ...contamination, code: 1, is_transient: true } }, 503) : null);
  await assert.rejects(wire.adapter.uploadMedia({ bytes: Buffer.from("%PDF-1.7\nfixture\n%%EOF\n"), mimeType: "application/pdf", fileName: "fixture.pdf" }),
    { code: "META_HTTP_ERROR", uncertain: false, retryable: true });
  assert.equal(wire.calls.filter(call => call.method === "POST").length, 1);
  assert.deepEqual(httpLogs(logs), [{ operation: "upload_media", httpStatus: 503, graphCode: 1, isTransient: true }]);
  assertPrivate(logs);
});

test("private download failure identifies only the stage without its signed URL or media ID", async t => {
  const logs = captured(t), wire = network(url => url.hostname === "lookaside.fbsbx.com"
    ? json({ error: { ...contamination, code: 100 } }, 404)
    : url.pathname.endsWith(`/${mediaId}`) ? json({ id: mediaId, mime_type: "application/pdf", file_size: 4096, url: privateUrl }) : null);
  await assert.rejects(wire.adapter.downloadMedia({ mediaId }), { code: "META_HTTP_ERROR", uncertain: false, retryable: false });
  assert.equal(wire.calls.length, 2); assert.ok(wire.calls.every(call => call.method === "GET"));
  assert.deepEqual(httpLogs(logs), [{ operation: "private_media", httpStatus: 404, graphCode: 100 }]);
  assertPrivate(logs);
});

test("HTTP diagnostics omit malformed fields rather than coercing strings, objects or unsafe integers", async t => {
  const logs = captured(t);
  for (const fields of [
    { code: input.recipient, error_subcode: mediaId, is_transient: "synthetic-private-value" },
    { code: -1, error_subcode: -20, is_transient: { secret: env.WHATSAPP_ATTENTION_ACCESS_TOKEN } },
    { code: 1.5, error_subcode: Number.MAX_SAFE_INTEGER + 1, is_transient: 1 },
  ]) {
    const wire = network(url => url.pathname.endsWith("/messages") ? json({ error: { ...contamination, ...fields } }, 400) : null);
    await assert.rejects(wire.adapter.sendText(input, async () => {}), { code: "META_HTTP_ERROR", uncertain: !Number.isInteger(fields.code), retryable: false });
    assert.equal(wire.calls.filter(call => call.method === "POST").length, 1);
  }
  assert.deepEqual(httpLogs(logs), Array.from({ length: 3 }, () => ({ operation: "send", httpStatus: 400 })));
  assertPrivate(logs);
});

test("nonJSON HTTP rejection logs no body and retains an uncertain send", async t => {
  const logs = captured(t), wire = network(url => url.pathname.endsWith("/messages")
    ? new Response(contamination.message, { status: 400 }) : null);
  await assert.rejects(wire.adapter.sendText(input, async () => {}), { code: "META_HTTP_ERROR", uncertain: true, retryable: false });
  assert.deepEqual(httpLogs(logs), [{ operation: "send", httpStatus: 400 }]);
  assertPrivate(logs);
});
