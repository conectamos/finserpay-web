import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "Credito" (id INTEGER PRIMARY KEY, folio TEXT, "clienteNombre" TEXT, "clienteTelefono" TEXT, estado TEXT);
    CREATE TABLE "Usuario" (id INTEGER PRIMARY KEY, nombre TEXT);
    INSERT INTO "Usuario" VALUES (1,'Administradora real'),(2,'Analista real');`);
  const client = { query: (sql, values = []) => db.query(sql, values) };
  await installMoraExceptionRequestSchema(client);
  let nextCreditId = 77;
  async function insert({ status = "APPROVED", type = "PRORROGA", source = "ANALYST_REQUEST",
    at = "2026-10-03T17:00:00.000Z", expiresOn = "2026-10-06", installmentDueDate = "2026-10-02", system = false, userId = 1 } = {}, connection = db) {
    const id = randomUUID(), creditId = nextCreditId++;
    await connection.query(`INSERT INTO "Credito" VALUES ($1,$2,'Cliente sintético','3001234567','ACTIVO')`, [creditId, `FC-${creditId}`]);
    const pending = status === "PENDING", direct = source === "CENTRAL_DIRECT", systemKey = system ? "SYSTEM_DIANA" : null;
    await connection.query(`INSERT INTO "CreditMoraExceptionRequest"
      (id,"creditoId",type,status,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,
       "createdByUserId","createdBySystemKey","createdByName","decidedByUserId","decidedBySystemKey","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::date,'Compromiso confirmado','Seguimiento documentado',
        $11,$12,$13,$14,$15,$16,$17::timestamptz,$18::uuid,$19)`,
    [id, creditId, type, status, source, direct ? null : 1, direct ? null : installmentDueDate, expiresOn,
      direct || source === "SYSTEM_DIANA_REQUEST" ? null : 100,
      direct || source === "SYSTEM_DIANA_REQUEST" ? null : expiresOn,
      system ? null : userId, systemKey, system ? "Diana" : userId === 2 ? "Analista real" : "Administradora real",
      pending || system ? null : userId, pending ? null : systemKey,
      pending ? null : system ? "Diana" : userId === 2 ? "Analista real" : "Administradora real", pending ? null : at, randomUUID(), "a".repeat(64)]);
    return { id, creditId };
  }
  const read = async (id, connection = db) => (await connection.query(`SELECT "activationWhatsApp" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [id])).rows[0]?.activationWhatsApp;
  return { db, client, insert, read };
}

const iso = value => new Date(value).toISOString();

test("la activación guarda el WhatsApp V2 con identidad y plazo de la cuota; repetir y editar no lo recrea", async t => {
  const f = await fixture(t), { id } = await f.insert();
  const activation = await f.read(id);
  assert.equal(activation.status, "PENDING");
  assert.equal(activation.name, "Cliente sintético");
  assert.equal(activation.phone, "3001234567");
  assert.equal(activation.authorizedByName, "Administradora real");
  assert.equal(iso(activation.activatedAt), "2026-10-03T17:00:00.000Z");
  assert.equal(activation.templateName, "prorroga_activada_v2");
  assert.equal(activation.installmentDueDate, "2026-10-02");
  assert.equal(activation.approvedDays, 4, "el plazo del mensaje se cuenta desde la cuota del 02 hasta el 06");
  assert.equal(iso(activation.expiresAt), "2026-10-07T04:59:59.999Z");
  assert.equal(activation.sentAt, null);
  assert.equal(activation.attempts, 0);
  assert.equal(activation.operationKey, null);
  assert.ok(Number.isFinite(new Date(activation.nextAttemptAt).getTime()));
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED',version=version+1,"expiresOn"='2026-10-10',observation='Observación posterior' WHERE id=$1::uuid`, [id]);
  assert.deepEqual(await f.read(id), activation, "edición y repetición conservan la activación original");
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [id]);
  assert.deepEqual(await f.read(id), activation, "cancelar conserva historial y no crea otro envío");
});

test("una solicitud pendiente solo encola al aprobarse y la auditoría fallida revierte también la notificación", async t => {
  const f = await fixture(t), pending = await f.insert({ status: "PENDING", source: "ANALYST_REQUEST", userId: 2 });
  assert.equal(await f.read(pending.id), null);
  await assert.rejects(f.db.transaction(async tx => {
    await tx.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED',version=2,"decidedByUserId"=1,"decidedByName"='Administradora real',"decidedAt"='2026-10-03T17:00:00Z' WHERE id=$1::uuid`, [pending.id]);
    assert.equal((await f.read(pending.id, tx)).status, "PENDING");
    await tx.query(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorName","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,2,'INVALID','PENDING','APPROVED','{}','Administradora real',$4)`, [randomUUID(), pending.id, pending.creditId, "b".repeat(64)]);
  }));
  assert.equal(await f.read(pending.id), null);
  assert.equal((await f.db.query(`SELECT status FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [pending.id])).rows[0].status, "PENDING");
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED',version=2,"decidedByUserId"=1,"decidedByName"='Administradora real',"decidedAt"='2026-10-03T17:00:00Z' WHERE id=$1::uuid`, [pending.id]);
  assert.equal((await f.read(pending.id)).approvedDays, 4);
});

