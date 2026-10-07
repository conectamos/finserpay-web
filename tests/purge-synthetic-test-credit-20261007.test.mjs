import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { creditApprovalSchemaStatements } from '../scripts/credit-approval-schema.mjs';
import { installCreditSadminSchema } from '../scripts/credit-sadmin-schema.mjs';
import { PURGE_BOTH_CONFIRMATION, purgeBothWithClient, purgeWithClient } from
  '../scripts/purge-synthetic-test-credit-20261007.mjs';

const CONFIRMATION = 'PURGE FC-20261007042755-TQLK';

async function fixture(state = 'GENERADO') {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Usuario" ("id" INTEGER PRIMARY KEY);
    INSERT INTO "Usuario" VALUES (1);
    CREATE TABLE "Credito" (
      "id" INTEGER PRIMARY KEY,
      "folio" TEXT NOT NULL UNIQUE,
      "clienteNombre" TEXT NOT NULL,
      "clienteDocumento" TEXT,
      "imei" TEXT,
      "valorEquipoTotal" NUMERIC NOT NULL,
      "montoCredito" NUMERIC NOT NULL,
      "cuotaInicial" NUMERIC NOT NULL,
      "estado" TEXT NOT NULL,
      "deliverableReady" BOOLEAN NOT NULL DEFAULT FALSE,
      "contratoAceptadoAt" TIMESTAMP,
      "pagareAceptadoAt" TIMESTAMP,
      "pazYSalvoEmitidoAt" TIMESTAMP,
      "planCapitalVigente" NUMERIC,
      "contratoFirmaDataUrl" TEXT,
      "contratoFotoDataUrl" TEXT,
      "fotoEntregaDataUrl" TEXT,
      "fotoRemisionDataUrl" TEXT,
      "contratoOtpVerificadoAt" TIMESTAMP,
      "contratoSnapshot" JSONB,
      "fechaCredito" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE "CreditApprovalSharedSession" (
      "id" UUID PRIMARY KEY,
      "grantId" UUID NOT NULL,
      UNIQUE ("id", "grantId")
    );
  `);
  await db.query('INSERT INTO "Credito" ("id","folio","clienteNombre","valorEquipoTotal","montoCredito","cuotaInicial","estado","clienteDocumento","imei") VALUES (1,$1,$2,5000,5000,0,$3,\'1000000001\',\'123456789012345\')',
    ['FC-20261007042755-TQLK', 'PRUEBA DAPTA', state]);
  await db.query('INSERT INTO "Credito" ("id","folio","clienteNombre","valorEquipoTotal","montoCredito","cuotaInicial","estado","clienteDocumento","imei") VALUES (2,$1,$2,5000,5000,0,$3,\'1000000002\',\'123456789012346\')',
    ['FC-OTHER-CREDIT', 'PRUEBA DAPTA', state]);
  const immutable = creditApprovalSchemaStatements.find(statement =>
    statement.includes('CREATE OR REPLACE FUNCTION public.credit_approval_reject_history_mutation()'));
  assert.ok(immutable);
  await db.query(immutable);
  await installCreditSadminSchema(db);
  for (const id of [1, 2]) {
    await db.query('INSERT INTO "CreditSadminRegistration" ("creditoId","numeroCredito") VALUES ($1,$2)',
      [id, id === 1 ? '1234567891' : 'OTHER-NUMBER']);
    await db.query(`INSERT INTO "CreditSadminEvent"
      ("id","creditoId","version","actorKind","actorUserId","actorName","payload")
      VALUES ($1,$2,1,'USER',1,'Analista QA','{}'::jsonb)`, [randomUUID(), id]);
  }
  return {
    query: async (...args) => {
      const result = await db.query(...args);
      return { ...result, rowCount: result.rowCount ?? result.affectedRows };
    },
    exec: (...args) => db.exec(...args),
    close: () => db.close(),
  };
}

const count = async (db, table, id) => Number((await db.query(
  `SELECT count(*)::int AS count FROM "${table}" WHERE ${table === 'Credito' ? '"id"' : '"creditoId"'}=$1`, [id])).rows[0].count);

async function assertImmutable(db) {
  await assert.rejects(db.query('DELETE FROM "CreditSadminEvent" WHERE "creditoId"=2'),
    /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
}

async function addClosedDrafts(db) {
  await db.exec(`
    CREATE TABLE "CreditoBorrador" (
      "id" INTEGER PRIMARY KEY,
      "creditoId" INTEGER,
      "estado" TEXT NOT NULL,
      "closedReason" TEXT,
      "clienteNombre" TEXT,
      "clienteDocumento" TEXT,
      "imei" TEXT,
      "dataCreditoAssessmentId" UUID,
      "payload" JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    INSERT INTO "CreditoBorrador" VALUES
      (11,1,'CERRADO','FINALIZADA','PRUEBA DAPTA','1000000001','123456789012345',NULL),
      (12,2,'CERRADO','FINALIZADA','PRUEBA DAPTA','1000000002','123456789012346',NULL);
  `);
}

async function addSecondTarget(db) {
  await db.query(`INSERT INTO "Credito"
    ("id","folio","clienteNombre","valorEquipoTotal","montoCredito","cuotaInicial",
      "estado","clienteDocumento","imei")
    VALUES (3,'FC-20261007051500-NMIK','PRUEBA DOS DAPTA',150000,150000,0,
      'GENERADO','1000000003','123456789012347')`);
  await db.query(`INSERT INTO "CreditSadminRegistration" ("creditoId","numeroCredito")
    VALUES (3,'1111111238')`);
  await db.query(`INSERT INTO "CreditSadminEvent"
    ("id","creditoId","version","actorKind","actorUserId","actorName","payload")
    VALUES ($1,3,1,'USER',1,'Analista QA','{}'::jsonb)`, [randomUUID()]);
}

async function addGeneratedApprovalAndCommission(db) {
  await db.exec(`
    CREATE TABLE "CreditApprovalReview" (
      "creditoId" INTEGER PRIMARY KEY REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "status" TEXT NOT NULL DEFAULT 'PENDING',
      "approvedRevision" INTEGER,
      "approvedAt" TIMESTAMP,
      "approvedByUserId" INTEGER,
      "callRecordingId" UUID
    );
    CREATE TABLE "CreditApprovalEvent" (
      "id" UUID PRIMARY KEY,
      "creditoId" INTEGER REFERENCES "CreditApprovalReview"("creditoId") ON DELETE RESTRICT,
      "eventType" TEXT NOT NULL
    );
    CREATE TRIGGER "CreditApprovalEvent_immutable"
      BEFORE UPDATE OR DELETE ON "CreditApprovalEvent"
      FOR EACH ROW EXECUTE FUNCTION public.credit_approval_reject_history_mutation();
    CREATE TABLE "CommissionCreditSource" (
      "creditId" INTEGER PRIMARY KEY REFERENCES "Credito"("id") ON DELETE RESTRICT,
      "isTest" BOOLEAN NOT NULL,
      "eligible" BOOLEAN NOT NULL,
      "finalizedAt" TIMESTAMPTZ
    );
    CREATE TABLE "CommissionAudit" (
      "id" INTEGER PRIMARY KEY,
      "action" TEXT NOT NULL,
      "payload" JSONB NOT NULL
    );
    CREATE FUNCTION public.finser_commission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Commission audit and payments are immutable'; END $$;
    CREATE TRIGGER finser_commission_audit_immutable BEFORE UPDATE OR DELETE ON "CommissionAudit"
      FOR EACH ROW EXECUTE FUNCTION public.finser_commission_immutable();
    INSERT INTO "CreditApprovalReview" ("creditoId") VALUES (1),(2);
    INSERT INTO "CommissionCreditSource" VALUES (1,TRUE,FALSE,NULL),(2,TRUE,FALSE,NULL);
    INSERT INTO "CommissionAudit" VALUES
      (1,'CREDIT_CHANGED','{"current":{"id":1}}'::jsonb),
      (2,'CREDIT_CHANGED','{"current":{"id":2}}'::jsonb);
  `);
  await db.query('INSERT INTO "CreditApprovalEvent" VALUES ($1,1,$2)', [randomUUID(), 'INVALIDATED']);
  await db.query('INSERT INTO "CreditApprovalEvent" VALUES ($1,2,$2)', [randomUUID(), 'INVALIDATED']);
}

test('purga física solo el crédito sintético exacto; restaura el bloqueo de auditoría', async t => {
  const db = await fixture('ANULADO');
  t.after(() => db.close());
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.ok(result);
  for (const table of ['Credito', 'CreditSadminRegistration', 'CreditSadminEvent']) {
    assert.equal(await count(db, table, 1), 0, `${table}: crédito sintético borrado`);
    assert.equal(await count(db, table, 2), 1, `${table}: crédito ajeno conservado`);
  }
  await assertImmutable(db);
});

test('si falla el DELETE del crédito, la transacción restaura hijos y trigger', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await db.exec(`
    CREATE FUNCTION public.reject_test_credit_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD.id=1 THEN RAISE EXCEPTION 'forced-test-delete-failure'; END IF;
      RETURN OLD; END $$;
    CREATE TRIGGER "Credito_test_reject" BEFORE DELETE ON "Credito"
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_credit_delete();
  `);
  await assert.rejects(purgeWithClient(db, { execute: true, confirmation: CONFIRMATION }),
    /forced-test-delete-failure/);
  for (const table of ['Credito', 'CreditSadminRegistration', 'CreditSadminEvent']) {
    assert.equal(await count(db, table, 1), 1, `${table}: transacción revertida`);
    assert.equal(await count(db, table, 2), 1, `${table}: crédito ajeno intacto`);
  }
  await assertImmutable(db);
});




test('una referencia nueva y cualquier otro estado bloquean la purga sin alterar datos', async t => {
  const db = await fixture('GENERADO');
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "UnexpectedCreditLink" (
      "id" INTEGER PRIMARY KEY,
      "creditoId" INTEGER NOT NULL REFERENCES "Credito"("id") ON DELETE RESTRICT
    );
    INSERT INTO "UnexpectedCreditLink" VALUES (1,1);
  `);
  const linked = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(linked.deleted, false);
  assert.ok(linked.blockers.some(blocker => blocker.includes('UnexpectedCreditLink')));
  assert.equal(await count(db, 'Credito', 1), 1);
  assert.equal(await count(db, 'CreditSadminEvent', 1), 1);
  await db.query('DELETE FROM "UnexpectedCreditLink" WHERE "id"=1');
  await db.query('UPDATE "Credito" SET "estado"=$1 WHERE "id"=1', ['ACTIVO']);
  const active = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(active.deleted, false);
  assert.ok(active.blockers.includes('CREDIT_IDENTITY_MISMATCH'));
  assert.equal(await count(db, 'Credito', 1), 1);
  await db.query('UPDATE "Credito" SET "estado"=$1,"clienteNombre"=$2 WHERE "id"=1',
    ['GENERADO', 'OTRO CLIENTE']);
  const wrongIdentity = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(wrongIdentity.deleted, false);
  assert.ok(wrongIdentity.blockers.includes('CREDIT_IDENTITY_MISMATCH'));
  assert.equal(await count(db, 'Credito', 1), 1);
  await assertImmutable(db);
});

