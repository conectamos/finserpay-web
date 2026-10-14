import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  creditAbonoAllyAttributionSchemaStatements,
  creditAbonoAllyAttributionValidationStatements,
} from "../scripts/credit-abono-ally-attribution-schema.mjs";
import { creditAllyPaymentExclusionSchemaStatements } from "../scripts/credit-ally-payment-exclusion-schema.mjs";
import {
  allyPaymentCentralCollectionAdjustmentSchemaStatements,
  allyPaymentCentralCollectionAdjustmentValidationStatements,
} from "../scripts/ally-payment-central-collection-adjustment-schema.mjs";

const source = await readFile(new URL("../scripts/ensure-ally-payments-schema.mjs", import.meta.url), "utf8");
const body = source.replace(/^import\s[\s\S]*?;\r?\n/gm, "");
const arrayMarker = "const statements = ";
const arrayStart = source.indexOf(arrayMarker) + arrayMarker.length;
const arrayEnd = source.indexOf("\n];", arrayStart);
const baseStatements = runInNewContext(`(${source.slice(arrayStart, arrayEnd + 2)})`);

/** Run the complete startup script, including its transaction and compatibility checks.
 * pg is replaced with an in-memory PostgreSQL adapter; no sockets or real credentials.
 */
async function runStartup(database) {
  let statementError;
  class FixtureClient {
    async connect() {}
    async end() {}
    async query(sql, parameters) {
      try {
        if (parameters) return await database.query(sql, parameters);
        const results = await database.exec(sql);
        return results.at(-1) || { rows: [] };
      } catch (error) { statementError = error; throw error; }
    }
  }
  try {
    await runInNewContext(`(async () => { ${body}\n })()`, {
      pg: { Client: FixtureClient },
      process: { env: { DATABASE_URL: "postgresql://in-memory-qa-only" } },
      console: { log() {} },
      creditAbonoAllyAttributionSchemaStatements,
      creditAbonoAllyAttributionValidationStatements,
      creditAllyPaymentExclusionSchemaStatements,
      allyPaymentCentralCollectionAdjustmentSchemaStatements,
      allyPaymentCentralCollectionAdjustmentValidationStatements,
    });
  } catch (error) {
    if (statementError) {
      const diagnostic = new Error(`${error.message} SQLSTATE=${statementError.code || ""}; constraint=${statementError.constraint || ""}; statement=${statementError.message || ""}`);
      diagnostic.cause = statementError;
      throw diagnostic;
    }
    throw error;
  }
}