test("un INSERT aprobado de analista revierte junto a toda la activación si falla el historial", async t => {
  const f = await fixture(t);
  let recorded;
  await assert.rejects(f.db.transaction(async tx => {
    recorded = await f.insert({ source: "ANALYST_REQUEST", userId: 2 }, tx);
    const snapshot = await f.read(recorded.id, tx);
    assert.equal(snapshot.authorizedByName, "Analista real");
    throw new Error("No se pudo guardar el historial de la activación");
  }), /historial/);
  assert.equal(await f.read(recorded.id), undefined);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "Credito"`)).rows[0].n, 0);
});

test("rechazo, cancelación sin aprobar, excepciones indefinidas y decisiones de Diana no crean mensajes de prórroga", async t => {
  const f = await fixture(t);
  for (const status of ["REJECTED", "CANCELLED"]) {
    const pending = await f.insert({ source: "ANALYST_REQUEST", status: "PENDING" });
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status=$2,"decidedAt"='2026-10-03T17:00:00Z',"decidedByUserId"=1,"decidedByName"='Administradora real' WHERE id=$1::uuid`, [pending.id, status]);
    assert.equal(await f.read(pending.id), null);
  }
  const exception = await f.insert({ type: "EXCEPCION", source: "CENTRAL_DIRECT", expiresOn: null });
  assert.equal(await f.read(exception.id), null);
  for (const source of ["SYSTEM_DIANA", "SYSTEM_DIANA_REQUEST"]) {
    const row = await f.insert({ source, system: true });
    assert.equal(await f.read(row.id), null);
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [row.id]);
    assert.equal(await f.read(row.id), null, "el trigger conserva las protecciones de identidad de Diana");
  }
});

test("la excepción temporal con cuota encola una sola notificación sin cambiar tipo ni condiciones", async t => {
  const f = await fixture(t);
  let row;
  await f.db.transaction(async tx => {
    row = await f.insert({ type: "EXCEPCION" }, tx);
    const notification = await f.read(row.id, tx);
    assert.equal(notification.status, "PENDING");
    assert.equal(notification.approvedDays, 4);
    assert.equal(notification.authorizedByName, "Administradora real");
  });
  const notification = await f.read(row.id);
  const business = async () => (await f.db.query(`SELECT to_jsonb(r)-'activationWhatsApp' AS request,to_jsonb(c) AS credit
    FROM "CreditMoraExceptionRequest" r JOIN "Credito" c ON c.id=r."creditoId" WHERE r.id=$1::uuid`, [row.id])).rows[0];
  const before = await business();
  assert.equal(before.request.type, "EXCEPCION");
  assert.equal(before.request.source, "ANALYST_REQUEST");
  assert.equal(before.request.status, "APPROVED");
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED' WHERE id=$1::uuid`, [row.id]);
  assert.deepEqual(await f.read(row.id), notification);
  assert.deepEqual(await business(), before, "la reserva no reclasifica la excepción ni modifica crédito, versión, autorización o fechas");
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"='2026-10-10',version=version+1 WHERE id=$1::uuid`, [row.id]);
  assert.deepEqual(await f.read(row.id), notification, "editar una excepción ya aprobada no duplica la activación");
});

