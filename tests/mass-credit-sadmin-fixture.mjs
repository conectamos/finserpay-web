import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const nativeRequire = createRequire(import.meta.url);
export function load(path, mocks = {}) {
  const loaded = { exports: {} };
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  runInNewContext(compiled, { module: loaded, exports: loaded.exports, Date, console, Request, Response,
    require(name) {
      if (name === "server-only") return {};
      if (name in mocks) return mocks[name];
      if (name.startsWith("node:")) return nativeRequire(name);
      if (name.startsWith("@/lib/")) return load(name.slice(2) + ".ts", mocks);
      throw new Error("Unexpected dependency: " + name);
    },
  });
  return loaded.exports;
}
export const approvalErrors = load("lib/credit-approval-errors.ts");
export const blacklistErrors = load("lib/document-blacklist-core.ts");
export const helper = load("lib/mass-credit-sadmin.ts", { "@/lib/credit-approval-errors": approvalErrors });
export const sample = (index = 1, changes = {}) => ({
  aliado: "ALIADO PRUEBA", sede: "SEDE PRUEBA", vendedor: "VENDEDOR PRUEBA", cedula: `90000${index}`,
  numeroCreditoSadmin: `000-SADMIN-${index}`, cliente: `CLIENTE PRUEBA ${index}`, telefono: "3001234567",
  referencia: "EQUIPO PRUEBA", imei: String(index).padStart(15, "0"), fecha: "2026-09-01", fechaPago: "2026-09-15",
  inicial: "100000", valorCredito: "600000", cuota: "60000", plazo: "12", frecuencia: "CATORCENAL", ...changes,
});
export function routeFixture(db, options = {}) {
  return load("app/api/creditos/masivos/route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/prisma": { __esModule: true, default: db },
    "@/lib/mass-credit-sadmin": helper, "@/lib/credit-approval-errors": approvalErrors,
    "@/lib/document-blacklist-core": blacklistErrors,
    "@/lib/document-blacklist": { assertDocumentNotBlacklisted: async document => {
      if (options.blocked === document) throw new blacklistErrors.DocumentBlacklistError("DOCUMENT_BLACKLISTED", "Cédula bloqueada", 403);
    } },
    "@/lib/document-blacklist-response": { documentBlacklistErrorResponse: () => null },
    "@/lib/auth": { getSessionUser: async () => options.user === undefined
      ? { id: 1, nombre: "Admin sintético", rolNombre: "ADMIN", aliadoAccesoCodigo: "FINSERPAY" } : options.user },
    "@/lib/credit-device-replacement-storage": {
      CreditDeviceReplacementError: class extends Error {}, ensureCreditDeviceReplacementSchema: async () => {},
      lockCreditDeviceReplacementImeiForCreditCreation: async () => {},
    },
    "@/lib/credit-factory": {
      generateCreditFolio: () => `FC-${nativeRequire("node:crypto").randomUUID()}`,
      generatePaymentReference: folio => folio, MAX_CREDIT_INSTALLMENTS: 36,
      sanitizeDeviceValue: value => String(value ?? "").trim(), sanitizeText: value => String(value ?? "").trim(),
    },
  });
}
export const catalogs = {
  aliado: { findMany: async () => [{ id: 2, nombre: "ALIADO PRUEBA", codigo: "ALLY", activo: true }] },
  sede: { findMany: async () => [{ id: 2, aliadoId: 2, nombre: "SEDE PRUEBA", codigo: "SEDE", activa: true }] },
  sedeVendedor: { findMany: async () => [{ sedeId: 2, vendedor: { id: 1, nombre: "VENDEDOR PRUEBA", documento: "12345", activo: true } }] },
};
export async function call(route, rows, options = {}) {
  const response = await route.POST(new Request("https://finserpay.test/api/creditos/masivos", {
    method: "POST", body: JSON.stringify({ rows, ...options }), headers: { "content-type": "application/json" },
  }));
  return { status: response.status, data: await response.json() };
}
export function postgresAdapter(pool, state = {}) {
  const adapter = client => ({
    ...catalogs,
    $queryRawUnsafe: async (sql, ...params) => {
      if (sql.includes('INSERT INTO "CreditSadminRegistration"')) {
        if (state.failRegistration || state.failRegistrationNumber === params[1]) throw new Error("Injected registration failure");
        await state.beforeRegistration?.();
      }
      return (await client.query(sql, params)).rows;
    },
    $executeRawUnsafe: async (sql, ...params) => {
      if (state.failAudit && sql.includes('INSERT INTO "CreditSadminEvent"')) throw new Error("Injected audit failure");
      return (await client.query(sql, params)).rowCount;
    },
    credito: {
      findMany: async ({ where }) => (await client.query(`SELECT "folio","imei","imei" AS "deviceUid" FROM "Credito" WHERE "imei"=ANY($1::text[]) AND "estado"<>'ANULADO'`, [where.OR[0].imei.in])).rows,
      findUnique: async ({ where }) => (await client.query('SELECT "id" FROM "Credito" WHERE "folio"=$1', [where.folio])).rows[0] || null,
      create: async ({ data }) => {
        // These assertions protect the historical-import approval/finance rules.
        assert.equal(data.estado, "GENERADO"); assert.equal(data.deliverableReady, false);
        assert.equal(data.equalityService, "IMPORTACION_MASIVA");
        const fields = ["folio", "clienteDocumento", "clienteNombre", "imei", "contratoSnapshot", "sedeId", "estado",
          "createdAt", "fechaCredito", "fechaPrimerPago", "fechaProximoPago", "montoCredito", "valorCuota", "plazoMeses",
          "frecuenciaPago", "cuotaInicial", "saldoBaseFinanciado", "valorEquipoTotal", "valorInteres"];
        data.createdAt = new Date();
        return (await client.query('INSERT INTO "Credito" (' + fields.map(key => '"' + key + '"').join(',') + ') VALUES (' +
          fields.map((_, i) => '$' + (i + 1)).join(',') + ') RETURNING "id","folio"', fields.map(key => data[key]))).rows[0];
      },
    },
  });
  return { ...adapter(pool), async $transaction(work) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await work(adapter(client)); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  } };
}
