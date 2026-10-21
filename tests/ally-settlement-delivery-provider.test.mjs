import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { sendSettlementDelivery, DeliveryProviderError, SETTLEMENT_WHATSAPP_TEMPLATE_BODY } =
  await jiti.import("../lib/ally-settlement-delivery-provider.ts");
const attemptId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const emailId = "33333333-3333-4333-8333-333333333333";
const env = {
  ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", RESEND_API_KEY: "fixture-not-a-real-key", RESEND_SETTLEMENT_DOMAIN_ID: domainId,
  WHATSAPP_ACCESS_TOKEN: "fixture-not-a-real-token", WHATSAPP_PHONE_NUMBER_ID: "111111111111111",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "222222222222222", WHATSAPP_SETTLEMENT_TEMPLATE_NAME: "liquidacion_aliado",
  WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE: "es_CO",
};
const input = (channel = "EMAIL", patch = {}) => ({
  channel, attemptId, recipient: channel === "EMAIL" ? "aliado@example.invalid" : "+57 300 1234567",
  subject: "FINSER PAY | Liquidación del 01/10/2026 al 15/10/2026",
  text: "Hola, Aliado de prueba. Liquidación generada. No confirma un desembolso.",
  allyName: "Aliado de prueba", periodStart: "01/10/2026", periodEnd: "15/10/2026", netAmount: "$ 123.456",
  pdf: Buffer.from("%PDF-1.7\nfixture de prueba\n%%EOF"), filename: "liquidacion-prueba.pdf", ...patch,
});
const verifiedDomain = () => ({ id: domainId, name: "finserpay.com", status: "verified", capabilities: { sending: "enabled" } });
const template = () => ({
  name: "liquidacion_aliado", status: "APPROVED", language: "es_CO", parameter_format: "POSITIONAL",
  components: [{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: SETTLEMENT_WHATSAPP_TEMPLATE_BODY }],
});

