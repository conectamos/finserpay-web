import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";

const servicePath = new URL("../lib/mora-exception-requests.ts", import.meta.url);

class CreditApprovalError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function colombiaDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value instanceof Date ? value : new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function loadService({ prisma = {}, plan, assertActor = async (_db, actor) => actor } = {}) {
  const source = readFileSync(servicePath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const dependencies = {
    "server-only": {},
    "node:crypto": { createHash, randomUUID },
    "@/lib/prisma": { default: prisma },
    "@/lib/analyst-mora-access": { assertMoraActor: assertActor },
    "@/lib/analyst-mora-credit": {
      moraCreditSelect: {},
      moraCreditSummary: (credit) => credit,
      readMoraCredit: async () => null,
    },
    "@/lib/analyst-mora-schema": { ensureAnalystMoraSchema: async () => {} },
    "@/lib/analyst-mora-management": { listMoraPortfolio: async () => ({ items: [], hasMore: false }) },
    "@/lib/analyst-mora-support": { listMoraSupports: async () => [] },
    "@/lib/colombia-date": { colombiaDateKey },
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: () => plan },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
  };
  runInNewContext(outputText, {
    exports: loaded.exports,
    module: loaded,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    Buffer,
    Date,
    Intl,
    Map,
    URLSearchParams,
  }, { filename: "lib/mora-exception-requests.ts" });
  return loaded.exports;
}

const basePlan = {
  estadoPago: "MORA",
  saldoPendiente: 900,
  installments: [{ numero: 3, fechaVencimiento: "2026-10-02", saldoPendiente: 300, eliminada: false }],
};

const validCreate = {
  creditoId: 9,
  type: "PRORROGA",
  expiresOn: "2026-10-06",
  promiseAmount: 250.5,
  promiseDate: "2026-10-06",
  reason: "Cliente confirma pago",
  observation: "Seguimiento documentado",
  bypassCooldown: false,
  bypassReason: null,
  idempotencyKey: "10000000-0000-4000-8000-000000000001",
};

test("valida DTO, ventanas 02/06 y 17/21, y el enfriamiento de 20 días completos", () => {
  const service = loadService({ plan: basePlan });
  const parsed = service.parseMoraExceptionCreate(validCreate);
  assert.equal(parsed.promiseAmount, 250.5);
  assert.equal(service.evaluateMoraExceptionRule({}, parsed, new Date("2026-10-03T17:00:00.000Z")).maxExpiresOn, "2026-10-06");
  assert.equal(service.moraCooldownEnabledOn("2026-10-06"), "2026-10-27");
  assert.equal(
    service.moraCooldownMessage("2026-10-27"),
    "Este crédito tuvo una excepción vencida. Podrá solicitar una nueva excepción a partir del 27/10/2026."
  );

  assert.throws(
    () => service.evaluateMoraExceptionRule({}, parsed, new Date("2026-10-02T17:00:00.000Z")),
    { code: "EXTENSION_WINDOW_CLOSED" }
  );
  assert.throws(
    () => service.evaluateMoraExceptionRule({}, { ...parsed, expiresOn: "2026-10-07" }, new Date("2026-10-03T17:00:00.000Z")),
    { code: "EXTENSION_WINDOW_CLOSED" }
  );

  const day17 = {
    ...basePlan,
    installments: [{ numero: 4, fechaVencimiento: "2026-10-17", saldoPendiente: 300, eliminada: false }],
  };
  const service17 = loadService({ plan: day17 });
  assert.equal(service17.evaluateMoraExceptionRule({}, { ...parsed, expiresOn: "2026-10-21", promiseDate: "2026-10-21" }, new Date("2026-10-21T17:00:00.000Z")).maxExpiresOn, "2026-10-21");
});

