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
  async function insert({ status = "APPROVED", type = "PRORROGA", source = "CENTRAL_DIRECT",
    at = "2026-10-03T17:00:00.000Z", expiresOn = "2026-10-06", system = false, userId = 1 } = {}, connection = db) {
    const id = randomUUID(), creditId = nextCreditId++;
    await connection.query(`INSERT INTO "Credito" VALUES ($1,$2,'Cliente sintético','3001234567','ACTIVO')`, [creditId, `FC-${creditId}`]);
    const pending = status === "PENDING", direct = source === "CENTRAL_DIRECT", systemKey = system ? "SYSTEM_DIANA" : null;
    await connection.query(`INSERT INTO "CreditMoraExceptionRequest"
      (id,"creditoId",type,status,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,
       "createdByUserId","createdBySystemKey","createdByName","decidedByUserId","decidedBySystemKey","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10::date,'Compromiso confirmado','Seguimiento documentado',
        $11,$12,$13,$14,$15,$16,$17::timestamptz,$18::uuid,$19)`,
    [id, creditId, type, status, source, direct ? null : 1, direct ? null : "2026-10-02", expiresOn,
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

test("la activación directa guarda el WhatsApp con identidad y plazo desde la decisión; repetir y editar no lo recrea", async t => {
  const f = await fixture(t), { id } = await f.insert();
  const activation = await f.read(id);
  assert.equal(activation.status, "PENDING");
  assert.equal(activation.name, "Cliente sintético");
  assert.equal(activation.phone, "3001234567");
  assert.equal(activation.authorizedByName, "Administradora real");
  assert.equal(iso(activation.activatedAt), "2026-10-03T17:00:00.000Z");
  assert.equal(activation.approvedDays, 3, "el plazo del mensaje se cuenta desde activación, no desde cuota del 02");
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
  assert.equal((await f.read(pending.id)).approvedDays, 3);
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

test("rechazo, cancelación sin aprobar, excepciones y decisiones de Diana no crean mensajes de prórroga", async t => {
  const f = await fixture(t);
  for (const status of ["REJECTED", "CANCELLED"]) {
    const pending = await f.insert({ source: "ANALYST_REQUEST", status: "PENDING" });
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status=$2,"decidedAt"='2026-10-03T17:00:00Z',"decidedByUserId"=1,"decidedByName"='Administradora real' WHERE id=$1::uuid`, [pending.id, status]);
    assert.equal(await f.read(pending.id), null);
  }
  const exception = await f.insert({ type: "EXCEPCION" });
  assert.equal(await f.read(exception.id), null);
  for (const source of ["SYSTEM_DIANA", "SYSTEM_DIANA_REQUEST"]) {
    const row = await f.insert({ source, system: true });
    assert.equal(await f.read(row.id), null);
    await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [row.id]);
    assert.equal(await f.read(row.id), null, "el trigger conserva las protecciones de identidad de Diana");
  }
});

test("el día de activación usa medianoche Colombia y el mismo día equivale a un día", async t => {
  const f = await fixture(t);
  for (const [at, expected] of [["2026-10-04T04:59:59.999Z", 3], ["2026-10-04T05:00:00.000Z", 2], ["2026-10-06T23:59:00.000Z", 1]]) {
    const { id } = await f.insert({ at });
    const snapshot = await f.read(id);
    assert.equal(snapshot.approvedDays, expected, at);
    assert.equal(iso(snapshot.activatedAt), at);
  }
});

test("sin fecha de vencimiento la activación se conserva con fallo rastreable y sin duración inventada", async t => {
  const f = await fixture(t), { id } = await f.insert({ expiresOn: null });
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

test("reinstalar conserva notificaciones y no genera envíos para aprobaciones históricas", async t => {
  const f = await fixture(t), current = await f.insert(), historical = await f.insert();
  const snapshot = await f.read(current.id);
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET "activationWhatsApp"=NULL WHERE id=$1::uuid`, [historical.id]);
  await installMoraExceptionRequestSchema(f.client);
  await installMoraExceptionRequestSchema(f.client);
  assert.deepEqual(await f.read(current.id), snapshot);
  assert.equal(await f.read(historical.id), null);
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='APPROVED' WHERE id=$1::uuid`, [historical.id]);
  assert.equal(await f.read(historical.id), null, "repetir estado aprobado histórico no encola retrospectivamente");
});
