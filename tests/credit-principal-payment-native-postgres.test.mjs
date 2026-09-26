import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { access, mkdtemp, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import pg from "pg";
import ts from "typescript";
import { installCreditPrincipalPaymentSchema } from "../scripts/credit-principal-payment-schema.mjs";

// Explicit opt-in: always creates a NEW local cluster, never reads DATABASE_URL.
const enabled = process.env.CAPITAL_NATIVE_PG_TEST === "1";
const binaryDirectory = process.env.CAPITAL_NATIVE_PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
const root = path.resolve(import.meta.dirname, "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function command(binary, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG|^DATABASE_URL$/.test(key)));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(binaryDirectory, `${binary}${process.platform === "win32" ? ".exe" : ""}`), args, {
      cwd: root, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", reject);
    child.on("exit", code => {
      child.stdout.destroy(); child.stderr.destroy();
      code === 0 ? resolve(output) : reject(new Error(`${binary} exited ${code}: ${output}`));
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
async function waitForBlocked(observer, waiter, blocker) {
  const deadline = Date.now() + 8000;
  do {
    const row = (await observer.query("SELECT pg_blocking_pids($1) AS blockers", [waiter])).rows[0];
    if (row.blockers.includes(blocker)) return;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail("The second isolated transaction did not wait on the credit row lock");
}
const dbAdapter = client => ({
  $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
  $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount,
});
async function storageModule() {
  const source = await readFile(new URL("../lib/credit-principal-payment-storage.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: name => {
    if (name === "server-only") return {};
    if (name === "node:crypto") return crypto;
    throw new Error(`Unexpected dependency ${name}`);
  }, Date });
  return mod.exports;
}

test("isolated native PostgreSQL: principal revision migration, immutability, transactions and concurrent idempotency", {
  skip: !enabled && "Opt-in CAPITAL_NATIVE_PG_TEST=1: creates and stops a new loopback-only cluster, never accesses existing databases.",
  timeout: 90000,
}, async context => {
  await access(path.join(binaryDirectory, process.platform === "win32" ? "initdb.exe" : "initdb"));
  const directory = await mkdtemp(path.join(root, "tmp-capital-pg-"));
  const dataDirectory = path.join(directory, "data");
  const port = await unusedPort();
  const clients = [];
  const pending = [];
  const gates = [];
  let startAttempted = false;
  try {
    await command("initdb", ["-D", dataDirectory, "--username=capital_test", "--auth-host=trust", "--auth-local=trust", "--no-locale", "--encoding=UTF8"]);
    startAttempted = true;
    await command("pg_ctl", ["-D", dataDirectory, "-l", path.join(directory, "server.log"), "-w", "-t", "20", "-o", `-h 127.0.0.1 -p ${port} -c fsync=off -c synchronous_commit=off`, "start"]);
    for (let index = 0; index < 3; index++) {
      const client = new pg.Client({ host: "127.0.0.1", port, user: "capital_test", password: "", database: "postgres", ssl: false, options: "", application_name: `isolated_capital_${index}`, connectionTimeoutMillis: 5000 });
      await client.connect(); clients.push(client);
      await client.query("SET statement_timeout='15s'");
      await client.query("SET lock_timeout='10s'");
    }
    const [writer, retry, observer] = clients;
    const { persistPrincipalPaymentRevision, findPrincipalPaymentRevision } = await storageModule();
    await writer.query(`
      CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "montoCredito" NUMERIC(20,2) NOT NULL DEFAULT 10000000);
      CREATE TABLE "CreditoAbono" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id"), "valor" NUMERIC(20,2) NOT NULL);
      CREATE TABLE "CajaMovimiento" ("id" SERIAL PRIMARY KEY, "valor" NUMERIC(20,2) NOT NULL);
      INSERT INTO "Usuario" VALUES (1);
      INSERT INTO "Credito" ("id") VALUES (1),(2),(3),(4);
      INSERT INTO "CreditoAbono" ("creditoId","valor") VALUES (1,700000),(1,100000),(1,100000),(2,700000);
    `);
    await installCreditPrincipalPaymentSchema(writer);
    await installCreditPrincipalPaymentSchema(writer);
    assert.equal((await writer.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='public' AND table_name='Credito' AND column_name='planCapitalVigente'`)).rows[0].count, 1);
    assert.equal((await writer.query(`SELECT count(*)::int AS count FROM pg_trigger WHERE tgrelid='"CreditPrincipalPaymentRevision"'::regclass AND NOT tgisinternal`)).rows[0].count, 2);
    context.diagnostic("Migration executed twice successfully; nullable live plan and both audit triggers exist once.");

    const revision = overrides => ({
      creditoId: 1, abonoId: 1, revision: 1, idempotencyKey: "isolated-capital-request-1",
      requestHash: "a".repeat(64), previewHash: "b".repeat(64), snapshotBefore: null,
      snapshotAfter: { version: "CAPITAL_REDUCCION_PLAZO_V1", revision: 1 },
      conciliacion: { fuente: "Synthetic isolated test" }, resultado: { ok: true, abonoId: 1 }, usuarioId: 1,
      ...overrides,
    });
    const write = overrides => persistPrincipalPaymentRevision(dbAdapter(writer), revision(overrides));
    await write();
    assert.equal((await findPrincipalPaymentRevision(dbAdapter(writer), 1, "isolated-capital-request-1")).resultado.abonoId, 1);
    await assert.rejects(write({ creditoId: 999, abonoId: 2 }), { code: "23503" });
    await assert.rejects(write({ abonoId: 999, revision: 2, idempotencyKey: "isolated-capital-request-2" }), { code: "23503" });
    await assert.rejects(write({ usuarioId: 999, abonoId: 2, revision: 2, idempotencyKey: "isolated-capital-request-2" }), { code: "23503" });
    await assert.rejects(write({ abonoId: 2, revision: 2 }), { code: "23505" });
    await assert.rejects(write({ abonoId: 2, idempotencyKey: "isolated-capital-request-2" }), { code: "23505" });
    await assert.rejects(write({ revision: 2, idempotencyKey: "isolated-capital-request-2" }), { code: "23505" });
    await write({ creditoId: 2, abonoId: 4 });
    context.diagnostic("Credit, receipt and user foreign keys; unique receipt, credit/request and credit/revision verified; request key may be reused only on another credit.");

    await assert.rejects(writer.query(`UPDATE "CreditPrincipalPaymentRevision" SET "resultado"='{}'`), { code: "P0001" });
    await assert.rejects(writer.query(`DELETE FROM "CreditPrincipalPaymentRevision"`), { code: "P0001" });
    await assert.rejects(writer.query(`TRUNCATE "CreditPrincipalPaymentRevision"`), { code: "P0001" });
    await assert.rejects(writer.query(`DELETE FROM "CreditoAbono" WHERE "id"=1`), error =>
      ["23001", "23503"].includes(error.code) && error.constraint === "CreditPrincipalPaymentRevision_abonoId_fkey");
    assert.equal((await writer.query(`SELECT count(*)::int AS count FROM "CreditPrincipalPaymentRevision"`)).rows[0].count, 2);
    context.diagnostic("Real UPDATE, DELETE and TRUNCATE rejected by append-only triggers; linked receipt deletion rejected by FK.");

    const counts = async () => (await observer.query(`SELECT
      (SELECT count(*)::int FROM "CreditoAbono") AS receipts,
      (SELECT count(*)::int FROM "CajaMovimiento") AS cash,
      (SELECT count(*)::int FROM "CreditPrincipalPaymentRevision") AS revisions,
      (SELECT "montoCredito"::text FROM "Credito" WHERE "id"=1) AS amount`)).rows[0];
    const before = await counts();
    await writer.query("BEGIN");
    await writer.query(`SELECT "id" FROM "Credito" WHERE "id"=1 FOR UPDATE`);
    const paymentId = (await writer.query(`INSERT INTO "CreditoAbono" ("creditoId","valor") VALUES (1,700000) RETURNING "id"`)).rows[0].id;
    await writer.query(`INSERT INTO "CajaMovimiento" ("valor") VALUES (700000)`);
    await writer.query(`UPDATE "Credito" SET "montoCredito"=1, "planCapitalVigente"='{"revision":2}' WHERE "id"=1`);
    await assert.rejects(write({ abonoId: paymentId, revision: 2 }), { code: "23505" });
    await writer.query("ROLLBACK");
    assert.deepEqual(await counts(), before);
    assert.equal((await observer.query(`SELECT "planCapitalVigente" FROM "Credito" WHERE "id"=1`)).rows[0].planCapitalVigente, null);
    context.diagnostic("An audit uniqueness failure rolled back payment, cash movement, balance and live plan together.");

    const writerPid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const retryPid = (await retry.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const acquired = deferred();
    const release = deferred(); gates.push(release);
    const confirm = async (client, hold) => {
      await client.query("BEGIN");
      try {
        await client.query(`SELECT "id" FROM "Credito" WHERE "id"=3 FOR UPDATE`);
        if (hold) { acquired.resolve(); await release.promise; }
        const existing = await findPrincipalPaymentRevision(dbAdapter(client), 3, "isolated-concurrent-request");
        if (existing) { await client.query("COMMIT"); return { replay: true, id: existing.resultado.abonoId }; }
        const id = (await client.query(`INSERT INTO "CreditoAbono" ("creditoId","valor") VALUES (3,700000) RETURNING "id"`)).rows[0].id;
        await client.query(`INSERT INTO "CajaMovimiento" ("valor") VALUES (700000)`);
        await client.query(`UPDATE "Credito" SET "montoCredito"=9300000,"planCapitalVigente"='{"revision":1}' WHERE "id"=3`);
        await persistPrincipalPaymentRevision(dbAdapter(client), revision({ creditoId: 3, abonoId: id, idempotencyKey: "isolated-concurrent-request", resultado: { ok: true, abonoId: id } }));
        await client.query("COMMIT");
        return { replay: false, id };
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    };
    const first = confirm(writer, true); first.catch(() => {}); pending.push(first);
    await acquired.promise;
    const second = confirm(retry, false); second.catch(() => {}); pending.push(second);
    await waitForBlocked(observer, retryPid, writerPid);
    release.resolve();
    const results = await Promise.all([first, second]);
    assert.equal(results[0].id, results[1].id);
    assert.equal(results[0].replay, false); assert.equal(results[1].replay, true);
    assert.equal((await observer.query(`SELECT count(*)::int AS count FROM "CreditoAbono" WHERE "creditoId"=3`)).rows[0].count, 1);
    assert.equal((await observer.query(`SELECT count(*)::int AS count FROM "CajaMovimiento"`)).rows[0].count, 1);
    context.diagnostic("Concurrent confirmations serialized on the credit row; retry replayed the single committed receipt, with only one cash entry.");
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(pending);
    await Promise.allSettled(clients.map(client => client.query("ROLLBACK")));
    await Promise.allSettled(clients.map(client => client.end()));
    if (startAttempted) await command("pg_ctl", ["-D", dataDirectory, "-w", "-t", "20", "-m", "fast", "stop"]);
    context.diagnostic(`New isolated cluster stopped. Recoverable test artifacts: ${directory}`);
  }
});
