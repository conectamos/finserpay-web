import { EXPORT_CURRENT_SCHEMA_SQL, EXPORT_FIXTURE_SQL } from "./helpers/solicitudes-export-fixture.mjs";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const jiti = createJiti(import.meta.url);
const { normalizeExportFilters, assertExportViewer, exportDateBounds } = await jiti.import("../lib/solicitudes-export-core.ts");
const { getExportOptions, validateExportScope, countExportRows, iterateExportRows, buildExportQuery } = await jiti.import("../lib/solicitudes-export-data.ts");
const central = { kind: "CENTRAL_ADMIN", userId: 1, aliadoId: 1, sedeId: 10, vendedorId: null };
const ally = { ...central, kind: "ALLY_ADMIN" };
const filters = (changes = {}) => normalizeExportFilters({ period: "all", ...changes });
let pg;
const db = { $queryRawUnsafe: async (sql, ...values) => (await pg.query(sql, values)).rows };
async function exported(viewer = central, changes = {}, batch = 1000) {
  const rows = [];
  for await (const row of iterateExportRows(viewer, filters(changes), db, batch)) rows.push(row);
  return rows;
}

before(async () => {
  pg = new PGlite();
  await pg.exec(EXPORT_FIXTURE_SQL);
});
after(async () => { await pg.close(); });

test("validación estricta, roles y días completos de Bogotá", () => {
  for (const input of [null, [], { period: "today" }, { aliadoIds: ["2"] }, { sedeIds: [-1] }, { vendedorIds: [1.5] }, { period: "month", month: "2026-13" }, { period: "range", desde: "2026-02-30" }, { period: "range", desde: "2026-10-20", hasta: "2026-10-10" }, { period: "range" }, { estado: "INVALID" }]) {
    assert.throws(() => normalizeExportFilters(input), { status: 400 });
  }
  for (const kind of ["SUPERVISOR", "SELLER", "OTHER"]) assert.throws(() => assertExportViewer({ ...central, kind }), { status: 403 });
  assert.throws(() => assertExportViewer({ ...ally, aliadoId: null }), { status: 403 });
  assert.deepEqual(exportDateBounds(filters({ period: "month", month: "2026-10" })), {
    start: new Date("2026-10-01T05:00:00Z"), endExclusive: new Date("2026-11-01T05:00:00Z"),
  });
  assert.deepEqual(exportDateBounds(filters({ period: "range", hasta: "2026-10-31" })), {
    start: null, endExclusive: new Date("2026-11-01T05:00:00Z"),
  });
  assert.deepEqual(filters({ aliadoIds: [2, 1, 2] }).aliadoIds, [1, 2]);
});

test("central: histórico completo, una fila por solicitud y conteo idéntico", async () => {
  const rows = await exported(central, {}, 2);
  assert.equal(rows.length, 8);
  assert.equal(await countExportRows(central, filters(), db), rows.length);
  assert.equal(new Set(rows.map(row => `${row.source}-${row.entityId}`)).size, rows.length);
  assert.equal(rows.filter(row => row.numeroDocumento === "001.234.567").length, 3);
  const converted = rows.find(row => row.source === "CREDIT" && row.entityId === 1);
  assert.equal(converted.solicitudNumero, "SOL-000003");
  assert.equal(converted.createdAt.toISOString(), "2026-09-15T15:00:00.000Z");
  assert.equal(converted.operationAt.toISOString(), "2026-10-02T15:00:00.000Z");
  assert.equal(converted.numeroCredito, "00001");
  assert.equal(converted.numeroSadmin, "000000123");
  assert.equal(converted.imei, "001234567890123");
  assert.equal(rows.find(row => row.source === "DRAFT" && row.entityId === 1).numeroSadmin, null);
  const draft = rows.find(row => row.source === "DRAFT" && row.entityId === 1);
  assert.equal(draft.valorEquipo, 1200000);
  assert.equal(draft.inicial, 200000);
  assert.equal(draft.numeroCuotas, 12);
  assert.equal(draft.valorCuota, 100000);
  assert.equal(draft.valorFinanciado, null, "No calcular importes ausentes del payload guardado");
  assert.equal(draft.tipoDocumento, null);
  assert.equal(draft.direccion, null);
  assert.equal(rows.find(row => row.source === "CREDIT" && row.entityId === 2).numeroSadmin, null);
  assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_EXPORT|fotoEntregaDataUrl|contratoSnapshot|payload/);
});

