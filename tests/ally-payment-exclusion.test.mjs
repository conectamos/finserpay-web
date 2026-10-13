import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes, registerHooks } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  creditAbonoAllyAttributionSchemaStatements,
  creditAbonoAllyAttributionValidationStatements,
} from "../scripts/credit-abono-ally-attribution-schema.mjs";
import { creditAllyPaymentExclusionSchemaStatements } from "../scripts/credit-ally-payment-exclusion-schema.mjs";
import {
  resolveAllyPaymentPlatform,
  resolveColombiaPaymentPeriod,
} from "../lib/ally-payments-core.ts";

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
  ALLY_PAYMENTS_AVAILABLE_FROM: "2026-09-01",
  resolveColombiaPaymentPeriod,
  compactText: (value, fallback) => String(value || fallback),
  resolveAllyPaymentPlatform,
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
    creditAbonoAllyAttributionSchemaStatements,
    creditAbonoAllyAttributionValidationStatements,
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
  assert.deepEqual(calls.slice(2), [
    ...creditAbonoAllyAttributionSchemaStatements,
    ...creditAllyPaymentExclusionSchemaStatements,
    ...creditAbonoAllyAttributionValidationStatements,
  ]);
  await initializer();
  assert.equal(transactions, 2, "Un inicio ya confirmado no vuelve a instalar el esquema.");
});

