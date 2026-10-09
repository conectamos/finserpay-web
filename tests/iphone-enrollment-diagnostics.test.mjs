import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

function load(path, dependencies = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    module: loadedModule, exports: loadedModule.exports, Date, Buffer, process,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return crypto;
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const normalizers = load("lib/iphone-enrollment.ts");
const lookup = { document: "10012345", imei: "351168083278358" };

async function harness(t, { applications = true, optional = true } = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT, "activo" BOOLEAN);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "activa" BOOLEAN);
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "rolId" INTEGER, "sedeId" INTEGER, "activo" BOOLEAN);
    INSERT INTO "Aliado" VALUES (1,'FINSERPAY',TRUE),(2,'ALIADO',TRUE),(3,'FINSERPAY',FALSE);
    INSERT INTO "Sede" VALUES (1,1,TRUE),(2,2,TRUE),(3,1,FALSE),(4,3,TRUE);
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION'),(3,'VENDEDOR');
    INSERT INTO "Usuario" VALUES (1,1,1,TRUE),(2,2,1,TRUE),(3,1,2,TRUE),(4,2,1,FALSE),(5,3,1,TRUE),(6,2,3,TRUE),(7,1,4,TRUE);
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY, "folio" TEXT, "clienteNombre" TEXT, "clienteDocumento" TEXT,
      "imei" TEXT, "deviceUid" TEXT, "estado" TEXT, "contratoSnapshot" JSONB, "updatedAt" TIMESTAMPTZ
    );
  `);
  if (applications) await db.exec(`
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY, "creditoId" INTEGER, "clienteNombre" TEXT, "clienteDocumento" TEXT,
      "imei" TEXT, "currentStep" INTEGER, "estado" TEXT, "plataforma" TEXT,
      "payload" JSONB DEFAULT '{}', "closedReason" TEXT, "dataCreditoStatus" TEXT,
      "createdAt" TIMESTAMPTZ DEFAULT '2026-10-01T00:00:00Z', "updatedAt" TIMESTAMPTZ DEFAULT '2026-10-09T12:00:00Z',
      "expiresAt" TIMESTAMPTZ DEFAULT '2099-10-01T00:00:00Z'
    );
  `);
  if (optional) await db.exec(`
    CREATE TABLE "FirmaSeguroProcess" (
      "id" INTEGER PRIMARY KEY, "draftId" INTEGER, "status" TEXT, "completedAt" TIMESTAMPTZ,
      "signedDocumentBase64" TEXT, "supersededAt" TIMESTAMPTZ, "createdAt" TIMESTAMPTZ
    );
    CREATE TABLE "VeriffIdentityValidation" ("id" INTEGER PRIMARY KEY, "draftId" INTEGER, "status" TEXT);
    CREATE TABLE "CreditDeviceReplacement" (
      "id" UUID PRIMARY KEY, "creditId" INTEGER, "solicitudId" INTEGER,
      "newImei" TEXT, "status" TEXT, "updatedAt" TIMESTAMPTZ
    );
  `);
  const queries = [];
  const adapter = connection => ({
    async $queryRawUnsafe(sql, ...params) {
      queries.push({ sql, params });
      return (await connection.query(sql, params)).rows;
    },
  });
  const transactionOptions = [];
  const prisma = { $transaction: (callback, options) => {
    transactionOptions.push(options);
    return db.transaction(tx => callback(adapter(tx)));
  } };
  const service = load("lib/iphone-enrollment-diagnostics.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/iphone-enrollment": normalizers,
  });
  const draft = async (id = 1, patch = {}) => {
    const row = { id, creditoId: null, clienteNombre: "Cliente guardado", clienteDocumento: lookup.document,
      imei: lookup.imei, currentStep: 4, estado: "ABIERTO", plataforma: "IPHONE", payload: {},
      dataCreditoStatus: "APROBADO", updatedAt: "2026-10-09T12:00:00Z", ...patch };
    const keys = Object.keys(row);
    await db.query(`INSERT INTO "CreditoBorrador" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, keys.map(key => row[key]));
  };
  const credit = async (id = 77, patch = {}) => {
    const row = { id, folio: `FC-${id}`, clienteNombre: "Cliente histórico", clienteDocumento: lookup.document,
      imei: lookup.imei, deviceUid: lookup.imei, estado: "ACTIVO", contratoSnapshot: { equipo: { plataforma: "IPHONE" }, secreto: "NO EXPONER" },
      updatedAt: "2026-10-09T12:00:00Z", ...patch };
    const keys = Object.keys(row);
    await db.query(`INSERT INTO "Credito" (${keys.map(key => `"${key}"`).join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`, keys.map(key => row[key]));
  };
  return { db, queries, transactionOptions, service, draft, credit, search: (input = lookup, actor = { userId: 2 }) => service.lookupNominalIphoneEnrollmentDiagnostics(input, actor) };
}

