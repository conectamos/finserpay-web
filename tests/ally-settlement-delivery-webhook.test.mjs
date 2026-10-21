import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const jiti = createJiti(import.meta.url);
const { verifySettlementWebhook, settlementWebhookEvents } = await jiti.import("../lib/ally-settlement-delivery-webhook.ts");
const phoneId = "111111111111111";
const attemptId = "11111111-1111-4111-8111-111111111111";
const validStatus = patch => ({ id: "wamid.fixture123==", recipient_id: "573001234567", status: "sent",
  timestamp: "1792591200", biz_opaque_callback_data: attemptId, ...patch });
const payload = (statuses = [validStatus()], number = phoneId) => ({
  object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: {
    metadata: { phone_number_id: number }, statuses,
  } }] }],
});

test("webhook verification authenticates exact raw UTF-8 bytes, rejects tampering and absent/malformed signatures", () => {
  const secret = "fake-test-secret-never-a-production-secret";
  const raw = JSON.stringify({ mensaje: "Liquidación de prueba", ...payload() });
  const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  assert.equal(verifySettlementWebhook(raw, signature, secret), true);
  assert.equal(verifySettlementWebhook(`${raw}\n`, signature, secret), false);
  assert.equal(verifySettlementWebhook(raw.replace("Liquidación", "Pago"), signature, secret), false);
  assert.equal(verifySettlementWebhook(raw, signature, "another-secret"), false);
  assert.equal(verifySettlementWebhook(raw, signature, undefined), false);
  for (const invalid of [null, "", "sha1=" + "a".repeat(40), "sha256=" + "a".repeat(63), "sha256=" + "a".repeat(65), "sha256=" + "g".repeat(64)]) {
    assert.equal(verifySettlementWebhook(raw, invalid, secret), false);
  }
});

test("webhook extracts only correlated delivery statuses for the configured Meta phone", () => {
  const statuses = ["sent", "delivered", "read", "failed"].map(status => validStatus({ status }));
  const result = settlementWebhookEvents(payload(statuses), phoneId);
  assert.equal(result.length, 4);
  for (let i = 0; i < statuses.length; i++) {
    assert.deepEqual(result[i], {
      attemptId, providerId: statuses[i].id, recipient: statuses[i].recipient_id,
      status: statuses[i].status, timestamp: new Date(Number(statuses[i].timestamp) * 1000),
    });
    assert.deepEqual(Object.keys(result[i]).sort(), ["attemptId", "providerId", "recipient", "status", "timestamp"]);
  }
  assert.deepEqual(settlementWebhookEvents(payload(statuses, "999999999999999"), phoneId), []);
  assert.deepEqual(settlementWebhookEvents(payload(statuses), ""), []);
  const wrongField = payload(statuses); wrongField.entry[0].changes[0].field = "account_update";
  assert.deepEqual(settlementWebhookEvents(wrongField, phoneId), []);
  assert.deepEqual(settlementWebhookEvents({ ...payload(), object: "instagram" }, phoneId), []);
});

test("unrelated or malformed receipt values cannot reconcile settlement attempts", () => {
  const invalid = [
    { biz_opaque_callback_data: "" }, { biz_opaque_callback_data: "not-a-settlement-attempt" },
    { biz_opaque_callback_data: "11111111-1111-0111-0111-111111111111" },
    { id: "" }, { id: "not-a-wamid" }, { id: "wamid.unsafe\nreceipt" }, { id: "wamid." + "x".repeat(1000) },
    { id: 123 }, { recipient_id: "" }, { recipient_id: "+573001234567" }, { recipient_id: "123" },
    { status: "queued" }, { status: "accepted" }, { timestamp: "invalid" },
    { timestamp: null }, { timestamp: "-1" }, { timestamp: "0" }, { timestamp: "1.5" },
    { timestamp: "9".repeat(100) },
  ].map(validStatus);
  assert.deepEqual(settlementWebhookEvents(payload(invalid), phoneId), []);
  assert.equal(settlementWebhookEvents(payload([...invalid, validStatus()]), phoneId).length, 1);
});

