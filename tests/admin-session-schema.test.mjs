import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { ADMIN_SESSION_SCHEMA_SQL, installAdminSessionSchema } from "../scripts/admin-session-schema.mjs";

test("PostgreSQL: add marker without revoking existing accounts; rerun preserves revocation", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "Usuario" ("id" SERIAL PRIMARY KEY,"usuario" TEXT UNIQUE,"claveHash" TEXT);
    INSERT INTO "Usuario" ("usuario","claveHash") VALUES ('fixture-one','hash-one'),('fixture-two','hash-two')`);
  await installAdminSessionSchema(db);
  assert.deepEqual((await db.query('SELECT "id","usuario","claveHash","legacySessionRevokedAt" FROM "Usuario" ORDER BY "id"')).rows, [
    { id: 1, usuario: "fixture-one", claveHash: "hash-one", legacySessionRevokedAt: null },
    { id: 2, usuario: "fixture-two", claveHash: "hash-two", legacySessionRevokedAt: null },
  ]);
  await db.exec(`UPDATE "Usuario" SET "legacySessionRevokedAt"='2026-10-28 12:34:56.789' WHERE "id"=1`);
  await installAdminSessionSchema(db);
  const rows = (await db.query('SELECT "id","claveHash","legacySessionRevokedAt"::text AS "legacySessionRevokedAt" FROM "Usuario" ORDER BY "id"')).rows;
  assert.equal(rows[0].legacySessionRevokedAt, "2026-10-28 12:34:56.789");
  assert.equal(rows[0].claveHash, "hash-one");
  assert.equal(rows[1].legacySessionRevokedAt, null);
  assert.equal(rows[1].claveHash, "hash-two");
  await db.exec(`INSERT INTO "Usuario" ("usuario","claveHash") VALUES ('fixture-three','hash-three')`);
  assert.equal((await db.query('SELECT "legacySessionRevokedAt" FROM "Usuario" WHERE "id"=3')).rows[0].legacySessionRevokedAt, null);
});

test("PostgreSQL: incompatible existing marker fails and is never rewritten", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  for (const definition of ["TEXT", "TIMESTAMP(6)", "TIMESTAMPTZ(3)", "TIMESTAMP(3) NOT NULL", "TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP"]) {
    await db.exec(`CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY,"legacySessionRevokedAt" ${definition})`);
    const before = (await db.query(`SELECT data_type,is_nullable,column_default,datetime_precision
      FROM information_schema.columns WHERE table_schema='public' AND table_name='Usuario' AND column_name='legacySessionRevokedAt'`)).rows;
    await assert.rejects(installAdminSessionSchema(db), /Definición incompatible/);
    const after = (await db.query(`SELECT data_type,is_nullable,column_default,datetime_precision
      FROM information_schema.columns WHERE table_schema='public' AND table_name='Usuario' AND column_name='legacySessionRevokedAt'`)).rows;
    assert.deepEqual(after, before);
    await db.exec('DROP TABLE "Usuario"');
  }
});

test("installer uses a bounded transaction/advisory lock and rolls back failures", async () => {
  const queries = [];
  const failure = new Error("synthetic installer failure");
  await assert.rejects(installAdminSessionSchema({ query: async sql => {
    queries.push(sql);
    if (sql === ADMIN_SESSION_SCHEMA_SQL) throw failure;
    return { rows: [] };
  } }), failure);
  assert.deepEqual(queries.slice(0, 4), ["BEGIN", "SET LOCAL lock_timeout = '10s'", "SET LOCAL statement_timeout = '120s'",
    "SELECT pg_advisory_xact_lock(hashtext('finserpay-admin-session-schema'))"]);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
});

test("predeploy, final Docker image and Prisma carry the same additive marker", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(read("prisma/schema.prisma"), /legacySessionRevokedAt\s+DateTime\?\s+@db\.Timestamp\(3\)/);
  assert.match(read("scripts/railway-predeploy.mjs"), /await import\("\.\/ensure-admin-session-schema\.mjs"\)/);
  for (const file of ["admin-session-schema.mjs", "ensure-admin-session-schema.mjs"]) assert.ok(read("Dockerfile").includes(`/app/scripts/${file}`));
  const runner = read("scripts/ensure-admin-session-schema.mjs");
  assert.match(runner, /await installAdminSessionSchema\(client\)/);
  assert.match(runner, /connectionTimeoutMillis: 10_000/);
  assert.doesNotMatch(runner, /console\.(?:error|log)\([^\n]*\b(?:connectionString|error|process\.env)\b/);
});
