import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { sendSettlementDelivery, settlementDaptaReceipt, DeliveryProviderError } = await jiti.import("../lib/ally-settlement-delivery-provider.ts");
const { verifySettlementDaptaToken } = await jiti.import("../lib/ally-settlement-delivery-dapta-auth.ts");
const attemptId = "11111111-1111-4111-8111-111111111111";
const recipient = "573001234567";
const env = {
  ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", WHATSAPP_SETTLEMENT_PROVIDER: "dapta",
  DAPTA_SETTLEMENT_WEBHOOK_URL: "https://api.dapta.ai/api/v1/test-only-flow?api_key=fixture",
  ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "callback-fixture-secret-32-bytes-minimum",
  ALLY_SETTLEMENT_MEDIA_SECRET: "media-fixture-secret-32-bytes-minimum",
};
const input = {
  channel: "WHATSAPP", attemptId, recipient, allyName: "Aliado de prueba", periodStart: "01/10/2026", periodEnd: "15/10/2026",
  netAmount: "COP 123.456", subject: "Liquidación de prueba", text: "No confirma un desembolso.",
  pdf: Buffer.from("%PDF-1.4\nfixture only"), filename: "liquidacion-prueba.pdf",
};
const receipt = (extra = {}) => ({ ok: true, accepted: true, event_id: attemptId, recipient,
  sender: "573124085562", provider_message_id: "wamid.fixture123==", code: null, ...extra });
test("Dapta uses existing official flow and sends only identifiers after durable boundary", async () => {
  let boundary = false; let calls = 0;
  const result = await sendSettlementDelivery(input, { env, beforeSend: async () => { boundary = true; }, fetch: async (url, request) => {
    calls++; assert.equal(boundary, true); assert.equal(url, env.DAPTA_SETTLEMENT_WEBHOOK_URL);
    assert.equal(request.method, "POST"); assert.equal(request.redirect, "error"); assert.equal(request.cache, "no-store");
    assert.ok(request.signal instanceof AbortSignal);
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body).sort(), ["callback_token", "event_id", "recipient"]);
    assert.equal(body.event_id, attemptId); assert.equal(body.recipient, recipient);
    assert.equal(verifySettlementDaptaToken(body.callback_token, attemptId, recipient, env), true);
    assert.ok(!request.body.includes(env.ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET));
    assert.ok(!request.body.includes("PDF")); assert.ok(!request.body.includes("Aliado de prueba"));
    return Response.json({ response: receipt() });
  } });
  assert.equal(calls, 1); assert.deepEqual(result, { providerId: "wamid.fixture123==" });
});
test("Dapta disabled/malformed credentials and provider never reach HTTP or boundary", async () => {
  const patches = [
    { ALLY_SETTLEMENT_DELIVERY_ENABLED: "false" }, { WHATSAPP_SETTLEMENT_PROVIDER: "other" },
    { DAPTA_SETTLEMENT_WEBHOOK_URL: "" }, { DAPTA_SETTLEMENT_WEBHOOK_URL: "http://api.dapta.ai/flow" },
    { DAPTA_SETTLEMENT_WEBHOOK_URL: "https://evil.invalid/flow" }, { DAPTA_SETTLEMENT_WEBHOOK_URL: "https://api.dapta.ai.evil.invalid/flow" },
    { DAPTA_SETTLEMENT_WEBHOOK_URL: "https://user:secret@api.dapta.ai/flow" }, { DAPTA_SETTLEMENT_WEBHOOK_URL: "https://api.dapta.ai/flow#secret" },
    { ALLY_SETTLEMENT_MEDIA_SECRET: "short" }, { ALLY_SETTLEMENT_DAPTA_CALLBACK_SECRET: "short" },
  ];
  for (const patch of patches) {
    let calls = 0;
    await assert.rejects(() => sendSettlementDelivery(input, { env: { ...env, ...patch },
      beforeSend: async () => { calls++; }, fetch: async () => { calls++; throw new Error("no"); },
    }), error => error instanceof DeliveryProviderError && !error.uncertain);
    assert.equal(calls, 0);
  }
});
test("Dapta cannot send if database lease was lost", async () => {
  let calls = 0;
  await assert.rejects(() => sendSettlementDelivery(input, { env, beforeSend: async () => { throw new Error("lost lease"); },
    fetch: async () => { calls++; return Response.json(receipt()); },
  }), /lost lease/);
  assert.equal(calls, 0);
});

