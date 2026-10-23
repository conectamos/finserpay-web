import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { dispatchSettlementDeliveries } = await jiti.import("../lib/ally-settlement-delivery-dispatch.ts");
const { DeliveryProviderError, sendSettlementDelivery } = await jiti.import("../lib/ally-settlement-delivery-provider.ts");
const { buildSettlementDeliveryPayload } = await jiti.import("../lib/ally-settlement-delivery-types.ts");
const id = suffix => `11111111-1111-4111-8111-${String(suffix).padStart(12, "0")}`;
const attempt = (channel, settlementId = 10, suffix = channel === "EMAIL" ? 1 : 2) => ({
  id: id(suffix), claimToken: id(suffix + 100), settlementId, allyId: settlementId + 1000, channel, sequence: 1,
  recipient: channel === "EMAIL" ? `aliado${settlementId}@example.invalid` : "573001234567", status: "PROCESSING",
  payload: buildSettlementDeliveryPayload({ allyName: `Aliado ${settlementId}`, periodStart: "2026-10-01", periodEnd: "2026-10-15", netAmount: settlementId * 1000 }),
  error: null, createdAt: new Date("2026-10-21T14:00:00Z"), attemptedAt: new Date("2026-10-21T14:01:00Z"),
  sentAt: null, sendStartedAt: null, providerId: null,
});

function fixture(attempts, overrides = {}) {
  const queue = [...attempts]; const events = []; const outcomes = []; const requests = [];
  const pdfs = new Map(attempts.map(row => [row.settlementId, Buffer.from(`%PDF-1.7\nLIQUIDACION ${row.settlementId} EXCLUSIVA\n%%EOF`)]));
  const store = {
    async recover() { events.push(["recover"]); },
    async claim(settlementId) {
      events.push(["claim", settlementId]);
      const index = queue.findIndex(item => settlementId === undefined || settlementId === item.settlementId);
      return index >= 0 ? queue.splice(index, 1)[0] : null;
    },
    async beforeSend(attemptId, claimToken) { events.push(["boundary", attemptId, claimToken]); },
    async accepted(attemptId, providerId, claimToken) {
      events.push(["accepted", attemptId, claimToken]); outcomes.push({ attemptId, status: "SENT", providerId });
    },
    async failed(attemptId, error, uncertain, claimToken) {
      events.push(["failed", attemptId, claimToken]); outcomes.push({ attemptId, status: uncertain ? "UNCERTAIN" : "FAILED", error, uncertain });
    },
    ...overrides.store,
  };
  const document = async settlementId => {
    events.push(["document", settlementId]);
    assert.ok(pdfs.has(settlementId), "document must belong to claimed settlement");
    return { pdf: pdfs.get(settlementId), filename: `liquidacion-${settlementId}.pdf` };
  };
  const send = async (data, options) => {
    requests.push(data); events.push(["provider-preflight", data.attemptId]);
    await options.beforeSend(); events.push(["provider-post", data.attemptId]);
    return { providerId: `provider-${data.attemptId}` };
  };
  return { queue, store, events, outcomes, requests, pdfs, document, send, ...overrides.dependencies };
}

test("email rejection preserves the settlement and WhatsApp is still processed independently", async () => {
  const email = attempt("EMAIL"); const whatsapp = attempt("WHATSAPP");
  const f = fixture([email, whatsapp]);
  const send = async (data, options) => {
    if (data.channel === "EMAIL") throw new DeliveryProviderError("Resend: HTTP 401.");
    return f.send(data, options);
  };
  assert.deepEqual(await dispatchSettlementDeliveries({ store: f.store, document: f.document, send, settlementId: 10 }), { processed: 2 });
  assert.deepEqual(f.outcomes.map(row => [row.attemptId, row.status]), [[email.id, "FAILED"], [whatsapp.id, "SENT"]]);
  assert.equal(f.outcomes[0].uncertain, false); assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].recipient, whatsapp.recipient); assert.equal(f.requests[0].channel, "WHATSAPP");
  assert.equal(f.pdfs.size, 1, "delivery failure does not delete or modify saved settlement PDF");
});

test("each channel receives only its settlement's saved PDF and original snapshot payload", async () => {
  const rows = [attempt("EMAIL", 10, 1), attempt("WHATSAPP", 10, 2), attempt("EMAIL", 20, 3), attempt("WHATSAPP", 20, 4)];
  const f = fixture(rows);
  assert.equal((await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send })).processed, 4);
  for (const row of rows) {
    const request = f.requests.find(item => item.attemptId === row.id);
    assert.deepEqual(request.pdf, f.pdfs.get(row.settlementId));
    assert.equal(request.filename, `liquidacion-${row.settlementId}.pdf`);
    assert.equal(request.recipient, row.recipient); assert.equal(request.allyName, row.payload.allyName);
    assert.equal(request.allyId, row.allyId);
    assert.equal(request.subject, row.payload.subject); assert.equal(request.netAmount, row.payload.netAmount);
  }
  assert.deepEqual(f.requests[0].pdf, f.requests[1].pdf);
  assert.notDeepEqual(f.requests[0].pdf, f.requests[2].pdf);
});

test("dispatch usa la identidad reclamada aunque el payload indique otro aliado", async () => {
  const row = attempt("EMAIL");
  row.allyId = 65588;
  row.payload = { ...row.payload, allyId: 14877 };
  const f = fixture([row]);
  await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].allyId, 65588);
  assert.equal(f.requests[0].allyName, row.payload.allyName);
  assert.deepEqual(f.requests[0].pdf, f.pdfs.get(row.settlementId));
});

