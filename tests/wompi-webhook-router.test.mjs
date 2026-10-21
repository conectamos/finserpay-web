import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const storeReference = "wp_12345678-abcd-4321-abcd-123456789abc";
const storeEndpoint = "https://store.example.test/api/payments/wompi/events";
const routerEndpoint = "https://finser.example.test/api/wompi/webhook-router";
const eventSecret = "test_events_router-fixture-only";
const legacyEndpoint = "https://legacy.example.test/webhook";

function loadModule(path, dependencies, globals) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  runInNewContext(output, {
    module: loaded, exports: loaded.exports, URL, Request, Response, AbortSignal,
    ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), "Unexpected dependency: " + name);
      return dependencies[name];
    },
  }, { filename: path });
  return loaded.exports;
}

function fixture({ env = {}, resultStatus = 200, fetchError = false } = {}) {
  const calls = [], logs = [], timeouts = [];
  const globals = {
    process: { env: { WOMPI_EVENTS_SECRET: eventSecret, ...env } },
    console: { error: (...args) => logs.push(args) },
    AbortSignal: { timeout: milliseconds => { timeouts.push(milliseconds); return AbortSignal.timeout(milliseconds); } },
  };
  const wompi = loadModule("lib/wompi.ts", { "node:crypto": crypto }, globals);
  const route = loadModule("app/api/wompi/webhook-router/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/wompi": wompi,
  }, {
    ...globals,
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (fetchError) throw new Error("Synthetic network failure");
      return new Response(null, { status: resultStatus });
    },
  });
  return { calls, logs, timeouts, post: (bodyText, checksum) => route.POST(new Request(routerEndpoint, {
    method: "POST", body: bodyText,
    headers: { "Content-Type": "application/json", ...(checksum ? { "X-Event-Checksum": checksum } : {}) },
  })) };
}

function event(reference) {
  const payload = {
    event: "transaction.updated", environment: "test", timestamp: 1_800_000_000,
    data: { transaction: { id: "fixture-tx-1", reference, status: "APPROVED", amount_in_cents: 10000, currency: "COP" } },
    signature: { properties: ["transaction.id", "transaction.status", "transaction.amount_in_cents", "transaction.reference"] },
  };
  payload.signature.checksum = createHash("sha256")
    .update("fixture-tx-1APPROVED10000" + reference + payload.timestamp + eventSecret).digest("hex");
  return { payload, checksum: payload.signature.checksum, body: JSON.stringify(payload, null, 2) };
}

test("FP references keep the Finser destination and legacy references retain both existing configurations", async () => {
  for (const scenario of [
    { reference: "FP-TEST-123", env: {}, target: "finserpay", url: "https://finser.example.test/api/wompi/webhook" },
    { reference: "LEGACY-TEST-123", env: { WOMPI_LEGACY_WEBHOOK_URL: legacyEndpoint }, target: "legacy", url: legacyEndpoint },
    { reference: "LEGACY-TEST-123", env: {}, target: "legacy", url: "https://kaiowa.app/APIS/API_PASARELA_ABONOS_CREDITO/services/transactions/registrar_response_wompi" },
  ]) {
    const f = fixture({ env: scenario.env }), input = event(scenario.reference);
    const response = await f.post(input.body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, target: scenario.target });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, scenario.url);
    assert.equal(f.calls[0].options.body, input.body);
    assert.equal(f.calls[0].options.headers["X-Event-Checksum"], input.checksum);
    assert.equal(f.calls[0].options.redirect, undefined, "Existing forwarding behavior stays unchanged.");
    assert.deepEqual(f.timeouts, [], "Existing destinations keep their timeout behavior.");
  }
});

test("store UUID references go only to CONECTAMOS with the original signed payload and checksum", async () => {
  const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint, WOMPI_LEGACY_WEBHOOK_URL: legacyEndpoint } });
  const input = event(storeReference), response = await f.post(input.body, input.checksum);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, target: "conectamos" });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, storeEndpoint);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.body, input.body);
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.equal(call.options.headers["X-Event-Checksum"], input.checksum);
  assert.equal(call.options.redirect, "manual");
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.deepEqual(f.timeouts, [15000], "Allow margin beyond the store's 10-second private provider lookup.");
});

test("missing or malformed store destinations fail for retry without reaching any collector", async () => {
  for (const value of [undefined, "", "not-a-url", "http://store.example.test/api/payments/wompi/events", "https://user:password@store.example.test/api/payments/wompi/events", `${storeEndpoint}?token=test`, `${storeEndpoint}#fragment`, "https://store.example.test/api/wompi/webhook"] ) {
    const f = fixture({ env: { ...(value === undefined ? {} : { WOMPI_CONECTAMOS_WEBHOOK_URL: value }), WOMPI_LEGACY_WEBHOOK_URL: legacyEndpoint } });
    const response = await f.post(event(storeReference).body);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, target: "conectamos" });
    assert.equal(f.calls.length, 0);
  }
});

test("similar legacy references are not captured by the store UUID branch", async () => {
  for (const reference of ["wp_invoice_123", "wp_1234", `${storeReference}-extra`, `prefix-${storeReference}`]) {
    const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint, WOMPI_LEGACY_WEBHOOK_URL: legacyEndpoint } });
    assert.equal((await f.post(event(reference).body)).status, 200);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, legacyEndpoint);
  }
});

test("invalid signatures are rejected before any destination is contacted", async () => {
  for (const reference of [storeReference, "FP-TEST-123", "LEGACY-TEST-123"]) {
    const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint } });
    const input = event(reference);
    input.payload.data.transaction.amount_in_cents++;
    const response = await f.post(JSON.stringify(input.payload));
    assert.equal(response.status, 401);
    assert.equal(f.calls.length, 0);
  }
});

test("a failed or redirecting store receiver keeps the event retryable and is never sent to legacy", async () => {
  for (const resultStatus of [301, 302, 400, 401, 404, 409, 429, 500, 503]) {
    const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint }, resultStatus });
    const response = await f.post(event(storeReference).body);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, target: "conectamos" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, storeEndpoint);
  }
  const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint }, fetchError: true });
  assert.equal((await f.post(event(storeReference).body)).status, 500);
  assert.equal(f.calls.length, 1);
});

test("provider retries forward the unchanged event again so the recipient can finish idempotently", async () => {
  const f = fixture({ env: { WOMPI_CONECTAMOS_WEBHOOK_URL: storeEndpoint } }), input = event(storeReference);
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await f.post(input.body)).status, 200);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.url === storeEndpoint && call.options.body === input.body));
});
