import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installDianaExtensionRequestSchema, dianaExtensionRequestSchemaCheckSql } from "../scripts/diana-extension-request-schema.mjs";
import { installDianaExtensionSchema } from "../scripts/diana-extension-schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createDianaExtensionRequestStore } = await jiti.import("../lib/diana-extension-request-storage.ts");
const scope = { workspaceId: "7496b9a3-2fe6-4e28-8411-7d54ee788b2c", agentId: "6f9560ec-dcfd-4725-bf61-27cd8d528a1c", agentChannelId: "6933b28b-b0a1-400c-aa1e-54f75bfbbd91", phoneNumberId: "1162059967000416", wabaId: "2148284059050848" };
const initial = "2026-11-01T17:00:00.000Z", activatedAt = "2026-11-01T16:00:00Z", phone = "+573001234567";
const wrap = (db, hook) => ({ $queryRawUnsafe: async (sql, ...params) => { await hook?.(sql, params, db); return (await db.query(sql, params)).rows; }, $transaction: fn => db.transaction(tx => fn(wrap(tx, hook))) });
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa boolean);
    CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,activo boolean,"sedeId" int,"rolId" int);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY);
    CREATE TABLE "Credito"(id int PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,"clienteTipoDocumento" text DEFAULT 'CC',"clienteTelefono" text,
      estado text DEFAULT 'ACTIVO',"montoCredito" float DEFAULT 400,"valorCuota" float DEFAULT 100,"plazoMeses" int DEFAULT 4,"frecuenciaPago" text DEFAULT 'QUINCENAL',
      "fechaPrimerPago" timestamp DEFAULT '2026-11-02 12:00:00',"fechaProximoPago" timestamp,"pazYSalvoEmitidoAt" timestamp,"planCapitalVigente" jsonb);
    CREATE TABLE "CreditoAbono"(id int PRIMARY KEY,"creditoId" int,valor float,"fechaAbono" timestamp,"createdAt" timestamp DEFAULT '2026-11-01 13:00:00',
      estado text DEFAULT 'ACTIVO',"anuladoAt" timestamp);
    INSERT INTO "Rol" VALUES(1,'ADMIN'); INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);
    INSERT INTO "Sede" VALUES(10,'Central',1,true); INSERT INTO "Usuario" VALUES(1,'Administrador real',true,10,1);
    INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(77,'FC-77','Cliente sintético','100000077','3001234567');`);
  await db.exec(readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8"));
  await installDianaExtensionRequestSchema({ query: (sql, params = []) => db.query(sql, params) });
  const id = randomUUID(), externalId = randomUUID();
  await db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name) VALUES($1,$2,'whatsapp',$3,'Cliente sintético')`, [id, externalId, phone]);
  await db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`, [randomUUID(), id, scope.phoneNumberId, scope.wabaId, phone.slice(1)]);
  let clock = new Date(initial);
  const options = { scope, enabled: true, activatedAt, now: () => clock }, store = createDianaExtensionRequestStore(wrap(db), options);
  const proof = (intent = { kind: "days", days: 4 }, patch = {}) => ({ scope, conversationId: id, externalConversationId: externalId,
    contactId: phone.slice(1), phone, messageId: randomUUID(), messageAt: "2026-11-01T16:59:59.000Z", observedAt: clock.toISOString(),
    latest: true, deliveryId: randomUUID(), textDigest: "a".repeat(64), intent, ...patch });
  return { db, store, id, externalId, proof, storeWithHook: hook => createDianaExtensionRequestStore(wrap(db, hook), options), setNow: value => { clock = new Date(value); } };
}
async function count(db, table) { return (await db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n; }
const statusInput = { cedula: "100000077", folio: "FC-77" };

test("one native 1–4 day request commits actual CRM protection and history without a fabricated payment promise", async t => {
  for (const days of [1, 2, 3, 4]) {
    const f = await fixture(t), before = (await f.db.query('SELECT * FROM "Credito"')).rows, proof = f.proof({ kind: "days", days });
    const result = await f.store.consumeVerifiedRequest(proof); assert.equal(result.outcome, "granted");
    const request = (await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows[0];
    assert.equal(request.source, "SYSTEM_DIANA_REQUEST"); assert.equal(request.type, "PRORROGA"); assert.equal(request.status, "APPROVED");
    for (const key of ["promiseAmount", "promiseDate", "createdByUserId", "decidedByUserId"]) assert.equal(request[key], null);
    for (const key of ["createdBySystemKey", "decidedBySystemKey"]) assert.equal(request[key], "SYSTEM_DIANA");
    const expiry = `2026-11-0${2 + days}`;
    assert.equal(request.installmentNumber, 1); assert.equal(request.expiresOn.toISOString().slice(0, 10), expiry);
    const management = (await f.db.query('SELECT * FROM "CreditMoraManagementEvent"')).rows[0];
    assert.equal(management.resultCode, "PRORROGA_APROBADA"); assert.equal(management.managementStatus, "SEGUIMIENTO");
    for (const key of ["agreementDate", "agreementAmount", "actorUserId", "responsibleUserId"]) assert.equal(management[key], null);
    assert.equal(management.actorSystemKey, "SYSTEM_DIANA"); assert.equal(management.responsibleSystemKey, "SYSTEM_DIANA");
    assert.equal(management.nextFollowUpAt.toISOString(), `2026-11-0${3 + days}T13:00:00.000Z`);
    const ledger = (await f.db.query('SELECT * FROM "DianaExtensionRequest"')).rows[0];
    assert.equal(ledger.messageId, proof.messageId); assert.equal(ledger.extensionId, result.extensionId); assert.equal(ledger.outcome, "GRANTED");
    const view = await f.store.status(statusInput);
    assert.equal(view.approved, true); assert.equal(view.status, "GRANTED"); assert.equal(view.days, days); assert.equal(view.expiresOn, expiry);
    for (const key of ["phone", "cedula", "messageId", "creditId", "extensionId", "managementId"]) assert.equal(Object.hasOwn(view, key), false);
    assert.deepEqual((await f.db.query('SELECT * FROM "Credito"')).rows, before, "contractual dates and loan amounts stay intact");
  }
});

test("native request retries serialize into a single immutable grant; changing terms under the same native UUID never grants twice", async t => {
  const f = await fixture(t), proof = f.proof();
  const results = await Promise.all([f.store.consumeVerifiedRequest(proof), f.store.consumeVerifiedRequest({ ...proof, deliveryId: randomUUID() })]);
  assert.deepEqual(results.map(value => value.outcome).sort(), ["already_granted", "granted"]);
  assert.equal((await f.store.consumeVerifiedRequest({ ...proof, intent: { kind: "days", days: 1 } })).outcome, "ignored");
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 1); assert.equal(await count(f.db, "CreditMoraManagementEvent"), 1); assert.equal(await count(f.db, "DianaExtensionRequest"), 1);
  for (const statement of ['UPDATE "DianaExtensionRequest" SET days=1', 'DELETE FROM "DianaExtensionRequest"', 'TRUNCATE "DianaExtensionRequest"']) await assert.rejects(f.db.exec(statement));
});

test("failed management or final chat audit rolls back every financial write and keeps the real request retryable", async t => {
  for (const table of ["CreditMoraManagementEvent", "AttentionAudit"]) {
    const f = await fixture(t), proof = f.proof();
    await f.db.exec(`CREATE FUNCTION fail_direct_test() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'offline failure'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_direct_test BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_direct_test()`);
    await assert.rejects(f.store.consumeVerifiedRequest(proof));
    for (const name of ["CreditMoraExceptionRequest", "CreditMoraManagementEvent", "CreditMoraExceptionEvent", "DianaExtensionRequest"]) assert.equal(await count(f.db, name), 0);
    await f.db.exec(`DROP TRIGGER fail_direct_test ON "${table}"`);
    assert.equal((await f.store.consumeVerifiedRequest(proof)).outcome, "granted");
  }
});

test("different identities sharing a phone stay blocked even with a manually linked chat or a native folio", async t => {
  const f = await fixture(t);
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteDocumento","clienteTelefono") VALUES(78,'FC-78','100000078','3001234567')`);
  await f.db.query('UPDATE "AttentionConversation" SET "linkedCreditId"=77 WHERE id=$1', [f.id]);
  for (const intent of [{ kind: "days", days: 2 }, { kind: "days", days: 2, folio: "FC-77" }])
    assert.equal((await f.store.consumeVerifiedRequest(f.proof(intent))).outcome, "rejected");
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
});