test("filtros combinados por aliados, sedes, vendedores, mes y plataforma", async () => {
  const selection = { aliadoIds: [1], sedeIds: [10, 11], vendedorIds: [100, 101, 300], period: "month", month: "2026-10" };
  const rows = await exported(central, selection, 2);
  assert.deepEqual(rows.map(row => `${row.source}-${row.entityId}`), ["CREDIT-1", "CREDIT-2", "CREDIT-4", "DRAFT-1"]);
  assert.equal(await countExportRows(central, filters(selection), db), rows.length);
  assert.deepEqual((await exported(central, { ...selection, plataforma: "ANDROID" })).map(row => `${row.source}-${row.entityId}`), ["CREDIT-1", "DRAFT-1"]);
  assert.equal((await exported(central, { aliadoIds: [1, 2] })).length, 8);
  assert.equal((await exported(central, { sedeIds: [11], vendedorIds: [100] })).length, 0);
});

test("rango inclusivo y ausencia de resultados", async () => {
  const rows = await exported(central, { period: "range", desde: "2026-10-01", hasta: "2026-10-31" });
  assert.equal(rows.length, 6);
  assert(rows.some(row => row.source === "CREDIT" && row.entityId === 4));
  assert(!rows.some(row => row.source === "CREDIT" && row.entityId === 5));
  const empty = { period: "month", month: "1999-01" };
  assert.equal(await countExportRows(central, filters(empty), db), 0);
  assert.deepEqual(await exported(central, empty), []);
});

test("admin aliado: opciones, consultas y ataques a identificadores externos", async () => {
  const options = await getExportOptions(ally, db);
  assert.deepEqual(options.aliados.map(row => row.id), [1]);
  assert.deepEqual(options.sedes.map(row => row.id), [10, 11]);
  assert.deepEqual(options.vendedores.map(row => row.id).sort(), [100, 101, 300]);
  const rows = await exported(ally);
  assert.equal(rows.length, 6);
  assert(rows.every(row => row.aliadoId === 1));
  for (const attack of [{ aliadoIds: [2] }, { aliadoIds: [1, 2] }, { sedeIds: [20] }, { vendedorIds: [200] }, { sedeIds: [999999] }]) {
    await assert.rejects(validateExportScope(ally, filters(attack), db), { status: 403 });
    await assert.rejects(countExportRows(ally, filters(attack), db), { status: 403 });
    await assert.rejects(exported(ally, attack), { status: 403 });
    // Even bypassing the options check cannot widen the server-owned row predicate.
    const query = buildExportQuery(ally, filters(attack));
    const unvalidatedRows = await db.$queryRawUnsafe(query.sql, ...query.values);
    assert(unvalidatedRows.every(row => row.aliadoId === 1));
  }
});

test("estados canónicos usan solo el último registro de cada relación", async () => {
  const rows = await exported(central, { estado: "LISTA_PARA_ENTREGA" });
  assert.deepEqual(rows.map(row => `${row.source}-${row.entityId}`), ["DRAFT-1"]);
  assert.match(rows[0].estado, /^(?:En proceso|Proceso) · Lista para entrega$/);
  assert.equal((await exported(central, { estado: "RECHAZADA" })).length, 1);
  assert.deepEqual((await exported(central, { estado: "PROCESO" })).map(row => `${row.source}-${row.entityId}`), ["DRAFT-1", "DRAFT-5"]);
});

test("búsqueda del muro: documento normalizado, Sadmin confirmado y caracteres literales", async () => {
  for (const [q, expected] of [
    ["001234567", ["CREDIT-1", "CREDIT-2", "DRAFT-1"]],
    ["001 234-567", ["CREDIT-1", "CREDIT-2", "DRAFT-1"]],
    ["000000123", ["CREDIT-1"]],
    ["000000999", []],
    ["%", []], ["_", []], ["' OR TRUE --", []],
  ]) {
    const rows = await exported(central, { q }, 2);
    assert.deepEqual(rows.map(row => `${row.source}-${row.entityId}`), expected, q);
    assert.equal(await countExportRows(central, filters({ q }), db), rows.length, q);
  }
});

