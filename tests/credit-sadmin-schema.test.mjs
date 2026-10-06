import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { creditApprovalSchemaStatements } from "../scripts/credit-approval-schema.mjs";
import { creditSadminSchemaStatements, installCreditSadminSchema } from "../scripts/credit-sadmin-schema.mjs";

test("SADMIN installer executes the entire schema under a transaction and advisory lock", async () => {
  const queries = [];
  await installCreditSadminSchema({ query: async statement => { queries.push(statement); } });
  assert.equal(queries[0], "BEGIN");
  assert.match(queries[3], /pg_advisory_xact_lock/);
  assert.deepEqual(queries.slice(4, -1), creditSadminSchemaStatements);
  assert.equal(queries.at(-1), "COMMIT");
});

test("SADMIN installer rolls back every partial schema change on error", async () => {
  const queries = [];
  const failure = new Error("synthetic migration failure");
  await assert.rejects(installCreditSadminSchema({ query: async statement => {
    queries.push(statement);
    if (statement === creditSadminSchemaStatements[4]) throw failure;
  } }), failure);
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.includes("COMMIT"), false);
});

test("PGlite instala SADMIN dos veces, migra históricos y conserva constraints e historial inmutable", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1);
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY,
      "fechaCredito" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "estado" TEXT NOT NULL DEFAULT 'INSCRITO'
    );
    INSERT INTO "Credito" ("id") SELECT generate_series(1,12);
    CREATE TABLE "CreditApprovalSharedSession" (
      "id" UUID PRIMARY KEY,
      "grantId" UUID NOT NULL,
      UNIQUE ("id","grantId")
    );
  `);
  const immutableFunction = creditApprovalSchemaStatements.find(statement =>
    statement.includes("CREATE OR REPLACE FUNCTION public.credit_approval_reject_history_mutation()"));
  assert.ok(immutableFunction);
  await db.query(immutableFunction);

  // Simula la tabla creada por Prisma antes de que predeploy agregue backfill,
  // llaves, checks, índices y triggers.
  for (const statement of creditSadminSchemaStatements.filter(statement => statement.startsWith("CREATE TABLE"))) {
    await db.query(statement);
  }
  await db.query(`INSERT INTO "CreditSadminRegistration"
    ("creditoId","codeudorCreado","creditoCreado","numeroCreditoConfirmado","numeroCredito","completedAt")
    VALUES (1,TRUE,TRUE,TRUE,'LEGACY-SA-001','2026-10-06T15:00:00Z')`);

  await installCreditSadminSchema(db);
  const migrated = (await db.query('SELECT * FROM "CreditSadminRegistration" WHERE "creditoId"=1')).rows[0];
  assert.equal(migrated.estadoCreacion, "CREADO_CORRECTAMENTE");
  assert.equal(migrated.motivoEstado, null);

  await db.query(`INSERT INTO "CreditSadminRegistration" ("creditoId","estadoCreacion","motivoEstado")
    VALUES (2,'ERROR_CREACION','SADMIN rechazó el alta')`);
  const eventId = randomUUID();
  await db.query(`INSERT INTO "CreditSadminEvent"
    ("id","creditoId","version","actorKind","actorUserId","actorName","payload")
    VALUES ($1,2,1,'USER',1,'Analista QA','{"resultado":"ERROR_CREACION"}'::jsonb)`, [eventId]);

  const snapshot = async () => ({
    registrations: (await db.query('SELECT to_jsonb(row) AS data FROM "CreditSadminRegistration" row ORDER BY "creditoId"')).rows,
    events: (await db.query('SELECT to_jsonb(row) AS data FROM "CreditSadminEvent" row ORDER BY "creditoId","version"')).rows,
  });
  const beforeReinstall = await snapshot();
  await installCreditSadminSchema(db);
  assert.deepEqual(await snapshot(), beforeReinstall, "reinstalar no reescribe registros ni eventos");

  const checkViolation = error => error.code === "23514";
  for (const sql of [
    `INSERT INTO "CreditSadminRegistration" ("creditoId","estadoCreacion") VALUES (3,'DESCONOCIDO')`,
    `INSERT INTO "CreditSadminRegistration" ("creditoId","estadoCreacion") VALUES (4,'ERROR_CREACION')`,
    `INSERT INTO "CreditSadminRegistration" ("creditoId","estadoCreacion","motivoEstado") VALUES (5,'PENDIENTE_CREAR','No permitido')`,
    `INSERT INTO "CreditSadminRegistration" ("creditoId","estadoCreacion") VALUES (6,'CREADO_CORRECTAMENTE')`,
    `INSERT INTO "CreditSadminRegistration" ("creditoId","numeroCreditoConfirmado") VALUES (7,TRUE)`,
  ]) await assert.rejects(db.query(sql), checkViolation);
  await assert.rejects(
    db.query(`INSERT INTO "CreditSadminRegistration" ("creditoId","numeroCredito") VALUES (8,'legacy-sa-001')`),
    error => error.code === "23505",
  );

  for (const mutation of [
    `UPDATE "CreditSadminEvent" SET "payload"='{}'::jsonb WHERE "id"='${eventId}'`,
    `DELETE FROM "CreditSadminEvent" WHERE "id"='${eventId}'`,
    `TRUNCATE "CreditSadminEvent"`,
  ]) await assert.rejects(db.query(mutation), error => error.code === "23514" && /CREDIT_APPROVAL_HISTORY_IMMUTABLE/.test(error.message));
  assert.equal((await db.query('SELECT COUNT(*)::integer AS count FROM "CreditSadminEvent"')).rows[0].count, 1);
});
