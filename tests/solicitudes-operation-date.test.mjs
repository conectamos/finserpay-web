import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createJiti } from "jiti";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { EXPORT_FIXTURE_SQL } from "./helpers/solicitudes-export-fixture.mjs";

const jiti = createJiti(import.meta.url);
const { normalizeExportFilters } = await jiti.import("../lib/solicitudes-export-core.ts");
const { countExportRows, iterateExportRows } = await jiti.import("../lib/solicitudes-export-data.ts");
const core = loadReissueModule("lib/solicitudes.ts", {}, { URLSearchParams });
const central = { kind: "CENTRAL_ADMIN", userId: 1, aliadoId: null, sedeId: null, vendedorId: null };
const ally = { ...central, kind: "ALLY_ADMIN", aliadoId: 1 };
const supervisor = { ...ally, kind: "SUPERVISOR", sedeId: 10 };
const seller = { ...supervisor, kind: "SELLER", vendedorId: 100 };
const filters = (values = {}) => core.normalizeSolicitudFilters(new URLSearchParams({ pageSize: "100", ...values }));
let pg;
let storage;
const statements = [];
const db = {
  $queryRawUnsafe: async (sql, ...values) => {
    statements.push({ sql, values });
    return (await pg.query(sql, values)).rows;
  },
  aliado: { findMany: async () => [] },
  sede: { findMany: async () => [] },
  vendedor: { findMany: async () => [] },
};
const ids = (items) => Array.from(items, (item) => item.id);
const list = (day, viewer = central, extra = {}) => storage.listSolicitudes({ viewer, filters: filters({ desde: day, hasta: day, ...extra }) });
async function exported(day, viewer = central, changes = {}) {
  const selection = normalizeExportFilters({ period: "range", desde: day, hasta: day, ...changes });
  const rows = [];
  for await (const row of iterateExportRows(viewer, selection, db, 2)) rows.push(row);
  assert.equal(await countExportRows(viewer, selection, db), rows.length);
  return rows;
}

