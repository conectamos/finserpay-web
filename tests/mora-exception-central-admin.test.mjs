import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";

class CreditApprovalError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function load(path, dependencies) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(outputText, {
    exports: module.exports, module, Buffer, Date, Intl, Map, URL, URLSearchParams,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return { createHash, randomUUID };
      assert.ok(name in dependencies, `Dependencia inesperada de ${path}: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return module.exports;
}

const dates = load("lib/colombia-date.ts", {});
const displayNumbers = load("lib/credit-display-number.ts", {});
const access = load("lib/analyst-mora-access.ts", {
  "@/lib/auth": {},
  "@/lib/approval-shared-session": {},
  "@/lib/roles": {},
  "@/lib/credit-approval-errors": { CreditApprovalError },
});
const now = new Date("2026-10-07T17:00:00Z");
const central = { id: 1, nombre: "Nombre enviado por cliente", centralAdmin: true };
const analyst = { id: 2, nombre: "Analista", centralAdmin: false };
const overduePlan = {
  estadoPago: "MORA", saldoPendiente: 900,
  installments: [{ numero: 3, fechaVencimiento: "2026-10-02", saldoPendiente: 300, eliminada: false }],
};

function service(prisma = {}, creditLookup = () => null, listMoraPortfolio = async () => ({ items: [] })) {
  return load("lib/mora-exception-requests.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/analyst-mora-access": access,
    "@/lib/analyst-mora-management": { listMoraPortfolio },
    "@/lib/analyst-mora-credit": {
      moraCreditSelect: {}, moraCreditSummary: credit => credit,
      readMoraCredit: async id => {
        const credit = creditLookup(id);
        if (!credit) throw new CreditApprovalError("CREDIT_NOT_FOUND", "Crédito no encontrado.", 404);
        return credit;
      },
    },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-support": { listMoraSupports: async () => [] },
    "@/lib/colombia-date": dates,
    "@/lib/credit-display-number": displayNumbers,
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: credit => credit.plan || overduePlan },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
}

async function harness(t, { plan = overduePlan, estado = "ACTIVO" } = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "folio" TEXT, "clienteNombre" TEXT, "clienteDocumento" TEXT);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT, "activo" BOOLEAN);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "activa" BOOLEAN);
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT, "rolId" INTEGER, "sedeId" INTEGER, "activo" BOOLEAN);
    CREATE TABLE "CreditoAbono" ("creditoId" INTEGER, "valor" NUMERIC(20,2), "estado" TEXT, "fechaAbono" TIMESTAMP);
    INSERT INTO "Aliado" VALUES (1,'FINSERPAY',TRUE),(2,'ALIADO',TRUE);
    INSERT INTO "Sede" VALUES (1,1,TRUE),(2,2,TRUE);
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION');
    INSERT INTO "Usuario" VALUES (1,'Administrador vigente',1,1,TRUE),(2,'Analista vigente',2,1,TRUE),(3,'Administrador aliado',1,2,TRUE);
    INSERT INTO "Credito" VALUES (77,'FC-77','Cliente prueba','100000077');
  `);
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => database.query(sql, params) });
  const credits = new Map([[77, { id: 77, folio: "FC-77", clienteNombre: "Cliente prueba", clienteDocumento: "100000077",
    estado, plan, valorCuota: 300, pazYSalvoEmitidoAt: null, abonos: [] }]]);
  const queries = [];
  const adapter = connection => ({
    async $queryRawUnsafe(sql, ...params) {
      queries.push(sql);
      return (await connection.query(sql, params)).rows;
    },
    async $executeRawUnsafe(sql, ...params) {
      queries.push(sql);
      return (await connection.query(sql, params)).affectedRows;
    },
    credito: { findUnique: async ({ where }) => credits.get(where.id) || null },
  });
  const prisma = { ...adapter(database), $transaction: callback => database.transaction(tx => callback(adapter(tx))) };
  return { database, credits, queries, prisma, service: service(prisma, id => credits.get(id)) };
}