async function createFixture(database) {
  await database.exec(`
    CREATE TABLE public."Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT NOT NULL, "nombre" TEXT NOT NULL);
    CREATE TABLE public."Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "nombre" TEXT NOT NULL);
    CREATE TABLE public."Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT NOT NULL);
    CREATE TABLE public."Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT NOT NULL, "usuario" TEXT NOT NULL, "rolId" INTEGER NOT NULL, "sedeId" INTEGER NOT NULL);
    CREATE TABLE public."Credito" (
      "id" INTEGER PRIMARY KEY, "estado" TEXT NOT NULL, "sedeId" INTEGER NOT NULL,
      "clienteDocumento" TEXT NOT NULL, "imei" TEXT NOT NULL, "deviceUid" TEXT,
      "observacionAdmin" TEXT, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE public."CreditoAbono" (
      "id" INTEGER PRIMARY KEY, "creditoId" INTEGER NOT NULL, "usuarioId" INTEGER NOT NULL,
      "sedeId" INTEGER NOT NULL, "fechaAbono" TIMESTAMP(3) NOT NULL, "metodoPago" TEXT NOT NULL,
      "valor" NUMERIC(20,2) NOT NULL, "estado" TEXT NOT NULL
    );
    INSERT INTO public."Aliado" VALUES (1, 'FINSERPAY', 'FINSER QA'), (2, 'QA', 'Aliado QA');
    INSERT INTO public."Sede" VALUES (10, 1, 'Central QA'), (20, 2, 'Sede QA');
    INSERT INTO public."Rol" VALUES (1, 'ADMIN');
    INSERT INTO public."Usuario" VALUES (1, 'Administrador QA', 'admin', 1, 10);
    INSERT INTO public."Credito" ("id", "estado", "sedeId", "clienteDocumento", "imei")
      VALUES (4100, 'FINALIZADO', 20, '00123456789', '035000000000001');
    INSERT INTO public."CreditoAbono" VALUES (1574, 4100, 1, 20, '2026-10-08 12:00:00', 'OTRO', 110000.37, 'ACTIVO');
  `);
  // A historical paid collection predates the attribution guards. Its snapshot
  // must remain intact; the startup adds an append-only central compensation.
  await database.exec(baseStatements.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS public."LiquidacionAliado"')));
  await database.exec(baseStatements.find(statement => statement.includes('CREATE TABLE IF NOT EXISTS public."LiquidacionAliadoRecaudo"')));
  await database.exec(`
    INSERT INTO public."LiquidacionAliado" (
      "id", "mutationId", "requestHash", "aliadoId", "periodoInicio", "periodoFin",
      "numeroAprobacionBancaria", "numeroAprobacionNormalizado", "estado", "numeroCreditos",
      "totalValorVenta", "totalCreditoAutorizado", "totalCuotaInicial", "totalIntermediacion", "totalPagar",
      "totalRecaudosAliado", "saldoNeto", "direccionSaldo", "registradoPorUsuarioId", "registradoPorNombre"
    ) VALUES (100, '00000000-0000-4000-8000-000000000100', REPEAT('a', 64), 2, '2026-10-01', '2026-10-08',
      'QA-ORIGEN', 'QA-ORIGEN', 'PAGADA', 0, 1000000, 800000, 200000, 80000, 720000,
      110000.37, 609999.63, 'PAGO_ALIADO', 1, 'Administrador QA');
    INSERT INTO public."LiquidacionAliadoRecaudo" (
      "id", "liquidacionId", "abonoId", "creditoId", "sedeId", "fechaAbono", "folio", "clienteNombre",
      "clienteDocumento", "sedeNombre", "metodoPago", "valor", "estado"
    ) VALUES (500, 100, 1574, 4100, 20, '2026-10-08 12:00:00', 'FC-QA-0001', 'Cliente QA',
      '00123456789', 'Sede QA', 'OTRO', 110000.37, 'DESCONTADO');
  `);
}

async function financialSnapshot(database) {
  const tables = ["LiquidacionAliado", "LiquidacionAliadoRecaudo", "AjusteRecaudoCentralAliado", "LiquidacionAliadoAjusteRecaudoCentral", "CreditoAbonoAtribucionAliado"];
  const snapshot = {};
  for (const table of tables) {
    const order = table === "CreditoAbonoAtribucionAliado" ? "abonoId" : "id";
    snapshot[table] = (await database.query(`SELECT * FROM public."${table}" ORDER BY "${order}"`)).rows;
  }
  return JSON.stringify(snapshot);
}

test("the complete ally-payment startup can rerun after a paid central adjustment without changing any ledger snapshot", async () => {
  const database = new PGlite();
  try {
    await createFixture(database);
    await runStartup(database);
    const adjustmentId = (await database.query('SELECT "id" FROM public."AjusteRecaudoCentralAliado" WHERE "abonoId" = 1574')).rows[0].id;
    await database.exec(`
      INSERT INTO public."LiquidacionAliado" (
        "id", "mutationId", "requestHash", "aliadoId", "periodoInicio", "periodoFin",
        "numeroAprobacionBancaria", "numeroAprobacionNormalizado", "estado", "numeroCreditos",
        "totalValorVenta", "totalCreditoAutorizado", "totalCuotaInicial", "totalIntermediacion", "totalPagar",
        "totalRecaudosAliado", "numeroAjustesRecaudoCentral", "totalAjustesRecaudoCentral", "saldoNeto",
        "direccionSaldo", "registradoPorUsuarioId", "registradoPorNombre"
      ) VALUES (200, '00000000-0000-4000-8000-000000000200', REPEAT('b', 64), 2, '2026-10-09', '2026-10-14',
        'QA-AJUSTE', 'QA-AJUSTE', 'PAGADA', 0, 0, 0, 0, 0, 0, 0, 1, 110000.37, 110000.37,
        'PAGO_ALIADO', 1, 'Administrador QA');
    `);
    await database.query(`INSERT INTO public."LiquidacionAliadoAjusteRecaudoCentral" ("liquidacionId", "ajusteId", "valorAjuste", "estado") VALUES (200, $1, 110000.37, 'ACREDITADO')`, [adjustmentId]);
    const before = await financialSnapshot(database);
    await runStartup(database);
    assert.equal(await financialSnapshot(database), before, "Startup must not rewrite historic amounts, attribution, timestamps, or compensation applications.");
    await assert.rejects(database.exec(`
      INSERT INTO public."LiquidacionAliado" (
        "mutationId", "requestHash", "aliadoId", "periodoInicio", "periodoFin", "numeroAprobacionBancaria", "numeroAprobacionNormalizado", "estado", "numeroCreditos",
        "totalValorVenta", "totalCreditoAutorizado", "totalCuotaInicial", "totalIntermediacion", "totalPagar", "totalRecaudosAliado", "totalAjustesRecaudoCentral",
        "saldoNeto", "direccionSaldo", "registradoPorUsuarioId", "registradoPorNombre"
      ) VALUES ('00000000-0000-4000-8000-000000000201', REPEAT('c', 64), 2, '2026-10-09', '2026-10-14', 'QA-INVALIDA', 'QA-INVALIDA', 'PAGADA', 0,
        0, 0, 0, 0, 0, 0, 110000.37, 0, 'SALDO_CERO', 1, 'Administrador QA')
    `), /LiquidacionAliado_balance_check/);
  } finally { await database.close(); }
});
