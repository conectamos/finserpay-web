import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import sharp from "sharp";
import ExcelJS from "exceljs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createMetaAttentionAdapter, getMetaAttentionScope, META_ATTENTION_LINE, validateMetaAttentionMedia } = await jiti.import("../lib/atencion-meta.ts");
const { readMetaManualTemplate } = await jiti.import("../lib/atencion-meta-templates.ts");
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
const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Ventas").addRow(["Informe artificial", 215]);
const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
// Small stored ZIP fixtures exercise malicious package metadata without extracting any content.
function zipFixture(names = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
  const locals = [], records = []; let offset = 0;
  for (const name of names) {
    const filename = Buffer.from(name), data = Buffer.from("<fixture/>"); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, filename, data); records.push(central, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
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
const bsuid = "CO.A1b2C3";
const bsuidContact = { user_id: bsuid, profile: { name: "Perfil de prueba", username: "usuario.prueba" } };
function userEnvelope(messages = [{ ...inbound, from: undefined, from_user_id: bsuid }], contacts = [bsuidContact], statuses = []) {
  const body = envelope(messages, statuses); body.entry[0].changes[0].value.contacts = contacts; return body;
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
test("BSUID-only inbound retains its opaque identifier, separate profile and username without fabricating a phone", () => {
  const body = userEnvelope([
    { ...inbound, from: undefined, from_user_id: bsuid },
    { ...inbound, id: "wamid.SECOND_USER", from: undefined, from_user_id: "US.SecondUser" },
  ], [
    { wa_id: "12025550199", user_id: "US.Unrelated", profile: { name: "No corresponde", username: "no.corresponde" } },
    { user_id: "US.SecondUser", profile: { name: "Segundo perfil", username: "segundo.usuario" } }, bsuidContact,
  ]);
  const events = adapter().parseWebhook(...sign(body));
  assert.equal(events.ignored, 0); assert.equal(events.messages.length, 2);
  assert.equal(events.messages[0].from, bsuid); assert.equal(events.messages[0].userId, bsuid); assert.equal(events.messages[0].phone, null);
  assert.equal(events.messages[0].name, "Perfil de prueba"); assert.equal(events.messages[0].username, "usuario.prueba");
  assert.equal(events.messages[1].from, "US.SecondUser"); assert.equal(events.messages[1].name, "Segundo perfil");
  const noContact = adapter().parseWebhook(...sign(userEnvelope(undefined, []))).messages[0];
  assert.equal(noContact.from, bsuid); assert.equal(noContact.phone, null); assert.equal(noContact.name, null); assert.equal(noContact.username, undefined);
});
test("coherent phone plus BSUID remains the phone conversation and never selects another contact by position", () => {
  const body = userEnvelope([{ ...inbound, from_user_id: bsuid }], [
    { wa_id: "12025550199", user_id: "US.Unrelated", profile: { name: "No corresponde" } },
    { ...bsuidContact, wa_id: phone },
  ]);
  const message = adapter().parseWebhook(...sign(body)).messages[0];
  assert.equal(message.from, phone); assert.equal(message.phone, `+${phone}`); assert.equal(message.userId, bsuid);
  assert.equal(message.name, bsuidContact.profile.name); assert.equal(message.username, bsuidContact.profile.username);
  const legacy = adapter().parseWebhook(...sign(userEnvelope([inbound], [{ ...bsuidContact, wa_id: phone }]))).messages[0];
  assert.equal(legacy.from, phone); assert.equal(legacy.userId, undefined, "a missing message-level BSUID does not learn a contact alias");
});
test("BSUID media retains the real attachment and caption for image, audio, video, document and sticker", () => {
  for (const [type, mime_type] of [["image", "image/png"], ["audio", "audio/ogg"], ["video", "video/mp4"], ["document", "application/pdf"], ["sticker", "image/webp"]]) {
    const body = userEnvelope([{ ...inbound, from: undefined, from_user_id: bsuid, type, text: undefined,
      [type]: { id: "1234567890", mime_type, caption: "Adjunto de prueba", url: "https://untrusted.invalid/file" } }]);
    const events = adapter().parseWebhook(...sign(body)), message = events.messages[0];
    assert.equal(events.ignored, 0); assert.equal(message.from, bsuid); assert.equal(message.phone, null);
    assert.equal(message.type, type); assert.equal(message.media.id, "1234567890"); assert.equal(message.media.url, undefined);
  }
});
test("ambiguous or contradictory contact pairs and malformed identifiers are ignored without guessing a phone", () => {
  const both = { ...inbound, from_user_id: bsuid }, hidden = { ...inbound, from: undefined, from_user_id: bsuid };
  for (const [message, contacts] of [
    [both, [{ wa_id: phone, user_id: "US.Other" }]],
    [both, [{ wa_id: "12025550199", user_id: bsuid }]],
    [both, [{ wa_id: phone, user_id: bsuid }, { wa_id: phone, user_id: "US.Other" }]],
    [inbound, [{ wa_id: phone, user_id: bsuid }, { wa_id: phone, user_id: "US.Other" }]],
    [hidden, [{ wa_id: phone, user_id: bsuid }, { wa_id: "12025550199", user_id: bsuid }]],
    [both, [{ wa_id: phone, user_id: "CO.invalid_id" }]],
    [hidden, [{ wa_id: "not-a-phone", user_id: bsuid }]],
    [{ ...hidden, from: "" }, []], [{ ...hidden, from_user_id: "+CO.A1" }, []],
    [{ ...hidden, from_user_id: "CO.ENT.A1" }, []], [{ ...hidden, from_user_id: `CO.${"a".repeat(129)}` }, []],
  ]) {
    const events = adapter().parseWebhook(...sign(userEnvelope([message], contacts)));
    assert.equal(events.messages.length, 0); assert.equal(events.ignored, 1);
  }
});
test("BSUID parsing preserves raw signatures and fixed scope and rejects group messages", () => {
  const body = userEnvelope(), signed = sign(body);
  assert.throws(() => adapter().parseWebhook(Buffer.concat([signed[0], Buffer.from(" ")]), signed[1]), { code: "INVALID_SIGNATURE" });
  for (const change of [
    b => { b.entry[0].id = "0000000000"; },
    b => { b.entry[0].changes[0].value.metadata.phone_number_id = "0000000000"; },
    b => { b.entry[0].changes[0].value.messages[0].group_id = "group"; },
    b => { b.entry[0].changes[0].value.group_id = "group"; },
  ]) {
    const other = structuredClone(body); change(other);
    const events = adapter().parseWebhook(...sign(other)); assert.equal(events.messages.length, 0); assert.equal(events.ignored, 1);
  }
});
test("BSUID app echoes and statuses remain outbound and do not manufacture a customer phone or author", () => {
  const echoBody = echoEnvelope([{ ...echo, to: undefined, to_user_id: bsuid }]);
  echoBody.entry[0].changes[0].value.contacts = [bsuidContact];
  const echoed = adapter().parseWebhook(...sign(echoBody));
  assert.deepEqual(echoed.messages, []); assert.equal(echoed.echoes[0].from, businessPhone); assert.equal(echoed.echoes[0].to, bsuid);
  assert.equal(echoed.echoes[0].phone, null); assert.equal(echoed.echoes[0].name, null); assert.equal(echoed.echoes[0].userId, bsuid);
  assert.equal(echoed.echoes[0].username, "usuario.prueba");
  const events = adapter().parseWebhook(...sign(userEnvelope([], [bsuidContact], [
    { id: wamid, recipient_user_id: bsuid, timestamp: inbound.timestamp, status: "read", biz_opaque_callback_data: input.attemptId },
  ])));
  assert.equal(events.ignored, 0); assert.deepEqual(events.messages, []); assert.equal(events.statuses[0].recipient, bsuid);
  assert.equal(events.statuses[0].userId, bsuid); assert.equal(events.statuses[0].requestId, input.attemptId);
  const failed = envelope([], [{ id: wamid, recipient_id: phone, timestamp: inbound.timestamp, status: "failed", errors: [{ code: 131000 }] }]);
  delete failed.entry[0].changes[0].value.contacts;
  assert.equal(adapter().parseWebhook(...sign(failed)).statuses[0].recipient, phone);
});
test("BSUID echo/status pairs remain coherent and a known self-contact cannot become a customer echo", () => {
  for (const contacts of [[{ wa_id: phone, user_id: "CO.OtherUser" }], [{ wa_id: "12025550199", user_id: bsuid }]]) {
    const echoBody = echoEnvelope([{ ...echo, to_user_id: bsuid }]); echoBody.entry[0].changes[0].value.contacts = contacts;
    const echoed = adapter().parseWebhook(...sign(echoBody)); assert.equal(echoed.echoes.length, 0); assert.equal(echoed.ignored, 1);
    const statuses = adapter().parseWebhook(...sign(userEnvelope([], contacts, [{ id: wamid, recipient_id: phone, recipient_user_id: bsuid, timestamp: inbound.timestamp, status: "read" }])));
    assert.equal(statuses.statuses.length, 0); assert.equal(statuses.ignored, 1);
  }
  const own = echoEnvelope([{ ...echo, to: undefined, to_user_id: bsuid }]);
  own.entry[0].changes[0].value.contacts = [{ user_id: bsuid, wa_id: businessPhone }];
  assert.equal(adapter().parseWebhook(...sign(own)).echoes.length, 0);
  const coherent = adapter().parseWebhook(...sign(userEnvelope([], [{ ...bsuidContact, wa_id: phone }], [{ id: wamid, recipient_id: phone, recipient_user_id: bsuid, timestamp: inbound.timestamp, status: "read" }])));
  assert.equal(coherent.statuses[0].recipient, phone); assert.equal(coherent.statuses[0].userId, bsuid);
});
test("unsupported identifiers, formats, timestamps and marked secrets are not exposed", () => {
  const events = adapter().parseWebhook(...sign(envelope([
    { ...inbound, text: { body: "OTP: 123456 contraseña: prueba123 bearer abc.def.ghi" } },
    { ...inbound, from: "US.0000000000000000" }, { ...inbound, timestamp: "bad" },
    { ...inbound, type: "document", document: { id: "1234567890", mime_type: "text/html" } },
  ])));
  assert.equal(events.messages.length, 2); assert.equal(events.ignored, 2);
  assert.equal(events.messages[0].text.includes("123456"), false); assert.equal(events.messages[0].text.includes("prueba123"), false);
  assert.match(events.messages[1].text, /Documento recibido no compatible/); assert.equal(events.messages[1].media, undefined);
});

test("Excel recibido conserva el documento y su caption tanto entrante como desde WhatsApp Business", () => {
  for (const [base, wrap, property] of [[inbound, envelope, "messages"], [echo, echoEnvelope, "echoes"]]) {
    const message = { ...base, type: "document", text: undefined, document: { id: "1234567890", mime_type: xlsxMime, filename: "VENTAS.xlsx", caption: "Informe artificial de cierre", url: "https://untrusted.invalid/private" } };
    const events = adapter().parseWebhook(...sign(wrap([message]))), received = events[property][0];
    assert.equal(events.ignored, 0); assert.equal(received.id, base.id); assert.equal(received.type, "document");
    assert.equal(received.media.fileName, "VENTAS.xlsx"); assert.equal(received.media.mimeType, xlsxMime);
    assert.equal(received.media.caption, message.document.caption); assert.equal(received.media.url, undefined);
  }
});

test("otros documentos conservan ID y texto con aviso real, sin inventar un adjunto descargable", () => {
  for (const [type, name] of [["application/vnd.ms-excel", "VENTAS.xls"], ["application/vnd.ms-excel.sheet.macroEnabled.12", "VENTAS.xlsm"], ["text/html", "pagina.html"], ["application/zip", "archivo.zip"], [xlsxMime, "VENTAS.xlsm"]]) {
    for (const [base, wrap, property] of [[inbound, envelope, "messages"], [echo, echoEnvelope, "echoes"]]) {
      const message = { ...base, type: "document", text: undefined, document: { id: "1234567890", mime_type: type, filename: name, caption: "Informe de cierre. OTP: 123456" } };
      const events = adapter().parseWebhook(...sign(wrap([message]))), received = events[property][0];
      assert.equal(events.ignored, 0); assert.equal(received.id, base.id); assert.equal(received.type, "text"); assert.equal(received.media, undefined);
      assert.match(received.text, /Informe de cierre/); assert.match(received.text, /Documento recibido no compatible/); assert.ok(received.text.includes(name)); assert.ok(!received.text.includes("123456"));
    }
  }
  const invalid = { ...inbound, type: "document", text: undefined, document: { id: "fake", mime_type: xlsxMime, filename: "VENTAS.xlsx", caption: "No crear identidad ficticia" } };
  assert.equal(adapter().parseWebhook(...sign(envelope([invalid]))).messages.length, 0);
});

test("signed quick replies and list replies become visible text without executing payloads or inventing sender",()=>{
  const content=[{type:"button",button:{text:"Continuar",payload:"RUN_COMMAND_ASSIGN_ADMIN"}},
    {type:"interactive",interactive:{type:"button_reply",button_reply:{id:"RUN_COMMAND_SEND_PAYMENT",title:"Necesito ayuda"}}},
    {type:"interactive",interactive:{type:"list_reply",list_reply:{id:"RUN_COMMAND_CLOSE_CHAT",title:"Otra consulta",description:"Private payload"}}}];
  const body=envelope(content.map((value,index)=>({...inbound,...value,id:`wamid.button-${index}`,context:{id:"wamid.template-origin"}})));
  const [bytes,signature]=sign(body),events=adapter().parseWebhook(bytes,signature);
  assert.deepEqual(events.messages.map(message=>message.text),["Continuar","Necesito ayuda","Otra consulta"]);
  assert.ok(events.messages.every(message=>message.type==="text"&&message.from===phone&&message.phone===`+${phone}`&&message.replyToId==="wamid.template-origin"));
  assert.ok(!JSON.stringify(events).includes("RUN_COMMAND"));assert.ok(!JSON.stringify(events).includes("Private payload"));
  assert.throws(()=>adapter().parseWebhook(Buffer.concat([bytes,Buffer.from(" ")]),signature),{code:"INVALID_SIGNATURE"});
  const invalid=adapter().parseWebhook(...sign(envelope([{...inbound,type:"button",button:{payload:"not text"}},
    {...inbound,type:"interactive",interactive:{type:"flow_reply",flow_reply:{title:"unsupported"}}},
    {...inbound,...content[0],from:"ADMIN"}])));
  assert.equal(invalid.messages.length,0);assert.equal(invalid.ignored,3);
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
test("BSUID text and media use only recipient, verify scope and accept the exact user_id ACK", async () => {
  for (const media of [false, true]) {
    let claimed = false;
    const mock = transportMock({ custom: (url, init) => {
      if (url.pathname === "/v25.0/1234567890") return json({ id: "1234567890", mime_type: "image/png", file_size: png.length,
        url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?signed=private" });
      if (url.pathname.endsWith("/messages")) {
        assert.equal(claimed, true); const payload = JSON.parse(init.body);
        assert.equal(payload.recipient, bsuid); assert.equal(Object.hasOwn(payload, "to"), false);
        assert.equal(payload.type, media ? "image" : "text");
        return json({ messaging_product: "whatsapp", contacts: [{ input: bsuid, user_id: bsuid }], messages: [{ id: wamid }] });
      }
    } });
    const client = adapter({ fetch: mock.transport }), claim = async () => { claimed = true; };
    const receipt = media ? await client.sendMedia({ ...input, recipient: bsuid, kind: "image", mediaId: "1234567890" }, claim)
      : await client.sendText({ ...input, recipient: bsuid }, claim);
    assert.deepEqual(receipt, { providerMessageId: wamid, recipient: bsuid });
    assert.equal(mock.requests.filter(request => request.init.method === "POST").length, 1);
    assert.equal(mock.requests.filter(request => request.url.pathname.endsWith("/phone_numbers")).length, 1);
  }
});
test("BSUID templates use the same recipient contract and retain catalogue and persisted-send guards", async () => {
  const raw = { id: "12345678901", name: "atencion_prueba", language: "es", category: "UTILITY", status: "APPROVED", parameter_format: "POSITIONAL",
    components: [{ type: "BODY", text: "Hola {{1}}, recibimos tu consulta." }] };
  const definition = readMetaManualTemplate(raw); assert.equal(definition.available, true); let claims = 0;
  const mock = transportMock({ custom: (url, init) => {
    if (url.pathname.endsWith("/message_templates")) return json({ data: [raw] });
    if (url.pathname.endsWith("/messages")) {
      const payload = JSON.parse(init.body); assert.equal(claims, 1); assert.equal(payload.type, "template");
      assert.equal(payload.recipient, bsuid); assert.equal(Object.hasOwn(payload, "to"), false);
      return json({ messaging_product: "whatsapp", contacts: [{ input: bsuid, user_id: bsuid }], messages: [{ id: wamid }] });
    }
  } });
  const receipt = await adapter({ fetch: mock.transport }).sendTemplate({ ...input, recipient: bsuid, snapshot: { definition, parameters: { "body:1": "Perfil de prueba" } } }, async () => { claims++; });
  assert.deepEqual(receipt, { providerMessageId: wamid, recipient: bsuid });
  assert.equal(mock.requests.filter(request => request.init.method === "POST").length, 1);
});
test("legacy plus phone stays a phone send and malformed opaque recipients never reach Meta", async () => {
  const mock = transportMock();
  assert.deepEqual(await adapter({ fetch: mock.transport }).sendText({ ...input, recipient: `+${phone}` }, async () => {}), { providerMessageId: wamid, recipient: phone });
  const payload = JSON.parse(mock.requests.find(request => request.init.method === "POST").init.body);
  assert.equal(payload.to, phone); assert.equal(Object.hasOwn(payload, "recipient"), false);
  for (const value of ["+CO.A1", "CO.A_B", "CO.ENT.A1", "CO.", "co.A1", `CO.${"a".repeat(129)}`]) {
    await assert.rejects(adapter().sendText({ ...input, recipient: value }, async () => assert.fail("invalid recipient cannot claim")), { code: "INVALID_RECIPIENT" });
  }
  await assert.rejects(adapter().sendText({ ...input, recipient: bsuid, lastInboundAt: "2026-10-29T18:00:00Z" }, async () => assert.fail("closed service window cannot claim")), { code: "SERVICE_WINDOW_CLOSED" });
});
test("mismatched BSUID ACKs, transport errors and 5xx remain uncertain and never retry or fall back to phone", async () => {
  for (const mode of ["missing", "different", "input", "duplicate", "network", "server"]) {
    let posts = 0;
    const mock = transportMock({ custom: (url, init) => {
      if (!url.pathname.endsWith("/messages")) return;
      posts++; const payload = JSON.parse(init.body); assert.equal(payload.recipient, bsuid); assert.equal(Object.hasOwn(payload, "to"), false);
      if (mode === "network") throw new TypeError("test network failure");
      if (mode === "server") return json({ error: { code: 1 } }, 503);
      const contact = { input: mode === "input" ? "CO.OtherUser" : bsuid, ...(mode === "missing" ? { wa_id: phone } : { user_id: mode === "different" ? "CO.OtherUser" : bsuid }) };
      return json({ messaging_product: "whatsapp", contacts: mode === "duplicate" ? [contact, contact] : [contact], messages: [{ id: wamid }] });
    } });
    await assert.rejects(adapter({ fetch: mock.transport }).sendText({ ...input, recipient: bsuid }, async () => {}), error => error.uncertain === true && error.retryable === false);
    assert.equal(posts, 1, mode);
  }
});
test("verification starts independent phone and WABA reads together and shares concurrent work", async () => {
  const pending = [];
  const client = adapter({ fetch: (url) => new Promise(resolve => pending.push({ url: new URL(url), resolve })) });
  const first = client.verifyConnection(), second = client.verifyConnection();
  assert.equal(pending.length, 2, "both independent reads start before either one resolves; concurrent calls add no reads");
  pending.find(item => item.url.pathname.endsWith("/phone_numbers")).resolve(json({ data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] }));
  pending.find(item => !item.url.pathname.endsWith("/phone_numbers")).resolve(json({ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }));
  assert.deepEqual(await first, await second);
});
test("successful verification is private to one adapter, expires after five seconds and binds token and Graph version", async () => {
  const cfg = { ...env }, requests = []; let clock = now;
  const fetch = async (url, init) => { const parsed = new URL(url); requests.push({ url: parsed, authorization: init.headers.Authorization }); return parsed.pathname.endsWith("/phone_numbers")
    ? json({ data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] })
    : json({ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }); };
  const client = adapter({ env: cfg, fetch, now: () => clock });
  const returned = await client.verifyConnection(); returned.displayPhone = "must not mutate the cache";
  assert.equal((await client.verifyConnection()).displayPhone, META_ATTENTION_LINE.displayPhone); assert.equal(requests.length, 2);
  clock += 4_999; await client.verifyConnection(); assert.equal(requests.length, 2);
  clock++; await client.verifyConnection(); assert.equal(requests.length, 4);
  cfg.WHATSAPP_ATTENTION_ACCESS_TOKEN = "test-only-rotated-token"; await client.verifyConnection(); assert.equal(requests.length, 6);
  assert.equal(requests.at(-1).authorization, "Bearer test-only-rotated-token");
  cfg.WHATSAPP_GRAPH_API_VERSION = "v26.0"; await client.verifyConnection(); assert.equal(requests.length, 8); assert.match(requests.at(-1).url.pathname, /^\/v26\.0\//);
  await adapter({ env: cfg, fetch, now: () => clock }).verifyConnection(); assert.equal(requests.length, 10, "another HTTP runtime always verifies independently");
  cfg.WHATSAPP_ATTENTION_PHONE_NUMBER_ID = "99999999999";
  await assert.rejects(client.verifyConnection(), { code: "META_SCOPE_CONFIG" }); assert.equal(requests.length, 10);
});
test("verification failures and credential changes while pending never produce a cached success", async () => {
  let broken = true;
  const mock = transportMock({ custom: url => broken && url.pathname.endsWith("/phone_numbers") ? json({ data: [] }) : undefined });
  const client = adapter({ fetch: mock.transport });
  await assert.rejects(client.verifyConnection(), { code: "META_SCOPE_MISMATCH" });
  broken = false; await client.verifyConnection(); assert.equal(mock.requests.length, 4, "a failure must be retried against Meta");
  const cfg = { ...env }, pending = [];
  const changed = adapter({ env: cfg, fetch: url => new Promise(resolve => pending.push({ url: new URL(url), resolve })) });
  const first = changed.verifyConnection(); cfg.WHATSAPP_ATTENTION_ACCESS_TOKEN = "test-only-new-token";
  for (const item of pending) item.resolve(json(item.url.pathname.endsWith("/phone_numbers")
    ? { data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] }
    : { id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }));
  await assert.rejects(first, { code: "META_SCOPE_CONFIG" });
  const next = changed.verifyConnection(); assert.equal(pending.length, 4, "changed credentials require a fresh pair of reads");
  for (const item of pending.slice(2)) item.resolve(json(item.url.pathname.endsWith("/phone_numbers")
    ? { data: [{ id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }] }
    : { id: META_ATTENTION_LINE.phoneNumberId, display_phone_number: META_ATTENTION_LINE.displayPhone }));
  await next;
});
test("upload and media send reuse the short verification but still validate metadata and the transactional claim", async () => {
  const mock = mediaMock(), client = adapter({ fetch: mock.transport }); let claimed = false;
  await client.uploadMedia({ bytes: png, mimeType: "image/png", fileName: "image.png", kind: "image" });
  await client.sendMedia({ ...input, mediaId: "1234567890", kind: "image" }, async () => { claimed = true; });
  assert.equal(claimed, true);
  assert.equal(mock.requests.filter(item => item.url.pathname.endsWith("/phone_numbers")).length, 1);
  assert.equal(mock.requests.filter(item => item.url.pathname === `/v25.0/${META_ATTENTION_LINE.phoneNumberId}`).length, 1);
  assert.equal(mock.requests.filter(item => item.url.pathname === "/v25.0/1234567890").length, 1, "uploaded media metadata remains independently validated");
  assert.equal(mock.requests.filter(item => item.init.method === "POST").length, 2, "one upload and one send, without retries");
  const cfg = { ...env }, flagsMock = transportMock(), guarded = adapter({ env: cfg, fetch: flagsMock.transport });
  await guarded.verifyConnection(); cfg.WHATSAPP_ATTENTION_SEND_ENABLED = "false";
  await assert.rejects(guarded.sendText(input, async () => assert.fail("disabled sends cannot claim")), { code: "META_SEND_DISABLED" });
  assert.equal(flagsMock.requests.length, 2, "cached verification never bypasses fresh enablement guards");
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
test("XLSX real se descarga privado con autenticación, hash y rango sin habilitar envío de Office", async () => {
  const mock = mediaMock({ bytes: xlsx, type: xlsxMime }), result = await adapter({ fetch: mock.transport }).downloadMedia({ mediaId: "1234567890" });
  assert.equal(result.status, 200); assert.equal(result.mimeType, xlsxMime); assert.deepEqual(Buffer.from(result.bytes), xlsx);
  assert.equal(mock.requests.length, 2); assert.equal(mock.requests[1].init.headers.Authorization, `Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);
  const ranged = await adapter({ fetch: mediaMock({ bytes: xlsx, type: xlsxMime }).transport }).downloadMedia({ mediaId: "1234567890", range: "bytes=2-15" });
  assert.equal(ranged.status, 206); assert.deepEqual(Buffer.from(ranged.bytes), xlsx.subarray(2, 16));
  assert.throws(() => validateMetaAttentionMedia({ bytes: xlsx, mimeType: xlsxMime, fileName: "VENTAS.xlsx" }), { code: "UNSUPPORTED_MEDIA" });
  await assert.rejects(adapter({ fetch: mock.transport }).uploadMedia({ bytes: xlsx, mimeType: xlsxMime, fileName: "VENTAS.xlsx" }), { code: "UNSUPPORTED_MEDIA" });
  await assert.rejects(adapter({ fetch: mock.transport }).sendMedia({ ...input, mediaId: "1234567890", kind: "document", fileName: "VENTAS.xlsx" }, async () => {}), { code: "UNSUPPORTED_MEDIA" });
  const printable = zipFixture(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/printerSettings/printerSettings1.bin", "xl/media/image1.emf", "xl/media/image2.wmf", "xl/drawings/vmlDrawing1.vml"]);
  const printableResult = await adapter({ fetch: mediaMock({ bytes: printable, type: xlsxMime }).transport }).downloadMedia({ mediaId: "1234567890" });
  assert.deepEqual(Buffer.from(printableResult.bytes), printable, "printer settings and normal Office drawings stay opaque download-only parts");
});
test("recepción XLSX rechaza ZIP arbitrario, rutas peligrosas, macros, cifrado, solapamientos y expansión excesiva", async () => {
  const base = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/worksheets/sheet1.xml"];
  const encrypted = zipFixture(); encrypted.writeUInt16LE(1, 6); encrypted.writeUInt16LE(1, encrypted.readUInt32LE(encrypted.length - 6) + 8);
  const bomb = zipFixture(); bomb.writeUInt32LE(0x10000000, bomb.readUInt32LE(bomb.length - 6) + 24);
  const overlap = zipFixture(); overlap.writeUInt32LE(0, overlap.readUInt32LE(overlap.length - 6) + 46 + Buffer.byteLength(base[0]) + 42);
  const bad = [Buffer.from("<html>VENTAS.xlsx</html>"), zipFixture(["unrelated.txt"]), zipFixture(base.slice(0, -1)), encrypted, bomb, overlap, zipFixture([...base, "../archivo.xml"]), zipFixture([...base, "xl/vbaProject.bin"]), zipFixture([...base, "xl/macrosheets/sheet1.xml"]), zipFixture([...base, "xl/embeddings/oleObject1.bin"]), zipFixture([...base, "xl/printerSettings/payload.bin"]), zipFixture([...base, "xl/worksheets/SHEET1.XML"]), Buffer.concat([xlsx, Buffer.from("trailing")]), xlsx.subarray(0, xlsx.length - 2)];
  for (const bytes of bad) await assert.rejects(adapter({ fetch: mediaMock({ bytes, type: xlsxMime }).transport }).downloadMedia({ mediaId: "1234567890" }), { code: "INVALID_MEDIA_CONTENT" });
  const oversized = mediaMock({ bytes: xlsx, type: xlsxMime, metadata: { file_size: 16 * 1024 * 1024 + 1 } });
  await assert.rejects(adapter({ fetch: oversized.transport }).downloadMedia({ mediaId: "1234567890" }), { code: "UNSUPPORTED_MEDIA" }); assert.equal(oversized.requests.length, 1);
  await assert.rejects(adapter({ fetch: mediaMock({ bytes: xlsx, type: xlsxMime, metadata: { sha256: "0".repeat(64) } }).transport }).downloadMedia({ mediaId: "1234567890" }), { code: "INVALID_MEDIA_HASH" });
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

test("transport diagnostics expose only stage and allowlisted name/code without credentials or raw provider errors",async t=>{
  const logs=[];t.mock.method(console,"warn",(...args)=>logs.push(args));
  const failure=new TypeError("private token signed-url client information",{cause:Object.assign(new Error("private cause"),{code:"ECONNRESET"})});
  await assert.rejects(adapter({fetch:async()=>{throw failure;}}).verifyConnection(),{code:"META_UNAVAILABLE",uncertain:false});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(logs.filter(([name])=>name==="[attention-meta-transport]"),["phone","waba_phones","phone","waba_phones"].map(operation=>["[attention-meta-transport]",JSON.stringify({operation,error:"TypeError",cause:"ECONNRESET",aborted:false})]));
  assert.deepEqual(logs.filter(([name])=>name==="[attention-meta-read-retry]"),["phone","waba_phones"].map(operation=>["[attention-meta-read-retry]",JSON.stringify({operation,attempt:2,code:"META_UNAVAILABLE",delayMs:250})]));
  const count=logs.length;
  await assert.rejects(adapter({fetch:async()=>{throw {name:"secret name",code:"secret code",message:"private message"};}}).verifyConnection(),{code:"META_UNAVAILABLE"});
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual(logs.slice(count).filter(([name])=>name==="[attention-meta-transport]"),["phone","waba_phones","phone","waba_phones"].map(operation=>["[attention-meta-transport]",JSON.stringify({operation,error:"UnknownError",cause:"UNKNOWN",aborted:false})]));
  assert.ok(!JSON.stringify(logs).includes("private"));assert.ok(!JSON.stringify(logs).includes("secret"));assert.ok(!JSON.stringify(logs).includes(env.WHATSAPP_ATTENTION_ACCESS_TOKEN));
});

test("a transient WABA connection failure recovers once before the only message POST",async()=>{
  let reads=0,claims=0;
  const mock=transportMock({custom:url=>{
    if(url.pathname.endsWith("/phone_numbers")&&++reads===1)throw new TypeError("private transport failure",{cause:Object.assign(new Error("private"),{code:"UND_ERR_CONNECT_TIMEOUT"})});
  }});
  const receipt=await adapter({fetch:mock.transport}).sendText(input,async()=>{claims++;});
  assert.equal(receipt.providerMessageId,wamid);assert.equal(reads,2);assert.equal(claims,1);
  assert.equal(mock.requests.filter(item=>item.init.method==="POST").length,1);
  assert.equal(mock.requests.filter(item=>item.url.pathname===`/v25.0/${META_ATTENTION_LINE.phoneNumberId}`).length,1);
});

test("GET retries transient HTTP429/5xx but never authorization or validation rejections",async()=>{
  for(const status of[429,500,503,400,401,403]){
    let reads=0;
    const mock=transportMock({custom:url=>url.pathname.endsWith("/phone_numbers")&&++reads===1?json({error:{code:status,message:"private details"}},status):undefined});
    const call=adapter({fetch:mock.transport}).verifyConnection();
    if([429,500,503].includes(status)){await call;assert.equal(reads,2);}
    else{await assert.rejects(call,{code:"META_HTTP_ERROR",uncertain:false,retryable:false});assert.equal(reads,1);}
    assert.equal(mock.requests.some(item=>item.init.method==="POST"),false);
  }
});

test("a repeated transient read failure stops after two attempts and never claims a send",async()=>{
  let reads=0;
  const mock=transportMock({custom:url=>{if(url.pathname.endsWith("/phone_numbers")){reads++;throw new TypeError("private transport failure");}}});
  await assert.rejects(adapter({fetch:mock.transport}).sendText(input,async()=>assert.fail("No claim before verification")),{code:"META_UNAVAILABLE",uncertain:false,retryable:true});
  assert.equal(reads,2);assert.equal(mock.requests.some(item=>item.init.method==="POST"),false);
});

test("uploads are never retried for transport loss, HTTP429 or HTTP5xx",async()=>{
  for(const status of[0,429,503]){
    const mock=transportMock({custom:url=>{
      if(!url.pathname.endsWith("/media"))return;
      if(!status)throw new TypeError("private upload failure");
      return json({error:{code:status,message:"private details"}},status);
    }});
    await assert.rejects(adapter({fetch:mock.transport}).uploadMedia({bytes:pdf,mimeType:"application/pdf",fileName:"receipt.pdf"}),{uncertain:false});
    assert.equal(mock.requests.filter(item=>item.init.method==="POST").length,1);
  }
});

test("a stalled GET body is cancelled within the total read budget and is not retried after expiry",async()=>{
  let cancelled=false,signal,reads=0;
  const mock=transportMock({custom:(url,init)=>{
    if(!url.pathname.endsWith("/phone_numbers"))return;
    reads++;signal=init.signal;
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":['));},cancel(){cancelled=true;}}));
  }});
  await assert.rejects(adapter({fetch:mock.transport,timeoutMs:100}).verifyConnection(),{code:"META_UNAVAILABLE",uncertain:false});
  assert.equal(cancelled,true);assert.equal(signal.aborted,true);assert.equal(reads,1);
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