test("bypass y observaciones exigen intención explícita, razón e idempotencia", () => {
  const service = loadService({ plan: basePlan });
  assert.throws(
    () => service.parseMoraExceptionCreate({ ...validCreate, type: "EXCEPCION", bypassCooldown: true, bypassReason: null }),
    { code: "INVALID_MORA_EXCEPTION" }
  );
  assert.throws(
    () => service.parseMoraExceptionCreate({ ...validCreate, bypassCooldown: true, bypassReason: "Razón especial válida" }),
    { code: "INVALID_MORA_EXCEPTION" }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(service.parseMoraExceptionDecision({
      action: "OBSERVE",
      version: 2,
      reason: "Nueva observación",
      bypassCooldown: false,
      bypassReason: null,
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
    }))),
    {
      action: "OBSERVE",
      version: 2,
      reason: "Nueva observación",
      bypassCooldown: false,
      bypassReason: null,
      idempotencyKey: "10000000-0000-4000-8000-000000000002",
    }
  );
});

async function insertRequest(database, { id, creditoId, status = "PENDING", key, expiresOn = "2026-10-06" }) {
  await database.query(`INSERT INTO "CreditMoraExceptionRequest"
    ("id","creditoId","type","status","version","installmentNumber","installmentDueDate","expiresOn",
     "promiseAmount","promiseDate","reason","observation","createdByUserId","createdByName","decidedAt",
     "createIdempotencyKey","createRequestHash")
    VALUES ($1::uuid,$2,'EXCEPCION',$3::varchar,1,1,'2026-10-02',$4::date,200,'2026-10-06','Motivo válido','Observación válida',
      1,'Admin',CASE WHEN $3::varchar='PENDING' THEN NULL ELSE '2026-10-05 12:00:00+00'::timestamptz END,$5::uuid,$6::char(64))`,
  [id, creditoId, status, expiresOn, key, "a".repeat(64)]);
}

test("instalador es idempotente y protege ledger, permisos y solicitudes contra borrado", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.query('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY)');
  await database.query('CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY)');
  await database.query('INSERT INTO "Credito" ("id") VALUES (1),(2)');
  await database.query('INSERT INTO "Usuario" ("id") VALUES (1)');
  const client = { query: (sql, params = []) => database.query(sql, params) };
  await installMoraExceptionRequestSchema(client);
  await installMoraExceptionRequestSchema(client);

  const requestId = "20000000-0000-4000-8000-000000000001";
  await insertRequest(database, {
    id: requestId,
    creditoId: 1,
    key: "20000000-0000-4000-8000-000000000002",
  });
  await assert.rejects(
    insertRequest(database, {
      id: "20000000-0000-4000-8000-000000000003",
      creditoId: 1,
      status: "APPROVED",
      key: "20000000-0000-4000-8000-000000000004",
    }),
    /unique|duplicate/i
  );

  const eventId = "20000000-0000-4000-8000-000000000005";
  await database.query(`INSERT INTO "CreditMoraExceptionEvent"
    ("id","requestId","creditoId","version","action","toStatus","payload","actorUserId","actorName","idempotencyKey","requestHash")
    VALUES ($1,$2,1,1,'SUBMITTED','PENDING','{}',1,'Admin',$3,$4)`,
  [eventId, requestId, "20000000-0000-4000-8000-000000000006", "b".repeat(64)]);

  const permissionEventId = "20000000-0000-4000-8000-000000000007";
  await database.query(`INSERT INTO "CreditMoraPermissionEvent"
    ("id","userId","permissionKey","active","reason","actorUserId","actorName","idempotencyKey","requestHash")
    VALUES ($1,1,'MORA_COOLDOWN_BYPASS',TRUE,'Permiso excepcional',1,'Admin',$2,$3)`,
  [permissionEventId, "20000000-0000-4000-8000-000000000008", "c".repeat(64)]);

  await assert.rejects(database.query('UPDATE "CreditMoraExceptionEvent" SET "actorName"=\'Otro\' WHERE "id"=$1', [eventId]), /inmutable/i);
  await assert.rejects(database.query('DELETE FROM "CreditMoraPermissionEvent" WHERE "id"=$1', [permissionEventId]), /inmutable/i);
  await assert.rejects(database.query('DELETE FROM "CreditMoraExceptionRequest" WHERE "id"=$1', [requestId]), /inmutable/i);
});

