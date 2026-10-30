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
  const loadedModule = { exports: {} };
  runInNewContext(outputText, {
    exports: loadedModule.exports, module: loadedModule, Buffer, Date, Intl, Map, URL, URLSearchParams,
    require(name) {
      if (name === "server-only") return {};
      if (name === "node:crypto") return { createHash, randomUUID };
      assert.ok(name in dependencies, `Dependencia inesperada de ${path}: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return loadedModule.exports;
}

const dates = load("lib/colombia-date.ts", {});
const displayNumbers = load("lib/credit-display-number.ts", {});
const products = load("lib/ally-payments-core.ts", {});
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
    "@/lib/analyst-mora-extension": load("lib/analyst-mora-extension.ts", {
      "@/lib/prisma": { default: prisma }, "@/lib/colombia-date": dates,
      "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
    }),
    "@/lib/analyst-mora-credit": {
      moraCreditSelect: {}, moraCreditSummary: credit => credit,
      readMoraCreditProducts: async ids => new Map(ids.map(id => [id, creditLookup(id)?.producto ?? null])),
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
    "@/lib/ally-payments-core": products,
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: credit => credit.plan || overduePlan },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  });
}

async function harness(t, { plan = overduePlan, estado = "ACTIVO" } = {}) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY, "folio" TEXT, "clienteNombre" TEXT, "clienteDocumento" TEXT,
      "equipoMarca" TEXT, "contratoSnapshot" JSONB);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT, "activo" BOOLEAN);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER, "activa" BOOLEAN);
    CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT);
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT, "rolId" INTEGER, "sedeId" INTEGER, "activo" BOOLEAN);
    CREATE TABLE "CreditoAbono" ("creditoId" INTEGER, "valor" NUMERIC(20,2), "estado" TEXT, "fechaAbono" TIMESTAMP);
    INSERT INTO "Aliado" VALUES (1,'FINSERPAY',TRUE),(2,'ALIADO',TRUE);
    INSERT INTO "Sede" VALUES (1,1,TRUE),(2,2,TRUE);
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'ANALISTA_APROBACION');
    INSERT INTO "Usuario" VALUES (1,'Administrador vigente',1,1,TRUE),(2,'Analista vigente',2,1,TRUE),(3,'Administrador aliado',1,2,TRUE);
    INSERT INTO "Credito" VALUES (77,'FC-77','Cliente prueba','100000077','IPHONE',NULL);
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

function amendmentInput(api, item, patch = {}) {
  return api.parseCentralMoraExceptionAmendment({ action: "EDIT", version: item.version,
    expiresOn: item.expiresOn, reason: item.reason, observation: item.observation,
    idempotencyKey: randomUUID(), ...patch });
}

const extensionNow = new Date("2026-10-18T20:00:00Z");
const extensionPlan = { estadoPago: "MORA", saldoPendiente: 900,
  installments: [{ numero: 3, fechaVencimiento: "2026-10-17", saldoPendiente: 300, eliminada: false }] };
async function approvedAnalystExtension(f) {
  const created = await f.service.createMoraExceptionRequest(analystInput(f.service, {
    type: "PRORROGA", expiresOn: "2026-10-20", promiseDate: "2026-10-20",
  }), analyst, extensionNow);
  return (await f.service.actOnMoraExceptionRequest(created.item.id, f.service.parseMoraExceptionDecision({
    action: "APPROVE", version: created.item.version, reason: "Plazo autorizado por central", idempotencyKey: randomUUID(),
  }), central, extensionNow)).item;
}
function analystAmendment(api, item, patch = {}) {
  return api.parseAnalystMoraExtensionAmendment({ action: "EDIT", version: item.version, expiresOn: "2026-10-21",
    reason: "Ajuste solicitado por el cliente", observation: "Seguimiento del compromiso", auditReason: "Fecha corregida por solicitud del cliente",
    idempotencyKey: randomUUID(), ...patch });
}

test("analista edita y cancela la prórroga vigente con rol real, versión e historial sin tocar el crédito", async t => {
  const f = await harness(t, { plan: extensionPlan });
  const item = await approvedAnalystExtension(f);
  const creditBefore = JSON.stringify(f.credits.get(77));
  const capabilities = await f.service.getMoraExtensionActions(item.id, analyst, extensionNow);
  assert.deepEqual(JSON.parse(JSON.stringify(capabilities)), { canEdit: true, canCancel: true, centralAdmin: false,
    minExpiresOn: "2026-10-18", maxExpiresOn: "2026-10-21", editBlockedReason: null });
  const input = analystAmendment(f.service, item, { promiseDate: "2026-10-21" });
  const edited = await f.service.amendMoraExceptionRequest(item.id, input, analyst, extensionNow);
  assert.equal(edited.item.expiresOn, "2026-10-21"); assert.equal(edited.item.promiseAmount, item.promiseAmount);
  assert.equal(edited.item.promiseDate, "2026-10-21"); assert.equal(edited.item.status, "APPROVED");
  assert.equal(edited.item.version, item.version + 1); assert.equal(edited.affectsMora, true);
  const replay = await f.service.amendMoraExceptionRequest(item.id, input, analyst, extensionNow);
  assert.equal(replay.unchanged, true);
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id, { ...input, idempotencyKey: randomUUID() }, analyst, extensionNow), { code: "MORA_REQUEST_CHANGED" });
  const cancel = f.service.parseAnalystMoraExtensionAmendment({ action: "CANCEL", version: edited.item.version,
    auditReason: "El cliente canceló su solicitud", idempotencyKey: randomUUID() });
  const cancelled = await f.service.amendMoraExceptionRequest(item.id, cancel, analyst, extensionNow);
  assert.equal(cancelled.item.status, "CANCELLED"); assert.equal(cancelled.affectsMora, true);
  assert.equal((await f.service.amendMoraExceptionRequest(item.id, cancel, analyst, extensionNow)).unchanged, true);
  const after = await f.service.getMoraExtensionActions(item.id, analyst, extensionNow);
  assert.equal(after.canEdit, false); assert.equal(after.canCancel, false);
  const events = (await f.database.query(`SELECT * FROM "CreditMoraExceptionEvent" WHERE "action" IN ('EDITED','CANCELLED') ORDER BY "version"`)).rows;
  assert.equal(events.length, 2); assert.ok(events.every(event => event.actorUserId === 2 && event.actorName === "Analista vigente"));
  assert.equal(events[0].payload.auditReason, input.auditReason);
  assert.equal(events[0].payload.before.expiresOn, "2026-10-20"); assert.equal(events[0].payload.after.expiresOn, "2026-10-21");
  assert.equal(JSON.stringify(f.credits.get(77)), creditBefore);
  assert.ok(!f.queries.some(sql => /UPDATE\s+"Credito"/i.test(sql)));
});

test("las fechas analista están ligadas a la cuota regular y no reinician cuatro días desde la edición", async t => {
  const f = await harness(t, { plan: extensionPlan });
  const item = await approvedAnalystExtension(f);
  for (const expiresOn of [null, "2026-10-17", "2026-10-22", "2030-10-21"])
    await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
      amendmentInput(f.service, item, { expiresOn, auditReason: "Corrección requerida por cliente" }), analyst, extensionNow), { code: "EXTENSION_WINDOW_CLOSED" });
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
    amendmentInput(f.service, item, { promiseAmount: 150, auditReason: "Corrección requerida por cliente" }), analyst, extensionNow), { code: "INVALID_MORA_EXCEPTION" });
  await f.database.query(`UPDATE "CreditMoraExceptionRequest" SET "promiseDate"='2026-10-17' WHERE "id"=$1`, [item.id]);
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
    analystAmendment(f.service, item), analyst, extensionNow), { code: "INVALID_MORA_EXCEPTION" });
  await f.database.query(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"='2026-10-30',"promiseDate"='2026-10-30' WHERE "id"=$1`, [item.id]);
  const outside = new Date("2026-10-22T18:00:00Z");
  const caps = await f.service.getMoraExtensionActions(item.id, analyst, outside);
  assert.equal(caps.canEdit, false); assert.equal(caps.canCancel, true); assert.equal(caps.maxExpiresOn, "2026-10-21");
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, item), analyst, outside), { code: "MORA_EXTENSION_NOT_EDITABLE" });
  const centralCaps = await f.service.getMoraExtensionActions(item.id, central, outside);
  assert.equal(centralCaps.canEdit, true); assert.equal(centralCaps.maxExpiresOn, null);
  assert.equal((await f.service.amendMoraExceptionRequest(item.id,
    amendmentInput(f.service, item, { expiresOn: "2035-12-31" }), central, outside)).item.expiresOn, "2035-12-31");
});