function centralInput(api, patch = {}) {
  return api.parseCentralMoraExceptionCreate({ creditoId: 77, type: "EXCEPCION", expiresOn: null, idempotencyKey: randomUUID(), ...patch });
}

function analystInput(api, patch = {}) {
  return api.parseMoraExceptionCreate({ creditoId: 77, type: "EXCEPCION", expiresOn: "2026-10-10",
    promiseAmount: 200, promiseDate: "2026-10-10", reason: "Cliente confirma pago", observation: "Seguimiento documentado",
    idempotencyKey: randomUUID(), ...patch });
}

test("central registra con datos mínimos y rechaza campos que intentan imponer identidad o estado", () => {
  const api = service();
  const input = centralInput(api, { expiresOn: "2035-10-07" });
  assert.equal(input.source, "CENTRAL_DIRECT");
  assert.equal(input.expiresOn, "2035-10-07");
  assert.equal(centralInput(api).expiresOn, null);
  for (const patch of [{ expiresOn: "2026-02-30" }, { idempotencyKey: "falso" }, { creditoId: 0 },
    { centralAdmin: true }, { createdByUserId: 3 }, { status: "APPROVED" }, { source: "CENTRAL_DIRECT" }]) {
    assert.throws(() => centralInput(api, patch), { code: "INVALID_MORA_EXCEPTION" });
  }
  assert.throws(() => api.parseMoraExceptionCreate({ creditoId: 77, type: "EXCEPCION", expiresOn: null,
    source: "CENTRAL_DIRECT", idempotencyKey: randomUUID() }), { code: "INVALID_MORA_EXCEPTION" });
});

test("central puede decidir sin nota o con una nota corta y el analista conserva el mínimo", () => {
  const api = service();
  const input = { action: "APPROVE", version: 1, idempotencyKey: randomUUID() };
  assert.match(api.parseCentralMoraExceptionDecision(input).reason, /administrador central/);
  assert.equal(api.parseCentralMoraExceptionDecision({ ...input, reason: "OK" }).reason, "OK");
  assert.equal(api.parseCentralMoraExceptionDecision({ ...input, action: "OBSERVE", reason: "OK" }).reason, "OK");
  assert.throws(() => api.parseMoraExceptionDecision({ ...input, reason: "OK" }), { code: "INVALID_MORA_EXCEPTION" });
  assert.throws(() => api.parseCentralMoraExceptionDecision({ ...input, reason: 123 }), { code: "INVALID_MORA_EXCEPTION" });
});

test("central aplica prórroga de cualquier duración a crédito sin mora y audita responsable automáticamente", async t => {
  const f = await harness(t, { plan: { estadoPago: "AL_DIA", saldoPendiente: 900, installments: [] } });
  const result = await f.service.createMoraExceptionRequest(centralInput(f.service, { type: "PRORROGA", expiresOn: "2035-10-07" }), central, now);
  assert.equal(result.item.status, "APPROVED");
  assert.equal(result.item.centralDirect, true);
  assert.equal(result.item.createdByUserId, 1);
  assert.equal(result.item.decidedByUserId, 1);
  assert.equal(result.item.createdByName, "Administrador vigente");
  assert.equal(result.item.decidedByName, "Administrador vigente");
  assert.ok(Number.isFinite(Date.parse(result.item.createdAt)));
  assert.ok(Number.isFinite(Date.parse(result.item.decidedAt)));
  assert.equal(result.item.installmentNumber, null);
  assert.equal(result.item.promiseAmount, null);
  assert.equal(result.item.promiseDate, null);
  assert.equal(result.item.conditionStatus, "NOT_APPLICABLE");
  assert.equal(f.queries.some(sql => sql.includes('FROM "CreditMoraSpecialPermission"')), false);
  const events = (await f.database.query('SELECT "action","toStatus","actorUserId","actorName" FROM "CreditMoraExceptionEvent"')).rows;
  assert.deepEqual(events, [{ action: "APPROVED", toStatus: "APPROVED", actorUserId: 1, actorName: "Administrador vigente" }]);
});

