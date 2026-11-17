import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { syncDataCreditoBranchDailyQuotaUsage } from "../lib/datacredito/branch-quota.ts";

const [setup, storage] = await Promise.all([
  readFile(new URL("../scripts/setup-datacredito.sql", import.meta.url), "utf8"),
  readFile(new URL("../lib/datacredito/storage.ts", import.meta.url), "utf8"),
]);
const branchSql = setup.slice(setup.indexOf("-- BEGIN BRANCH DAILY QUERY QUOTAS"), setup.indexOf("-- END BRANCH DAILY QUERY QUOTAS"));
assert.ok(branchSql.length > 500);
const reserveSource = storage.match(/async function reserveDataCreditoDailyQuota[\s\S]*?(?=async function insertPendingDataCreditoAssessment)/)?.[0];
const compensationSource = storage.match(/export async function failDataCreditoAssessmentBeforeProviderDispatch[\s\S]*?(?=export async function getDataCreditoAssessmentById)/)?.[0];
const verifySource = storage.match(/async function verifyDataCreditoBranchDailyQuotaSchema[\s\S]*?(?=async function verifyDataCreditoSchema)/)?.[0];
assert.ok(reserveSource && compensationSource && verifySource);
const schemaNotReady = () => new Error("SCHEMA_NOT_READY");
const reserveQuota = new Function("DataCreditoStorageConfigurationError", "schemaNotReady", "syncDataCreditoBranchDailyQuotaUsage",
  `${stripTypeScriptTypes(reserveSource)};return reserveDataCreditoDailyQuota;`)(Error, schemaNotReady, syncDataCreditoBranchDailyQuotaUsage);
const compensateFor = database => new Function("prisma", "ensureDataCreditoSchema",
  `${stripTypeScriptTypes(compensationSource.replace("export async", "async"))};return failDataCreditoAssessmentBeforeProviderDispatch;`)(database, async () => {});
const verifyFor = database => new Function("prisma", "schemaNotReady",
  `${stripTypeScriptTypes(verifySource)};return verifyDataCreditoBranchDailyQuotaSchema;`)(database, schemaNotReady);