test("several active credits require the folio in the actual native request; model status hints cannot select a credit", async t => {
  const f = await fixture(t);
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteDocumento","clienteTelefono") VALUES(78,'FC-78','100000077','3001234567')`);
  await f.db.query('UPDATE "AttentionConversation" SET "linkedCreditId"=77 WHERE id=$1', [f.id]);
  assert.equal((await f.store.consumeVerifiedRequest(f.proof())).outcome, "needs_credit");
  assert.equal((await f.store.status(statusInput)).status, "NEEDS_CREDIT"); assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
  const result = await f.store.consumeVerifiedRequest(f.proof({ kind: "days", days: 3, folio: "FC-78" }, { messageAt: initial }));
  assert.equal(result.outcome, "granted"); assert.equal(result.creditId, 78);
  assert.equal((await f.store.status({ ...statusInput, folio: "FC-78" })).approved, true);
  assert.equal((await f.store.status(statusInput)).approved, false);
});

test("same UUID cannot authorize another conversation or credit and a later request cannot be overwritten by an older one", async t => {
  const f = await fixture(t), proof = f.proof();
  assert.equal((await f.store.consumeVerifiedRequest(proof)).outcome, "granted");
  const id = randomUUID(), externalId = randomUUID();
  const otherPhone = "+573001234568";
  await f.db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name) VALUES($1,$2,'whatsapp',$3,'Cliente sintético')`, [id, externalId, otherPhone]);
  await f.db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`, [randomUUID(), id, scope.phoneNumberId, scope.wabaId, otherPhone.slice(1)]);
  assert.equal((await f.store.consumeVerifiedRequest({ ...proof, conversationId: id, externalConversationId: externalId, phone: otherPhone, contactId: otherPhone.slice(1) })).outcome, "ignored");
  assert.equal((await f.store.consumeVerifiedRequest(f.proof({ kind: "days", days: 1 }, { messageAt: "2026-11-01T16:59:58Z" }))).outcome, "ignored");
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 1);
});

