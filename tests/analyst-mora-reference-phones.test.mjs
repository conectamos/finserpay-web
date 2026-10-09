import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadApprovalModule, approvalErrors } from "./credit-approval-test-loader.mjs";

const now = new Date("2026-10-09T16:00:00Z");
function fixture(contratoSnapshot) {
  return { id: 81, folio: "FC-81", clienteNombre: "Cliente sintético", clienteDocumento: "001234",
    clienteTelefono: "3001234567", contratoSnapshot, estado: "ACTIVO", fechaCredito: now,
    sede: { aliado: { id: 2, nombre: "Aliado sintético" } }, registroSadmin: null, abonos: [],
    referenciaEquipo: "Equipo de prueba", imei: "000000000000081" };
}
function service(credit, drafts = [], draftQuery = null) {
  const queries = [];
  const prisma = { credito: { findUnique: async input => { queries.push({ kind: "credit", input }); return credit; } },
    $queryRawUnsafe: async (sql, ...params) => { queries.push({ kind: "draft", sql, params }); return draftQuery ? draftQuery(sql, params) : drafts; } };
  return { queries, api: loadApprovalModule("lib/analyst-mora-credit.ts", {
    "@/lib/prisma": { default: prisma },
    "@/lib/credit-payment-plan": { buildCreditPaymentPlan: () => ({ installments: [] }) },
    "@/lib/colombia-date": { colombiaDateKey: () => "2026-10-09" },
    "@/lib/credit-display-number": { confirmedSadminNumber: () => null },
    "@/lib/credit-approval-errors": approvalErrors,
  }) };
}

test("el detalle lee las dos referencias del cierre y conserva su posición sin consultar borradores", async () => {
  const credit = fixture({ cliente: { referenciasFamiliares: [
    { nombre: "Primera referencia", telefono: " 03001234567 " },
    { nombre: "Segunda referencia", telefono: "3107654321" },
    { nombre: "No corresponde", telefono: "3209999999" },
  ] }, evidencia: { privado: "no incluir" } });
  const before = structuredClone(credit);
  const { api, queries } = service(credit);
  const detail = await api.readMoraCredit(81);
  assert.equal(detail.referenciaFamiliar1Telefono, "03001234567");
  assert.equal(detail.referenciaFamiliar2Telefono, "3107654321");
  assert.equal(queries.length, 1);
  assert.equal(queries[0].input.select.contratoSnapshot, true);
  assert.equal("contratoSnapshot" in detail, false);
  assert.deepEqual(credit, before);
  const summary = api.moraCreditSummary(detail, now);
  assert.equal(summary.referenciaFamiliar1Telefono, "03001234567");
  assert.equal(summary.referenciaFamiliar2Telefono, "3107654321");
});

test("las referencias del cierre prevalecen y cada posición faltante se completa solo con el borrador del crédito", async () => {
  const credit = fixture({ cliente: { referenciasFamiliares: [{ telefono: "3001111111" }, { telefono: " " }] } });
  const { api, queries } = service(credit, [{ referenciaFamiliar1Telefono: "3002222222", referenciaFamiliar2Telefono: " 3103333333 " }]);
  const detail = await api.readMoraCredit(81);
  assert.equal(detail.referenciaFamiliar1Telefono, "3001111111");
  assert.equal(detail.referenciaFamiliar2Telefono, "3103333333");
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[1].params, [81]);
  assert.match(queries[1].sql, /WHERE "creditoId"=\$1/);
  assert.match(queries[1].sql, /ORDER BY "updatedAt" DESC,"id" DESC LIMIT 1/);
  assert.doesNotMatch(queries[1].sql, /clienteDocumento|clienteNombre|SELECT \*/);
  assert.match(queries[1].sql, /jsonb_typeof/);
  assert.equal("contratoSnapshot" in detail, false);
});

test("una segunda referencia no se mueve a la primera posición", async () => {
  const { api } = service(fixture({ cliente: { referenciasFamiliares: [null, { telefono: "3103333333" }] } }));
  const detail = await api.readMoraCredit(81);
  assert.equal(detail.referenciaFamiliar1Telefono, null);
  assert.equal(detail.referenciaFamiliar2Telefono, "3103333333");
});

test("créditos históricos sin referencias muestran nulos sin inventar contactos", async () => {
  for (const snapshot of [null, [], "texto", { cliente: [] }, { cliente: { referenciasFamiliares: {} } },
    { cliente: { referenciasFamiliares: [[], { telefono: 3103333333 }] } }]) {
    const { api } = service(fixture(snapshot));
    const detail = await api.readMoraCredit(81);
    const summary = api.moraCreditSummary(detail, now);
    assert.equal(summary.referenciaFamiliar1Telefono, null);
    assert.equal(summary.referenciaFamiliar2Telefono, null);
  }
});

test("el listado no carga snapshots ni consulta referencias y sus cálculos se conservan", () => {
  const { api, queries } = service(null);
  assert.equal("contratoSnapshot" in api.moraCreditSelect, false);
  const listCredit = fixture(undefined);
  delete listCredit.contratoSnapshot;
  const summary = api.moraCreditSummary(listCredit, now);
  assert.equal(summary.referenciaFamiliar1Telefono, null);
  assert.equal(summary.referenciaFamiliar2Telefono, null);
  assert.equal(summary.valorVencido, 0);
  assert.equal(summary.diasMora, 0);
  assert.equal(summary.enMora, false);
  assert.equal(queries.length, 0);
});

test("un crédito inválido, inexistente o anulado falla antes de consultar sus contactos", async () => {
  const invalid = service(fixture(null));
  for (const id of [0, -1, NaN, 1.5, "81"]) {
    await assert.rejects(invalid.api.readMoraCredit(id), error => error.code === "INVALID_CREDIT");
  }
  assert.equal(invalid.queries.length, 0);
  for (const credit of [null, { ...fixture(null), estado: " cancelado " }]) {
    const { api, queries } = service(credit);
    await assert.rejects(api.readMoraCredit(81), error => error.code === "CREDIT_NOT_FOUND");
    assert.equal(queries.length, 1);
  }
});


test("PostgreSQL devuelve solo el borrador vinculado más reciente y rechaza teléfonos JSON no textuales", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "CreditoBorrador" ("id" INT PRIMARY KEY,"creditoId" INT,"payload" JSONB,"updatedAt" TIMESTAMPTZ);
    INSERT INTO "CreditoBorrador" VALUES
      (1,81,'{"referenciaFamiliar1Telefono":"3001111111","referenciaFamiliar2Telefono":"3101111111"}','2026-10-08T12:00:00Z'),
      (2,81,'{"referenciaFamiliar1Telefono":3002222222,"referenciaFamiliar2Telefono":"3102222222"}','2026-10-09T12:00:00Z'),
      (3,82,'{"referenciaFamiliar1Telefono":"3009999999","referenciaFamiliar2Telefono":"3109999999"}','2026-10-10T12:00:00Z');`);
  const query = async (sql, params) => (await db.query(sql, params)).rows;
  const { api } = service(fixture(null), [], query);
  const detail = await api.readMoraCredit(81);
  assert.equal(detail.referenciaFamiliar1Telefono, null);
  assert.equal(detail.referenciaFamiliar2Telefono, "3102222222");
  assert.equal((await db.query('SELECT COUNT(*)::int AS total FROM "CreditoBorrador"')).rows[0].total, 3);
});