test("central directo deriva la cuota para edición analista y permite cancelación aun fuera de la ventana", async t => {
  const f = await harness(t, { plan: extensionPlan });
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service, { type: "PRORROGA", expiresOn: null }), central, extensionNow);
  const caps = await f.service.getMoraExtensionActions(created.item.id, analyst, extensionNow);
  assert.equal(caps.canEdit, true); assert.equal(caps.canCancel, true); assert.equal(caps.maxExpiresOn, "2026-10-21");
  const edited = await f.service.amendMoraExceptionRequest(created.item.id, analystAmendment(f.service, created.item), analyst, extensionNow);
  assert.equal(edited.item.source, "CENTRAL_DIRECT"); assert.equal(edited.item.promiseAmount, null);
  const centralEdit = await f.service.amendMoraExceptionRequest(created.item.id,
    amendmentInput(f.service, edited.item, { expiresOn: null }), central, extensionNow);
  const outside = new Date("2026-11-01T18:00:00Z");
  const outsideCaps = await f.service.getMoraExtensionActions(created.item.id, analyst, outside);
  assert.equal(outsideCaps.canEdit, false); assert.equal(outsideCaps.canCancel, true);
  const cancelled = await f.service.amendMoraExceptionRequest(created.item.id, f.service.parseAnalystMoraExtensionAmendment({
    action: "CANCEL", version: centralEdit.item.version, auditReason: "Autorización ya no requerida", idempotencyKey: randomUUID(),
  }), analyst, outside);
  assert.equal(cancelled.item.status, "CANCELLED");
});