test("aprobar una excepción temporal pendiente encola atómicamente; un fallo revierte decisión y WhatsApp", async t => {
  const f = await fixture(t), row = await f.insert({ type: "EXCEPCION", source: "ANALYST_REQUEST", status: "PENDING", userId: 2 });
  assert.equal(await f.read(row.id), null);
  const approve = tx => tx.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED',version=2,
    "decidedByUserId"=1,"decidedByName"='Administradora real',"decidedAt"='2026-10-03T17:00:00Z' WHERE id=$1::uuid`, [row.id]);
  await assert.rejects(f.db.transaction(async tx => {
    await approve(tx);
    assert.equal((await f.read(row.id, tx)).status, "PENDING");
    await tx.query(`INSERT INTO "CreditMoraExceptionEvent"(id,"requestId","creditoId",version,action,"fromStatus","toStatus",payload,"actorName","requestHash")
      VALUES ($1::uuid,$2::uuid,$3,2,'INVALID','PENDING','APPROVED','{}','Administradora real',$4)`, [randomUUID(), row.id, row.creditId, "b".repeat(64)]);
  }));
  assert.equal(await f.read(row.id), null);
  assert.equal((await f.db.query(`SELECT status FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [row.id])).rows[0].status, "PENDING");
  await f.db.transaction(approve);
  const notification = await f.read(row.id);
  assert.equal(notification.status, "PENDING");
  assert.equal(notification.approvedDays, 4);
  assert.equal(notification.name, "Cliente sintético");
  assert.equal(notification.phone, "3001234567");
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED' WHERE id=$1::uuid`, [row.id]);
  assert.deepEqual(await f.read(row.id), notification);
  const stored = (await f.db.query(`SELECT type,source,"decidedByUserId","decidedAt",version FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [row.id])).rows[0];
  assert.equal(stored.type, "EXCEPCION");
  assert.equal(stored.source, "ANALYST_REQUEST");
  assert.equal(stored.decidedByUserId, 1);
  assert.equal(iso(stored.decidedAt), "2026-10-03T17:00:00.000Z");
  assert.equal(stored.version, 2);
});

test("una excepción indefinida conserva su aprobación y no se notifica al editarla después", async t => {
  const f = await fixture(t), row = await f.insert({ type: "EXCEPCION", source: "CENTRAL_DIRECT", expiresOn: null });
  assert.equal(await f.read(row.id), null);
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED',"expiresOn"='2026-10-06' WHERE id=$1::uuid`, [row.id]);
  assert.equal(await f.read(row.id), null, "corregir una autorización anterior no equivale a una nueva activación");
  const stored = (await f.db.query(`SELECT type,status FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [row.id])).rows[0];
  assert.equal(stored.type, "EXCEPCION");
  assert.equal(stored.status, "APPROVED");
});

test("cuota del 17 hasta el 21 siempre representa cuatro días, aunque se active el 16, 18 o 20", async t => {
  const f = await fixture(t);
  for (const at of ["2026-11-16T20:00:00.000Z", "2026-11-18T20:00:00.000Z", "2026-11-20T20:00:00.000Z"]) {
    const { id } = await f.insert({ at, installmentDueDate: "2026-11-17", expiresOn: "2026-11-21" });
    const snapshot = await f.read(id);
    assert.equal(snapshot.approvedDays, 4, at);
    assert.equal(snapshot.installmentDueDate, "2026-11-17");
    assert.equal(iso(snapshot.expiresAt), "2026-11-22T04:59:59.999Z");
    assert.equal(iso(snapshot.activatedAt), at);
  }
});

test("sin fecha de vencimiento la activación se conserva con fallo rastreable y sin duración inventada", async t => {
  const f = await fixture(t), { id } = await f.insert({ source: "CENTRAL_DIRECT", expiresOn: null });
  const snapshot = await f.read(id);
  assert.equal(snapshot.status, "FAILED");
  assert.equal(snapshot.error, "MISSING_EXTENSION_EXPIRY");
  assert.equal(snapshot.approvedDays, null);
  assert.equal(snapshot.expiresAt, null);
  assert.equal(snapshot.nextAttemptAt, null);
  assert.equal(snapshot.sentAt, null);
  assert.equal(snapshot.attempts, 0);
  assert.equal((await f.db.query(`SELECT status FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [id])).rows[0].status, "APPROVED");
});

test("sin cuota verificada o con plazo cero o negativo falla solo la notificación", async t => {
  const f = await fixture(t), direct = await f.insert({ source: "CENTRAL_DIRECT" });
  const missing = await f.read(direct.id);
  assert.equal(missing.status, "FAILED");
  assert.equal(missing.error, "MISSING_INSTALLMENT_DUE_DATE");
  assert.equal(missing.approvedDays, null);
  assert.equal(missing.installmentDueDate, null);
  assert.equal(missing.nextAttemptAt, null);
  for (const expiresOn of ["2026-11-17", "2026-11-16"]) {
    const { id } = await f.insert({ installmentDueDate: "2026-11-17", expiresOn });
    const invalid = await f.read(id);
    assert.equal(invalid.status, "FAILED");
    assert.equal(invalid.error, "INVALID_EXTENSION_DURATION");
    assert.equal(invalid.approvedDays, null);
    assert.equal(invalid.nextAttemptAt, null);
    assert.equal((await f.db.query(`SELECT status FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [id])).rows[0].status, "APPROVED");
  }
});

test("una notificación legacy existente conserva su plantilla y duración al reinstalar y repetir estado", async t => {
  const f = await fixture(t), { id } = await f.insert();
  const legacy = { ...(await f.read(id)), templateName: "prorroga_activada", approvedDays: 3, installmentDueDate: null };
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET "activationWhatsApp"=$2::jsonb WHERE id=$1::uuid`, [id, JSON.stringify(legacy)]);
  await installMoraExceptionRequestSchema(f.client);
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED' WHERE id=$1::uuid`, [id]);
  assert.deepEqual(await f.read(id), legacy);
});

test("reinstalar conserva notificaciones y no genera envíos para aprobaciones históricas", async t => {
  const f = await fixture(t);
  const pairs = [];
  for (const type of ["PRORROGA", "EXCEPCION"]) {
    const current = await f.insert({ type }), historical = await f.insert({ type });
    pairs.push({ current, historical, snapshot: await f.read(current.id) });
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET "activationWhatsApp"=NULL WHERE id=$1::uuid`, [historical.id]);
  }
  await installMoraExceptionRequestSchema(f.client);
  await installMoraExceptionRequestSchema(f.client);
  for (const { current, historical, snapshot } of pairs) {
    assert.deepEqual(await f.read(current.id), snapshot);
    assert.equal(await f.read(historical.id), null);
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED' WHERE id=$1::uuid`, [historical.id]);
    assert.equal(await f.read(historical.id), null, "repetir estado aprobado histórico no encola retrospectivamente");
  }
});
