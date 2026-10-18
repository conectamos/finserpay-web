import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

function load(dependencies) {
  const loaded = { exports: {} };
  const source = readFileSync(new URL("../lib/mora-block-protection.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  runInNewContext(outputText, { module: loaded, exports: loaded.exports,
    require(name) { if (name === "server-only") return {}; assert.ok(name in dependencies, name); return dependencies[name]; },
    Promise, Boolean,
  });
  return loaded.exports;
}

test("PostgreSQL: ambas clases aprobadas protegen solo el crédito vigente, sin alterar el historial", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "CreditMoraExceptionRequest" ("creditoId" INTEGER, "type" TEXT, "status" TEXT, "expiresOn" DATE);
    CREATE TABLE "ExcepcionBloqueoMora" ("documento" TEXT, "activa" BOOLEAN, "fechaFin" TIMESTAMP);
  `);
  const db = { $queryRawUnsafe: async (sql, ...params) => (await database.query(sql, params)).rows };
  const helpers = load({
    "@/lib/prisma": { default: db },
    "@/lib/mora-block-exemptions": { ensureMoraBlockExemptionTable: async () => {}, normalizeMoraExemptionDocument: value => String(value ?? "").replace(/\D/g, "") },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
  const protect = (id, document = "001234567") => helpers.hasActiveMoraBlockProtection(id, document);
  for (const type of ["EXCEPCION", "PRORROGA"]) {
    await database.query(`DELETE FROM "CreditMoraExceptionRequest"`);
    await database.query(`INSERT INTO "CreditMoraExceptionRequest" VALUES (41,$1,'APPROVED',(clock_timestamp() AT TIME ZONE 'America/Bogota')::date)`, [type]);
    assert.equal(await protect(41), true, `${type} vigente hasta el final del día colombiano`);
    assert.equal(await protect(42), false, "No hereda la excepción de otro crédito aunque comparta cédula");
    await database.query(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"=(clock_timestamp() AT TIME ZONE 'America/Bogota')::date-1`);
    assert.equal(await protect(41), false, `${type} vencida deja actuar las reglas normales`);
    await database.query(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"=NULL`);
    assert.equal(await protect(41), true, "Excepción sin vencimiento conserva protección");
    for (const status of ["PENDING", "REJECTED", "EXPIRED", "CANCELLED", "REPLACED"]) {
      await database.query(`UPDATE "CreditMoraExceptionRequest" SET "status"=$1`, [status]);
      assert.equal(await protect(41), false, `${status} no concede protección`);
    }
  }
  const before = (await database.query(`SELECT * FROM "CreditMoraExceptionRequest"`)).rows;
  await protect(41);
  assert.deepEqual((await database.query(`SELECT * FROM "CreditMoraExceptionRequest"`)).rows, before, "Consultar vigencia no modifica decisiones o fechas históricas");
});

test("acuerdo heredado usa la cédula completa y el reloj real de base de datos", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "CreditMoraExceptionRequest" ("creditoId" INTEGER, "status" TEXT, "expiresOn" DATE);
    CREATE TABLE "ExcepcionBloqueoMora" ("documento" TEXT, "activa" BOOLEAN, "fechaFin" TIMESTAMP);
    INSERT INTO "ExcepcionBloqueoMora" VALUES ('001234567',TRUE, (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '1 hour');
  `);
  const db = { $queryRawUnsafe: async (sql, ...params) => (await database.query(sql, params)).rows };
  const helpers = load({
    "@/lib/prisma": { default: db },
    "@/lib/mora-block-exemptions": { ensureMoraBlockExemptionTable: async () => {}, normalizeMoraExemptionDocument: value => String(value ?? "").replace(/\D/g, "") },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
  assert.equal(await helpers.hasActiveMoraBlockProtection(41, "00.123.4567"), true);
  assert.equal(await helpers.hasActiveMoraBlockProtection(41, "1234567"), false, "Conserva ceros iniciales");
  await database.exec(`UPDATE "ExcepcionBloqueoMora" SET "fechaFin"=(clock_timestamp() AT TIME ZONE 'UTC') - INTERVAL '1 second'`);
  assert.equal(await helpers.hasActiveMoraBlockProtection(41, "001234567"), false);
  await database.exec(`UPDATE "ExcepcionBloqueoMora" SET "fechaFin"=NULL`);
  assert.equal(await helpers.hasActiveMoraBlockProtection(41, "001234567"), true);
  await database.exec(`UPDATE "ExcepcionBloqueoMora" SET "activa"=FALSE`);
  assert.equal(await helpers.hasActiveMoraBlockProtection(41, "001234567"), false);
});
