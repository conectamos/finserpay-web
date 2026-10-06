import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { appendApprovalAnalystAccountEvent } from "../lib/approval-analyst-account-audit.ts";
import {
  approvalAnalystAccountAuditSchemaStatements,
  installApprovalAnalystAccountAuditSchema,
} from "../scripts/approval-analyst-account-audit-schema.mjs";

test("el instalador de auditoría usa una transacción, lock e incluye todas las sentencias", async () => {
  const queries = [];
  await installApprovalAnalystAccountAuditSchema({ query: async (sql) => { queries.push(sql); } });
  assert.equal(queries[0], "BEGIN");
  assert.match(queries[3], /pg_advisory_xact_lock/);
  assert.deepEqual(queries.slice(4, -1), approvalAnalystAccountAuditSchemaStatements);
  assert.equal(queries.at(-1), "COMMIT");
});

test("el instalador revierte una preparación parcial", async () => {
  const queries = [];
  const failure = new Error("fallo sintético de esquema");
  await assert.rejects(installApprovalAnalystAccountAuditSchema({ query: async (sql) => {
    queries.push(sql);
    if (sql === approvalAnalystAccountAuditSchemaStatements[2]) throw failure;
  } }), failure);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
});

test("PostgreSQL: la auditoría valida actor y cuenta, es append-only y acompaña la mutación", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY,"nombre" TEXT NOT NULL);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"activo" BOOLEAN NOT NULL DEFAULT TRUE);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER REFERENCES "Aliado"("id"));
    CREATE TABLE "Usuario" (
      "id" INTEGER PRIMARY KEY,"nombre" TEXT NOT NULL,"usuario" TEXT NOT NULL,"activo" BOOLEAN NOT NULL,
      "rolId" INTEGER NOT NULL REFERENCES "Rol"("id"),"sedeId" INTEGER NOT NULL REFERENCES "Sede"("id")
    );
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES (1,'FINSERPAY',TRUE),(2,'EXTERNO',TRUE);
    INSERT INTO "Sede" VALUES (1,1),(2,2);
    INSERT INTO "Usuario" VALUES
      (1,'Admin central','admin.central',TRUE,1,1),
      (2,'Admin externo','admin.externo',TRUE,1,2),
      (3,'Admin inactivo','admin.inactivo',FALSE,1,1),
      (7,'Analista central','analista.central',TRUE,2,1),
      (8,'Analista externo','analista.externo',TRUE,2,2),
      (9,'Otro admin','otro.admin',TRUE,1,1);
  `);
  const client = {
    async query(sql, params = []) {
      const result = await database.query(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
  };
  const adapter = (connection) => ({
    $executeRawUnsafe: async (sql, ...params) => (await connection.query(sql, params)).affectedRows,
  });

  await installApprovalAnalystAccountAuditSchema(client);
  await appendApprovalAnalystAccountEvent(adapter(database), {
    analystUserId: 7, actorUserId: 1, eventType: "CREATED", accountActive: true,
  });
  await installApprovalAnalystAccountAuditSchema(client);
  assert.equal((await database.query('SELECT COUNT(*)::integer AS count FROM "ApprovalAnalystAccountEvent"')).rows[0].count, 1);

  for (const event of [
    { analystUserId: 7, actorUserId: 2, eventType: "PASSWORD_RESET", accountActive: null },
    { analystUserId: 7, actorUserId: 3, eventType: "PASSWORD_RESET", accountActive: null },
    { analystUserId: 8, actorUserId: 1, eventType: "PASSWORD_RESET", accountActive: null },
    { analystUserId: 9, actorUserId: 1, eventType: "PASSWORD_RESET", accountActive: null },
  ]) {
    await assert.rejects(appendApprovalAnalystAccountEvent(adapter(database), event), (error) => error.code === "23514");
  }

  await assert.rejects(database.query(
    'INSERT INTO "ApprovalAnalystAccountEvent" ("analystUserId","actorUserId","eventType","accountActive") VALUES (7,1,\'PASSWORD_RESET\',TRUE)'
  ), (error) => error.code === "23514");

  await assert.rejects(database.transaction(async (tx) => {
    await tx.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=7');
    await appendApprovalAnalystAccountEvent(adapter(tx), {
      analystUserId: 7, actorUserId: 2, eventType: "DEACTIVATED", accountActive: false,
    });
  }));
  assert.equal((await database.query('SELECT "activo" FROM "Usuario" WHERE "id"=7')).rows[0].activo, true);

  await database.transaction(async (tx) => {
    await tx.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=7');
    await appendApprovalAnalystAccountEvent(adapter(tx), {
      analystUserId: 7, actorUserId: 1, eventType: "DEACTIVATED", accountActive: false,
    });
  });
  assert.equal((await database.query('SELECT "activo" FROM "Usuario" WHERE "id"=7')).rows[0].activo, false);
  assert.deepEqual(
    (await database.query('SELECT "eventType","accountActive" FROM "ApprovalAnalystAccountEvent" ORDER BY "id"')).rows,
    [
      { eventType: "CREATED", accountActive: true },
      { eventType: "DEACTIVATED", accountActive: false },
    ]
  );

  await assert.rejects(database.query('UPDATE "ApprovalAnalystAccountEvent" SET "eventType"=\'ACTIVATED\' WHERE "id"=1'), /IMMUTABLE/);
  await assert.rejects(database.query('DELETE FROM "ApprovalAnalystAccountEvent" WHERE "id"=1'), /IMMUTABLE/);
  await assert.rejects(database.query('TRUNCATE "ApprovalAnalystAccountEvent"'), /IMMUTABLE/);

  const columns = (await database.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='ApprovalAnalystAccountEvent' ORDER BY ordinal_position`)).rows
    .map(({ column_name }) => column_name);
  assert.deepEqual(columns, ["id", "analystUserId", "actorUserId", "eventType", "accountActive", "createdAt"]);
});
