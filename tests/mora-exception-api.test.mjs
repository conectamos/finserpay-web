import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

function loadRoute({ action, syncImpl, events, errors = [] }) {
  const path = new URL("../app/api/aprobaciones/excepciones-mora/[id]/route.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const dependencies = {
    "next/server": {
      NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) },
    },
    "@/lib/analyst-mora-access": { getMoraActor: async () => ({ id: 1, nombre: "Central", centralAdmin: true }) },
    "@/lib/mora-exception-requests": {
      parseMoraExceptionDecision: () => ({
        action,
        version: 1,
        reason: "Decisión justificada",
        bypassCooldown: false,
        bypassReason: null,
        idempotencyKey: "50000000-0000-4000-8000-000000000001",
      }),
      getMoraExceptionRequest: async () => ({}),
      actOnMoraExceptionRequest: async () => {
        events.push("commit");
        return { item: { id: "request", creditoId: 77, status: action === "APPROVE" ? "APPROVED" : "PENDING" }, unchanged: false };
      },
    },
    "@/lib/credit-approval-http": {
      approvalErrorResponse: (error) => ({ status: 500, body: { error: error.message } }),
      approvalPrivateHeaders: { "Cache-Control": "private, no-store" },
      readApprovalRequest: async () => ({}),
    },
    "@/lib/credit-mora-sync": {
      syncCreditMoraById: syncImpl,
    },
  };
  runInNewContext(outputText, {
    exports: loaded.exports,
    module: loaded,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    console: { error: (...args) => errors.push(args) },
    Error,
  }, { filename: "app/api/aprobaciones/excepciones-mora/[id]/route.ts" });
  return loaded.exports;
}

const context = { params: Promise.resolve({ id: "50000000-0000-4000-8000-000000000010" }) };

test("APPROVE sincroniza solo el crédito después del commit y devuelve trazabilidad segura", async () => {
  const events = [];
  const calls = [];
  const route = loadRoute({
    action: "APPROVE",
    events,
    syncImpl: async (creditoId, options) => {
      events.push("sync");
      calls.push({ creditoId, options });
      return { action: "UNLOCKED", message: "Desbloqueo aplicado" };
    },
  });
  const response = await route.PATCH({}, context);
  assert.deepEqual(events, ["commit", "sync"]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ creditoId: 77, options: { forceRemoteAudit: true } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body.moraSync)), { ok: true, action: "UNLOCKED", message: "Desbloqueo aplicado" });
});

test("fallo post-commit conserva aprobación, no filtra el error y permite reintento idempotente", async () => {
  const events = [];
  const errors = [];
  const route = loadRoute({
    action: "APPROVE",
    events,
    errors,
    syncImpl: async () => {
      events.push("sync");
      throw new Error("PASSWORD=secreto remoto");
    },
  });
  const response = await route.PATCH({}, context);
  assert.equal(response.status, 200);
  assert.equal(response.body.item.status, "APPROVED");
  assert.equal(response.body.moraSync.ok, false);
  assert.match(response.body.moraSync.message, /volverá a intentarlo/);
  assert.doesNotMatch(JSON.stringify(response), /secreto remoto|PASSWORD/);
  assert.doesNotMatch(JSON.stringify(errors), /secreto remoto|PASSWORD/);
});

test("OBSERVE no ejecuta sincronización operativa", async () => {
  const events = [];
  let syncCalls = 0;
  const route = loadRoute({
    action: "OBSERVE",
    events,
    syncImpl: async () => { syncCalls += 1; },
  });
  const response = await route.PATCH({}, context);
  assert.equal(response.status, 200);
  assert.deepEqual(events, ["commit"]);
  assert.equal(syncCalls, 0);
  assert.equal("moraSync" in response.body, false);
});