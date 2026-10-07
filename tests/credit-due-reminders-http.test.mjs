import assert from "node:assert/strict";
import test from "node:test";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const { createCreditDueReminderHandlers } = loadReissueModule("lib/credit-due-reminders-http.ts");
const roles = loadReissueModule("lib/roles.ts");
const allies = loadReissueModule("lib/aliados.ts");
function fixture(admin = false) {
  const calls = [];
  const handlers = createCreditDueReminderHandlers({
    getAdmin: async () => admin,
    cronTokens: () => ["mora-test-token", "cron-test-token"],
    previewToken: () => "diana-preview-token",
    run: async options => { calls.push(options); return { ok: true, dryRun: options.dryRun, summary: { accepted: 0 } }; },
  });
  const request = (method, token = "", body = {}, query = "") => new Request("http://localhost/api/integraciones/dapta/recordatorios-cuota" + query, {
    method, headers: { authorization: token ? `Bearer ${token}` : "", "Content-Type": "application/json" },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  return { handlers, calls, request };
}

test("unauthenticated requests never query or send; query-string tokens are refused", async () => {
  const f = fixture();
  for (const method of ["GET", "POST"]) {
    assert.equal((await f.handlers[method](f.request(method))).status, 401);
    assert.equal((await f.handlers[method](f.request(method, "wrong"))).status, 401);
    assert.equal((await f.handlers[method](f.request(method, "", {}, "?token=cron-test-token"))).status, 401);
  }
  assert.equal(f.calls.length, 0);
});

test("Diana token permits only GET preview, including when POST requests dryRun", async () => {
  const f = fixture();
  const response = await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?today=2026-10-07&dryRun=false"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(f.calls[0].dryRun, true);
  assert.equal(f.calls[0].previewDate, "2026-10-07");
  for (const body of [{}, { dryRun: true }, { dryRun: false }]) assert.equal((await f.handlers.POST(f.request("POST", "diana-preview-token", body))).status, 401);
  assert.equal(f.calls.length, 1);
});

test("invalid preview calendar dates do not reach the runner", async () => {
  const f = fixture();
  for (const date of ["2026-02-31", "2026-13-01", "2026-00-00", "not-a-date"]) {
    assert.equal((await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?today=" + date))).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test("POST requires explicit boolean false to dispatch and discards historical dates/limits", async () => {
  for (const token of ["mora-test-token", "cron-test-token"]) {
    const f = fixture();
    assert.equal((await f.handlers.POST(f.request("POST", token, {}, "?dryRun=false"))).status, 200);
    assert.equal(f.calls[0].dryRun, true);
    await f.handlers.POST(f.request("POST", token, { dryRun: false, today: "1900-01-01", limit: 1 }, "?today=2099-01-01"));
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), { campaign: "before_due", dryRun: false });
    for (const body of [{ dryRun: "false" }, [], "{"]) assert.equal((await f.handlers.POST(f.request("POST", token, body))).status, 400);
  }
});

test("an authenticated administrator can preview and dispatch without a bearer credential", async () => {
  const f = fixture(true);
  assert.equal((await f.handlers.GET(f.request("GET"))).status, 200);
  assert.equal((await f.handlers.POST(f.request("POST", "", { dryRun: false }))).status, 200);
  assert.equal(f.calls[0].dryRun, true);
  assert.equal(f.calls[1].dryRun, false);
});

test("processing errors are generic and never expose database or webhook secrets", async () => {
  const handlers = createCreditDueReminderHandlers({ getAdmin: async () => true,
    cronTokens: () => [], previewToken: () => undefined,
    run: async () => { throw new Error("private phone, token and webhook"); } });
  const f = fixture();
  for (const method of ["GET", "POST"]) {
    const response = await handlers[method](f.request(method));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private|phone|token|webhook/);
  }
});

test("the route requires an active central FINSERPAY administrator for global session access", async () => {
  const active = { activo: true, sedeAccesoActiva: true, aliadoAccesoActivo: true,
    rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" };
  for (const [user, status] of [
    [active, 200],
    [{ ...active, aliadoAccesoCodigo: "CONECTAMOS" }, 401],
    [{ ...active, rolNombre: "VENDEDOR" }, 401],
    [{ ...active, activo: false }, 401],
    [{ ...active, sedeAccesoActiva: false }, 401],
    [{ ...active, aliadoAccesoActivo: false }, 401],
    [null, 401],
  ]) {
    const calls = [];
    const route = loadReissueModule("app/api/integraciones/dapta/recordatorios-cuota/route.ts", {
      "@/lib/auth": { getSessionUser: async () => user },
      "@/lib/roles": roles,
      "@/lib/aliados": allies,
      "@/lib/credit-due-reminders": { runCreditDueReminders: async options => { calls.push(options); return { ok: true }; } },
      "@/lib/credit-due-reminders-http": { createCreditDueReminderHandlers },
    });
    const f = fixture();
    assert.equal((await route.GET(f.request("GET"))).status, status);
    assert.equal((await route.POST(f.request("POST", "", { dryRun: false }))).status, status);
    assert.equal(calls.length, status === 200 ? 2 : 0);
  }
});

test("campaign selection is whitelisted and defaults to before-due for GET and POST", async () => {
  const f = fixture();
  await f.handlers.GET(f.request("GET", "diana-preview-token"));
  assert.equal(f.calls[0].campaign, "before_due");
  await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?campaign=due_today"));
  assert.equal(f.calls[1].campaign, "due_today");
  assert.equal(f.calls[1].dryRun, true);
  await f.handlers.POST(f.request("POST", "cron-test-token", { campaign: "due_today", dryRun: false }));
  assert.equal(f.calls[2].campaign, "due_today");
  assert.equal(f.calls[2].dryRun, false);
  await f.handlers.POST(f.request("POST", "cron-test-token", {}, "?campaign=due_today&dryRun=false"));
  assert.equal(f.calls[3].campaign, "before_due");
  assert.equal(f.calls[3].dryRun, true);
  for (const campaign of ["", "invalid", "DUE_TODAY", null, 1, [], {}]) {
    assert.equal((await f.handlers.POST(f.request("POST", "cron-test-token", { campaign, dryRun: false }))).status, 400);
  }
  for (const campaign of ["", "invalid", "DUE_TODAY"]) {
    assert.equal((await f.handlers.GET(f.request("GET", "diana-preview-token", {}, "?campaign=" + campaign))).status, 400);
  }
  assert.equal(f.calls.length, 4);
});

test("Diana's preview credential cannot start due-today messages", async () => {
  const f = fixture();
  assert.equal((await f.handlers.POST(f.request("POST", "diana-preview-token", { campaign: "due_today", dryRun: false }))).status, 401);
  assert.equal(f.calls.length, 0);
});