test("scope, native chat and Meta binding mismatches cannot reach the financial writer", async t => {
  const f = await fixture(t), proof = f.proof();
  await assert.rejects(f.store.consumeVerifiedRequest({ ...proof, scope: { ...scope, phoneNumberId: "999" } }), { status: 403 });
  assert.equal((await f.store.consumeVerifiedRequest({ ...proof, phone: "+573001234568", contactId: "573001234568" })).outcome, "ignored");
  await f.db.query('UPDATE "AttentionMetaBinding" SET "wabaId"=\'999\' WHERE "conversationId"=$1', [f.id]);
  assert.equal((await f.store.consumeVerifiedRequest(proof)).outcome, "ignored");
  assert.equal(await count(f.db, "DianaExtensionRequest"), 0); assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
});

test("requests are revalidated after credit locks and after all audit writes", async t => {
  for (const checkpoint of ["FOR UPDATE OF c", 'INSERT INTO "AttentionAudit"']) {
    const f = await fixture(t), proof = f.proof();
    const store = f.storeWithHook(sql => { if (sql.includes(checkpoint)) f.setNow("2026-11-01T17:16:00Z"); });
    await assert.rejects(store.consumeVerifiedRequest(proof), { status: 409 });
    assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0); assert.equal(await count(f.db, "DianaExtensionRequest"), 0);
  }
});