test("PostgreSQL local: creditos excluidos y recaudos descontables, insert directo, historial y limites del periodo", async (t) => {
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
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "Usuario" (
      "id" INTEGER PRIMARY KEY, "nombre" TEXT, "usuario" TEXT, "rolId" INTEGER, "sedeId" INTEGER
    );
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
    CREATE TABLE "CreditDeviceReplacement" ("creditId" INTEGER, "source" TEXT, "status" TEXT);
    CREATE TABLE "ApprovalOperationalContractVersion" ("creditoId" INTEGER, "version" INTEGER, "status" TEXT);
    CREATE TABLE "CreditoAbono" (
      "id" INTEGER PRIMARY KEY, "creditoId" INTEGER, "usuarioId" INTEGER, "sedeId" INTEGER,
      "fechaAbono" TIMESTAMP, "metodoPago" TEXT, "valor" NUMERIC, "estado" TEXT, "anuladoAt" TIMESTAMP
    );
    CREATE TABLE "LiquidacionAliado" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER);
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER);
    CREATE TABLE "LiquidacionAliadoRecaudo" (
      "id" SERIAL PRIMARY KEY, "liquidacionId" INTEGER, "creditoId" INTEGER, "abonoId" INTEGER
    );
    INSERT INTO "CreditApprovalPolicy" VALUES (1, '2099-01-01');
    INSERT INTO "Aliado" VALUES
      (1, 'FINSERPAY', 'FINSER PAY', 10, 10, 10),
      (2, 'ALIADO', 'Aliado sintetico', 10, 10, 15);
    INSERT INTO "Sede" VALUES
      (1, 2, 'Sede sintetica'),
      (2, 1, 'Sede central');
    INSERT INTO "Rol" VALUES (1, 'ADMIN'), (2, 'VENDEDOR');
    INSERT INTO "Usuario" VALUES
      (10, 'Administrador central', 'admin', 1, 2),
      (20, 'Recaudador aliado', 'aliado.qa', 2, 1),
      (30, 'Administrador central alterno', 'admin.finser.qa', 1, 2);
    INSERT INTO "LiquidacionAliado" VALUES (1, 2);
    INSERT INTO "Credito"
      SELECT id, '2026-09-26T12:00:00'::timestamp, '2020-01-01'::timestamp,
        'F-' || id, 'Cliente sintetico', 'CC-' || id, 'IMEI-' || id, 'IMEI-' || id,
        'Equipo sintetico', 'Apple', 'iPhone', 1000000, 0,
        CASE WHEN id IN (2, 3) THEN '{"origen":{"tipo":"IMPORTACION_MASIVA"},"equipo":{"plataforma":"IPHONE"}}'::jsonb
        ELSE '{"equipo":{"plataforma":"IPHONE"}}'::jsonb END,
        1, 'GENERADO', CASE WHEN id IN (2, 3) THEN 'IMPORTACION_MASIVA' ELSE NULL END
      FROM generate_series(1, 5) id;
    INSERT INTO "CreditoAbono"
      SELECT id, id, 20, 1, '2026-09-26T12:00:00'::timestamp, 'EFECTIVO', 100000, 'REGISTRADO', NULL
      FROM generate_series(1, 5) id;
    INSERT INTO "CreditoAbono"
      VALUES
        (6, 1, 20, 1, '2026-08-31T12:00:00'::timestamp, 'EFECTIVO', 100000, 'REGISTRADO', NULL),
        (7, 1, 10, 1, '2026-09-26T13:00:00'::timestamp, 'OTRO', 110000, 'REGISTRADO', NULL),
        (10, 1, 10, 1, '2026-09-25T13:00:00'::timestamp, 'OTRO', 90000, 'REGISTRADO', NULL);
    INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId", "creditoId", "abonoId")
      VALUES (1, 1, 10);
  `);
  for (const statement of creditAbonoAllyAttributionSchemaStatements) await db.exec(statement);
  for (const statement of creditAllyPaymentExclusionSchemaStatements) await db.exec(statement);
  for (const statement of creditAbonoAllyAttributionValidationStatements) await db.exec(statement);
  await db.exec(`
    INSERT INTO "CreditoAbono" VALUES
      (8, 1, 20, 2, '2026-09-26T14:00:00'::timestamp, 'WOMPI', 120000, 'REGISTRADO', NULL),
      (9, 1, 20, 1, '2026-09-26T15:00:00'::timestamp, 'EFECTIVO', 130000, 'REGISTRADO', NULL),
      (11, 1, 10, 1, '2026-09-26T16:00:00'::timestamp, 'OTRO', 140000, 'REGISTRADO', NULL),
      (12, 1, 30, 1, '2026-09-26T17:00:00'::timestamp, 'OTRO', 150000, 'REGISTRADO', NULL);
    UPDATE "Usuario" SET "sedeId" = 1 WHERE "id" = 10;
    UPDATE "Usuario" SET "sedeId" = 2 WHERE "id" = 20;
  `);
  // Re-running the initializer must preserve registered exclusions and histories.
  const registerExclusion = (id) => db.query(
    'INSERT INTO "CreditAllyPaymentExclusion" ("creditoId","reason","sourceFile","sourceSha256","sourceSheet","sourceRow","createdBy") VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, "Carga historica ya pagada", "synthetic.xlsx", "a".repeat(64), "Hoja 1", id + 1, "Admin autorizado"]
  );
  await registerExclusion(2);
  for (const statement of creditAbonoAllyAttributionSchemaStatements) await db.exec(statement);
  for (const statement of creditAllyPaymentExclusionSchemaStatements) await db.exec(statement);
  for (const statement of creditAbonoAllyAttributionValidationStatements) await db.exec(statement);
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

    await t.test("la atribucion queda congelada y excluye admin central y sedes digitales", async () => {
      const ids = (rows) => JSON.parse(JSON.stringify(rows)).map((row) => row.abonoId);
      assert.deepEqual((await db.query(`
        SELECT "abonoId", "titularTipo", "aliadoId", "fuente"
        FROM "CreditoAbonoAtribucionAliado"
        WHERE "abonoId" IN (7, 8, 9, 10, 11, 12)
        ORDER BY "abonoId"
      `)).rows, [
        { abonoId: 7, titularTipo: "FINSER_PAY", aliadoId: null, fuente: "LEGACY_ADMIN_CANONICO" },
        { abonoId: 8, titularTipo: "FINSER_PAY", aliadoId: null, fuente: "TRIGGER_SEDE_CENTRAL" },
        { abonoId: 9, titularTipo: "ALIADO", aliadoId: 2, fuente: "TRIGGER_SEDE_ALIADA" },
        { abonoId: 10, titularTipo: "ALIADO", aliadoId: 2, fuente: "LEGACY_LIQUIDADO" },
        { abonoId: 11, titularTipo: "FINSER_PAY", aliadoId: null, fuente: "TRIGGER_ADMIN_CENTRAL" },
        { abonoId: 12, titularTipo: "FINSER_PAY", aliadoId: null, fuente: "TRIGGER_ADMIN_CENTRAL" },
      ]);
      const pendingCollections = await loadCollections(collectionClient, { allyId: 2 });
      assert.deepEqual(ids(pendingCollections), [1, 2, 3, 4, 5, 9]);
      assert.equal(pendingCollections.some((row) => row.abonoId === 7), false, "El actor FINSER PAY prevalece aunque el abono conserve una sede aliada.");
      assert.equal(pendingCollections.some((row) => row.abonoId === 8), false, "Una sede digital central nunca se carga al aliado.");
      assert.deepEqual(JSON.parse(JSON.stringify(pendingCollections[0].aliado)), { id: 2, nombre: "Aliado sintetico" });
      assert.equal(pendingCollections[0].plataforma, "IPHONE");
      assert.equal(pendingCollections[0].imei, "IMEI-1");
      assert.equal(pendingCollections.some((row) => row.abonoId === 6), false, "No arrastra recaudos anteriores al inicio operativo.");
      assert.deepEqual(ids(await loadCollections(collectionClient, {
        allyId: 2, start: new Date("2026-09-26T05:00:00Z"), endExclusive: new Date("2026-09-27T05:00:00Z"), lock: true,
      })), [1, 2, 3, 4, 5, 9]);
      assert.deepEqual(ids(await loadCollections(collectionClient, { allyId: 3 })), []);
    });

    await t.test("el guard dedicado sobrevive si una instancia anterior reemplaza el guard compartido", async () => {
      await db.exec(`
        CREATE OR REPLACE FUNCTION public.credit_ally_payment_guard_exclusion()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE actual_credit_id INTEGER;
        BEGIN
          IF TG_TABLE_NAME = 'LiquidacionAliadoRecaudo' THEN
            SELECT "creditoId" INTO actual_credit_id
            FROM public."CreditoAbono" WHERE "id" = NEW."abonoId";
            IF actual_credit_id IS DISTINCT FROM NEW."creditoId" THEN
              RAISE EXCEPTION 'ALLY_PAYMENT_COLLECTION_CREDIT_MISMATCH' USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
          END IF;
          PERFORM 1 FROM public."Credito" WHERE "id" = NEW."creditoId" FOR UPDATE;
          IF EXISTS (
            SELECT 1 FROM public."CreditAllyPaymentExclusion"
            WHERE "creditoId" = NEW."creditoId"
          ) THEN
            RAISE EXCEPTION 'ALLY_PAYMENT_CREDIT_EXCLUDED' USING ERRCODE = '23514';
          END IF;
          RETURN NEW;
        END $$
      `);
      await assert.rejects(
        db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,1,7)'),
        /ALLY_PAYMENT_COLLECTION_NOT_OWNED_BY_ALLY/
      );
    });

    await t.test("rechaza el credito excluido, admite su recaudo y bloquea IDs falsificados", async () => {
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES (2)'), /ALLY_PAYMENT_CREDIT_EXCLUDED/);
      await db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,2,2)');
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,1,3)'), /ALLY_PAYMENT_COLLECTION_CREDIT_MISMATCH/);
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,1,999)'), /ALLY_PAYMENT_COLLECTION_CREDIT_MISMATCH/);
      await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,1,7)'), /ALLY_PAYMENT_COLLECTION_NOT_OWNED_BY_ALLY/);
      await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES (4)');
      await db.query('INSERT INTO "LiquidacionAliadoRecaudo" ("liquidacionId","creditoId","abonoId") VALUES (1,5,5)');
      assert.deepEqual(await eligibleCredits({ allyId: 2 }), [1, 3, 5]);
    });

    await t.test("impide excluir un credito ya pagado pero no uno con recaudo descontado", async () => {
      await assert.rejects(registerExclusion(4), /ALLY_PAYMENT_CREDIT_ALREADY_SETTLED/);
      await registerExclusion(5);
      assert.deepEqual((await db.query('SELECT "creditoId" FROM "CreditAllyPaymentExclusion" ORDER BY "creditoId"')).rows, [{ creditoId: 2 }, { creditoId: 5 }]);
    });

    await t.test("la evidencia es inmutable y no cambia el snapshot contractual", async () => {
      await assert.rejects(db.query('UPDATE "CreditAllyPaymentExclusion" SET "reason"=$1 WHERE "creditoId"=2', ["Cambio"]), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      await assert.rejects(db.query('DELETE FROM "CreditAllyPaymentExclusion" WHERE "creditoId"=2'), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      await assert.rejects(db.exec('TRUNCATE "CreditAllyPaymentExclusion"'), /ALLY_PAYMENT_EXCLUSION_IMMUTABLE/);
      await assert.rejects(db.query('UPDATE "CreditoAbonoAtribucionAliado" SET "fuente"=$1 WHERE "abonoId"=9', ["LEGACY_SEDE_ALIADA"]), /ALLY_PAYMENT_ATTRIBUTION_IMMUTABLE/);
      await assert.rejects(db.query('DELETE FROM "CreditoAbonoAtribucionAliado" WHERE "abonoId"=9'), /ALLY_PAYMENT_ATTRIBUTION_IMMUTABLE/);
      await assert.rejects(db.exec('TRUNCATE "CreditoAbonoAtribucionAliado"'), /ALLY_PAYMENT_ATTRIBUTION_IMMUTABLE/);
      const credit = (await db.query('SELECT "contratoSnapshot" FROM "Credito" WHERE "id"=2')).rows[0];
      assert.deepEqual(credit.contratoSnapshot, { origen: { tipo: "IMPORTACION_MASIVA" }, equipo: { plataforma: "IPHONE" } });
      await assert.rejects(db.query('DELETE FROM "Credito" WHERE "id"=2'), /foreign key constraint/);
    });
  } finally {
    await db.close();
  }
});