test("analista no altera excepciones, pendientes, vencidas, promesas cumplidas ni solicitudes reemplazadas", async t => {
  const f = await harness(t, { plan: extensionPlan });
  const exception = await f.service.createMoraExceptionRequest(centralInput(f.service), central, extensionNow);
  await assert.rejects(f.service.amendMoraExceptionRequest(exception.item.id,
    analystAmendment(f.service, exception.item), analyst, extensionNow), { code: "FORBIDDEN" });
  // Close the direct exception before creating a normal pending request.
  await f.service.amendMoraExceptionRequest(exception.item.id, f.service.parseCentralMoraExceptionAmendment({
    action: "CANCEL", version: exception.item.version, idempotencyKey: randomUUID(),
  }), central, extensionNow);
  const item = (await f.service.createMoraExceptionRequest(analystInput(f.service, {
    type: "PRORROGA", expiresOn: "2026-10-20", promiseDate: "2026-10-20",
  }), analyst, extensionNow)).item;
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, item), analyst, extensionNow), { code: "MORA_EXTENSION_NOT_EDITABLE" });
  const approved = await f.service.actOnMoraExceptionRequest(item.id, f.service.parseMoraExceptionDecision({
    action: "APPROVE", version: item.version, reason: "Plazo aprobado correctamente", idempotencyKey: randomUUID(),
  }), central, extensionNow);
  await f.database.query(`INSERT INTO "CreditoAbono" VALUES (77,200,'APROBADO',$1)`, [new Date()]);
  // Tie payment to the actual decision timestamp; the eligibility clock is later.
  const decided = (await f.database.query(`SELECT "decidedAt" FROM "CreditMoraExceptionRequest" WHERE "id"=$1`, [item.id])).rows[0].decidedAt;
  await f.database.query(`UPDATE "CreditoAbono" SET "fechaAbono"=($1::timestamptz AT TIME ZONE 'UTC')`, [decided]);
  const afterDecision = new Date(Math.max(extensionNow.getTime(), new Date(decided).getTime() + 1000));
  const fulfilledCaps = await f.service.getMoraExtensionActions(item.id, analyst, afterDecision);
  assert.equal(fulfilledCaps.canEdit, false); assert.equal(fulfilledCaps.canCancel, false);
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, approved.item), analyst, afterDecision), error => ["MORA_EXTENSION_NOT_EDITABLE","MORA_REQUEST_CHANGED"].includes(error.code));
  await f.database.exec('DELETE FROM "CreditoAbono"');
  for (const status of ["REPLACED", "CANCELLED", "EXPIRED"]) {
    await f.database.query(`UPDATE "CreditMoraExceptionRequest" SET "status"=$2 WHERE "id"=$1`, [item.id, status]);
    const caps = await f.service.getMoraExtensionActions(item.id, analyst, extensionNow);
    assert.equal(caps.canEdit, false); assert.equal(caps.canCancel, false);
    await assert.rejects(f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, approved.item), analyst, extensionNow), { code: "MORA_REQUEST_TERMINAL" });
  }
  await f.database.query(`UPDATE "CreditMoraExceptionRequest" SET "status"='APPROVED',"expiresOn"='2026-10-17',"promiseDate"='2026-10-17' WHERE "id"=$1`, [item.id]);
  assert.equal((await f.service.getMoraExtensionActions(item.id, analyst, extensionNow)).canCancel, false);
});

