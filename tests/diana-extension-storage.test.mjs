import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installDianaExtensionSchema } from "../scripts/diana-extension-schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createDianaExtensionStore } = await jiti.import("../lib/diana-extension-storage.ts");
const { parseDianaExtensionProposal, dianaExtensionMessageCode, dianaExtensionDigest } = await jiti.import("../lib/diana-extension-core.ts");
const scope = { workspaceId: "7496b9a3-2fe6-4e28-8411-7d54ee788b2c", agentId: "6f9560ec-dcfd-4725-bf61-27cd8d528a1c", agentChannelId: "6933b28b-b0a1-400c-aa1e-54f75bfbbd91", phoneNumberId: "1162059967000416", wabaId: "2148284059050848" };
const initial = "2026-11-01T17:00:00.000Z", phone = "+573001234567";
const input = { cedula: "100000077", folio: "FC-77", days: 4, promiseAmount: 100, promiseDate: "2026-11-06", reason: "Compromiso de pago del cliente" };
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
  await installDianaExtensionSchema({ query: (sql, params = []) => db.query(sql, params) });
  const id = randomUUID(), externalId = randomUUID();
  await db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name) VALUES($1,$2,'whatsapp',$3,'Cliente sintético')`, [id, externalId, phone]);
  await db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`, [randomUUID(), id, scope.phoneNumberId, scope.wabaId, phone.slice(1)]);
  let clock = new Date(initial);
  const now = () => clock, store = createDianaExtensionStore(wrap(db), { scope, enabled: true, now });
  const proof = (direction, text, patch = {}) => ({ scope, direction, conversationId: id, externalConversationId: externalId,
    contactId: phone.slice(1), phone, messageId: randomUUID(), messageAt: direction === "outbound" ? "2026-11-01T17:00:05.000Z" : "2026-11-01T17:00:10.000Z",
    code: text.match(/\bPR-[A-F0-9]{16}\b/)?.[0] || "PR-0000000000000000", textDigest: dianaExtensionDigest(text), deliveryId: randomUUID(), ...patch });
  const offer = async proposal => store.consumeVerifiedMessage(proof("outbound", proposal.offerText));
  const confirm = async (proposal, patch = {}) => store.consumeVerifiedMessage(proof("inbound", `CONFIRMO ${proposal.code}`, patch));
  return { db, store, id, externalId, proof, offer, confirm, now, storeWithHook: hook => createDianaExtensionStore(wrap(db, hook), { scope, enabled: true, now }), setNow: value => { clock = new Date(value); } };
}

test("proposal parser admits exact real terms and rejects model claims, invalid dates and non-decimal commitments", () => {
  assert.deepEqual(parseDianaExtensionProposal(input), input);
  for (const patch of [{ confirmed: true }, { userId: 1 }, { conversationId: randomUUID() }, { days: 0 }, { days: "4" }, { days: 5 },
    { promiseDate: "2026-02-30" }, { promiseAmount: 0 }, { promiseAmount: 1.001 }, { reason: "a" }]) assert.throws(() => parseDianaExtensionProposal({ ...input, ...patch }));
  assert.equal(dianaExtensionMessageCode("sí confirmo PR-0123456789ABCDEF", "inbound"), null);
  assert.equal(dianaExtensionMessageCode("CONFIRMO PR-0123456789ABCDEF", "inbound"), "PR-0123456789ABCDEF");
});

test("proposal is read-only for credit, private, immutable, bounded and idempotent without renewing its TTL", async t => {
  const f = await fixture(t), before = (await f.db.query('SELECT * FROM "Credito"')).rows;
  const proposal = await f.store.propose(input);
  assert.match(proposal.code, /^PR-[A-F0-9]{16}$/); assert.equal(proposal.status, "PENDING"); assert.equal(proposal.approved, false);
  assert.equal(proposal.expiresAt, "2026-11-01T17:15:00.000Z"); assert.match(proposal.offerText, /vencimiento 02\/11\/2026/);
  assert.match(proposal.offerText, /hasta 06\/11\/2026/); assert.match(proposal.offerText, new RegExp(`CONFIRMO ${proposal.code}$`));
  for (const privateKey of ["creditoId", "creditId", "phone", "cedula", "conversationId", "identityHash"]) assert.equal(Object.hasOwn(proposal, privateKey), false);
  assert.equal(JSON.stringify(proposal).includes(input.cedula), false); assert.equal(JSON.stringify(proposal).includes(phone), false);
  f.setNow("2026-11-01T17:01:00.000Z"); assert.deepEqual(await f.store.propose(input), proposal);
  await assert.rejects(f.store.propose({ ...input, days: 3 }), { status: 409 });
  await assert.rejects(f.db.query('UPDATE "DianaExtensionProposal" SET "promiseAmount"=1 WHERE code=$1', [proposal.code]));
  await assert.rejects(f.db.exec('DELETE FROM "DianaExtensionProposal"'));
  assert.deepEqual((await f.db.query('SELECT * FROM "Credito"')).rows, before);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
});