test("pagos hasta 23:59:59 Colombia cuentan y desde 00:00 del día siguiente no", async (t) => {
  const source = readFileSync(servicePath, "utf8");
  assert.match(source, /\(r\."promiseDate"\+1\)::timestamp \+ interval '5 hours'/);
  assert.match(source, /r\."decidedAt" AT TIME ZONE 'UTC'/);

  const database = new PGlite();
  t.after(() => database.close());
  await database.query('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY)');
  await database.query('CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY)');
  await database.query('INSERT INTO "Credito" ("id") VALUES (2),(3)');
  await database.query('INSERT INTO "Usuario" ("id") VALUES (1)');
  await database.query(`CREATE TABLE "CreditoAbono" (
    "creditoId" INTEGER NOT NULL, "valor" NUMERIC(20,2) NOT NULL,
    "estado" TEXT NOT NULL, "fechaAbono" TIMESTAMP NOT NULL
  )`);
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => database.query(sql, params) });
  const requestId = "30000000-0000-4000-8000-000000000001";
  await insertRequest(database, {
    id: requestId,
    creditoId: 2,
    status: "APPROVED",
    key: "30000000-0000-4000-8000-000000000002",
  });
  await database.query(`INSERT INTO "CreditoAbono" VALUES
    (2,10,'APLICADO','2026-10-05 11:59:59.999'),
    (2,200,'APLICADO','2026-10-07 04:59:59.999'),
    (2,900,'APLICADO','2026-10-07 05:00:00.000')`);
  const result = await database.query(`SELECT COALESCE(SUM(payment."valor"),0)::double precision AS paid
    FROM "CreditMoraExceptionRequest" r JOIN "CreditoAbono" payment ON payment."creditoId"=r."creditoId"
    WHERE r."id"=$1 AND payment."fechaAbono">=(r."decidedAt" AT TIME ZONE 'UTC')
      AND payment."fechaAbono"<((r."promiseDate"+1)::timestamp + interval '5 hours')`, [requestId]);
  assert.equal(result.rows[0].paid, 200);

  const prisma = {
    $queryRawUnsafe: async (sql, ...params) => (await database.query(sql, params)).rows,
  };
  const service = loadService({ prisma, plan: basePlan });
  assert.equal(await service.latestExceptionExpiry(prisma, 2), null, "una promesa cumplida no inicia enfriamiento");
  await insertRequest(database, {
    id: "30000000-0000-4000-8000-000000000003",
    creditoId: 3,
    status: "APPROVED",
    key: "30000000-0000-4000-8000-000000000004",
  });
  assert.equal(await service.latestExceptionExpiry(prisma, 3), "2026-10-06", "una promesa incumplida sí inicia enfriamiento");
  const active = await service.getActiveMoraExceptionsByCreditIds([1, 2, 2], new Date("2026-10-06T17:00:00.000Z"));
  assert.deepEqual([...active.keys()], [2]);
  assert.equal(active.get(2).fechaFin.toISOString(), "2026-10-07T04:59:59.999Z");
  assert.equal((await service.getActiveMoraExceptionsByCreditIds([2], new Date("2026-10-07T17:00:00.000Z"))).size, 0);
});
function loadPermissionService({ prisma, actorChecks = [] }) {
  const path = new URL("../lib/mora-exception-permissions.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  const dependencies = {
    "server-only": {},
    "node:crypto": { createHash, randomUUID },
    "@/lib/prisma": { default: prisma },
    "@/lib/analyst-mora-access": {
      assertMoraActor: async (_db, actor, centralOnly) => {
        actorChecks.push({ id: actor.id, centralOnly });
        return { ...actor, nombre: actor.nombre || `Usuario ${actor.id}`, centralAdmin: true };
      },
    },
    "@/lib/credit-approval-errors": { CreditApprovalError },
    "@/lib/mora-exception-schema": { ensureMoraExceptionRequestSchema: async () => {} },
    "@/lib/mora-exception-requests": { MORA_COOLDOWN_BYPASS_PERMISSION: "MORA_COOLDOWN_BYPASS" },
  };
  runInNewContext(outputText, {
    exports: loaded.exports,
    module: loaded,
    require(name) {
      assert.ok(name in dependencies, `Dependencia inesperada: ${name}`);
      return dependencies[name];
    },
    Date,
  }, { filename: "lib/mora-exception-permissions.ts" });
  return loaded.exports;
}

