import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { creditApprovalSchemaStatements } from "../scripts/credit-approval-schema.mjs";
import { installCreditSadminSchema } from "../scripts/credit-sadmin-schema.mjs";
import { secondCreditAuthorizationSchemaStatements } from "../scripts/second-credit-authorization-schema.mjs";

const requireFromTest = createRequire(import.meta.url);
const cache = new Map();
export function loadSadminModule(path) {
  if (cache.has(path)) return cache.get(path);
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const loaded = { exports: {} };
  runInNewContext(compiled, {
    module: loaded, exports: loaded.exports, Buffer, Uint8Array, Date, URL, Request, Response, TextDecoder, console,
    require(name) {
      if (name === "server-only") return {};
      if (name.startsWith("@/lib/")) return loadSadminModule(name.slice(2) + ".ts");
      if (name.startsWith("./")) return loadSadminModule("lib/" + name.slice(2) + ".ts");
      return requireFromTest(name);
    },
  }, { filename: path });
  cache.set(path, loaded.exports);
  return loaded.exports;
}

export const service = loadSadminModule("lib/credit-sadmin.ts");
export const state = loadSadminModule("lib/credit-sadmin-state.ts");
export const actor = { id: 1, nombre: "Administrador sintético SADMIN", sadminScope: "HISTORICAL", sadminWriteScope: "HISTORICAL" };
export const analystActor = { id: 1, nombre: "Analista sintético SADMIN", sadminScope: "HISTORICAL", sadminWriteScope: "HISTORICAL_OR_APPROVED_READY" };
export const sharedActor = { kind: "SHARED_LINK", id: null, nombre: "No confiar en este nombre",
  grantId: "10000000-0000-4000-8000-000000000001", sessionId: "20000000-0000-4000-8000-000000000001",
  sadminScope: "HISTORICAL" };

export async function approveCreditForSadmin(pool, creditoId, overrides = {}) {
  const values = {
    status: "APPROVED", revision: 1, approvedRevision: 1,
    approvedByUserId: 1, approvedByName: "Analista sintético SADMIN", approvedByKind: "USER",
    approvedAt: "2026-09-17T13:00:00Z", reviewHash: "a".repeat(64),
    reviewHashVersion: 2, approvedHashVersion: 2, ...overrides,
  };
  const fields = ["creditoId", ...Object.keys(values)];
  await pool.query(`INSERT INTO "CreditApprovalReview" (${fields.map(field => `"${field}"`).join(",")})
    VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")})`, [creditoId, ...Object.values(values)]);
}