test("the durable send boundary follows document and preflight, precedes the POST, and carries its lease token", async () => {
  const row = attempt("EMAIL"); const f = fixture([row]);
  await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send, settlementId: row.settlementId });
  assert.deepEqual(f.events.map(event => event[0]), ["recover", "claim", "document", "provider-preflight", "boundary", "provider-post", "accepted", "claim"]);
  assert.deepEqual(f.events.find(event => event[0] === "boundary"), ["boundary", row.id, row.claimToken]);
  assert.deepEqual(f.events.find(event => event[0] === "accepted"), ["accepted", row.id, row.claimToken]);
});

test("database failure after provider acceptance records uncertain and still processes the other channel", async () => {
  const email = attempt("EMAIL"); const whatsapp = attempt("WHATSAPP");
  const f = fixture([email, whatsapp]);
  const accepted = f.store.accepted;
  f.store.accepted = async (attemptId, ...rest) => {
    if (attemptId === email.id) throw new Error("PRIVATE_DATABASE_CONNECTION_STRING");
    await accepted(attemptId, ...rest);
  };
  assert.equal((await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send })).processed, 2);
  assert.deepEqual(f.outcomes.map(row => row.status), ["UNCERTAIN", "SENT"]);
  assert.equal(f.outcomes[0].uncertain, true);
  assert.match(f.outcomes[0].error, /Concilia/); assert.ok(!f.outcomes[0].error.includes("PRIVATE_DATABASE"));
  assert.deepEqual(f.events.find(event => event[0] === "failed"), ["failed", email.id, email.claimToken]);
});

test("generic document failure is safe to retry, sanitizes diagnostics, and never crosses the send boundary", async () => {
  const email = attempt("EMAIL"); const whatsapp = attempt("WHATSAPP"); const f = fixture([email, whatsapp]);
  let count = 0;
  const document = async settlementId => {
    if (count++ === 0) throw new Error("PRIVATE_CUSTOMER_ID_OR_DATABASE_SECRET");
    return f.document(settlementId);
  };
  await dispatchSettlementDeliveries({ store: f.store, document, send: f.send });
  assert.deepEqual(f.outcomes.map(row => row.status), ["FAILED", "SENT"]);
  assert.equal(f.outcomes[0].uncertain, false); assert.match(f.outcomes[0].error, /liquidación está guardada/);
  assert.ok(!f.outcomes[0].error.includes("PRIVATE_CUSTOMER"));
  assert.ok(!f.events.some(event => event[0] === "boundary" && event[1] === email.id));
});

test("generic failures before and after the boundary are classified separately; explicit provider uncertainty is preserved", async () => {
  for (const mode of ["before", "after", "provider"]) {
    const row = attempt("EMAIL"); const f = fixture([row]);
    const send = async (_data, options) => {
      if (mode !== "before") await options.beforeSend();
      if (mode === "provider") throw new DeliveryProviderError("No se pudo confirmar la respuesta del proveedor.", true);
      throw new Error("PROVIDER_RAW_SECRET");
    };
    await dispatchSettlementDeliveries({ store: f.store, document: f.document, send });
    assert.equal(f.outcomes.length, 1); assert.equal(f.outcomes[0].uncertain, mode !== "before");
    assert.equal(f.outcomes[0].status, mode === "before" ? "FAILED" : "UNCERTAIN");
    assert.ok(!f.outcomes[0].error.includes("PROVIDER_RAW_SECRET"));
  }
});

test("missing recipient does not prepare or send a document; available channel proceeds", async () => {
  const email = { ...attempt("EMAIL"), recipient: null }; const f = fixture([email, attempt("WHATSAPP")]);
  await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send });
  assert.deepEqual(f.outcomes.map(row => row.status), ["FAILED", "SENT"]);
  assert.equal(f.events.filter(event => event[0] === "document").length, 1);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].channel, "WHATSAPP");
});

test("empty queue performs no document/provider operations and scoped runs obey the requested settlement and limit", async () => {
  const empty = fixture([]);
  assert.equal((await dispatchSettlementDeliveries({ store: empty.store, document: empty.document, send: empty.send })).processed, 0);
  assert.deepEqual(empty.events, [["recover"], ["claim", undefined]]); assert.equal(empty.requests.length, 0);
  const f = fixture([attempt("EMAIL", 20, 3), attempt("EMAIL", 10, 1), attempt("WHATSAPP", 10, 2)]);
  assert.equal((await dispatchSettlementDeliveries({ store: f.store, document: f.document, send: f.send, settlementId: 10, limit: 1 })).processed, 1);
  assert.equal(f.requests[0].allyName, "Aliado 10"); assert.equal(f.queue.length, 2);
  assert.ok(f.queue.some(item => item.settlementId === 20));
});

test("real provider adapter with a fake invalid receipt never becomes a successful dispatch", async () => {
  const row = attempt("EMAIL"); const f = fixture([row]); let requests = 0;
  const domainId = id(500);
  const send = (data, options) => sendSettlementDelivery(data, {
    ...options,
    env: { ALLY_SETTLEMENT_DELIVERY_ENABLED: "true", RESEND_API_KEY: "fake-fixture-key", RESEND_SETTLEMENT_DOMAIN_ID: domainId },
    fetch: async url => {
      requests++;
      if (url.includes("/domains/")) return Response.json({ id: domainId, name: "finserpay.com", status: "verified", capabilities: { sending: "enabled" } });
      assert.equal(url, "https://api.resend.com/emails"); return Response.json({ ok: true });
    },
  });
  await dispatchSettlementDeliveries({ store: f.store, document: f.document, send });
  assert.equal(requests, 2); assert.equal(f.outcomes.length, 1); assert.equal(f.outcomes[0].status, "UNCERTAIN");
  assert.equal(f.outcomes[0].uncertain, true); assert.ok(!f.events.some(event => event[0] === "accepted"));
});