test("actual payments, paid/cancelled status, incomplete calendars and a conflicting day/date request fail closed", async t => {
  for (const setup of [
    `UPDATE "Credito" SET estado='PAGADO'`, `UPDATE "Credito" SET estado='CANCELADO'`,
    `INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono") VALUES(1,77,400,'2026-11-01 16:00:00')`,
    `UPDATE "Credito" SET "montoCredito"=0`, `UPDATE "Credito" SET "fechaPrimerPago"=NULL`,
  ]) {
    const f = await fixture(t); await f.db.exec(setup);
    assert.equal((await f.store.consumeVerifiedRequest(f.proof())).outcome, "rejected", setup); assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
  }
  const f = await fixture(t);
  assert.equal((await f.store.consumeVerifiedRequest(f.proof({ kind: "days", days: 4, date: "2026-11-03" }))).outcome, "rejected");
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
});

test("only currently available dates are applied, including pre-due requests and the existing 06/21 final cutoff", async t => {
  for (const intent of [{ kind: "date", date: "2026-11-03" }, { kind: "days", days: 1, date: "2026-11-03" }]) {
    const f = await fixture(t); assert.equal((await f.store.consumeVerifiedRequest(f.proof(intent))).outcome, "granted");
  }
  const f = await fixture(t); f.setNow("2026-11-06T17:00:00Z");
  assert.equal((await f.store.consumeVerifiedRequest(f.proof({ kind: "days", days: 1 }, { messageAt: "2026-11-06T16:59:59Z" }))).outcome, "rejected");
  assert.equal((await f.store.consumeVerifiedRequest(f.proof({ kind: "days", days: 4 }, { messageAt: "2026-11-06T17:00:00Z" }))).outcome, "granted");
  const late = await fixture(t); late.setNow("2026-11-07T17:00:00Z");
  assert.equal((await late.store.consumeVerifiedRequest(late.proof({ kind: "days", days: 4 }, { messageAt: "2026-11-07T17:00:00Z" }))).outcome, "rejected");
  assert.equal(await count(late.db, "CreditMoraExceptionRequest"), 0);
});

test("status reflects current payments and canonical protection, never a cancelled or fully paid historical grant", async t => {
  const f = await fixture(t); await f.store.consumeVerifiedRequest(f.proof());
  assert.equal((await f.store.status(statusInput)).approved, true);
  await f.db.exec(`INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono") VALUES(1,77,100,'2026-11-01 17:00:00')`);
  assert.equal((await f.store.status(statusInput)).approved, false, "covering the protected installment invalidates its current approval view");
  await f.db.exec(`UPDATE "CreditoAbono" SET valor=400`);
  assert.equal((await f.store.status(statusInput)).approved, false, "stale credit estado cannot hide an actual full payoff");
  await f.db.exec(`UPDATE "CreditoAbono" SET estado='ANULADO'`);
  assert.equal((await f.store.status(statusInput)).approved, true);
  await f.db.exec(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1`);
  assert.equal((await f.store.status(statusInput)).approved, false);
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 1);
});

test("another current protection blocks automatic grants and is never reported as a new Diana extension", async t => {
  const f = await fixture(t);
  await f.db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"expiresOn",reason,observation,"createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES($1,77,'PRORROGA','APPROVED','CENTRAL_DIRECT',NULL,'Autorización central','Sin vencimiento',1,'Administrador real',1,'Administrador real',$2,$3,$4)`, [randomUUID(), initial, randomUUID(), "a".repeat(64)]);
  const before = await f.store.status(statusInput); assert.equal(before.approved, false); assert.equal(before.existing, true);
  assert.equal((await f.store.consumeVerifiedRequest(f.proof())).outcome, "rejected");
  assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 1);
});