function fixture(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal, "all provider calls have a deadline");
    assert.equal(options.redirect, "error", "credentials cannot follow redirects");
    calls.push({ url, options });
    if (overrides.handle) {
      const response = await overrides.handle(url, options);
      if (response !== undefined) return response;
    }
    if (url.startsWith("https://api.resend.com/domains/")) return Response.json(overrides.domain ?? verifiedDomain());
    if (url === "https://api.resend.com/emails") return Response.json({ id: emailId });
    if (url.endsWith("?fields=id,display_phone_number")) return Response.json(overrides.phone ?? { id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 312 4085562" });
    if (url.includes("/phone_numbers?")) return Response.json({ data: overrides.numbers ?? [{ id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 312 4085562" }] });
    if (url.includes("/message_templates?")) return Response.json({ data: overrides.templates ?? [template()] });
    if (url.endsWith("/media")) return Response.json(overrides.media ?? { id: "333333333333333" });
    if (url.endsWith("/messages")) return Response.json({ messages: [{ id: "wamid.fixture123==" }] });
    assert.fail(`Unexpected provider request ${url}`);
  };
  return { calls, fetcher };
}
const rejectsSafely = (run, matcher) => assert.rejects(run, error => {
  assert.ok(error instanceof DeliveryProviderError);
  assert.equal(error.uncertain, false);
  if (matcher) assert.match(error.message, matcher);
  return true;
});

test("disabled/missing configuration never calls the provider or beforeSend", async () => {
  for (const enabled of [undefined, "false", "TRUE", " true "]) {
    let called = false;
    await rejectsSafely(() => sendSettlementDelivery(input(), {
      env: { ...env, ALLY_SETTLEMENT_DELIVERY_ENABLED: enabled },
      fetch: async () => { called = true; throw new Error("must not run"); },
      beforeSend: async () => { called = true; },
    }), /ALLY_SETTLEMENT_DELIVERY_ENABLED/);
    assert.equal(called, false);
  }
  for (const key of ["RESEND_API_KEY", "RESEND_SETTLEMENT_DOMAIN_ID"]) {
    const f = fixture();
    await rejectsSafely(() => sendSettlementDelivery(input(), { env: { ...env, [key]: "" }, fetch: f.fetcher }), new RegExp(key));
    assert.equal(f.calls.length, 0);
  }
  for (const key of ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID",
    "WHATSAPP_SETTLEMENT_TEMPLATE_NAME", "WHATSAPP_SETTLEMENT_TEMPLATE_LANGUAGE"]) {
    const f = fixture();
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP"), { env: { ...env, [key]: "" }, fetch: f.fetcher }), new RegExp(key));
    assert.equal(f.calls.length, 0);
  }
});

test("invalid destinations, metadata and PDF are rejected before provider work", async () => {
  for (const patch of [
    { recipient: "a@example.invalid,b@example.invalid" }, { recipient: "name <a@example.invalid>" },
    { recipient: "a@example.invalid\r\nBcc: b@example.invalid" }, { attemptId: "not-uuid" },
    { pdf: Buffer.from("not a pdf") }, { filename: "../private.pdf" }, { filename: "x\ny.pdf" },
    { subject: "subject\r\nBcc: other@example.invalid" }, { allyName: "" },
  ]) {
    const f = fixture();
    await rejectsSafely(() => sendSettlementDelivery(input("EMAIL", patch), { env, fetch: f.fetcher }));
    assert.equal(f.calls.length, 0);
  }
  for (const recipient of ["", "call +57 300 1234567", "123", "+57 3001234567\n"]) {
    const f = fixture();
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP", { recipient }), { env, fetch: f.fetcher }));
    assert.equal(f.calls.length, 0);
  }
});

test("email verifies sender authorization and attaches exactly the frozen PDF to one recipient", async () => {
  const f = fixture(); let boundary = 0;
  const data = input();
  const result = await sendSettlementDelivery(data, { env, fetch: f.fetcher, beforeSend: async () => {
    boundary++; assert.equal(f.calls.length, 1); assert.match(f.calls[0].url, /\/domains\//);
  } });
  assert.deepEqual(result, { providerId: emailId }); assert.equal(boundary, 1); assert.equal(f.calls.length, 2);
  const request = f.calls[1]; const payload = JSON.parse(request.options.body);
  assert.equal(payload.from, "FINSER PAY <pagos@finserpay.com>");
  assert.deepEqual(payload.to, [data.recipient]);
  assert.equal(payload.subject, data.subject); assert.equal(payload.text, data.text);
  assert.equal(payload.attachments.length, 1);
  assert.deepEqual(Buffer.from(payload.attachments[0].content, "base64"), data.pdf);
  assert.equal(payload.attachments[0].filename, data.filename);
  assert.equal(request.options.headers["Idempotency-Key"], `ally-settlement/${attemptId}`);
  await sendSettlementDelivery(data, { env, fetch: f.fetcher });
  assert.equal(f.calls[3].options.body, request.options.body);
  assert.equal(f.calls[3].options.headers["Idempotency-Key"], request.options.headers["Idempotency-Key"]);
});

test("unverified, wrong, or sending-disabled Resend domain prevents email", async () => {
  for (const domain of [
    {}, { ...verifiedDomain(), id: emailId }, { ...verifiedDomain(), name: "mail.finserpay.com" },
    { ...verifiedDomain(), status: "pending" }, { ...verifiedDomain(), capabilities: { sending: "disabled" } },
  ]) {
    const f = fixture({ domain }); let boundary = false;
    await rejectsSafely(() => sendSettlementDelivery(input(), { env, fetch: f.fetcher, beforeSend: async () => { boundary = true; } }), /Resend/);
    assert.equal(f.calls.length, 1); assert.equal(boundary, false);
  }
});

test("WhatsApp verifies the exact sender and approved document template then uploads the private PDF", async () => {
  const f = fixture(); let boundary = 0;
  const data = input("WHATSAPP");
  assert.deepEqual(await sendSettlementDelivery(data, { env, fetch: f.fetcher, beforeSend: async () => {
    boundary++; assert.equal(f.calls.length, 4); assert.ok(f.calls[3].url.endsWith("/media"));
  } }), { providerId: "wamid.fixture123==" });
  assert.equal(boundary, 1); assert.equal(f.calls.length, 5);
  const media = f.calls[3].options.body;
  assert.ok(media instanceof FormData); assert.equal(media.get("messaging_product"), "whatsapp");
  assert.equal(media.get("type"), "application/pdf");
  assert.deepEqual(Buffer.from(await media.get("file").arrayBuffer()), data.pdf);
  const body = JSON.parse(f.calls[4].options.body);
  assert.equal(body.to, "573001234567"); assert.equal(body.biz_opaque_callback_data, attemptId);
  assert.equal(body.type, "template"); assert.equal(body.template.name, env.WHATSAPP_SETTLEMENT_TEMPLATE_NAME);
  assert.deepEqual(body.template.language, { code: "es_CO" });
  assert.deepEqual(body.template.components[0].parameters, [{ type: "document", document: { id: "333333333333333", filename: data.filename } }]);
  assert.deepEqual(body.template.components[1].parameters.map(p => p.text), [data.allyName, data.periodStart, data.periodEnd, data.netAmount]);
});

test("wrong sender, unapproved/template changed to payment confirmation, wrong language/format never sends", async () => {
  const changedBody = template(); changedBody.components[1].text = "Hola {{1}}. Hemos pagado {{4}} del {{2}} al {{3}}.";
  const wrongHeader = template(); wrongHeader.components[0].format = "IMAGE";
  const addedButton = template(); addedButton.components.push({ type: "BUTTONS", buttons: [{ type: "URL", url: "https://example.invalid" }] });
  for (const overrides of [
    { phone: { id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 300 1234567" } },
    { phone: { id: "999999999999999", display_phone_number: "+57 312 4085562" } },
    { numbers: [] },
    { numbers: [{ id: "999999999999999", display_phone_number: "+57 312 4085562" }] },
    { numbers: [{ id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 300 1234567" }] },
    { templates: [] }, { templates: [{ ...template(), status: "PENDING" }] },
    { templates: [{ ...template(), name: "cuotavencida" }] }, { templates: [{ ...template(), language: "es" }] },
    { templates: [{ ...template(), parameter_format: "NAMED" }] }, { templates: [changedBody] },
    { templates: [wrongHeader] }, { templates: [addedButton] },
  ]) {
    const f = fixture(overrides); let boundary = false;
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP"), { env, fetch: f.fetcher, beforeSend: async () => { boundary = true; } }));
    assert.ok(f.calls.every(call => call.options.method !== "POST")); assert.equal(boundary, false);
  }
});

test("preflight/upload failure is known-unsent even on network failure, invalid response, or HTTP 5xx", async () => {
  for (const target of ["/domains/", "?fields=", "/phone_numbers?", "/message_templates?", "/media"]) {
    for (const failure of ["network", "badjson", "missingid", 503]) {
      const f = fixture({ handle: async url => {
        if (!url.includes(target)) return;
        if (failure === "network") throw new Error("sensitive token and provider body");
        if (failure === "badjson") return new Response("not json");
        if (failure === "missingid") return Response.json({});
        return new Response("sensitive provider body", { status: failure });
      } });
      let boundary = false;
      await rejectsSafely(() => sendSettlementDelivery(input(target === "/domains/" ? "EMAIL" : "WHATSAPP"), {
        env, fetch: f.fetcher, beforeSend: async () => { boundary = true; },
      }));
      assert.equal(boundary, false);
      assert.ok(!f.calls.some(call => call.url.endsWith("/messages") || call.url.endsWith("/emails")));
    }
  }
});

test("outbound failures distinguish definitive rejection from ambiguous acceptance without leaking provider content", async () => {
  for (const channel of ["EMAIL", "WHATSAPP"]) {
    for (const [failure, uncertain] of [[400, false], [401, false], [429, false], [408, true], [409, true], [503, true], ["network", true], ["badjson", true], ["missingid", true]]) {
      const f = fixture({ handle: async url => {
        if (!url.endsWith("/emails") && !url.endsWith("/messages")) return;
        if (failure === "network") throw new Error("DO_NOT_LOG_TOKEN");
        if (failure === "badjson") return new Response("DO_NOT_LOG_TOKEN");
        if (failure === "missingid") return Response.json({ messages: [{ id: "unsafe\nreceipt" }] });
        return new Response("DO_NOT_LOG_TOKEN", { status: failure });
      } });
      let boundary = 0;
      await assert.rejects(() => sendSettlementDelivery(input(channel), { env, fetch: f.fetcher, beforeSend: async () => { boundary++; } }), error => {
        assert.ok(error instanceof DeliveryProviderError); assert.equal(error.uncertain, uncertain);
        assert.ok(!error.message.includes("DO_NOT_LOG_TOKEN")); return true;
      });
      assert.equal(boundary, 1);
    }
  }
});

test("database claim lost at beforeSend prevents any message POST", async () => {
  for (const channel of ["EMAIL", "WHATSAPP"]) {
    const f = fixture();
    await assert.rejects(() => sendSettlementDelivery(input(channel), { env, fetch: f.fetcher,
      beforeSend: async () => { throw new Error("claim lost"); },
    }), /claim lost/);
    assert.ok(!f.calls.some(call => call.url.endsWith("/messages") || call.url.endsWith("/emails")));
  }
});

test("WhatsApp verifies WABA ownership through bounded cursor pagination without following provider next URLs", async () => {
  const cursor = "opaque+/=?cursor"; let pages = 0;
  const f = fixture({ handle: async url => {
    if (!url.includes("/phone_numbers?")) return;
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://graph.facebook.com");
    assert.equal(parsed.pathname, `/v25.0/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers`);
    assert.equal(parsed.searchParams.get("fields"), "id,display_phone_number");
    assert.equal(parsed.searchParams.get("limit"), "100");
    pages++;
    if (pages === 1) {
      assert.equal(parsed.searchParams.get("after"), null);
      return Response.json({ data: [{ id: "999999999999999", display_phone_number: "+57 300 1234567" }],
        paging: { next: "https://untrusted.example.invalid/do-not-follow", cursors: { after: cursor } } });
    }
    assert.equal(parsed.searchParams.get("after"), cursor);
    return Response.json({ data: [{ id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 312 4085562" }] });
  } });
  assert.deepEqual(await sendSettlementDelivery(input("WHATSAPP"), { env, fetch: f.fetcher }), { providerId: "wamid.fixture123==" });
  assert.equal(pages, 2);
  assert.ok(f.calls.every(call => call.url.startsWith("https://graph.facebook.com/")));
  assert.ok(f.calls.findIndex(call => call.url.includes("/message_templates?")) > f.calls.findLastIndex(call => call.url.includes("/phone_numbers?")));
});

test("unproven WABA ownership, repeated cursors, and excessive pages cannot upload or send", async () => {
  for (const mode of ["wrong-account", "repeated-cursor", "page-limit", "invalid-cursor"]) {
    let pages = 0;
    const f = fixture({ handle: async url => {
      if (!url.includes("/phone_numbers?")) return;
      pages++;
      if (mode === "wrong-account") return Response.json({ data: [{ id: "999999999999999", display_phone_number: "+57 312 4085562" }] });
      const after = mode === "invalid-cursor" ? "unsafe\nvalue" : mode === "repeated-cursor" ? "same-cursor" : `cursor-${pages}`;
      return Response.json({ data: [], paging: { next: "https://untrusted.example.invalid", cursors: { after } } });
    } });
    let boundary = false;
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP"), { env, fetch: f.fetcher,
      beforeSend: async () => { boundary = true; },
    }), /WHATSAPP_BUSINESS_ACCOUNT_ID/);
    assert.equal(boundary, false);
    assert.equal(pages, mode === "page-limit" ? 10 : mode === "repeated-cursor" ? 2 : 1);
    assert.ok(!f.calls.some(call => call.url.includes("/message_templates?") || call.options.method === "POST"));
  }
});

test("dedicated settlement Meta configuration takes priority without changing shared integration values", async () => {
  const dedicated = Object.freeze({
    ...env,
    WHATSAPP_SETTLEMENT_ACCESS_TOKEN: "dedicated-fixture-token",
    WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: "444444444444444",
    WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID: "555555555555555",
  });
  const before = JSON.stringify(dedicated);
  const phone = { id: dedicated.WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID, display_phone_number: "+57 312 4085562" };
  const f = fixture({ phone, numbers: [phone] });
  assert.deepEqual(await sendSettlementDelivery(input("WHATSAPP"), { env: dedicated, fetch: f.fetcher }), { providerId: "wamid.fixture123==" });
  assert.equal(f.calls.length, 5);
  for (const call of f.calls) {
    assert.equal(call.options.headers.Authorization, "Bearer dedicated-fixture-token");
    assert.ok(!call.url.includes(`/${env.WHATSAPP_PHONE_NUMBER_ID}`));
    assert.ok(!call.url.includes(`/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}`));
  }
  assert.ok(f.calls[0].url.includes(`/${dedicated.WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID}?`));
  assert.ok(f.calls[1].url.includes(`/${dedicated.WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID}/phone_numbers?`));
  assert.ok(f.calls[2].url.includes(`/${dedicated.WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID}/message_templates?`));
  assert.ok(f.calls[4].url.endsWith(`/${dedicated.WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID}/messages`));
  assert.equal(JSON.stringify(dedicated), before);
  assert.equal(dedicated.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_ACCESS_TOKEN);
  assert.equal(dedicated.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_PHONE_NUMBER_ID);
  assert.equal(dedicated.WHATSAPP_BUSINESS_ACCOUNT_ID, env.WHATSAPP_BUSINESS_ACCOUNT_ID);
});

test("omitted dedicated Meta settings fall back individually while invalid defined overrides never fall back", async () => {
  const f = fixture();
  const tokenOnly = { ...env, WHATSAPP_SETTLEMENT_ACCESS_TOKEN: "dedicated-token-only" };
  assert.deepEqual(await sendSettlementDelivery(input("WHATSAPP"), { env: tokenOnly, fetch: f.fetcher }), { providerId: "wamid.fixture123==" });
  assert.ok(f.calls.every(call => call.options.headers.Authorization === "Bearer dedicated-token-only"));
  assert.ok(f.calls[0].url.includes(`/${env.WHATSAPP_PHONE_NUMBER_ID}?`));
  assert.ok(f.calls[1].url.includes(`/${env.WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers?`));
  for (const [name, value] of [
    ["WHATSAPP_SETTLEMENT_ACCESS_TOKEN", ""],
    ["WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID", ""],
    ["WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID", "not-a-phone-id"],
    ["WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID", " "],
    ["WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID", "https://wrong.invalid"],
  ]) {
    const invalid = fixture();
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP"), {
      env: { ...env, [name]: value }, fetch: invalid.fetcher,
    }), new RegExp(name));
    assert.equal(invalid.calls.length, 0);
  }
});

test("partial or mismatched dedicated sender overrides still require the official phone and matching WABA", async () => {
  const dedicatedPhoneId = "444444444444444";
  const dedicatedBusinessId = "555555555555555";
  for (const [patch, overrides, expected] of [
    [{ WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: dedicatedPhoneId }, {
      phone: { id: dedicatedPhoneId, display_phone_number: "+57 300 1234567" },
    }, /WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID/],
    [{ WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: dedicatedPhoneId }, {
      phone: { id: dedicatedPhoneId, display_phone_number: "+57 312 4085562" },
      numbers: [{ id: env.WHATSAPP_PHONE_NUMBER_ID, display_phone_number: "+57 312 4085562" }],
    }, /WHATSAPP_BUSINESS_ACCOUNT_ID/],
    [{ WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: dedicatedPhoneId, WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID: dedicatedBusinessId }, {
      phone: { id: dedicatedPhoneId, display_phone_number: "+57 312 4085562" }, numbers: [],
    }, /WHATSAPP_SETTLEMENT_BUSINESS_ACCOUNT_ID/],
  ]) {
    const f = fixture(overrides);
    let boundary = false;
    await rejectsSafely(() => sendSettlementDelivery(input("WHATSAPP"), {
      env: { ...env, ...patch }, fetch: f.fetcher, beforeSend: async () => { boundary = true; },
    }), expected);
    assert.equal(boundary, false);
    assert.ok(f.calls.every(call => call.options.method !== "POST"));
  }
});
