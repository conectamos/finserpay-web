import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";

class CreditApprovalError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function load(path, dependencies = {}) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    exports: module.exports, module, Buffer, Date, Intl, Map, URLSearchParams,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return { createHash, randomUUID };
      assert.ok(name in dependencies, `Dependencia inesperada de ${path}: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports;
}
const dates = load("lib/colombia-date.ts");
const displayNumbers = load("lib/credit-display-number.ts");
const access = load("lib/analyst-mora-access.ts", {
  "@/lib/auth": {}, "@/lib/approval-shared-session": {}, "@/lib/roles": {},
  "@/lib/credit-approval-errors": { CreditApprovalError },
});
const analyst = { id: 2, nombre: "Nombre de sesión", centralAdmin: false };
const central = { id: 1, nombre: "Administrador", centralAdmin: true };
const now = new Date("2026-10-08T16:00:00Z");
const statuses = ["PENDING", "PENDING", "APPROVED", "REJECTED", "EXPIRED", "REPLACED", "APPROVED"];

async function fixture(t) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "folio" TEXT, "clienteNombre" TEXT, "clienteDocumento" TEXT);
    CREATE TABLE "CreditSadminRegistration" ("creditoId" INTEGER PRIMARY KEY REFERENCES "Credito"("id"),
      "numeroCredito" TEXT, "numeroCreditoConfirmado" BOOLEAN);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT, "activo" BOOLEAN);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "activa" BOOLEAN);
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT, "rolId" INTEGER, "sedeId" INTEGER, "activo" BOOLEAN);
    CREATE TABLE "CreditoAbono" ("creditoId" INTEGER, "valor" NUMERIC(20,2), "estado" TEXT, "fechaAbono" TIMESTAMP);
    INSERT INTO "Aliado" VALUES (1,'FINSERPAY',TRUE),(2,'ALIADO',TRUE);
    INSERT INTO "Sede" VALUES (1,1,TRUE),(2,2,TRUE);
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION');
    INSERT INTO "Usuario" VALUES (1,'Administrador real',1,1,TRUE),(2,'Analista real',2,1,TRUE),(3,'Admin aliado',1,2,TRUE);
  `);
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => database.query(sql, params) });
  const credits = new Map();
  const ids = [];
  for (let i = 1; i <= statuses.length; i++) {
    const folio = `000-FC-${String(i).padStart(3, "0")}`;
    const document = i === 1 ? "00.123.456" : `000100${String(i).padStart(3, "0")}`;
    const name = i <= 3 ? `Cliente grupo ${i}` : `Persona ${i}`;
    await database.query('INSERT INTO "Credito" VALUES ($1,$2,$3,$4)', [i, folio, name, document]);
    const registration = i === 1 ? { numeroCredito: "000030000000000000000085", numeroCreditoConfirmado: true }
      : i === 2 ? { numeroCredito: "000999999", numeroCreditoConfirmado: false }
        : i === 3 ? { numeroCredito: "   ", numeroCreditoConfirmado: true } : null;
    if (registration) await database.query('INSERT INTO "CreditSadminRegistration" VALUES ($1,$2,$3)',
      [i, registration.numeroCredito, registration.numeroCreditoConfirmado]);
    credits.set(i, { id: i, folio, clienteNombre: name, clienteDocumento: document,
      clienteTelefono: "003005678901", equipo: "Equipo real", imei: "000123456789012",
      aliadoId: 8, aliadoNombre: "Aliado real", registroSadmin: registration, abonos: [],
      valorCuota: 200, pazYSalvoEmitidoAt: null });
    const id = randomUUID(); ids.push(id);
    const createdAt = new Date(`2026-10-07T${String(10 + i).padStart(2, "0")}:00:00Z`).toISOString();
    await database.query(`INSERT INTO "CreditMoraExceptionRequest"
      ("id","creditoId","type","status","installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",
       "reason","observation","createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","decisionReason",
       "createIdempotencyKey","createRequestHash","createdAt","updatedAt","submittedAt")
      VALUES ($1::uuid,$2,$3,$4,1,'2026-10-02',$5::date,100,$5::date,'Motivo histórico','Observación histórica',
       2,'Analista histórico',$6,$7,$8::timestamptz,$9,$10::uuid,$11,$12::timestamptz,$12::timestamptz,$12::timestamptz)`,
    [id, i, i % 2 ? "EXCEPCION" : "PRORROGA", statuses[i - 1],
      statuses[i - 1] === "EXPIRED" ? "2026-10-06" : "2026-10-21",
      statuses[i - 1] === "PENDING" ? null : 1, statuses[i - 1] === "PENDING" ? null : "Administrador histórico",
      statuses[i - 1] === "PENDING" ? null : createdAt, statuses[i - 1] === "PENDING" ? null : "Decisión histórica",
      randomUUID(), "a".repeat(64), createdAt]);
  }
  await database.query(`INSERT INTO "CreditMoraExceptionEvent"
    ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","requestHash","createdAt")
    VALUES ($1::uuid,$2::uuid,1,1,'SUBMITTED',NULL,'PENDING','{"reason":"Motivo histórico"}'::jsonb,2,'Analista histórico',$3,'2026-10-07T11:00:00Z')`,
  [randomUUID(), ids[0], "b".repeat(64)]);
  const queries = [];
  const adapter = db => ({
    async $queryRawUnsafe(sql, ...params) { queries.push({ sql, params }); return (await db.query(sql, params)).rows; },
    credito: { findUnique: async ({ where }) => credits.get(where.id) || null },
  });
  const prisma = { ...adapter(database), $transaction: callback => database.transaction(db => callback(adapter(db))) };
  let supportsReads = 0;
  const service = load("lib/mora-exception-requests.ts", {
    "@/lib/prisma": { default: prisma }, "@/lib/analyst-mora-access": access,
    "@/lib/analyst-mora-management": { listMoraPortfolio: async () => ({ items: [], hasMore: false }) },
    "@/lib/analyst-mora-credit": { moraCreditSelect: {}, moraCreditSummary: credit => ({ ...credit,
      numeroCreditoVisible: displayNumbers.confirmedSadminNumber(credit.registroSadmin) || credit.folio }),
      readMoraCredit: async id => credits.get(id) || null },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-support": { listMoraSupports: async input => {
      supportsReads++; return [{ id: "soporte-existente", creditoId: input.creditoId, originalName: "evidencia.pdf" }];
    } },
    "@/lib/colombia-date": dates, "@/lib/credit-display-number": displayNumbers,
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: () => ({ estadoPago: "MORA",
      installments: [{ numero: 1, fechaVencimiento: "2026-10-02", eliminada: false, saldoPendiente: 200 }] }) },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
  const list = params => service.listMoraExceptionRequests(new URLSearchParams(params), analyst, now);
  return { database, credits, ids, queries, service, list, supportsReads: () => supportsReads };
}

