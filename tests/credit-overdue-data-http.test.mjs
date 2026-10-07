import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { createCreditOverdueDataHandlers } = loadReissueModule("lib/credit-overdue-data-http.ts");
const roles = loadReissueModule("lib/roles.ts");
const allies = loadReissueModule("lib/aliados.ts");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture({ admin = false, reportOk = true, runError = false } = {}) {
  const calls = [];
  const handlers = createCreditOverdueDataHandlers({
    getAdmin: async () => admin,
    cronTokens: () => ["mora-test-token", "cron-test-token"],
    previewToken: () => "diana-preview-token",
    run: async options => {
      calls.push(plain(options));
      if (runError) throw new Error("private phone token webhook database");
      return { ok: reportOk, dryRun: options.dryRun, summary: { accepted: 0 } };
    },
  });
  const request = (method, token = "", body = {}, query = "", extraHeaders = {}) => new Request("http://localhost/api/integraciones/dapta/datos" + query, {
    method,
    headers: { authorization: token ? `Bearer ${token}` : "", "Content-Type": "application/json", ...extraHeaders },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return { handlers, calls, request };
}

function assertPrivateCache(response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Authorization, Cookie");
}

test("unauthenticated and query-token requests cannot scan or send Datos", async () => {
  const f = fixture();
  for (const method of ["GET", "POST"]) {
    for (const [token, query] of [
      ["", ""], ["wrong", ""], ["", "?token=cron-test-token"],
      ["", "?authorization=Bearer%20cron-test-token"], ["", "?x-mora-sync-token=mora-test-token"],
    ]) {
      const response = await f.handlers[method](f.request(method, token, { dryRun: false }, query));
      assert.equal(response.status, 401);
      assertPrivateCache(response);
    }
  }
  assert.equal(f.calls.length, 0);
});

test("Diana's read credential only permits GET even when POST requests a preview", async () => {
  const f = fixture();
  const response = await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?today=2026-10-07&dryRun=false&limit=1"));
  assert.equal(response.status, 200);
  assertPrivateCache(response);
  assert.deepEqual(f.calls, [{ dryRun: true, previewDate: "2026-10-07" }]);
  for (const body of [{}, { dryRun: true }, { dryRun: false }]) {
    assert.equal((await f.handlers.POST(f.request("POST", "diana-preview-token", body))).status, 401);
    assert.equal((await f.handlers.POST(f.request("POST", "", body, "", { "x-mora-sync-token": "diana-preview-token" }))).status, 401);
  }
  assert.equal(f.calls.length, 1);
});

test("GET accepts real calendar dates and rejects malformed or impossible dates before scanning", async () => {
  const f = fixture();
  for (const date of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-00-00", "not-a-date", "2026-10-07T15:00:00Z", "07/10/2026"]) {
    const response = await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?today=" + encodeURIComponent(date)));
    assert.equal(response.status, 400, date);
    assertPrivateCache(response);
  }
  assert.equal(f.calls.length, 0);
  await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?today=2028-02-29"));
  await f.handlers.GET(f.request("GET", "diana-preview-token"));
  assert.deepEqual(f.calls, [{ dryRun: true, previewDate: "2028-02-29" }, { dryRun: true }]);
});

test("cron credentials require explicit boolean false to dispatch and cannot override date or limit", async () => {
  for (const token of ["mora-test-token", "cron-test-token"]) {
    const f = fixture();
    await f.handlers.POST(f.request("POST", token, {}, "?dryRun=false&today=2099-01-01&limit=1"));
    await f.handlers.POST(f.request("POST", token, { dryRun: true, previewDate: "1900-01-01", limit: 1 }));
    await f.handlers.POST(f.request("POST", token, {
      dryRun: false, today: "1900-01-01", previewDate: "2099-01-01", limit: 1, campaign: "before_due",
    }, "?today=2099-01-01&dryRun=true&limit=0"));
    assert.deepEqual(f.calls, [{ dryRun: true }, { dryRun: true }, { dryRun: false }]);
  }
  const headerAuth = fixture();
  const response = await headerAuth.handlers.POST(headerAuth.request("POST", "", { dryRun: false }, "", { "x-mora-sync-token": "mora-test-token" }));
  assert.equal(response.status, 200);
  assert.deepEqual(headerAuth.calls, [{ dryRun: false }]);
});

test("malformed JSON and nonboolean dryRun values never reach the runner", async () => {
  const f = fixture();
  for (const body of ["{", "", "null", "true", "1", "[]", { dryRun: "false" }, { dryRun: 0 }, { dryRun: null }, { dryRun: [] }]) {
    const response = await f.handlers.POST(f.request("POST", "cron-test-token", body));
    assert.equal(response.status, 400);
    assertPrivateCache(response);
  }
  assert.equal(f.calls.length, 0);
});

test("only an active central FINSERPAY admin session can preview or dispatch globally", async () => {
  const active = { activo: true, sedeAccesoActiva: true, aliadoAccesoActivo: true,
    rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
  for (const [user, status] of [
    [active, 200],
    [{ ...active, aliadoAccesoCodigo: "CONECTAMOS" }, 401],
    [{ ...active, aliadoAccesoCodigo: undefined }, 401],
    [{ ...active, rolNombre: "VENDEDOR" }, 401],
    [{ ...active, rolNombre: "COBRADOR" }, 401],
    [{ ...active, activo: false }, 401],
    [{ ...active, sedeAccesoActiva: false }, 401],
    [{ ...active, aliadoAccesoActivo: false }, 401],
    [null, 401],
  ]) {
    const calls = [];
    const route = loadReissueModule("app/api/integraciones/dapta/datos/route.ts", {
      "@/lib/auth": { getSessionUser: async () => user },
      "@/lib/roles": roles,
      "@/lib/aliados": allies,
      "@/lib/credit-overdue-data-campaign": { runCreditOverdueDataCampaign: async options => { calls.push(plain(options)); return { ok: true }; } },
      "@/lib/credit-overdue-data-http": { createCreditOverdueDataHandlers },
    });
    const f = fixture();
    const get = await route.GET(f.request("GET"));
    const post = await route.POST(f.request("POST", "", { dryRun: false }));
    assert.equal(get.status, status);
    assert.equal(post.status, status);
    assertPrivateCache(get);
    assertPrivateCache(post);
    assert.deepEqual(calls, status === 200 ? [{ dryRun: true }, { dryRun: false }] : []);
  }
});

test("POST reports worker failures as 207 and provider exceptions as sanitized 500", async () => {
  const failed = fixture({ reportOk: false });
  const rejected = await failed.handlers.POST(failed.request("POST", "cron-test-token", { dryRun: false }));
  assert.equal(rejected.status, 207);
  assert.equal((await rejected.json()).ok, false);
  assertPrivateCache(rejected);
  const f = fixture({ admin: true, runError: true });
  for (const method of ["GET", "POST"]) {
    const response = await f.handlers[method](f.request(method, "", { dryRun: false }));
    assert.equal(response.status, 500);
    assertPrivateCache(response);
    assert.doesNotMatch(await response.text(), /private|phone|token|webhook|database/);
  }
});
