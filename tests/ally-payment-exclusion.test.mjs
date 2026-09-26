import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { creditAllyPaymentExclusionSchemaStatements } from "../scripts/credit-ally-payment-exclusion-schema.mjs";

const imports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (["./ally-payments-core", "./credit-approval-policy", "./credit-import-flags"].includes(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    return nextResolve(specifier, context);
  },
});
const { buildAllyPaymentEligibilityQuery } = await import("../lib/ally-payment-eligibility.ts");
imports.deregister();

const storage = await readFile(new URL("../lib/ally-payments.ts", import.meta.url), "utf8");
const collectionFunction = storage.slice(
  storage.indexOf("async function loadEligibleCollections"),
  storage.indexOf("function totalCollections")
);
const loadCollections = runInNewContext(stripTypeScriptTypes("(" + collectionFunction + ")"), {
  ensureCreditAllyPaymentExclusionSchema: async () => {},
  ALIADO_FINSER_PAY: { codigo: "FINSERPAY" },
  compactText: (value, fallback) => String(value || fallback),
});

test("el inicio comparte el lock de predeploy, coalesce llamadas y reintenta un fallo", async () => {
  const source = await readFile(new URL("../lib/credit-ally-payment-exclusion-storage.ts", import.meta.url), "utf8");
  const predeploy = await readFile(new URL("../scripts/ensure-ally-payments-schema.mjs", import.meta.url), "utf8");
  const predeployLock = /"SELECT pg_advisory_xact_lock\(hashtext\('([^']+)'\)\)"/.exec(predeploy)?.[0];
  assert.ok(predeployLock, "El predeploy necesita un lock antes de modificar las tablas.");
  const expectedLockSql = JSON.parse(predeployLock);
  const calls = [];
  let transactions = 0;
  let failNext = true;
  const initializer = runInNewContext(stripTypeScriptTypes(
    source.slice(source.indexOf("let schemaReady"))
      .replace("export function", "function") +
      "\n({ ensureCreditAllyPaymentExclusionSchema })"
  ), {
    creditAllyPaymentExclusionSchemaStatements,
    prisma: {
      async $transaction(run) {
        transactions += 1;
        return run({
          $queryRawUnsafe: () => assert.fail("Un advisory lock void debe usar execute."),
          async $executeRawUnsafe(sql) {
            calls.push(sql);
            if (failNext) {
              failNext = false;
              throw new Error("Fallo sintetico antes del DDL");
            }
          },
        });
      },
    },
  }).ensureCreditAllyPaymentExclusionSchema;
  await assert.rejects(initializer(), /Fallo sintetico/);
  calls.length = 0;
  await Promise.all([initializer(), initializer()]);
  assert.equal(transactions, 2, "Un fallo admite reintento; llamadas concurrentes comparten el inicio.");
  assert.equal(calls[1], expectedLockSql, "Runtime y predeploy deben bloquear la misma clave antes del DDL.");
  assert.deepEqual(calls.slice(2), creditAllyPaymentExclusionSchemaStatements);
  await initializer();
  assert.equal(transactions, 2, "Un inicio ya confirmado no vuelve a instalar el esquema.");
});