test("esquema actual: resultados retenidos, estados comerciales y etapas sin perder histórico", async () => {
  const current = new PGlite();
  try {
    await current.exec(EXPORT_FIXTURE_SQL + EXPORT_CURRENT_SCHEMA_SQL);
    const database = { $queryRawUnsafe: async (sql, ...values) => (await current.query(sql, values)).rows };
    async function rowsFor(changes = {}) {
      const rows = [];
      for await (const row of iterateExportRows(central, filters(changes), database, 3)) rows.push(row);
      assert.equal(await countExportRows(central, filters(changes), database), rows.length);
      return rows;
    }
    const rows = await rowsFor();
    assert.equal(rows.length, 20);
    const converted = rows.find(row => row.source === "CREDIT" && row.entityId === 1);
    assert.equal(converted.sedeId, 11);
    assert.equal(converted.createdAt.toISOString(), "2026-09-15T15:00:00.000Z");
    assert.equal(converted.solicitudNumero, "SOL-000003");
    assert.equal(rows.filter(row => row.numeroDocumento === "001.234.567").length, 7);
    for (const [estado, expected] of [
      ["APROBADA", ["CREDIT-1", "CREDIT-2", "CREDIT-4", "CREDIT-5"]],
      ["CANCELADA", ["CREDIT-3", "DRAFT-22", "DRAFT-23", "DRAFT-24"]],
      ["RECHAZADA", ["DRAFT-2", "DRAFT-25"]],
      ["ERROR_TECNICO", ["DRAFT-21"]],
      ["PROCESO", ["DRAFT-1", "DRAFT-5", "DRAFT-20", "DRAFT-26", "DRAFT-27", "DRAFT-28", "DRAFT-29", "DRAFT-30", "DRAFT-31"]],
      ["CONSULTA_PENDIENTE", ["DRAFT-5", "DRAFT-26"]],
      ["CONTRATOS", ["DRAFT-27", "DRAFT-31"]],
      ["VALIDACION_FACIAL", ["DRAFT-30"]],
      ["LISTA_PARA_ENTREGA", ["DRAFT-1", "DRAFT-28", "DRAFT-29"]],
    ]) {
      assert.deepEqual((await rowsFor({ estado })).map(row => `${row.source}-${row.entityId}`), expected, estado);
    }
  } finally {
    await current.close();
  }
});

test("histórico grande continúa todos los lotes sin el límite de la página", async () => {
  await pg.exec(`INSERT INTO "Credito" (id,"sedeId","vendedorId",folio,"createdAt","fechaCredito",estado,"clienteNombre") SELECT n,10,100,'L-' || n,'2025-01-15'::timestamp,'2025-01-15'::timestamp,'GENERADO','Lote' FROM generate_series(1000,3504) n`);
  try {
    const selection = { period: "month", month: "2025-01" };
    const rows = await exported(ally, selection, 128);
    assert.equal(rows.length, 2505);
    assert.equal(await countExportRows(ally, filters(selection), db), rows.length);
    assert.equal(rows[0].entityId, 1000);
    assert.equal(rows.at(-1).entityId, 3504);
  } finally {
    await pg.exec(`DELETE FROM "Credito" WHERE id >= 1000`);
  }
});

test("números de solicitud con más de seis dígitos se conservan en borrador y crédito convertido", async () => {
  await pg.exec(`
    INSERT INTO "Credito" (id,"sedeId","vendedorId",folio,"createdAt","fechaCredito",estado,"clienteNombre")
    VALUES (9000001,10,100,'C-LONG-ID','2024-01-15','2024-01-15','GENERADO','Identificador largo');
    INSERT INTO "CreditoBorrador" (id,"sedeId","vendedorId","creditoId","createdAt",estado,"expiresAt","currentStep","dataCreditoAssessmentId") VALUES
      (1000000,10,100,null,'2024-01-15','ABIERTO','2099-01-01',1,'00000000-0000-4000-8000-000000000001'),
      (1000001,10,100,9000001,'2024-01-14','CERRADO','2099-01-01',5,null);
  `);
  try {
    const selection = { period: "month", month: "2024-01" };
    const rows = await exported(ally, selection, 1);
    assert.equal(await countExportRows(ally, filters(selection), db), 2);
    assert.deepEqual(rows.map(row => [row.source, row.entityId, row.solicitudNumero]), [
      ["CREDIT", 9000001, "SOL-1000001"],
      ["DRAFT", 1000000, "SOL-1000000"],
    ]);
    assert.equal(new Set(rows.map(row => row.solicitudNumero)).size, 2);
  } finally {
    await pg.exec(`DELETE FROM "CreditoBorrador" WHERE id IN (1000000,1000001); DELETE FROM "Credito" WHERE id = 9000001`);
  }
});

test("instalaciones sin registro Sadmin mantienen el dato vacío", async () => {
  await pg.exec(`ALTER TABLE "CreditSadminRegistration" RENAME TO "SavedSadminRegistration"`);
  try {
    const rows = await exported(central);
    assert(rows.every(row => row.numeroSadmin === null));
    assert.equal(await countExportRows(central, filters({ q: "000000123" }), db), 0);
    assert.deepEqual(await exported(central, { q: "000000123" }), []);
  } finally {
    await pg.exec(`ALTER TABLE "SavedSadminRegistration" RENAME TO "CreditSadminRegistration"`);
  }
});
