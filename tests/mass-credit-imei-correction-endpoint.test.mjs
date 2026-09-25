import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { load } from "./mass-credit-sadmin-fixture.mjs";
import pg from "pg";
import { creditMassImeiCorrectionSchemaStatements } from "../scripts/credit-mass-imei-correction-schema.mjs";

function validImei(index) {
  const base = String(index).padStart(14, "0");
  let sum = 0;
  for (let position = 0; position < base.length; position += 1) {
    let digit = Number(base[position]);
    if (position % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return base + String((10 - (sum % 10)) % 10);
}
const realImei = validImei(35824005111111);
const secondImei = validImei(35824005111112);
const target = (changes = {}) => ({
  creditoId: 11,
  sadminNumber: "0000123",
  clienteDocumento: "900001",
  creditoCreado: true,
  numeroCreditoConfirmado: true,
  folio: "FC-11",
  previousImei: "100000000000001",
  previousDeviceUid: "100000000000001",
  estado: "GENERADO",
  equalityService: "IMPORTACION_MASIVA",
  importSource: "IMPORTACION_MASIVA",
  pending: "true",
  ...changes,
});
function database(targets = [target()]) {
  const state = { targets, audit: [], updates: [], locks: [] };
  const db = {
    async $queryRawUnsafe(sql, ...params) {
      if (sql.includes('FROM "CreditSadminRegistration"')) {
        return state.targets.filter((row) => params[0].includes(row.sadminNumber.toLowerCase()));
      }
      if (sql.includes('FROM "CreditMassImeiCorrection"')) {
        return state.audit.filter((row) => row.requestId === params[0]);
      }
      if (sql.startsWith('UPDATE "Credito"')) {
        const row = state.targets.find((item) => item.creditoId === params[1]);
        if (!row || row.pending !== "true" || row.previousImei !== params[2]) return [];
        row.previousImei = params[0];
        row.previousDeviceUid = params[0];
        row.pending = "false";
        state.updates.push(params);
        return [{ id: row.creditoId }];
      }
      if (sql.includes('FROM "CreditoBorrador"') ||
          sql.includes('FROM "CreditDeviceReplacement"') ||
          sql.includes('UNION ALL SELECT credit."folio"')) return [];
      throw new Error("Unexpected query: " + sql.slice(0, 80));
    },
    async $executeRawUnsafe(sql, ...params) {
      if (sql.includes("pg_advisory_xact_lock")) {
        state.locks.push(params[0]); return 1;
      }
      if (sql.includes('INSERT INTO "CreditMassImeiCorrection"')) {
        state.audit.push({
          creditoId: params[1],
          requestId: params[2],
          requestHash: params[3],
          rowNumber: params[4],
          numeroCreditoSadmin: params[5],
          clienteDocumento: params[6],
          previousImei: params[7],
          newImei: params[8],
          folio: state.targets.find((row) => row.creditoId === params[1]).folio,
        });
        return 1;
      }
      throw new Error("Unexpected execution: " + sql.slice(0, 80));
    },
    async $transaction(work) { return work(db); },
  };
  return { db, state };
}
function service(db, locks) {
  const isValid = value => /^\d{15}$/.test(value) && validImei(value.slice(0, 14)) === value;
  return load("lib/credit-mass-imei-correction.ts", {
    "@/lib/prisma": { __esModule: true, default: db },
    "@/lib/credit-device-replacement": { isValidCreditDeviceReplacementImei: isValid },
    "@/lib/credit-device-replacement-storage": {
      ensureCreditDeviceReplacementSchema: async () => {},
      lockCreditDeviceReplacementImeiForCreditCreation: async (_db, row) => {
        locks.push(row.imei);
      },
    },
    "@/lib/credit-import-flags": { MASS_CREDIT_SOURCE: "IMPORTACION_MASIVA" },
    "@/lib/mass-credit-sadmin": {
      importDocument: value => String(value ?? "").replace(/\D/g, "").replace(/^0+/, ""),
    },
  });
}

test("previsualización rechaza duplicados por número SADMIN e IMEI antes de actualizar", async () => {
  const { db, state } = database();
  const api = service(db, []);
  const rows = api.parseMassImeiCorrectionRows([
    { numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei },
    { numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei },
  ]);
  const preview = await api.previewMassImeiCorrections(rows);
  assert.equal(preview.summary.invalid, 2);
  assert.match(preview.rows[0].errors.join(" "), /SADMIN repetido/);
  assert.match(preview.rows[1].errors.join(" "), /IMEI nuevo repetido/);
  assert.equal(state.updates.length, 0);
});

test("solo corrige créditos históricos con marca explícita pendiente", async () => {
  const { db } = database([target({ pending: "false" })]);
  const api = service(db, []);
  const preview = await api.previewMassImeiCorrections([
    { numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei },
  ]);
  assert.equal(preview.summary.invalid, 1);
  assert.match(preview.rows[0].errors.join(" "), /no tiene una corrección/);
});

test("confirmación actualiza IMEI y deja bitácora inmutable con reintento idempotente", async () => {
  const { db, state } = database([
    target(),
    target({
      creditoId: 12, sadminNumber: "0000124", clienteDocumento: "900002", folio: "FC-12",
      previousImei: "100000000000002", previousDeviceUid: "100000000000002",
    }),
  ]);
  const locks = [];
  const api = service(db, locks);
  const rows = [
    { numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei },
    { numeroCreditoSadmin: "0000124", cedula: "900002", nuevoImei: secondImei },
  ];
  const requestId = randomUUID();
  const input = { rows, requestId, actor: { id: 1, nombre: "Administradora" } };
  const created = await api.confirmMassImeiCorrections(input);
  assert.equal(created.commit, true);
  assert.equal(created.corrected, 2);
  assert.equal(state.updates.length, 2);
  assert.equal(state.audit.length, 2);
  assert.equal(state.audit[0].previousImei, "100000000000001");
  assert.equal(state.audit[0].clienteDocumento, "900001");
  assert.deepEqual(locks, [realImei, secondImei].sort());
  const retry = await api.confirmMassImeiCorrections(input);
  assert.equal(retry.corrected, 2);
  assert.equal(state.audit.length, 2);
  assert.equal(state.updates.length, 2);
});

test("el esquema de auditoría se instala en predeploy, se empaqueta y bloquea cambios", async () => {
  const [schema, predeploy, docker] = await Promise.all([
    readFile(new URL("../scripts/credit-mass-imei-correction-schema.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/railway-predeploy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /CreditMassImeiCorrection_immutable/);
  assert.match(schema, /BEFORE UPDATE OR DELETE/);
  assert.match(schema, /BEFORE TRUNCATE/);
  assert.match(schema, /"requestId", "rowNumber"/);
  assert.match(schema, /"clienteDocumento" VARCHAR\(80\) NOT NULL/);
  assert.match(predeploy, /ensure-credit-mass-imei-correction-schema/);
  assert.match(docker, /credit-mass-imei-correction-schema\.mjs/);
  assert.match(docker, /ensure-credit-mass-imei-correction-schema\.mjs/);
});

test("la ruta exige administrador central y confirmación explícita antes de modificar", async () => {
  let user = null;
  let confirmations = 0;
  const route = load("app/api/creditos/masivos/correcciones-imei/route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/auth": { getSessionUser: async () => user },
    "@/lib/aliados": { isFinserPayCentralAlly: value => value === "FINSERPAY" },
    "@/lib/roles": { isAdminRole: value => value === "ADMIN" },
    "@/lib/credit-device-replacement-storage": { CreditDeviceReplacementError: class extends Error {} },
    "@/lib/credit-mass-imei-correction": {
      MassImeiCorrectionError: class extends Error {},
      parseMassImeiCorrectionRows: rows => rows,
      previewMassImeiCorrections: async rows => ({ ok: true, commit: false, rows }),
      confirmMassImeiCorrections: async () => {
        confirmations += 1;
        return { ok: true, commit: true };
      },
    },
  });
  const rows = [{ numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei }];
  const call = async body => {
    const response = await route.POST(new Request("https://finserpay.test/api/creditos/masivos/correcciones-imei", {
      method: "POST",
      body: JSON.stringify(body),
    }));
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call({ commit: false, rows })).status, 401);
  user = { id: 1, nombre: "Admin", rolNombre: "ADMIN", aliadoAccesoCodigo: "OTRO" };
  assert.equal((await call({ commit: false, rows })).status, 403);
  user.aliadoAccesoCodigo = "FINSERPAY";
  assert.equal((await call({ commit: true, rows, requestId: randomUUID(), confirmed: false })).status, 400);
  assert.equal(confirmations, 0);
  assert.equal((await call({ commit: true, rows, requestId: randomUUID(), confirmed: true })).status, 200);
  assert.equal(confirmations, 1);
});

test("la cédula debe coincidir con el crédito de SADMIN antes de actualizar", async () => {
  const { db, state } = database();
  const api = service(db, []);
  assert.throws(
    () => api.parseMassImeiCorrectionRows([
      { numeroCreditoSadmin: "0000123", nuevoImei: realImei },
    ]),
    /numeroCreditoSadmin, cedula y nuevoImei/
  );
  const wrong = api.parseMassImeiCorrectionRows([
    { numeroCreditoSadmin: "0000123", cedula: "900099", nuevoImei: realImei },
  ]);
  const preview = await api.previewMassImeiCorrections(wrong);
  assert.equal(preview.summary.invalid, 1);
  assert.match(preview.rows[0].errors.join(" "), /cédula no coincide/);
  const denied = await api.confirmMassImeiCorrections({
    rows: wrong,
    requestId: randomUUID(),
    actor: { id: 1, nombre: "Administradora" },
  });
  assert.equal(denied.commit, false);
  assert.equal(state.updates.length, 0);
  assert.equal(state.audit.length, 0);

  const formatted = api.parseMassImeiCorrectionRows([
    { numeroCreditoSadmin: "0000123", cedula: "09.000-01", nuevoImei: realImei },
  ]);
  assert.equal((await api.previewMassImeiCorrections(formatted)).summary.valid, 1);
});

const isolatedPostgres = process.env.MASS_CREDIT_CORRECTION_TEST_DATABASE_URL;
test("PostgreSQL aislado: fallo en segunda fila revierte ambos IMEI y su auditoría", {
  skip: !isolatedPostgres && "Requiere mass_credit_imei_correction_test en PostgreSQL local",
}, async (t) => {
  const url = new URL(isolatedPostgres);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  assert.equal(url.pathname, "/mass_credit_imei_correction_test");

  const bootstrap = new pg.Client({ connectionString: isolatedPostgres });
  await bootstrap.connect();
  assert.equal(
    (await bootstrap.query("SELECT current_database() AS name")).rows[0].name,
    "mass_credit_imei_correction_test"
  );
  const schema = "credit_mass_imei_correction_" + randomUUID().replaceAll("-", "").slice(0, 12);
  const namespace = '"' + schema + '"';
  let pool;
  let schemaCreated = false;
  t.after(async () => {
    if (pool) await pool.end();
    if (schemaCreated) await bootstrap.query("DROP SCHEMA " + namespace + " CASCADE");
    await bootstrap.end();
  });

  await bootstrap.query("CREATE SCHEMA " + namespace);
  schemaCreated = true;
  for (const sql of [
    'CREATE TABLE ' + namespace + '."Usuario" ("id" INTEGER PRIMARY KEY)',
    'CREATE TABLE ' + namespace + '."Credito" (' +
      '"id" INTEGER PRIMARY KEY, "folio" TEXT NOT NULL, "clienteDocumento" TEXT, ' +
      '"imei" TEXT NOT NULL, "deviceUid" TEXT NOT NULL, "estado" TEXT NOT NULL, ' +
      '"equalityService" TEXT, "contratoSnapshot" JSONB, "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE ' + namespace + '."CreditSadminRegistration" (' +
      '"creditoId" INTEGER NOT NULL, "numeroCredito" TEXT NOT NULL, ' +
      '"creditoCreado" BOOLEAN NOT NULL, "numeroCreditoConfirmado" BOOLEAN NOT NULL)',
    'CREATE TABLE ' + namespace + '."CreditoBorrador" (' +
      '"id" INTEGER PRIMARY KEY, "imei" TEXT, "estado" TEXT, "creditoId" INTEGER, ' +
      '"expiresAt" TIMESTAMP, "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE ' + namespace + '."CreditDeviceReplacement" (' +
      '"id" UUID PRIMARY KEY, "newImei" TEXT, "status" TEXT)',
  ]) await bootstrap.query(sql);
  await bootstrap.query('INSERT INTO ' + namespace + '."Usuario" ("id") VALUES (1)');
  for (const statement of creditMassImeiCorrectionSchemaStatements) {
    await bootstrap.query(statement.replaceAll("public.", namespace + "."));
  }

  const original = ["100000000000001", "100000000000002"];
  for (let index = 0; index < 2; index += 1) {
    await bootstrap.query(
      'INSERT INTO ' + namespace + '."Credito" ' +
        '("id", "folio", "clienteDocumento", "imei", "deviceUid", "estado", ' +
        '"equalityService", "contratoSnapshot") ' +
        'VALUES ($1,$2,$3,$4,$4,$5,$6,$7::jsonb)',
      [index + 11, "FC-" + String(index + 11), "90000" + String(index + 1),
        original[index], "GENERADO", "IMPORTACION_MASIVA",
        JSON.stringify({ origen: {
          tipo: "IMPORTACION_MASIVA",
          imeiTemporalPendienteCorreccion: true,
        }, equipo: { imei: original[index], imeiTemporal: true } })]
    );
    await bootstrap.query(
      'INSERT INTO ' + namespace + '."CreditSadminRegistration" ' +
        '("creditoId", "numeroCredito", "creditoCreado", "numeroCreditoConfirmado") ' +
        'VALUES ($1,$2,true,true)',
      [index + 11, "000012" + String(index + 3)]
    );
  }

  pool = new pg.Pool({ connectionString: isolatedPostgres, max: 2 });
  let injectSecondAuditFailure = true;
  let auditInsertCount = 0;
  const db = {
    async $transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL search_path TO " + namespace);
        const transaction = {
          $queryRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rows,
          $executeRawUnsafe: async (sql, ...params) => {
            if (sql.includes('INSERT INTO "CreditMassImeiCorrection"')) {
              auditInsertCount += 1;
              if (injectSecondAuditFailure && auditInsertCount === 2) {
                throw new Error("Fallo de auditoría inyectado en segunda fila");
              }
            }
            return (await client.query(sql, params)).rowCount;
          },
        };
        const value = await work(transaction);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  const api = service(db, []);
  const input = {
    requestId: randomUUID(),
    actor: { id: 1, nombre: "Administradora" },
    rows: [
      { numeroCreditoSadmin: "0000123", cedula: "900001", nuevoImei: realImei },
      { numeroCreditoSadmin: "0000124", cedula: "900002", nuevoImei: secondImei },
    ],
  };
  await assert.rejects(api.confirmMassImeiCorrections(input), /Fallo de auditoría/);
  const afterFailure = await bootstrap.query(
    'SELECT "imei", "deviceUid", "contratoSnapshot"#>>\'{origen,imeiTemporalPendienteCorreccion}\' AS pending ' +
      'FROM ' + namespace + '."Credito" ORDER BY "id"'
  );
  assert.deepEqual(afterFailure.rows.map(row => row.imei), original);
  assert.ok(afterFailure.rows.every(row => row.imei === row.deviceUid && row.pending === "true"));
  assert.equal(
    Number((await bootstrap.query('SELECT COUNT(*) AS count FROM ' + namespace + '."CreditMassImeiCorrection"')).rows[0].count),
    0
  );

  injectSecondAuditFailure = false;
  const success = await api.confirmMassImeiCorrections(input);
  assert.equal(success.corrected, 2);
  assert.equal(
    Number((await bootstrap.query('SELECT COUNT(*) AS count FROM ' + namespace + '."CreditMassImeiCorrection"')).rows[0].count),
    2
  );
});
