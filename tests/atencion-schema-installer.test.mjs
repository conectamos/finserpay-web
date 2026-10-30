import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

const installerUrl = new URL("../scripts/ensure-atencion-schema.mjs", import.meta.url);
const sqlUrl = new URL("../scripts/setup-atencion.sql", import.meta.url);
const source = (await readFile(installerUrl, "utf8")).replace(/^import .+;\r?\n/gm, "").replaceAll("import.meta.url", "scriptUrl");
const run = new (Object.getPrototypeOf(async function() {}).constructor)("readFile", "pg", "console", "process", "scriptUrl", source);
const setupSql = await readFile(sqlUrl, "utf8");

async function fixture(t, overrides = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec('CREATE TABLE public."Sede"(id integer PRIMARY KEY); CREATE TABLE public."Usuario"(id integer PRIMARY KEY); CREATE TABLE public."Vendedor"(id integer PRIMARY KEY); CREATE TABLE public."Credito"(id integer PRIMARY KEY)');
  const calls = []; const logs = []; const metadataFields = []; let ended = false;
  class Client {
    async connect() { calls.push("connect"); }
    async query(sql, values) {
      calls.push(sql);
      // PGlite is single-process; test lock ordering, and delegate all schema/metadata
      // operations to real PostgreSQL execution instead of mocking their results.
      if (sql.startsWith("SELECT pg_advisory_lock(")) return { rows: [] };
      if (sql === setupSql) {
        await database.exec(sql);
        if (overrides.afterSql) await overrides.afterSql(database);
        return { rows: [] };
      }
      const result = await database.query(sql, values);
      if (sql.includes("FROM pg_catalog.pg_constraint c")) {
        metadataFields.push(result.fields);
        if (overrides.nodePgArrays) {
          for (const field of result.fields.filter(field => ["columns", "foreignColumns"].includes(field.name))) {
            const parser = pg.types.getTypeParser(field.dataTypeID, "text");
            for (const row of result.rows) {
              const wireValue = `{${row[field.name].map(value => JSON.stringify(value)).join(",")}}`;
              row[field.name] = parser(wireValue);
            }
          }
        }
      }
      return result;
    }
    async end() { ended = true; }
  }
  return { database, calls, logs, metadataFields, ended: () => ended,
    install: () => run(readFile, { Client }, { log: message => logs.push(message) },
      { env: { DATABASE_URL: "postgresql://test-only:no-network@example.invalid/database" } }, installerUrl.href) };
}

test("instalación aditiva verifica siete tablas y se puede repetir sin pérdida de datos", async t => {
  const { database, install, calls, logs, ended } = await fixture(t);
  await install();
  await database.query(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES('user:1','00000000-0000-4000-8000-000000000001','retained')`);
  await install();
  assert.equal((await database.query('SELECT fingerprint FROM "AttentionRequest"')).rows[0].fingerprint, "retained");
  assert.ok(calls.findIndex(sql => sql.startsWith("SELECT pg_advisory_lock(")) < calls.indexOf(setupSql));
  assert.ok(logs.every(message => message.includes("7 tablas") && message.includes("auditoría inmutable")));
  assert.ok(ended());
});

test("schema previo incompatible se rechaza antes de aplicar SQL y sin tocar la tabla", async t => {
  const { database, install, calls, logs, ended } = await fixture(t);
  await database.exec('CREATE TABLE "AttentionConversation"(id text PRIMARY KEY); INSERT INTO "AttentionConversation" VALUES(\'conservar\')');
  await assert.rejects(install(), /AttentionConversation\.id/);
  assert.ok(!calls.includes(setupSql)); assert.deepEqual(logs, []); assert.ok(ended());
  assert.equal((await database.query('SELECT id FROM "AttentionConversation"')).rows[0].id, "conservar");
  assert.equal((await database.query(`SELECT to_regclass('public."AttentionMessage"') AS table_name`)).rows[0].table_name, null);
});

test("actualización permite solo las dos columnas aditivas previstas y rechaza claves ausentes", async t => {
  const { database, install } = await fixture(t);
  await database.exec(setupSql);
  await database.exec('ALTER TABLE "AttentionConversation" DROP COLUMN "closedAt", DROP COLUMN "daptaMessagesCursor"');
  await install();
  const columns = (await database.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='AttentionConversation'`)).rows.map(row => row.column_name);
  assert.ok(columns.includes("closedAt")); assert.ok(columns.includes("daptaMessagesCursor"));
  await database.exec('ALTER TABLE "AttentionMessage" DROP CONSTRAINT "AttentionMessage_conversationId_externalId_key"');
  await assert.rejects(install(), /AttentionMessage\.EXTERNAL_ID_UNIQUE/);
});

test("postverificación rechaza auditoría desactivada en lugar de anunciar éxito", async t => {
  const { install, logs, ended } = await fixture(t, { afterSql: database => database.exec('ALTER TABLE "AttentionAudit" DISABLE TRIGGER attention_audit_immutable') });
  await assert.rejects(install(), /AttentionAudit\.APPEND_ONLY_TRIGGER/);
  assert.deepEqual(logs, []); assert.ok(ended());
});

test("SQL instala en public aunque el rol tenga un esquema de búsqueda distinto", async t => {
  const { database, install } = await fixture(t);
  await database.exec('CREATE SCHEMA tenant; SET search_path=tenant,public');
  await install();
  const rows = (await database.query(`SELECT table_schema FROM information_schema.tables WHERE table_name='AttentionConversation'`)).rows;
  assert.deepEqual(rows, [{ table_schema: "public" }]);
});

test("metadatos usan text[] OID1009 y se verifican con los parsers reales de node-pg", async t => {
  const { install, metadataFields } = await fixture(t, { nodePgArrays: true });
  // Unlike PGlite, node-pg leaves the catalog's name[] (1003) as a raw string.
  assert.equal(typeof pg.types.getTypeParser(1003, "text")('{"id"}'), "string");
  assert.deepEqual(pg.types.getTypeParser(1009, "text")('{"id"}'), ["id"]);
  await install();
  await install();
  assert.equal(metadataFields.length, 4, "preflight y postcheck de ambas ejecuciones");
  for (const fields of metadataFields) {
    for (const name of ["columns", "foreignColumns"]) assert.equal(fields.find(field => field.name === name)?.dataTypeID, 1009, name);
  }
});
