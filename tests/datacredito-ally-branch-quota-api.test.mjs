import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const plain = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies = {}) {
  const vmModule = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module: vmModule, exports: vmModule.exports, Request, Response, URL, Error,
    console: { error() {} }, require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  });
  return vmModule.exports;
}
const policy = load("lib/datacredito/policy.ts");
const quotaUsage = load("lib/datacredito/branch-quota.ts");
const roles = load("lib/roles.ts");
const setup = readFileSync(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8");
const branchSql = setup.slice(setup.indexOf("-- BEGIN BRANCH DAILY QUERY QUOTAS"), setup.indexOf("-- END BRANCH DAILY QUERY QUOTAS"));
class StorageError extends Error {}
const adminUser = () => ({ id: 7, activo: true, rolNombre: "ADMIN", aliadoAccesoId: 8,
  aliadoId: 99, aliadoAccesoCodigo: "ALIADO", sedeAccesoActiva: true, aliadoAccesoActivo: true });
const payload = () => ({ expectedDailyQueryLimit: 10,
  branches: [{ branchId: 12, dailyLimit: 8, expectedDailyLimit: 6 }, { branchId: 11, dailyLimit: 2, expectedDailyLimit: 4 }],
  reason: "Trasladar cupo disponible a sede 12" });

async function fixture(t, options = {}) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "Aliado" (id INTEGER PRIMARY KEY, nombre TEXT, codigo TEXT, activo BOOLEAN NOT NULL DEFAULT true,
      "dataCreditoDailyQueryLimit" INTEGER, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Sede" (id INTEGER PRIMARY KEY, nombre TEXT, "aliadoId" INTEGER, activa BOOLEAN NOT NULL DEFAULT true,
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "DataCreditoAssessment" (id UUID PRIMARY KEY, "aliadoId" INTEGER, "sedeId" INTEGER,
      "reusedFromAssessmentId" UUID, status TEXT, "durationMs" INTEGER, "providerStatus" TEXT,
      "transactionCode" TEXT, "errorCode" TEXT, "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "DataCreditoDailyQuotaUsage" ("allyId" INTEGER, "businessDate" DATE, "usedCount" INTEGER,
      "createdAt" TIMESTAMP, "updatedAt" TIMESTAMP, PRIMARY KEY("allyId","businessDate"));
    INSERT INTO "Aliado" (id,nombre,codigo,"dataCreditoDailyQueryLimit") VALUES (8,'Aliado propio','PROPIO',10),(9,'Otro aliado','AJENO',90);
    INSERT INTO "Sede" (id,nombre,"aliadoId",activa) VALUES (11,'Sede uno',8,true),(12,'Sede dos',8,true),(13,'Sede inactiva',8,false),(91,'Sede ajena',9,true);
  `);
  await pg.exec(branchSql);
  await pg.exec(`
    UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=true;
    UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=CASE id WHEN 11 THEN 4 WHEN 12 THEN 6 WHEN 13 THEN 7 ELSE 90 END;
    INSERT INTO "DataCreditoDailyQuotaUsage" VALUES (8,'2026-11-19',3,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),(9,'2026-11-19',5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "DataCreditoAssessment" (id,"aliadoId","sedeId",status,"dailyQuotaBusinessDate") VALUES
      ('10000000-0000-4000-8000-000000000001',8,11,'APROBADO','2026-11-19'),
      ('10000000-0000-4000-8000-000000000002',8,11,'RECHAZADO','2026-11-19'),
      ('10000000-0000-4000-8000-000000000003',8,12,'PENDING','2026-11-19');
    INSERT INTO "DataCreditoBranchDailyQuotaUsage" VALUES
      (8,11,'2026-11-19',2,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (8,12,'2026-11-19',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
      (9,91,'2026-11-19',5,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
  `);
  let user = options.user === undefined ? adminUser() : options.user;
  let failRead = false;
  const events = [];
  const adapter = {
    async $queryRawUnsafe(sql, ...values) {
      events.push({ type: "query", sql, values });
      if (failRead && sql.includes('WHERE ally."id" = $1')) throw new Error("read failed after commit");
      const text = sql.replaceAll("clock_timestamp()", "'2026-11-19T16:00:00Z'::timestamptz");
      return (await pg.query(text, values)).rows;
    },
    async $executeRawUnsafe(sql, ...values) {
      events.push({ type: "write", sql, values });
      return (await pg.query(sql, values)).affectedRows;
    },
  };
  const database = { ...adapter, async $transaction(callback) {
    await pg.exec("BEGIN");
    try { const result = await callback(adapter); await pg.exec("COMMIT"); return result; }
    catch (error) { await pg.exec("ROLLBACK"); throw error; }
  } };
  const access = load("lib/datacredito/ally-branch-quota-access.ts", {
    "server-only": {}, "@/lib/auth": { getSessionUser: async () => user }, "@/lib/roles": roles,
  });
  const storage = load("lib/datacredito/ally-branch-quota-storage.ts", {
    "server-only": {}, "@/lib/prisma": { default: database },
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: async () => {} },
  });
  const admin = load("lib/datacredito/admin-storage.ts", {
    "server-only": {}, "node:crypto": { randomUUID }, "@/lib/prisma": { default: database },
    "@/lib/credit-settings": { getCreditSettings: async () => ({}) },
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: async () => {} },
    "@/lib/datacredito/database-errors": {}, "@/lib/datacredito/policy": policy,
    "@/lib/datacredito/secure-record": {}, "@/lib/datacredito/branch-quota": quotaUsage,
  });
  const route = load("app/api/creditos/datacredito/cupos-sedes/route.ts", {
    "node:crypto": { randomUUID }, "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/datacredito/ally-branch-quota-access": access,
    "@/lib/datacredito/ally-branch-quota-storage": storage,
    "@/lib/datacredito/admin-storage": admin,
    "@/lib/datacredito/storage": { DataCreditoStorageConfigurationError: StorageError },
  });
  const state = async () => plain({
    allies: (await pg.query('SELECT * FROM "Aliado" ORDER BY id')).rows,
    branches: (await pg.query('SELECT * FROM "Sede" ORDER BY id')).rows,
    globalUsage: (await pg.query('SELECT * FROM "DataCreditoDailyQuotaUsage" ORDER BY "allyId"')).rows,
    branchUsage: (await pg.query('SELECT * FROM "DataCreditoBranchDailyQuotaUsage" ORDER BY "allyId","branchId"')).rows,
    audit: (await pg.query('SELECT * FROM "DataCreditoBranchDailyQuotaAudit"')).rows,
  });
  return { pg, admin, access, storage, events, state, setUser(value) { user = value; },
    setReadFailure(value) { failRead = value; },
    async api(body, method = "POST", headers = {}) {
      const response = await route[method](new Request("https://finserpay.test/api/creditos/datacredito/cupos-sedes", {
        method, headers: { "content-type": "application/json", origin: "https://finserpay.test", ...headers },
        ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }));
      return { status: response.status, headers: response.headers, data: await response.json() };
    },
  };
}

test("GET solo muestra el aliado del acceso administrativo y sus cupos, nunca catálogos o sedes ajenas", async t => {
  const f = await fixture(t);
  const result = await f.api(undefined, "GET");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(Object.keys(result.data).sort(), ["ally", "ok"]);
  assert.deepEqual(result.data.ally, { id: 8, name: "Aliado propio", dailyQueryLimit: 10,
    branchQuotaEnabled: true, dailyQueriesUsed: 3, dailyQueriesRemaining: 7,
    dailyQuotaResetsAt: "2026-11-20T05:00:00.000Z",
    branches: [
      { id: 12, name: "Sede dos", active: true, dailyQueryLimit: 6, usedToday: 1, remainingToday: 5 },
      { id: 13, name: "Sede inactiva", active: false, dailyQueryLimit: 7, usedToday: 0, remainingToday: 0 },
      { id: 11, name: "Sede uno", active: true, dailyQueryLimit: 4, usedToday: 2, remainingToday: 2 },
    ] });
  assert.equal(f.events.filter(event => event.type === "write").length, 0);
  assert.ok(f.events.every(event => !event.sql.includes('DataCreditoPolicyProfile')));
  assert.deepEqual(f.events[0].values, [8], "No usa el aliadoId operativo 99 de la sesión");
});

test("redistribuye de forma atómica con auditoría conservando padre, modo, consumo, sedes ajenas e inactivas", async t => {
  const f = await fixture(t), before = await f.state();
  const result = await f.api(payload());
  assert.equal(result.status, 200);
  assert.equal(result.data.ally.id, 8);
  const after = await f.state();
  assert.deepEqual(after.allies, before.allies);
  assert.deepEqual(after.globalUsage, before.globalUsage);
  assert.deepEqual(after.branchUsage, before.branchUsage);
  assert.deepEqual(after.branches.map(branch => branch.dataCreditoDailyQueryLimit), [2, 8, 7, 90]);
  assert.equal(after.audit.length, 1);
  assert.equal(after.audit[0].actorUserId, 7);
  assert.equal(after.audit[0].allyId, 8);
  assert.equal(after.audit[0].previousEnabled, true);
  assert.equal(after.audit[0].enabled, true);
  assert.deepEqual(after.audit[0].limits, [{ branchId: 11, dailyLimit: 2 }, { branchId: 12, dailyLimit: 8 }]);
  assert.equal(f.events.some(event => /UPDATE "Aliado"/.test(event.sql)), false);
  assert.equal(result.data.ally.dailyQueriesRemaining, 7);
  assert.equal(result.data.ally.branches.find(branch => branch.id === 12).remainingToday, 7);
});

test("identidad administrativa activa es obligatoria y no se amplía a vendedores, supervisores ni analistas", async t => {
  const f = await fixture(t);
  for (const user of [null, ...[
    { rolNombre: "USUARIO" }, { rolNombre: "SUPERVISOR" }, { rolNombre: "ANALISTA_APROBACION" },
    { activo: false }, { sedeAccesoActiva: false }, { aliadoAccesoActivo: false },
    { aliadoAccesoId: null }, { aliadoAccesoId: -1 },
  ].map(changes => ({ ...adminUser(), ...changes }))]) {
    f.setUser(user);
    const before = f.events.length;
    for (const method of ["GET", "POST"]) {
      assert.equal((await f.api(payload(), method)).status, user ? 403 : 401);
    }
    assert.equal(f.events.length, before);
  }
  f.setUser({ ...adminUser(), aliadoAccesoId: 9 });
  const read = await f.api(undefined, "GET");
  assert.equal(read.data.ally.id, 9);
  assert.deepEqual(read.data.ally.branches.map(branch => branch.id), [91]);
  assert.equal((await f.api(payload())).status, 409, "No puede escribir sedes del aliado 8");
});

test("rechaza campos forjados, JSON/origen inválidos y distribuciones incompletas sin escrituras", async t => {
  const f = await fixture(t), before = await f.state();
  for (const field of ["allyId", "enabled", "expectedEnabled", "dailyQueryLimit", "action", "policyId", "actorUserId"]) {
    assert.equal((await f.api({ ...payload(), [field]: 999 })).status, 400, field);
  }
  for (const branches of [[], [{ branchId: 11, dailyLimit: 10, expectedDailyLimit: 4 }],
    [{ branchId: 11, dailyLimit: 10, expectedDailyLimit: 4 }, { branchId: 91, dailyLimit: 0, expectedDailyLimit: 90 }],
    [{ branchId: 11, dailyLimit: 2, expectedDailyLimit: 4, aliadoId: 9 }],
    [{ branchId: 11, dailyLimit: 2 }, { branchId: 12, dailyLimit: 8, expectedDailyLimit: 6 }],
    [{ branchId: 11, dailyLimit: -1, expectedDailyLimit: 4 }],
    [{ branchId: 11, dailyLimit: 2.5, expectedDailyLimit: 4 }],
    [{ branchId: 11, dailyLimit: "2", expectedDailyLimit: 4 }],
    [{ branchId: 11, dailyLimit: 2, expectedDailyLimit: 4 }, { branchId: 11, dailyLimit: 8, expectedDailyLimit: 4 }],
  ]) assert.ok([400, 409].includes((await f.api({ ...payload(), branches })).status));
  assert.equal((await f.api("{")).status, 400);
  assert.equal((await f.api(payload(), "POST", { "content-type": "text/plain" })).status, 400);
  for (const headers of [{ origin: "https://other.test" }, { origin: "null" },
    { origin: "" }, { "sec-fetch-site": "cross-site" },
    { origin: "https://other.test", "x-forwarded-host": "other.test" },
  ]) assert.equal((await f.api(payload(), "POST", headers)).status, 403);
  assert.deepEqual(await f.state(), before);
  assert.equal(f.events.filter(event => event.type === "write").length, 0);
});

test("no habilita ni deshabilita reparto y comprueba bajo lock modo, estado, tope, sedes y presupuestos vigentes", async t => {
  const f = await fixture(t);
  for (const statement of [
    'UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=false WHERE id=8',
    'UPDATE "Aliado" SET activo=false WHERE id=8',
    'UPDATE "Aliado" SET "dataCreditoDailyQueryLimit"=9 WHERE id=8',
    'UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=5 WHERE id=11',
    'UPDATE "Sede" SET activa=false WHERE id=12',
    'UPDATE "Sede" SET "aliadoId"=9 WHERE id=12',
  ]) {
    await f.pg.exec(statement);
    const before = await f.state();
    const response = await f.api(payload());
    assert.equal(response.status, 409, statement);
    assert.deepEqual(await f.state(), before, "Rollback completo de un conflicto");
    await f.pg.exec(`UPDATE "Aliado" SET activo=true,"dataCreditoBranchQuotaEnabled"=true,"dataCreditoDailyQueryLimit"=10 WHERE id=8;
      UPDATE "Sede" SET activa=true,"dataCreditoDailyQueryLimit"=CASE id WHEN 11 THEN 4 ELSE 6 END,"aliadoId"=8 WHERE id IN (11,12);`);
  }
  const invalid = payload(); invalid.branches[0].dailyLimit = 9;
  assert.equal((await f.api(invalid)).status, 400);
  assert.equal((await f.state()).audit.length, 0);
});

test("un guardado anterior invalida otra propuesta y una recarga fallida informa commit sin duplicar cambios", async t => {
  const f = await fixture(t), original = payload();
  f.setReadFailure(true);
  const saved = await f.api(original);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.operationCommitted, true);
  assert.equal(saved.data.quotaReloadRequired, true);
  assert.equal(saved.data.code, "BRANCH_QUOTA_REFRESH_FAILED");
  assert.equal((await f.state()).audit.length, 1);
  assert.equal((await f.api(original)).status, 409);
  assert.equal((await f.state()).audit.length, 1);
  f.setReadFailure(false);
  const read = await f.api(undefined, "GET");
  assert.equal(read.data.ally.branches.find(branch => branch.id === 11).dailyQueryLimit, 2);
  const noOp = { ...original, branches: original.branches.map(branch => ({ ...branch, expectedDailyLimit: branch.dailyLimit })) };
  assert.equal((await f.api(noOp)).status, 200);
  assert.equal((await f.state()).audit.length, 1);
});
