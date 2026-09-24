import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { service, state, actor, sharedActor, databaseAdapter, prepareServiceFixture } from "./credit-sadmin-service-fixture.mjs";

const connectionString = process.env.CREDIT_SADMIN_SERVICE_TEST_DATABASE_URL;
const plain = value => JSON.parse(JSON.stringify(value));
pg.types.setTypeParser(1114, value => new Date(value.replace(" ", "T") + "Z"));

test("parser SADMIN exige versión, campos exactos, booleanos reales y número limitado", () => {
  for (const input of [null, [], {}, { version: -1, field: "codeudorCreado", value: true },
    { version: 1, field: "estado", value: "CREADO_SADMIN" }, { version: 0, field: "codeudorCreado", value: "true" },
    { version: 0, field: "numeroCredito", value: 123 }, { version: 0, field: "numeroCredito", value: "x".repeat(81) },
    { version: 0, field: "numeroCredito", value: "12\n34" }, { version: 0, field: "numeroCredito", value: "12", actorUserId: 999 }]) {
    assert.throws(() => state.parseSadminChange(input), error => error.status === 400);
  }
  assert.deepEqual(plain(state.parseSadminChange({ version: 0, field: "numeroCredito", value: " 000123-A " })),
    { version: 0, field: "numeroCredito", value: "000123-A" });
});

