import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createMetaAttentionAdapter, getMetaAttentionScope, META_ATTENTION_LINE, validateMetaAttentionMedia } = await jiti.import("../lib/atencion-meta.ts");
const now = Date.parse("2026-10-30T18:00:00Z");
const env = {
  WHATSAPP_ATTENTION_ACCESS_TOKEN: "test-only-attention-token", WHATSAPP_ATTENTION_APP_SECRET: "test-only-app-secret",
  WHATSAPP_ATTENTION_VERIFY_TOKEN: "test-only-verify-token", WHATSAPP_ATTENTION_PHONE_NUMBER_ID: META_ATTENTION_LINE.phoneNumberId,
  WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: META_ATTENTION_LINE.wabaId, WHATSAPP_GRAPH_API_VERSION: "v25.0",
  WHATSAPP_ATTENTION_SEND_ENABLED: "true", WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true",
};
const phone = "12025550100";
const input = { recipient: phone, attemptId: "00000000-0000-4000-8000-000000000001", cutoverConfirmed: true, lastInboundAt: "2026-10-30T17:00:00Z", text: "Consulta de prueba" };
const wamid = "wamid.TEST_MESSAGE";
const inbound = { id: wamid, from: phone, timestamp: String(now / 1000 - 60), type: "text", text: { body: "Consulta de prueba" } };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const pdf = Buffer.from("%PDF-1.7\nexample\n%%EOF\n");
function envelope(messages = [inbound], statuses = []) {
  return { object: "whatsapp_business_account", entry: [{ id: META_ATTENTION_LINE.wabaId, changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: META_ATTENTION_LINE.phoneNumberId },
    contacts: [{ wa_id: phone, profile: { name: "Persona de prueba" } }], messages, statuses,
  } }] }] };
}
const businessPhone = META_ATTENTION_LINE.displayPhone.slice(1);
const echo = { ...inbound, id: "wamid.APP_REPLY", from: businessPhone, to: phone, text: { body: "Respuesta desde la app" } };
function echoEnvelope(echoes = [echo]) {
  const body = envelope([], []), change = body.entry[0].changes[0];
  change.field = "smb_message_echoes";
  change.value.message_echoes = echoes;
  return body;
}
function sign(body) { const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); return [raw, `sha256=${createHmac("sha256", env.WHATSAPP_ATTENTION_APP_SECRET).update(raw).digest("hex")}`]; }
function adapter(overrides = {}) { return createMetaAttentionAdapter({ env: { ...env }, now: () => now, fetch: async () => { throw new Error("Unexpected network request"); }, ...overrides }); }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
function transportMock(options = {}) {
  const requests = [];
  const transport = async (url, init) => {
    const parsed = new URL(url); requests.push({ url: parsed, init });
    assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store");
    assert.equal(init.headers.Authorization, `Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);
    assert.equal(parsed.searchParams.has("access_token"), false);
    if (options.custom) { const response = await options.custom(parsed, init); if (response) return response; }
    assert.equal(parsed.origin, "https://graph.facebook.com");
    if (parsed.pathname === `/v25.0/${META_ATTENTION_LINE.phoneNumberId}`) return json({ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone });
    if (parsed.pathname.endsWith("/phone_numbers")) return json({ data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] });
    if (parsed.pathname.endsWith("/messages")) return json({ messaging_product: "whatsapp", contacts: [{ input: phone, wa_id: phone }], messages: [{ id: wamid }] });
    if (parsed.pathname.endsWith("/media")) return json({ id: "1234567890" });
    throw new Error("Unexpected mock request");
  };
  return { requests, transport };
}
function mediaMock(overrides = {}) {
  const bytes = overrides.bytes ?? png; const type = overrides.type ?? "image/png";
  return transportMock({ custom: async (url, init) => {
    if (url.pathname === "/v25.0/1234567890") {
      assert.equal(url.searchParams.get("phone_number_id"), META_ATTENTION_LINE.phoneNumberId);
      return json({ id: "1234567890", mime_type: type, file_size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?signed=private", ...overrides.metadata });
    }
    if (url.hostname === "lookaside.fbsbx.com") return overrides.binary?.(url, init) ?? new Response(bytes, { headers: { "content-type": type } });
  } });
}

test("dedicated configuration never falls back to OTP; safe status and scope", () => {
  assert.equal(adapter().status().canSend, true);
  const wrong = adapter({ env: { WHATSAPP_ACCESS_TOKEN: "test-only-other", WHATSAPP_PHONE_NUMBER_ID: META_ATTENTION_LINE.phoneNumberId } });
  assert.equal(wrong.status().configured, false); assert.equal(getMetaAttentionScope({}), null);
  assert.deepEqual(getMetaAttentionScope(env), { phoneNumberId: META_ATTENTION_LINE.phoneNumberId, wabaId: META_ATTENTION_LINE.wabaId });
  assert.equal(JSON.stringify(adapter().status()).includes(env.WHATSAPP_ATTENTION_ACCESS_TOKEN), false);
});
test("challenge requires exact mode, token and singular parameters", () => {
  const params = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": env.WHATSAPP_ATTENTION_VERIFY_TOKEN, "hub.challenge": "123456" });
  assert.equal(adapter().verifyWebhookChallenge(params), "123456");
  params.append("hub.challenge", "999"); assert.throws(() => adapter().verifyWebhookChallenge(params), { code: "INVALID_CHALLENGE" });
});
test("HMAC verifies exact raw bytes before parsing, no forged scope or invalid JSON", () => {
  const [raw, signature] = sign(envelope());
  assert.equal(adapter().parseWebhook(raw, signature).messages.length, 1);
  assert.throws(() => adapter().parseWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature), { code: "INVALID_SIGNATURE" });
  assert.throws(() => adapter().parseWebhook(raw, null), { code: "INVALID_SIGNATURE" });
  assert.throws(() => adapter().parseWebhook(...sign("{")), { code: "INVALID_WEBHOOK" });
  assert.throws(() => adapter().parseWebhook(Buffer.alloc(1024 * 1024 + 1), signature), { code: "WEBHOOK_TOO_LARGE" });
});
test("webhooks import only expected WABA and phone, contacts matched by wa_id", () => {
  const body = envelope(); body.entry.unshift({ ...body.entry[0], id: "0000000000" });
  body.entry[1].changes.unshift({ field: "messages", value: { ...body.entry[1].changes[0].value, metadata: { phone_number_id: "0000000000" } } });
  const events = adapter().parseWebhook(...sign(body));
  assert.equal(events.messages.length, 1); assert.equal(events.ignored, 2);
  assert.equal(events.messages[0].phone, `+${phone}`); assert.equal(events.messages[0].name, "Persona de prueba");
  assert.equal(events.messages[0].timestamp, "2026-10-30T17:59:00.000Z");
});
test("media and delivery DTOs exclude URLs/payloads and preserve correlation UUID", () => {
  const body = envelope([{ ...inbound, type: "image", text: undefined, image: { id: "1234567890", mime_type: "image/png", caption: "Prueba", url: "https://untrusted.invalid/private" } }],
    [{ id: wamid, recipient_id: phone, timestamp: inbound.timestamp, status: "delivered", biz_opaque_callback_data: input.attemptId, errors: [{ code: 131000, message: "private provider payload" }] }]);
  const events = adapter().parseWebhook(...sign(body));
  assert.equal(events.messages[0].media.id, "1234567890"); assert.equal(events.statuses[0].requestId, input.attemptId);
  assert.deepEqual(events.statuses[0].errorCodes, [131000]); assert.equal(JSON.stringify(events).includes("private"), false);
});
test("unsupported identifiers, formats, timestamps and marked secrets are not exposed", () => {
  const events = adapter().parseWebhook(...sign(envelope([
    { ...inbound, text: { body: "OTP: 123456 contraseña: prueba123 bearer abc.def.ghi" } },
    { ...inbound, from: "US.0000000000000000" }, { ...inbound, timestamp: "bad" },
    { ...inbound, type: "document", document: { id: "1234567890", mime_type: "text/html" } },
  ])));
  assert.equal(events.messages.length, 1); assert.equal(events.ignored, 3);
  assert.equal(events.messages[0].text.includes("123456"), false); assert.equal(events.messages[0].text.includes("prueba123"), false);
});

test("business-app echoes are separate outbound content with recipient identity and no attributed name", () => {
  const events = adapter({ env: { ...env, WHATSAPP_ATTENTION_SEND_ENABLED: "false", WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "false" } })
    .parseWebhook(...sign(echoEnvelope([{ ...echo, context: { id: inbound.id }, author: "Untrusted operator" }])));
  assert.deepEqual(events.messages, []); assert.deepEqual(events.statuses, []); assert.equal(events.ignored, 0);
  assert.deepEqual(events.echoes, [{ id: echo.id, from: businessPhone, to: phone, phone: `+${phone}`, name: null,
    timestamp: "2026-10-30T17:59:00.000Z", type: "text", text: echo.text.body, replyToId: inbound.id }]);
});

test("echoes still require the exact raw-body signature, WABA, phone and WhatsApp product", () => {
  const [raw, signature] = sign(echoEnvelope());
  assert.throws(() => adapter().parseWebhook(Buffer.concat([raw, Buffer.from(" ")]), signature), { code: "INVALID_SIGNATURE" });
  assert.throws(() => adapter().parseWebhook(raw, null), { code: "INVALID_SIGNATURE" });
  assert.throws(() => adapter().parseWebhook(raw, `sha256=${"0".repeat(64)}`), { code: "INVALID_SIGNATURE" });
  for (const alter of [
    body => { body.entry[0].id = "9999999999999999"; },
    body => { body.entry[0].changes[0].value.metadata.phone_number_id = "9999999999999999"; },
    body => { body.entry[0].changes[0].value.messaging_product = "messenger"; },
    body => { body.entry[0].changes[0].field = "message_echoes"; },
  ]) {
    const body = echoEnvelope(); alter(body);
    const events = adapter().parseWebhook(...sign(body));
    assert.deepEqual(events.echoes, []); assert.deepEqual(events.messages, []); assert.equal(events.ignored, 1);
  }
});

test("echoes reject foreign senders, self recipients, groups and non-phone identities", () => {
  const invalid = [
    { from: phone }, { from: `+${businessPhone}` }, { from: Number(businessPhone) }, { from: undefined },
    { to: businessPhone }, { to: `+${phone}` }, { to: `${phone}@g.us` }, { to: `${phone}@s.whatsapp.net` },
    { to: "CO.12345678901234567" }, { to: "1234567890123456" }, { to: "0123456789" }, { to: undefined },
    { recipient_type: "group" }, { group_id: "123456789" },
  ];
  const events = adapter().parseWebhook(...sign(echoEnvelope(invalid.map(fields => ({ ...echo, ...fields })))));
  assert.deepEqual(events.echoes, []); assert.equal(events.ignored, invalid.length);
  const grouped = echoEnvelope(); grouped.entry[0].changes[0].value.group_id = "123456789";
  assert.equal(adapter().parseWebhook(...sign(grouped)).echoes.length, 0);
});

test("malformed echo IDs, timestamps and content are ignored without manufacturing inbound messages", () => {
  const invalid = [
    { id: "not-a-wamid" }, { id: "wamid." }, { timestamp: "bad" }, { timestamp: 1793383140 },
    { timestamp: String(now / 1000 + 301) }, { timestamp: "1577836799" },
    { type: "edit" }, { type: "revoke" }, { text: { body: " " } }, { text: { body: "x".repeat(16001) } },
    { type: "image", image: { id: "https://untrusted.invalid/image", mime_type: "image/png" } },
    { type: "image", image: { id: "123456789", mime_type: "image/svg+xml" } },
    { type: "audio", audio: { id: "123456789", mime_type: "video/mp4" } },
  ];
  const events = adapter().parseWebhook(...sign(echoEnvelope([null, [], ...invalid.map(fields => ({ ...echo, ...fields }))])));
  assert.deepEqual(events.echoes, []); assert.deepEqual(events.messages, []); assert.equal(events.ignored, invalid.length + 2);
  const wrongShape = echoEnvelope({ ...echo });
  assert.deepEqual(adapter().parseWebhook(...sign(wrongShape)).echoes, []);
});

test("echo media uses the same allowlist and strips external URLs and unsafe optional fields", () => {
  const cases = [["image", "image/png"], ["audio", "audio/ogg; codecs=opus"], ["video", "video/mp4"],
    ["document", "application/pdf"], ["sticker", "image/webp"]];
  const echoes = cases.map(([type, mimeType], i) => ({ ...echo, id: `${echo.id}_${i}`, type, text: undefined,
    context: { id: "not-a-wamid" }, [type]: { id: "1234567890", mime_type: mimeType, sha256: "a".repeat(64),
      filename: type === "document" ? "Recibo prueba.pdf" : "../unsafe", caption: "OTP: 123456", url: "https://untrusted.invalid/private" } }));
  const events = adapter().parseWebhook(...sign(echoEnvelope(echoes)));
  assert.equal(events.echoes.length, 5); assert.equal(events.ignored, 0); assert.deepEqual(events.messages, []);
  for (const [index, item] of events.echoes.entries()) {
    assert.equal(item.type, cases[index][0]); assert.equal(item.media.mimeType, cases[index][1].split(";")[0]);
    assert.equal(item.media.id, "1234567890"); assert.equal(item.media.sha256, "a".repeat(64));
    assert.equal(item.replyToId, undefined); assert.equal(item.media.fileName, item.type === "document" ? "Recibo prueba.pdf" : undefined);
    assert.equal(item.media.caption.includes("123456"), false); assert.equal(item.media.url, undefined);
  }
  assert.equal(JSON.stringify(events).includes("untrusted.invalid"), false);
});

test("mixed signed batches keep app echoes, customer inbound and API receipts distinct", () => {
  const body = envelope([inbound], [{ id: "wamid.CRM_REPLY", recipient_id: phone, timestamp: inbound.timestamp, status: "read", biz_opaque_callback_data: input.attemptId }]);
  body.entry[0].changes.unshift(echoEnvelope().entry[0].changes[0]);
  // Arrays under the wrong webhook field must never cross into another direction.
  body.entry[0].changes[0].value.messages = [{ ...inbound, id: "wamid.WRONG_INBOUND" }];
  body.entry[0].changes[0].value.statuses = [{ id: echo.id, recipient_id: phone, timestamp: inbound.timestamp, status: "read" }];
  body.entry[0].changes[1].value.message_echoes = [{ ...echo, id: "wamid.WRONG_ECHO" }];
  const events = adapter().parseWebhook(...sign(body));
  assert.deepEqual(events.messages.map(item => item.id), [inbound.id]);
  assert.deepEqual(events.echoes.map(item => item.id), [echo.id]);
  assert.deepEqual(events.statuses.map(item => item.id), ["wamid.CRM_REPLY"]);
  assert.equal(events.statuses[0].requestId, input.attemptId);
});

test("echo parsing preserves wamid across redelivery for storage deduplication and has no parser state", () => {
  const client = adapter(), signed = sign(echoEnvelope());
  const first = client.parseWebhook(...signed), replay = client.parseWebhook(...signed);
  assert.deepEqual(first, replay); assert.equal(replay.echoes[0].id, echo.id);
  const repeated = client.parseWebhook(...sign(echoEnvelope([echo, echo])));
  assert.deepEqual(repeated.echoes.map(item => item.id), [echo.id, echo.id]);
  assert.deepEqual(client.parseWebhook(...sign(envelope())).echoes, []);
});
test("send checks flags, cutover, 24-hour window, UUID and beforeSend before any network", async () => {
  for (const [key, code] of [["WHATSAPP_ATTENTION_SEND_ENABLED", "META_SEND_DISABLED"], ["WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED", "META_CUTOVER_REQUIRED"]]) {
    await assert.rejects(adapter({ env: { ...env, [key]: "false" } }).sendText(input, async () => {}), { code });
  }
  await assert.rejects(adapter().sendText({ ...input, cutoverConfirmed: false }, async () => {}), { code: "META_CUTOVER_REQUIRED" });
  for (const lastInboundAt of ["2026-10-29T18:00:00Z", "2026-10-30T19:00:00Z", "2026-10-30T17:00:00"]) await assert.rejects(adapter().sendText({ ...input, lastInboundAt }, async () => {}), { code: "SERVICE_WINDOW_CLOSED" });
  await assert.rejects(adapter().sendText(input), { code: "INVALID_ATTEMPT" });
  await assert.rejects(adapter({ env: { ...env, WHATSAPP_ATTENTION_APP_SECRET: undefined } }).sendText(input, async () => {}), { code: "META_NOT_CONFIGURED" });
});
test("verified sender and WABA precede persisted claim and single send", async () => {
  const mock = transportMock(); let claimed = false;
  const receipt = await adapter({ fetch: mock.transport }).sendText(input, async () => { assert.equal(mock.requests.length, 2); claimed = true; });
  assert.equal(claimed, true); assert.deepEqual(receipt, { providerMessageId: wamid, recipient: phone });
  assert.equal(mock.requests.length, 3);
  const payload = JSON.parse(mock.requests[2].init.body);
  assert.equal(payload.biz_opaque_callback_data, input.attemptId); assert.equal(payload.text.body, input.text);
});
test("different sender or missing WABA membership prevents claim and send", async () => {
  for (const mode of ["sender", "waba"]) {
    const mock = transportMock({ custom: (url) => {
      if (mode === "sender" && url.pathname === `/v25.0/${META_ATTENTION_LINE.phoneNumberId}`) return json({ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: "+12025550101" });
      if (mode === "waba" && url.pathname.endsWith("/phone_numbers")) return json({ data: [] });
    } });
    await assert.rejects(adapter({ fetch: mock.transport }).sendText(input, async () => assert.fail("Must not claim")), { code: "META_SCOPE_MISMATCH", uncertain: false });
    assert.equal(mock.requests.some(x => x.init.method === "POST"), false);
  }
});
test("WABA pagination rebuilds fixed Graph URLs and never follows provider next", async () => {
  const mock = transportMock({ custom: url => {
    if (url.pathname.endsWith("/phone_numbers") && !url.searchParams.has("after")) return json({ data: [], paging: { next: "https://attacker.invalid/?access_token=private", cursors: { after: "cursor-2" } } });
  } });
  await adapter({ fetch: mock.transport }).verifyConnection();
  assert.equal(mock.requests[2].url.searchParams.get("after"), "cursor-2");
  assert.equal(mock.requests.every(x => x.url.hostname === "graph.facebook.com"), true);
});
test("claim failure prevents POST and is not treated as ambiguous delivery", async () => {
  const mock = transportMock(); const conflict = new Error("outbox already claimed");
  await assert.rejects(adapter({ fetch: mock.transport }).sendText(input, async () => { throw conflict; }), error => error === conflict);
  assert.equal(mock.requests.length, 2);
});
test("ambiguous send timeout, 5xx and invalid receipts never retry", async () => {
  for (const mode of ["network", "server", "receipt"]) {
    const mock = transportMock({ custom: url => {
      if (!url.pathname.endsWith("/messages")) return;
      if (mode === "network") throw new Error("private token and URL");
      if (mode === "server") return json({ error: { code: 1, message: "private" } }, 503);
      return json({ messaging_product: "whatsapp", messages: [{ id: "invalid" }] });
    } });
    await assert.rejects(adapter({ fetch: mock.transport }).sendText(input, async () => {}), error => error.uncertain === true && error.retryable === false && !error.message.includes("private"));
    assert.equal(mock.requests.filter(x => x.init.method === "POST").length, 1);
  }
});
test("structured Graph rejection is definite, preflight timeout never ambiguous", async () => {
  const mock = transportMock({ custom: url => url.pathname.endsWith("/messages") ? json({ error: { code: 131047, message: "private" } }, 400) : undefined });
  await assert.rejects(adapter({ fetch: mock.transport }).sendText(input, async () => {}), { uncertain: false });
  await assert.rejects(adapter({ fetch: async () => { throw new Error("private"); } }).sendText(input, async () => {}), { uncertain: false });
});
test("upload validates size, extension, magic and category before network", async () => {
  for (const bad of [
    { bytes: Buffer.from("<svg/>"), mimeType: "image/svg+xml", fileName: "image.svg" },
    { bytes: png, mimeType: "__proto__", fileName: "image.png" },
    { bytes: png, mimeType: "image/png", fileName: "image.html" },
    { bytes: Buffer.from("<html/>"), mimeType: "image/png", fileName: "image.png" },
    { bytes: png, mimeType: "image/png", fileName: "image.png", kind: "audio" },
    { bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mimeType: "image/png", fileName: "image.png" },
  ]) await assert.rejects(adapter().uploadMedia(bad));
  assert.equal(validateMetaAttentionMedia({ bytes: pdf, mimeType: "application/pdf", fileName: "test.pdf" }).kind, "document");
});
test("valid upload uses multipart, private header and verified phone", async () => {
  const mock = transportMock(); const result = await adapter({ fetch: mock.transport }).uploadMedia({ bytes: png, mimeType: "image/png", fileName: "test.png" });
  assert.deepEqual(result, { mediaId: "1234567890" });
  const form = mock.requests[2].init.body; assert.ok(form instanceof FormData);
  assert.equal(form.get("messaging_product"), "whatsapp"); assert.equal(form.get("file").type, "image/png");
});
test("media sends use ID, verified scope and callback correlation", async () => {
  const mock = mediaMock(); await adapter({ fetch: mock.transport }).sendMedia({ ...input, mediaId: "1234567890", kind: "image", caption: "Prueba" }, async () => {});
  const payload = JSON.parse(mock.requests.at(-1).init.body);
  assert.deepEqual(payload.image, { id: "1234567890", caption: "Prueba" }); assert.equal(payload.image.link, undefined);
});
test("download checks metadata, auth, magic and hash then supplies local byte range", async () => {
  const mock = mediaMock(); const result = await adapter({ fetch: mock.transport }).downloadMedia({ mediaId: "1234567890", range: "bytes=2-5" });
  assert.equal(result.status, 206); assert.deepEqual(Buffer.from(result.bytes), png.subarray(2, 6)); assert.equal(result.contentRange, `bytes 2-5/${png.length}`);
  assert.equal(mock.requests[1].init.headers.Range, undefined);
  const suffix = await adapter({ fetch: mediaMock().transport }).downloadMedia({ mediaId: "1234567890", range: "bytes=-3" });
  assert.deepEqual(Buffer.from(suffix.bytes), png.subarray(-3));
});
test("download rejects non-Meta URLs, redirects, mismatched metadata and excess bytes", async () => {
  for (const url of ["http://lookaside.fbsbx.com/whatsapp_business/attachments/", "https://lookaside.fbsbx.com.evil.invalid/whatsapp_business/attachments/", "https://127.0.0.1/whatsapp_business/attachments/", "https://lookaside.fbsbx.com:444/whatsapp_business/attachments/", "https://lookaside.fbsbx.com/other/"]) {
    const mock = mediaMock({ metadata: { url } }); await assert.rejects(adapter({ fetch: mock.transport }).downloadMedia({ mediaId: "1234567890" }), { code: "INVALID_MEDIA_URL" });
    assert.equal(mock.requests.length, 1);
  }
  for (const overrides of [
    { binary: () => new Response(null, { status: 302, headers: { location: "https://evil.invalid" } }) },
    { metadata: { sha256: "0".repeat(64) } },
    { binary: () => new Response(png, { headers: { "content-type": "text/html" } }) },
    { binary: () => new Response(Buffer.concat([png, png]), { headers: { "content-type": "image/png" } }) },
  ]) await assert.rejects(adapter({ fetch: mediaMock(overrides).transport }).downloadMedia({ mediaId: "1234567890" }));
});
test("ranges are single bounded byte ranges; impossible range returns 416", async () => {
  for (const range of ["bytes=0-1,3-4", "items=0-5", "bytes=-0", "bytes=999-", "bytes=5-2"]) await assert.rejects(adapter({ fetch: mediaMock().transport }).downloadMedia({ mediaId: "1234567890", range }), { status: 416 });
});
test("body streaming enforces byte limit even without content-length", async () => {
  const mock = transportMock({ custom: url => url.pathname === `/v25.0/${META_ATTENTION_LINE.phoneNumberId}` ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } })) : undefined });
  await assert.rejects(adapter({ fetch: mock.transport }).verifyConnection(), { code: "RESPONSE_TOO_LARGE", uncertain: false });
});
test("real AbortSignal deadline aborts one send and reports ambiguous without retry", async () => {
  const mock = transportMock({ custom: async (url, init) => {
    if (url.pathname.endsWith("/messages")) await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("transport timeout")), { once: true }));
  } });
  await assert.rejects(adapter({ fetch: mock.transport, timeoutMs: 100 }).sendText(input, async () => {}), { code: "META_UNAVAILABLE", uncertain: true, retryable: false });
  assert.equal(mock.requests.filter(x => x.init.method === "POST").length, 1);
});
test("send window is rechecked after a delayed transactional claim", async () => {
  const mock = transportMock(); let current = now;
  const client = adapter({ fetch: mock.transport, now: () => current });
  await assert.rejects(client.sendText(input, async () => { current += 24 * 60 * 60_000; }), { code: "SERVICE_WINDOW_CLOSED", uncertain: false });
  assert.equal(mock.requests.filter(x => x.init.method === "POST").length, 0);
});
test("audio/video MP4 requires corresponding container track, not just filename", () => {
  const box = (type, data) => { const out = Buffer.alloc(8 + data.length); out.writeUInt32BE(out.length); out.write(type, 4); data.copy(out, 8); return out; };
  const ftyp = box("ftyp", Buffer.from("isom0000"));
  const track = kind => { const hdlr = Buffer.alloc(12); hdlr.write(kind, 8); return Buffer.concat([ftyp, box("moov", box("trak", box("mdia", box("hdlr", hdlr))))]); };
  assert.equal(validateMetaAttentionMedia({ bytes: track("soun"), mimeType: "audio/mp4", fileName: "audio.m4a" }).kind, "audio");
  assert.equal(validateMetaAttentionMedia({ bytes: track("vide"), mimeType: "video/mp4", fileName: "video.mp4" }).kind, "video");
  assert.throws(() => validateMetaAttentionMedia({ bytes: track("vide"), mimeType: "audio/mp4", fileName: "audio.m4a" }), { code: "INVALID_MEDIA_CONTENT" });
});

test("stickers reales WEBP512 requieren estructura válida y límites diferenciados100/500KB",async()=>{
  const staticWebp=await sharp({create:{width:512,height:512,channels:4,background:{r:12,g:180,b:70,alpha:0.5}}}).webp({lossless:true}).toBuffer();
  const pixels=Buffer.alloc(512*1024*4);for(let i=0;i<pixels.length;i+=4){pixels[i]=i<512*512*4?255:0;pixels[i+1]=i<512*512*4?0:255;pixels[i+3]=255;}
  const animated=await sharp(pixels,{raw:{width:512,height:1024,channels:4,pageHeight:512}}).webp({lossless:true,delay:[150,150],loop:0}).toBuffer();
  const check=bytes=>validateMetaAttentionMedia({bytes,mimeType:"image/webp",fileName:"prueba.webp",kind:"sticker"});
  assert.equal(check(staticWebp).kind,"sticker");assert.equal(check(animated).kind,"sticker");
  const padding=(bytes,size)=>{const length=size-bytes.length-8;const chunk=Buffer.alloc(length+8);chunk.write("JUNK");chunk.writeUInt32LE(length,4);chunk.write("ANIM",8);const out=Buffer.concat([bytes,chunk]);out.writeUInt32LE(out.length-8,4);return out;};
  assert.equal(check(padding(staticWebp,100*1024)).size,100*1024);
  assert.throws(()=>check(padding(staticWebp,100*1024+2)),{code:"MEDIA_TOO_LARGE"});
  assert.equal(check(padding(animated,500*1024)).size,500*1024);
  assert.throws(()=>check(padding(animated,500*1024+2)),{code:"MEDIA_TOO_LARGE"});
  const wrongSize=await sharp({create:{width:128,height:512,channels:3,background:"red"}}).webp().toBuffer();
  assert.throws(()=>check(wrongSize),{code:"INVALID_STICKER_DIMENSIONS"});
  assert.throws(()=>check(Buffer.from("RIFF0000WEBPVP8 fake ANIM")),{code:"INVALID_MEDIA_CONTENT"});
  const truncated=staticWebp.subarray(0,staticWebp.length-2);assert.throws(()=>check(truncated),{code:"INVALID_MEDIA_CONTENT"});
  const corrupted=Buffer.from(animated);corrupted[20]&=~2;assert.throws(()=>check(corrupted),{code:"INVALID_MEDIA_CONTENT"});
});

test("tipos habituales de audio se normalizan sin aceptar archivo incompatible",()=>{
  assert.equal(validateMetaAttentionMedia({bytes:Buffer.from("ID3synthetic"),mimeType:"audio/mp3",fileName:"audio.mp3"}).mimeType,"audio/mpeg");
  assert.equal(validateMetaAttentionMedia({bytes:Buffer.from("OggS synthetic OpusHead"),mimeType:"application/ogg",fileName:"audio.ogg"}).mimeType,"audio/ogg");
  assert.throws(()=>validateMetaAttentionMedia({bytes:Buffer.from("not opus"),mimeType:"application/ogg",fileName:"audio.ogg"}),{code:"INVALID_MEDIA_CONTENT"});
});
