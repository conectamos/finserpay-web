import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { creditApprovalSchemaStatements } from "../scripts/credit-approval-schema.mjs";
import { creditSadminSchemaStatements, installCreditSadminSchema } from "../scripts/credit-sadmin-schema.mjs";

const connectionString = process.env.CREDIT_SADMIN_SCHEMA_TEST_DATABASE_URL;

test("PostgreSQL aislado: SADMIN conserva checklist, números únicos e historial verificable", {
  skip: connectionString ? false : "Requiere CREDIT_SADMIN_SCHEMA_TEST_DATABASE_URL local sadmin_test",
}, async t => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Solo PostgreSQL local aislado");
  assert.equal(url.pathname, "/sadmin_test", "Base exclusiva de fixtures SADMIN");
  const db = new pg.Client({ connectionString });
  await db.connect();
  t.after(async () => { await db.end(); });
  const tables = ["CreditSadminEvent", "CreditSadminRegistration", "CreditApprovalSharedSession", "Credito", "Usuario"];
  const existing = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({ tablename }) => tables.includes(tablename)), "No se permite borrar tablas ajenas al fixture");
  for (const table of tables) await db.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
  await db.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1),(2);
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY,"fechaCredito" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"estado" TEXT NOT NULL DEFAULT 'INSCRITO');
    INSERT INTO "Credito" ("id") SELECT generate_series(1,100);
    CREATE TABLE "CreditApprovalSharedSession" ("id" UUID PRIMARY KEY,"grantId" UUID NOT NULL,UNIQUE("id","grantId"));
    SET TIME ZONE 'America/Bogota';
  `);
  await db.query(creditApprovalSchemaStatements.find(statement => statement.includes("CREATE OR REPLACE FUNCTION public.credit_approval_reject_history_mutation()")));

  // Emulate Prisma creating the new tables before predeploy adds checks and indexes.
  for (const statement of creditSadminSchemaStatements.filter(statement => statement.startsWith("CREATE TABLE"))) await db.query(statement);
  await db.query('INSERT INTO "CreditSadminRegistration" ("creditoId") VALUES (1)');
  await installCreditSadminSchema(db);

  const read = async id => (await db.query('SELECT to_jsonb(r) AS row FROM "CreditSadminRegistration" r WHERE "creditoId"=$1', [id])).rows[0]?.row;
  const registration = (id, values = {}) => {
    const data = { creditoId: id, ...values };
    const fields = Object.keys(data);
    return db.query('INSERT INTO "CreditSadminRegistration" (' + fields.map(field => '"' + field + '"').join(",") + ') VALUES (' + fields.map((_, index) => '$' + (index + 1)).join(",") + ')', Object.values(data));
  };
  const event = (creditId, values = {}) => {
    const data = { id: randomUUID(), creditoId: creditId, version: 1, actorKind: "USER", actorUserId: 1, actorName: "Analista sintético", payload: { changed: true }, ...values };
    const fields = Object.keys(data);
    return db.query('INSERT INTO "CreditSadminEvent" (' + fields.map(field => '"' + field + '"').join(",") + ') VALUES (' + fields.map((_, index) => '$' + (index + 1)).join(",") + ') RETURNING *', Object.values(data));
  };
  const failsCheck = error => error.code === "23514";

  await t.test("defaults are pending; UTC timestamps do not depend on session timezone", async () => {
    const row = await read(1);
    assert.equal(row.version, 1);
    assert.equal(row.codeudorCreado, false);
    assert.equal(row.creditoCreado, false);
    assert.equal(row.numeroCreditoConfirmado, false);
    assert.equal(row.numeroCredito, null);
    assert.equal(row.completedAt, null);
    const time = await db.query(`SELECT ABS(EXTRACT(EPOCH FROM ((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-"createdAt"))) AS seconds
      FROM "CreditSadminRegistration" WHERE "creditoId"=1`);
    assert.ok(Number(time.rows[0].seconds) < 10);
    const index = await db.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='Credito_sadmin_date_id'");
    assert.equal(index.rowCount, 1);
    assert.match(index.rows[0].indexdef, /\("fechaCredito" DESC, id DESC\)/);
    for (const state of ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"]) assert.ok(index.rows[0].indexdef.includes(state));
  });

  await t.test("completion requires all three checks and a persisted number, in both directions", async () => {
    const complete = { codeudorCreado: true, creditoCreado: true, numeroCreditoConfirmado: true, numeroCredito: "SA-100", completedAt: "2026-09-17T10:00:00.000Z" };
    for (const missing of ["codeudorCreado", "creditoCreado", "numeroCreditoConfirmado"]) {
      await assert.rejects(registration(2, { ...complete, [missing]: false }), failsCheck);
    }
    await assert.rejects(registration(2, { ...complete, numeroCredito: null }), failsCheck);
    await assert.rejects(registration(2, { ...complete, completedAt: null }), failsCheck);
    await assert.rejects(registration(2, { numeroCreditoConfirmado: true }), failsCheck);
    await registration(2, complete);
    assert.equal((await read(2)).numeroCredito, "SA-100");
    await registration(3, { numeroCredito: "SA-101", codeudorCreado: true });
    assert.equal((await read(3)).completedAt, null);
  });

  await t.test("numbers are nonblank, trimmed, length-limited and case-insensitively unique", async () => {
    for (const numeroCredito of ["", " ", " SA-102", "SA-102 "]) {
      await assert.rejects(registration(4, { numeroCredito }), failsCheck);
    }
    await assert.rejects(registration(4, { numeroCredito: "sa-100" }), error => error.code === "23505");
    await assert.rejects(registration(4, { numeroCredito: "1".repeat(81) }), error => error.code === "22001");
    await registration(4, { numeroCredito: "1".repeat(80) });
    await registration(5);
    await registration(6);
  });

  await t.test("versions and credit/user relationships reject invalid records", async () => {
    await assert.rejects(registration(7, { version: 0 }), failsCheck);
    await assert.rejects(registration(999), error => error.code === "23503");
    await assert.rejects(event(7, { version: 0 }), failsCheck);
    await assert.rejects(event(999), error => error.code === "23503");
    await assert.rejects(event(7, { actorUserId: 999 }), error => error.code === "23503");
  });

  const grantA = randomUUID(), grantB = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
  await db.query('INSERT INTO "CreditApprovalSharedSession" ("id","grantId") VALUES ($1,$2),($3,$4)', [sessionA, grantA, sessionB, grantB]);
  const sharedActor = { actorKind: "SHARED_LINK", actorUserId: null, actorGrantId: grantA, actorSessionId: sessionA };
  let personalId, sharedId;

  await t.test("personal and shared actors preserve their distinct identity", async () => {
    personalId = (await event(1)).rows[0].id;
    const row = (await event(2, sharedActor)).rows[0];
    sharedId = row.id;
    assert.equal(row.actorUserId, null);
    assert.equal(row.actorGrantId, grantA);
    assert.equal(row.actorSessionId, sessionA);
    await assert.rejects(event(1), error => error.code === "23505");
  });

  await t.test("actor XOR, nonblank name and composite shared-session FK are enforced", async () => {
    for (const values of [
      { actorName: " " }, { actorKind: "UNKNOWN" }, { actorUserId: null },
      { ...sharedActor, actorUserId: 1 }, { ...sharedActor, actorGrantId: null },
      { ...sharedActor, actorSessionId: null },
    ]) await assert.rejects(event(7, values), failsCheck);
    for (const values of [
      { ...sharedActor, actorGrantId: grantB }, { ...sharedActor, actorSessionId: sessionB },
      { ...sharedActor, actorGrantId: randomUUID() }, { ...sharedActor, actorSessionId: randomUUID() },
    ]) await assert.rejects(event(7, values), error => error.code === "23503");
  });

  await t.test("events reject update, delete and truncate; linked credit/user/session cannot be deleted", async () => {
    await assert.rejects(db.query('UPDATE "CreditSadminEvent" SET "payload"=\'{}\' WHERE "id"=$1', [personalId]), /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
    await assert.rejects(db.query('DELETE FROM "CreditSadminEvent" WHERE "id"=$1', [sharedId]), /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
    for (const table of ["CreditSadminEvent", "CreditSadminRegistration"]) {
      await assert.rejects(db.query('TRUNCATE "' + table + '"'), /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
    }
    const restrictsDelete = error => ["23503", "23001"].includes(error.code);
    await assert.rejects(db.query('DELETE FROM "Credito" WHERE "id"=2'), restrictsDelete);
    await assert.rejects(db.query('DELETE FROM "Usuario" WHERE "id"=1'), restrictsDelete);
    await assert.rejects(db.query('DELETE FROM "CreditApprovalSharedSession" WHERE "id"=$1', [sessionA]), restrictsDelete);
  });

  await t.test("reinstall is idempotent and preserves existing registration, events and timestamps", async () => {
    const snapshot = async () => {
      const result = {};
      for (const table of tables) result[table] = (await db.query('SELECT to_jsonb(row) AS data FROM "' + table + '" row ORDER BY to_jsonb(row)::text')).rows;
      return result;
    };
    const before = await snapshot();
    await installCreditSadminSchema(db);
    await installCreditSadminSchema(db);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(registration(7, { numeroCredito: "sA-100" }), error => error.code === "23505");
    await assert.rejects(event(7, { actorUserId: null }), failsCheck);
    await assert.rejects(db.query('DELETE FROM "CreditSadminEvent" WHERE "id"=$1', [personalId]), /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
  });
});
