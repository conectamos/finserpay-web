import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { secondCreditAuthorizationSchemaStatements } from "../scripts/second-credit-authorization-schema.mjs";
import { loadStore, actor, mutation } from "./second-credit-authorization-fixture.mjs";

const source = readFileSync(new URL("../lib/solicitudes-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("solicitudes-storage.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "ActiveSolicitudConflictError", "sameOwner", "findBlockingSolicitudByDocument",
  "solicitudConflictFromBlocker", "findActiveByIdentity", "reserveSolicitudForIdentity",
]);
const implementation = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name?.text)
).map(node => node.getText(ast)).join("\n");

async function fixture(t) {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "Usuario" (id integer PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (${actor.id});
    CREATE TABLE "Credito" (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, estado text NOT NULL DEFAULT 'GENERADO',
      "clienteDocumento" text, "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
      "montoCredito" float8, "cuotaInicial" float8 NOT NULL DEFAULT 0,
      "sedeId" integer NOT NULL DEFAULT 1, "vendedorId" integer NOT NULL DEFAULT 2,
      folio text NOT NULL DEFAULT 'HISTORICO', "contratoSnapshot" jsonb NOT NULL DEFAULT '{"signed":"original"}'
    );
    CREATE TABLE "CreditoAbono" (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "creditoId" integer,
      valor float8 NOT NULL, estado text NOT NULL DEFAULT 'REGISTRADO'
    );
    CREATE TABLE "CreditoBorrador" (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, estado text NOT NULL DEFAULT 'ABIERTO',
      "creditoId" integer, "usuarioId" integer, "vendedorId" integer, "sedeId" integer,
      "currentStep" integer NOT NULL DEFAULT 1, "clienteDocumento" text, imei text, plataforma text,
      "dataCreditoStatus" text, "dataCreditoAssessmentId" uuid, payload jsonb NOT NULL DEFAULT '{}',
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "expiresAt" timestamptz DEFAULT '2300-01-01',
      "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "closedReason" text
    );
  `);
  const events = [];
  const adapter = database => ({
    $queryRawUnsafe: async (sql, ...values) => {
      events.push({ kind: "query", sql, values });
      return (await database.query(sql, values)).rows;
    },
    $executeRawUnsafe: async (sql, ...values) => {
      events.push({ kind: "execute", sql, values });
      return (await database.query(sql, values)).affectedRows;
    },
  });
  const prisma = {
    ...adapter(pg),
    $transaction: callback => pg.transaction(database => callback(adapter(database))),
  };
  const secondCredit = loadStore(prisma, secondCreditAuthorizationSchemaStatements);
  let blacklisted = false;
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(implementation, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module: loaded, exports: loaded.exports, prisma, ...secondCredit,
    ensureSolicitudSchema: async () => events.push({ kind: "solicitud-schema" }),
    assertDocumentNotBlacklisted: async () => {
      events.push({ kind: "blacklist" });
      if (blacklisted) throw Object.assign(new Error("Documento bloqueado por revisión administrativa"), { code: "DOCUMENT_BLACKLISTED" });
    },
    lockIdentity: async (db, kind, value) => {
      events.push({ kind: "identity-lock", identity: kind, value });
      await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", `${kind}:${value}`);
    },
    expireStaleWith: async () => {},
    assertImeiNotReservedByActiveDeviceReplacement: async () => {},
    normalizeDigits: value => String(value || "").replace(/\D/g, "").slice(0, 40),
    normalizePlatform: value => ["ANDROID", "IPHONE"].includes(value) ? value : null,
    isCompleteImei: value => /^\d{15}$/.test(value),
  });
  const reserve = (document, extra = {}) => loaded.exports.reserveSolicitudForIdentity({
    usuarioId: 20, vendedorId: 30, sedeId: 40, clienteDocumento: document,
    clientePrimerApellido: "Pérez", plataforma: "IPHONE", ...extra,
  });
  async function credit(document, { amount = 1000, paid = 0, state = "GENERADO", initial = 200, paymentState = "REGISTRADO" } = {}) {
    const id = (await pg.query(`INSERT INTO "Credito" ("clienteDocumento","montoCredito","cuotaInicial",estado)
      VALUES ($1,$2,$3,$4) RETURNING id`, [document, amount, initial, state])).rows[0].id;
    if (paid) await pg.query('INSERT INTO "CreditoAbono" ("creditoId",valor,estado) VALUES ($1,$2,$3)', [id, paid, paymentState]);
    return id;
  }
  async function authorize(document, changes = {}) {
    await secondCredit.ensureSecondCreditAuthorizationSchema();
    return prisma.$transaction(db => secondCredit.mutateSecondCreditAuthorization(db, mutation({ documentNumber: document, mutationId: randomUUID(), ...changes }), actor));
  }
  return { pg, events, prisma, secondCredit, reserve, credit, authorize,
    blacklist: value => { blacklisted = value; },
    countDrafts: async document => (await pg.query('SELECT COUNT(*)::integer AS n FROM "CreditoBorrador" WHERE "clienteDocumento"=$1', [document])).rows[0].n,
  };
}

const isConflict = error => error.code === "SOLICITUD_ACTIVA_EXISTENTE" || error.code === "ACTIVE_CREDIT_EXISTS" || error.code === "SECOND_CREDIT_LIMIT_REACHED";

test("la reserva respeta la autorización central de segundo crédito sin alterar histórico, pagos ni permiso", async t => {
  const f = await fixture(t), document = "900000001";
  const id = await f.credit(document, { paid: 100 });
  await f.authorize(document);
  const beforeCredits = (await f.pg.query('SELECT * FROM "Credito" ORDER BY id')).rows;
  const beforePayments = (await f.pg.query('SELECT * FROM "CreditoAbono" ORDER BY id')).rows;
  const beforePermission = (await f.pg.query('SELECT * FROM "SecondCreditAuthorization"')).rows;
  const beforeAudit = (await f.pg.query('SELECT * FROM "SecondCreditAuthorizationEvent"')).rows;
  f.events.length = 0;
  const created = await f.reserve(document);
  assert.equal(created.reused, false);
  assert.equal(await f.countDrafts(document), 1);
  assert.equal((await f.reserve(document, { solicitudId: created.id })).reused, true);
  assert.equal(await f.countDrafts(document), 1, "Retomar la misma venta no crea otra reserva");
  await assert.rejects(f.reserve(document, { usuarioId: 91, vendedorId: 92, sedeId: 93 }), isConflict);
  assert.deepEqual((await f.pg.query('SELECT * FROM "Credito" ORDER BY id')).rows, beforeCredits);
  assert.deepEqual((await f.pg.query('SELECT * FROM "CreditoAbono" ORDER BY id')).rows, beforePayments);
  assert.deepEqual((await f.pg.query('SELECT * FROM "SecondCreditAuthorization"')).rows, beforePermission);
  assert.deepEqual((await f.pg.query('SELECT * FROM "SecondCreditAuthorizationEvent"')).rows, beforeAudit);
  assert.equal((await f.secondCredit.getSecondCreditEligibility(f.prisma, [document])).get(document).activeCreditIds[0], id);
});

test("sin autorización, revocada o con dos créditos activos no se puede reservar una venta adicional", async t => {
  const f = await fixture(t);
  for (const [document, mode] of [["900000002", "missing"], ["900000003", "revoked"], ["900000004", "two"]]) {
    await f.credit(document);
    if (mode !== "missing") await f.authorize(document);
    else await f.secondCredit.ensureSecondCreditAuthorizationSchema();
    if (mode === "revoked") await f.authorize(document, { action: "REVOKE", expectedVersion: 1, mutationId: "f0fdbbf1-8aba-40af-8b87-93003767c4ba" });
    if (mode === "two") await f.credit(document);
    await assert.rejects(f.reserve(document), isConflict, mode);
    assert.equal(await f.countDrafts(document), 0, mode);
  }
});

test("la autorización no omite otra solicitud pendiente, un rechazo vigente ni la lista negra", async t => {
  const f = await fixture(t);
  for (const [document, state, reason] of [["900000005", "ABIERTO", null], ["900000006", "CERRADO", "RECHAZADA"]]) {
    await f.credit(document); await f.authorize(document);
    await f.pg.query(`INSERT INTO "CreditoBorrador" ("usuarioId","vendedorId","sedeId","clienteDocumento",estado,"closedReason",payload)
      VALUES (1,2,3,$1,$2,$3,'{"solicitudOrigen":"DATACREDITO"}')`, [document, state, reason]);
    const before = (await f.pg.query('SELECT * FROM "CreditoBorrador" WHERE "clienteDocumento"=$1', [document])).rows;
    await assert.rejects(f.reserve(document), isConflict);
    assert.deepEqual((await f.pg.query('SELECT * FROM "CreditoBorrador" WHERE "clienteDocumento"=$1', [document])).rows, before);
  }
  const document = "900000007";
  await f.credit(document); await f.authorize(document); f.blacklist(true);
  await assert.rejects(f.reserve(document), { code: "DOCUMENT_BLACKLISTED" });
  assert.equal(await f.countDrafts(document), 0);
});

test("los créditos pagados o anulados permiten renovar; los abonos anulados conservan el saldo", async t => {
  const f = await fixture(t);
  await f.secondCredit.ensureSecondCreditAuthorizationSchema();
  for (const [document, options] of [["900000008", { paid: 1000 }], ["900000009", { state: "ANULADO" }], ["900000010", { amount: 0 }]]) {
    await f.credit(document, options);
    assert.equal((await f.reserve(document, { plataforma: "ANDROID" })).reused, false);
  }
  const document = "900000011";
  await f.credit(document, { paid: 1000, paymentState: "ANULADO" });
  await assert.rejects(f.reserve(document), isConflict);
  assert.equal(await f.countDrafts(document), 0);
});

test("la autorización revocada durante una reserva impide retomarla y un fallo de lectura nunca habilita el segundo crédito", async t => {
  const f = await fixture(t), document = "900000012";
  await f.credit(document); await f.authorize(document);
  const created = await f.reserve(document);
  await f.authorize(document, { action: "REVOKE", expectedVersion: 1, mutationId: "6fd898da-87e5-44f0-b8fb-652422c0f914" });
  await assert.rejects(f.reserve(document, { solicitudId: created.id }), isConflict);
  assert.equal(await f.countDrafts(document), 1);
  await f.pg.exec('ALTER TABLE "SecondCreditAuthorization" RENAME TO "SecondCreditAuthorizationUnavailable"');
  await assert.rejects(f.reserve("900000013"), { code: "SECOND_CREDIT_AUTHORIZATION_UNAVAILABLE" });
  assert.equal(await f.countDrafts("900000013"), 0);
});

test("el crédito histórico con documento formateado o ceros iniciales se verifica con la identidad canónica", async t => {
  const f = await fixture(t), document = "900000014";
  await f.credit("CC-00900.000.014");
  await f.secondCredit.ensureSecondCreditAuthorizationSchema();
  await assert.rejects(f.reserve(document), isConflict);
  assert.equal(await f.countDrafts(document), 0);
  await f.authorize(document);
  assert.equal((await f.reserve(document)).reused, false);
  assert.equal(await f.countDrafts(document), 1);
});