test("la pareja exacta devuelve la etapa real sin revelar coincidencias amplias", async t => {
  const f = await harness(t);
  await f.draft();
  await f.draft(2, { imei: "350000000000002", clienteNombre: "Otro cliente por cédula" });
  await f.draft(3, { clienteDocumento: "10099999", clienteNombre: "Otro cliente por IMEI" });
  const result = await f.search();
  assert.equal(result.kind, "EXACT_MATCH");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].currentStep, 4);
  assert.equal(result.candidates[0].stepLabel, "Identidad y firma");
  assert.equal(result.candidates[0].matchedBy, "BOTH");
  assert.equal(result.candidates[0].document, lookup.document);
  assert.equal(result.candidates[0].solicitudNumero, "SOL-000001");
  assert.match(result.candidates[0].pendingReason, /Todavía no está en Enrolamiento y entrega/);
  assert.equal(f.queries.filter(query => query.sql.startsWith("WITH cases")).length, 1);
  assert.equal(f.transactionOptions[0].isolationLevel, "RepeatableRead");
});

test("la discrepancia muestra CC e IMEI guardados y la causa exacta de cada coincidencia", async t => {
  const f = await harness(t);
  await f.draft(1, { imei: "350000000000001", updatedAt: "2026-10-08T00:00:00Z" });
  await f.draft(2, { clienteDocumento: "10099999", updatedAt: "2026-10-09T00:00:00Z" });
  const result = await f.search({ document: "10.012.345", imei: "351 168 083 278 358" });
  assert.equal(result.kind, "MISMATCH");
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].matchedBy, "IMEI");
  assert.equal(result.candidates[0].document, "10099999");
  assert.equal(result.candidates[1].matchedBy, "DOCUMENT");
  assert.equal(result.candidates[1].imei, "350000000000001");
  assert.equal(f.queries.filter(query => query.sql.startsWith("WITH cases")).length, 2);
});

test("el paso 5 con validación facial pendiente no se informa como paso 4", async t => {
  const f = await harness(t);
  await f.draft(1, { currentStep: 5 });
  await f.db.exec(`
    INSERT INTO "FirmaSeguroProcess" VALUES (1,1,'SIGNED','2026-10-09T00:00:00Z','SECRETO',NULL,'2026-10-09T00:00:00Z');
    INSERT INTO "VeriffIdentityValidation" VALUES (1,1,'PENDING');
  `);
  const item = (await f.search()).candidates[0];
  assert.equal(item.currentStep, 5);
  assert.equal(item.stepLabel, "Enrolamiento y entrega");
  assert.match(item.pendingReason, /validación facial/);
  assert.doesNotMatch(JSON.stringify(item), /SECRETO|signedDocumentBase64|caseToken|documentHash|veriffStatus/);
  await f.db.exec(`UPDATE "VeriffIdentityValidation" SET "status"='APPROVED'`);
  const storedApproved = (await f.search()).candidates[0];
  assert.match(storedApproved.pendingReason, /verificarse la autorización/);
  assert.doesNotMatch(storedApproved.pendingReason, /lista para enrolar/i);
});

test("la firma incompleta vigente se distingue de la etapa aunque exista una firma anterior", async t => {
  const f = await harness(t);
  await f.draft(1, { currentStep: 5 });
  await f.db.exec(`
    INSERT INTO "FirmaSeguroProcess" VALUES
      (1,1,'SIGNED','2026-10-08T00:00:00Z','ANTERIOR','2026-10-09T00:00:00Z','2026-10-08T00:00:00Z'),
      (2,1,'PENDING',NULL,NULL,NULL,'2026-10-09T00:00:00Z');
    INSERT INTO "VeriffIdentityValidation" VALUES (1,1,'APPROVED');
  `);
  const item = (await f.search()).candidates[0];
  assert.equal(item.currentStep, 5);
  assert.match(item.pendingReason, /FirmaSeguro no registra un contrato firmado/);
});