test("los permisos se recalculan contra el usuario activo y el parser analista rechaza finanzas y motivos vacíos", async t => {
  const f = await harness(t, { plan: extensionPlan });
  const item = await approvedAnalystExtension(f);
  const centralFromDatabase = await f.service.getMoraExtensionActions(item.id, { ...central, centralAdmin: false }, extensionNow);
  assert.equal(centralFromDatabase.centralAdmin, true); assert.equal(centralFromDatabase.maxExpiresOn, null);
  for (const patch of [{ promiseAmount: 100 }, { creditoId: 8 }, { montoCredito: 100 }, { auditReason: "" },
    { auditReason: undefined }, { expiresOn: null }, { promiseDate: null }, { status: "APPROVED" }])
    assert.throws(() => analystAmendment(f.service, item, patch), { code: "INVALID_MORA_EXCEPTION" });
  await f.database.exec(`UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=2`);
  await assert.rejects(f.service.getMoraExtensionActions(item.id, analyst, extensionNow), { code: "FORBIDDEN" });
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, item), analyst, extensionNow), { code: "FORBIDDEN" });
  await assert.rejects(f.service.getMoraExtensionActions(item.id, { id: 3, nombre: "Ajeno", centralAdmin: true }, extensionNow), { code: "FORBIDDEN" });
});