test("malformed nested payloads are ignored without throwing or blocking a later valid event", () => {
  for (const malformed of [null, [], {}, { object: "whatsapp_business_account", entry: {} },
    { object: "whatsapp_business_account", entry: [null, "text", { changes: {} }, { changes: [null] }] },
    payload(null), payload({}), payload([null, 5, "status"]),
  ]) assert.deepEqual(settlementWebhookEvents(malformed, phoneId), []);
  const mixed = payload([null, "status", validStatus()]);
  mixed.entry.unshift(null, { changes: [null] });
  assert.equal(settlementWebhookEvents(mixed, phoneId).length, 1);
});

function webhookRouteFixture(env) {
  const reconciled = [];
  const route = loadReissueModule("app/api/integraciones/liquidaciones/whatsapp/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/ally-settlement-delivery-service": { settlementDeliveryStore: { reconcileWhatsApp: async (event) => { reconciled.push(event); } } },
    "@/lib/ally-settlement-delivery-webhook": { verifySettlementWebhook, settlementWebhookEvents },
    "@/lib/ally-settlement-delivery-body": loadReissueModule("lib/ally-settlement-delivery-body.ts"),
  }, { process: { env }, fetch: async () => assert.fail("Webhook tests cannot call any network") });
  const request = (number, secret) => {
    const raw = JSON.stringify(payload([validStatus()], number));
    const signature = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    return new Request("https://qa.invalid/api/integraciones/liquidaciones/whatsapp", {
      method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": signature }, body: raw,
    });
  };
  return { route, reconciled, request };
}

test("webhook uses the dedicated phone and secret, ignores the shared line, and leaves shared settings intact", async () => {
  const dedicatedPhoneId = "444444444444444";
  const env = Object.freeze({
    WHATSAPP_PHONE_NUMBER_ID: phoneId, WHATSAPP_APP_SECRET: "shared-test-secret",
    WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: dedicatedPhoneId, WHATSAPP_SETTLEMENT_APP_SECRET: "dedicated-test-secret",
  });
  const before = JSON.stringify(env);
  const f = webhookRouteFixture(env);
  assert.equal((await f.route.POST(f.request(dedicatedPhoneId, env.WHATSAPP_SETTLEMENT_APP_SECRET))).status, 200);
  assert.equal(f.reconciled.length, 1);
  assert.equal(f.reconciled[0].attemptId, attemptId);
  assert.equal((await f.route.POST(f.request(phoneId, env.WHATSAPP_SETTLEMENT_APP_SECRET))).status, 200);
  assert.equal(f.reconciled.length, 1, "A signed receipt for the shared campaign's phone must be ignored");
  assert.equal((await f.route.POST(f.request(dedicatedPhoneId, env.WHATSAPP_APP_SECRET))).status, 403);
  assert.equal(f.reconciled.length, 1);
  assert.equal(JSON.stringify(env), before);
});

test("webhook retains shared fallback only for omitted dedicated settings and fails closed on empty overrides", async () => {
  const shared = { WHATSAPP_PHONE_NUMBER_ID: phoneId, WHATSAPP_APP_SECRET: "shared-test-secret" };
  const legacy = webhookRouteFixture(shared);
  assert.equal((await legacy.route.POST(legacy.request(phoneId, shared.WHATSAPP_APP_SECRET))).status, 200);
  assert.equal(legacy.reconciled.length, 1);
  const emptySecret = webhookRouteFixture({ ...shared, WHATSAPP_SETTLEMENT_APP_SECRET: "" });
  assert.equal((await emptySecret.route.POST(emptySecret.request(phoneId, shared.WHATSAPP_APP_SECRET))).status, 403);
  assert.equal(emptySecret.reconciled.length, 0);
  const emptyPhone = webhookRouteFixture({ ...shared, WHATSAPP_SETTLEMENT_PHONE_NUMBER_ID: "" });
  assert.equal((await emptyPhone.route.POST(emptyPhone.request(phoneId, shared.WHATSAPP_APP_SECRET))).status, 200);
  assert.equal(emptyPhone.reconciled.length, 0);
});