const branchQuotaFixtureSql = `
  CREATE TABLE "Aliado" (id integer PRIMARY KEY, "dataCreditoDailyQueryLimit" integer, "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "Sede" (id integer PRIMARY KEY, "aliadoId" integer, activa boolean NOT NULL DEFAULT true, "updatedAt" timestamp DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "DataCreditoAssessment" (id uuid PRIMARY KEY, "aliadoId" integer, "sedeId" integer,
    "reusedFromAssessmentId" uuid, status text, "durationMs" integer, "providerStatus" text,
    "transactionCode" text, "errorCode" text, "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE "DataCreditoDailyQuotaUsage" ("allyId" integer NOT NULL, "businessDate" date NOT NULL,
    "usedCount" integer NOT NULL CHECK("usedCount">=0), "createdAt" timestamp NOT NULL,
    "updatedAt" timestamp NOT NULL, PRIMARY KEY("allyId","businessDate"));
  INSERT INTO "Aliado"(id,"dataCreditoDailyQueryLimit") VALUES(1,3),(2,20),(3,NULL);
  INSERT INTO "Sede"(id,"aliadoId",activa) VALUES(11,1,true),(12,1,true),(21,2,true),(22,2,true),(31,3,true);
`;
const now = "2026-11-19T12:00:00.000Z";
const day = "2026-11-19";
const args = values => values.map(value => value instanceof Date ? value.toISOString() : value);
const quotaAdapter = client => ({
  $queryRawUnsafe: async (sql, ...values) => {
    const patched = sql.includes("clock_timestamp()")
      ? { text: sql.replaceAll("clock_timestamp()", `$${values.length + 1}::timestamptz`), values: [...values, now] }
      : { text: sql, values: args(values) };
    return (await client.query(patched.text, patched.values)).rows;
  },
});
async function fixture(t) {
  const pg = new PGlite({ parsers: { 1114: value => new Date(value.replace(" ", "T") + "Z") } });
  t.after(() => pg.close());
  await pg.exec(branchQuotaFixtureSql);
  await pg.exec(branchSql);
  const adapter = quotaAdapter(pg);
  const database = { ...adapter, $transaction: async callback => {
    await pg.exec("BEGIN");
    try { const result = await callback(adapter); await pg.exec("COMMIT"); return result; }
    catch (error) { await pg.exec("ROLLBACK"); throw error; }
  } };
  const root = async (changes = {}) => {
    const row = { id: randomUUID(), aliadoId: 1, sedeId: 11, status: "PENDING", createdAt: now, ...changes };
    await pg.query(`INSERT INTO "DataCreditoAssessment" (${Object.keys(row).map(key => `"${key}"`).join(",")})
      VALUES(${Object.keys(row).map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
    return row;
  };
  const usage = async () => (await pg.query(`SELECT "allyId","branchId","businessDate"::text AS day,"usedCount"
    FROM "DataCreditoBranchDailyQuotaUsage" ORDER BY 1,2,3`)).rows;
  const reserve = async (allyId, branchId) => database.$transaction(async tx => {
    const result = await reserveQuota(allyId, tx, branchId);
    if (!result.allowed) return result;
    const assessment = await root({ aliadoId: allyId, sedeId: branchId, dailyQuotaBusinessDate: result.businessDate });
    return { ...result, assessmentId: assessment.id, reservation: { allyId, branchId, businessDate: result.businessDate } };
  });
  return { pg, adapter, database, root, usage, reserve, compensate: compensateFor(database) };
}

test("la migración es opt-in e idempotente, conserva el padre y reconstruye raíces históricas sin contar reutilizaciones", async t => {
  const f = await fixture(t);
  const first = await f.root({ status: "APROBADO", createdAt: "2026-11-19T03:59:00Z" });
  await f.root({ status: "RECHAZADO", createdAt: "2026-11-19T08:00:00Z" });
  await f.root({ sedeId: 12 });
  await f.root({ sedeId: 12, status: "NO_EVALUADO", errorCode: "PROVIDER_OUTCOME_AMBIGUOUS" });
  await f.root({ sedeId: 12, status: "NO_EVALUADO", durationMs: 0 });
  await f.root({ status: "NO_EVALUADO", errorCode: "EVALUATION_ERROR" });
  await f.root({ status: "APROBADO", reusedFromAssessmentId: first.id });
  await f.root({ status: "APROBADO", dailyQuotaBusinessDate: day, createdAt: "2026-11-20T12:00:00Z" });
  await f.pg.exec(`INSERT INTO "DataCreditoDailyQuotaUsage" VALUES(1,'${day}',9,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "DataCreditoBranchDailyQuotaUsage" VALUES(1,11,'2026-11-18',7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  await f.pg.exec(branchSql);
  const expected = [
    { allyId: 1, branchId: 11, day: "2026-11-18", usedCount: 7 },
    { allyId: 1, branchId: 11, day, usedCount: 2 },
    { allyId: 1, branchId: 12, day, usedCount: 3 },
  ];
  assert.deepEqual(await f.usage(), expected);
  await f.pg.exec(branchSql);
  assert.deepEqual(await f.usage(), expected);
  assert.equal((await f.pg.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage"')).rows[0].usedCount, 9);
  assert.ok((await f.pg.query('SELECT "dataCreditoBranchQuotaEnabled" AS enabled FROM "Aliado"')).rows.every(row => row.enabled === false));
  assert.ok((await f.pg.query('SELECT "dataCreditoDailyQueryLimit" AS limit FROM "Sede"')).rows.every(row => row.limit === null));
  assert.equal((await f.pg.query('SELECT COUNT(*)::integer AS n FROM "DataCreditoBranchDailyQuotaAudit"')).rows[0].n, 0);
  await f.pg.exec('UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=true WHERE id=1;UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=2 WHERE id=11');
  await f.pg.exec(branchSql);
  assert.equal((await f.pg.query('SELECT "dataCreditoBranchQuotaEnabled" AS enabled FROM "Aliado" WHERE id=1')).rows[0].enabled, true);
  assert.equal((await f.pg.query('SELECT "dataCreditoDailyQueryLimit" AS limit FROM "Sede" WHERE id=11')).rows[0].limit, 2);
});

test("la sincronización del día repara la compensación antigua y no cambia otros días, aliados ni el contador padre", async t => {
  const f = await fixture(t);
  const assessment = await f.root({ dailyQuotaBusinessDate: day });
  await syncDataCreditoBranchDailyQuotaUsage(f.adapter, 1, day);
  assert.equal((await f.usage())[0].usedCount, 1);
  await f.pg.exec(`INSERT INTO "DataCreditoBranchDailyQuotaUsage" VALUES
    (1,11,'2026-11-18',7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),(2,21,'${day}',8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "DataCreditoDailyQuotaUsage" VALUES(1,'${day}',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
  await f.pg.query('UPDATE "DataCreditoAssessment" SET status=\'NO_EVALUADO\',"errorCode"=\'LOCAL_FAILURE\' WHERE id=$1', [assessment.id]);
  await syncDataCreditoBranchDailyQuotaUsage(f.adapter, 1, day);
  const expected = [
    { allyId: 1, branchId: 11, day: "2026-11-18", usedCount: 7 },
    { allyId: 1, branchId: 11, day, usedCount: 0 },
    { allyId: 2, branchId: 21, day, usedCount: 8 },
  ];
  assert.deepEqual(await f.usage(), expected);
  await f.pg.exec(`UPDATE "DataCreditoBranchDailyQuotaUsage" SET "updatedAt"='2000-01-01'`);
  await syncDataCreditoBranchDailyQuotaUsage(f.adapter, 1, day);
  assert.deepEqual(await f.usage(), expected);
  assert.ok((await f.pg.query('SELECT "updatedAt"::text AS date FROM "DataCreditoBranchDailyQuotaUsage"')).rows.every(row => row.date.startsWith("2000-01-01")));
  assert.equal((await f.pg.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage"')).rows[0].usedCount, 0);
  await assert.rejects(syncDataCreditoBranchDailyQuotaUsage(f.adapter, 0, day), /SYNC_SCOPE_INVALID/);
});

test("el preflight comprueba tipos, nulabilidad, índices, claves foráneas y checks de las cuotas por sede", async t => {
  const f = await fixture(t);
  await verifyFor(f.adapter)();
  await f.pg.exec('ALTER TABLE "DataCreditoBranchDailyQuotaUsage" DROP CONSTRAINT "DataCreditoBranchDailyQuotaUsage_used_check"');
  await assert.rejects(verifyFor(f.adapter)(), /SCHEMA_NOT_READY/);
  await f.pg.exec(branchSql);
  await verifyFor(f.adapter)();
  await assert.rejects(f.pg.exec(`INSERT INTO "DataCreditoBranchDailyQuotaUsage" VALUES(1,11,'${day}',-1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`), error => error.code === "23514");
  await assert.rejects(f.pg.exec('UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=-1 WHERE id=11'), error => error.code === "23514");
  await f.pg.exec('ALTER TABLE "Aliado" ALTER COLUMN "dataCreditoBranchQuotaEnabled" DROP DEFAULT');
  await assert.rejects(verifyFor(f.adapter)(), /SCHEMA_NOT_READY/);
  await f.pg.exec(branchSql);
  await verifyFor(f.adapter)();
});

test("la reserva SQL aplica ambos límites y compensar libera ambos contadores una vez con rollback si falta uno", async t => {
  const f = await fixture(t);
  await f.pg.exec('UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=true WHERE id=1;UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=CASE id WHEN 11 THEN 1 ELSE 2 END WHERE "aliadoId"=1');
  const first = await f.reserve(1, 11);
  assert.equal(first.allowed, true);
  assert.deepEqual({ ...(await f.reserve(1, 11)), resetsAt: null }, { allowed: false, scope: "BRANCH", limit: 1, used: 1, remaining: 0, resetsAt: null });
  await f.reserve(1, 12); await f.reserve(1, 12);
  assert.equal((await f.reserve(1, 12)).scope, "ALLY");
  assert.deepEqual((await f.usage()).map(row => row.usedCount), [1, 2]);
  const input = { id: first.assessmentId, errorCode: "LOCAL_FAILURE", dailyQuotaReservation: first.reservation };
  assert.equal(await f.compensate({ ...input, dailyQuotaReservation: { ...first.reservation, branchId: 12 } }), null);
  assert.equal((await f.compensate(input)).status, "NO_EVALUADO");
  assert.equal(await f.compensate(input), null);
  assert.deepEqual((await f.usage()).map(row => row.usedCount), [0, 2]);
  assert.equal((await f.pg.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage"')).rows[0].usedCount, 2);
  const again = await f.reserve(1, 11);
  await f.pg.exec('DELETE FROM "DataCreditoBranchDailyQuotaUsage" WHERE "branchId"=11');
  await assert.rejects(f.compensate({ id: again.assessmentId, errorCode: "LOCAL_FAILURE", dailyQuotaReservation: again.reservation }), /BRANCH_QUOTA_COMPENSATION_FAILED/);
  assert.equal((await f.pg.query('SELECT status FROM "DataCreditoAssessment" WHERE id=$1', [again.assessmentId])).rows[0].status, "PENDING");
  assert.equal((await f.pg.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage"')).rows[0].usedCount, 3);
});

test("el contador de sede funciona deshabilitado y activar el reparto durante el día no renueva consumo", async t => {
  const f = await fixture(t);
  await f.pg.exec('UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=0 WHERE id=31');
  await f.reserve(3, 31); await f.reserve(3, 31);
  assert.equal((await f.usage())[0].usedCount, 2);
  await f.pg.exec('UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=true,"dataCreditoDailyQueryLimit"=4 WHERE id=3;UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=2 WHERE id=31');
  assert.equal((await f.reserve(3, 31)).scope, "BRANCH");
  assert.equal((await f.pg.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage" WHERE "allyId"=3')).rows[0].usedCount, 2);
});

const nativeEnabled = process.env.DATACREDITO_BRANCH_NATIVE_PG_TEST === "1";
const binaryDirectory = process.env.DATACREDITO_BRANCH_NATIVE_PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function nativeCommand(binary, parameters) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(binaryDirectory, `${binary}${process.platform === "win32" ? ".exe" : ""}`), parameters,
      { cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", code => {
      child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve(output); else reject(new Error(`${binary} exited ${code}: ${output}`));
    });
  });
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test("PostgreSQL nativo aislado: sedes comparten el último cupo, respetan su límite y compensan/distribuyen una sola vez", {
  skip: !nativeEnabled && "Opt-in DATACREDITO_BRANCH_NATIVE_PG_TEST=1; crea y detiene un clúster nuevo en loopback, sin DATABASE_URL.",
  timeout: 90000,
}, async () => {
  await access(path.join(binaryDirectory, process.platform === "win32" ? "initdb.exe" : "initdb"));
  const testRoot = path.resolve(projectRoot, "tmp");
  await mkdir(testRoot, { recursive: true });
  const directory = await mkdtemp(path.join(testRoot, "datacredito-branch-native-"));
  assert.ok(path.resolve(directory).startsWith(`${testRoot}${path.sep}`));
  const dataDirectory = path.join(directory, "data"), port = await unusedPort();
  let started = false, pool;
  try {
    await nativeCommand("initdb", ["-D", dataDirectory, "--username=branch_quota_test", "--auth-host=trust", "--auth-local=trust", "--no-locale", "--encoding=UTF8"]);
    started = true;
    await nativeCommand("pg_ctl", ["-D", dataDirectory, "-l", path.join(directory, "server.log"), "-w", "-t", "20",
      "-o", `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off`, "start"]);
    const { Pool } = await import("pg");
    pool = new Pool({ host: "127.0.0.1", port, user: "branch_quota_test", password: "", database: "postgres",
      ssl: false, max: 24, connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=10000" });
    await pool.query(branchQuotaFixtureSql);
    await pool.query(branchSql);
    await verifyFor(quotaAdapter(pool))();
    await pool.query('UPDATE "Aliado" SET "dataCreditoBranchQuotaEnabled"=true WHERE id IN(1,2);UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=2 WHERE "aliadoId"=1;UPDATE "Sede" SET "dataCreditoDailyQueryLimit"=1 WHERE id=21');
    const database = { $transaction: async callback => {
      const client = await pool.connect();
      const adapter = { ...quotaAdapter(client), $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, args(values))).rowCount };
      await client.query("BEGIN");
      try { const result = await callback(adapter); await client.query("COMMIT"); return result; }
      catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } };
    const reserve = (allyId, branchId) => database.$transaction(async tx => {
      const result = await reserveQuota(allyId, tx, branchId);
      if (!result.allowed) return result;
      const id = randomUUID();
      await tx.$queryRawUnsafe(`INSERT INTO "DataCreditoAssessment"(id,"aliadoId","sedeId",status,"dailyQuotaBusinessDate")
        VALUES($1,$2,$3,'PENDING',$4::date) RETURNING id`, id, allyId, branchId, result.businessDate);
      return { ...result, assessmentId: id, reservation: { allyId, branchId, businessDate: result.businessDate } };
    });
    const shared = await Promise.all(Array.from({ length: 24 }, (_, index) => reserve(1, index % 2 ? 11 : 12)));
    assert.equal(shared.filter(result => result.allowed).length, 3, "Dos sedes concurrentes nunca exceden el total compartido3");
    assert.equal((await pool.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage" WHERE "allyId"=1')).rows[0].usedCount, 3);
    const sharedBranches = (await pool.query('SELECT "usedCount" FROM "DataCreditoBranchDailyQuotaUsage" WHERE "allyId"=1')).rows;
    assert.equal(sharedBranches.reduce((sum, row) => sum + row.usedCount, 0), 3);
    assert.ok(sharedBranches.every(row => row.usedCount <= 2));
    const oneBranch = await Promise.all(Array.from({ length: 20 }, () => reserve(2, 21)));
    assert.equal(oneBranch.filter(result => result.allowed).length, 1, "Un único asesor obtiene el último cupo de sede");
    assert.ok(oneBranch.filter(result => !result.allowed).every(result => result.scope === "BRANCH"));
    const paid = oneBranch.find(result => result.allowed), compensate = compensateFor(database);
    const releaseInput = { id: paid.assessmentId, errorCode: "LOCAL_FAILURE", dailyQuotaReservation: paid.reservation };
    const released = await Promise.all([compensate(releaseInput), compensate(releaseInput)]);
    assert.equal(released.filter(Boolean).length, 1, "La compensación concurrente se aplica una sola vez");
    assert.equal((await pool.query('SELECT "usedCount" FROM "DataCreditoDailyQuotaUsage" WHERE "allyId"=2')).rows[0].usedCount, 0);
    assert.equal((await pool.query('SELECT "usedCount" FROM "DataCreditoBranchDailyQuotaUsage" WHERE "allyId"=2 AND "branchId"=21')).rows[0].usedCount, 0);

    await pool.query('INSERT INTO "Aliado"(id,"dataCreditoDailyQueryLimit") VALUES(4,6);INSERT INTO "Sede"(id,"aliadoId",activa) VALUES(41,4,true),(42,4,true)');
    const adminSource = await readFile(new URL("../lib/datacredito/admin-storage.ts", import.meta.url), "utf8");
    const validators = adminSource.slice(adminSource.indexOf("export class DataCreditoDailyQueryLimitValidationError"), adminSource.indexOf("export class DataCreditoPolicyProfileNameConflictError"));
    const setter = adminSource.slice(adminSource.indexOf("export async function setDataCreditoBranchDailyQuotas"));
    const allocation = new Function("prisma", "ensureDataCreditoSchema", "syncDataCreditoBranchDailyQuotaUsage", "randomUUID", "DATACREDITO_DAILY_QUERY_LIMIT_MAX",
      `${stripTypeScriptTypes(`${validators}\n${setter}`.replaceAll("export ", ""))};return setDataCreditoBranchDailyQuotas;`)(database, async () => {}, syncDataCreditoBranchDailyQuotaUsage, randomUUID, 10000);
    const distribution = limits => ({ allyId: 4, enabled: true, expectedEnabled: false, expectedDailyQueryLimit: 6,
      branches: limits.map((dailyLimit, index) => ({ branchId: 41 + index, dailyLimit, expectedDailyLimit: null })),
      actorUserId: 1, requestCorrelationId: randomUUID() });
    const allocations = await Promise.allSettled([allocation(distribution([3, 3])), allocation(distribution([2, 4]))]);
    assert.equal(allocations.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(allocations.filter(result => result.status === "rejected" && result.reason.name === "DataCreditoBranchDailyQuotaConflictError").length, 1);
    assert.equal((await pool.query('SELECT COUNT(*)::integer AS n FROM "DataCreditoBranchDailyQuotaAudit" WHERE "allyId"=4')).rows[0].n, 1);
    assert.equal((await pool.query('SELECT SUM("dataCreditoDailyQueryLimit")::integer AS n FROM "Sede" WHERE "aliadoId"=4')).rows[0].n, 6);
  } finally {
    if (pool) await pool.end();
    if (started) await nativeCommand("pg_ctl", ["-D", dataDirectory, "-m", "immediate", "-w", "-t", "20", "stop"]);
  }
});