test("central admite excepción sin vencimiento ni compromiso, y sigue activa años después", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  assert.equal(created.item.expiresOn, null);
  assert.equal(created.item.promiseAmount, null);
  assert.equal(created.item.promiseDate, null);
  const active = await f.service.getActiveMoraExceptionsByCreditIds([77], new Date("2040-12-31T17:00:00Z"));
  assert.equal(active.has(77), true);
  assert.equal(active.get(77).fechaFin, null);
  const stored = (await f.database.query('SELECT "status","expiresOn","promiseAmount","promiseDate" FROM "CreditMoraExceptionRequest"')).rows[0];
  assert.deepEqual(stored, { status: "APPROVED", expiresOn: null, promiseAmount: null, promiseDate: null });
});

test("enfriamiento continúa para analista y central crea sin permiso adicional", async t => {
  const f = await harness(t);
  await f.database.query(`INSERT INTO "CreditMoraExceptionRequest"
    ("id","creditoId","type","status","version","installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",
     "reason","observation","createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES ($1,77,'EXCEPCION','APPROVED',1,3,'2026-10-02','2026-10-06',200,'2026-10-06',
      'Motivo anterior','Observación anterior',2,'Analista vigente',1,'Administrador vigente','2026-10-03T17:00:00Z',$2,$3)`,
  [randomUUID(), randomUUID(), "a".repeat(64)]);
  await assert.rejects(f.service.createMoraExceptionRequest(analystInput(f.service), analyst, now), { code: "MORA_COOLDOWN" });
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionRequest"')).rows[0].n, 1);
  const direct = await f.service.createMoraExceptionRequest(centralInput(f.service, { expiresOn: "2026-10-08" }), central, now);
  assert.equal(direct.item.status, "APPROVED");
  assert.equal(direct.item.cooldownBypassed, false);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraSpecialPermission"')).rows[0].n, 0);
  await assert.rejects(f.service.createMoraExceptionRequest(analystInput(f.service), analyst, now), { code: "MORA_REQUEST_PENDING" });
});