test("cuota del 02 admite hasta el 06 y una cuota irregular no habilita edición analista", async t => {
  const f = await harness(t);
  const early = new Date("2026-10-03T19:00:00Z");
  const item = (await f.service.createMoraExceptionRequest(centralInput(f.service, {
    type: "PRORROGA", expiresOn: "2026-10-06",
  }), central, early)).item;
  const caps = await f.service.getMoraExtensionActions(item.id, analyst, early);
  assert.equal(caps.canEdit, true); assert.equal(caps.maxExpiresOn, "2026-10-06");
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
    analystAmendment(f.service, item, { expiresOn: "2026-10-07" }), analyst, early), { code: "EXTENSION_WINDOW_CLOSED" });
  const edited = await f.service.amendMoraExceptionRequest(item.id,
    analystAmendment(f.service, item, { expiresOn: "2026-10-06" }), analyst, early);
  f.credits.get(77).plan = { ...overduePlan, installments: [{ ...overduePlan.installments[0], fechaVencimiento: "2026-10-01" }] };
  const irregular = await f.service.getMoraExtensionActions(item.id, analyst, early);
  assert.equal(irregular.canEdit, false); assert.equal(irregular.canCancel, true);
  await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
    analystAmendment(f.service, edited.item, { expiresOn: "2026-10-04" }), analyst, early), { code: "MORA_EXTENSION_NOT_EDITABLE" });
});

test("cuota futura habilita prórroga y edición con mínimo vencimiento+1, sin habilitar excepción de mora", async t => {
  const f = await harness(t, { plan: { ...overduePlan, estadoPago: "AL_DIA" } });
  const early = new Date("2026-10-01T17:00:00Z");
  const preflight = await f.service.getMoraExceptionPreflight(77, analyst, early);
  assert.equal(preflight.eligibility.prorroga.canRequest, true);
  assert.equal(preflight.eligibility.excepcion.canRequest, false);
  assert.equal(preflight.eligibility.minExpiresOn, "2026-10-03");
  assert.equal(preflight.eligibility.maxExpiresOn, "2026-10-06");
  const item = (await f.service.createMoraExceptionRequest(centralInput(f.service, { type: "PRORROGA", expiresOn: "2026-10-06" }), central, early)).item;
  const caps = await f.service.getMoraExtensionActions(item.id, analyst, early);
  assert.equal(caps.canEdit, true); assert.equal(caps.minExpiresOn, "2026-10-03");
  for (const expiresOn of ["2026-10-01", "2026-10-02", "2026-10-07"]) await assert.rejects(f.service.amendMoraExceptionRequest(item.id,
    analystAmendment(f.service, item, { expiresOn }), analyst, early), { code: "EXTENSION_WINDOW_CLOSED" });
  const edited = await f.service.amendMoraExceptionRequest(item.id, analystAmendment(f.service, item, { expiresOn: "2026-10-04" }), analyst, early);
  assert.equal(edited.item.expiresOn, "2026-10-04");
  f.credits.get(77).plan = { ...overduePlan, estadoPago: "PAGADO", saldoPendiente: 0, installments: [{ ...overduePlan.installments[0], saldoPendiente: 0 }] };
  assert.equal((await f.service.getMoraExtensionActions(item.id, analyst, early)).canEdit, false);
});

test("central edita plazo, motivo y observación sin recrear la excepción ni alterar el crédito", async t => {
  const f = await harness(t, { plan: { estadoPago: "AL_DIA", saldoPendiente: 900, installments: [] } });
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service, { type: "PRORROGA", expiresOn: "2026-10-09" }), central, now);
  const input = amendmentInput(f.service, created.item, { expiresOn: "2035-12-31", reason: "Cambio autorizado",
    observation: "Fecha ajustada por central", auditReason: "Corrección de fecha" });
  const result = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  assert.equal(result.item.id, created.item.id);
  assert.equal(result.item.creditoId, 77);
  assert.equal(result.item.type, "PRORROGA");
  assert.equal(result.item.status, "APPROVED");
  assert.equal(result.item.source, "CENTRAL_DIRECT");
  assert.equal(result.item.expiresOn, "2035-12-31");
  assert.equal(result.item.reason, "Cambio autorizado");
  assert.equal(result.item.observation, "Fecha ajustada por central");
  assert.equal(result.item.version, created.item.version + 1);
  assert.equal(result.item.decidedAt, created.item.decidedAt);
  assert.equal(result.affectsMora, true);
  const history = (await f.database.query(`SELECT * FROM "CreditMoraExceptionEvent" WHERE "action"='EDITED'`)).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].actorUserId, 1);
  assert.equal(history[0].actorName, "Administrador vigente");
  assert.equal(history[0].payload.before.expiresOn, "2026-10-09");
  assert.equal(history[0].payload.after.expiresOn, "2035-12-31");
  assert.equal(history[0].payload.auditReason, "Corrección de fecha");
  assert.equal(history[0].version, result.item.version);
  assert.equal((await f.database.query(`SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionRequest"`)).rows[0].n, 1);
  assert.equal(f.queries.some(sql => /UPDATE "Credito" SET/.test(sql)), false);
});