test("private raw-message digests authorize real numeric folios and all-numeric codes without weakening CRM redaction", async t => {
  const f = await fixture(t), folio = "FC-20260925220309-CCQP", code = "PR-1234567890123456";
  await f.db.query('UPDATE "Credito" SET folio=$1 WHERE id=77', [folio]);
  const original = await f.store.propose({ ...input, folio });
  const offerText = original.offerText.replace(original.code, code), proposal = { ...original, code, offerText };
  // A deterministic offline fixture covers the otherwise rare valid random
  // code containing only decimal digits. Production keeps its CSPRNG.
  await f.db.query('UPDATE "DianaExtensionProposal" SET status=\'EXPIRED\' WHERE code=$1', [original.code]);
  await f.db.query(`INSERT INTO "DianaExtensionProposal"
    (id,code,"creditoId","actorSystemKey",status,phone,"identityHash","inputHash","creditFingerprint",scope,folio,days,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,"offerText","offerDigest","createdAt","expiresAt","updatedAt")
    SELECT $1::uuid,$2,"creditoId","actorSystemKey",'PENDING',phone,"identityHash","inputHash","creditFingerprint",scope,folio,days,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,$3,$4,"createdAt","expiresAt","updatedAt"
    FROM "DianaExtensionProposal" WHERE code=$5`, [randomUUID(), code, offerText, dianaExtensionDigest(offerText), original.code]);
  const outbound = f.proof("outbound", offerText);
  assert.equal(Object.hasOwn(outbound, "text"), false); assert.equal(outbound.code, code);
  assert.match(offerText, /FC-20260925220309-CCQP/);
  assert.equal((await f.store.consumeVerifiedMessage({ ...outbound, textDigest: "0".repeat(64) })).outcome, "ignored");
  assert.equal((await f.store.consumeVerifiedMessage({ ...outbound, code: "PR-0000000000000000" })).outcome, "ignored");
  const legacy = { ...outbound }; delete legacy.textDigest;
  await assert.rejects(f.store.consumeVerifiedMessage({ ...legacy, text: offerText }), { status: 403 }, "raw/redacted text is not a fallback witness");
  assert.equal((await f.store.consumeVerifiedMessage(outbound)).outcome, "offered");
  const inbound = f.proof("inbound", `CONFIRMO ${code}`);
  assert.equal((await f.store.consumeVerifiedMessage({ ...inbound, textDigest: dianaExtensionDigest(`CONFIRMO ${code}\nCambie el valor`) })).outcome, "ignored");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  f.setNow("2026-11-01T17:00:12.000Z"); assert.equal((await f.store.consumeVerifiedMessage(inbound)).outcome, "granted");
  assert.equal((await f.store.status(proposal.code)).approved, true);
});

