import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import ExcelJS from "exceljs";
import { createJiti } from "jiti";
import { EXPORT_FIXTURE_SQL } from "./helpers/solicitudes-export-fixture.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { createSolicitudExportStore, serializeExportJob } = await jiti.import("../lib/solicitudes-export-jobs.ts");
const { exportViewerFromSession } = await jiti.import("../lib/solicitudes-export-access.ts");

const central = { kind: "CENTRAL_ADMIN", userId: 1, aliadoId: 9, sedeId: 90, vendedorId: null };
const ally = { kind: "ALLY_ADMIN", userId: 2, aliadoId: 1, sedeId: 10, vendedorId: null };
const foreignAlly = { ...ally, userId: 4, aliadoId: 2, sedeId: 20 };
const all = { period: "all" };

async function fixture(t) {
  const pg = new PGlite();
  await pg.exec(EXPORT_FIXTURE_SQL);
  await pg.exec(`ALTER TABLE "Aliado" ADD COLUMN codigo text;
    UPDATE "Aliado" SET codigo='ALIADO-' || id;
    INSERT INTO "Aliado" VALUES (9,'FINSER PAY','FINSERPAY');
    INSERT INTO "Sede" VALUES (90,'Central',9);
    CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
    CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"rolId" integer,"sedeId" integer);
    INSERT INTO "Rol" VALUES (1,'ADMIN'),(2,'VENDEDOR');
    INSERT INTO "Usuario" VALUES (1,'Central',true,1,90),(2,'Aliado Uno',true,1,10),
      (3,'Otro administrador',true,1,10),(4,'Aliado Dos',true,1,20),(5,'Vendedor',true,2,10);`);
  t.after(() => pg.close());
  // PGlite has one connection. Its transaction executor also handles progress
  // writes that production PostgreSQL runs on a separate connection. This runs
  // real SQL/rollback and files, but does not simulate PostgreSQL MVCC races.
  let executor = pg;
  const transactionOptions = [];
  const observedQueries = [];
  let queryFailure;
  const db = {
    async $queryRawUnsafe(sql, ...values) {
      observedQueries.push(sql);
      if (queryFailure && queryFailure(sql)) throw new Error("DO_NOT_EXPORT_PRIVATE_DOCUMENT_00123456");
      return (await executor.query(sql, values)).rows;
    },
    async $executeRawUnsafe(sql, ...values) {
      return (await executor.query(sql, values)).affectedRows || 0;
    },
    async $transaction(callback, options) {
      transactionOptions.push(options);
      return pg.transaction(async (tx) => {
        executor = tx;
        try { return await callback(db); }
        finally { executor = pg; }
      });
    },
  };
  const store = createSolicitudExportStore(db);
  async function viewer(userId) {
    const { rows } = await pg.query(`SELECT u.id,r.nombre AS "rolNombre",s.id AS "sedeAccesoId",
      s."aliadoId" AS "aliadoAccesoId",a.codigo AS "aliadoAccesoCodigo" FROM "Usuario" u
      JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId"
      JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.id=$1 AND u.activo=true`, [userId]);
    return exportViewerFromSession(rows[0] ?? null);
  }
  async function ready(view = central, filters = all, count = 8) {
    const job = await store.create(view, filters, count);
    await store.run(job.id);
    const completed = await store.get(view, job.id);
    assert.equal(completed.status, "READY", completed.error ?? "Export must finish");
    return completed;
  }
  return { pg, store, db, ready, viewer, transactionOptions, observedQueries, failQuery: (predicate) => { queryFailure = predicate; } };
}

