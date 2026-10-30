import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const http = await jiti.import("../lib/atencion-http.ts"), core = await jiti.import("../lib/atencion-core.ts");
const parsers = await jiti.import("../lib/atencion-financial-core.ts");
const id = "11111111-1111-4111-8111-111111111111", requestId = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id }) }, origin = "https://finserpay.com";
const actor = { userId: 5, analyst: true };
function route(suffix, patches = {}) {
  const calls = [], result = { extension: { id: requestId, creditId: 77, status: "APPROVED", expiresOn: "2026-10-06" }, version: 2, unchanged: false };
  const financial = {
    get: async (...args) => { calls.push(["get", ...args]); return { credits: [], version: 1, blockedReason: null }; },
    grant: async (...args) => { calls.push(["grant", ...args]); return result; },
    receipt: async (...args) => { calls.push(["receipt", ...args]); return { pdf: {}, paymentId: 1, version: 1, fileName: "recibo-pago-77-1.pdf" }; },
  };
  const dependencies = {
    "@/lib/atencion-core": { ...core, getAttentionAccess: async () => actor },
    "@/lib/atencion-http": http,
    "@/lib/atencion-financial-core": parsers,
    "@/lib/atencion-financial-runtime": { attentionFinancialRuntime: async () => { calls.push(["runtime"]); return { financial,
      sendReceipt: async (...args) => { calls.push(["sendReceipt", ...args]); return { message: { id, deliveryStatus: "accepted" }, uncertain: false }; } }; } },
    "@/lib/client-payment-receipt-pdf": { buildClientPaymentReceiptPdf: async () => Buffer.from("%PDF-test") },
    "@/lib/credit-mora-sync": { syncCreditMoraById: async () => { calls.push(["sync"]); throw new Error("provider internal secret"); } },
    ...patches,
  };
  const source = readFileSync(path.join(root, `app/api/atencion/[id]/${suffix}/route.ts`), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const loaded = { exports: {} };
  runInNewContext(outputText, { module: loaded, exports: loaded.exports, Response, Request, URL, Buffer, Uint8Array,
    require(name) { assert.ok(name in dependencies, `Unexpected ${name}`); return dependencies[name]; } });
  return { api: loaded.exports, calls, result };
}
const post = (suffix, body, headers = {}) => new Request(`${origin}/api/atencion/${id}/${suffix}`, { method: "POST", headers: { origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const extension = { creditId: 77, days: 4, version: 1, requestId, installmentNumber: 1, installmentDueDate: "2026-10-02", reason: "Motivo confirmado", observation: "Compromiso confirmado", promiseAmount: 100, promiseDate: "2026-10-06" };

test("all financial endpoints authenticate before database or rendering", async () => {
  for (const [suffix, method] of [["financial", "GET"], ["extensions", "POST"], ["receipts/latest", "GET"], ["receipts/latest/send", "POST"]]) {
    const f = route(suffix, { "@/lib/atencion-core": { ...core, getAttentionAccess: async () => { throw new core.AttentionError("Inicia sesión", 401); } } });
    const request = method === "POST" ? post(suffix, extension) : new Request(`${origin}/api/atencion/${id}/${suffix}?creditId=77`);
    assert.equal((await f.api[method](request, context)).status, 401); assert.equal(f.calls.length, 0);
  }
});
test("financial writes reject cross-origin and forged authority fields", async () => {
  for (const suffix of ["extensions", "receipts/latest/send"]) {
    const f = route(suffix);
    assert.equal((await f.api.POST(post(suffix, extension, { origin: "https://attacker.example" }), context)).status, 403);
    assert.equal(f.calls.length, 0);
  }
  const f = route("extensions"); assert.equal((await f.api.POST(post("extensions", { ...extension, centralAdmin: true }), context)).status, 400);
  assert.equal(f.calls.length, 0);
});
test("approved extension remains committed if device synchronization fails and replay skips synchronization", async () => {
  const f = route("extensions"); const response = await f.api.POST(post("extensions", extension), context), body = await response.json();
  assert.equal(response.status, 201); assert.equal(body.extension.status, "APPROVED"); assert.equal(body.moraSync.ok, false); assert.ok(!JSON.stringify(body).includes("secret"));
  f.result.unchanged = true; f.result.extension.status = "CANCELLED";
  assert.equal((await f.api.POST(post("extensions", extension), context)).status, 200);
  assert.equal(f.calls.filter(c => c[0] === "sync").length, 1);
});
test("receipt is private PDF and revalidates after render; repeated query parameters are rejected", async () => {
  const f = route("receipts/latest"), url = `${origin}/api/atencion/${id}/receipts/latest?creditId=77`;
  const response = await f.api.GET(new Request(url), context);
  assert.equal(response.status, 200); assert.equal(response.headers.get("Content-Type"), "application/pdf"); assert.match(response.headers.get("Cache-Control"), /no-store/);
  assert.equal(f.calls.filter(c => c[0] === "receipt").length, 2);
  assert.equal((await f.api.GET(new Request(`${url}&creditId=78`), context)).status, 400);
});
test("send receipt parses exact server-controlled identity and safely reports unexpected errors", async () => {
  const f = route("receipts/latest/send");
  const response = await f.api.POST(post("receipts/latest/send", { creditId: 77, paymentId: 1, version: 1, requestId }), context);
  assert.equal(response.status, 200); assert.equal((await response.json()).message.deliveryStatus, "accepted");
  assert.equal(f.calls.find(c => c[0] === "sendReceipt")[2], id);
  const bad = route("financial", { "@/lib/atencion-financial-runtime": { attentionFinancialRuntime: async () => { throw new Error("SQL secret"); } } });
  const failed = await bad.api.GET(new Request(origin), context); assert.equal(failed.status, 500); assert.ok(!(await failed.text()).includes("SQL secret"));
});
