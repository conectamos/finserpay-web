import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import pg from "pg";
import { installCreditApprovalSchema } from "../scripts/credit-approval-schema.mjs";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("/lib/") && /^\.\/[\w-]+$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    return next(specifier, context);
  },
});
const { buildAllyPaymentEligibilityQuery } = await import("../lib/ally-payment-eligibility.ts");
const { buildCreditApprovalRequiredSql } = await import("../lib/credit-approval-policy.ts");
hooks.deregister();

const connectionString = process.env.CREDIT_APPROVAL_TEST_DATABASE_URL;
test("PostgreSQL aislado: activacion, revision, auditoria y concurrencia de liquidaciones", {
  skip: connectionString ? false : "Falta CREDIT_APPROVAL_TEST_DATABASE_URL; requiere base local approval_test.",
}, async (t) => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Solo PostgreSQL local aislado");
  assert.equal(url.pathname, "/approval_test", "Base exclusiva de fixtures");
  const db = new pg.Client({ connectionString });
  await db.connect();
  t.after(async () => { await db.end(); });
  const fixtureTables = ["CreditApprovalEvent", "CreditApprovalReview", "CreditApprovalPolicy",
    "FirmaSeguroProcess", "LiquidacionAliadoCredito", "Credito", "Usuario", "Sede", "Aliado"];
  const previous = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(previous.rows.every(({ tablename }) => fixtureTables.includes(tablename)),
    "La base contiene tablas ajenas: no se permite reiniciar fixtures");
  for (const table of fixtureTables) await db.query('DROP TABLE IF EXISTS public."' + table + '" CASCADE');
  await db.query(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1);
    CREATE TABLE "Aliado" ("id" INTEGER PRIMARY KEY, "codigo" TEXT, "nombre" TEXT,
      "redescuentoPorcentaje" FLOAT, "redescuentoAndroidPorcentaje" FLOAT, "redescuentoIphonePorcentaje" FLOAT);
    INSERT INTO "Aliado" VALUES (10, 'ALLY', 'Aliado sintetico',10,10,15), (20,'FINSERPAY','Central',0,0,0);
    CREATE TABLE "Sede" ("id" INTEGER PRIMARY KEY, "aliadoId" INTEGER);
    INSERT INTO "Sede" VALUES (10,10),(20,20);
    CREATE TABLE "Credito" (
      "id" SERIAL PRIMARY KEY, "folio" TEXT DEFAULT 'TEST', "clienteNombre" TEXT DEFAULT 'Cliente sintetico',
      "clienteDocumento" TEXT DEFAULT '1000000000', "fechaCredito" TIMESTAMP DEFAULT '2026-09-09T12:00:00',
      "createdAt" TIMESTAMP(3) DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),
      "updatedAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP, "estado" TEXT DEFAULT 'INSCRITO',
      "sedeId" INTEGER DEFAULT 10, "imei" TEXT DEFAULT '123456789012345', "deviceUid" TEXT DEFAULT 'device-test',
      "referenciaEquipo" TEXT DEFAULT 'Equipo test', "equipoMarca" TEXT DEFAULT 'Samsung', "equipoModelo" TEXT DEFAULT 'Test',
      "valorEquipoTotal" FLOAT DEFAULT 1000000, "cuotaInicial" FLOAT DEFAULT 200000,
      "saldoBaseFinanciado" FLOAT DEFAULT 800000, "montoCredito" FLOAT DEFAULT 800000,
      "equalityService" TEXT, "observacionAdmin" TEXT,
      "contratoSnapshot" JSONB DEFAULT '{"equipo":{"plataforma":"ANDROID"}}',
      "contratoCedulaFrenteDataUrl" TEXT DEFAULT 'front', "contratoCedulaRespaldoDataUrl" TEXT DEFAULT 'back',
      "iphoneSelfieCedulaDataUrl" TEXT DEFAULT 'selfie', "fotoEntregaDataUrl" TEXT DEFAULT 'delivery',
      "fotoRemisionDataUrl" TEXT DEFAULT 'remission'
    );
    CREATE TABLE "LiquidacionAliadoCredito" ("id" SERIAL PRIMARY KEY,
      "creditoId" INTEGER UNIQUE REFERENCES "Credito"("id"), "snapshot" TEXT DEFAULT 'frozen-payment');
  `);
  const createCredit = async (overrides = {}) => {
    const values = { createdAt: "2099-01-01T00:00:00Z", ...overrides };
    const keys = Object.keys(values);
    const result = await db.query(
      'INSERT INTO "Credito" (' + keys.map(k => '"' + k + '"').join(",") + ') VALUES (' +
      keys.map((_, i) => "$" + (i + 1)).join(",") + ') RETURNING "id"',
      Object.values(values));
    return result.rows[0].id;
  };
  const review = async (id) => (await db.query('SELECT * FROM "CreditApprovalReview" WHERE "creditoId"=$1', [id])).rows[0];
  const approve = async (id, client = db) => {
    await client.query(`UPDATE "CreditApprovalReview" SET "status"='APPROVED',
      "approvedRevision"="revision", "approvedByUserId"=1, "approvedByName"='Analista sintetico',
      "approvedAt"=CURRENT_TIMESTAMP, "reviewHash"=$2 WHERE "creditoId"=$1`, [id, "a".repeat(64)]);
    await client.query(`INSERT INTO "CreditApprovalEvent"
      ("creditoId","eventType","revision","actorUserId","actorName","reviewHash")
      SELECT "creditoId",'APPROVED',"revision",1,'Analista sintetico',"reviewHash"
      FROM "CreditApprovalReview" WHERE "creditoId"=$1`, [id]);
  };
  const eligible = async () => {
    const { query, values } = buildAllyPaymentEligibilityQuery({ allyId: 10 });
    return (await db.query(query, values)).rows;
  };
  const pay = (id, client = db) => client.query('INSERT INTO "LiquidacionAliadoCredito" ("creditoId") VALUES ($1)', [id]);
  const historic = await createCredit({ createdAt: "2020-01-01" });
  // Simulate Prisma-first timestamp defaults and a database in Colombia before
  // the first policy insert; exercise the installer statement unchanged.
  await installCreditApprovalSchema({ query: async (statement) => {
    if (statement.trim().startsWith('INSERT INTO public."CreditApprovalPolicy"')) {
      await db.query('ALTER TABLE "CreditApprovalPolicy" ALTER COLUMN "activatedAt" SET DEFAULT CURRENT_TIMESTAMP');
      await db.query("SET LOCAL TIME ZONE 'America/Bogota'");
    }
    return db.query(statement);
  } });
  const activatedAt = (await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt;
  {
    await t.test("instantes UTC explicitos con defaults Prisma y TimeZone America/Bogota", async () => {
      const policyTime = await db.query(`SELECT ABS(EXTRACT(EPOCH FROM (
        "activatedAt" - (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')))) < 5 AS utc
        FROM "CreditApprovalPolicy" WHERE "id"=1`);
      assert.equal(policyTime.rows[0].utc, true, 'Activacion UTC incluso con default local');
      await db.query('BEGIN');
      try {
        await db.query("SET LOCAL TIME ZONE 'America/Bogota'");
        await db.query('ALTER TABLE "CreditApprovalReview" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP');
        await db.query('ALTER TABLE "CreditApprovalEvent" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP');
        const id = await createCredit();
        const timestamps = await db.query(`SELECT
          "createdAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS created_utc,
          "updatedAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS updated_utc
          FROM "CreditApprovalReview" WHERE "creditoId"=$1`, [id]);
        assert.equal(timestamps.rows[0].created_utc, true);
        assert.equal(timestamps.rows[0].updated_utc, true);
        await db.query(`UPDATE "Credito" SET "fotoEntregaDataUrl"='timezone-change' WHERE "id"=$1`, [id]);
        const events = await db.query(`SELECT
          "createdAt" = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::timestamp(3) AS utc
          FROM "CreditApprovalEvent" WHERE "creditoId"=$1 AND "eventType"='INVALIDATED'`, [id]);
        assert.equal(events.rows[0].utc, true);
      } finally { await db.query('ROLLBACK'); }
    });
    await t.test("migracion aditiva repetible sin cambiar activacion ni historicos", async () => {
      await installCreditApprovalSchema(db);
      assert.equal((await db.query('SELECT "activatedAt"::text FROM "CreditApprovalPolicy"')).rows[0].activatedAt, activatedAt);
      assert.equal(await review(historic), undefined);
      assert.equal((await eligible()).some(row => row.id === historic), true);
    });
    await t.test("nuevo pendiente no entra; OK por credito entra; cedula compartida no hereda OK", async () => {
      const first = await createCredit();
      const second = await createCredit();
      assert.equal((await review(first)).status, "PENDING");
      assert.equal((await eligible()).some(row => [first, second].includes(row.id)), false);
      await assert.rejects(pay(first), /CREDIT_APPROVAL_REQUIRED/);
      await approve(first);
      const rows = await eligible();
      assert.equal(rows.some(row => row.id === first), true);
      assert.equal(rows.some(row => row.id === second), false);
      assert.equal(rows.find(row => row.id === first).approvalRevision, 1);
    });
    await t.test("historia importada queda exenta solo con ambos marcadores internos", async () => {
      const legacy = await createCredit({ equalityService: "IMPORTACION_MASIVA",
        contratoSnapshot: { origen: { tipo: "IMPORTACION_MASIVA" }, equipo: { plataforma: "ANDROID" } } });
      const forged = await createCredit({ observacionAdmin: "IMPORTACION_MASIVA" });
      assert.equal(await review(legacy), undefined);
      assert.equal((await review(forged)).status, "PENDING");
      assert.equal((await eligible()).some(row => row.id === legacy), true);
      const id = await createCredit();
      await db.query(`UPDATE "Credito" SET "createdAt"='2020-01-01',
        "equalityService"='IMPORTACION_MASIVA', "contratoSnapshot"='{"origen":{"tipo":"IMPORTACION_MASIVA"}}' WHERE "id"=$1`, [id]);
      assert.equal((await db.query('SELECT ' + buildCreditApprovalRequiredSql("credit") + ' AS required FROM "Credito" credit WHERE "id"=$1', [id])).rows[0].required, true);
      await assert.rejects(pay(id), /CREDIT_APPROVAL_REQUIRED/);
    });
    await t.test("cada foto, valor e identidad invalida el OK; metadatos y no-op no lo invalidan", async () => {
      const id = await createCredit();
      const fields = ["contratoCedulaFrenteDataUrl","contratoCedulaRespaldoDataUrl","iphoneSelfieCedulaDataUrl",
        "fotoEntregaDataUrl","fotoRemisionDataUrl","clienteNombre","clienteDocumento","equipoMarca","equipoModelo"];
      for (const field of fields) {
        await approve(id);
        const before = await review(id);
        await db.query('UPDATE "Credito" SET "' + field + '"=$2 WHERE "id"=$1', [id, field + "-changed"]);
        const after = await review(id);
        assert.equal(after.status, "PENDING", field);
        assert.equal(after.revision, before.revision + 1, field);
        assert.equal(after.reviewHash, null);
      }
      for (const field of ["valorEquipoTotal", "cuotaInicial", "saldoBaseFinanciado", "montoCredito"]) {
        await approve(id);
        await db.query('UPDATE "Credito" SET "' + field + '"="' + field + '"+1 WHERE "id"=$1', [id]);
        assert.equal((await review(id)).status, "PENDING", field);
      }
      await approve(id);
      const before = await review(id);
      await db.query('UPDATE "Credito" SET "updatedAt"=CURRENT_TIMESTAMP,"estado"=\'AL_DIA\',"fotoEntregaDataUrl"="fotoEntregaDataUrl" WHERE "id"=$1', [id]);
      assert.equal((await review(id)).revision, before.revision);
      assert.equal((await review(id)).status, "APPROVED");
      const event = (await db.query('SELECT * FROM "CreditApprovalEvent" WHERE "creditoId"=$1 AND "eventType"=\'INVALIDATED\' ORDER BY "revision" DESC LIMIT 1', [id])).rows[0];
      assert.equal(event.reviewHash, "a".repeat(64));
    });
    await t.test("FirmaSeguro puede instalarse despues y cambio PDF/vinculo invalida atomicamente", async () => {
      await db.query(`CREATE TABLE "FirmaSeguroProcess" ("id" SERIAL PRIMARY KEY, "creditoId" INTEGER,
        "processUuid" TEXT, "status" TEXT, "signedDocumentBase64" TEXT, "signedDocumentFileName" TEXT,
        "supersededAt" TIMESTAMPTZ, "completedAt" TIMESTAMP, "updatedAt" TIMESTAMP)`);
      const runtimeSource = await readFile(new URL('../lib/firmaseguro-storage.ts', import.meta.url), 'utf8');
      const runtimeInstaller = runtimeSource.match(/`(DO \$\$ BEGIN[\s\S]*?install_credit_approval_firmaseguro_trigger[\s\S]*?END \$\$)`/);
      assert.ok(runtimeInstaller, 'Instalacion runtime conserva delimitadores PL/pgSQL');
      await db.query(runtimeInstaller[1]);
      const id = await createCredit();
      await db.query('INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","signedDocumentBase64") VALUES ($1,\'p1\',\'COMPLETED\',\'pdf-one\')', [id]);
      await approve(id);
      const before = await review(id);
      await db.query('UPDATE "FirmaSeguroProcess" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "creditoId"=$1', [id]);
      assert.equal((await review(id)).revision, before.revision);
      await db.query('UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=\'pdf-two\' WHERE "creditoId"=$1', [id]);
      assert.equal((await review(id)).status, "PENDING");
      assert.equal((await review(id)).revision, before.revision + 1);
      await assert.rejects(pay(id), /CREDIT_APPROVAL_REQUIRED/);
      await approve(id);
      await db.query('DELETE FROM "FirmaSeguroProcess" WHERE "creditoId"=$1', [id]);
      assert.equal((await review(id)).status, "PENDING");
    });
    await t.test("liquidaciones pagadas, su aprobacion y auditoria permanecen congeladas", async () => {
      const id = await createCredit();
      await approve(id);
      await pay(id);
      const before = await review(id);
      await db.query('UPDATE "Credito" SET "fotoEntregaDataUrl"=\'new-after-payment\' WHERE "id"=$1', [id]);
      assert.deepEqual(await review(id), before);
      assert.equal((await db.query('SELECT "snapshot" FROM "LiquidacionAliadoCredito" WHERE "creditoId"=$1', [id])).rows[0].snapshot, "frozen-payment");
      assert.equal((await eligible()).some(row => row.id === id), false);
      await assert.rejects(pay(id), { code: "23505" });
      await assert.rejects(db.query('UPDATE "CreditApprovalPolicy" SET "activatedAt"=CURRENT_TIMESTAMP'), /HISTORY_IMMUTABLE/);
      await assert.rejects(db.query('DELETE FROM "CreditApprovalEvent" WHERE "creditoId"=$1', [id]), /HISTORY_IMMUTABLE/);
    });
    await t.test("Serializable rechaza snapshot aprobado si documento cambio concurrentemente", async () => {
      const id = await createCredit();
      await db.query('INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","signedDocumentBase64") VALUES ($1,\'race\',\'COMPLETED\',\'old\')', [id]);
      await approve(id);
      const stale = new pg.Client({ connectionString });
      await stale.connect();
      try {
        await stale.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await stale.query('SELECT "status" FROM "CreditApprovalReview" WHERE "creditoId"=$1', [id]);
        await db.query('UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=\'new\' WHERE "creditoId"=$1', [id]);
        await assert.rejects(pay(id, stale), { code: "40001" });
        await stale.query("ROLLBACK");
        assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "LiquidacionAliadoCredito" WHERE "creditoId"=$1', [id])).rows[0].n, 0);
      } finally { await stale.end(); }
    });
    await t.test("pago con lock de credito termina antes de correccion en espera, sin duplicar ni borrar aprobacion", async () => {
      const id = await createCredit();
      await db.query('INSERT INTO "FirmaSeguroProcess" ("creditoId","processUuid","status","signedDocumentBase64") VALUES ($1,\'race-paid\',\'COMPLETED\',\'old\')', [id]);
      await approve(id);
      const paying = new pg.Client({ connectionString });
      const changing = new pg.Client({ connectionString });
      await Promise.all([paying.connect(), changing.connect()]);
      try {
        await paying.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await paying.query('SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE', [id]);
        let finished = false;
        const change = changing.query('UPDATE "FirmaSeguroProcess" SET "signedDocumentBase64"=\'new-after-paid\' WHERE "creditoId"=$1', [id]).then(() => { finished = true; });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(finished, false, "La correccion espera el lock del credito");
        await pay(id, paying);
        await paying.query("COMMIT");
        await change;
        assert.equal((await review(id)).status, "APPROVED");
        assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM "LiquidacionAliadoCredito" WHERE "creditoId"=$1', [id])).rows[0].n, 1);
      } finally { await Promise.all([paying.end(), changing.end()]); }
    });
    await t.test("reasignar aliado de una sede invalida solo revisiones de creditos no pagados", async () => {
      const pending = await createCredit();
      const paid = await createCredit();
      await approve(pending);
      await approve(paid);
      await pay(paid);
      const pendingBefore = await review(pending);
      const paidBefore = await review(paid);
      try {
        await db.query('UPDATE "Sede" SET "aliadoId"=20 WHERE "id"=10');
        assert.equal((await review(pending)).status, "PENDING");
        assert.equal((await review(pending)).revision, pendingBefore.revision + 1);
        assert.deepEqual(await review(paid), paidBefore);
        await assert.rejects(pay(pending), /CREDIT_APPROVAL_REQUIRED/);
        assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM "CreditApprovalEvent"
          WHERE "creditoId"=$1 AND "reason"='CREDIT_ALLY_CHANGED'`, [pending])).rows[0].n, 1);
      } finally { await db.query('UPDATE "Sede" SET "aliadoId"=10 WHERE "id"=10'); }
    });
    await t.test("trigger de auditoria funciona con UUID generado por Prisma sin default SQL", async () => {
      const id = await createCredit();
      await approve(id);
      await db.query('ALTER TABLE "CreditApprovalEvent" ALTER COLUMN "id" DROP DEFAULT');
      try {
        await db.query(`UPDATE "Credito" SET "fotoEntregaDataUrl"='changed-without-default' WHERE "id"=$1`, [id]);
        assert.equal((await review(id)).status, "PENDING");
        assert.ok((await db.query(`SELECT "id" FROM "CreditApprovalEvent"
          WHERE "creditoId"=$1 AND "eventType"='INVALIDATED'`, [id])).rows[0].id);
      } finally {
        await db.query('ALTER TABLE "CreditApprovalEvent" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()');
      }
    });
    await t.test("policy ausente falla cerrada en consulta y escritura", async () => {
      await db.query('ALTER TABLE "CreditApprovalPolicy" DISABLE TRIGGER "CreditApprovalPolicy_immutable"');
      await db.query('DELETE FROM "CreditApprovalPolicy"');
      assert.deepEqual(await eligible(), []);
      await assert.rejects(pay(historic), /CREDIT_APPROVAL_POLICY_MISSING/);
      await db.query('INSERT INTO "CreditApprovalPolicy" ("id","activatedAt") VALUES (1,$1)', [activatedAt]);
      await db.query('ALTER TABLE "CreditApprovalPolicy" ENABLE TRIGGER "CreditApprovalPolicy_immutable"');
    });
  }
});
