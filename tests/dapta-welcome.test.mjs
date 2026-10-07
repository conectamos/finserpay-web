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

test("sends credit identity and normalized Colombian mobile once", async () => {
  const calls = [];
  const result = await sendDaptaWelcome(credit, {
    enabled: true, webhookUrl,
    fetcher: async (url, request) => {
      calls.push({ url: String(url), request });
      return Response.json({ ok: true });
    },
  });
  assert.equal(result, "sent");
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