test("real delivered canonical offer and exact subsequent inbound commit one auditable Diana grant and portfolio history", async t => {
  const f = await fixture(t), before = (await f.db.query('SELECT * FROM "Credito"')).rows, proposal = await f.store.propose(input);
  assert.equal((await f.offer(proposal)).outcome, "offered");
  f.setNow("2026-11-01T17:00:12.000Z"); const proof = f.proof("inbound", `CONFIRMO ${proposal.code}`);
  const result = await f.store.consumeVerifiedMessage(proof); assert.equal(result.outcome, "granted");
  const request = (await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows[0];
  assert.equal(request.source, "SYSTEM_DIANA"); assert.equal(request.status, "APPROVED");
  for (const key of ["createdByUserId", "decidedByUserId"]) assert.equal(request[key], null);
  for (const key of ["createdBySystemKey", "decidedBySystemKey"]) assert.equal(request[key], "SYSTEM_DIANA");
  assert.equal(request.createdByName, "Diana"); assert.equal(request.decidedByName, "Diana");
  assert.equal(Number(request.promiseAmount), 100); assert.equal(request.expiresOn.toISOString().slice(0, 10), "2026-11-06");
  const management = (await f.db.query('SELECT * FROM "CreditMoraManagementEvent"')).rows[0];
  assert.equal(management.managementStatus, "ACUERDO_PAGO"); assert.equal(management.actorUserId, null); assert.equal(management.responsibleUserId, null);
  assert.equal(management.actorSystemKey, "SYSTEM_DIANA"); assert.equal(management.responsibleSystemKey, "SYSTEM_DIANA");
  assert.equal(management.nextFollowUpAt.toISOString(), "2026-11-07T13:00:00.000Z");
  const event = (await f.db.query('SELECT * FROM "CreditMoraExceptionEvent" WHERE action=\'APPROVED\'')).rows[0];
  assert.equal(event.actorSystemKey, "SYSTEM_DIANA"); assert.equal(event.actorUserId, null); assert.equal(event.payload.confirmationMessageId, proof.messageId);
  assert.equal((await f.store.status(proposal.code)).approved, true);
  assert.deepEqual((await f.db.query('SELECT * FROM "Credito"')).rows, before, "the extension does not rewrite contractual dates or loan amounts");
  assert.equal((await f.store.consumeVerifiedMessage(proof)).outcome, "already_granted");
  assert.equal((await f.confirm(proposal)).outcome, "already_granted");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraManagementEvent"')).rows[0].n, 1);
  await assert.rejects(f.db.exec('DELETE FROM "CreditMoraManagementEvent"'));
  await installDianaExtensionSchema({ query: (sql, params = []) => f.db.query(sql, params) });
  assert.equal((await f.store.status(proposal.code)).approved, true, "a repeated shared schema initializer keeps the system principal valid");
});

test("two simultaneous confirmations serialize into one canonical financial decision", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  f.setNow("2026-11-01T17:00:12.000Z");
  const proof = f.proof("inbound", `CONFIRMO ${proposal.code}`);
  const results = await Promise.all([f.store.consumeVerifiedMessage(proof), f.store.consumeVerifiedMessage(proof)]);
  assert.deepEqual(results.map(result => result.outcome).sort(), ["already_granted", "granted"]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraManagementEvent"')).rows[0].n, 1);
});

test("audit/management failures roll back the exception and leave the real confirmation retryable", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  f.setNow("2026-11-01T17:00:12.000Z");
  await f.db.exec(`CREATE FUNCTION fail_diana_test_management() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test unavailable audit'; END; $$ LANGUAGE plpgsql;
    CREATE TRIGGER fail_diana_test_management BEFORE INSERT ON "CreditMoraManagementEvent" FOR EACH ROW EXECUTE FUNCTION fail_diana_test_management()`);
  await assert.rejects(f.confirm(proposal));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  assert.equal((await f.store.status(proposal.code)).status, "OFFERED");
  await f.db.exec('DROP TRIGGER fail_diana_test_management ON "CreditMoraManagementEvent"');
  assert.equal((await f.confirm(proposal)).outcome, "granted");
});

test("non-active and annulled payments cannot change the verified quote or satisfy its installment", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  await f.db.exec(`INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono",estado,"anuladoAt") VALUES
    (1,77,400,'2026-11-01 17:00:06','PENDIENTE',NULL),(2,77,400,'2026-11-01 17:00:07','ACTIVO','2026-11-01 17:00:08')`);
  f.setNow("2026-11-01T17:00:12.000Z");
  assert.equal((await f.confirm(proposal)).outcome, "granted");
  assert.equal(Number((await f.db.query('SELECT "promiseAmount" FROM "CreditMoraExceptionRequest"')).rows[0].promiseAmount), 100);
});

test("expiry is rechecked after waiting for locks and again before completing the atomic writes", async t => {
  for (const waitAt of ["proposal-lock", "audit-write"]) {
    const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
    f.setNow("2026-11-01T17:00:12.000Z");
    const store = f.storeWithHook(async sql => {
      if ((waitAt === "proposal-lock" && sql.includes('SELECT * FROM "DianaExtensionProposal" WHERE code=$1 FOR UPDATE'))
        || (waitAt === "audit-write" && sql.includes('INSERT INTO "AttentionAudit"'))) f.setNow("2026-11-01T17:16:00.000Z");
    });
    const call = store.consumeVerifiedMessage(f.proof("inbound", `CONFIRMO ${proposal.code}`));
    if (waitAt === "proposal-lock") assert.equal((await call).outcome, "rejected"); else await assert.rejects(call, { status: 409 });
    assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraManagementEvent"')).rows[0].n, 0);
  }
});