export function databaseAdapter(pool) {
  return { async $transaction(work, options = {}) {
    const client = await pool.connect();
    try {
      await client.query(options.isolationLevel === "RepeatableRead" ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL statement_timeout='15s'");
      const result = await work({
        $queryRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rows,
        $executeRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rowCount,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } };
}

export async function prepareServiceFixture(pool, connectionString, expectedDatabase = "sadmin_service_test") {
  assert.ok(["sadmin_service_test", "mass_credit_sadmin_test"].includes(expectedDatabase), "Base exclusiva de pruebas SADMIN");
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Solo PostgreSQL local aislado");
  assert.equal(url.pathname, "/" + expectedDatabase, "Base exclusiva de servicio SADMIN");
  const client = await pool.connect();
  try {
    assert.equal((await client.query("SELECT current_database() AS name")).rows[0].name, expectedDatabase);
    const tables = ["SecondCreditAuthorizationEvent", "SecondCreditAuthorization", "CreditSadminEvent", "CreditSadminRegistration",
      "CreditApprovalReissue", "CreditApprovalNovelty", "CreditApprovalReview", "CreditApprovalPolicy", "LiquidacionAliadoCredito", "CreditoAbono", "CreditoAmortizacion", "Credito", "Sede", "Aliado", "Usuario",
      "CreditApprovalSharedSession", "CreditApprovalSharedGrant"];
    const existing = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.ok(existing.rows.every(row => tables.includes(row.tablename)), "El fixture no borra tablas ajenas");
    for (const table of tables) await client.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
    await prepareServiceSchema(client);
  } finally { client.release(); }
}

// Shared synthetic schema; the external-PostgreSQL caller above checks the
// exclusive local database before dropping tables. PGlite callers use memory.
export async function prepareServiceSchema(client) {
  await client.query(`
      CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
      INSERT INTO "Usuario" VALUES (1);
      CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"nombre" TEXT NOT NULL,"codigo" TEXT NOT NULL);
      INSERT INTO "Aliado" VALUES (1,'FINSER PAY CENTRAL','FINSERPAY'),(2,'JG COMPANY','JG');
      CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER NOT NULL REFERENCES "Aliado","nombre" TEXT NOT NULL);
      INSERT INTO "Sede" VALUES (1,1,'Central'),(2,2,'JG Prueba');
      CREATE TABLE "Credito" (
        "id" SERIAL PRIMARY KEY,"folio" TEXT UNIQUE NOT NULL,"sedeId" INTEGER NOT NULL DEFAULT 2 REFERENCES "Sede",
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-09-17T12:00:00',"fechaCredito" TIMESTAMP(3) NOT NULL DEFAULT '2020-01-01T12:00:00',
        "clienteNombre" TEXT NOT NULL DEFAULT 'Cliente sintético',"clienteDocumento" TEXT DEFAULT '100000001',
        "clienteTelefono" TEXT DEFAULT '3000000000',"clienteDireccion" TEXT DEFAULT 'Calle sintética',
        "clienteFechaNacimiento" TIMESTAMP(3) DEFAULT '1990-01-01',"clienteCorreo" TEXT DEFAULT 'test@example.invalid',"clienteGenero" TEXT DEFAULT 'M',
        "imei" TEXT NOT NULL DEFAULT '000000000000001',"referenciaEquipo" TEXT DEFAULT 'Equipo prueba',"equipoMarca" TEXT,"equipoModelo" TEXT,
        "plazoMeses" INTEGER DEFAULT 24,"frecuenciaPago" TEXT NOT NULL DEFAULT 'QUINCENAL',
        "valorEquipoTotal" DOUBLE PRECISION NOT NULL DEFAULT 1200000,"cuotaInicial" DOUBLE PRECISION NOT NULL DEFAULT 200000,
        "saldoBaseFinanciado" DOUBLE PRECISION NOT NULL DEFAULT 1000000,"valorCuota" DOUBLE PRECISION NOT NULL DEFAULT 50000,
        "montoCredito" DOUBLE PRECISION NOT NULL DEFAULT 1200000,"valorFianza" DOUBLE PRECISION NOT NULL DEFAULT 100000,
        "valorInteres" DOUBLE PRECISION NOT NULL DEFAULT 100000,"tasaInteresEa" DOUBLE PRECISION NOT NULL DEFAULT 10,
        "fianzaPorcentaje" DOUBLE PRECISION NOT NULL DEFAULT 10,"contratoSnapshot" JSONB,"planCapitalVigente" JSONB,"equalityService" TEXT,
        "fechaPrimerPago" TIMESTAMP(3) DEFAULT '2020-02-02',"fechaProximoPago" TIMESTAMP(3),"pazYSalvoEmitidoAt" TIMESTAMP(3),
        "estado" TEXT NOT NULL DEFAULT 'INSCRITO');
      CREATE TABLE "CreditoAmortizacion" (
        "id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito", "tasaInteresEaPorcentaje" DOUBLE PRECISION,
        "fianzaCuotaPorcentaje" DOUBLE PRECISION,"seguroCuotaPorcentaje" DOUBLE PRECISION,"numeroCuotas" INTEGER);
      CREATE TABLE "CreditoAbono" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER REFERENCES "Credito", "fechaAbono" TIMESTAMP(3),
        "valor" DOUBLE PRECISION NOT NULL,"metodoPago" TEXT,"estado" TEXT DEFAULT 'APLICADO');
      CREATE TABLE "LiquidacionAliadoCredito" ("creditoId" INTEGER PRIMARY KEY REFERENCES "Credito");
      CREATE TABLE "CreditApprovalSharedGrant" ("id" UUID PRIMARY KEY,"scope" TEXT NOT NULL,"revokedAt" TIMESTAMP(3));
      CREATE TABLE "CreditApprovalSharedSession" ("id" UUID PRIMARY KEY,"grantId" UUID NOT NULL REFERENCES "CreditApprovalSharedGrant",
        "revokedAt" TIMESTAMP(3),"expiresAt" TIMESTAMP(3) NOT NULL, UNIQUE("id","grantId"));
      CREATE TABLE "CreditApprovalReview" (
        "creditoId" INTEGER PRIMARY KEY REFERENCES "Credito","status" TEXT NOT NULL DEFAULT 'PENDING',"revision" INTEGER NOT NULL DEFAULT 1,
        "approvedRevision" INTEGER,"approvedByUserId" INTEGER,"approvedByName" TEXT,"approvedByKind" TEXT,
        "approvedByGrantId" UUID,"approvedBySessionId" UUID,"approvedAt" TIMESTAMP(3),"reviewHash" TEXT,
        "reviewHashVersion" SMALLINT NOT NULL DEFAULT 2,"approvedHashVersion" SMALLINT);
      CREATE TABLE "CreditApprovalPolicy" ("id" INTEGER PRIMARY KEY,"activatedAt" TIMESTAMP(3) NOT NULL);
      INSERT INTO "CreditApprovalPolicy" VALUES (1,'2026-09-01T00:00:00Z');
      CREATE TABLE "CreditApprovalNovelty" ("id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL REFERENCES "Credito","status" TEXT NOT NULL);
      CREATE TABLE "CreditApprovalReissue" ("id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL REFERENCES "Credito","status" TEXT);
    `);
    await client.query(creditApprovalSchemaStatements.find(sql => sql.includes("CREATE OR REPLACE FUNCTION public.credit_approval_reject_history_mutation()")));
    await installCreditSadminSchema(client);
    for (const statement of secondCreditAuthorizationSchemaStatements) await client.query(statement);
    await client.query('INSERT INTO "CreditApprovalSharedGrant" ("id","scope") VALUES ($1,\'CREDIT_APPROVAL\')', [sharedActor.grantId]);
    await client.query('INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt") VALUES ($1,$2,\'2199-01-01\')', [sharedActor.sessionId, sharedActor.grantId]);
}
