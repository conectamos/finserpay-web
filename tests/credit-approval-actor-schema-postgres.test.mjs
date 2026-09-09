import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";
import { installCreditApprovalActorSchema } from "../scripts/credit-approval-actor-schema.mjs";
import { installApprovalSharedSchema } from "../scripts/approval-shared-schema.mjs";

const connectionString = process.env.CREDIT_APPROVAL_ACTOR_TEST_DATABASE_URL;

test("PostgreSQL aislado: autoría personal/compartida, Prisma-first e historia preservada", {
  skip: connectionString ? false : "Requiere CREDIT_APPROVAL_ACTOR_TEST_DATABASE_URL local approval_actor_test",
}, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Solo PostgreSQL local aislado");
  assert.equal(url.pathname, "/approval_actor_test", "Base exclusiva de fixtures de autoría");
  const db = new pg.Client({ connectionString });
  await db.connect();
  t.after(async () => { await db.end(); });
  const tables = ["CreditApprovalEvent", "CreditApprovalReview", "CreditApprovalSharedSession", "CreditApprovalSharedGrant",
    "CreditApprovalPolicy", "LiquidacionAliadoCredito", "Credito", "Sede", "Usuario"];
  const existing = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(existing.rows.every(({ tablename }) => tables.includes(tablename)), "No se permite borrar tablas ajenas al fixture");
  for (const table of tables) await db.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
  await db.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1),(2);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (10,10);
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY,"createdAt" TIMESTAMP(3) DEFAULT '2099-01-01',
      "clienteNombre" TEXT DEFAULT 'Cliente sintético',"clienteDocumento" TEXT DEFAULT '12345',
      "valorEquipoTotal" FLOAT DEFAULT 1000000,"cuotaInicial" FLOAT DEFAULT 200000,
      "saldoBaseFinanciado" FLOAT DEFAULT 800000,"montoCredito" FLOAT DEFAULT 800000,
      "imei" TEXT DEFAULT '111111111111111',"sedeId" INTEGER DEFAULT 10,
      "equipoMarca" TEXT DEFAULT 'Marca QA',"equipoModelo" TEXT DEFAULT 'Modelo QA',
      "equalityService" TEXT,"contratoSnapshot" JSONB DEFAULT '{"firma":{"hash":"original"}}',
      "contratoCedulaFrenteDataUrl" TEXT DEFAULT 'front',"contratoCedulaRespaldoDataUrl" TEXT DEFAULT 'back',
      "iphoneSelfieCedulaDataUrl" TEXT DEFAULT 'selfie',"fotoEntregaDataUrl" TEXT DEFAULT 'delivery',"fotoRemisionDataUrl" TEXT DEFAULT 'remission'
    );
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,"creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"),"snapshot" TEXT DEFAULT 'pago original');
  `);
  await installCreditApprovalSchema(db);
  const createCredit = async () => (await db.query('INSERT INTO "Credito" DEFAULT VALUES RETURNING "id"')).rows[0].id;
  const review = async (id) => (await db.query('SELECT to_jsonb(r) AS row FROM "CreditApprovalReview" r WHERE "creditoId"=$1', [id])).rows[0].row;
  const approvePersonal = async (id) => {
    await db.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"="revision",
      "approvedByUserId"=1,"approvedByName"='Analista previo',"approvedAt"='2026-09-09 12:34:56.123',"reviewHash"=$2
      WHERE "creditoId"=$1`, [id, "a".repeat(64)]);
    await db.query(`INSERT INTO "CreditApprovalEvent" ("creditoId","eventType","revision","actorUserId","actorName","reviewHash","createdAt")
      SELECT "creditoId",'APPROVED',"revision",1,'Analista previo',"reviewHash",'2026-09-09 12:34:56.123'
      FROM "CreditApprovalReview" WHERE "creditoId"=$1`, [id]);
  };
  const snapshot = async () => {
    const result = {};
    for (const table of tables.filter((name) => !name.includes("Shared"))) {
      result[table] = (await db.query('SELECT to_jsonb(t) AS row FROM "' + table + '" t ORDER BY to_jsonb(t)::text')).rows.map(({ row }) => row);
    }
    return result;
  };
  const approved = await createCredit();
  const paid = await createCredit();
  const pending = await createCredit();
  const anotherPending = await createCredit();
  await db.query(`UPDATE "CreditApprovalReview" SET "revision"=7,"createdAt"='2026-01-01 01:02:03.456',"updatedAt"='2026-02-02 02:03:04.567'
    WHERE "creditoId"=$1`, [pending]);
  await approvePersonal(approved);
  await approvePersonal(paid);
  await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [paid]);
  const beforeColumns = await snapshot();
  const originalPolicy = beforeColumns.CreditApprovalPolicy;
  // Prisma introduces nullable review classification, and a non-null USER
  // classification on events. Its schema push runs before the SQL installer.
  await db.query(`ALTER TABLE "CreditApprovalReview" ADD COLUMN "approvedByKind" VARCHAR(16),
    ADD COLUMN "approvedByGrantId" UUID, ADD COLUMN "approvedBySessionId" UUID;
    ALTER TABLE "CreditApprovalEvent" ADD COLUMN "actorKind" VARCHAR(16) NOT NULL DEFAULT 'USER',
    ADD COLUMN "actorGrantId" UUID, ADD COLUMN "actorSessionId" UUID;`);
  // Also cover an earlier additive default that labelled a pending review USER.
  await db.query('UPDATE "CreditApprovalReview" SET "approvedByKind"=\'USER\' WHERE "creditoId"=$1', [pending]);
  const reviewFields = ["approvedByKind", "approvedByGrantId", "approvedBySessionId"];
  const eventFields = ["actorKind", "actorGrantId", "actorSessionId"];
  const without = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
  await db.query("SET TIME ZONE 'America/Bogota'");
  await installCreditApprovalActorSchema(db);
  await installApprovalSharedSchema(db);

  await t.test("Prisma-first conserva decisiones, eventos, créditos y liquidaciones previos", async () => {
    const after = await snapshot();
    const stable = { ...after,
      CreditApprovalReview: after.CreditApprovalReview.map((row) => without(row, reviewFields)),
      CreditApprovalEvent: after.CreditApprovalEvent.map((row) => without(row, eventFields)),
    };
    // The added metadata changes JSON key ordering, so compare each row by its ID.
    for (const name of Object.keys(stable)) {
      const key = name === "CreditApprovalReview" ? "creditoId" : "id";
      const sort = (rows) => [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
      assert.deepEqual(sort(stable[name]), sort(beforeColumns[name]), name);
    }
    for (const id of [approved, paid]) {
      const row = await review(id);
      assert.equal(row.status, "APPROVED"); assert.equal(row.approvedByKind, "USER"); assert.equal(row.approvedByUserId, 1);
      assert.equal(row.approvedByGrantId, null); assert.equal(row.approvedBySessionId, null);
    }
    assert.ok(after.CreditApprovalEvent.every((row) => row.actorKind === "USER" && row.actorUserId === 1));
  });

  await t.test("PENDING normaliza solo clasificación y no toca revisión ni fechas", async () => {
    for (const id of [pending, anotherPending]) {
      const row = await review(id);
      const before = beforeColumns.CreditApprovalReview.find((item) => item.creditoId === id);
      assert.deepEqual(without(row, reviewFields), before);
      for (const field of reviewFields) assert.equal(row[field], null, field);
    }
    const defaults = await db.query(`SELECT column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='CreditApprovalReview' AND column_name='approvedByKind'`);
    assert.equal(defaults.rows[0].column_default, null);
    assert.equal((await review(await createCredit())).approvedByKind, null);
  });

  const grantA = randomUUID(), grantB = randomUUID(), sessionA = randomUUID(), sessionB = randomUUID();
  await db.query(`INSERT INTO "CreditApprovalSharedGrant" ("id","issuedByUserId") VALUES ($1,1)`, [grantA]);
  await db.query(`INSERT INTO "CreditApprovalSharedGrant" ("id","issuedByUserId","revokedAt","revokedByUserId")
    VALUES ($1,1,CURRENT_TIMESTAMP AT TIME ZONE 'UTC',1)`, [grantB]);
  for (const [sessionId, grantId] of [[sessionA, grantA], [sessionB, grantB]]) {
    await db.query(`INSERT INTO "CreditApprovalSharedSession" ("id","grantId","expiresAt")
      VALUES ($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '1 hour')`, [sessionId, grantId]);
  }
  const sharedFields = { kind: "SHARED_LINK", userId: null, grantId: grantA, sessionId: sessionA };
  const approveActor = (id, fields = sharedFields) => db.query(`UPDATE "CreditApprovalReview"
    SET "status"='APPROVED',"approvedRevision"="revision","approvedByName"='Acceso compartido',
      "approvedAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"reviewHash"=$2,
      "approvedByKind"=$3,"approvedByUserId"=$4,"approvedByGrantId"=$5,"approvedBySessionId"=$6 WHERE "creditoId"=$1`,
  [id, "b".repeat(64), fields.kind, fields.userId, fields.grantId, fields.sessionId]);
  const insertActorEvent = (id, fields = sharedFields) => db.query(`INSERT INTO "CreditApprovalEvent"
    ("creditoId","eventType","revision","actorName","reviewHash","actorKind","actorUserId","actorGrantId","actorSessionId")
    SELECT "creditoId",'APPROVED',"revision",'Acceso compartido',$2,$3,$4,$5,$6 FROM "CreditApprovalReview" WHERE "creditoId"=$1 RETURNING "id"`,
  [id, "b".repeat(64), fields.kind, fields.userId, fields.grantId, fields.sessionId]);
  let sharedCredit;
  let sharedEventId;

  await t.test("autoría compartida válida conserva grant/sesión reales sin atribuir al emisor", async () => {
    sharedCredit = await createCredit();
    await approveActor(sharedCredit);
    sharedEventId = (await insertActorEvent(sharedCredit)).rows[0].id;
    const row = await review(sharedCredit);
    assert.equal(row.approvedByKind, "SHARED_LINK"); assert.equal(row.approvedByUserId, null);
    assert.equal(row.approvedByGrantId, grantA); assert.equal(row.approvedBySessionId, sessionA);
    const event = (await db.query('SELECT * FROM "CreditApprovalEvent" WHERE "id"=$1', [sharedEventId])).rows[0];
    assert.equal(event.actorKind, "SHARED_LINK"); assert.equal(event.actorUserId, null); assert.equal(event.actorGrantId, grantA);
    assert.equal(event.actorSessionId, sessionA);
  });

  await t.test("CHECK XOR rechaza mezclar usuario personal con grant/sesión y pares incompletos", async () => {
    const id = await createCredit();
    for (const fields of [
      { ...sharedFields, userId: 1 }, { ...sharedFields, kind: "USER", userId: 1 },
      { ...sharedFields, grantId: null }, { ...sharedFields, sessionId: null },
      { ...sharedFields, kind: "USER", grantId: null, sessionId: null },
      { ...sharedFields, kind: "INVALID" },
    ]) {
      await assert.rejects(approveActor(id, fields), (error) => error.code === "23514");
      await assert.rejects(insertActorEvent(id, fields), (error) => error.code === "23514");
      assert.equal((await review(id)).status, "PENDING");
    }
    await assert.rejects(approveActor(id, { ...sharedFields, kind: null }), (error) => error.code === "23514");
    await assert.rejects(insertActorEvent(id, { ...sharedFields, kind: null }), (error) => error.code === "23502");
  });

  await t.test("FK compuesta rechaza sesiones/grants inexistentes y dos referencias reales incompatibles", async () => {
    const id = await createCredit();
    for (const fields of [{ ...sharedFields, grantId: randomUUID() }, { ...sharedFields, sessionId: randomUUID() },
      { ...sharedFields, grantId: grantB }, { ...sharedFields, sessionId: sessionB }]) {
      await assert.rejects(approveActor(id, fields), (error) => error.code === "23503");
      await assert.rejects(insertActorEvent(id, fields), (error) => error.code === "23503");
    }
    const constraints = await db.query(`SELECT conname FROM pg_constraint
      WHERE conname IN ('CreditApprovalReview_shared_actor_fkey','CreditApprovalEvent_shared_actor_fkey')`);
    assert.equal(constraints.rowCount, 2);
  });

  await t.test("INVALIDATED admite sistema sin usuario, nombre ni metadata compartida", async () => {
    const result = await db.query(`INSERT INTO "CreditApprovalEvent" ("creditoId","eventType","revision","reason")
      VALUES ($1,'INVALIDATED',1,'SYSTEM_TEST') RETURNING *`, [pending]);
    const event = result.rows[0];
    assert.equal(event.actorKind, "USER"); assert.equal(event.actorUserId, null); assert.equal(event.actorName, null);
    assert.equal(event.actorGrantId, null); assert.equal(event.actorSessionId, null);
    await assert.rejects(db.query(`INSERT INTO "CreditApprovalEvent" ("creditoId","eventType","revision","actorKind","actorGrantId","actorSessionId")
      VALUES ($1,'INVALIDATED',1,'SHARED_LINK',$2,$3)`, [pending, grantA, sessionA]), (error) => error.code === "23514");
  });

  await t.test("reinstalar actor, shared y después base conserva datos, CHECK nuevo y guard de metadata", async () => {
    const before = await snapshot();
    await installCreditApprovalActorSchema(db);
    await installApprovalSharedSchema(db);
    await installCreditApprovalSchema(db);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual((await snapshot()).CreditApprovalPolicy, originalPolicy);
    const id = await createCredit();
    await approveActor(id); // The old base check must not replace the actor XOR.
    await assert.rejects(approveActor(id, { ...sharedFields, userId: 1 }), (error) => error.code === "23514");
    await db.query('SELECT public.credit_approval_invalidate($1,\'BASE_RERUN_TEST\')', [id]);
    const invalidated = await review(id);
    assert.equal(invalidated.status, "PENDING");
    for (const field of reviewFields) assert.equal(invalidated[field], null, field);
    await approvePersonal(await createCredit()); // Existing personal caller still works.
  });

  await t.test("cambiar la foto invalida OK compartido, limpia actor y conserva evento original", async () => {
    const before = await review(sharedCredit);
    const eventBefore = (await db.query('SELECT to_jsonb(e) AS row FROM "CreditApprovalEvent" e WHERE "id"=$1', [sharedEventId])).rows[0].row;
    await db.query('UPDATE "Credito" SET "fotoEntregaDataUrl"=\'revised-delivery\' WHERE "id"=$1', [sharedCredit]);
    const after = await review(sharedCredit);
    assert.equal(after.status, "PENDING"); assert.equal(after.revision, before.revision + 1);
    for (const field of [...reviewFields, "approvedByUserId", "approvedByName", "approvedAt", "approvedRevision", "reviewHash"]) assert.equal(after[field], null, field);
    const invalidated = (await db.query('SELECT * FROM "CreditApprovalEvent" WHERE "creditoId"=$1 AND "eventType"=\'INVALIDATED\' ORDER BY "revision" DESC LIMIT 1', [sharedCredit])).rows[0];
    assert.equal(invalidated.reviewHash, before.reviewHash); assert.equal(invalidated.actorUserId, null); assert.equal(invalidated.actorName, null);
    assert.equal(invalidated.actorKind, "USER"); assert.equal(invalidated.actorGrantId, null); assert.equal(invalidated.actorSessionId, null);
    assert.deepEqual((await db.query('SELECT to_jsonb(e) AS row FROM "CreditApprovalEvent" e WHERE "id"=$1', [sharedEventId])).rows[0].row, eventBefore);
    await assert.rejects(db.query('UPDATE "CreditApprovalEvent" SET "actorName"=\'Reatribución\' WHERE "id"=$1', [sharedEventId]), /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
  });

  await t.test("la nueva metadata no habilita liquidar un pendiente ni afecta un crédito ya pagado", async () => {
    const id = await createCredit();
    await assert.rejects(db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]), /CREDIT_APPROVAL_REQUIRED/);
    await approveActor(id);
    await db.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]);
    const oldPaid = await review(paid);
    await db.query('SELECT public.credit_approval_invalidate($1,\'PAID_TEST\')', [paid]);
    assert.deepEqual(await review(paid), oldPaid);
  });
});