test('el modo de lectura y una confirmación incorrecta jamás eliminan el crédito', async t => {
  const db = await fixture();
  t.after(() => db.close());
  const preview = await purgeWithClient(db);
  assert.equal(preview.deleted, false);
  assert.equal(preview.eligible, true);
  assert.equal(await count(db, 'Credito', 1), 1);
  await assert.rejects(purgeWithClient(db, { execute: true, confirmation: 'PURGE OTHER' }),
    /CONFIRMATION_REQUIRED/);
  assert.equal(await count(db, 'Credito', 1), 1);
  await assertImmutable(db);
});

test('un identificador de proceso de firma dentro del contrato bloquea el borrado', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await db.query(`UPDATE "Credito" SET "contratoSnapshot"=$1::jsonb WHERE id=1`,
    [JSON.stringify({ firma: { procesoUuid: randomUUID() } })]);
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(result.deleted, false);
  assert.ok(result.blockers.includes('FIRMASEGURO_PROVIDER_REFERENCE_EXISTS'));
  assert.equal(await count(db, 'Credito', 1), 1);
  await assertImmutable(db);
});

test('borra solo la solicitud finalizada enlazada al crédito sintético', async t => {
  const db = await fixture('ANULADO');
  t.after(() => db.close());
  await addClosedDrafts(db);
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(result.deleted, true);
  assert.equal(result.deletedRows.CreditoBorrador, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "CreditoBorrador" WHERE id=11')).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "CreditoBorrador" WHERE id=12')).rows[0].count, 1);
  assert.equal(await count(db, 'Credito', 2), 1);
  await assertImmutable(db);
});