async function readWorkbook(download) {
  const buffer = Buffer.from(await new Response(download.stream).arrayBuffer());
  assert.equal(buffer.length, download.bytes);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

test("cola central: pendiente, generación completa, descarga y auditoría sin datos de cliente", async (t) => {
  const f = await fixture(t);
  const pending = await f.store.create(central, all, 8);
  assert.equal(pending.status, "PENDING");
  assert.equal(pending.count, 8);
  assert.equal(pending.filename, "FINSERPAY_Clientes_General_Historico.xlsx");
  assert.equal(pending.downloadUrl, undefined);
  await assert.rejects(f.store.download(central, pending.id), { status: 409 });
  await f.store.work();
  const job = await f.store.get(central, pending.id);
  assert.equal(job.status, "READY", job.error);
  assert.equal(job.processed, 8);
  assert.equal(serializeExportJob(job).downloadUrl, `/api/solicitudes/export/${job.id}/download`);
  const workbook = await readWorkbook(await f.store.download(central, pending.id));
  assert.equal(workbook.worksheets[0].rowCount - 1, pending.count);
  assert.equal(workbook.worksheets[0].getCell("D2").value, "00001");
  assert.equal(workbook.worksheets[0].getCell("E2").value, "000000123");
  assert.equal(workbook.worksheets[0].getCell("H2").value, "001234567");
  assert.equal(workbook.worksheets[0].getCell("S2").value, "001234567890123");
  assert.ok(f.transactionOptions.some(options => options?.isolationLevel === "RepeatableRead"));
  assert.ok(f.observedQueries.some(sql => /SELECT 1 FROM pg_advisory_xact_lock/.test(sql)), "lock must not return unsupported void to Prisma");
  const { rows: audit } = await f.pg.query(`SELECT * FROM "SolicitudExportAudit" ORDER BY id`);
  assert.deepEqual(audit.map(row => row.event), ["REQUESTED", "GENERATED", "DOWNLOAD_STARTED"]);
  assert.ok(audit.every(row => row.userId === 1 && row.count === 8 && row.createdAt instanceof Date));
  assert.doesNotMatch(JSON.stringify(audit), /Ana Cliente|001234567|001\.234\.567|003001234567|DO_NOT_EXPORT|uno@example/);
  await f.store.run(job.id);
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportAudit"`)).rows[0].n, 3, "ready job cannot generate twice");
});

test("rechaza conteos desactualizados, otros roles, filtros externos y exceso de solicitudes pendientes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.create(central, all, 7), { status: 409 });
  await assert.rejects(f.store.create(central, all, "8"), { status: 400 });
  await assert.rejects(f.store.create({ ...ally, kind: "SELLER" }, all, 6), { status: 403 });
  for (const attack of [{ aliadoIds: [2] }, { sedeIds: [20] }, { vendedorIds: [200] }]) {
    await assert.rejects(f.store.create(ally, { ...all, ...attack }, 0), { status: 403 });
  }
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportJob"`)).rows[0].n, 0);
  await f.store.create(central, all, 8);
  await f.store.create(central, all, 8);
  await assert.rejects(f.store.create(central, all, 8), { status: 429 });
  await f.store.work();
  assert.deepEqual((await f.pg.query(`SELECT status FROM "SolicitudExportJob"`)).rows.map(row => row.status), ["READY", "READY"]);
});

test("archivo del aliado contiene solo su histórico y ningún otro usuario puede consultar o descargarlo", async (t) => {
  const f = await fixture(t);
  const job = await f.ready(ally, all, 6);
  const workbook = await readWorkbook(await f.store.download(ally, job.id));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 7);
  assert.equal(job.filename, "FINSERPAY_Clientes_Aliado_Historico.xlsx");
  for (let row = 2; row <= sheet.rowCount; row += 1) assert.equal(sheet.getCell(`N${row}`).value, "Aliado Uno");
  for (const attacker of [foreignAlly, central, { ...ally, userId: 3 }, { ...ally, kind: "CENTRAL_ADMIN" }]) {
    await assert.rejects(f.store.get(attacker, job.id), { status: 403 });
    await assert.rejects(f.store.download(attacker, job.id), { status: 403 });
  }
  await assert.rejects(f.store.get(ally, "../../anywhere"), { status: 404 });
});

