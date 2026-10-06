import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  service, actor, analystActor, approveCreditForSadmin, prepareServiceSchema, loadSadminModule,
} from "./credit-sadmin-service-fixture.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const { buildCurrentCreditApprovalSql } = loadSadminModule("lib/credit-approval-actor.ts");

test("SADMIN del analista restaura todo el histórico y conserva el control de escritura", async t => {
  const sql = new PGlite();
  t.after(() => sql.close());
  // Execute the same synthetic schema used by the external PostgreSQL tests.
  // Every statement runs in a new in-memory database; no operational data is read.
  await prepareServiceSchema({
    query: async (statement, values) => values?.length
      ? sql.query(statement, values)
      : (await sql.exec(statement)).at(-1),
  });
  const db = { $transaction: (work) => sql.transaction(tx => work({
    $queryRawUnsafe: async (statement, ...values) => (await tx.query(statement, values)).rows,
    $executeRawUnsafe: async (statement, ...values) => (await tx.query(statement, values)).affectedRows,
  })) };
  const create = async (folio, extra = {}) => {
    const values = { folio, ...extra };
    const fields = Object.keys(values);
    return (await sql.query(`INSERT INTO "Credito" (${fields.map(field => `"${field}"`).join(",")})
      VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")}) RETURNING "id"`, Object.values(values))).rows[0].id;
  };
  const change = (id, version, field, value, acting = actor) => service.updateSadminRegistration(db, acting, id, { version, field, value });
  const complete = async (id, number, acting = actor) => {
    let result = { version: 0 };
    for (const [field, value] of [["numeroCredito", number], ["codeudorCreado", true], ["creditoCreado", true], ["numeroCreditoConfirmado", true]]) {
      result = await change(id, result.version, field, value, acting);
    }
    return result;
  };
  const snapshot = async () => plain({
    credits: (await sql.query('SELECT to_jsonb(c) AS row FROM "Credito" c ORDER BY "id"')).rows,
    registrations: (await sql.query('SELECT to_jsonb(r) AS row FROM "CreditSadminRegistration" r ORDER BY "creditoId"')).rows,
    events: (await sql.query('SELECT to_jsonb(e) AS row FROM "CreditSadminEvent" e ORDER BY "creditoId","version"')).rows,
    reviews: (await sql.query('SELECT to_jsonb(r) AS row FROM "CreditApprovalReview" r ORDER BY "creditoId"')).rows,
    novelties: (await sql.query('SELECT to_jsonb(n) AS row FROM "CreditApprovalNovelty" n ORDER BY "id"')).rows,
    reissues: (await sql.query('SELECT to_jsonb(r) AS row FROM "CreditApprovalReissue" r ORDER BY "id"')).rows,
  });

  const historical = [];
  for (let index = 0; index < 23; index++) historical.push(await create(`RESTORED-HISTORY-${index}`, {
    createdAt: "2026-08-01T12:00:00Z", fechaCredito: "2020-01-01T12:00:00Z",
    clienteDocumento: String(900000000 + index),
  }));
  const imported = await create("RESTORED-IMPORTED", {
    equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } },
  });
  const paid = await create("RESTORED-PAID", { estado: "PAZ_Y_SALVO", pazYSalvoEmitidoAt: "2026-10-01T12:00:00Z" });
  const central = await create("RESTORED-CENTRAL", { sedeId: 1, createdAt: "2026-08-01T12:00:00Z" });
  const unapproved = await create("RESTORED-UNAPPROVED");
  const ready = await create("RESTORED-READY");
  const withNovelty = await create("RESTORED-NOVELTY");
  const withReissue = await create("RESTORED-REISSUE");
  for (const id of [ready, withNovelty, withReissue, historical[0], imported, central]) await approveCreditForSadmin(sql, id);
  await sql.query(`INSERT INTO "CreditApprovalNovelty" ("id","creditoId","status")
    VALUES ('30000000-0000-4000-8000-000000000001',$1,'WAITING_ALLY')`, [withNovelty]);
  await sql.query(`INSERT INTO "CreditApprovalReissue" ("id","creditoId","status")
    VALUES ('40000000-0000-4000-8000-000000000001',$1,'DISPATCHED')`, [withReissue]);
  const cancelled = [];
  for (const [index, estado] of ["ANULADO", " anulada ", "CANCELADO", " cancelada "].entries()) {
    cancelled.push(await create(`RESTORED-CANCELLED-${index}`, { estado, createdAt: "2026-08-01T12:00:00Z" }));
  }
  for (const id of [historical[0], imported, paid, central]) await complete(id, `LEGACY-${id}`);
  const beforeRead = await snapshot();
  const expectedIds = new Set([...historical, imported, paid, central, unapproved, ready, withNovelty, withReissue]);

  await t.test("Todos incluye 30 créditos históricos y pagados con conteos y paginación completos", async () => {
    const pages = await Promise.all([1, 2].map(page => service.listSadminCredits(db, analystActor, { page })));
    assert.deepEqual(pages.map(page => page.items.length), [20, 10]);
    assert.ok(pages.every(page => page.total === 30 && page.totalPages === 2));
    for (const page of pages) assert.deepEqual(plain(page.counts), { all: 30, pending: 26, created: 4 });
    assert.deepEqual(new Set(pages.flatMap(page => page.items.map(item => item.id))), expectedIds);
    assert.deepEqual(new Set(pages.flatMap(page => page.items).filter(item => item.canEditSadmin).map(item => item.id)),
      expectedIds);
    assert.equal(pages.flatMap(page => page.items).find(item => item.id === paid).saldoObligacion, 0);
  });

  await t.test("Pendientes, Creados, búsqueda por cédula y número SADMIN mantienen el alcance histórico", async () => {
    const pending = await service.listSadminCredits(db, analystActor, { status: "pending", page: 2 });
    assert.equal(pending.total, 26);
    assert.equal(pending.items.length, 6);
    const created = await service.listSadminCredits(db, analystActor, { status: "created" });
    assert.deepEqual(new Set(created.items.map(item => item.id)), new Set([historical[0], imported, paid, central]));
    assert.deepEqual(plain(created.counts), { all: 30, pending: 26, created: 4 });
    const document = await service.listSadminCredits(db, analystActor, { q: "900000005" });
    assert.deepEqual(document.items.map(item => item.id), [historical[5]]);
    assert.deepEqual(plain(document.counts), { all: 1, pending: 1, created: 0 });
    const assigned = await service.listSadminCredits(db, analystActor, { q: `LEGACY-${imported}` });
    assert.deepEqual(assigned.items.map(item => item.id), [imported]);
    assert.equal(assigned.items[0].canEditSadmin, true);
  });

  await t.test("Excel devuelve todas las páginas históricas y el resumen conserva su auditoría", async () => {
    const all = await service.exportSadminCredits(db, analystActor);
    assert.deepEqual(new Set(all.items.map(item => item.id)), expectedIds);
    assert.equal(all.items.length, 30);
    const created = await service.exportSadminCredits(db, analystActor, { status: "created" });
    assert.equal(created.items.length, 4);
    const pending = await service.exportSadminCredits(db, analystActor, { status: "pending" });
    assert.equal(pending.items.length, 26);
    for (const id of [historical[0], imported, paid, central, unapproved]) {
      const summary = await service.getSadminCreditSummary(db, analystActor, id);
      assert.equal(summary.creditoId, id);
      assert.equal(summary.canEditSadmin, true);
      assert.equal(summary.historial.length, id === unapproved ? 0 : 4);
      assert.ok(summary.historial.every(event => event.actor === actor.nombre));
    }
    assert.deepEqual(await snapshot(), beforeRead, "lista, filtros, resumen y exportación no reescriben datos");
  });

  await t.test("los créditos anulados y cancelados siguen bloqueados para lectura y escritura", async () => {
    for (const id of cancelled) {
      await assert.rejects(change(id, 0, "codeudorCreado", true, analystActor), error => error.code === "CREDIT_NOT_FOUND" && error.status === 404);
    }
    for (const id of cancelled) await assert.rejects(service.getSadminCreditSummary(db, analystActor, id), error => error.status === 404);
    assert.deepEqual(await snapshot(), beforeRead);
    const centralPage = await service.listSadminCredits(db, actor);
    assert.ok(centralPage.items.every(item => item.canEditSadmin));
    assert.equal((await service.getSadminCreditSummary(db, actor, central)).canEditSadmin, true);
  });

  await t.test("el analista completa el aprobado, conserva las finanzas y sale de Pendientes", async () => {
    const result = await complete(ready, "READY-000001", analystActor);
    assert.equal(result.estadoCreacion, "CREADO_CORRECTAMENTE");
    const summary = await service.getSadminCreditSummary(db, analystActor, ready);
    assert.equal(summary.canEditSadmin, true);
    assert.equal(summary.numeroCreditoVisible, "READY-000001");
    assert.equal(summary.historial.length, 4);
    assert.ok(summary.historial.every(event => event.actor === analystActor.nombre));
    const pending = await service.listSadminCredits(db, analystActor, { status: "pending" });
    assert.deepEqual(plain(pending.counts), { all: 30, pending: 25, created: 5 });
    assert.equal(pending.total, 25);
    assert.equal((await service.listSadminCredits(db, analystActor, { q: "RESTORED-READY", status: "pending" })).total, 0);
    assert.deepEqual((await snapshot()).credits, beforeRead.credits, "ninguna condición financiera del crédito cambia");
    await assert.rejects(service.updateSadminRegistration(db, analystActor, ready, {
      version: result.version, field: "valorCuota", value: 1,
    }), error => error.status === 400);
  });

  await t.test("una novedad posterior no bloquea SADMIN ni se resuelve al guardar sus verificaciones", async () => {
    await sql.query(`INSERT INTO "CreditApprovalNovelty" ("id","creditoId","status")
      VALUES ('30000000-0000-4000-8000-000000000002',$1,'WAITING_ALLY')`, [ready]);
    const before = await snapshot();
    const saved = await change(ready, 4, "codeudorCreado", false, analystActor);
    assert.equal(saved.codeudorCreado, false);
    assert.equal((await service.getSadminCreditSummary(db, analystActor, ready)).canEditSadmin, true);
    const after = await snapshot();
    for (const key of ["credits", "reviews", "novelties", "reissues"]) assert.deepEqual(after[key], before[key]);
  });

  await t.test("el crédito histórico de julio permite guardar número y tres verificaciones con historial y finanzas intactas", async () => {
    const id = await create("FC-HISTORICO-JULIO", {
      clienteNombre: "Cliente histórico de julio", clienteDocumento: "900000099",
      createdAt: "2026-07-02T15:36:04Z", fechaCredito: "2026-07-02T12:00:00Z",
      valorEquipoTotal: 1700000, cuotaInicial: 0, saldoBaseFinanciado: 1700000,
      plazoMeses: 15, frecuenciaPago: "MENSUAL", valorCuota: 180045,
      montoCredito: 2700675, valorFianza: 0, valorInteres: 1000675,
      fechaPrimerPago: "2026-08-02T12:00:00Z", contratoSnapshot: { financiero: { sello: "historico-inmutable" } },
    });
    await sql.query(`INSERT INTO "CreditoAbono" ("creditoId","fechaAbono","valor","metodoPago")
      VALUES ($1,'2026-08-02',180045,'EFECTIVO'),($1,'2026-09-02',180045,'EFECTIVO'),($1,'2026-10-03',180045,'EFECTIVO')`, [id]);
    const before = await snapshot();
    const page = await service.listSadminCredits(db, analystActor, { q: "900000099" });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].canEditSadmin, true);
    assert.equal(page.items[0].numeroCuotas, 15);
    assert.equal(page.items[0].cuotasPagadas, 3);
    assert.equal(page.items[0].sadmin.version, 0);
    const result = await complete(id, "0000702-HISTORICO", analystActor);
    assert.equal(result.estadoCreacion, "CREADO_CORRECTAMENTE");
    const summary = await service.getSadminCreditSummary(db, analystActor, id);
    assert.equal(summary.numeroCreditoVisible, "0000702-HISTORICO");
    assert.deepEqual(summary.historial.map(event => event.version), [4, 3, 2, 1]);
    assert.ok(summary.historial.every(event => event.actor === analystActor.nombre && event.fechaHora.endsWith("Z")));
    assert.equal(summary.historial[0].resultado, "CREADO_CORRECTAMENTE");
    assert.equal((await service.listSadminCredits(db, analystActor, { q: "900000099", status: "pending" })).total, 0);
    assert.equal((await service.listSadminCredits(db, analystActor, { q: "900000099", status: "created" })).total, 1);
    assert.deepEqual((await snapshot()).credits, before.credits);
    for (const field of ["clienteDocumento", "valorEquipoTotal", "cuotaInicial", "saldoBaseFinanciado", "plazoMeses", "valorCuota", "fechaPrimerPago"]) {
      await assert.rejects(service.updateSadminRegistration(db, analystActor, id, {
        version: result.version, field, value: 1,
      }), error => error.status === 400);
    }
  });

  await t.test("SADMIN permite el registro operativo en todos los orígenes y fechas sin cambiar el crédito", async () => {
    const settled = await create("OPERATING-SETTLED");
    await sql.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [settled]);
    const paid = await create("OPERATING-PAID", { pazYSalvoEmitidoAt: "2026-10-01T12:00:00Z" });
    const imported = await create("OPERATING-IMPORTED", {
      equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } },
    });
    const historicalCentral = await create("OPERATING-CENTRAL", { sedeId: 1, createdAt: "2026-07-01T12:00:00Z" });
    const beforeActivation = await create("OPERATING-BEFORE-ACTIVATION", { createdAt: "2026-08-31T23:59:59.999Z" });
    const atActivation = await create("OPERATING-AT-ACTIVATION", { createdAt: "2026-09-01T00:00:00Z" });
    const backdated = await create("OPERATING-BACKDATED", { fechaCredito: "2020-01-01" });
    const markerOnly = await create("OPERATING-PARTIAL-MARKER", { equalityService: "IMPORTACION_MASIVA" });
    const snapshotOnly = await create("OPERATING-PARTIAL-SNAPSHOT", { contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } });
    const freeState = await create("OPERATING-FREE-STATE", { estado: "PAZ_Y_SALVO" });
    const before = await snapshot();
    const eligible = [settled, paid, imported, historicalCentral, beforeActivation, atActivation, backdated, markerOnly, snapshotOnly, freeState];
    const listed = await service.listSadminCredits(db, analystActor, { q: "OPERATING-" });
    const exported = await service.exportSadminCredits(db, analystActor, { q: "OPERATING-" });
    for (const view of [listed, exported]) {
      assert.deepEqual(new Set(view.items.filter(item => item.canEditSadmin).map(item => item.id)), new Set(eligible));
      assert.ok(view.items.every(item => item.canEditSadmin));
    }
    for (const id of eligible) {
      assert.equal((await service.getSadminCreditSummary(db, analystActor, id)).canEditSadmin, true);
      const result = await complete(id, `OPERATING-${id}`, analystActor);
      assert.equal(result.estadoCreacion, "CREADO_CORRECTAMENTE");
      assert.ok((await service.getSadminCreditSummary(db, analystActor, id)).historial.every(event => event.actor === analystActor.nombre));
    }
    assert.deepEqual((await snapshot()).credits, before.credits);
  });

  await t.test("un crédito nuevo del 6 de octubre sin aprobación guarda número y tres marcas sin conceder OK ni modificar el expediente", async () => {
    const newCredit = await create("FC-NUEVO-20261006-SIN-REVISION", {
      createdAt: "2026-10-06T18:42:00Z", fechaCredito: "2026-10-06T12:00:00Z",
      contratoSnapshot: { financiero: { sello: "nuevo-inmutable" } },
    });
    const pendingReview = await create("FC-NUEVO-20261006-PENDIENTE", {
      createdAt: "2026-10-06T18:44:00Z", fechaCredito: "2026-10-06T12:00:00Z",
    });
    await approveCreditForSadmin(sql, pendingReview, {
      status: "PENDING", approvedRevision: null, approvedByUserId: null,
      approvedByName: null, approvedByKind: null, approvedAt: null, approvedHashVersion: null,
    });
    await sql.query(`INSERT INTO "CreditApprovalNovelty" ("id","creditoId","status")
      VALUES ('30000000-0000-4000-8000-000000000100',$1,'WAITING_ALLY')`, [pendingReview]);
    await sql.query(`INSERT INTO "CreditApprovalReissue" ("id","creditoId","status")
      VALUES ('40000000-0000-4000-8000-000000000100',$1,'DISPATCHED')`, [pendingReview]);
    const before = await snapshot();
    for (const view of [await service.listSadminCredits(db, analystActor, { q: "FC-NUEVO-20261006" }),
      await service.exportSadminCredits(db, analystActor, { q: "FC-NUEVO-20261006" })]) {
      assert.deepEqual(new Set(view.items.map(item => item.id)), new Set([newCredit, pendingReview]));
      assert.ok(view.items.every(item => item.canEditSadmin));
    }
    for (const [id, number] of [[newCredit, "0000610-NUEVO"], [pendingReview, "0000610-PENDIENTE"]]) {
      assert.equal((await service.getSadminCreditSummary(db, analystActor, id)).canEditSadmin, true);
      const saved = await complete(id, number, analystActor);
      assert.equal(saved.estadoCreacion, "CREADO_CORRECTAMENTE");
      assert.equal(saved.version, 4);
      assert.ok(saved.codeudorCreado && saved.creditoCreado && saved.numeroCreditoConfirmado);
      const summary = await service.getSadminCreditSummary(db, analystActor, id);
      assert.equal(summary.numeroCreditoVisible, number);
      assert.deepEqual(summary.historial.map(event => event.version), [4, 3, 2, 1]);
      assert.ok(summary.historial.every(event => event.actor === analystActor.nombre && event.fechaHora.endsWith("Z")));
      assert.equal(summary.historial[0].resultado, "CREADO_CORRECTAMENTE");
      const approval = await sql.query(`SELECT COALESCE(${buildCurrentCreditApprovalSql("credit", "review")},false) AS approved
        FROM "Credito" credit LEFT JOIN "CreditApprovalReview" review ON review."creditoId"=credit."id"
        WHERE credit."id"=$1`, [id]);
      assert.equal(approval.rows[0].approved, false, "CREADO_CORRECTAMENTE no equivale a OK para liquidación");
      for (const field of ["clienteDocumento", "valorEquipoTotal", "cuotaInicial", "saldoBaseFinanciado", "plazoMeses", "valorCuota", "fechaPrimerPago", "status", "approvedAt", "revision"]) {
        await assert.rejects(service.updateSadminRegistration(db, analystActor, id, {
          version: saved.version, field, value: 1,
        }), error => error.status === 400);
      }
      await assert.rejects(change(id, 0, "codeudorCreado", false, analystActor), error => error.code === "SADMIN_CHANGED" && error.status === 409);
    }
    await assert.rejects(change(pendingReview, 4, "numeroCredito", "0000610-NUEVO", analystActor),
      error => error.code === "SADMIN_NUMBER_EXISTS" && error.status === 409);
    const after = await snapshot();
    for (const key of ["credits", "reviews", "novelties", "reissues"]) assert.deepEqual(after[key], before[key]);
    assert.equal(after.events.length, before.events.length + 8);
    assert.equal((await service.listSadminCredits(db, analystActor, { q: "FC-NUEVO-20261006", status: "pending" })).total, 0);
    assert.equal((await service.listSadminCredits(db, analystActor, { q: "FC-NUEVO-20261006", status: "created" })).total, 2);
  });

  await t.test("el registro SADMIN no depende de que exista una política de aprobación", async () => {
    await sql.query('DELETE FROM "CreditApprovalPolicy" WHERE "id"=1');
    const before = await snapshot();
    const id = await create("SADMIN-WITHOUT-APPROVAL-POLICY");
    assert.equal((await service.getSadminCreditSummary(db, analystActor, id)).canEditSadmin, true);
    const saved = await complete(id, "NO-POLICY-001", analystActor);
    assert.equal(saved.estadoCreacion, "CREADO_CORRECTAMENTE");
    const after = await snapshot();
    assert.deepEqual(after.credits.filter(row => row.row.id !== id), before.credits);
    for (const key of ["reviews", "novelties", "reissues"]) assert.deepEqual(after[key], before[key]);
  });
});