test("búsqueda real textual por nombre, cédula, folio y Sadmin confirmado conserva ceros", async t => {
  const f = await fixture(t);
  for (const q of ["CLIENTE GRUPO 1", "00123456", "00.123.456", "000-FC-001", "000030000000000000000085"]) {
    const result = await f.list({ q, page: "1", pageSize: "25" });
    assert.equal(result.total, 1, q);
    assert.equal(result.items[0].creditoId, 1, q);
    assert.equal(result.items[0].credit.numeroSadmin, "000030000000000000000085");
    assert.equal(result.items[0].credit.folio, "000-FC-001");
    assert.equal(typeof result.items[0].credit.clienteDocumento, "string");
  }
  for (const q of ["000999999", "%", "' OR TRUE --", "no existe"]) assert.equal((await f.list({ q })).total, 0, q);
  const pending = await f.list({ q: "000-FC-002" });
  assert.equal(pending.items[0].credit.numeroSadmin, null);
  assert.equal(pending.items[0].status, "PENDING");
  assert.equal((await f.list({ q: "000-FC-003" })).items[0].credit.numeroSadmin, null);
  assert.equal((await f.list({ q: "000-FC-004" })).items[0].credit.numeroSadmin, null);
});

test("el total combina filtros antes de paginar, sin duplicados ni cambiar históricos", async t => {
  const f = await fixture(t);
  const historicalBefore = (await f.database.query('SELECT * FROM "CreditMoraExceptionRequest" ORDER BY "id"')).rows;
  const eventsBefore = (await f.database.query('SELECT * FROM "CreditMoraExceptionEvent" ORDER BY "id"')).rows;
  const found = [];
  for (let page = 1; page <= 4; page++) {
    const result = await f.list({ page: String(page), pageSize: "2" });
    assert.equal(result.total, 7); assert.equal(result.totalPages, 4);
    assert.equal(result.page, page); assert.equal(result.pageSize, 2);
    assert.equal(result.hasMore, page < 4);
    found.push(...result.items.map(item => item.creditoId));
  }
  assert.deepEqual(found, [7, 6, 5, 4, 3, 2, 1]);
  const matched = await f.list({ q: "cliente grupo", type: "EXCEPCION", page: "2", pageSize: "1" });
  assert.equal(matched.total, 2); assert.equal(matched.items[0].creditoId, 1);
  assert.equal((await f.list({ page: "99", pageSize: "25" })).items.length, 0);
  assert.equal((await f.list({ page: "99", pageSize: "25" })).total, 7);
  const empty = await f.list({ q: "sin coincidencias", page: "1", pageSize: "25" });
  assert.equal(empty.total, 0); assert.equal(empty.totalPages, 0); assert.equal(empty.nextCursor, null);
  assert.deepEqual((await f.database.query('SELECT * FROM "CreditMoraExceptionRequest" ORDER BY "id"')).rows, historicalBefore);
  assert.deepEqual((await f.database.query('SELECT * FROM "CreditMoraExceptionEvent" ORDER BY "id"')).rows, eventsBefore);
});