test("el trabajador revalida la cuenta: rol revocado o cuenta inactiva impiden generar", async (t) => {
  const f = await fixture(t);
  const revoked = await f.store.create(ally, all, 6);
  await f.pg.exec(`UPDATE "Usuario" SET "rolId"=2 WHERE id=2`);
  await f.store.run(revoked.id);
  const [job] = (await f.pg.query(`SELECT * FROM "SolicitudExportJob" WHERE id=$1::uuid`, [revoked.id])).rows;
  assert.equal(job.status, "FAILED");
  assert.match(job.error, /administrador autorizado/);
  await assert.rejects(f.viewer(2), { status: 403 });
  await f.pg.exec(`UPDATE "Usuario" SET "rolId"=1 WHERE id=2`);
  const inactive = await f.store.create(ally, all, 6);
  await f.pg.exec(`UPDATE "Usuario" SET activo=false WHERE id=2`);
  await f.store.run(inactive.id);
  await assert.rejects(f.viewer(2), { status: 401 });
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportChunk"`)).rows[0].n, 0);
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportMember"`)).rows[0].n, 0);
});

test("al cambiar aliado, sede o propiedad de una solicitud se bloquea el archivo ya generado", async (t) => {
  const f = await fixture(t);
  const job = await f.ready(ally, all, 6);
  await f.pg.exec(`UPDATE "Usuario" SET "sedeId"=20 WHERE id=2`);
  await assert.rejects(f.store.download(await f.viewer(2), job.id), { status: 403 });
  await f.pg.exec(`UPDATE "Usuario" SET "sedeId"=10 WHERE id=2; UPDATE "Credito" SET "sedeId"=20 WHERE id=2`);
  await assert.rejects(f.store.download(await f.viewer(2), job.id), { status: 403 });
  await f.pg.exec(`UPDATE "Credito" SET "sedeId"=11 WHERE id=2; DELETE FROM "Credito" WHERE id=2`);
  await assert.rejects(f.store.download(ally, job.id), { status: 403 });
});

test("un filtro de sede queda invalidado si esa sede pasa a otro aliado", async (t) => {
  const f = await fixture(t);
  const job = await f.ready(ally, { ...all, sedeIds: [11] }, 1);
  await f.pg.exec(`UPDATE "Sede" SET "aliadoId"=2 WHERE id=11`);
  await assert.rejects(f.store.get(ally, job.id), { status: 403 });
  await assert.rejects(f.store.download(ally, job.id), { status: 403 });
});

test("si cambia el conteo antes de generar se informa fallo y nunca se publican filas parciales", async (t) => {
  const f = await fixture(t);
  const job = await f.store.create(central, all, 8);
  await f.pg.exec(`DELETE FROM "Credito" WHERE id=2`);
  await f.store.run(job.id);
  const failed = await f.store.get(central, job.id);
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error, /solicitudes cambiaron/);
  assert.equal(serializeExportJob(failed).downloadUrl, undefined);
  await assert.rejects(f.store.download(central, job.id), { status: 409 });
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportChunk"`)).rows[0].n, 0);
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportMember"`)).rows[0].n, 0);
});

test("la auditoría conserva filtros y cantidad, redacta búsquedas de clientes y errores internos", async (t) => {
  const f = await fixture(t);
  const selected = { period: "month", month: "2026-10", q: "001.234.567", aliadoIds: [1], sedeIds: [10, 11] };
  const job = await f.ready(central, selected, 2);
  const logs = (await f.pg.query(`SELECT * FROM "SolicitudExportAudit" WHERE "jobId"=$1::uuid`, [job.id])).rows;
  assert.ok(logs.every(log => log.filters.searchApplied === true && log.count === 2));
  assert.ok(logs.every(log => log.filters.month === "2026-10" && log.filters.sedeIds.join() === "10,11"));
  assert.doesNotMatch(JSON.stringify(logs), /001\.234\.567|Ana Cliente|uno@example/);
  const failure = await f.store.create(central, all, 8);
  f.failQuery(sql => sql.includes("WITH requests AS"));
  await f.store.run(failure.id);
  const [failed] = (await f.pg.query(`SELECT * FROM "SolicitudExportJob" WHERE id=$1::uuid`, [failure.id])).rows;
  assert.equal(failed.status, "FAILED");
  assert.doesNotMatch(failed.error, /DO_NOT_EXPORT|00123456/);
  assert.match(failed.error, /archivo completo/);
});