test("Dapta validates the exact media signing secret before the boundary or any request", async () => {
  for (const secret of [
    undefined, "", "x".repeat(31), ` ${"x".repeat(32)}`, `${"x".repeat(32)} `,
    `${"x".repeat(32)}\n`, `${"x".repeat(16)}\u0000${"x".repeat(16)}`, "á".repeat(2049),
  ]) {
    let boundary = 0, requests = 0;
    await assert.rejects(() => sendSettlementDelivery(input, {
      env: { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: secret },
      beforeSend: async () => { boundary++; },
      fetch: async () => { requests++; return Response.json(receipt()); },
    }), error => error instanceof DeliveryProviderError && !error.uncertain && /ALLY_SETTLEMENT_MEDIA_SECRET/.test(error.message));
    assert.equal(boundary, 0);
    assert.equal(requests, 0);
  }
  let boundary = 0, requests = 0;
  await sendSettlementDelivery(input, {
    env: { ...env, ALLY_SETTLEMENT_MEDIA_SECRET: "á".repeat(16) },
    beforeSend: async () => { boundary++; },
    fetch: async () => { requests++; assert.equal(boundary, 1); return Response.json(receipt()); },
  });
  assert.equal(requests, 1, "The signing contract measures UTF-8 bytes, not character count");
});
test("Only a real receipt matching attempt, destination and official sender counts as sent", () => {
  for (const payload of [
    { ok: true }, { execution_id: "fake" }, { data: receipt() }, receipt({ event_id: "other" }),
    receipt({ recipient: "573009999999" }), receipt({ sender: "573113539730" }), receipt({ provider_message_id: "success" }),
    receipt({ accepted: false }), receipt({ success: false }), receipt({ status: "failed" }),
    receipt({ status: "error" }), receipt({ code: "PENDING" }), { response: receipt(), error: "node failed" },
    { response: receipt(), success: false }, { response: receipt(), nodes: [{ suppressed: true }] },
    { response: receipt(), scheduled: true }, { response: receipt(), nodes: [{ success: false }] },
    { ...receipt(), ok: false, accepted: false, provider_message_id: null, code: "PROVIDER_REJECTED" },
  ]) assert.deepEqual(settlementDaptaReceipt(payload, attemptId, recipient), { status: "UNCERTAIN" });
  assert.deepEqual(settlementDaptaReceipt(receipt(), attemptId, recipient), { status: "ACCEPTED", providerId: "wamid.fixture123==" });
});
test("HTTP/network/malformed receipts are uncertain, with no retries or leaked credentials", async () => {
  for (const mode of ["network", "json", "missing", "large", "chunked-large", 400, 401, 429, 503]) {
    let calls = 0;
    await assert.rejects(() => sendSettlementDelivery(input, { env, fetch: async () => {
      calls++;
      if (mode === "network") throw new Error("DO_NOT_LEAK");
      if (mode === "json") return new Response("DO_NOT_LEAK");
      if (mode === "missing") return Response.json({ ok: true });
      if (mode === "large") return new Response("DO_NOT_LEAK", { headers: { "content-length": "9999999" } });
      if (mode === "chunked-large") return new Response("x".repeat(140000));
      return new Response("DO_NOT_LEAK", { status: mode });
    } }), error => error instanceof DeliveryProviderError && error.uncertain && !error.message.includes("DO_NOT_LEAK"));
    assert.equal(calls, 1);
  }
});
test("Only explicit correlated Meta rejection permits safe retry", async () => {
  const rejected = receipt({ ok: false, accepted: false, provider_message_id: null, code: "META_REJECTED",
    provider_http_status: 400, provider_error_code: 132000 });
  for (const payload of [rejected, { ...rejected, status: "failed" }, { ...rejected, status: "failed", success: false }]) {
    for (const wrapped of [payload, { response: payload }]) {
      assert.deepEqual(settlementDaptaReceipt(wrapped, attemptId, recipient), { status: "FAILED" });
      let requests = 0;
      await assert.rejects(() => sendSettlementDelivery(input, { env, fetch: async () => { requests++; return Response.json(wrapped); } }),
        error => error instanceof DeliveryProviderError && !error.uncertain);
      assert.equal(requests, 1, "A proven rejection is retryable, but the provider must not retry by itself");
    }
  }
  for (const patch of [
    { provider_error_code: undefined }, { provider_http_status: 500 }, { event_id: "wrong" },
    { status: "accepted" }, { success: true }, { ok: true }, { accepted: true },
    { provider_message_id: "wamid.already-accepted" }, { suppressed: true }, { scheduled: true },
  ]) {
    assert.deepEqual(settlementDaptaReceipt({ ...rejected, ...patch }, attemptId, recipient), { status: "UNCERTAIN" });
  }
  assert.deepEqual(settlementDaptaReceipt({ response: { ...rejected, status: "failed" }, nodes: [{ status: "failed" }] }, attemptId, recipient), { status: "UNCERTAIN" });
});