test("conserva todos los estados/tipos y consumidores de cursor/limit", async t => {
  const f = await fixture(t);
  for (const status of [...new Set(statuses)]) {
    const result = await f.list({ status });
    assert.equal(result.total, statuses.filter(item => item === status).length);
    assert.ok(result.items.every(item => item.status === status));
  }
  assert.equal((await f.list({ type: "EXCEPCION" })).total, 4);
  assert.equal((await f.list({ type: "PRORROGA" })).total, 3);
  const first = await f.list({ limit: "2" });
  const next = await f.list({ limit: "2", cursor: first.nextCursor });
  assert.equal(first.total, 7); assert.equal(next.total, 7);
  assert.deepEqual(first.items.map(item => item.creditoId), [7, 6]);
  assert.deepEqual(next.items.map(item => item.creditoId), [5, 4]);
  assert.equal(next.hasMore, true);
  const preflight = await f.list({ creditoId: "1", limit: "50" });
  assert.equal(preflight.total, 1);
  assert.equal(preflight.credit.numeroSadmin, "000030000000000000000085");
  assert.equal(preflight.credit.folio, "000-FC-001");
  assert.equal(preflight.eligibility.maxExpiresOn, "2026-10-06");
  assert.equal(preflight.eligibility.prorroga.canRequest, false);
});

test("detalle devuelve soportes e historial existentes junto a identidad completa y Sadmin separado", async t => {
  const f = await fixture(t);
  const result = await f.service.getMoraExceptionRequest(f.ids[0], analyst, now);
  assert.equal(result.item.credit.numeroSadmin, "000030000000000000000085");
  assert.equal(result.item.credit.folio, "000-FC-001");
  assert.equal(result.credit.clienteTelefono, "003005678901");
  assert.equal(result.item.credit.imei, "000123456789012");
  assert.equal(result.item.credit.aliadoNombre, "Aliado real");
  assert.equal(result.history[0].actorName, "Analista histórico");
  assert.equal(result.history[0].action, "SUBMITTED");
  assert.equal(result.supports[0].originalName, "evidencia.pdf");
  assert.equal(f.supportsReads(), 1);
  const without = await f.service.getMoraExceptionRequest(f.ids[1], analyst, now);
  assert.equal(without.credit.numeroSadmin, null); assert.equal(without.item.credit.numeroSadmin, null);
  assert.equal(without.item.status, "PENDING");
  await assert.rejects(f.service.getMoraExceptionRequest(randomUUID(), analyst, now), { code: "MORA_EXCEPTION_NOT_FOUND" });
});

test("validación server rechaza filtros/paginación malformados antes de leer resultados", async t => {
  const f = await fixture(t);
  for (const params of [{ status: "inventado" }, { type: "inventado" }, { q: "x".repeat(101) }, { q: "bad\0query" },
    { page: "0" }, { page: "1.5" }, { pageSize: "101" }, { pageSize: "0" }, { pageSize: "NaN" },
    { limit: "-1" }, { creditoId: "0" }, { cursor: "invalido" },
    { page: "1", cursor: Buffer.from(JSON.stringify({ createdAt: now.toISOString(), id: f.ids[0] })).toString("base64url") }]) {
    await assert.rejects(f.list(params));
  }
  assert.equal(f.queries.length, 0);
});

test("revalida cuenta/organización/rol antes de listado y detalle y conserva el alcance central", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.listMoraExceptionRequests(new URLSearchParams(), central, now)).total, 7);
  for (const actor of [{ id: 3, nombre: "Admin aliado", centralAdmin: true }, { ...analyst, centralAdmin: true }]) {
    const start = f.queries.length;
    await assert.rejects(f.service.listMoraExceptionRequests(new URLSearchParams(), actor, now), { code: "FORBIDDEN" });
    assert.equal(f.queries.length, start + 1);
    assert.match(f.queries.at(-1).sql, /FROM "Usuario"/);
  }
  await f.database.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=2');
  const start = f.queries.length;
  await assert.rejects(f.list({}), { code: "FORBIDDEN" });
  await assert.rejects(f.service.getMoraExceptionRequest(f.ids[0], analyst, now), { code: "FORBIDDEN" });
  assert.equal(f.queries.length, start + 2);
  assert.equal(f.supportsReads(), 0);
});