test("nueva excepción central reemplaza pendiente y vigente con historial inmutable e idempotencia", async t => {
  const f = await harness(t);
  const pending = await f.service.createMoraExceptionRequest(analystInput(f.service), analyst, now);
  assert.equal(pending.item.status, "PENDING");
  const first = await f.service.createMoraExceptionRequest(centralInput(f.service, { expiresOn: "2026-10-09" }), central, now);
  const secondInput = centralInput(f.service);
  const second = await f.service.createMoraExceptionRequest(secondInput, central, now);
  const replay = await f.service.createMoraExceptionRequest(secondInput, central, now);
  assert.equal(second.unchanged, false);
  assert.equal(replay.unchanged, true);
  assert.equal(replay.item.id, second.item.id);
  const rows = (await f.database.query('SELECT "id"::text,"status" FROM "CreditMoraExceptionRequest"')).rows;
  assert.equal(rows.find(row => row.id === pending.item.id).status, "REPLACED");
  assert.equal(rows.find(row => row.id === first.item.id).status, "REPLACED");
  assert.equal(rows.filter(row => row.status === "APPROVED").length, 1);
  assert.equal(rows.length, 3);
  const events = (await f.database.query('SELECT "requestId"::text,"action","fromStatus","toStatus","actorUserId" FROM "CreditMoraExceptionEvent"')).rows;
  assert.equal(events.length, 5, "replay no agrega eventos ni vuelve a reemplazar");
  assert.deepEqual(events.filter(event => event.action === "REPLACED").map(({ fromStatus, toStatus, actorUserId }) =>
    ({ fromStatus, toStatus, actorUserId })).sort((a, b) => a.fromStatus.localeCompare(b.fromStatus)), [
    { fromStatus: "APPROVED", toStatus: "REPLACED", actorUserId: 1 },
    { fromStatus: "PENDING", toStatus: "REPLACED", actorUserId: 1 },
  ]);
  await assert.rejects(f.service.createMoraExceptionRequest({ ...secondInput, expiresOn: "2026-11-01" }, central, now), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(f.database.query('UPDATE "CreditMoraExceptionEvent" SET "actorName"=\'Otro\''), /inmutable/i);
  await assert.rejects(f.database.query('DELETE FROM "CreditMoraExceptionEvent"'), /inmutable/i);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionEvent"')).rows[0].n, 5);
});

test("rol central se revalida en base de datos y los analistas o aliados no reciben registro directo", async t => {
  const f = await harness(t);
  for (const actor of [analyst, { ...analyst, centralAdmin: true }, { id: 3, nombre: "Aliado", centralAdmin: true }]) {
    await assert.rejects(f.service.createMoraExceptionRequest(centralInput(f.service), actor, now), { code: "FORBIDDEN" });
  }
  await f.database.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=1');
  await assert.rejects(f.service.createMoraExceptionRequest(centralInput(f.service), central, now), { code: "FORBIDDEN" });
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionEvent"')).rows[0].n, 0);
});

test("búsqueda central incluye créditos sin mora; parámetros de cliente no amplían facultades de analista", async t => {
  const f = await harness(t, { plan: { estadoPago: "AL_DIA", saldoPendiente: 900, installments: [] } });
  const current = f.credits.get(77);
  const overdue = { ...current, id: 78, folio: "FC-78", plan: overduePlan };
  let centralReads = 0;
  let portfolioReads = 0;
  f.prisma.credito.findMany = async ({ where }) => {
    centralReads++;
    assert.ok(where.estado.notIn.includes("ANULADO"));
    assert.equal(where.pazYSalvoEmitidoAt, undefined);
    return [current, overdue];
  };
  const api = service(f.prisma, id => f.credits.get(id), async params => {
    portfolioReads++;
    assert.equal(params.get("q"), "Cliente");
    assert.equal(params.has("centralAdmin"), false);
    return { items: [overdue], hasMore: false };
  });
  const params = new URLSearchParams("q=Cliente&centralAdmin=true&includeAll=true");
  const all = await api.searchMoraExceptionCredits(params, central, now);
  assert.deepEqual(Array.from(all.items, item => item.id), [77, 78]);
  const limited = await api.searchMoraExceptionCredits(params, analyst, now);
  assert.deepEqual(Array.from(limited.items, item => item.id), [78]);
  assert.equal(centralReads, 1);
  assert.equal(portfolioReads, 1);
  for (const actor of [{ ...analyst, centralAdmin: true }, { id: 3, nombre: "Aliado", centralAdmin: true }]) {
    await assert.rejects(api.searchMoraExceptionCredits(params, actor, now), { code: "FORBIDDEN" });
  }
  await f.database.query('UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=1');
  await assert.rejects(api.searchMoraExceptionCredits(params, central, now), { code: "FORBIDDEN" });
  assert.equal(centralReads, 1, "no consulta créditos completos después de revocar el rol");
  assert.equal(portfolioReads, 1);
});

test("registro directo conserva validación de fecha y existencia de crédito", async t => {
  const f = await harness(t);
  await assert.rejects(f.service.createMoraExceptionRequest(centralInput(f.service, { expiresOn: "2026-10-06" }), central, now), { code: "INVALID_MORA_EXCEPTION" });
  await assert.rejects(f.service.createMoraExceptionRequest(centralInput(f.service, { creditoId: 999 }), central, now), { code: "CREDIT_NOT_FOUND" });
  f.credits.get(77).estado = "ANULADO";
  await assert.rejects(f.service.createMoraExceptionRequest(centralInput(f.service), central, now), { code: "CREDIT_NOT_FOUND" });
  assert.equal((await f.database.query('SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
});

test("instalación actualiza esquema previo con datos existentes y admite NULLs centrales sin alterar auditoría", async t => {
  const database = new PGlite();
  t.after(() => database.close());
  // Constraints intentionally use the names PostgreSQL generated for the prior
  // schema, so this exercises an upgrade rather than a fresh empty installation.
  await database.exec(`
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Credito" VALUES (1),(2);
    INSERT INTO "Usuario" VALUES (1);
    CREATE TABLE "CreditMoraExceptionRequest" (
      "id" UUID PRIMARY KEY,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "type" VARCHAR(16) NOT NULL CHECK ("type" IN ('EXCEPCION','PRORROGA')),
      "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
      "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version">0),
      "installmentNumber" INTEGER NOT NULL CHECK ("installmentNumber">0),
      "installmentDueDate" DATE NOT NULL,
      "expiresOn" DATE NOT NULL,
      "promiseAmount" NUMERIC(20,2) NOT NULL CHECK ("promiseAmount">0),
      "promiseDate" DATE NOT NULL,
      "reason" VARCHAR(500) NOT NULL,
      "observation" VARCHAR(2000) NOT NULL,
      "createdByUserId" INTEGER NOT NULL REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "createdByName" VARCHAR(180) NOT NULL,
      "submittedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "decidedByUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "decidedByName" VARCHAR(180),
      "decidedAt" TIMESTAMPTZ,
      "decisionReason" VARCHAR(1000),
      "cooldownBypassed" BOOLEAN NOT NULL DEFAULT FALSE,
      "cooldownBypassReason" VARCHAR(1000),
      "createIdempotencyKey" UUID NOT NULL UNIQUE,
      "createRequestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ("promiseDate"<="expiresOn"),
      CHECK (("status"='PENDING' AND "decidedAt" IS NULL AND "decidedByUserId" IS NULL)
        OR ("status"<>'PENDING' AND "decidedAt" IS NOT NULL)),
      CHECK (NOT "cooldownBypassed" OR NULLIF(BTRIM("cooldownBypassReason"),'') IS NOT NULL)
    );
    CREATE UNIQUE INDEX "CreditMoraExceptionRequest_one_open" ON "CreditMoraExceptionRequest" ("creditoId")
      WHERE "status" IN ('PENDING','APPROVED');
    CREATE TABLE "CreditMoraExceptionEvent" (
      "id" UUID PRIMARY KEY,
      "requestId" UUID NOT NULL REFERENCES "CreditMoraExceptionRequest"("id") ON DELETE RESTRICT,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "version" INTEGER NOT NULL CHECK ("version">0),
      "action" VARCHAR(16) NOT NULL CHECK ("action" IN ('SUBMITTED','APPROVED','REJECTED','EXPIRED','OBSERVED')),
      "fromStatus" VARCHAR(16),
      "toStatus" VARCHAR(16) NOT NULL,
      "payload" JSONB NOT NULL,
      "actorUserId" INTEGER REFERENCES "Usuario"("id") ON DELETE RESTRICT,
      "actorName" VARCHAR(180) NOT NULL,
      "idempotencyKey" UUID UNIQUE,
      "requestHash" CHAR(64) NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("requestId","version")
    );
    CREATE FUNCTION public.mora_exception_history_immutable() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'El historial de excepciones de mora es inmutable' USING ERRCODE='23514'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER "CreditMoraExceptionEvent_immutable" BEFORE UPDATE OR DELETE OR TRUNCATE
      ON "CreditMoraExceptionEvent" FOR EACH STATEMENT EXECUTE FUNCTION public.mora_exception_history_immutable();
  `);
  const requestId = randomUUID();
  const eventId = randomUUID();
  await database.query(`INSERT INTO "CreditMoraExceptionRequest"
    ("id","creditoId","type","status","installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",
     "reason","observation","createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES ($1,1,'EXCEPCION','APPROVED',3,'2026-10-02','2026-10-10',200,'2026-10-10',
      'Motivo original','Observación original',1,'Administrador original',1,'Administrador original','2026-10-03T17:00:00Z',$2,$3)`,
  [requestId, randomUUID(), "b".repeat(64)]);
  await database.query(`INSERT INTO "CreditMoraExceptionEvent"
    ("id","requestId","creditoId","version","action","toStatus","payload","actorUserId","actorName","requestHash")
    VALUES ($1,$2,1,1,'APPROVED','APPROVED','{"reason":"Motivo original"}',1,'Administrador original',$3)`,
  [eventId, requestId, "c".repeat(64)]);
  const eventBefore = (await database.query('SELECT * FROM "CreditMoraExceptionEvent"')).rows[0];
  const client = { query: (sql, params = []) => database.query(sql, params) };
  await installMoraExceptionRequestSchema(client);
  await installMoraExceptionRequestSchema(client);
  const previous = (await database.query('SELECT "source","promiseAmount","expiresOn","reason","createdByName" FROM "CreditMoraExceptionRequest" WHERE "id"=$1', [requestId])).rows[0];
  assert.equal(previous.source, "ANALYST_REQUEST");
  assert.equal(Number(previous.promiseAmount), 200);
  assert.equal(new Date(previous.expiresOn).toISOString().slice(0, 10), "2026-10-10");
  assert.equal(previous.reason, "Motivo original");
  assert.equal(previous.createdByName, "Administrador original");
  assert.deepEqual((await database.query('SELECT * FROM "CreditMoraExceptionEvent"')).rows[0], eventBefore);
  const directId = randomUUID();
  await database.query(`INSERT INTO "CreditMoraExceptionRequest"
    ("id","creditoId","type","source","status","reason","observation","createdByUserId","createdByName",
     "decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES ($1,2,'EXCEPCION','CENTRAL_DIRECT','APPROVED','Registro directo','',1,'Administrador',1,'Administrador',CURRENT_TIMESTAMP,$2,$3)`,
  [directId, randomUUID(), "d".repeat(64)]);
  const direct = (await database.query('SELECT "expiresOn","installmentNumber","installmentDueDate","promiseAmount","promiseDate" FROM "CreditMoraExceptionRequest" WHERE "id"=$1', [directId])).rows[0];
  assert.deepEqual(direct, { expiresOn: null, installmentNumber: null, installmentDueDate: null, promiseAmount: null, promiseDate: null });
  await database.query('UPDATE "CreditMoraExceptionRequest" SET "status"=\'REPLACED\',"version"=2 WHERE "id"=$1', [requestId]);
  await database.query(`INSERT INTO "CreditMoraExceptionEvent"
    ("id","requestId","creditoId","version","action","fromStatus","toStatus","payload","actorUserId","actorName","requestHash")
    VALUES ($1,$2,1,2,'REPLACED','APPROVED','REPLACED','{}',1,'Administrador',$3)`,
  [randomUUID(), requestId, "e".repeat(64)]);
  assert.deepEqual((await database.query('SELECT * FROM "CreditMoraExceptionEvent" WHERE "id"=$1', [eventId])).rows[0], eventBefore);
  await assert.rejects(database.query(`INSERT INTO "CreditMoraExceptionRequest"
    ("id","creditoId","type","status","reason","observation","createdByUserId","createdByName",
     "decidedAt","createIdempotencyKey","createRequestHash")
    VALUES ($1,1,'EXCEPCION','EXPIRED','Intento sin compromiso','',1,'Analista',CURRENT_TIMESTAMP,$2,$3)`,
  [randomUUID(), randomUUID(), "f".repeat(64)]), error => error.code === "23514", "NULLs no relajan los datos obligatorios de las solicitudes de analista");
  await assert.rejects(database.query('DELETE FROM "CreditMoraExceptionEvent" WHERE "id"=$1', [eventId]), /inmutable/i);
});