before(async () => {
  pg = new PGlite();
  await pg.exec(EXPORT_FIXTURE_SQL + `
    TRUNCATE "Credito", "CreditoBorrador", "DataCreditoAssessment", "VeriffIdentityValidation", "FirmaSeguroProcess", "CreditSadminRegistration";
    CREATE TABLE "Usuario" (id integer PRIMARY KEY, nombre text);
    INSERT INTO "Usuario" VALUES (1,'Usuario de prueba');
    ALTER TABLE "Credito" ADD COLUMN "usuarioId" integer DEFAULT 1, ADD COLUMN "updatedAt" timestamp DEFAULT '2026-10-22';
    ALTER TABLE "CreditoBorrador" ADD COLUMN "usuarioId" integer DEFAULT 1,
      ADD COLUMN "updatedAt" timestamptz DEFAULT '2026-10-22', ADD COLUMN "closedAt" timestamptz,
      ADD COLUMN "dataCreditoStatus" text, ADD COLUMN "dataCreditoErrorCode" text,
      ADD COLUMN "desistedByUserId" integer, ADD COLUMN "desistedBySellerId" integer;
    ALTER TABLE "VeriffIdentityValidation" ADD COLUMN "creditoId" integer;
    ALTER TABLE "FirmaSeguroProcess" ADD COLUMN "creditoId" integer, ADD COLUMN "supersededAt" timestamptz;
    -- Tests use one connection; no lock contention is simulated.
    CREATE FUNCTION pg_try_advisory_xact_lock(integer,integer) RETURNS boolean LANGUAGE sql AS 'SELECT true';
    INSERT INTO "Credito" (id,"sedeId","vendedorId",folio,"createdAt","fechaCredito",estado,"clienteNombre","clienteDocumento") VALUES
      (101,10,100,'TEST-101','2026-10-18 00:17:39','2026-10-18 00:17:39','GENERADO','Cliente 101','10001'),
      (102,10,100,'TEST-102','2026-10-17 04:59:59.999','2026-10-17 04:59:59.999','GENERADO','Cliente 102','10002'),
      (103,10,100,'TEST-103','2026-10-17 05:00:00','2026-10-17 05:00:00','GENERADO','Cliente 103','10003'),
      (104,10,100,'TEST-104','2026-10-18 04:59:59.999','2026-10-18 04:59:59.999','GENERADO','Cliente 104','10004'),
      (105,10,100,'TEST-105','2026-10-18 05:00:00','2026-10-18 05:00:00','GENERADO','Cliente 105','10005'),
      (106,10,100,'TEST-106','2026-10-22 15:00:00','2026-10-17 15:00:00','GENERADO','Importado después','10006'),
      (107,20,200,'TEST-107','2026-10-17 16:00:00','2026-10-17 16:00:00','GENERADO','Otro aliado','10007'),
      (108,11,101,'TEST-108','2026-10-17 17:00:00','2026-10-17 17:00:00','GENERADO','Otra sede','10008'),
      (109,10,100,'TEST-109','2026-10-13 16:00:00','2026-10-13 16:00:00','GENERADO','Crédito anterior','10009');
    INSERT INTO "CreditoBorrador" (id,"sedeId","vendedorId","creditoId","createdAt",estado,"closedReason","expiresAt","currentStep","clienteNombre","clienteDocumento","dataCreditoStatus") VALUES
      (201,10,100,101,'2026-10-13 14:00:00+00','CERRADO','FINALIZADA','2099-01-01',5,'Cliente 101','10001','APROBADO'),
      (202,10,100,null,'2026-10-13 14:00:00+00','ABIERTO',null,'2099-01-01',5,'Aprobado sin crédito','20002','APROBADO'),
      (203,10,100,null,'2026-10-17 14:00:00+00','ABIERTO',null,'2099-01-01',1,'Consulta actual','20003','PENDING');
    SET TIME ZONE 'America/Los_Angeles';
  `);
  const noSchemaChange = async () => {};
  storage = loadReissueModule("lib/solicitudes-storage.ts", {
    "@/lib/prisma": { default: db },
    "@/lib/document-blacklist": {},
    "@/lib/solicitud-blacklist-locks": {},
    "@/lib/datacredito/storage": { ensureDataCreditoSchema: noSchemaChange },
    "@/lib/firmaseguro-status": loadReissueModule("lib/firmaseguro-status.ts"),
    "@/lib/firmaseguro-storage": { ensureFirmaSeguroSchema: noSchemaChange, SOLICITUD_OPERATION_LOCK_NAMESPACE: 1 },
    "@/lib/delivery-evidence-draft": {},
    "@/lib/veriff-storage": { ensureVeriffSchema: noSchemaChange },
    "@/lib/firmaseguro-draft-dispatch-ledger": {},
    "@/lib/approval-request-correction-core": {},
    "@/lib/approval-request-financial-correction-core": {},
    "@/lib/approval-request-evidence-correction-core": {},
    "@/lib/credit-imei-confirmation": {},
    "@/lib/solicitudes": core,
  }, { process: { env: { NODE_ENV: "production" } } });
});
after(async () => { await pg?.close(); });

test("consulta del 13 finalizada el 17: operación y finalización del crédito, inicio histórico intacto", async () => {
  const response = await list("2026-10-17");
  const credit = response.items.find((item) => item.id === "C-101");
  assert.ok(credit);
  assert.equal(credit.operationAt, "2026-10-18T00:17:39.000Z");
  assert.equal(credit.finalizedAt, credit.operationAt);
  assert.equal(credit.createdAt, "2026-10-13T14:00:00.000Z");
  assert.equal(credit.timeline.find((event) => event.key === "CREADA").at, credit.createdAt);
  assert.equal(credit.timeline.find((event) => event.key === "CREDITO").at, credit.operationAt);
  assert.equal((await list("2026-10-13")).items.some((item) => item.id === "C-101"), false);
  const detail = await storage.getSolicitudDetail({ viewer: central, filters: filters({ id: "C-101" }), readOnly: true });
  assert.equal(detail.operationAt, credit.operationAt);
  assert.equal(detail.createdAt, credit.createdAt);
  const original = (await pg.query(`SELECT "createdAt" FROM "CreditoBorrador" WHERE id=201`)).rows[0];
  assert.equal(original.createdAt.toISOString(), "2026-10-13T14:00:00.000Z");
});

