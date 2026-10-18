import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";

const credit = (id, overrides = {}) => ({ id, folio: "TEST-" + id, clienteNombre: "Cliente sintético",
  clienteDocumento: "001234567", estado: "INSCRITO", abonos: [], montoCredito: 100, valorCuota: 100,
  plazoMeses: 1, frecuenciaPago: "QUINCENAL", fechaPrimerPago: "2026-10-17", fechaProximoPago: "2026-10-17", ...overrides });

function harness({ protectedIds = [1], lateProtection = false, tokenCount = 1, state = "MORA" } = {}) {
  const rows = [credit(1), credit(2)]; const calls = [];
  let locked = false, logId = 0;
  const db = {
    credito: { findMany: async () => rows },
    $executeRawUnsafe: async sql => { if (/UPDATE "FcmNotificationLog"/.test(sql)) calls.push("log-result"); return 1; },
    $queryRawUnsafe: async (sql, ...values) => {
      if (/FOR UPDATE/.test(sql)) { assert.equal(locked, true); calls.push("credit-lock"); return [rows.find(row => row.id === values[0])]; }
      if (/INSERT INTO "FcmNotificationLog"/.test(sql)) { calls.push("reserve-log"); return [{ id: ++logId }]; }
      throw Error("Unexpected SQL: " + sql);
    },
    $transaction: async callback => {
      assert.equal(locked, false); locked = true;
      try { return await callback(db); } finally { locked = false; }
    },
  };
  const protection = {
    ensureMoraMessageProtection: async () => {},
    getActiveMoraMessageProtectionIds: async () => new Set(protectedIds),
    hasActiveMoraMessageProtection: async id => {
      assert.equal(locked, true); assert.equal(calls.at(-1), "credit-lock"); calls.push("protection");
      return lateProtection || protectedIds.includes(id);
    },
  };
  const fcm = { ensureFcmDeviceTokenTable: async () => {}, isFcmConfigured: () => true,
    listFcmTokensForDocument: async () => Array.from({ length: tokenCount }, (_, index) => ({ id: index + 1, token: "synthetic-token-" + index })),
    markFcmTokenSendResult: async () => {},
    sendFcmNotification: async () => { calls.push(locked ? "http-under-lock" : "http"); return { ok: true, error: null, providerMessageId: "synthetic" }; },
  };
  const dependencies = {
    "@/lib/prisma": { default: db }, "@/lib/credit-abono-audit": { ensureCreditAbonoAuditColumns: async () => {} },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: () => ({ estadoPago: state,
      nextInstallment: { fechaVencimiento: state === "MORA" ? "2026-10-17" : "2026-10-18", saldoPendiente: 100 } }) },
    "@/lib/mora-message-protection": protection, "@/lib/fcm-notifications": fcm,
  };
  const route = loadReissueModule("app/api/creditos/push-manual/route.ts", {
    ...dependencies, "next/server": { NextResponse: Response },
    "@/lib/aliados": { isFinserPayCentralAlly: () => true },
    "@/lib/auth": { getSessionUser: async () => ({ id: 7, rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" }) },
    "@/lib/cartera-access": { resolveCarteraAliadoId: () => null }, "@/lib/roles": { isAdminRole: () => true },
  }, { URLSearchParams });
  const automatic = loadReissueModule("lib/credit-push-reminders.ts", dependencies, { URLSearchParams });
  return { calls, post: async body => (await route.POST(new Request("https://finserpay.test/api/creditos/push-manual", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }))).json(), automatic: options => automatic.dispatchCreditPushReminders({ today: "2026-10-18", ...options }) };
}

test("manual mora preview excludes protected credit without suppressing another credit of the same document", async () => {
  const f = harness(); const response = await f.post({ mode: "bulk", preset: "mora", filter: "MORA", dryRun: true });
  assert.equal(response.summary.excludedActiveMoraProtection, 1); assert.equal(response.summary.targetCredits, 1);
  assert.equal(response.summary.wouldSend, 1); assert.equal(response.summary.noToken, 0);
  assert.equal(response.items[0].action, "SKIPPED_ACTIVE_MORA_PROTECTION"); assert.deepEqual(f.calls, []);
});

test("manual mora dispatch revalidates approval after preview/selection under credit row lock", async () => {
  const f = harness({ protectedIds: [], lateProtection: true, tokenCount: 2 });
  assert.equal((await f.post({ mode: "bulk", preset: "mora", dryRun: true })).summary.wouldSend, 4);
  const response = await f.post({ mode: "bulk", preset: "mora", dryRun: false });
  assert.equal(response.summary.sent, 0); assert.equal(response.summary.excludedActiveMoraProtection, 2);
  assert.equal(response.summary.targetCredits, 0); assert.ok(!f.calls.some(call => call.startsWith("http")));
  assert.deepEqual(f.calls, ["credit-lock", "protection", "credit-lock", "protection"]);
});

test("manual mora preset remains protected even if caller uses TODOS_APP or direct credit mode", async () => {
  for (const input of [{ mode: "bulk", filter: "TODOS_APP" }, { mode: "credit", creditoId: 1 }]) {
    const f = harness({ protectedIds: [1, 2] });
    const response = await f.post({ ...input, preset: "mora", dryRun: false });
    assert.equal(response.summary.sent, 0); assert.equal(response.summary.excludedActiveMoraProtection, 2);
    assert.deepEqual(f.calls, []);
  }
});

test("normal unprotected dispatch starts HTTP under the guard and keeps generic app notices available", async () => {
  const mora = harness({ protectedIds: [] });
  assert.equal((await mora.post({ mode: "bulk", filter: "MORA", preset: "mora" })).summary.sent, 2);
  assert.deepEqual(mora.calls, ["credit-lock", "protection", "http-under-lock", "credit-lock", "protection", "http-under-lock"]);
  const generic = harness({ protectedIds: [1, 2] });
  assert.equal((await generic.post({ mode: "bulk", filter: "TODOS_APP", preset: "internet" })).summary.sent, 2);
  assert.deepEqual(generic.calls, ["http", "http"]);
});

test("automatic mora preview skips protected credit without reserving a notification or sending HTTP", async () => {
  const f = harness(); const report = await f.automatic({ dryRun: true });
  assert.equal(report.summary.skipped, 1); assert.equal(report.summary.wouldSend, 1);
  assert.match(report.items[0].message, /Prórroga/); assert.deepEqual(f.calls, []);
});

test("automatic mora rechecks under lock and records skipped reservations when approval arrives during dispatch", async () => {
  const f = harness({ protectedIds: [], lateProtection: true }); const report = await f.automatic({ dryRun: false });
  assert.equal(report.summary.skipped, 2); assert.equal(report.summary.sent, 0);
  assert.deepEqual(f.calls, ["reserve-log", "credit-lock", "protection", "log-result", "reserve-log", "credit-lock", "protection", "log-result"]);
});

test("automatic unprotected mora starts HTTP while holding the credit guard and settles its existing reservation", async () => {
  const f = harness({ protectedIds: [] }); const report = await f.automatic({ dryRun: false });
  assert.equal(report.summary.sent, 2); assert.equal(report.summary.skipped, 0);
  assert.deepEqual(f.calls, ["reserve-log", "credit-lock", "protection", "http-under-lock", "log-result",
    "reserve-log", "credit-lock", "protection", "http-under-lock", "log-result"]);
});

test("automatic due-date notices keep their current eligibility and do not apply the mora-only exclusion", async () => {
  const f = harness({ protectedIds: [1, 2], state: "AL_DIA" }); const report = await f.automatic({ dryRun: true });
  assert.equal(report.summary.wouldSend, 2); assert.equal(report.summary.skipped, 0);
  assert.equal(report.items[0].category, "VENCE_HOY"); assert.deepEqual(f.calls, []);
});

test("FCM authentication and dispatch share one bounded signal, without any real provider requests", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const requests = [], timeouts = [];
  const api = loadReissueModule("lib/fcm-notifications.ts", { "@/lib/prisma": { default: {} } }, {
    URLSearchParams, process: { env: { FCM_PROJECT_ID: "synthetic-project", FCM_CLIENT_EMAIL: "synthetic@example.test", FCM_PRIVATE_KEY: privateKey } },
    AbortSignal: { timeout: milliseconds => { timeouts.push(milliseconds); return new AbortController().signal; } },
    fetch: async (url, options) => { requests.push({ url, signal: options.signal });
      return Response.json(requests.length === 1 ? { access_token: "synthetic-access", expires_in: 3600 } : { name: "synthetic-message" }); },
  });
  const result = await api.sendFcmNotification("synthetic-token", { title: "TEST", body: "TEST" });
  assert.equal(result.ok, true); assert.equal(requests.length, 2);
  assert.deepEqual(timeouts, [8000]); assert.equal(requests[0].signal, requests[1].signal);
});