test("all exact-phone credit candidates lock in ascending order, and a changed pre-read phone fails closed", async t => {
  const f = await fixture(t);
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(78,'FC-78','Misma identidad','100000077','3001234567')`);
  const queries = [], store = f.storeWithHook(sql => { queries.push(sql); });
  const proposals = await Promise.all([store.propose(input), store.propose({ ...input, folio: "FC-78" })]);
  assert.equal(proposals.length, 2);
  const locks = queries.filter(sql => sql.includes("FOR UPDATE OF c"));
  assert.equal(locks.length, 2); for (const sql of locks) assert.match(sql, /WHERE c\.id=\$1 OR .*ORDER BY c\.id LIMIT 102 FOR UPDATE OF c/s);
  f.setNow("2026-11-01T17:16:00.000Z");
  let changed = false;
  const changedStore = f.storeWithHook(async (sql, _params, tx) => {
    if (!changed && sql.includes("FOR UPDATE OF c")) { changed = true; await tx.query('UPDATE "Credito" SET "clienteTelefono"=\'3001234568\' WHERE id=77'); }
  });
  await assert.rejects(changedStore.propose(input), { status: 409 });
});

test("a model paraphrase, forwarded confirmation, wrong author direction or early confirmation cannot authorize the grant", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input);
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("outbound", proposal.offerText.replace("hasta 06/11/2026", "hasta 05/11/2026")))).outcome, "ignored");
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("outbound", `Texto previo\n${proposal.offerText}`))).outcome, "ignored");
  assert.equal((await f.confirm(proposal)).outcome, "pending_offer");
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("outbound", `CONFIRMO ${proposal.code}`))).outcome, "ignored");
  await f.offer(proposal);
  assert.equal((await f.confirm(proposal, { messageAt: "2026-11-01T17:00:04.000Z" })).outcome, "ignored");
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("inbound", `Confirmo ${proposal.code}`))).outcome, "ignored");
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("inbound", `CONFIRMO ${proposal.code}\nCambie la fecha`))).outcome, "ignored");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  f.setNow("2026-11-01T17:00:12.000Z"); assert.equal((await f.confirm(proposal)).outcome, "granted", "out of order queue processing can retry the real proof");
});

test("wrong phone, Meta line, WABA or conversation binding never consumes a proposal", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input);
  await assert.rejects(f.store.consumeVerifiedMessage(f.proof("outbound", proposal.offerText, { scope: { ...scope, phoneNumberId: "999999999999999" } })), { status: 403 });
  assert.equal((await f.store.consumeVerifiedMessage(f.proof("outbound", proposal.offerText, { phone: "+573001234568", contactId: "573001234568" }))).outcome, "ignored");
  await f.db.query('UPDATE "AttentionMetaBinding" SET "wabaId"=\'999999999999999\' WHERE "conversationId"=$1', [f.id]);
  assert.equal((await f.offer(proposal)).outcome, "ignored");
  await f.db.query('UPDATE "AttentionMetaBinding" SET "wabaId"=$2 WHERE "conversationId"=$1', [f.id, scope.wabaId]);
  await f.offer(proposal);
  await f.db.query('UPDATE "AttentionConversation" SET "externalId"=$2 WHERE id=$1', [f.id, randomUUID()]);
  assert.equal((await f.confirm(proposal)).outcome, "ignored");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
});

test("expired proposal and dates beyond the CRM window are rejected without financial changes", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  f.setNow("2026-11-01T17:15:00.000Z"); assert.equal((await f.confirm(proposal)).outcome, "rejected");
  assert.equal((await f.store.status(proposal.code)).status, "EXPIRED");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  f.setNow("2026-11-07T05:00:00.000Z"); await assert.rejects(f.store.propose(input), { status: 409 });
});

test("new payment, calendar changes or paid status invalidate the accepted terms instead of granting stale data", async t => {
  for (const change of [
    `INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono") VALUES(1,77,25,'2026-11-01 17:00:06')`,
    `UPDATE "Credito" SET "fechaPrimerPago"='2026-11-17 12:00:00' WHERE id=77`,
    `UPDATE "Credito" SET estado='PAZ_Y_SALVO' WHERE id=77`,
    `UPDATE "Credito" SET "clienteTelefono"='3001234568' WHERE id=77`,
  ]) {
    const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
    await f.db.exec(change); f.setNow("2026-11-01T17:00:12.000Z");
    assert.equal((await f.confirm(proposal)).outcome, "rejected");
    assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  }
});