test("integridad: faltar bytes o renumerar fragmentos se rechaza antes de iniciar la descarga", async (t) => {
  const f = await fixture(t);
  const job = await f.ready();
  await f.pg.query(`UPDATE "SolicitudExportChunk" SET sequence=sequence+100 WHERE "jobId"=$1::uuid`, [job.id]);
  await assert.rejects(f.store.download(central, job.id), { status: 409 });
  await f.pg.query(`UPDATE "SolicitudExportChunk" SET sequence=sequence-100 WHERE "jobId"=$1::uuid`, [job.id]);
  await f.pg.query(`UPDATE "SolicitudExportChunk" SET data=substring(data FROM 1 FOR 5) WHERE "jobId"=$1::uuid`, [job.id]);
  await assert.rejects(f.store.download(central, job.id), { status: 409 });
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportAudit" WHERE event='DOWNLOAD_STARTED'`)).rows[0].n, 0);
});

test("un archivo próximo a vencer conserva los fragmentos durante la descarga y la limpieza retiene la auditoría", async (t) => {
  const f = await fixture(t);
  const job = await f.ready();
  await f.pg.query(`UPDATE "SolicitudExportJob" SET "expiresAt"=NOW()+INTERVAL '2 seconds' WHERE id=$1::uuid`, [job.id]);
  const download = await f.store.download(central, job.id);
  assert.ok(new Date(download.job.expiresAt).getTime() - Date.now() > 14 * 60 * 1000);
  await f.store.cleanup();
  const workbook = await readWorkbook(download);
  assert.equal(workbook.worksheets[0].rowCount, 9);
  await f.pg.query(`UPDATE "SolicitudExportJob" SET "expiresAt"=NOW()-INTERVAL '1 second' WHERE id=$1::uuid`, [job.id]);
  await f.store.cleanup();
  await assert.rejects(f.store.get(central, job.id), { status: 404 });
  for (const table of ["SolicitudExportChunk", "SolicitudExportMember"]) {
    assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "${table}"`)).rows[0].n, 0);
  }
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportAudit"`)).rows[0].n, 3);
});

test("exportación grande recorre lotes completos y el periodo vacío sigue generando un Excel válido", async (t) => {
  const f = await fixture(t);
  await f.pg.exec(`INSERT INTO "Credito" (id,"sedeId","vendedorId",folio,"createdAt",estado,"clienteNombre","clienteDocumento")
    SELECT n,10,100,'L-' || n,'2025-01-15'::timestamp,'GENERADO','Lote','000001' FROM generate_series(1000,4004) n`);
  const large = await f.ready(ally, { period: "month", month: "2025-01" }, 3005);
  assert.equal(large.processed, 3005);
  const workbook = await readWorkbook(await f.store.download(ally, large.id));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount - 1, 3005);
  assert.equal(sheet.getCell("D2").value, "L-1000");
  assert.equal(sheet.getCell("D3006").value, "L-4004");
  assert.equal((await f.pg.query(`SELECT COUNT(*)::integer AS n FROM "SolicitudExportMember" WHERE "jobId"=$1::uuid`, [large.id])).rows[0].n, 3005);
  const empty = await f.ready(ally, { period: "month", month: "1999-01" }, 0);
  assert.equal((await readWorkbook(await f.store.download(ally, empty.id))).worksheets[0].rowCount, 1);
  assert.equal(empty.filename, "FINSERPAY_Clientes_Aliado_1999-01.xlsx");
});

test("una generación interrumpida se marca fallida y no ofrece un enlace al archivo", async (t) => {
  const f = await fixture(t);
  const job = await f.store.create(central, all, 8);
  await f.pg.query(`UPDATE "SolicitudExportJob" SET status='PROCESSING',"updatedAt"=NOW()-INTERVAL '4 minutes' WHERE id=$1::uuid`, [job.id]);
  await f.store.cleanup();
  const failed = await f.store.get(central, job.id);
  assert.equal(failed.status, "FAILED");
  assert.equal(serializeExportJob(failed).downloadUrl, undefined);
  await assert.rejects(f.store.download(central, job.id), { status: 409 });
});