test("cancelar una excepción aprobada la quita inmediatamente de las activas y conserva sus datos", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  assert.equal((await f.service.getActiveMoraExceptionsByCreditIds([77], now)).has(77), true);
  const input = f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: created.item.version,
    idempotencyKey: randomUUID() });
  const result = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  assert.equal(result.item.status, "CANCELLED");
  assert.equal(result.item.reason, created.item.reason);
  assert.equal(result.item.decidedAt, created.item.decidedAt);
  assert.equal(result.item.version, 2);
  assert.equal(result.affectsMora, true);
  assert.equal((await f.service.getActiveMoraExceptionsByCreditIds([77], now)).has(77), false);
  const event = (await f.database.query(`SELECT * FROM "CreditMoraExceptionEvent" WHERE "action"='CANCELLED'`)).rows[0];
  assert.equal(event.fromStatus, "APPROVED"); assert.equal(event.toStatus, "CANCELLED");
  assert.equal(event.payload.before.status, "APPROVED"); assert.equal(event.payload.after.status, "CANCELLED");
  assert.equal(event.payload.auditReason, "Cancelada por administrador central");
  assert.equal((await f.database.query(`SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionRequest"`)).rows[0].n, 1);
  await assert.rejects(f.database.query(`DELETE FROM "CreditMoraExceptionRequest"`), /inmutable/i);
});

test("central cancela una solicitud pendiente del analista sin aprobarla y registra su responsable", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(analystInput(f.service), analyst, now);
  const input = f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: created.item.version,
    auditReason: "Cliente desistió", idempotencyKey: randomUUID() });
  const result = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  assert.equal(result.item.status, "CANCELLED"); assert.equal(result.affectsMora, false);
  assert.equal(result.item.createdByUserId, 2); assert.equal(result.item.decidedByUserId, 1);
  assert.equal(result.item.decidedByName, "Administrador vigente"); assert.ok(result.item.decidedAt);
  assert.equal(result.item.decisionReason, "Cliente desistió");
  assert.equal(result.item.promiseAmount, created.item.promiseAmount);
  assert.equal(result.item.source, "ANALYST_REQUEST");
  const replay = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  assert.equal(replay.unchanged, true); assert.equal(replay.affectsMora, false);
  assert.equal((await f.database.query(`SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionEvent"`)).rows[0].n, 2);
});

test("editar compromiso del analista conserva cuota, origen, estado y ventana de pagos de la aprobación", async t => {
  const f = await harness(t);
  const pending = await f.service.createMoraExceptionRequest(analystInput(f.service), analyst, now);
  const pendingEdited = await f.service.amendMoraExceptionRequest(pending.item.id,
    amendmentInput(f.service, pending.item, { observation: "Corrección mientras espera aprobación" }), central, now);
  assert.equal(pendingEdited.item.status, "PENDING"); assert.equal(pendingEdited.affectsMora, false);
  assert.equal(pendingEdited.item.decidedAt, null); assert.equal(pendingEdited.item.decidedByUserId, null);
  const decision = f.service.parseCentralMoraExceptionDecision({ action: "APPROVE", version: pendingEdited.item.version,
    idempotencyKey: randomUUID() });
  const approved = await f.service.actOnMoraExceptionRequest(pending.item.id, decision, central, now);
  const input = amendmentInput(f.service, approved.item, { expiresOn: "2027-01-31", promiseAmount: 1000.25,
    promiseDate: "2027-01-30", reason: "Compromiso actualizado" });
  const result = await f.service.amendMoraExceptionRequest(approved.item.id, input, central, now);
  assert.equal(result.item.status, "APPROVED");
  assert.equal(result.item.promiseAmount, 1000.25);
  assert.equal(result.item.promiseDate, "2027-01-30");
  assert.equal(result.item.source, "ANALYST_REQUEST");
  assert.equal(result.item.installmentNumber, approved.item.installmentNumber);
  assert.equal(result.item.installmentDueDate, approved.item.installmentDueDate);
  assert.equal(result.item.decidedAt, approved.item.decidedAt);
});

