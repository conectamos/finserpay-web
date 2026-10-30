import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const meta = await jiti.import("../lib/atencion-meta.ts");
const core = await jiti.import("../lib/atencion-core.ts");
const http = await jiti.import("../lib/atencion-http.ts");
const mediaHttp = await jiti.import("../lib/atencion-meta-http.ts");
const { createAttentionMetaService } = await jiti.import("../lib/atencion-meta-service.ts");
const origin = "https://finser.example";
const now = Date.parse("2026-10-30T18:00:00Z");
const id = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const outboxId = "00000000-0000-4000-8000-000000000003";
const leaseToken = "00000000-0000-4000-8000-000000000004";
const messageId = "00000000-0000-4000-8000-000000000005";
const phone = "12025550100";
const wamid = "wamid.SERVICE_TEST";
const mediaId = "1234567890";
const actor = { userId: 1, sellerId: null, central: true, admin: true, analyst: false, key: "admin:1", name: "Central de prueba", sedeId: 1, aliadoId: 1, supervisor: false };
const env = {
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "test-only-attention-token", WHATSAPP_ATTENTION_APP_SECRET: "test-only-app-secret", WHATSAPP_ATTENTION_VERIFY_TOKEN: "test-only-verify-token",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID: meta.META_ATTENTION_LINE.phoneNumberId, WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: meta.META_ATTENTION_LINE.wabaId,
  WHATSAPP_GRAPH_API_VERSION: "v25.0", WHATSAPP_ATTENTION_SEND_ENABLED: "true", WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true",
};
const textInput = { requestId, version: 4, text: "Respuesta de prueba", attachment: undefined, bytes: undefined };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function box(type, payload) { const out = Buffer.alloc(8 + payload.length); out.writeUInt32BE(out.length); out.write(type, 4); payload.copy(out, 8); return out; }
const hdlr = Buffer.alloc(12); hdlr.write("vide", 8);
const mp4 = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", box("trak", box("mdia", box("hdlr", hdlr))))]);
const sticker = await sharp({create:{width:512,height:512,channels:4,background:{r:0,g:120,b:30,alpha:0.8}}}).webp({lossless:true}).toBuffer();
const formats = [
  { kind: "image", mimeType: "image/png", fileName: "prueba.png", bytes: png },
  { kind: "audio", mimeType: "audio/amr", fileName: "prueba.amr", bytes: Buffer.from("#!AMR\nsynthetic-audio") },
  { kind: "video", mimeType: "video/mp4", fileName: "prueba.mp4", bytes: mp4 },
  { kind: "document", mimeType: "application/pdf", fileName: "prueba.pdf", bytes: Buffer.from("%PDF-1.7\nsynthetic-document\n%%EOF\n") },
  { kind: "sticker", mimeType: "image/webp", fileName: "prueba.webp", bytes: sticker },
];
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function multipart({ file, text = "Respuesta de prueba", extra, headers = {}, signal } = {}) {
  const form = new FormData(); form.set("requestId", requestId); form.set("version", "4"); form.set("text", text);
  if (file) form.set("file", new Blob([file.bytes], { type: file.mimeType }), file.fileName);
  extra?.(form);
  return new Request(`${origin}/api/atencion/${id}/messages`, { method: "POST", headers: { origin, ...headers }, body: form, signal });
}
function harness(options = {}) {
  const calls = { network: [], queue: 0, claim: 0, before: 0, uploaded: 0, accepted: 0, failed: [], media: 0, find: 0, cancel: [], runtime: 0, ingest: [], access: 0, messaging: 0 };
  let cancelled = false;
  let row = {
    id: outboxId, conversationId: id, userId: 1, actorKey: actor.key, authorName: actor.name, requestId,
    fingerprint: "synthetic", conversationVersion: 4, phoneNumberId: env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID, wabaId: env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID,
    contactId: phone, text: textInput.text, attachment: null, uploadedMediaId: null, status: "queued", messageId: null, wamid: null,
    leaseToken, leaseUntil: new Date(now + 120_000).toISOString(), sendStartedAt: null, acceptedAt: null, deliveryAt: null, errorCode: null,
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), attempts: 1, ...options.row,
  };
  const format = options.format ?? formats[0];
  const descriptor = { mediaId, mimeType: format.mimeType, kind: format.kind, fileName: format.fileName };
  const store = {
    async queueReply(who, conversationId, input) { calls.queue++; assert.deepEqual(who, actor); assert.equal(conversationId, id); if (options.queueError) throw options.queueError; if (cancelled) throw new core.AttentionError("Solicitud cancelada", 409); row = { ...row, text: input.text, attachment: input.attachment ?? null }; return { ...row }; },
    async claimReply(who, conversationId, key) { calls.claim++; assert.equal(key, requestId); return { reply: { ...row }, claimed: options.claimed !== false, lastInboundAt: options.noInbound ? null : "2026-10-30T17:00:00Z" }; },
    async setUploadedMedia(who, rowId, lease, providerId) { calls.uploaded++; assert.equal(rowId, outboxId); assert.equal(lease, leaseToken); row = { ...row, uploadedMediaId: providerId }; return { ...row }; },
    async beforeSend(who, rowId, lease) { calls.before++; assert.equal(rowId, outboxId); assert.equal(lease, leaseToken); if (options.beforeError) throw options.beforeError; row = { ...row, status: "sending", sendStartedAt: new Date(now).toISOString() }; },
    async acceptReply(rowId, lease, providerId) { calls.accepted++; assert.equal(rowId, outboxId); assert.equal(lease, leaseToken); assert.equal(providerId, wamid); if (options.ackError) throw options.ackError; row = { ...row, status: "accepted", messageId, wamid, acceptedAt: new Date(now).toISOString(), leaseToken: null }; return { ...row }; },
    async failReply(rowId, lease, failure) { calls.failed.push(failure); if (options.callbackAccepted) row = { ...row, status: "delivered", messageId, wamid, acceptedAt: new Date(now).toISOString() }; else row = { ...row, status: failure.uncertain ? "uncertain" : "failed", leaseToken: null }; return { ...row }; },
    async findReply(who, conversationId, key) { calls.find++; assert.equal(who,actor); assert.equal(conversationId,id); assert.equal(key,requestId); return options.missing ? null : { ...row }; },
    async cancelReply(who, conversationId, key) { calls.cancel.push({ actor: who, conversationId, requestId: key }); if (options.cancelError) throw options.cancelError; cancelled = true; return { cancelled: true }; },
    async getMedia(who, conversationId, requestedMessageId) { calls.media++; assert.equal(conversationId, id); assert.equal(requestedMessageId, messageId); if (options.mediaError && calls.media === (options.mediaErrorAt ?? 1)) throw options.mediaError; return calls.media === 2 && options.changedMedia ? { ...descriptor, mediaId: "9999999999" } : descriptor; },
    async getMessaging() { calls.messaging++; if (options.messagingError) throw options.messagingError; return { canReply: true }; },
    async ingest(events) { calls.ingest.push(events); if (options.ingestError) throw options.ingestError; },
  };
  const transport = async (rawUrl, init) => {
    const url = new URL(rawUrl); calls.network.push({ url, init });
    assert.equal(init.headers.Authorization, `Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);
    assert.equal(init.redirect, "error"); assert.equal(url.searchParams.has("access_token"), false);
    if (url.origin === "https://lookaside.fbsbx.com") return new Response(format.bytes, { headers: { "content-type": format.mimeType } });
    assert.equal(url.origin, "https://graph.facebook.com");
    if (url.pathname === `/v25.0/${env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID}`) return json({ id: env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID, display_phone_number: meta.META_ATTENTION_LINE.displayPhone });
    if (url.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID, display_phone_number: meta.META_ATTENTION_LINE.displayPhone }] });
    if (url.pathname.endsWith("/media")) return json({ id: mediaId });
    if (url.pathname === `/v25.0/${mediaId}`) return json({ id: mediaId, mime_type: format.mimeType, file_size: format.bytes.length,
      url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?signed=private", sha256: createHash("sha256").update(format.bytes).digest("hex") });
    if (url.pathname.endsWith("/messages")) {
      assert.equal(calls.before, 1, "outbox claim must precede POST");
      if (options.sendError) throw options.sendError;
      if (options.rejected) return json({ error: { code: 131047, message: "private diagnostic" } }, 400);
      return json({ messaging_product: "whatsapp", contacts: [{ input: phone, wa_id: phone }], messages: [{ id: wamid }] });
    }
    assert.fail(`Unexpected mock URL path: ${url.pathname}`);
  };
  const adapter = meta.createMetaAttentionAdapter({ env, fetch: transport, now: () => now });
  const service = createAttentionMetaService(store, adapter);
  return { calls, store, adapter, service, row: () => ({ ...row }) };
}
// Execute the actual route modules with only auth/runtime seams replaced. There
// is no Prisma import, listening HTTP server, live token or network fallback.
function route(file, h, options = {}) {
  const loaded = { exports: {} };
  const source = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mocks = {
    "@/lib/atencion-core": { ...core, getAttentionAccess: async () => { h.calls.access++; if (options.authError) throw options.authError; return actor; } },
    "@/lib/atencion-http": http, "@/lib/atencion-meta-http": mediaHttp,
    "@/lib/atencion-meta": { ...meta, createMetaAttentionAdapter: () => h.adapter },
    "@/lib/atencion-meta-service": { attentionMetaRuntime: async () => { h.calls.runtime++; return { store: h.store, service: h.service, adapter: h.adapter }; } },
  };
  new Function("require", "module", "exports", source)(name => { assert.ok(name in mocks, `No live dependency allowed: ${name}`); return mocks[name]; }, loaded, loaded.exports);
  return loaded.exports;
}
const messagesPath = "app/api/atencion/[id]/messages/route.ts";
const mediaPath = "app/api/atencion/[id]/messages/[messageId]/media/route.ts";
const webhookPath = "app/api/integraciones/atencion/whatsapp/route.ts";
const context = { params: Promise.resolve({ id, messageId }) };

for (const format of formats) test(`multipart → service → real adapter sends ${format.kind} with filename only on documents`, async () => {
  const h = harness({ format }); const text = ["audio", "sticker"].includes(format.kind) ? "" : "Archivo de prueba";
  const input = await mediaHttp.readAttentionMetaReply(multipart({ file: format, text }));
  const result = await h.service.send(actor, id, input);
  assert.equal(result.message.deliveryStatus, "accepted"); assert.equal(result.uncertain, false);
  assert.equal(h.calls.uploaded, 1); assert.equal(h.calls.before, 1); assert.equal(h.calls.accepted, 1); assert.deepEqual(h.calls.failed, []);
  const requests = h.calls.network.filter(item => item.url.pathname.endsWith("/messages")); assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.biz_opaque_callback_data, outboxId, "correlation must identify the persisted outbox, not the client's UUID");
  assert.equal(body[format.kind].id, mediaId); assert.equal(body[format.kind].filename, format.kind === "document" ? format.fileName : undefined);
  assert.equal(body[format.kind].caption, text || undefined);
});

test("claim refused or missing lease causes no upload/send/ack", async () => {
  for (const options of [{ claimed: false }, { row: { leaseToken: null } }]) {
    const h = harness(options); const result = await h.service.send(actor, id, textInput);
    assert.equal(result.uncertain, true); assert.equal(h.calls.network.length, 0); assert.equal(h.calls.before, 0); assert.equal(h.calls.accepted, 0);
  }
});
test("accepted, sending and uncertain retries never claim or send again", async () => {
  for (const status of ["accepted", "sending", "uncertain", "failed"]) {
    const h = harness({ row: { status } }); const result = await h.service.send(actor, id, textInput);
    assert.equal(result.message.deliveryStatus, status); assert.equal(h.calls.claim, 0); assert.equal(h.calls.network.length, 0);
  }
});
test("network ambiguity and post-send database ACK loss remain uncertain with one POST", async () => {
  for (const options of [{ sendError: new Error("synthetic connection lost") }, { ackError: new Error("synthetic database ACK lost") }]) {
    const h = harness(options); const result = await h.service.send(actor, id, textInput);
    assert.equal(result.uncertain, true); assert.equal(result.message.deliveryStatus, "uncertain");
    assert.equal(h.calls.failed[0].uncertain, true); assert.equal(h.calls.network.filter(item => item.url.pathname.endsWith("/messages")).length, 1);
    await h.service.send(actor, id, textInput);
    assert.equal(h.calls.network.filter(item => item.url.pathname.endsWith("/messages")).length, 1, "same uncertain reply must never be sent again");
  }
});
test("callback winning the race is preserved after lost send response or ACK", async () => {
  const h = harness({ sendError: new Error("synthetic timeout"), callbackAccepted: true });
  const result = await h.service.send(actor, id, textInput);
  assert.equal(result.uncertain, false); assert.equal(result.message.deliveryStatus, "delivered"); assert.equal(result.message.id, messageId);
});
test("provider rejection is failed; authorization revoked before POST never sends", async () => {
  const rejected = harness({ rejected: true }); const result = await rejected.service.send(actor, id, textInput);
  assert.equal(result.message.deliveryStatus, "failed"); assert.equal(result.uncertain, false); assert.equal(rejected.calls.failed[0].uncertain, false);
  const denied = harness({ beforeError: new core.AttentionError("Conversación reasignada", 404) });
  const deniedResult = await denied.service.send(actor, id, textInput);
  assert.equal(deniedResult.message.deliveryStatus, "failed"); assert.equal(denied.calls.network.some(item => item.init.method === "POST"), false);
});
test("queue authorization failure prevents all provider I/O", async () => {
  const h = harness({ queueError: new core.AttentionError("Sin acceso", 403) });
  await assert.rejects(h.service.send(actor, id, textInput), { status: 403 }); assert.equal(h.calls.network.length, 0);
});
test("download requires authorization first and rechecks it after network I/O", async () => {
  const denied = harness({ mediaError: new core.AttentionError("Sin acceso", 404) });
  await assert.rejects(denied.service.media(actor, id, messageId), { status: 404 }); assert.equal(denied.calls.network.length, 0);
  const revoked = harness({ mediaError: new core.AttentionError("Reasignado", 404), mediaErrorAt: 2 });
  await assert.rejects(revoked.service.media(actor, id, messageId), { status: 404 }); assert.equal(revoked.calls.media, 2); assert.equal(revoked.calls.network.length, 2);
  const changed = harness({ changedMedia: true });
  await assert.rejects(changed.service.media(actor, id, messageId), { status: 409 });
});
test("multipart rejects duplicates, extra fields, false file fields and audio captions", async () => {
  for (const extra of [form => form.append("requestId", requestId), form => form.append("text", "duplicate"), form => form.append("actorKey", "admin:999"), form => form.set("file", "not a file")]) {
    await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ extra })), { status: 400 });
  }
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ file: formats[1], text: "Caption not supported" })), { status: 400 });
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ file: formats[4], text: "Sticker caption not supported" })), { status: 400 });
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ file: formats[0], text: "x".repeat(1025) })), { status: 400 });
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ text: "" })), { status: 400 });
});
test("multipart verifies actual content and byte limits", async () => {
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ file: { ...formats[0], bytes: Buffer.from("<html>not an image</html>") } })), { status: 415 });
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ file: { ...formats[0], bytes: Buffer.alloc(5 * 1024 * 1024 + 1) } })), { status: 413 });
  await assert.rejects(mediaHttp.readAttentionMetaReply(multipart({ headers: { "content-length": String(meta.META_ATTENTION_MAX_MEDIA_BYTES + 65_537) } })), { status: 413 });
});
test("raw reader preserves exact bytes, bounds chunks and cancels stalled bodies", async () => {
  const bytes = Buffer.from('{ "sample" : "á" }\r\n');
  const exact = await mediaHttp.readAttentionBody(new Request(origin, { method: "POST", body: bytes }), 100);
  assert.deepEqual(Buffer.from(exact), bytes);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(9)); controller.close(); } });
  await assert.rejects(mediaHttp.readAttentionBody(new Request(origin, { method: "POST", headers: { "content-length": "1" }, body: stream, duplex: "half" }), 16), { status: 413 });
  let cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(mediaHttp.readAttentionBody(new Request(origin, { method: "POST", body: stalled, duplex: "half" }), 16, 10), { status: 408 });
  assert.equal(cancelled, true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mediaHttp.readAttentionBody(new Request(origin, { method: "POST", body: bytes, signal: controller.signal }), 100), { status: 408 });
});
test("message routes deny unauthenticated, wrong-origin and unauthorized chat before parsing/upload", async () => {
  for (const status of [401, 403]) {
    const h = harness(); const endpoint = route(messagesPath, h, { authError: new core.AttentionError("Sin acceso", status) });
    assert.equal((await endpoint.POST(multipart(), context)).status, status); assert.equal(h.calls.runtime, 0); assert.equal(h.calls.network.length, 0);
    assert.equal((await endpoint.GET(new Request(`${origin}/api/atencion/${id}/messages?requestId=${requestId}`), context)).status, status);
  }
  const h = harness({ messagingError: new core.AttentionError("No asignada", 404) }); const endpoint = route(messagesPath, h);
  assert.equal((await endpoint.POST(multipart({ headers: { origin: "https://other.example" } }), context)).status, 403); assert.equal(h.calls.access, 0);
  assert.equal((await endpoint.POST(multipart(), context)).status, 404); assert.equal(h.calls.queue, 0); assert.equal(h.calls.network.length, 0);
});
test("message route returns 202 on ambiguity and safe 200 on accepted receipt", async () => {
  for (const uncertain of [true, false]) {
    const h = harness(uncertain ? { sendError: new Error("private transport data") } : {}); const endpoint = route(messagesPath, h);
    const response = await endpoint.POST(multipart(), context); assert.equal(response.status, uncertain ? 202 : 200);
    assert.match(response.headers.get("cache-control"), /private, no-store/); const body = await response.json();
    assert.equal(body.uncertain, uncertain); assert.equal(JSON.stringify(body).includes("private transport data"), false);
  }
});
test("media route returns authenticated 206 with private headers and no provider URL", async () => {
  const h = harness(); const endpoint = route(mediaPath, h);
  const response = await endpoint.GET(new Request(`${origin}/api/atencion/${id}/messages/${messageId}/media`, { headers: { range: "bytes=2-5" } }), context);
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), `bytes 2-5/${png.length}`); assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin"); assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png.subarray(2, 6)); assert.equal(h.calls.media, 2);
  const denied = harness(); const deniedRoute = route(mediaPath, denied, { authError: new core.AttentionError("Sin sesión", 401) });
  assert.equal((await deniedRoute.GET(new Request(origin), context)).status, 401); assert.equal(denied.calls.network.length, 0);
});
function webhookRequest({ tampered = false, signature = true } = {}) {
  const payload = { object: "whatsapp_business_account", entry: [{ id: env.WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID, changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: env.WHATSAPP_ATTENTION_PHONE_NUMBER_ID },
    messages: [{ id: wamid, from: phone, timestamp: String(now / 1000 - 60), type: "text", text: { body: "Mensaje de prueba" } }],
  } }] }] };
  const raw = Buffer.from(`${JSON.stringify(payload, null, 2)}\r\n`);
  const signed = `sha256=${createHmac("sha256", env.WHATSAPP_ATTENTION_APP_SECRET).update(raw).digest("hex")}`;
  return new Request(`${origin}/api/integraciones/atencion/whatsapp`, { method: "POST", body: tampered ? Buffer.concat([raw, Buffer.from(" ")]) : raw,
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signed } : {}) } });
}
test("webhook route verifies exact raw signature before ingesting any event", async () => {
  const h = harness(); const endpoint = route(webhookPath, h);
  assert.equal((await endpoint.POST(webhookRequest())).status, 200); assert.equal(h.calls.ingest.length, 1); assert.equal(h.calls.ingest[0].messages[0].id, wamid);
  for (const options of [{ tampered: true }, { signature: false }]) assert.equal((await endpoint.POST(webhookRequest(options))).status, 401);
  assert.equal(h.calls.ingest.length, 1); assert.equal(h.calls.network.length, 0);
});
test("webhook database failure is not acknowledged; challenge performs no import", async () => {
  const h = harness({ ingestError: new Error("private database diagnostic") }); const endpoint = route(webhookPath, h);
  const failed = await endpoint.POST(webhookRequest()); assert.equal(failed.status, 500); assert.equal((await failed.text()).includes("private database diagnostic"), false);
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": env.WHATSAPP_ATTENTION_VERIFY_TOKEN, "hub.challenge": "123456" });
  const response = await endpoint.GET(new Request(`${origin}/api/integraciones/atencion/whatsapp?${params}`));
  assert.equal(response.status, 200); assert.equal(await response.text(), "123456"); assert.equal(h.calls.ingest.length, 1); assert.equal(h.calls.network.length, 0);
});

function cancellationRequest({ headers = {}, query = `requestId=${requestId}` } = {}) {
  return new Request(`${origin}/api/atencion/${id}/messages?${query}`, { method: "DELETE", headers: { origin, ...headers } });
}
test("cancel service delegates authenticated identity and preserves durable store refusal of late POST", async () => {
  const h = harness();
  assert.deepEqual(await h.service.cancel(actor, id, requestId), { cancelled: true });
  assert.deepEqual(h.calls.cancel, [{ actor, conversationId: id, requestId }]);
  // The real database's cancellation persistence is covered separately; this
  // verifies that the service never bypasses its refusal after cancellation.
  for (let repeat = 0; repeat < 2; repeat++) await assert.rejects(h.service.send(actor, id, textInput), { status: 409 });
  assert.equal(h.calls.claim, 0); assert.equal(h.calls.network.length, 0);
});
test("DELETE cancellation is idempotent at the route and never invokes Meta", async () => {
  const h = harness(); const endpoint = route(messagesPath, h);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await endpoint.DELETE(cancellationRequest(), context);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { cancelled: true });
    assert.match(response.headers.get("cache-control"), /private, no-store/);
  }
  assert.deepEqual(h.calls.cancel, Array.from({ length: 2 }, () => ({ actor, conversationId: id, requestId })));
  assert.equal(h.calls.network.length, 0);
});
test("DELETE cancellation requires session and same-origin before reaching storage", async () => {
  for (const status of [401, 403]) {
    const h = harness(); const endpoint = route(messagesPath, h, { authError: new core.AttentionError("Sin autorización", status) });
    const response = await endpoint.DELETE(cancellationRequest(), context);
    assert.equal(response.status, status); assert.equal(h.calls.runtime, 0); assert.deepEqual(h.calls.cancel, []); assert.equal(h.calls.network.length, 0);
  }
  for (const headers of [{ origin: "https://other.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }]) {
    const h = harness(); const endpoint = route(messagesPath, h);
    assert.equal((await endpoint.DELETE(cancellationRequest({ headers }), context)).status, 403);
    assert.equal(h.calls.access, 0); assert.equal(h.calls.runtime, 0); assert.deepEqual(h.calls.cancel, []);
  }
});
test("DELETE validates unique request UUID and conversation UUID before cancellation", async () => {
  const h = harness(); const endpoint = route(messagesPath, h);
  for (const query of ["", "requestId=invalid", `requestId=${requestId}&requestId=${requestId}`]) assert.equal((await endpoint.DELETE(cancellationRequest({ query }), context)).status, 400);
  assert.equal((await endpoint.DELETE(cancellationRequest(), { params: Promise.resolve({ id: "invalid" }) })).status, 400);
  assert.deepEqual(h.calls.cancel, []); assert.equal(h.calls.runtime, 0);
});
test("DELETE preserves repeated 409 for an already started send and does not cancel or retry it", async () => {
  const h = harness({ row: { status: "sending", sendStartedAt: new Date(now).toISOString() }, cancelError: new core.AttentionError("El envío ya se inició y no puede cancelarse.", 409) });
  const endpoint = route(messagesPath, h);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await endpoint.DELETE(cancellationRequest(), context);
    assert.equal(response.status, 409); assert.match((await response.json()).error, /no puede cancelarse/);
  }
  assert.equal(h.row().status, "sending"); assert.equal(h.calls.cancel.length, 2); assert.equal(h.calls.network.length, 0);
});
test("DELETE preserves conversation authorization failure from storage", async () => {
  const h = harness({ cancelError: new core.AttentionError("Conversación no asignada", 404) }); const endpoint = route(messagesPath, h);
  assert.equal((await endpoint.DELETE(cancellationRequest(), context)).status, 404); assert.equal(h.calls.network.length, 0);
});