test("a concurrent human protection takes precedence; a failed projection cannot create a second active exception", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  await f.db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"expiresOn",reason,observation,"createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES($1,77,'EXCEPCION','APPROVED','CENTRAL_DIRECT','2026-11-04','Revisión central','Protección administrativa vigente',1,'Administrador real',1,'Administrador real','2026-11-01 17:00:06',$2,$3)`, [randomUUID(), randomUUID(), "a".repeat(64)]);
  f.setNow("2026-11-01T17:00:12.000Z"); assert.equal((await f.confirm(proposal)).outcome, "rejected");
  const rows = (await f.db.query('SELECT source FROM "CreditMoraExceptionRequest"')).rows; assert.deepEqual(rows, [{ source: "CENTRAL_DIRECT" }]);
});

test("ambiguous debtor phones, no phone, paid and incomplete schedules cannot create proposals", async t => {
  for (const change of [
    `INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(78,'FC-78','Otra identidad','200000078','3001234567')`,
    `UPDATE "Credito" SET "clienteTelefono"=NULL WHERE id=77`,
    `UPDATE "Credito" SET estado='PAGADO' WHERE id=77`,
    `UPDATE "Credito" SET "fechaPrimerPago"=NULL WHERE id=77`,
  ]) {
    const f = await fixture(t); await f.db.exec(change); await assert.rejects(f.store.propose(input), { status: 409 });
    assert.equal((await f.db.query('SELECT count(*)::int n FROM "DianaExtensionProposal"')).rows[0].n, 0);
  }
});

test("authorization and schema fail closed; human or system actor omissions violate database constraints", async t => {
  const f = await fixture(t);
  const disabled = createDianaExtensionStore(wrap(f.db), { scope, enabled: false, now: f.now });
  await assert.rejects(disabled.propose(input), { status: 503 });
  await assert.rejects(f.db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"installmentNumber","installmentDueDate","expiresOn","promiseAmount","promiseDate",reason,observation,"createdByName","createIdempotencyKey","createRequestHash")
    VALUES($1,77,'PRORROGA','PENDING','ANALYST_REQUEST',1,'2026-11-02','2026-11-06',100,'2026-11-06','Motivo válido','Observación válida','Sin actor',$2,$3)`, [randomUUID(), randomUUID(), "a".repeat(64)]));
  await f.db.exec('DROP TABLE "DianaExtensionProposal"'); await assert.rejects(f.store.propose(input), { status: 503 });
});

test("schema readiness verifies actual actor definitions, active-credit uniqueness and immutable proposal triggers", async t => {
  const f = await fixture(t), install = () => installDianaExtensionSchema({ query: (sql, params = []) => f.db.query(sql, params) });
  for (const change of [
    `ALTER TABLE "CreditMoraManagementEvent" DROP CONSTRAINT "CreditMoraManagementEvent_actor_identity"`,
    `DROP INDEX "CreditMoraExceptionRequest_one_open"`,
    `DROP TRIGGER "DianaExtensionProposal_immutable" ON "DianaExtensionProposal"`,
    `ALTER TABLE "CreditMoraExceptionRequest" DROP CONSTRAINT "CreditMoraExceptionRequest_actor_identity";
      ALTER TABLE "CreditMoraExceptionRequest" ADD CONSTRAINT "CreditMoraExceptionRequest_actor_identity" CHECK (true)`,
  ]) {
    await f.db.exec(change); await assert.rejects(f.store.propose(input), { status: 503 });
    await install();
  }
  assert.equal((await f.store.propose(input)).status, "PENDING");
});

test("status confirms the current canonical exception and does not report an administratively cancelled grant as approved", async t => {
  const f = await fixture(t), proposal = await f.store.propose(input); await f.offer(proposal);
  f.setNow("2026-11-01T17:00:12.000Z"); const grant = await f.confirm(proposal); assert.equal(grant.outcome, "granted");
  await f.db.query('UPDATE "CreditMoraExceptionRequest" SET status=\'CANCELLED\' WHERE id=$1', [grant.extensionId]);
  const status = await f.store.status(proposal.code); assert.equal(status.status, "GRANTED"); assert.equal(status.approved, false);
});