test("Bogotá incluye exactamente el día operativo y ordena por operación, no por creación o actualización", async () => {
  const response = await list("2026-10-17");
  assert.deepEqual(ids(response.items), ["C-104", "C-101", "C-108", "C-107", "C-106", "D-203", "C-103"]);
  assert.equal(response.total, 7);
  assert.deepEqual(ids((await list("2026-10-16")).items), ["C-102"]);
  assert.deepEqual(ids((await list("2026-10-18")).items), ["C-105"]);
  assert.equal((await list("2026-10-22")).total, 0, "la importación posterior no cambia el periodo del crédito");
  const first = await list("2026-10-17", central, { pageSize: "2" });
  const second = await list("2026-10-17", central, { pageSize: "2", page: "2" });
  assert.equal(first.total, 7);
  assert.deepEqual(ids(first.items), ["C-104", "C-101"]);
  assert.deepEqual(ids(second.items), ["C-108", "C-107"]);
});

test("una aprobación sin crédito conserva la fecha de consulta; ediciones o recuperación posteriores no la sustituyen", async () => {
  const pending = (await list("2026-10-13")).items.find((item) => item.id === "D-202");
  assert.ok(pending);
  assert.equal(pending.source, "DRAFT");
  assert.equal(pending.estado, "PROCESO");
  assert.equal(pending.operationAt, "2026-10-13T14:00:00.000Z");
  assert.equal(pending.finalizedAt, null);
  assert.equal(pending.timeline.some((event) => event.key === "CREDITO"), false);
  const beforeIds = ids((await list("2026-10-17")).items);
  await pg.exec(`UPDATE "Credito" SET "updatedAt"='2026-12-01' WHERE id=101;
    UPDATE "CreditoBorrador" SET "closedAt"='2026-12-01', "updatedAt"='2026-12-01' WHERE id=201;`);
  const after = await list("2026-10-17");
  assert.deepEqual(ids(after.items), beforeIds);
  assert.equal(after.items.find((item) => item.id === "C-101").operationAt, "2026-10-18T00:17:39.000Z");
});

test("lista y detalle mantienen restricciones de aliado, sede y asesor al usar fecha operativa", async () => {
  assert.deepEqual(ids((await list("2026-10-17", ally)).items), ["C-104", "C-101", "C-108", "C-106", "D-203", "C-103"]);
  for (const viewer of [supervisor, seller]) {
    assert.deepEqual(ids((await list("2026-10-17", viewer)).items), ["C-104", "C-101", "C-106", "D-203", "C-103"]);
    assert.equal((await list("2026-10-17", viewer, { sedeId: "20" })).total, 0);
    assert.equal(await storage.getSolicitudDetail({ viewer, filters: filters({ id: "C-107" }), readOnly: true }), null);
  }
});

test("exportación y conteo usan el mismo día Bogotá de la lista y conservan createdAt original", async () => {
  for (const day of ["2026-10-13", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-22"]) {
    const rows = await exported(day);
    const listIds = ids((await list(day)).items).sort();
    assert.deepEqual(rows.map((row) => `${row.source === "CREDIT" ? "C" : "D"}-${row.entityId}`).sort(), listIds, day);
  }
  const credit = (await exported("2026-10-17")).find((row) => row.entityId === 101);
  assert.equal(credit.createdAt.toISOString(), "2026-10-13T14:00:00.000Z");
  assert.equal(credit.operationAt.toISOString(), "2026-10-18T00:17:39.000Z");
  const restricted = await exported("2026-10-17", ally);
  assert(restricted.every((row) => row.aliadoId === 1));
  await assert.rejects(exported("2026-10-17", ally, { sedeIds: [20] }), { status: 403 });
  assert(statements.some(({ sql }) => /"operationAt" >=/.test(sql)), "el filtro de export se aplica en SQL");
});
