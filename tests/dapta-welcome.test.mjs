import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { normalizeColombianMobile, sendDaptaWelcome } = await jiti.import("../lib/dapta-welcome.ts");
const credit = { creditId: 42, phone: "312 408 5562", name: "Ana Pérez" };
const webhookUrl = "https://api.dapta.ai/api/example?x-api-key=test-only";

test("welcome stays inactive until explicitly enabled", async () => {
  let calls = 0;
  assert.equal(await sendDaptaWelcome(credit, {
    enabled: false, webhookUrl,
    fetcher: async () => { calls += 1; return Response.json({ ok: true }); },
  }), "disabled");
  assert.equal(calls, 0);
});

test("webhook accepts credit identity and normalized Colombian mobile once", async () => {
  const calls = [];
  const result = await sendDaptaWelcome(credit, {
    enabled: true, webhookUrl,
    fetcher: async (url, request) => {
      calls.push({ url: String(url), request });
      return Response.json({ ok: true });
    },
  });
  assert.equal(result, "accepted");
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].request.body), {
    credito_id: "42", telefono: "573124085562", nombre: "Ana Pérez",
  });
  assert.equal(normalizeColombianMobile("+57 312 408 5562"), "573124085562");
});

test("rejects invalid contacts and non-Dapta webhook destinations", async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return Response.json({ ok: true }); };
  assert.equal(await sendDaptaWelcome({ ...credit, phone: "123" }, { enabled: true, webhookUrl, fetcher }), "invalid_contact");
  assert.equal(await sendDaptaWelcome(credit, { enabled: true, webhookUrl: "https://example.com/hook", fetcher }), "failed");
  assert.equal(calls, 0);
});

test("HTTP 200 with a failed WhatsApp node is a failed welcome", async () => {
  const flow = {
    inicio_http: { credito_id: "42" },
    normalizar_contacto: { valido: true },
    enviar_bienvenida: { error: JSON.stringify({ detail: "Invalid phone type" }) },
  };
  for (const payload of [flow, { response: flow }]) {
    let calls = 0;
    const result = await sendDaptaWelcome(credit, {
      enabled: true, webhookUrl,
      fetcher: async () => { calls += 1; return Response.json(payload); },
    });
    assert.equal(result, "failed");
    assert.equal(calls, 1, "A flow failure must not cause an automatic retry");
  }
});

test("HTTP 200 with an explicit flow or normalization error is a failed welcome", async () => {
  for (const payload of [
    { error: { detail: "Flow unavailable" } },
    { normalizar_contacto: { error: "Invalid contact" } },
  ]) {
    assert.equal(await sendDaptaWelcome(credit, {
      enabled: true, webhookUrl, fetcher: async () => Response.json(payload),
    }), "failed");
  }
});

test("successful and empty error fields report acceptance without claiming delivery", async () => {
  for (const payload of [
    {},
    { ok: true },
    { enviar_bienvenida: { id: "message-test", error: null } },
    { response: { enviar_bienvenida: { error: "" } } },
    { enviar_bienvenida: { error: false } },
    { enviar_bienvenida: { error: {} } },
  ]) {
    assert.equal(await sendDaptaWelcome(credit, {
      enabled: true, webhookUrl, fetcher: async () => Response.json(payload),
    }), "accepted");
  }
  assert.equal(await sendDaptaWelcome(credit, {
    enabled: true, webhookUrl, fetcher: async () => new Response(null, { status: 202 }),
  }), "accepted");
});

test("HTTP and network failures report failure without another request", async () => {
  for (const fetcher of [
    async () => Response.json({ error: "Unavailable" }, { status: 503 }),
    async () => { throw new TypeError("Synthetic connection failure"); },
  ]) {
    let calls = 0;
    assert.equal(await sendDaptaWelcome(credit, {
      enabled: true, webhookUrl,
      fetcher: async (...args) => { calls += 1; return fetcher(...args); },
    }), "failed");
    assert.equal(calls, 1);
  }
});