test("versiones e idempotencia evitan editar o cancelar sobre un registro cambiado", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  const input = amendmentInput(f.service, created.item, { expiresOn: "2026-11-30" });
  const first = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  const replay = await f.service.amendMoraExceptionRequest(created.item.id, input, central, now);
  assert.equal(replay.unchanged, true); assert.equal(replay.affectsMora, true); assert.equal(replay.item.version, first.item.version);
  await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id, { ...input, expiresOn: "2026-12-31" }, central, now), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id, { ...input, idempotencyKey: randomUUID() }, central, now), { code: "MORA_REQUEST_CHANGED" });
  const cancel = f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: first.item.version,
    idempotencyKey: randomUUID() });
  await f.service.amendMoraExceptionRequest(created.item.id, cancel, central, now);
  const cancelledReplay = await f.service.amendMoraExceptionRequest(created.item.id, cancel, central, now);
  assert.equal(cancelledReplay.affectsMora, true); assert.equal(cancelledReplay.unchanged, true);
  assert.equal((await f.database.query(`SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionEvent"`)).rows[0].n, 3);
});

test("los estados terminales jamás se reactivan por editar y no aceptan otra cancelación", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  for (const status of ["EXPIRED", "REPLACED", "CANCELLED"]) {
    await f.database.query(`UPDATE "CreditMoraExceptionRequest" SET "status"=$1 WHERE "id"=$2`, [status, created.item.id]);
    await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id, amendmentInput(f.service, created.item), central, now), { code: "MORA_REQUEST_TERMINAL" });
    await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id,
      f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: 1, idempotencyKey: randomUUID() }), central, now), { code: "MORA_REQUEST_TERMINAL" });
  }
  assert.equal((await f.database.query(`SELECT COUNT(*)::int AS n FROM "CreditMoraExceptionEvent"`)).rows[0].n, 1);
});

test("editar y cancelar revalidan rol central en base de datos, incluidos permisos retirados", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  for (const actor of [analyst, { ...analyst, centralAdmin: true }, { id: 3, nombre: "Aliado", centralAdmin: true }]) {
    await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id, amendmentInput(f.service, created.item), actor, now), { code: "FORBIDDEN" });
    await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id,
      f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: 1, idempotencyKey: randomUUID() }), actor, now), { code: "FORBIDDEN" });
  }
  await f.database.exec(`UPDATE "Usuario" SET "activo"=FALSE WHERE "id"=1`);
  await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id, amendmentInput(f.service, created.item), central, now), { code: "FORBIDDEN" });
  assert.equal((await f.database.query(`SELECT "version" FROM "CreditMoraExceptionRequest"`)).rows[0].version, 1);
});

test("central puede fijar una fecha pasada explícita y la excepción deja de estar activa sin reactivaciones", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  const result = await f.service.amendMoraExceptionRequest(created.item.id,
    amendmentInput(f.service, created.item, { expiresOn: "2026-09-01" }), central, now);
  assert.equal(result.item.status, "EXPIRED"); assert.equal(result.affectsMora, true);
  assert.equal((await f.service.getActiveMoraExceptionsByCreditIds([77], now)).has(77), false);
  assert.equal((await f.database.query(`SELECT "toStatus" FROM "CreditMoraExceptionEvent" WHERE "action"='EDITED'`)).rows[0].toStatus, "EXPIRED");
});

