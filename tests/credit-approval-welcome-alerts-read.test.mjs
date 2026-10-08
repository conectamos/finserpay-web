import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { reader, queue, plain } from "./credit-approval-welcome-alerts-fixture.mjs";

const emptyFingerprint = createHash("md5").update("").digest("hex");
async function fixture(t) {
  const database = new PGlite();
  t.after(() => database.close());
  await database.exec(`SET TIME ZONE 'America/Bogota';
    CREATE TABLE "CreditApprovalPolicy" ("id" INTEGER PRIMARY KEY,"activatedAt" TIMESTAMP(3));
    INSERT INTO "CreditApprovalPolicy" VALUES (1,'2026-09-09');
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY,"codigo" TEXT,"nombre" TEXT);
    INSERT INTO "Aliado" VALUES (10,'ALLY','Aliado sintético'),(20,'FINSERPAY','Central');
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY,"aliadoId" INTEGER,"nombre" TEXT);
    INSERT INTO "Sede" VALUES (10,10,'Sede sintética'),(20,20,'Central');
    CREATE TABLE "Credito" ("id" INTEGER PRIMARY KEY,"sedeId" INTEGER DEFAULT 10,
      "createdAt" TIMESTAMP(3) DEFAULT '2026-09-10',"updatedAt" TIMESTAMP(3) DEFAULT '2026-09-10',
      "fechaCredito" TIMESTAMP(3) DEFAULT '2026-09-10',"estado" TEXT DEFAULT 'INSCRITO',
      "equalityService" TEXT,"contratoSnapshot" JSONB DEFAULT '{}',
      "folio" TEXT DEFAULT 'FNS-SYNTHETIC',"clienteDocumento" TEXT DEFAULT '001000001',
      "clienteNombre" TEXT DEFAULT 'Cliente sintético',"imei" TEXT DEFAULT 'SYNTHETIC-IMEI',
      "referenciaEquipo" TEXT DEFAULT 'Equipo',"saldoBaseFinanciado" DOUBLE PRECISION DEFAULT 0,
      "valorEquipoTotal" DOUBLE PRECISION DEFAULT 100,"cuotaInicial" DOUBLE PRECISION DEFAULT 10);
    CREATE TABLE "CreditApprovalReview" ("creditoId" INTEGER PRIMARY KEY,"status" TEXT DEFAULT 'PENDING',
      "revision" INTEGER DEFAULT 1,"approvedRevision" INTEGER,"reviewHashVersion" INTEGER DEFAULT 2,
      "approvedHashVersion" INTEGER,"updatedAt" TIMESTAMP(3) DEFAULT '2026-09-10');
    CREATE TABLE "LiquidacionAliadoCredito" ("creditoId" INTEGER PRIMARY KEY);
    CREATE TABLE "CreditSadminRegistration" ("creditoId" INTEGER PRIMARY KEY,"numeroCredito" TEXT,"numeroCreditoConfirmado" BOOLEAN);
    CREATE TABLE "CreditApprovalNovelty" ("id" UUID PRIMARY KEY,"creditoId" INTEGER,"status" TEXT,"version" INTEGER DEFAULT 1);
    CREATE UNIQUE INDEX novelty_one_active ON "CreditApprovalNovelty"("creditoId") WHERE "status"<>'RESOLVED';
    CREATE TABLE "CreditApprovalNoveltyItem" ("id" UUID PRIMARY KEY,"noveltyId" UUID,"status" TEXT,"version" INTEGER DEFAULT 1);
    CREATE TABLE "CreditApprovalReissue" ("id" UUID PRIMARY KEY,"creditoId" INTEGER,"status" TEXT,
      "requestedAt" TIMESTAMP(3) DEFAULT '2026-09-10');`);
  const calls = [];
  const db = { $queryRawUnsafe: async (sql, ...params) => {
    assert.match(sql.trim(), /^(SELECT|WITH)\b/);
    calls.push({ sql, params });
    return (await database.query(sql, params)).rows;
  } };
  const create = async (id, fields = {}, review = true) => {
    const values = { id, ...fields };
    await database.query(`INSERT INTO "Credito" (${Object.keys(values).map(key => `"${key}"`).join(",")})
      VALUES (${Object.keys(values).map((_, index) => `$${index + 1}`).join(",")})`, Object.values(values));
    if (review) await database.query('INSERT INTO "CreditApprovalReview" ("creditoId") VALUES ($1)', [id]);
  };
  const novelty = async (creditId, statuses, state = "WAITING_ALLY") => {
    const noveltyId = randomUUID();
    await database.query('INSERT INTO "CreditApprovalNovelty" ("id","creditoId","status") VALUES ($1,$2,$3)', [noveltyId, creditId, state]);
    const itemIds = [];
    for (const status of statuses) {
      const id = randomUUID();
      await database.query('INSERT INTO "CreditApprovalNoveltyItem" ("id","noveltyId","status") VALUES ($1,$2,$3)', [id, noveltyId, status]);
      itemIds.push(id);
    }
    return { id: noveltyId, itemIds };
  };
  const reissue = async (creditId, status) => database.query(
    'INSERT INTO "CreditApprovalReissue" ("id","creditoId","status") VALUES ($1,$2,$3)', [randomUUID(), creditId, status]);
  return { database, db, calls, create, novelty, reissue };
}

