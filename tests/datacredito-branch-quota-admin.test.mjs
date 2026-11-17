import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const plain = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, { module: vmModule, exports: vmModule.exports, Request, Response,
    console: { error() {} }, require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`); return dependencies[name];
    } });
  return vmModule.exports;
}
const policy = load("lib/datacredito/policy.ts");
class StorageError extends Error {}
class VersionError extends Error {}
class PolicyNotFound extends Error {}
class DeleteAssigned extends Error {}
class DeleteDefault extends Error {}
class DeleteNotFound extends Error {}
class DeleteVersion extends Error {}
const defaults = { fianzaTotalPorcentaje: 75, seguroCuotaPorcentaje: 0.03, frecuenciaPago: "QUINCENAL" };
const initialState = () => ({ ally: { id: 8, dailyQueryLimit: 10, branchQuotaEnabled: false },
  branches: [{ id: 11, active: true, dailyQueryLimit: null }, { id: 12, active: true, dailyQueryLimit: null },
    { id: 13, active: false, dailyQueryLimit: 7 }], audits: [], parentAudits: [] });
const branchInput = () => ({ allyId: 8, enabled: true, expectedEnabled: false, expectedDailyQueryLimit: 10,
  branches: [{ branchId: 12, dailyLimit: 6, expectedDailyLimit: null }, { branchId: 11, dailyLimit: 4, expectedDailyLimit: null }],
  actorUserId: 7, requestCorrelationId: "request-test", reason: "  Distribución   aprobada  " });

function fixture({ state = initialState(), catalogError = false, access = { ok: true, user: { id: 7 } } } = {}) {
  const events = [];
  let currentState = plain(state);
  let catalogUnavailable = catalogError;
  const database = {
    async $queryRawUnsafe(sql, ...args) {
      events.push({ type: "query", sql, args });
      if (sql.includes('FROM "DataCreditoPolicyProfile" profile')) {
        if (catalogUnavailable) throw new Error("catalog read failed");
        return [];
      }
      if (sql.includes("WITH quota_clock")) return [{ ...currentState.ally, name: "Aliado", active: true,
        code: "TEST", policyId: "general", policyName: "General", dailyQueriesUsed: 3,
        dailyQuotaResetsAt: "2026-11-18T05:00:00.000Z",
        branches: currentState.branches.map(b => ({ ...b, name: `Sede ${b.id}`, usedToday: b.id === 11 ? 2 : 0 })) }];
      if (sql.includes('FROM "Aliado"') && sql.includes("FOR UPDATE")) return currentState.ally ? [plain(currentState.ally)] : [];
      if (sql.includes("clock_timestamp()") && sql.includes('AS "businessDate"')) return [{ businessDate: "2026-11-17" }];
      if (sql.includes('FROM "Sede"') && sql.includes("FOR UPDATE")) {
        return plain(currentState.branches.filter(b => !sql.includes('AND "activa" = true') || b.active));
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...args) {
      events.push({ type: "write", sql, args });
      if (sql.includes('UPDATE "Aliado"') && sql.includes('"dataCreditoBranchQuotaEnabled" =')) currentState.ally.branchQuotaEnabled = args[1];
      else if (sql.includes('UPDATE "Aliado"') && sql.includes('"dataCreditoDailyQueryLimit" =')) currentState.ally.dailyQueryLimit = args[1];
      else if (sql.includes('UPDATE "Sede"')) currentState.branches.find(b => b.id === args[0]).dailyQueryLimit = args[1];
      else if (sql.includes('INSERT INTO "DataCreditoBranchDailyQuotaAudit"')) currentState.audits.push(args);
      else if (sql.includes('INSERT INTO "DataCreditoDailyQuotaAudit"')) currentState.parentAudits.push(args);
      else throw new Error(`Escritura inesperada: ${sql}`);
      return 1;
    },
    async $transaction(callback) {
      const before = plain(currentState);
      try { return await callback(database); } catch (error) { currentState = before; throw error; }
    },
  };
  const admin = load("lib/datacredito/admin-storage.ts", {
    "server-only": {}, "node:crypto": { randomUUID }, "@/lib/prisma": { default: database },
    "@/lib/credit-settings": { getCreditSettings: async () => defaults },
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: async () => {}, DEFAULT_DATACREDITO_POLICY_PROFILE_ID: "general" },
    "@/lib/datacredito/database-errors": {}, "@/lib/datacredito/policy": policy,
    "@/lib/datacredito/secure-record": {},
    "@/lib/datacredito/branch-quota": { syncDataCreditoBranchDailyQuotaUsage: async (tx, allyId, businessDate) => {
      assert.equal(tx, database); events.push({ type: "sync", allyId, businessDate });
    } },
  });
  const route = load("app/api/creditos/datacredito/politicas/route.ts", {
    "node:crypto": { randomUUID },
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/datacredito": { getDataCreditoPublicConfig: () => ({ enabled: true, configured: true }) },
    "@/lib/datacredito/admin-access": { getDataCreditoCentralAdmin: async () => access },
    "@/lib/datacredito/admin-storage": admin, "@/lib/datacredito/policy": policy,
    "@/lib/datacredito/storage": { DataCreditoPolicyConflictError: VersionError,
      DataCreditoPolicyNotFoundError: PolicyNotFound, DataCreditoStorageConfigurationError: StorageError,
      isDataCreditoAuditConfigured: () => true },
    "@/lib/datacredito/policy-deletion": { DataCreditoPolicyDeleteAssignedError: DeleteAssigned,
      DataCreditoPolicyDeleteDefaultError: DeleteDefault, DataCreditoPolicyDeleteNotFoundError: DeleteNotFound,
      DataCreditoPolicyDeleteVersionConflictError: DeleteVersion },
  });
  return { admin, events, get state() { return currentState; }, recoverCatalog() { catalogUnavailable = false; },
    async api(body, method = "PATCH") {
      const response = await route[method](new Request("https://finserpay.test/api/creditos/datacredito/politicas", {
        method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }));
      return { status: response.status, headers: response.headers, data: await response.json() };
    },
  };
}

test("guarda toda la distribución atómicamente, conserva inactivas y audita sin alterar el cupo padre", async () => {
  const f = fixture();
  const result = await f.admin.setDataCreditoBranchDailyQuotas(branchInput());
  assert.deepEqual(plain(result), { allyId: 8, enabled: true,
    branches: [{ branchId: 11, dailyLimit: 4 }, { branchId: 12, dailyLimit: 6 }] });
  assert.deepEqual(f.state.branches.map(b => b.dailyQueryLimit), [4, 6, 7]);
  assert.equal(f.state.ally.dailyQueryLimit, 10);
  assert.equal(f.state.ally.branchQuotaEnabled, true);
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.parentAudits.length, 0);
  const audit = f.state.audits[0];
  assert.deepEqual(audit.slice(1, 6), [8, 7, "request-test", false, true]);
  assert.deepEqual(JSON.parse(audit[6]), [{ branchId: 11, dailyLimit: null }, { branchId: 12, dailyLimit: null }]);
  assert.deepEqual(JSON.parse(audit[7]), [{ branchId: 11, dailyLimit: 4 }, { branchId: 12, dailyLimit: 6 }]);
  assert.equal(audit[8], "Distribución aprobada");
  const allyLock = f.events.findIndex(e => e.sql?.includes('FROM "Aliado"') && e.sql.includes("FOR UPDATE"));
  const clock = f.events.findIndex(e => e.sql?.includes('AS "businessDate"'));
  const sync = f.events.findIndex(e => e.type === "sync");
  const branchLock = f.events.findIndex(e => e.sql?.includes('FROM "Sede"'));
  assert.ok(allyLock >= 0 && clock > allyLock && sync > clock && branchLock > sync);
  assert.deepEqual(f.events[sync], { type: "sync", allyId: 8, businessDate: "2026-11-17" });
  assert.match(f.events[branchLock].sql, /ORDER BY "id" FOR UPDATE/);
});

test("normaliza presupuesto nulo a cero, admite desactivar y no duplica auditoría de un no-op", async () => {
  const f = fixture();
  const input = branchInput(); input.branches[1].dailyLimit = null;
  await f.admin.setDataCreditoBranchDailyQuotas(input);
  assert.deepEqual(f.state.branches.map(b => b.dailyQueryLimit), [0, 6, 7]);
  const unchanged = { ...input, expectedEnabled: true,
    branches: [{ branchId: 11, dailyLimit: 0, expectedDailyLimit: 0 }, { branchId: 12, dailyLimit: 6, expectedDailyLimit: 6 }] };
  await f.admin.setDataCreditoBranchDailyQuotas(unchanged);
  assert.equal(f.state.audits.length, 1);
  await f.admin.setDataCreditoBranchDailyQuotas({ ...unchanged, enabled: false });
  assert.equal(f.state.ally.branchQuotaEnabled, false);
  assert.deepEqual(f.state.branches.map(b => b.dailyQueryLimit), [0, 6, 7]);
  assert.equal(f.state.audits.length, 2);
});

test("rechaza modo/tope/presupuestos obsoletos y sedes ajenas, inactivas o ausentes sin escrituras parciales", async () => {
  for (const alter of [input => { input.expectedEnabled = true; }, input => { input.expectedDailyQueryLimit = 9; },
    input => { input.branches[0].expectedDailyLimit = 1; }, input => { input.branches.pop(); },
    input => { input.branches[0].branchId = 999; }, input => { input.branches[0].branchId = 13; }]) {
    const f = fixture(); const before = plain(f.state); const input = branchInput(); alter(input);
    await assert.rejects(f.admin.setDataCreditoBranchDailyQuotas(input), error => error.name === "DataCreditoBranchDailyQuotaConflictError");
    assert.deepEqual(f.state, before);
    assert.equal(f.events.filter(e => e.type === "write").length, 0);
  }
});

test("activar exige total finito y suma de sedes activas dentro del total del aliado", async () => {
  for (const total of [null, 9]) {
    const state = initialState(); state.ally.dailyQueryLimit = total;
    const f = fixture({ state }); const input = { ...branchInput(), expectedDailyQueryLimit: total };
    await assert.rejects(f.admin.setDataCreditoBranchDailyQuotas(input), error => error.name === "DataCreditoBranchDailyQuotaValidationError");
    assert.deepEqual(f.state, state);
  }
  const state = initialState(); state.ally.dailyQueryLimit = 0;
  const f = fixture({ state });
  await f.admin.setDataCreditoBranchDailyQuotas({ ...branchInput(), expectedDailyQueryLimit: 0,
    branches: [{ branchId: 11, dailyLimit: 0, expectedDailyLimit: null }, { branchId: 12, dailyLimit: 0, expectedDailyLimit: null }] });
  assert.equal(f.state.ally.branchQuotaEnabled, true);
});

test("validación estricta impide duplicados, negativos, fracciones, datos faltantes y motivo excesivo", async () => {
  for (const branches of [null, {}, [{ branchId: 11, dailyLimit: 0 }],
    [{ branchId: 11, dailyLimit: -1, expectedDailyLimit: null }], [{ branchId: 11, dailyLimit: 1.5, expectedDailyLimit: null }],
    [{ branchId: 11, dailyLimit: "5", expectedDailyLimit: null }], [{ branchId: 11, dailyLimit: 10_001, expectedDailyLimit: null }],
    [{ branchId: 11, dailyLimit: 1, expectedDailyLimit: null }, { branchId: 11, dailyLimit: 1, expectedDailyLimit: null }]]) {
    const f = fixture();
    assert.throws(() => f.admin.parseDataCreditoBranchDailyQuotas(branches), error => error.name === "DataCreditoBranchDailyQuotaValidationError");
    assert.equal(f.events.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.admin.setDataCreditoBranchDailyQuotas({ ...branchInput(), reason: "x".repeat(241) }),
    error => error.name === "DataCreditoBranchDailyQuotaValidationError");
  assert.equal(f.events.length, 0);
});

test("el total padre no puede hacerse ilimitado ni bajar bajo la suma activa cuando la distribución está habilitada", async () => {
  const enabled = initialState(); enabled.ally.branchQuotaEnabled = true;
  enabled.branches[0].dailyQueryLimit = 4; enabled.branches[1].dailyQueryLimit = 6;
  for (const limit of [null, 9]) {
    const f = fixture({ state: enabled });
    await assert.rejects(f.admin.setDataCreditoDailyQueryLimitForAlly({ allyId: 8, dailyQueryLimit: limit,
      expectedDailyQueryLimit: 10, actorUserId: 7, requestCorrelationId: "parent-change" }),
    error => error.name === "DataCreditoDailyQueryLimitValidationError");
    assert.deepEqual(f.state, enabled);
  }
  const f = fixture({ state: enabled });
  await f.admin.setDataCreditoDailyQueryLimitForAlly({ allyId: 8, dailyQueryLimit: 12,
    expectedDailyQueryLimit: 10, actorUserId: 7, requestCorrelationId: "parent-change" });
  assert.equal(f.state.ally.dailyQueryLimit, 12);
  assert.equal(f.state.parentAudits.length, 1);
  assert.equal(f.state.audits.length, 0);
  const off = fixture();
  await off.admin.setDataCreditoDailyQueryLimitForAlly({ allyId: 8, dailyQueryLimit: null,
    expectedDailyQueryLimit: 10, actorUserId: 7, requestCorrelationId: "parent-change" });
  assert.equal(off.state.ally.dailyQueryLimit, null);
});

test("catálogo añade modo y presupuesto/consumo por sede bajo el mismo día Bogotá del aliado", async () => {
  const state = initialState(); state.ally.branchQuotaEnabled = true; state.branches[0].dailyQueryLimit = 4;
  const f = fixture({ state });
  const result = await f.admin.listDataCreditoPolicyCatalog();
  assert.equal(result.allies[0].branchQuotaEnabled, true);
  assert.deepEqual(plain(result.allies[0].branches), [
    { id: 11, name: "Sede 11", active: true, dailyQueryLimit: 4, usedToday: 2, remainingToday: 2 },
    { id: 12, name: "Sede 12", active: true, dailyQueryLimit: null, usedToday: 0, remainingToday: 0 },
    { id: 13, name: "Sede 13", active: false, dailyQueryLimit: 7, usedToday: 0, remainingToday: 0 },
  ]);
  const query = f.events.find(e => e.sql?.includes("WITH quota_clock")).sql;
  assert.match(query, /branch_usage\."allyId" = ally\."id"/);
  assert.match(query, /branch_usage\."businessDate" = quota_clock\."businessDate"/);
  assert.match(query, /branch\."aliadoId" = ally\."id"/);
  state.ally.dailyQueryLimit = 4;
  const limitedByParent = await fixture({ state }).admin.listDataCreditoPolicyCatalog();
  assert.equal(limitedByParent.allies[0].branches[0].remainingToday, 1,
    "Lo disponible en una sede también respeta el saldo global tras redistribuir el cupo durante el día");
});

test("API autoriza solo central, valida snapshot y conserva recuperación posterior al commit sin duplicar escrituras", async () => {
  const body = { action: "SET_BRANCH_DAILY_QUOTAS", ...branchInput() };
  const f = fixture({ catalogError: true });
  const result = await f.api(body);
  assert.equal(result.status, 200);
  assert.equal(result.data.operationCommitted, true);
  assert.equal(result.data.catalogReloadRequired, true);
  assert.equal(result.data.committedOperation, "SET_BRANCH_DAILY_QUOTAS");
  assert.equal(result.data.branchQuotasUpdatedAllyId, 8);
  assert.equal(result.data.code, "POLICY_CATALOG_REFRESH_FAILED");
  assert.equal(f.state.audits.length, 1);
  f.recoverCatalog();
  const recovered = await f.api(undefined, "GET");
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.allies[0].branchQuotaEnabled, true);
  assert.equal(f.state.audits.length, 1);
  const stale = await f.api(body);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "BRANCH_DAILY_QUOTA_CONFLICT");
  assert.equal(stale.data.operationCommitted, undefined);
  assert.equal(f.state.audits.length, 1);
  for (const invalid of [{ ...body, enabled: "true" }, { ...body, expectedEnabled: undefined },
    { ...body, expectedDailyQueryLimit: undefined }, { ...body, reason: 12 }, { ...body, branches: [] }]) {
    const bad = fixture(); const response = await bad.api(invalid);
    assert.ok([400, 409].includes(response.status));
    assert.equal(bad.state.audits.length, 0);
  }
  for (const status of [401, 403]) {
    const denied = fixture({ access: { ok: false, status } });
    assert.equal((await denied.api(body)).status, status);
    assert.equal(denied.events.length, 0);
  }
});
