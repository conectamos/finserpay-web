import test from "node:test";
import assert from "node:assert/strict";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { createCuotaVencidaWhatsAppHandlers } = loadReissueModule("lib/cuotavencida-whatsapp-http.ts");
const requestId = "ab21ad79-c604-44f8-bdbe-d0853b02ae47";
const batch = { id: requestId, status: "QUEUED", total: 3, pending: 3, accepted: 0, failed: 0, unknown: 0, skipped: 0 };
function fixture({ session = { id: 7, centralAdmin: true }, configured = true, created = true, fail = false } = {}) {
  const calls = [];
  const handlers = createCuotaVencidaWhatsAppHandlers({
    session: async () => session,
    sameOrigin: request => request.headers.get("origin") === "https://finserpay.com",
    configured: () => configured,
    latest: async () => { calls.push("read"); return batch; },
    create: async input => { calls.push(input); if (fail) throw new Error("secret webhook customer phone"); return { created, batch }; },
    start: () => calls.push("start"),
  });
  return { handlers, calls };
}
function request(body = { requestId }, headers = {}) {
  return new Request("https://finserpay.com/api/dashboard/cartera/cuotavencida", {
    method: "POST", headers: { origin: "https://finserpay.com", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("GET only reads aggregate status and never creates or starts a send", async () => {
  const f = fixture();
  const response = await f.handlers.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, configured: true, batch });
  assert.deepEqual(f.calls, ["read"]);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
});
test("POST creates the global batch under the authenticated actor and starts its worker after persistence", async () => {
  const f = fixture();
  const response = await f.handlers.POST(request());
  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [{ requestId, actorId: 7 }, "start"]);
  assert.deepEqual(await response.json(), { ok: true, configured: true, batch });
});
test("replaying an existing batch returns 200 without inventing a second batch", async () => {
  const f = fixture({ created: false });
  assert.equal((await f.handlers.POST(request())).status, 200);
  assert.equal(f.calls.length, 2);
});
test("anonymous and ally/seller sessions cannot read or create global batches", async () => {
  for (const [session, status] of [[null, 401], [{ id: 7, centralAdmin: false }, 403]]) {
    const f = fixture({ session });
    assert.equal((await f.handlers.GET()).status, status);
    assert.equal((await f.handlers.POST(request())).status, status);
    assert.deepEqual(f.calls, []);
  }
});
test("cross origin posts and malformed or oversized payloads cannot enqueue", async () => {
  const f = fixture();
  assert.equal((await f.handlers.POST(request({ requestId }, { origin: "https://other.invalid" }))).status, 403);
  for (const body of [null, [], {}, { requestId: "bad" }, { requestId, phones: ["3000000000"] }, { requestId, today: "2099-01-01" }, { requestId: "x".repeat(2000) }]) {
    assert.equal((await f.handlers.POST(request(body))).status, 400);
  }
  assert.equal((await f.handlers.POST(request({ requestId }, { "Content-Type": "text/plain" }))).status, 400);
  assert.deepEqual(f.calls, []);
});
test("missing configuration and storage errors never trigger a provider operation or expose secrets", async () => {
  const disabled = fixture({ configured: false });
  assert.equal((await disabled.handlers.POST(request())).status, 503);
  assert.deepEqual(disabled.calls, []);
  const failed = fixture({ fail: true });
  const response = await failed.handlers.POST(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret|webhook|phone/);
  assert.equal(failed.calls.length, 1);
});