test('un proceso FirmaSeguro vinculado al borrador bloquea el borrado completo', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await addClosedDrafts(db);
  await db.exec(`
    CREATE TABLE "FirmaSeguroProcess" (
      "id" INTEGER PRIMARY KEY,
      "draftId" INTEGER REFERENCES "CreditoBorrador"("id") ON DELETE RESTRICT,
      "creditoId" INTEGER,
      "completedAt" TIMESTAMP,
      "signedDocumentBase64" TEXT
    );
    INSERT INTO "FirmaSeguroProcess" ("id","draftId") VALUES (21,11);
  `);
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(result.deleted, false);
  assert.ok(result.blockers.some(blocker => blocker.includes('DRAFT_LINKED_RECORD:public.FirmaSeguroProcess')),
    JSON.stringify(result.blockers));
  assert.equal(await count(db, 'Credito', 1), 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "CreditoBorrador" WHERE id=11')).rows[0].count, 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "FirmaSeguroProcess" WHERE id=21')).rows[0].count, 1);
  await assertImmutable(db);
});

test('una evaluación Datacrédito legada en el payload del borrador bloquea el borrado', async t => {
  const db = await fixture();
  t.after(() => db.close());
  await addClosedDrafts(db);
  await db.query(`UPDATE "CreditoBorrador" SET payload=$1::jsonb WHERE id=11`,
    [JSON.stringify({ dataCreditoAssessmentId: randomUUID() })]);
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(result.deleted, false);
  assert.ok(result.blockers.includes('DRAFT_IDENTITY_OR_EXTERNAL_ASSESSMENT'));
  assert.equal(await count(db, 'Credito', 1), 1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM "CreditoBorrador" WHERE id=11')).rows[0].count, 1);
  await assertImmutable(db);
});

test('la lista cerrada permite borrar ambos créditos de prueba y deja intacto uno vecino', async t => {
  const db = await fixture('ANULADO');
  t.after(() => db.close());
  await addSecondTarget(db);
  await assert.rejects(purgeWithClient(db, { execute: true,
    folio: 'FC-OTHER-CREDIT', confirmation: 'PURGE FC-OTHER-CREDIT' }), /TARGET_NOT_ALLOWED/);
  await assert.rejects(purgeWithClient(db, { execute: true,
    folio: 'FC-20261007051500-NMIK', confirmation: CONFIRMATION }), /CONFIRMATION_REQUIRED/);
  const second = await purgeWithClient(db, { execute: true,
    folio: 'FC-20261007051500-NMIK', confirmation: 'PURGE FC-20261007051500-NMIK' });
  assert.equal(second.deleted, true);
  assert.equal(await count(db, 'Credito', 3), 0);
  assert.equal(await count(db, 'Credito', 1), 1);
  assert.equal(await count(db, 'Credito', 2), 1);
  const first = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(first.deleted, true);
  assert.equal(await count(db, 'Credito', 1), 0);
  assert.equal(await count(db, 'Credito', 2), 1);
  assert.equal(await count(db, 'CreditSadminEvent', 2), 1);
  await assertImmutable(db);
});

test('la purga de ambos es atómica y repetirla no afecta ningún otro crédito', async t => {
  const db = await fixture('ANULADO');
  t.after(() => db.close());
  await addSecondTarget(db);
  await db.query('UPDATE "Credito" SET "montoCredito"=149999 WHERE id=3');
  const blocked = await purgeBothWithClient(db, { execute: true,
    confirmation: PURGE_BOTH_CONFIRMATION });
  assert.equal(blocked.deleted, false);
  assert.equal(blocked.eligible, false);
  assert.equal(await count(db, 'Credito', 1), 1, 'no borra el primer objetivo antes de revisar el segundo');
  assert.equal(await count(db, 'Credito', 3), 1);
  await db.query('UPDATE "Credito" SET "montoCredito"=150000 WHERE id=3');
  const removed = await purgeBothWithClient(db, { execute: true,
    confirmation: PURGE_BOTH_CONFIRMATION });
  assert.equal(removed.deleted, true);
  assert.equal(await count(db, 'Credito', 1), 0);
  assert.equal(await count(db, 'Credito', 3), 0);
  assert.equal(await count(db, 'Credito', 2), 1);
  const repeated = await purgeBothWithClient(db, { execute: true,
    confirmation: PURGE_BOTH_CONFIRMATION });
  assert.equal(repeated.deleted, false);
  assert.equal(repeated.eligible, true);
  assert.ok(repeated.targets.every(target => target.alreadyAbsent));
  assert.equal(await count(db, 'Credito', 2), 1);
  await assertImmutable(db);
});

test('elimina solo las filas generadas de aprobación y comisión y restaura sus triggers', async t => {
  const db = await fixture('ANULADO');
  t.after(() => db.close());
  await addGeneratedApprovalAndCommission(db);
  const result = await purgeWithClient(db, { execute: true, confirmation: CONFIRMATION });
  assert.equal(result.deleted, true);
  for (const [table, column] of [
    ['CreditApprovalReview', 'creditoId'], ['CreditApprovalEvent', 'creditoId'],
    ['CommissionCreditSource', 'creditId'],
  ]) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM "${table}" WHERE "${column}"=1`)).rows[0].count, 0);
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM "${table}" WHERE "${column}"=2`)).rows[0].count, 1);
  }
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM "CommissionAudit"
    WHERE payload#>>'{current,id}'='1'`)).rows[0].count, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS count FROM "CommissionAudit"
    WHERE payload#>>'{current,id}'='2'`)).rows[0].count, 1);
  await assert.rejects(db.query('DELETE FROM "CreditApprovalEvent" WHERE "creditoId"=2'),
    /CREDIT_APPROVAL_HISTORY_IMMUTABLE/);
  await assert.rejects(db.query(`DELETE FROM "CommissionAudit" WHERE id=2`),
    /Commission audit and payments are immutable/);
  await assertImmutable(db);
});