const memoryPostgres = process.env.ALLY_PAYMENT_PGLITE_MODULE;
test("PostgreSQL local: creditos y recaudos excluidos, insert directo, historial y limites del periodo", {
  skip: memoryPostgres ? false : "Falta ALLY_PAYMENT_PGLITE_MODULE para PostgreSQL en memoria; no se usa produccion.",
}, async (t) => {
  const { PGlite } = await import(pathToFileURL(memoryPostgres).href);
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY, "fechaCredito" TIMESTAMP, "createdAt" TIMESTAMP,
      "folio" TEXT, "clienteNombre" TEXT, "clienteDocumento" TEXT, "imei" TEXT,
      "deviceUid" TEXT, "referenciaEquipo" TEXT, "equipoMarca" TEXT, "equipoModelo" TEXT,
      "valorEquipoTotal" NUMERIC, "cuotaInicial" NUMERIC, "contratoSnapshot" JSONB,
      "sedeId" INTEGER, "estado" TEXT, "equalityService" TEXT
    );
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "nombre" TEXT);
    CREATE TABLE "Aliado" (
      "id" INTEGER PRIMARY KEY, "codigo" TEXT, "nombre" TEXT,
      "redescuentoPorcentaje" NUMERIC, "redescuentoAndroidPorcentaje" NUMERIC,
      "redescuentoIphonePorcentaje" NUMERIC
    );
    CREATE TABLE "CreditApprovalPolicy" ("id" INTEGER PRIMARY KEY, "activatedAt" TIMESTAMP);
    CREATE TABLE "CreditApprovalReview" (
      "creditoId" INTEGER, "status" TEXT, "revision" INTEGER, "approvedRevision" INTEGER,
      "reviewHashVersion" SMALLINT, "approvedHashVersion" SMALLINT
    );
    CREATE TABLE "CreditApprovalNovelty" ("creditoId" INTEGER, "status" TEXT);
    CREATE TABLE "CreditoAbono" (
      "id" INTEGER PRIMARY KEY, "creditoId" INTEGER, "sedeId" INTEGER,
      "fechaAbono" TIMESTAMP, "metodoPago" TEXT, "valor" NUMERIC, "estado" TEXT, "anuladoAt" TIMESTAMP
    );
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER);
    CREATE TABLE "LiquidacionAliadoRecaudo" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER, "abonoId" INTEGER);
    INSERT INTO "CreditApprovalPolicy" VALUES (1, '2099-01-01');
    INSERT INTO "Aliado" VALUES (2, 'ALIADO', 'Aliado sintetico', 10, 10, 15);
    INSERT INTO "Sede" VALUES (1, 2, 'Sede sintetica');
    INSERT INTO "Credito"
      SELECT id, '2026-09-26T12:00:00'::timestamp, '2020-01-01'::timestamp,
        'F-' || id, 'Cliente sintetico', 'CC-' || id, 'IMEI-' || id, 'IMEI-' || id,
        'Equipo sintetico', 'Apple', 'iPhone', 1000000, 0,
        CASE WHEN id IN (2, 3) THEN '{"origen":{"tipo":"IMPORTACION_MASIVA"},"equipo":{"plataforma":"IPHONE"}}'::jsonb
        ELSE '{"equipo":{"plataforma":"IPHONE"}}'::jsonb END,
        1, 'GENERADO', CASE WHEN id IN (2, 3) THEN 'IMPORTACION_MASIVA' ELSE NULL END
      FROM generate_series(1, 5) id;
    INSERT INTO "CreditoAbono"
      SELECT id, id, 1, '2026-09-26T12:00:00'::timestamp, 'EFECTIVO', 100000, 'REGISTRADO', NULL
      FROM generate_series(1, 5) id;
  `);
  for (const statement of creditAllyPaymentExclusionSchemaStatements) await db.exec(statement);
  // Re-running the initializer must preserve registered exclusions and histories.
  const registerExclusion = (id) => db.query(
    'INSERT INTO "CreditAllyPaymentExclusion" ("creditoId","reason","sourceFile","sourceSha256","sourceSheet","sourceRow","createdBy") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, "Carga historica ya pagada", "synthetic.xlsx", "a".repeat(64), "Hoja 1", id + 1, "Admin autorizado"]
  );
  await registerExclusion(2);
  for (const statement of creditAllyPaymentExclusionSchemaStatements) await db.exec(statement);
  const eligibleCredits = async (input) => {
    const query = buildAllyPaymentEligibilityQuery(input);
    return (await db.query(query.query, query.values)).rows.map((row) => row.id);
  };
  const collectionClient = {
    $queryRawUnsafe: async (query, ...values) => (await db.query(query, values)).rows,
  };
  try {
    await t.test("excluye solo el ID señalado de pendientes y periodo, conservando otro importado", async () => {
      assert.deepEqual(await eligibleCredits({ allyId: 2 }), [1, 3, 4, 5]);
      const period = { allyId: 2, start: new Date("2026-09-26T05:00:00Z"), endExclusive: new Date("2026-09-27T05:00:00Z") };
      assert.deepEqual(await eligibleCredits(period), [1, 3, 4, 5]);
      assert.deepEqual(await eligibleCredits({ ...period, lock: true }), [1, 3, 4, 5]);
      assert.deepEqual(await eligibleCredits({ ...period, allyId: 3 }), []);
      assert.deepEqual(await eligibleCredits({ ...period, endExclusive: new Date("2026-09-26T05:00:00Z") }), []);
    });

    await t.test("los recaudos del credito excluido tampoco entran en pendientes ni periodo", async () => {
      const ids = (rows) => JSON.parse(JSON.stringify(rows)).map((row) => row.creditoId);
      assert.deepEqual(ids(await loadCollections(collectionClient, { allyId: 2 })), [1, 3, 4, 5]);
      assert.deepEqual(ids(await loadCollections(collectionClient, {
        allyId: 2, start: new Date("2026-09-26T05:00:00Z"), endExclusive: new Date("2026-09-27T05:00:00Z"), lock: true,
      })), [1, 3, 4, 5]);
      assert.deepEqual(ids(await loadCollections(collectionClient, { allyId: 3 })), []);
    });

    await t.test("rechaza liquidacion directa y recaudo con ID falsificado", async () => {
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES (2)'), /ALLY_PAYMENT_CREDIT_EXCLUDED/);
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("creditoId","abonoId") VALUES (2,2)'), /ALLY_PAYMENT_CREDIT_EXCLUDED/);
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("creditoId","abonoId") VALUES (1,2)'), /ALLY_PAYMENT_CREDIT_EXCLUDED/);
      await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES (4)');
      await db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("creditoId","abonoId") VALUES (5,5)');
      assert.deepEqual(await eligibleCredits({ allyId: 2 }), [1, 3, 5]);
    });

    await t.test("no permite excluir un credito ni recaudo ya liquidado", async () => {
      await assert.rejects(registerExclusion(4), /ALLY_PAYMENT_CREDIT_ALREADY_SETTLED/);
      await assert.rejects(registerExclusion(5), /ALLY_PAYMENT_CREDIT_ALREADY_SETTLED/);
      assert.deepEqual((await db.query('SELECT "creditoId" FROM "CreditAllyPaymentExclusion" ORDER BY "creditoId"')).rows, [{ creditoId: 2 }]);
    });

    await t.test("la evidencia es inmutable y no cambia el snapshot contractual", async () => {
      await assert.rejects(db.query('UPDATE "CreditAllyPaymentExclusion" SET "reason"=$1 WHERE "creditoId"=2', ["Cambio"]), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      await assert.rejects(db.query('DELETE FROM "CreditAllyPaymentExclusion" WHERE "creditoId"=2'), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      await assert.rejects(db.exec('TRUNCATE "CreditAllyPaymentExclusion"'), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      const credit = (await db.query('SELECT "contratoSnapshot" FROM "Credito" WHERE "id"=2')).rows[0];
      assert.deepEqual(credit.contratoSnapshot, { origen: { tipo: "IMPORTACION_MASIVA" }, equipo: { plataforma: "IPHONE" } });
      await assert.rejects(db.query('DELETE FROM "Credito" WHERE "id"=2'), /foreign key constraint/);
    });
  } finally {
    await db.close();
  }
});
