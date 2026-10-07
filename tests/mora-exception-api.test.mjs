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
      parseCentralMoraExceptionDecision: () => ({
        action, version: 1, reason: "Decisión justificada", bypassCooldown: false, bypassReason: null,
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

function loadCreateRoute({ centralAdmin = true, syncImpl, events = [], errors = [] }) {
  const path = new URL("../app/api/aprobaciones/excepciones-mora/route.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const stored = new Map();
  let creations = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } },
    "@/lib/analyst-mora-access": { getMoraActor: async () => ({ id: centralAdmin ? 1 : 2, nombre: centralAdmin ? "Central" : "Analista", centralAdmin }) },
    "@/lib/mora-exception-requests": {
      parseCentralMoraExceptionCreate: body => { events.push("parse-central"); return { ...body, source: "CENTRAL_DIRECT" }; },
      parseMoraExceptionCreate: body => { events.push("parse-analyst"); return body; },
      listMoraExceptionRequests: async () => ({}),
      createMoraExceptionRequest: async input => {
        const prior = stored.get(input.idempotencyKey);
        if (prior) { events.push("replay"); return { item: prior, unchanged: true }; }
        const item = { id: `request-${++creations}`, creditoId: input.creditoId, status: centralAdmin ? "APPROVED" : "PENDING" };
        stored.set(input.idempotencyKey, item);
        events.push("commit");
        return { item, unchanged: false };
      },
    },
    "@/lib/credit-approval-http": {
      approvalErrorResponse: error => ({ status: 500, body: { error: error.message } }),
      approvalPrivateHeaders: { "Cache-Control": "private, no-store" },
      readApprovalRequest: request => request.json(),
    },
    "@/lib/credit-mora-sync": { syncCreditMoraById: syncImpl },
  };
  runInNewContext(outputText, {
    exports: loaded.exports, module: loaded,
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name]; },
    console: { error: (...args) => errors.push(args) }, Error,
  }, { filename: "app/api/aprobaciones/excepciones-mora/route.ts" });
  return { route: loaded.exports, creations: () => creations };
}

const createRequest = () => ({ json: async () => ({ creditoId: 77, expiresOn: null, idempotencyKey: "50000000-0000-4000-8000-000000000081" }) });

test("POST central usa registro directo y sincroniza su crédito una vez confirmado el guardado", async () => {
  const events = [];
  const calls = [];
  const f = loadCreateRoute({ events, syncImpl: async (creditoId, options) => {
    events.push("sync"); calls.push({ creditoId, options }); return { action: "UNLOCKED", message: "Desbloqueo aplicado" };
  } });
  const response = await f.route.POST(createRequest());
  assert.equal(response.status, 201);
  assert.deepEqual(events, ["parse-central", "commit", "sync"]);
  assert.equal(response.body.item.status, "APPROVED");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ creditoId: 77, options: { forceRemoteAudit: true } }]);
  assert.equal(response.body.moraSync.ok, true);
  assert.match(response.headers["Cache-Control"], /no-store/);
});

test("POST central conserva excepción ante fallo remoto y el reintento no duplica su registro", async () => {
  const events = [];
  const errors = [];
  let attempts = 0;
  const f = loadCreateRoute({ events, errors, syncImpl: async () => {
    events.push("sync");
    if (++attempts === 1) throw new Error("TOKEN=secreto de proveedor");
    return { action: "UNLOCKED", message: "Desbloqueo aplicado" };
  } });
  const first = await f.route.POST(createRequest());
  assert.equal(first.status, 201);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.item.status, "APPROVED");
  assert.equal(first.body.moraSync.ok, false);
  assert.doesNotMatch(JSON.stringify({ first, errors }), /TOKEN|secreto de proveedor/);
  const retry = await f.route.POST(createRequest());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.unchanged, true);
  assert.equal(retry.body.item.id, first.body.item.id);
  assert.equal(retry.body.moraSync.ok, true);
  assert.equal(f.creations(), 1);
  assert.deepEqual(events, ["parse-central", "commit", "sync", "parse-central", "replay", "sync"]);
});

test("POST de analista mantiene solicitud pendiente y no solicita desbloqueo", async () => {
  const events = [];
  let syncCalls = 0;
  const f = loadCreateRoute({ centralAdmin: false, events, syncImpl: async () => { syncCalls++; } });
  const response = await f.route.POST(createRequest());
  assert.equal(response.status, 201);
  assert.equal(response.body.item.status, "PENDING");
  assert.deepEqual(events, ["parse-analyst", "commit"]);
  assert.equal(syncCalls, 0);
  assert.equal("moraSync" in response.body, false);
});

test("búsqueda de créditos exige autenticación antes de obtener candidatos", async () => {
  const path = new URL("../app/api/aprobaciones/excepciones-mora/creditos/route.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  let reads = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options = {}) => ({ body, status: options.status || 200, headers: options.headers }) } },
    "@/lib/analyst-mora-access": { getMoraActor: async () => { throw Object.assign(new Error("Sesión ajena"), { status: 403 }); } },
    "@/lib/mora-exception-requests": { searchMoraExceptionCredits: async () => { reads++; return { items: [] }; } },
    "@/lib/credit-approval-http": {
      approvalErrorResponse: error => ({ status: error.status, body: { ok: false }, headers: { "Cache-Control": "private, no-store" } }),
      approvalPrivateHeaders: { "Cache-Control": "private, no-store" },
    },
  };
  runInNewContext(outputText, {
    exports: loaded.exports, module: loaded, URL,
    require(name) { assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name]; },
  }, { filename: "app/api/aprobaciones/excepciones-mora/creditos/route.ts" });
  const response = await loaded.exports.GET({ url: "https://finserpay.com/api/aprobaciones/excepciones-mora/creditos?q=Cliente&centralAdmin=true" });
  assert.equal(response.status, 403);
  assert.equal(reads, 0);
  assert.match(response.headers["Cache-Control"], /private/);
});
