import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { selectCanonicalSolicitudesByDocument } from "../lib/solicitudes.ts";

const source = readFileSync(new URL("../lib/solicitudes-storage.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("solicitudes-storage.ts", source, ts.ScriptTarget.Latest, true);
const names = new Set([
  "ActiveSolicitudConflictError", "sameOwner", "findBlockingSolicitudByDocument",
  "solicitudConflictFromBlocker", "findActiveByIdentity", "reserveSolicitudForIdentity",
]);
const implementation = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && names.has(node.name?.text)
).map(node => node.getText(ast)).join("\n");
assert.equal(implementation.match(/(?:class|function) /g)?.length, names.size);

test("un crédito pagado libera la cédula globalmente sin borrar el histórico ni otra solicitud", async t => {
  const pg = new PGlite();
  t.after(() => pg.close());
  await pg.exec(`
    CREATE TABLE "Credito" (
      "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "estado" text NOT NULL DEFAULT 'GENERADO', "clienteDocumento" text,
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "montoCredito" float8,
      "cuotaInicial" float8 DEFAULT 0, "sedeId" integer, "vendedorId" integer,
      "folio" text, "contratoSnapshot" jsonb
    );
    CREATE TABLE "CreditoAbono" (
      "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "creditoId" integer, "valor" float8, "estado" text DEFAULT 'REGISTRADO'
    );
    CREATE TABLE "CreditoBorrador" (
      "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "estado" text NOT NULL DEFAULT 'ABIERTO', "creditoId" integer,
      "usuarioId" integer, "vendedorId" integer, "sedeId" integer,
      "currentStep" integer DEFAULT 1, "clienteDocumento" text,
      "imei" text, "plataforma" text, "dataCreditoStatus" text,
      "dataCreditoAssessmentId" uuid, "payload" jsonb DEFAULT '{}',
      "createdAt" timestamptz DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" timestamptz DEFAULT '2300-01-01',
      "updatedAt" timestamptz DEFAULT CURRENT_TIMESTAMP, "closedReason" text
    );
  `);
  const locks = [];
  const adapter = db => ({
    $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).affectedRows,
  });
  const loaded = { exports: {} };
  runInNewContext(ts.transpileModule(implementation, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, {
    module: loaded, exports: loaded.exports,
    prisma: { $transaction: callback => pg.transaction(db => callback(adapter(db))) },
    ensureSolicitudSchema: async () => {},
    assertDocumentNotBlacklisted: async () => {},
    lockIdentity: async (_db, kind, value) => locks.push([kind, value]),
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
  const credit = async (document, { amount = 1000, paid = 1000, state = "GENERADO", initial = 200 } = {}) => {
    const row = (await pg.query(`INSERT INTO "Credito" (
      "clienteDocumento","montoCredito","cuotaInicial","estado","sedeId","vendedorId","folio","contratoSnapshot")
      VALUES ($1,$2,$3,$4,1,2,'HISTORICO','{"signed":"original"}') RETURNING "id"`,
    [document, amount, initial, state])).rows[0];
    if (paid) await pg.query('INSERT INTO "CreditoAbono" ("creditoId","valor") VALUES ($1,$2)', [row.id, paid]);
    return row.id;
  };
  const blocked = async operation => assert.rejects(operation, error =>
    error.code === "SOLICITUD_ACTIVA_EXISTENTE" && error.status === 409
  );

  await t.test("otra tienda y asesor pueden reservar una venta conservando el crédito, recibos y solicitud finalizada", async () => {
    const id = await credit("1.082.873.090");
    await pg.query(`INSERT INTO "CreditoBorrador" (
      "usuarioId","vendedorId","sedeId","clienteDocumento","estado","closedReason","creditoId","payload")
      VALUES (1,2,3,'1082873090','CERRADO','FINALIZADA',$1,'{"signed":"immutable"}')`, [id]);
    const created = await reserve("1082873090");
    assert.equal(created.reused, false);
    const row = (await pg.query('SELECT * FROM "CreditoBorrador" WHERE "id"=$1', [created.id])).rows[0];
    assert.equal(row.usuarioId, 20); assert.equal(row.vendedorId, 30); assert.equal(row.sedeId, 40);
    assert.equal(row.plataforma, "IPHONE"); assert.equal(row.estado, "ABIERTO");
    const old = (await pg.query('SELECT * FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    assert.deepEqual(old.contratoSnapshot, { signed: "original" }); assert.equal(old.sedeId, 1);
    assert.equal((await pg.query('SELECT COUNT(*)::int AS n FROM "CreditoAbono" WHERE "creditoId"=$1', [id])).rows[0].n, 1);
    const original = (await pg.query('SELECT * FROM "CreditoBorrador" WHERE "creditoId"=$1', [id])).rows[0];
    assert.equal(original.closedReason, "FINALIZADA"); assert.deepEqual(original.payload, { signed: "immutable" });
    assert.equal((await reserve("1082873090", { solicitudId: created.id })).reused, true);
    await blocked(() => reserve("1082873090", { usuarioId: 91, vendedorId: 92, sedeId: 93 }));
    assert.ok(locks.some(([kind, value]) => kind === "document" && value === "1082873090"));
  });

  await t.test("cualquier saldo pendiente sigue bloqueando, sin descontar dos veces la inicial", async () => {
    for (const [document, options] of [
      ["200000001", { paid: 999.99 }],
      ["200000002", { paid: 800, initial: 200 }],
      ["200000003", { paid: 0, state: "PAGADO" }],
      ["200000004", { paid: 0, amount: null }],
    ]) {
      await credit(document, options);
      await blocked(() => reserve(document));
      await blocked(() => reserve(document, { usuarioId: 91, vendedorId: null, sedeId: 93, plataforma: "ANDROID" }));
    }
  });

  await t.test("un abono anulado no salda el crédito y otro crédito activo sigue bloqueando", async () => {
    const id = await credit("300000001", { paid: 0 });
    await pg.query(`INSERT INTO "CreditoAbono" ("creditoId","valor","estado") VALUES ($1,1000,'ANULADO')`, [id]);
    await blocked(() => reserve("300000001"));
    await credit("300000002"); await credit("300000002", { paid: 50 });
    await blocked(() => reserve("300000002"));
  });

  await t.test("el saldo cero o sobrepago permite reservar Android sin importar el aliado anterior", async () => {
    await credit("400000001", { paid: 0, amount: 0 });
    await credit("400000002", { paid: 1100 });
    for (const document of ["400000001", "400000002"]) {
      const created = await reserve(document, { usuarioId: 91, vendedorId: null, sedeId: 93, plataforma: "ANDROID" });
      assert.equal(created.reused, false);
    }
  });

  await t.test("un expediente realmente activo o rechazado no se libera por tener un crédito anterior pagado", async () => {
    for (const [document, state, reason] of [["500000001", "ABIERTO", null], ["500000002", "CERRADO", "RECHAZADA"]]) {
      await credit(document);
      await pg.query(`INSERT INTO "CreditoBorrador" (
        "usuarioId","vendedorId","sedeId","clienteDocumento","estado","closedReason","payload")
        VALUES (1,2,3,$1,$2,$3,'{"solicitudOrigen":"DATACREDITO"}')`, [document, state, reason]);
      await blocked(() => reserve(document));
    }
  });
});

test("el muro muestra la nueva venta y mantiene ocultos los borradores anteriores al crédito", () => {
  const historical = { source: "CREDIT", entityId: 1, clienteDocumento: "1082873090", rawState: "ENTREGABLE", createdAt: "2026-09-01T12:00:00Z" };
  const old = { source: "DRAFT", entityId: 2, clienteDocumento: "1082873090", rawState: "ABIERTO", currentStep: 5, createdAt: "2026-08-01T12:00:00Z" };
  const current = { source: "DRAFT", entityId: 3, clienteDocumento: "1082873090", rawState: "ABIERTO", currentStep: 1, createdAt: "2026-10-19T12:00:00Z" };
  for (const items of [
    [historical, old, current], [old, historical, current], [current, old, historical],
    [current, historical, old], [old, current, historical], [historical, current, old],
  ]) assert.deepEqual(selectCanonicalSolicitudesByDocument(items), [current]);
  assert.deepEqual(selectCanonicalSolicitudesByDocument([old, historical]), [historical]);
  assert.deepEqual(selectCanonicalSolicitudesByDocument([historical, { ...current, createdAt: historical.createdAt }]), [historical]);
  const lateFinalized = { ...historical, finalizedAt: "2026-08-01T12:00:00Z", canonicalCreditCreatedAt: "2026-10-20T12:00:00Z" };
  assert.deepEqual(selectCanonicalSolicitudesByDocument([current, lateFinalized]), [lateFinalized],
    "la fecha comercial retroactiva y el inicio antiguo no permiten que un duplicado previo al guardado real oculte el crédito");
  const laterSale = { ...current, createdAt: "2026-10-21T12:00:00Z" };
  assert.deepEqual(selectCanonicalSolicitudesByDocument([lateFinalized, laterSale]), [laterSale]);
  const rejected = { ...current, rawState: "CERRADO", closedReason: "RECHAZADA" };
  assert.deepEqual(selectCanonicalSolicitudesByDocument([historical, rejected]), [rejected],
    "el asesor conserva acceso a su renovación rechazada para desistirla");
  for (const reason of ["DESISTIDA", "DESISTIDO", "EXPIRADA", "EXPIRADA_15_DIAS", "DUPLICADA"]) {
    assert.deepEqual(selectCanonicalSolicitudesByDocument([historical, { ...rejected, closedReason: reason }]), [historical],
      `${reason} no reemplaza el histórico`);
  }
  for (const invalidDate of [null, "not-a-date"]) {
    assert.deepEqual(selectCanonicalSolicitudesByDocument([historical, { ...current, createdAt: invalidDate }]), [historical]);
    assert.deepEqual(selectCanonicalSolicitudesByDocument([{ ...historical, createdAt: invalidDate }, current]), [{ ...historical, createdAt: invalidDate }]);
  }
  const missingDate = { ...current, createdAt: null };
  const newerIdMissingDate = { ...missingDate, entityId: 4 };
  assert.deepEqual(selectCanonicalSolicitudesByDocument([missingDate, newerIdMissingDate]), [newerIdMissingDate]);
  assert.deepEqual(selectCanonicalSolicitudesByDocument([newerIdMissingDate, missingDate]), [newerIdMissingDate]);
});
