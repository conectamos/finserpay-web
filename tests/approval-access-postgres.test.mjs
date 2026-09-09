import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { installApprovalAccessSchema } from "../scripts/approval-access-schema.mjs";

const connectionString = process.env.APPROVAL_ACCESS_TEST_DATABASE_URL;
test("PostgreSQL aislado: enlaces personales, unicidad, revocacion y migracion repetible", {
  skip: connectionString ? false : "Falta APPROVAL_ACCESS_TEST_DATABASE_URL; requiere base local approval_access_test.",
}, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Solo PostgreSQL local aislado");
  assert.equal(url.pathname, "/approval_access_test", "Base exclusiva de fixtures");
  const db = new pg.Client({ connectionString });
  await db.connect();
  t.after(async () => { await db.end(); });
  const fixtureTables = ["CreditApprovalAccessLink", "Usuario", "CreditApprovalPolicy"];
  const existing = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({ tablename }) => fixtureTables.includes(tablename)),
    "La base contiene tablas ajenas: no se permite reiniciar fixtures");
  for (const table of fixtureTables) await db.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
  await db.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1),(2),(3),(4),(5);
    CREATE TABLE "CreditApprovalPolicy" ("id" INTEGER PRIMARY KEY, "activatedAt" TIMESTAMP(3));
    INSERT INTO "CreditApprovalPolicy" VALUES (1, '2020-01-01T00:00:00');
  `);
  const activation = async () => (await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy" WHERE "id"=1')).rows[0].activatedAt;
  const beforeActivation = await activation();
  const insert = (userId, issuer = 1, id = randomUUID(), version = "credential-v1") =>
    db.query(`INSERT INTO "CreditApprovalAccessLink"
      ("userId", "id", "credentialVersion", "issuedByUserId") VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, id, version, issuer]);
  const stored = async (userId) => (await db.query('SELECT * FROM "CreditApprovalAccessLink" WHERE "userId"=$1', [userId])).rows[0];

  await t.test("instala sin crear enlaces ni modificar corte existente", async () => {
    await installApprovalAccessSchema(db);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "CreditApprovalAccessLink"')).rows[0].n, 0);
    assert.equal(await activation(), beforeActivation);
  });
  await t.test("una fila por cuenta y un identificador globalmente unico", async () => {
    const id = randomUUID();
    await insert(2, 1, id);
    await assert.rejects(insert(2), { code: "23505" });
    await assert.rejects(insert(3, 1, id), { code: "23505" });
    assert.equal((await stored(2)).id, id);
  });
  await t.test("FK valida propietario y emisor y conserva registros referenciados", async () => {
    await assert.rejects(insert(999), { code: "23503" });
    await assert.rejects(insert(3, 999), { code: "23503" });
    await assert.rejects(db.query('DELETE FROM "Usuario" WHERE "id"=2'), error =>
      ["23001", "23503"].includes(error.code) && error.constraint === "CreditApprovalAccessLink_userId_fkey");
    await assert.rejects(db.query('DELETE FROM "Usuario" WHERE "id"=1'), error =>
      ["23001", "23503"].includes(error.code) && error.constraint === "CreditApprovalAccessLink_issuedByUserId_fkey");
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "Usuario" WHERE "id" IN (1,2)')).rows[0].n, 2);
  });
  await t.test("version de credenciales requiere valor no vacio de hasta64 caracteres", async () => {
    for (const value of ["", "   "]) await assert.rejects(insert(3, 1, randomUUID(), value), { code: "23514" });
    await assert.rejects(insert(3, 1, randomUUID(), "a".repeat(65)), { code: "22001" });
    await assert.rejects(insert(3, 1, randomUUID(), null), { code: "23502" });
  });
  await t.test("rotacion sustituye generacion y revocacion persiste en reinstalaciones", async () => {
    const old = await stored(2);
    const replacement = randomUUID();
    await db.query(`UPDATE "CreditApprovalAccessLink"
      SET "id"=$2, "credentialVersion"='credential-v2', "createdAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',
        "revokedAt"=NULL WHERE "userId"=$1`, [2, replacement]);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "CreditApprovalAccessLink" WHERE "id"=$1', [old.id])).rows[0].n, 0);
    assert.equal((await stored(2)).id, replacement);
    await db.query(`UPDATE "CreditApprovalAccessLink" SET "revokedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "userId"=2`);
    const before = await stored(2);
    await installApprovalAccessSchema(db);
    await installApprovalAccessSchema(db);
    assert.deepEqual(await stored(2), before);
    assert.equal(await activation(), beforeActivation);
    const columns = (await db.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='CreditApprovalAccessLink' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
    assert.deepEqual(columns, ["userId", "id", "credentialVersion", "issuedByUserId", "createdAt", "revokedAt"]);
  });
  await t.test("Prisma-first recibe checks y default UTC incluso con TimeZone America/Bogota", async () => {
    await db.query('DROP TABLE "CreditApprovalAccessLink"');
    await db.query(`CREATE TABLE "CreditApprovalAccessLink" (
      "userId" INTEGER NOT NULL, "id" UUID NOT NULL, "credentialVersion" VARCHAR(64) NOT NULL,
      "issuedByUserId" INTEGER NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "revokedAt" TIMESTAMP(3),
      CONSTRAINT "CreditApprovalAccessLink_pkey" PRIMARY KEY ("userId"),
      CONSTRAINT "CreditApprovalAccessLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT "CreditApprovalAccessLink_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX "CreditApprovalAccessLink_id_key" ON "CreditApprovalAccessLink"("id")`);
    await db.query("SET TIME ZONE 'America/Bogota'");
    try {
      await installApprovalAccessSchema(db);
      await assert.rejects(insert(3, 1, randomUUID(), " "), { code: "23514" });
      await insert(3);
      const result = await db.query(`SELECT ABS(EXTRACT(EPOCH FROM
        ("createdAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))) < 3 AS utc
        FROM "CreditApprovalAccessLink" WHERE "userId"=3`);
      assert.equal(result.rows[0].utc, true);
      assert.equal(await activation(), beforeActivation);
    } finally { await db.query("SET TIME ZONE 'UTC'"); }
  });
  await t.test("esquema incompatible aborta sin borrar enlaces", async () => {
    const before = await stored(3);
    await db.query('ALTER TABLE "CreditApprovalAccessLink" ALTER COLUMN "credentialVersion" DROP NOT NULL');
    await assert.rejects(installApprovalAccessSchema(db), /APPROVAL_ACCESS_SCHEMA_INCOMPATIBLE/);
    assert.deepEqual(await stored(3), before);
    await db.query('ALTER TABLE "CreditApprovalAccessLink" ALTER COLUMN "credentialVersion" SET NOT NULL');
    await installApprovalAccessSchema(db);
  });
});