test("PostgreSQL aislado: servicio SADMIN histórico, checklist, autoría y concurrencia", {
  skip: connectionString ? false : "Requiere CREDIT_SADMIN_SERVICE_TEST_DATABASE_URL local sadmin_service_test",
}, async t => {
  const pool = new pg.Pool({ connectionString, max: 5 });
  t.after(() => pool.end());
  await prepareServiceFixture(pool, connectionString);
  const db = databaseAdapter(pool);
  let sequence = 0;
  const create = async (overrides = {}) => {
    const values = { folio: `FC-SADMIN-${++sequence}`, ...overrides };
    const fields = Object.keys(values);
    return (await pool.query('INSERT INTO "Credito" (' + fields.map(field => '"' + field + '"').join(",") + ') VALUES (' + fields.map((_, index) => "$" + (index + 1)).join(",") + ') RETURNING "id"', Object.values(values))).rows[0].id;
  };
  const change = (id, version, field, value, acting = actor) => service.updateSadminRegistration(db, acting, String(id), { version, field, value });
  const getRegistration = async id => (await pool.query('SELECT * FROM "CreditSadminRegistration" WHERE "creditoId"=$1', [id])).rows[0];
  const eventCount = async id => Number((await pool.query('SELECT count(*) FROM "CreditSadminEvent" WHERE "creditoId"=$1', [id])).rows[0].count);

  await t.test("45 registros históricos en páginas 20/20/5, fecha de crédito y desempate ID descendentes", async () => {
    for (let index = 0; index < 45; index++) await create({ fechaCredito: `2020-01-${String(1 + Math.floor(index / 3)).padStart(2, "0")}T12:00:00Z`, createdAt: "2026-09-17T12:00:00Z" });
    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await service.listSadminCredits(db, actor, { page }));
    assert.deepEqual(pages.map(page => page.items.length), [20, 20, 5]);
    assert.ok(pages.every(page => page.total === 45 && page.pageSize === 20 && page.totalPages === 3));
    const actual = pages.flatMap(page => page.items.map(item => item.id));
    const expected = (await pool.query('SELECT "id" FROM "Credito" ORDER BY "fechaCredito" DESC,"id" DESC')).rows.map(row => row.id);
    assert.deepEqual(actual, expected);
    assert.equal(new Set(actual).size, 45);
    assert.ok(pages[0].items.every(item => item.sadmin.version === 0 && item.sadmin.estado === "PENDIENTE"));
    assert.equal((await service.listSadminCredits(db, actor, { page: 999 })).page, 3);
  });

  await t.test("filtra pendientes y creados antes de paginar, conserva la búsqueda y devuelve conteos del resultado", async () => {
    const pendingIds = [];
    for (let index = 0; index < 21; index++) {
      pendingIds.push(await create({
        folio: `FILTRO-SADMIN-${String(index + 1).padStart(2, "0")}`,
        fechaCredito: `2021-02-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
      }));
    }
    await change(pendingIds[0], 0, "codeudorCreado", true);
    const createdId = await create({ folio: "FILTRO-SADMIN-CREADO", fechaCredito: "2021-02-22T12:00:00Z" });
    let created = await change(createdId, 0, "numeroCredito", "FILTRO-0001");
    created = await change(createdId, created.version, "codeudorCreado", true);
    created = await change(createdId, created.version, "creditoCreado", true);
    created = await change(createdId, created.version, "numeroCreditoConfirmado", true);
    assert.equal(created.estado, "CREADO_SADMIN");

    const defaults = await service.listSadminCredits(db, actor, { q: "FILTRO-SADMIN-" });
    assert.equal(defaults.total, 22);
    assert.deepEqual(plain(defaults.counts), { all: 22, pending: 21, created: 1 });
    assert.ok(defaults.items.some(item => item.id === createdId));

    const pendingFirst = await service.listSadminCredits(db, actor, { q: "FILTRO-SADMIN-", status: "pending" });
    const pendingSecond = await service.listSadminCredits(db, actor, { q: "FILTRO-SADMIN-", status: "pending", page: 2 });
    assert.deepEqual([pendingFirst.items.length, pendingSecond.items.length], [20, 1]);
    assert.ok([...pendingFirst.items, ...pendingSecond.items].every(item => item.sadmin.estado === "PENDIENTE"));
    assert.equal(pendingFirst.total, 21);
    assert.equal(pendingFirst.totalPages, 2);
    assert.deepEqual(plain(pendingFirst.counts), { all: 22, pending: 21, created: 1 });

    const completed = await service.listSadminCredits(db, actor, { q: "FILTRO-SADMIN-", status: "created", page: 99 });
    assert.equal(completed.page, 1);
    assert.equal(completed.total, 1);
    assert.deepEqual(completed.items.map(item => item.id), [createdId]);
    assert.equal(completed.items[0].sadmin.estado, "CREADO_SADMIN");
    assert.deepEqual(plain(completed.counts), { all: 22, pending: 21, created: 1 });

    const all = await service.listSadminCredits(db, actor, { q: "FILTRO-SADMIN-", status: "all" });
    assert.equal(all.total, defaults.total);
    assert.deepEqual(plain(all.counts), plain(defaults.counts));
  });

  await t.test("la exportación devuelve todos los resultados filtrados, incluso cuando superan una página", async () => {
    const pendingIds = [];
    for (let index = 0; index < 25; index++) {
      pendingIds.push(await create({
        folio: `EXPORT-SADMIN-PAGE-${String(index + 1).padStart(2, "0")}`,
        fechaCredito: `2022-03-${String(index + 1).padStart(2, "0")}T12:00:00Z`,
      }));
    }
    const createdId = await create({ folio: "EXPORT-SADMIN-PAGE-CREADO", fechaCredito: "2022-03-26T12:00:00Z" });
    let created = await change(createdId, 0, "numeroCredito", "EXPORT-SADMIN-0001");
    created = await change(createdId, created.version, "codeudorCreado", true);
    created = await change(createdId, created.version, "creditoCreado", true);
    created = await change(createdId, created.version, "numeroCreditoConfirmado", true);
    assert.equal(created.estado, "CREADO_SADMIN");

    const all = await service.exportSadminCredits(db, actor, { q: "EXPORT-SADMIN-PAGE-", status: "all" });
    assert.equal(all.status, "all");
    assert.equal(all.items.length, 26);
    assert.equal(all.items[0].id, createdId);
    assert.deepEqual(new Set(all.items.slice(1).map(item => item.id)), new Set(pendingIds));
    assert.equal(new Set(all.items.map(item => item.id)).size, 26);

    const pending = await service.exportSadminCredits(db, actor, { q: "EXPORT-SADMIN-PAGE-", status: "pending" });
    assert.equal(pending.status, "pending");
    assert.equal(pending.items.length, 25);
    assert.ok(pending.items.every(item => item.sadmin.estado === "PENDIENTE"));

    const completed = await service.exportSadminCredits(db, sharedActor, { q: "EXPORT-SADMIN-PAGE-", status: "created" });
    assert.equal(completed.status, "created");
    assert.deepEqual(completed.items.map(item => item.id), [createdId]);
    assert.equal(completed.items[0].sadmin.numeroCredito, "EXPORT-SADMIN-0001");
  });

  await t.test("la exportación rechaza más de 2.000 coincidencias sin truncarlas silenciosamente", async () => {
    await pool.query(`INSERT INTO "Credito" ("folio")
      SELECT 'EXPORT-LIMIT-' || LPAD(value::text,5,'0') FROM generate_series(1,2001) AS value`);
    try {
      await assert.rejects(
        service.exportSadminCredits(db, actor, { q: "EXPORT-LIMIT-", status: "all" }),
        error => error.code === "SADMIN_EXPORT_TOO_LARGE" && error.status === 413,
      );
    } finally {
      await pool.query(`DELETE FROM "Credito" WHERE "folio" LIKE 'EXPORT-LIMIT-%'`);
    }
  });

  await t.test("incluye central, importados y pagados; excluye las cuatro variantes de anulación", async () => {
    const central = await create({ folio: "ALCANCE-CENTRAL", sedeId: 1 });
    const imported = await create({ folio: "ALCANCE-IMPORTADO", equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } });
    const paid = await create({ folio: "ALCANCE-PAGADO", estado: "PAZ_Y_SALVO", pazYSalvoEmitidoAt: "2026-01-01" });
    const paidByPayments = await create({ folio: "ALCANCE-ABONADO" });
    await pool.query('INSERT INTO "CreditoAbono" ("creditoId","fechaAbono","valor","metodoPago") VALUES ($1,\'2026-01-01\',1200000,\'EFECTIVO\')', [paidByPayments]);
    for (const estado of ["ANULADO", " anulada ", "CANCELADO", " cancelada "]) await create({ folio: `ALCANCE-${sequence}`, estado });
    const page = await service.listSadminCredits(db, sharedActor, { q: "ALCANCE-" });
    assert.equal(page.total, 4);
    assert.deepEqual(new Set(page.items.map(item => item.id)), new Set([central, imported, paid, paidByPayments]));
    for (const id of [paid, paidByPayments]) {
      const item = page.items.find(credit => credit.id === id);
      assert.equal(item.saldoObligacion, 0); assert.equal(item.cuotasPendientes, 0); assert.equal(item.fechaProximoPago, null);
    }
  });

  await t.test("tasas de amortización prevalecen; histórico usa snapshot y seguro ausente queda null", async () => {
    const amortized = await create({ folio: "TASAS-AMORT", contratoSnapshot: { financiero: { tasaInteresEa: 25, fianzaTotalPorcentaje: 65, seguroCuotaPorcentaje: 0.05 } } });
    await pool.query('INSERT INTO "CreditoAmortizacion" ("creditoId","tasaInteresEaPorcentaje","fianzaCuotaPorcentaje","seguroCuotaPorcentaje","numeroCuotas") VALUES ($1,29.24,3.125,0.03,24)', [amortized]);
    await create({ folio: "TASAS-SNAPSHOT", contratoSnapshot: { financiero: { tasaInteresEa: 25, fianzaTotalPorcentaje: 65, seguroCuotaPorcentaje: 0.05 } } });
    await create({ folio: "TASAS-SIN-SEGURO", tasaInteresEa: 0, fianzaPorcentaje: 0 });
    const page = await service.listSadminCredits(db, actor, { q: "TASAS-" });
    const amort = page.items.find(item => item.folio === "TASAS-AMORT");
    const snapshot = page.items.find(item => item.folio === "TASAS-SNAPSHOT");
    const absent = page.items.find(item => item.folio === "TASAS-SIN-SEGURO");
    assert.deepEqual([amort.interesMensual, amort.fianza, amort.seguro], [0.021605, 0.75, 0.0003]);
    assert.deepEqual([snapshot.interesMensual, snapshot.fianza, snapshot.seguro], [0.018769, 0.65, 0.0005]);
    assert.deepEqual([absent.interesMensual, absent.fianza, absent.seguro], [0, 0, null]);
  });

  await t.test("búsqueda usa texto literal y alcanza número SADMIN sin interpolar SQL", async () => {
    await create({ folio: "LITERAL-%_COMILLA'" });
    const result = await service.listSadminCredits(db, actor, { q: "%_COMILLA'" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].folio, "LITERAL-%_COMILLA'");
    assert.equal((await service.listSadminCredits(db, actor, { q: "' OR 1=1 --" })).total, 0);
    await change(result.items[0].id, 0, "numeroCredito", "NUM-0009");
    assert.equal((await service.listSadminCredits(db, actor, { q: "num-0009" })).items[0].id, result.items[0].id);
  });

  await t.test("tres checklist y número real completan; editar número desconfirma; no-op conserva versión y auditoría", async () => {
    const id = await create();
    let row = await change(id, 0, "codeudorCreado", true);
    assert.equal(row.version, 1); assert.equal(row.estado, "PENDIENTE");
    await assert.rejects(change(id, 1, "numeroCreditoConfirmado", true), error => error.code === "SADMIN_NUMBER_REQUIRED");
    row = await change(id, 1, "numeroCredito", " 0000123-A ");
    assert.equal(row.numeroCredito, "0000123-A"); assert.equal(row.version, 2);
    row = await change(id, 2, "creditoCreado", true);
    row = await change(id, 3, "numeroCreditoConfirmado", true);
    assert.equal(row.version, 4); assert.equal(row.estado, "CREADO_SADMIN"); assert.ok(row.completedAt);
    const confirmedCredit = (await service.listSadminCredits(db, actor, { q: "0000123-A" })).items[0];
    assert.equal(confirmedCredit.numeroCreditoVisible, "0000123-A");
    assert.notEqual(confirmedCredit.folio, confirmedCredit.numeroCreditoVisible);
    const unchanged = await change(id, 4, "numeroCreditoConfirmado", true);
    assert.equal(unchanged.version, 4); assert.equal(unchanged.completedAt, row.completedAt); assert.equal(await eventCount(id), 4);
    row = await change(id, 4, "numeroCredito", "0000123-B");
    assert.equal(row.version, 5); assert.equal(row.numeroCreditoConfirmado, false); assert.equal(row.estado, "PENDIENTE"); assert.equal(row.completedAt, null);
    const unconfirmedCredit = (await service.listSadminCredits(db, actor, { q: "0000123-B" })).items[0];
    assert.equal(unconfirmedCredit.numeroCreditoVisible, unconfirmedCredit.folio);
    assert.equal((await getRegistration(id)).numeroCredito, "0000123-B");
    const credit = (await pool.query('SELECT "estado" FROM "Credito" WHERE "id"=$1', [id])).rows[0];
    assert.equal(credit.estado, "INSCRITO");
    const events = (await pool.query('SELECT * FROM "CreditSadminEvent" WHERE "creditoId"=$1 ORDER BY "version"', [id])).rows;
    assert.equal(events.length, 5); assert.ok(events.every(event => event.actorKind === "USER" && event.actorUserId === 1 && event.actorName === actor.nombre));
    assert.equal(events[4].payload.before.numeroCredito, "0000123-A"); assert.equal(events[4].payload.after.numeroCredito, "0000123-B");
  });

  await t.test("rechaza número duplicado sin importar mayúsculas y revierte toda la escritura", async () => {
    const first = await create(), second = await create();
    await change(first, 0, "numeroCredito", "UNIQUE-001");
    await assert.rejects(change(second, 0, "numeroCredito", "unique-001"), error => error.code === "SADMIN_NUMBER_EXISTS" && error.status === 409);
    assert.equal(await getRegistration(second), undefined); assert.equal(await eventCount(second), 0);
  });

  await t.test("versión obsoleta falla sin modificar las marcas del otro operador", async () => {
    const id = await create();
    await change(id, 0, "codeudorCreado", true);
    await assert.rejects(change(id, 0, "creditoCreado", true), error => error.code === "SADMIN_CHANGED" && error.status === 409);
    const row = await getRegistration(id); assert.equal(row.version, 1); assert.equal(row.codeudorCreado, true); assert.equal(row.creditoCreado, false); assert.equal(await eventCount(id), 1);
  });

  await t.test("timestamps devueltos por JSON conservan UTC en un servidor configurado en Bogotá", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "America/Bogota";
    try {
      const id = await create({ folio: "TIMEZONE-SADMIN" });
      const changed = await change(id, 0, "codeudorCreado", true);
      const listed = (await service.listSadminCredits(db, actor, { q: "TIMEZONE-SADMIN" })).items[0].sadmin;
      assert.equal(listed.updatedAt, changed.updatedAt);
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  await t.test("dos escrituras simultáneas con igual versión: una confirma y otra responde 409", async () => {
    const id = await create();
    const results = await Promise.allSettled([change(id, 0, "codeudorCreado", true), change(id, 0, "creditoCreado", true)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const failure = results.find(result => result.status === "rejected").reason;
    assert.equal(failure.code, "SADMIN_CHANGED"); assert.equal(failure.status, 409);
    assert.equal((await getRegistration(id)).version, 1); assert.equal(await eventCount(id), 1);
  });

  await t.test("autoría compartida identifica grant/sesión; revocación bloquea lectura y escritura", async () => {
    const id = await create();
    await change(id, 0, "codeudorCreado", true, sharedActor);
    const event = (await pool.query('SELECT * FROM "CreditSadminEvent" WHERE "creditoId"=$1', [id])).rows[0];
    assert.equal(event.actorKind, "SHARED_LINK"); assert.equal(event.actorUserId, null); assert.equal(event.actorName, "Acceso compartido");
    assert.equal(event.actorGrantId, sharedActor.grantId); assert.equal(event.actorSessionId, sharedActor.sessionId);
    await pool.query('UPDATE "CreditApprovalSharedSession" SET "revokedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [sharedActor.sessionId]);
    await assert.rejects(service.listSadminCredits(db, sharedActor), error => error.code === "SHARED_ACCESS_REVOKED");
    await assert.rejects(service.exportSadminCredits(db, sharedActor), error => error.code === "SHARED_ACCESS_REVOKED");
    await assert.rejects(change(id, 1, "creditoCreado", true, sharedActor), error => error.code === "SHARED_ACCESS_REVOKED");
    assert.equal((await getRegistration(id)).version, 1); assert.equal(await eventCount(id), 1);
    await pool.query('UPDATE "CreditApprovalSharedSession" SET "revokedAt"=NULL WHERE "id"=$1', [sharedActor.sessionId]);
    await pool.query('UPDATE "CreditApprovalSharedGrant" SET "revokedAt"=CURRENT_TIMESTAMP WHERE "id"=$1', [sharedActor.grantId]);
    await assert.rejects(service.listSadminCredits(db, sharedActor), error => error.code === "SHARED_ACCESS_REVOKED");
    await assert.rejects(service.exportSadminCredits(db, sharedActor), error => error.code === "SHARED_ACCESS_REVOKED");
    await pool.query('UPDATE "CreditApprovalSharedGrant" SET "revokedAt"=NULL WHERE "id"=$1', [sharedActor.grantId]);
  });

  await t.test("IDs inexistentes/anulados y entradas inválidas fallan sin auditoría", async () => {
    const id = await create({ estado: "ANULADO" });
    for (const creditId of [id, 2147483647]) await assert.rejects(change(creditId, 0, "codeudorCreado", true), error => error.code === "CREDIT_NOT_FOUND");
    for (const invalid of ["0", "-1", "1 OR 1=1", "2147483648", "1.5"]) await assert.rejects(service.updateSadminRegistration(db, actor, invalid, { version: 0, field: "codeudorCreado", value: true }), error => error.code === "INVALID_CREDIT");
    for (const page of [-1, "abc", 0, "1.5"]) await assert.rejects(service.listSadminCredits(db, actor, { page }), error => error.code === "INVALID_PAGE");
    for (const q of ["x".repeat(101), "cliente\n", 42]) {
      await assert.rejects(service.listSadminCredits(db, actor, { q }), error => error.code === "INVALID_SEARCH");
      await assert.rejects(service.exportSadminCredits(db, actor, { q }), error => error.code === "INVALID_SEARCH");
    }
    for (const status of ["CREATED", "done", 42]) {
      await assert.rejects(service.listSadminCredits(db, actor, { status }), error => error.code === "INVALID_SADMIN_STATUS" && error.status === 400);
      await assert.rejects(service.exportSadminCredits(db, actor, { status }), error => error.code === "INVALID_SADMIN_STATUS" && error.status === 400);
    }
    assert.equal(await eventCount(id), 0);
  });

  await t.test("PrismaClient y PrismaPg reales leen histórico y guardan con sesión compartida", async () => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier.startsWith(".") && context.parentURL?.includes("/app/generated/prisma/")) {
        try { return nextResolve(specifier, context); }
        catch (error) {
          if (error.code === "ERR_MODULE_NOT_FOUND") return nextResolve(`${specifier}.ts`, context);
          throw error;
        }
      }
      return nextResolve(specifier, context);
    } });
    let prisma;
    try {
      const { PrismaClient } = await import("../app/generated/prisma/client.ts");
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
      const id = await create({ folio: "PRISMA-SADMIN" });
      const page = await service.listSadminCredits(prisma, sharedActor, { q: "PRISMA-SADMIN" });
      assert.equal(page.items[0].id, id); assert.equal(page.items[0].sadmin.version, 0);
      const exported = await service.exportSadminCredits(prisma, sharedActor, { q: "PRISMA-SADMIN", status: "pending" });
      assert.equal(exported.status, "pending"); assert.deepEqual(exported.items.map(item => item.id), [id]);
      const saved = await service.updateSadminRegistration(prisma, sharedActor, String(id), { version: 0, field: "numeroCredito", value: "PRISMA-00001" });
      assert.equal(saved.numeroCredito, "PRISMA-00001"); assert.equal(saved.version, 1);
      const reread = await service.listSadminCredits(prisma, sharedActor, { q: "PRISMA-00001" });
      assert.equal(reread.items[0].sadmin.updatedAt, saved.updatedAt);
      assert.equal((await getRegistration(id)).numeroCredito, "PRISMA-00001");
    } finally {
      if (prisma) await prisma.$disconnect();
      hooks.deregister();
    }
  });
});