test("migrar una base existente admite cancelación de central directo y mantiene historial inmutable", async t => {
  const f = await harness(t);
  await f.database.exec(`ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT "CreditMoraExceptionRequest_source_fields";
    ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_source_fields"
      CHECK (("source"='ANALYST_REQUEST' AND "installmentNumber" IS NOT NULL AND "installmentDueDate" IS NOT NULL
        AND "expiresOn" IS NOT NULL AND "promiseAmount" IS NOT NULL AND "promiseDate" IS NOT NULL)
        OR ("source"='CENTRAL_DIRECT' AND "installmentNumber" IS NULL AND "installmentDueDate" IS NULL
          AND "promiseAmount" IS NULL AND "promiseDate" IS NULL AND "status" IN ('APPROVED','EXPIRED','REPLACED')));`);
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => f.database.query(sql, params) });
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  const result = await f.service.amendMoraExceptionRequest(created.item.id,
    f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: 1, idempotencyKey: randomUUID() }), central, now);
  assert.equal(result.item.status, "CANCELLED");
  await assert.rejects(f.database.exec(`UPDATE "CreditMoraExceptionEvent" SET "actorName"='Otro'`), /inmutable/i);
});

test("si no se puede guardar la traza, editar o cancelar revierte el cambio completo", async t => {
  const f = await harness(t);
  const created = await f.service.createMoraExceptionRequest(centralInput(f.service), central, now);
  await f.database.exec(`CREATE FUNCTION public.reject_amendment_trace() RETURNS trigger AS $$
    BEGIN IF NEW."action" IN ('EDITED','CANCELLED') THEN RAISE EXCEPTION 'TRACE_WRITE_FAILURE'; END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_amendment_trace BEFORE INSERT ON "CreditMoraExceptionEvent"
      FOR EACH ROW EXECUTE FUNCTION public.reject_amendment_trace();`);
  await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id,
    amendmentInput(f.service, created.item, { expiresOn: "2035-12-31" }), central, now), /TRACE_WRITE_FAILURE/);
  await assert.rejects(f.service.amendMoraExceptionRequest(created.item.id,
    f.service.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: 1, idempotencyKey: randomUUID() }), central, now), /TRACE_WRITE_FAILURE/);
  const row = (await f.database.query(`SELECT "status","version","expiresOn" FROM "CreditMoraExceptionRequest"`)).rows[0];
  assert.equal(row.status, "APPROVED"); assert.equal(row.version, 1); assert.equal(row.expiresOn, null);
  assert.equal((await f.service.getActiveMoraExceptionsByCreditIds([77], now)).has(77), true);
});

test("el parser de correcciones no admite identidad, finanzas, cambios de tipo ni valores inválidos", () => {
  const api = service();
  const base = { action: "EDIT", version: 1, expiresOn: null, idempotencyKey: randomUUID() };
  for (const patch of [{ creditoId: 78 }, { type: "PRORROGA" }, { montoCredito: 100 }, { status: "APPROVED" },
    { actorUserId: 3 }, { version: 0 }, { expiresOn: "2026-02-30" }, { promiseAmount: -1 },
    { promiseAmount: 1.001 }, { promiseAmount: true }, { promiseDate: "2026-02-30" }, { auditReason: 123 }])
    assert.throws(() => api.parseCentralMoraExceptionAmendment({ ...base, ...patch }), { code: "INVALID_MORA_EXCEPTION" });
  assert.equal(api.parseCentralMoraExceptionAmendment(base).auditReason, "Editada por administrador central");
  assert.throws(() => api.parseCentralMoraExceptionAmendment({ action: "CANCEL", version: 1, expiresOn: null,
    idempotencyKey: randomUUID() }), { code: "INVALID_MORA_EXCEPTION" });
});

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