test("permisos usan contrato estricto, actor central revalidado y ledger idempotente", async (t) => {
  const database = new PGlite();
  t.after(() => database.close());
  await database.query('CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY)');
  await database.query('CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT NOT NULL, "activo" BOOLEAN NOT NULL)');
  await database.query('CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER NOT NULL, "activa" BOOLEAN NOT NULL)');
  await database.query('CREATE TABLE "Rol" ("id" INTEGER PRIMARY KEY, "nombre" TEXT NOT NULL)');
  await database.query('CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY, "nombre" TEXT NOT NULL, "rolId" INTEGER NOT NULL, "sedeId" INTEGER NOT NULL, "activo" BOOLEAN NOT NULL)');
  await database.query("INSERT INTO \"Aliado\" VALUES (1,'FINSERPAY',TRUE)");
  await database.query("INSERT INTO \"Sede\" VALUES (1,1,TRUE)");
  await database.query("INSERT INTO \"Rol\" VALUES (1,'ADMIN')");
  await database.query("INSERT INTO \"Usuario\" VALUES (1,'Central uno',1,1,TRUE),(2,'Central dos',1,1,TRUE)");
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => database.query(sql, params) });

  const db = { $queryRawUnsafe: async (sql, ...params) => (await database.query(sql, params)).rows };
  const prisma = { $transaction: async (callback) => callback(db) };
  const actorChecks = [];
  const permissions = loadPermissionService({ prisma, actorChecks });
  const input = permissions.parseMoraPermissionMutation({
    userId: 2,
    active: true,
    reason: "Autorización temporal justificada",
    idempotencyKey: "40000000-0000-4000-8000-000000000001",
  });
  assert.throws(
    () => permissions.parseMoraPermissionMutation({ ...input, idempotencyKey: undefined, idem: "40000000-0000-4000-8000-000000000001" }),
    { code: "INVALID_PERMISSION" }
  );

  const actor = { id: 1, nombre: "Central uno", centralAdmin: true };
  const created = await permissions.changeMoraExceptionPermission(input, actor);
  assert.equal(created.unchanged, false);
  assert.equal(created.item.active, true);
  const repeated = await permissions.changeMoraExceptionPermission(input, actor);
  assert.equal(repeated.unchanged, true);

  const listed = await permissions.listMoraExceptionPermissions(actor);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.users)), [
    { id: 2, nombre: "Central dos" },
    { id: 1, nombre: "Central uno" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(listed.grants)).map(({ userId, active, reason, grantedByName }) => ({ userId, active, reason, grantedByName })), [
    { userId: 2, active: true, reason: "Autorización temporal justificada", grantedByName: "Central uno" },
  ]);
  assert.equal(listed.history.length, 1);
  assert.equal(listed.history[0].actorName, "Central uno");
  assert.ok(actorChecks.length >= 4);
  assert.ok(actorChecks.every((call) => call.centralOnly === true));
});
function decisionHarness({ centralAdmin = true, type = "EXCEPCION", expiresOn = "2026-10-06" } = {}) {
  const requestId = "60000000-0000-4000-8000-000000000001";
  const actor = { id: centralAdmin ? 1 : 2, nombre: centralAdmin ? "Central" : "Analista", centralAdmin };
  const current = {
    id: requestId,
    creditoId: 77,
    type,
    status: "PENDING",
    version: 1,
    installmentNumber: 3,
    installmentDueDate: "2026-10-02",
    expiresOn,
    promiseAmount: 200,
    promiseDate: expiresOn,
    reason: "Motivo válido",
    observation: "Observación válida",
    createdByUserId: 2,
    createdByName: "Analista",
    submittedAt: new Date("2026-10-03T12:00:00.000Z"),
    decidedByUserId: null,
    decidedByName: null,
    decidedAt: null,
    decisionReason: null,
    cooldownBypassed: false,
    cooldownBypassReason: null,
    createdAt: new Date("2026-10-03T12:00:00.000Z"),
    updatedAt: new Date("2026-10-03T12:00:00.000Z"),
    folio: "F-77",
    clienteNombre: "Cliente",
    clienteDocumento: "123",
    paidTowardPromise: 0,
  };
  const queries = [];
  const events = [];
  const checks = [];
  const db = {
    credito: {
      async findUnique() {
        queries.push("credit-read");
        return { estado: "INSCRITO", montoCredito: 900, valorCuota: 300, plazoMeses: 3, frecuenciaPago: "MENSUAL", fechaPrimerPago: null, fechaProximoPago: null, planCapitalVigente: null, pazYSalvoEmitidoAt: null, abonos: [] };
      },
    },
    async $queryRawUnsafe(sql, ...params) {
      if (sql.includes('SELECT "creditoId" FROM "CreditMoraExceptionRequest"')) {
        queries.push("request-credit-read");
        return [{ creditoId: current.creditoId }];
      }
      if (sql.includes('WHERE "status"=\'APPROVED\' AND "expiresOn"<$1::date')) { queries.push("expire-approved"); return []; }
      if (sql.includes('SELECT * FROM "CreditMoraExceptionEvent" WHERE "idempotencyKey"')) {
        queries.push("idempotency-read");
        return events.filter((event) => event.idempotencyKey === params[0]);
      }
      if (sql.includes('SELECT * FROM "CreditMoraExceptionRequest"') && sql.includes("FOR UPDATE")) {
        queries.push("request-lock");
        return [{ ...current }];
      }
      if (sql.includes('SELECT "id" FROM "Credito"') && sql.includes("FOR UPDATE")) {
        queries.push("credit-lock");
        return [{ id: current.creditoId }];
      }
      if (sql.includes('SELECT request."expiresOn"')) { queries.push("cooldown-read"); return []; }
      if (sql.startsWith('UPDATE "CreditMoraExceptionRequest" SET "version"')) {
        queries.push("observe-update");
        current.version = params[1];
        current.updatedAt = new Date("2026-10-03T13:00:00.000Z");
        return [];
      }
      if (sql.startsWith('UPDATE "CreditMoraExceptionRequest" SET "status"')) {
        queries.push("decision-update");
        current.status = params[1];
        current.version = params[2];
        current.decidedByUserId = params[3];
        current.decidedByName = params[4];
        current.decidedAt = new Date("2026-10-03T13:00:00.000Z");
        current.decisionReason = params[5];
        current.cooldownBypassed = params[6];
        current.cooldownBypassReason = params[7];
        current.updatedAt = current.decidedAt;
        return [];
      }
      if (sql.includes('INSERT INTO "CreditMoraExceptionEvent"')) {
        queries.push("event-insert");
        events.push({
          id: params[0],
          requestId: params[1],
          creditoId: params[2],
          version: params[3],
          action: params[4],
          fromStatus: params[5],
          toStatus: params[6],
          payload: JSON.parse(params[7]),
          actorUserId: params[8],
          actorName: params[9],
          idempotencyKey: params[10],
          requestHash: params[11],
          createdAt: new Date("2026-10-03T13:00:00.000Z"),
        });
        return [];
      }
      if (sql.includes('FROM "CreditMoraExceptionRequest" r JOIN "Credito" credit') && sql.includes('WHERE r."id"=$1::uuid')) {
        queries.push("request-read");
        return [{ ...current }];
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  };
  const prisma = { $transaction: async (callback) => callback(db) };
  const service = loadService({
    prisma,
    plan: basePlan,
    assertActor: async (_db, checkedActor, centralOnly) => {
      checks.push({ id: checkedActor.id, centralOnly });
      if (centralOnly && !checkedActor.centralAdmin) throw new CreditApprovalError("FORBIDDEN", "Solo central", 403);
      return checkedActor;
    },
  });
  return { actor, checks, current, events, queries, requestId, service };
}

function decisionInput(action, idempotencyKey, version = 1) {
  return { action, version, reason: "Decisión justificada", bypassCooldown: false, bypassReason: null, idempotencyKey };
}

test("analista solo observa; aprobación exige central y registra nueva versión", async () => {
  const harness = decisionHarness({ centralAdmin: false });
  await assert.rejects(
    harness.service.actOnMoraExceptionRequest(harness.requestId, decisionInput("APPROVE", "60000000-0000-4000-8000-000000000002"), harness.actor, new Date("2026-10-03T17:00:00.000Z")),
    { code: "FORBIDDEN" }
  );
  const observed = await harness.service.actOnMoraExceptionRequest(
    harness.requestId,
    decisionInput("OBSERVE", "60000000-0000-4000-8000-000000000003"),
    harness.actor,
    new Date("2026-10-03T17:00:00.000Z")
  );
  assert.equal(observed.item.status, "PENDING");
  assert.equal(observed.item.version, 2);
  assert.equal(harness.events[0].action, "OBSERVED");
  assert.deepEqual(harness.checks.map((item) => item.centralOnly), [true, false]);
});

test("aprobación bloquea crédito antes de solicitud y replay es idempotente", async () => {
  const harness = decisionHarness();
  const input = decisionInput("APPROVE", "60000000-0000-4000-8000-000000000004");
  const approved = await harness.service.actOnMoraExceptionRequest(harness.requestId, input, harness.actor, new Date("2026-10-03T17:00:00.000Z"));
  assert.equal(approved.item.status, "APPROVED");
  assert.ok(harness.queries.indexOf("credit-lock") < harness.queries.indexOf("request-lock"));
  assert.ok(harness.queries.indexOf("credit-lock") < harness.queries.indexOf("credit-read"));
  const replay = await harness.service.actOnMoraExceptionRequest(harness.requestId, input, harness.actor, new Date("2026-10-03T17:00:00.000Z"));
  assert.equal(replay.unchanged, true);
  assert.equal(harness.events.length, 1);
});

test("versión obsoleta y ventana vencida rechazan sin decisión parcial", async () => {
  const changed = decisionHarness();
  await assert.rejects(
    changed.service.actOnMoraExceptionRequest(changed.requestId, decisionInput("APPROVE", "60000000-0000-4000-8000-000000000005", 2), changed.actor, new Date("2026-10-03T17:00:00.000Z")),
    { code: "MORA_REQUEST_CHANGED" }
  );
  assert.equal(changed.queries.includes("credit-lock"), true);
  assert.equal(changed.events.length, 0);

  const expired = decisionHarness({ type: "PRORROGA" });
  await assert.rejects(
    expired.service.actOnMoraExceptionRequest(expired.requestId, decisionInput("APPROVE", "60000000-0000-4000-8000-000000000006"), expired.actor, new Date("2026-10-07T17:00:00.000Z")),
    { code: "INVALID_MORA_EXCEPTION" }
  );
  assert.equal(expired.events.length, 0);
  assert.ok(expired.queries.includes("credit-lock"));
});

test("central aprueba una prórroga sin límite de cuatro días ni permiso adicional", async () => {
  const harness = decisionHarness({ type: "PRORROGA", expiresOn: "2026-10-30" });
  const approved = await harness.service.actOnMoraExceptionRequest(
    harness.requestId,
    decisionInput("APPROVE", "60000000-0000-4000-8000-000000000007"),
    harness.actor,
    new Date("2026-10-07T17:00:00.000Z")
  );
  assert.equal(approved.item.status, "APPROVED");
  assert.equal(approved.item.expiresOn, "2026-10-30");
  assert.equal(harness.events[0].actorName, "Central");
  assert.equal(harness.queries.includes("cooldown-read"), false);
});