test("SQL real: conserva el alcance del muro y cuenta respuestas parciales sin alertar esperas del aliado o de firma", async t => {
  const f = await fixture(t);
  for (let id = 1; id <= 18; id += 1) await f.create(id);
  await f.novelty(2, ["OPEN"]);
  await f.novelty(3, ["RESPONDED"], "RESPONDED");
  await f.novelty(4, ["OPEN", "RESPONDED"]);
  await f.novelty(5, ["OPEN", "VERIFIED"]);
  await f.novelty(6, ["RESPONDED"], "RESOLVED");
  await f.novelty(7, []);
  for (const [id, status] of [[8, "PREPARING"], [9, "DISPATCHING"], [10, "AWAITING_SIGNATURE"], [11, "UNCERTAIN"],
    [12, "COMPLETED"], [13, "FAILED_SAFE"]]) await f.reissue(id, status);
  await f.database.exec(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"=1,"approvedHashVersion"=2 WHERE "creditoId"=14;
    UPDATE "CreditApprovalReview" SET "status"='APPROVED',"approvedRevision"=1,"revision"=2,"approvedHashVersion"=2 WHERE "creditoId"=15;
    INSERT INTO "LiquidacionAliadoCredito" VALUES (16);
    UPDATE "Credito" SET "estado"=' CANCELADA ' WHERE "id"=17;
    UPDATE "Credito" SET "estado"='anulado' WHERE "id"=18;`);
  await f.create(19, { equalityService: "IMPORTACION_MASIVA", contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" } } });
  await f.create(20, { createdAt: "2026-09-08T23:59:59.999Z" });
  await f.create(21, { sedeId: 20 });
  await f.create(22, {}, false);
  await f.create(23, { equalityService: "IMPORTACION_MASIVA" });

  const summary = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(summary.pendingCount, 16);
  assert.equal(summary.attentionCount, 10);
  assert.equal(summary.href, "/dashboard/aprobaciones");
  assert.match(summary.fingerprint, /^[a-f0-9]{32}$/);
  assert.equal(f.calls.length, 2, "Dos consultas globales; nunca lista ni sincroniza cada crédito.");
  const pending = await queue.listCreditApprovalQueue(f.db, { limit: 100 });
  assert.equal(summary.pendingCount, pending.items.length);
  assert.deepEqual(plain(pending.items.map(item => item.id)), [1,2,3,4,5,6,7,8,9,10,11,12,13,15,22,23]);
  assert.deepEqual(Object.keys(summary).sort(), ["attentionCount", "fingerprint", "href", "pendingCount"]);
  assert.doesNotMatch(f.calls[1].sql, /clienteNombre|clienteDocumento|responseText|audio|foto|INSERT|UPDATE|DELETE/i);
});

test("SQL real: el fingerprint detecta identidad y versiones con igual cantidad, y omite cambios que todavía esperan al aliado", async t => {
  const f = await fixture(t);
  await f.create(1);
  await f.create(2);
  await f.create(3);
  const waiting = await f.novelty(2, ["OPEN"]);
  const partial = await f.novelty(3, ["OPEN", "RESPONDED"]);
  const initial = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(initial.attentionCount, 2);
  assert.deepEqual(plain(await reader.getApprovalWelcomeAlerts(f.db)), plain(initial), "Orden y hora de lectura no afectan la huella.");

  await f.database.exec(`UPDATE "Credito" SET "clienteNombre"='Nombre corregido',"updatedAt"='2026-10-08';
    UPDATE "CreditApprovalReview" SET "updatedAt"='2026-10-08';`);
  await f.database.query('UPDATE "CreditApprovalNoveltyItem" SET "version"=2 WHERE "id"=$1', [partial.itemIds[0]]);
  assert.equal((await reader.getApprovalWelcomeAlerts(f.db)).fingerprint, initial.fingerprint);

  await f.database.query('UPDATE "CreditApprovalNoveltyItem" SET "version"=2 WHERE "id"=$1', [partial.itemIds[1]]);
  const responseChanged = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(responseChanged.attentionCount, initial.attentionCount);
  assert.notEqual(responseChanged.fingerprint, initial.fingerprint);

  await f.database.query('UPDATE "CreditApprovalReview" SET "revision"=2 WHERE "creditoId"=1');
  const revisionChanged = await reader.getApprovalWelcomeAlerts(f.db);
  assert.notEqual(revisionChanged.fingerprint, responseChanged.fingerprint);
  await f.database.exec('DELETE FROM "CreditApprovalReview" WHERE "creditoId"=1; DELETE FROM "Credito" WHERE "id"=1;');
  await f.create(4);
  const identityChanged = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(identityChanged.pendingCount, revisionChanged.pendingCount);
  assert.equal(identityChanged.attentionCount, revisionChanged.attentionCount);
  assert.notEqual(identityChanged.fingerprint, revisionChanged.fingerprint);

  await f.database.query('UPDATE "CreditApprovalNoveltyItem" SET "status"=\'RESPONDED\',"version"=2 WHERE "id"=$1', [waiting.itemIds[0]]);
  const allyResponded = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(allyResponded.attentionCount, 3);
  assert.notEqual(allyResponded.fingerprint, identityChanged.fingerprint);
  await f.reissue(4, "AWAITING_SIGNATURE");
  const blocked = await reader.getApprovalWelcomeAlerts(f.db);
  assert.equal(blocked.pendingCount, 3);
  assert.equal(blocked.attentionCount, 2);
  await f.database.exec('UPDATE "CreditApprovalReissue" SET "status"=\'COMPLETED\' WHERE "creditoId"=4;');
  assert.equal((await reader.getApprovalWelcomeAlerts(f.db)).fingerprint, allyResponded.fingerprint);
});

test("SQL real: ausencia de pendientes devuelve un resumen vacío y falta de política falla cerrada con 503", async t => {
  const f = await fixture(t);
  assert.deepEqual(plain(await reader.getApprovalWelcomeAlerts(f.db)), {
    pendingCount: 0, attentionCount: 0, fingerprint: emptyFingerprint, href: "/dashboard/aprobaciones",
  });
  f.calls.length = 0;
  await f.database.exec('DELETE FROM "CreditApprovalPolicy";');
  await assert.rejects(reader.getApprovalWelcomeAlerts(f.db), { code: "APPROVAL_UNAVAILABLE", status: 503 });
  assert.equal(f.calls.length, 1, "No consulta pendientes cuando la política falta.");
});

test("resultados incompletos o incoherentes no simulan una cola vacía", async () => {
  for (const result of [[], [{ pendingCount: 1, attentionCount: 2, fingerprint: emptyFingerprint }],
    [{ pendingCount: 1, attentionCount: -1, fingerprint: emptyFingerprint }],
    [{ pendingCount: "1", attentionCount: 1, fingerprint: emptyFingerprint }],
    [{ pendingCount: 1, attentionCount: 1, fingerprint: "invalid" }]]) {
    let reads = 0;
    await assert.rejects(reader.getApprovalWelcomeAlerts({ $queryRawUnsafe: async () => ++reads === 1 ? [{ id: 1 }] : result }),
      { code: "APPROVAL_UNAVAILABLE", status: 503 });
  }
});