test("el diagnóstico nominal no concede datos a un aliado, rol incorrecto ni cuentas inactivas", async t => {
  const f = await harness(t);
  await f.draft();
  for (const userId of [3, 4, 5, 6, 7, 999]) {
    f.queries.length = 0;
    await assert.rejects(f.search(lookup, { userId }), error => error.code === "FORBIDDEN" && error.status === 403);
    assert.equal(f.queries.length, 1);
    assert.match(f.queries[0].sql, /FOR SHARE OF u, r, s, a/);
    assert.doesNotMatch(f.queries[0].sql, /CreditoBorrador|FROM "Credito"/);
  }
  const central = await f.search(lookup, { userId: 1 });
  assert.equal(central.kind, "EXACT_MATCH");
});

test("los identificadores inválidos o un actor compartido no inician consultas de datos", async t => {
  const f = await harness(t);
  for (const input of [{ ...lookup, imei: "123" }, { ...lookup, document: "---" }, { ...lookup, document: "1".repeat(81) }, { ...lookup, imei: "1".repeat(41) }]) {
    await assert.rejects(f.search(input), error => error.code === "INVALID_LOOKUP" && error.status === 400);
  }
  for (const userId of [null, 0, -1, 1.1, "2", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(f.search(lookup, { userId }), error => error.code === "FORBIDDEN");
  }
  assert.equal(f.queries.length, 0);
});

test("limita los resultados y el orden es determinista sin modificar registros", async t => {
  const f = await harness(t);
  for (let id = 1; id <= 8; id++) await f.draft(id, { imei: `35000000000000${id}` });
  const result = await f.search();
  assert.equal(result.kind, "MISMATCH");
  assert.equal(result.candidates.length, 6);
  assert.equal(result.hasMore, true);
  assert.equal(result.candidates.map(item => item.sourceId).join(","), "1,2,3,4,5,6");
  assert.ok(f.queries.every(({ sql }) => !/\b(UPDATE|INSERT|DELETE|CREATE|ALTER|DROP)\b/i.test(sql)));
});

test("el crédito histórico y la garantía muestran sus propios identificadores y estados", async t => {
  const f = await harness(t);
  await f.credit();
  await f.draft(9, { creditoId: 77, currentStep: 5, estado: "CERRADO" });
  const historical = await f.search();
  assert.equal(historical.candidates.length, 1);
  assert.equal(historical.candidates[0].source, "CREDIT");
  assert.equal(historical.candidates[0].creditoFolio, "FC-77");
  assert.equal(historical.candidates[0].solicitudId, 9);
  assert.equal(historical.candidates[0].currentStep, 5);
  assert.equal(historical.candidates[0].platform, "IPHONE");
  assert.match(historical.candidates[0].pendingReason, /crédito ya fue creado/);
  assert.doesNotMatch(JSON.stringify(historical), /NO EXPONER|contratoSnapshot|payload/);
  await f.db.query(`INSERT INTO "CreditDeviceReplacement" VALUES ($1,77,9,'350000000000099','COMPLETED','2026-10-09T13:00:00Z')`, ["00000000-0000-4000-8000-000000000099"]);
  const replacement = await f.search({ ...lookup, imei: "350000000000099" });
  assert.equal(replacement.kind, "EXACT_MATCH");
  assert.equal(replacement.candidates.length, 1);
  assert.equal(replacement.candidates[0].source, "DEVICE_REPLACEMENT");
  assert.equal(replacement.candidates[0].sourceId, "00000000-0000-4000-8000-000000000099");
  assert.equal(replacement.candidates[0].status, "COMPLETED");
  assert.match(replacement.candidates[0].pendingReason, /ya fue completado/);
});

test("funciona con registros históricos cuando las tablas opcionales aún no existen", async t => {
  const f = await harness(t, { applications: false, optional: false });
  await f.credit(77, { imei: "", deviceUid: lookup.imei });
  const result = await f.search();
  assert.equal(result.kind, "EXACT_MATCH");
  assert.equal(result.candidates[0].currentStep, null);
  assert.equal(result.candidates[0].stepLabel, "Crédito creado");
  assert.equal(result.candidates[0].imei, lookup.imei);
  const none = await f.search({ document: "99999999", imei: "350000000000001" });
  assert.equal(none.kind, "NOT_FOUND");
  assert.equal(none.candidates.length, 0);
  assert.equal(none.hasMore, false);
});

test("la búsqueda pública no incorpora el diagnóstico nominal ni cambia sus autorizaciones", () => {
  const storage = readFileSync(new URL("../lib/iphone-enrollment-storage.ts", import.meta.url), "utf8");
  assert.doesNotMatch(storage, /iphone-enrollment-diagnostics|lookupNominalIphoneEnrollmentDiagnostics/);
  assert.match(storage, /hasAuthorizedVeriffApprovalForEnrollment/);
  assert.match(storage, /authoritativeFirmaSeguroWhere/);
});