test("shared schema replay keeps legacy grants compatible and guards original direct-request identity/decision", async t => {
  const f = await fixture(t); await f.store.consumeVerifiedRequest(f.proof());
  await installDianaExtensionSchema({ query: (sql, params = []) => f.db.query(sql, params) });
  await installDianaExtensionRequestSchema({ query: (sql, params = []) => f.db.query(sql, params) });
  assert.equal((await f.db.query(dianaExtensionRequestSchemaCheckSql())).rows[0].ready, true);
  assert.equal((await f.store.status(statusInput)).approved, true);
  for (const assignment of ["source='CENTRAL_DIRECT'", '"createdByName"=\'Un humano\'', '"decidedByName"=\'Un humano\'',
    '"createIdempotencyKey"=gen_random_uuid()', '"installmentNumber"=2', '"promiseAmount"=100', '"promiseDate"=\'2026-11-06\''])
    await assert.rejects(f.db.exec(`UPDATE "CreditMoraExceptionRequest" SET ${assignment}`));
  await f.db.exec(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"='2026-11-05',version=version+1,observation='Edición humana posterior'`);
  const view = await f.store.status(statusInput); assert.equal(view.expiresOn, "2026-11-05"); assert.equal(view.days, 3);
  assert.equal(view.status, "ACTIVE"); assert.equal(view.existing, true, "a human amendment is never presented as the original native grant");
  await f.db.exec(`UPDATE "CreditMoraExceptionRequest" SET "expiresOn"='2026-11-20',version=version+1,observation='Autorización posterior de central'`);
  const manual = await f.store.status(statusInput); assert.equal(manual.approved, true); assert.equal(manual.expiresOn, "2026-11-20");
  assert.equal(manual.status, "ACTIVE"); assert.equal(manual.existing, true); assert.equal(manual.days, null);
  await f.db.exec(`ALTER TABLE "CreditMoraExceptionRequest" DISABLE TRIGGER "CreditMoraExceptionRequest_diana_identity"`);
  assert.equal((await f.db.query(dianaExtensionRequestSchemaCheckSql())).rows[0].ready, false);
  await assert.rejects(f.store.status(statusInput), { status: 503 });
});

test("readiness verifies typed ledger columns, real foreign keys, primary key, global message uniqueness and active-credit index", async t => {
  for (const statement of [
    'ALTER TABLE "DianaExtensionRequest" ALTER COLUMN phone DROP NOT NULL',
    'ALTER TABLE "DianaExtensionRequest" DROP CONSTRAINT "DianaExtensionRequest_conversationId_fkey"',
    'ALTER TABLE "DianaExtensionRequest" DROP CONSTRAINT "DianaExtensionRequest_pkey"',
    'DROP INDEX "DianaExtensionRequest_message"; CREATE UNIQUE INDEX "DianaExtensionRequest_message" ON "DianaExtensionRequest"(phone,"messageId")',
    'DROP INDEX "CreditMoraExceptionRequest_one_open"',
  ]) {
    const f = await fixture(t); assert.equal((await f.db.query(dianaExtensionRequestSchemaCheckSql())).rows[0].ready, true);
    await f.db.exec(statement); assert.equal((await f.db.query(dianaExtensionRequestSchemaCheckSql())).rows[0].ready, false, statement);
    await assert.rejects(f.store.consumeVerifiedRequest(f.proof()), { status: 503 });
    assert.equal(await count(f.db, "CreditMoraExceptionRequest"), 0);
  }
});

test("the granted ledger CHECK rejects missing installment facts rather than accepting SQL NULL", async t => {
  const f = await fixture(t); await f.store.consumeVerifiedRequest(f.proof());
  for (const value of ["NULL,\"expiresOn\"", '"installmentNumber",NULL']) {
    await assert.rejects(f.db.query(`INSERT INTO "DianaExtensionRequest"(id,"messageId","conversationId","externalConversationId","contactId",phone,scope,"messageAt","observedAt","textDigest","requestHash",intent,outcome,"creditoId",days,"installmentNumber","expiresOn","installmentDueDate","extensionId","managementId","createdAt")
      SELECT gen_random_uuid(),gen_random_uuid(),"conversationId","externalConversationId","contactId",phone,scope,"messageAt","observedAt","textDigest","requestHash",intent,outcome,"creditoId",days,${value},"installmentDueDate","extensionId","managementId","createdAt" FROM "DianaExtensionRequest"`), { code: "23514" });
  }
});
