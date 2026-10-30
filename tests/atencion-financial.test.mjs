import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createAttentionFinancialStore } = await jiti.import("../lib/atencion-financial-storage.ts");
const { createAttentionFinancialReceiptSender } = await jiti.import("../lib/atencion-financial-runtime.ts");
const { createAttentionMetaStore } = await jiti.import("../lib/atencion-meta-storage.ts");
const { parseAttentionExtension, parseAttentionReceiptSend } = await jiti.import("../lib/atencion-financial-core.ts");
const { buildClientPaymentReceiptPdf } = await jiti.import("../lib/client-payment-receipt-pdf.ts");
const migration = readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8");
const scope = { phoneNumberId: "1162059967000416", wabaId: "2148284059050848" };
const phone = "+573001234567", instant = "2026-10-03T17:00:00.000Z";
const central = { userId: 1, sellerId: null, key: "admin:1", name: "Untrusted client name", central: true, admin: true, analyst: false, supervisor: false, aliadoId: 1, sedeId: 10 };
const analyst = { ...central, userId: 5, key: "analyst:5", central: false, admin: false, analyst: true };
const other = { ...analyst, userId: 6, key: "analyst:6" };
const wrap = db => ({ $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows, $transaction: fn => db.transaction(tx => fn(wrap(tx))) });
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa boolean);
    CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,activo boolean,"sedeId" int,"rolId" int);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY);
    CREATE TABLE "Credito"(id int PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,"clienteTipoDocumento" text DEFAULT 'CC',"clienteTelefono" text,
      estado text DEFAULT 'ACTIVO',"montoCredito" float DEFAULT 400,"valorCuota" float DEFAULT 100,"plazoMeses" int DEFAULT 4,"frecuenciaPago" text DEFAULT 'QUINCENAL',
      "fechaPrimerPago" timestamp DEFAULT '2026-10-02 12:00:00',"fechaProximoPago" timestamp,"pazYSalvoEmitidoAt" timestamp,"planCapitalVigente" jsonb);
    CREATE TABLE "CreditoAbono"(id int PRIMARY KEY,"creditoId" int,valor float,"fechaAbono" timestamp,"createdAt" timestamp DEFAULT '2026-10-03 13:00:00',
      "metodoPago" text DEFAULT 'EFECTIVO',observacion text,estado text DEFAULT 'ACTIVO',"anuladoAt" timestamp);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(3,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);
    INSERT INTO "Sede" VALUES(10,'Central',1,true);
    INSERT INTO "Usuario" VALUES(1,'Administrador real',true,10,1),(5,'Analista real',true,10,3),(6,'Otro analista',true,10,3);
    INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(77,'FC-77','Cliente sintético','100000077','3001234567');`);
  await db.exec(migration);
  await installMoraExceptionRequestSchema({ query: (sql, params = []) => db.query(sql, params) });
  let clock = new Date(instant); const database = wrap(db), now = () => clock;
  const meta = createAttentionMetaStore(database, { scope, sendingEnabled: true, cutoverConfirmed: true, now });
  await meta.ingest({ scope, messages: [{ id: "wamid.test-inbound", from: phone.slice(1), phone, name: "Cliente sintético", timestamp: instant, type: "text", text: "Solicitud" }], statuses: [], ignored: 0 });
  const id = (await db.query('SELECT id FROM "AttentionConversation"')).rows[0].id;
  await db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=5,"assigneeKey"=\'analyst:5\',"assigneeName"=\'Analista real\' WHERE id=$1', [id]);
  const financial = createAttentionFinancialStore(database, { now });
  const input = async (patch = {}) => ({ creditId: 77, days: 4, version: (await db.query('SELECT version FROM "AttentionConversation" WHERE id=$1', [id])).rows[0].version,
    requestId: randomUUID(), installmentNumber: 1, installmentDueDate: "2026-10-02", reason: "Compromiso confirmado", observation: "Cliente confirma las condiciones", promiseAmount: 100, promiseDate: "2026-10-06", ...patch });
  const pay = async (paymentId = 1, patch = {}) => db.query(`INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono",estado,"anuladoAt") VALUES($1,77,$2,$3,$4,$5)`, [paymentId, patch.amount ?? 25, patch.at ?? "2026-10-03T12:00:00Z", patch.status ?? "ACTIVO", patch.annulled ?? null]);
  const sendInput = async (patch = {}) => ({ creditId: 77, paymentId: 1, version: (await financial.get(analyst, id)).version, requestId: randomUUID(), ...patch });
  return { db, database, meta, financial, id, now, input, pay, sendInput, setNow: value => { clock = new Date(value); } };
}

test("parsers reject extra fields, invalid days/dates/money and mismatched request payloads", () => {
  const data = { creditId: 77, days: 4, version: 1, requestId: randomUUID(), reason: "Motivo válido", observation: "Observación válida", promiseAmount: 100, promiseDate: "2026-10-06" };
  assert.equal(parseAttentionExtension(data).days, 4);
  for (const patch of [{ days: 5 }, { days: "4" }, { promiseDate: "2026-02-30" }, { promiseAmount: 0 }, { promiseAmount: 1.001 }, { centralAdmin: true }, { observation: "" }, { installmentNumber: 1 }, { installmentDueDate: "2026-10-02" }, { installmentNumber: 0, installmentDueDate: "2026-10-02" }]) assert.throws(() => parseAttentionExtension({ ...data, ...patch }));
  assert.throws(() => parseAttentionReceiptSend({ creditId: 77, paymentId: 1, version: 1, requestId: randomUUID(), url: "https://example.com" }));
});

test("assigned nominal analyst reads verified exact-phone credits; other analyst, revoked role and ambiguous identity are denied", async t => {
  const f = await fixture(t);
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].id, 77);
  await assert.rejects(f.financial.get(other, f.id), { status: 404 });
  await f.db.exec('UPDATE "Usuario" SET activo=false WHERE id=5');
  await assert.rejects(f.financial.get(analyst, f.id), { status: 403 });
  await f.db.exec('UPDATE "Usuario" SET activo=true WHERE id=5');
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(78,'FC-78','Otra identidad','AB100000077','+573001234567')`);
  assert.deepEqual((await f.financial.get(analyst, f.id)).credits, []);
  await assert.rejects(f.financial.grant(analyst, f.id, await f.input()), { status: 404 });
  await f.db.query('UPDATE "AttentionConversation" SET "linkedCreditId"=77 WHERE id=$1', [f.id]);
  assert.equal((await f.financial.get(analyst, f.id)).credits.length, 1);
  await f.db.exec('UPDATE "Credito" SET "clienteTelefono"=\'3009999999\' WHERE id=77');
  assert.deepEqual((await f.financial.get(analyst, f.id)).credits, []);
});

test("analyst grants approved due+4, preserves loan terms, real actor, immutable audit and idempotency", async t => {
  const f = await fixture(t), input = await f.input();
  const original = (await f.db.query('SELECT * FROM "Credito" WHERE id=77')).rows[0];
  const result = await f.financial.grant(analyst, f.id, input);
  assert.equal(result.extension.status, "APPROVED"); assert.equal(result.extension.expiresOn, "2026-10-06");
  assert.equal(result.version, input.version + 1);
  const row = (await f.db.query('SELECT * FROM "CreditMoraExceptionRequest"')).rows[0];
  assert.equal(row.createdByUserId, 5); assert.equal(row.decidedByUserId, 5); assert.equal(row.decidedByName, "Analista real"); assert.equal(row.source, "ANALYST_REQUEST");
  assert.deepEqual((await f.db.query('SELECT * FROM "Credito" WHERE id=77')).rows[0], original);
  const replay = await f.financial.grant(analyst, f.id, input); assert.equal(replay.unchanged, true); assert.equal(replay.extension.id, result.extension.id);
  await assert.rejects(f.financial.grant(analyst, f.id, { ...input, days: 3 }), { status: 409 });
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 1);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='EXTENSION_GRANTED'`)).rows[0].n, 1);
  await assert.rejects(f.db.exec('DELETE FROM "CreditMoraExceptionEvent"'));
  await assert.rejects(f.financial.grant(analyst, f.id, await f.input()), { status: 409 });
  await f.db.exec(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED'`);
  assert.equal((await f.financial.grant(analyst, f.id, input)).extension.status, "CANCELLED", "replay reports current status, not a new approval");
});

test("02/06 and 17/21 boundaries apply equally to central and analyst, never four days from today", async t => {
  const f = await fixture(t);
  f.setNow("2026-10-02T17:00:00Z"); assert.equal((await f.financial.get(analyst, f.id)).credits[0].extension.canGrant, true);
  f.setNow("2026-10-05T17:00:00Z"); assert.deepEqual((await f.financial.get(central, f.id)).credits[0].extension.choices.map(c => c.days), [3, 4]);
  await assert.rejects(f.financial.grant(central, f.id, await f.input({ days: 1 })), { status: 409 });
  f.setNow("2026-10-07T17:00:00Z"); await assert.rejects(f.financial.grant(central, f.id, await f.input({ promiseDate: "2026-10-07" })), { status: 409 });
  await f.db.exec(`UPDATE "Credito" SET "fechaPrimerPago"='2026-10-17 12:00:00' WHERE id=77`);
  f.setNow("2026-10-21T17:00:00Z"); assert.deepEqual((await f.financial.get(analyst, f.id)).credits[0].extension.choices, [{ days: 4, expiresOn: "2026-10-21" }]);
  const result = await f.financial.grant(analyst, f.id, await f.input({ promiseDate: "2026-10-21", installmentDueDate: "2026-10-17" })); assert.equal(result.extension.expiresOn, "2026-10-21");
});

test("future and due-today pending installments can be extended from their regular due date", async t => {
  for (const [today, actor] of [["2026-10-01T17:00:00Z", analyst], ["2026-10-02T17:00:00Z", central]]) {
    await t.test(today, async child => {
      const f = await fixture(child); f.setNow(today);
      const before = (await f.financial.get(actor, f.id)).credits[0];
      assert.equal(before.state, "AL_DIA"); assert.equal(before.extension.canGrant, true);
      assert.deepEqual(before.extension.choices.map(c => c.expiresOn), ["2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06"]);
      const result = await f.financial.grant(actor, f.id, await f.input({ days: 1, promiseDate: "2026-10-03" }));
      assert.equal(result.extension.installmentDueDate, "2026-10-02"); assert.equal(result.extension.expiresOn, "2026-10-03");
    });
  }
});

test("a newly paid installment cannot silently move a confirmed extension to the next future installment", async t => {
  const f = await fixture(t), input = await f.input();
  await f.pay(1, { amount: 100 });
  const next = (await f.financial.get(analyst, f.id)).credits[0].extension;
  assert.equal(next.installmentNumber, 2); assert.equal(next.dueDate, "2026-10-17"); assert.equal(next.canGrant, true);
  await assert.rejects(f.financial.grant(analyst, f.id, input), error => error.status === 409 && /cuota pendiente cambió/.test(error.message));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditMoraExceptionRequest"')).rows[0].n, 0);
  const result = await f.financial.grant(analyst, f.id, await f.input({ installmentNumber: 2, installmentDueDate: "2026-10-17", promiseDate: "2026-10-21" }));
  assert.equal(result.extension.installmentNumber, 2); assert.equal(result.extension.expiresOn, "2026-10-21");
});

test("a paid or cancelled credit stays ineligible; a cancelled payment does not remove the pending installment", async t => {
  const f = await fixture(t); f.setNow("2026-10-01T17:00:00Z");
  await f.pay(1, { amount: 400, at: "2026-10-01T12:00:00Z" });
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].extension.canGrant, false);
  await assert.rejects(f.financial.grant(analyst, f.id, await f.input()), { status: 409 });
  await f.db.exec(`UPDATE "CreditoAbono" SET estado='ANULADO',"anuladoAt"='2026-10-01' WHERE id=1`);
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].extension.installmentNumber, 1);
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].extension.canGrant, true);
  await f.db.exec(`UPDATE "Credito" SET estado='ANULADO' WHERE id=77`);
  assert.deepEqual((await f.financial.get(analyst, f.id)).credits, []);
  await assert.rejects(f.financial.grant(analyst, f.id, await f.input()), { status: 404 });
});

test("new grants require the reviewed installment, while an old recorded request can still be replayed", async t => {
  const f = await fixture(t), input = await f.input();
  const legacy = parseAttentionExtension({ ...input, installmentNumber: undefined, installmentDueDate: undefined });
  await assert.rejects(f.financial.grant(analyst, f.id, legacy), { status: 409 });
  const result = await f.financial.grant(analyst, f.id, input);
  // Model the fingerprint stored by the prior release without installment fields.
  const fingerprint = createHash("sha256").update(JSON.stringify({ conversationId: f.id, input: legacy, actorKey: analyst.key })).digest("hex");
  await f.db.query('UPDATE "AttentionRequest" SET fingerprint=$1 WHERE "actorKey"=$2 AND "requestId"=$3', [fingerprint, analyst.key, input.requestId]);
  const replay = await f.financial.grant(analyst, f.id, legacy);
  assert.equal(replay.unchanged, true); assert.equal(replay.extension.id, result.extension.id);
});

test("stale versions, unagreed promise dates/amounts, paid credits and incomplete calendars cannot grant", async t => {
  const f = await fixture(t);
  for (const patch of [{ version: 99 }, { promiseAmount: 401 }, { promiseDate: "2026-10-07" }, { promiseDate: "2026-10-02" }]) await assert.rejects(f.financial.grant(analyst, f.id, await f.input(patch)), { status: 409 });
  await f.db.exec('UPDATE "Credito" SET "fechaPrimerPago"=NULL WHERE id=77');
  const incomplete = (await f.financial.get(analyst, f.id)).credits[0]; assert.equal(incomplete.state, "NO_VERIFICADO"); assert.equal(incomplete.extension.canGrant, false);
  await f.db.exec(`UPDATE "Credito" SET "planCapitalVigente"='{"broken":true}' WHERE id=77`);
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].state, "NO_VERIFICADO");
  await f.db.exec('UPDATE "Credito" SET "planCapitalVigente"=NULL WHERE id=77');
  await f.db.exec(`UPDATE "Credito" SET "fechaPrimerPago"='2026-10-02',"pazYSalvoEmitidoAt"='2026-10-03' WHERE id=77`);
  const paid = (await f.financial.get(analyst, f.id)).credits[0]; assert.equal(paid.state, "PAGADO"); assert.equal(paid.extension.canGrant, false);
  await assert.rejects(f.financial.grant(analyst, f.id, await f.input()), { status: 409 });
});

test("expired approved protection is expired with audit before a new valid extension; pending blocks", async t => {
  const f = await fixture(t);
  await f.db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"expiresOn",reason,observation,"createdByUserId","createdByName","decidedAt","createIdempotencyKey","createRequestHash") VALUES($1,77,'EXCEPCION','APPROVED','CENTRAL_DIRECT','2026-10-02','Anterior','Observación',1,'Administrador',now(),$2,$3)`, [randomUUID(), randomUUID(), "a".repeat(64)]);
  await f.financial.grant(analyst, f.id, await f.input());
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "CreditMoraExceptionEvent" WHERE action='EXPIRED'`)).rows[0].n, 1);
});

test("latest receipt excludes annulled payments, uses payment date then id, and remains valid for paid credits", async t => {
  const f = await fixture(t);
  await f.pay(1, { at: "2026-10-03T11:00:00Z" }); await f.pay(2, { at: "2026-10-03T12:00:00Z" });
  await f.pay(3, { at: "2026-10-03T13:00:00Z", status: "ANULADO" }); await f.pay(4, { at: "2026-10-03T14:00:00Z", annulled: "2026-10-03" });
  await f.pay(5, { at: "2026-10-03T10:00:00Z" });
  await f.db.exec(`UPDATE "Credito" SET "pazYSalvoEmitidoAt"='2026-10-03' WHERE id=77`);
  assert.equal((await f.financial.get(analyst, f.id)).credits[0].lastPayment.id, 2);
  const receipt = await f.financial.receipt(analyst, f.id, 77); assert.equal(receipt.paymentId, 2); assert.equal(receipt.pdf.paymentSequence, 3);
  assert.equal(receipt.pdf.totalPaidThroughPayment, 75); assert.equal(receipt.pdf.paymentType, "PAYMENT"); assert.equal(receipt.pdf.presentation, undefined);
  assert.equal(receipt.pdf.creditClosed, true); assert.equal(receipt.fileName, "recibo-pago-77-2.pdf");
  await assert.rejects(f.financial.receipt(analyst, f.id, 77, 1), { status: 409 });
  await assert.rejects(f.financial.receipt(other, f.id, 77), { status: 404 });
  const a = await buildClientPaymentReceiptPdf(receipt.pdf), b = await buildClientPaymentReceiptPdf(receipt.pdf); assert.deepEqual(a, b, "stable PDF metadata supports concurrent retry fingerprints");
});

test("principal receipt uses recorded allocation and rejects corrupt amounts rather than inventing principal", async t => {
  const f = await fixture(t); await f.pay();
  await f.db.exec('CREATE TABLE "CreditPrincipalPaymentRevision"("creditoId" int,"abonoId" int,resultado jsonb)');
  await f.db.query('INSERT INTO "CreditPrincipalPaymentRevision" VALUES(77,1,$1)', [JSON.stringify({ quote: { saldoCapitalAntes: 400, saldoCapitalDespues: 375, abonoCapital: 25, cuotasEliminadas: 0 } })]);
  const receipt = await f.financial.receipt(analyst, f.id, 77); assert.equal(receipt.pdf.paymentType, "PRINCIPAL"); assert.equal(receipt.pdf.principalPayment.capitalApplied, 25);
  await f.db.exec(`UPDATE "CreditPrincipalPaymentRevision" SET resultado='{"quote":{"saldoCapitalAntes":400,"saldoCapitalDespues":374,"abonoCapital":26,"cuotasEliminadas":0}}'`);
  await assert.rejects(f.financial.receipt(analyst, f.id, 77), { status: 409 });
});

function provider(f, beforeUpload) {
  const calls = { upload: 0, send: 0 };
  return { calls, adapter: { status: () => ({ canSend: true, cutoverConfirmed: true }),
    uploadMedia: async () => { calls.upload++; await beforeUpload?.(); return { mediaId: "123456789" }; },
    sendMedia: async (input, beforeSend) => { await beforeSend(); calls.send++; return { providerMessageId: `wamid.${input.attemptId}` }; },
  } };
}
test("server PDF sends once through real outbox; retries preserve intent, versions and receipt identity", async t => {
  const f = await fixture(t); await f.pay(); const input = await f.sendInput(), p = provider(f);
  const send = createAttentionFinancialReceiptSender(f.database, f.financial, p.adapter, { scope, now: f.now });
  const first = await send(analyst, f.id, input); assert.equal(first.message.deliveryStatus, "accepted"); assert.equal(first.message.attachment.fileName, "recibo-pago-77-1.pdf");
  const replay = await send(analyst, f.id, input); assert.equal(replay.message.id, first.message.id); assert.deepEqual(p.calls, { upload: 1, send: 1 });
  await assert.rejects(send(analyst, f.id, { ...input, paymentId: 2 }), { status: 409 });
  const audit = (await f.db.query(`SELECT metadata FROM "AttentionAudit" WHERE action='PAYMENT_RECEIPT_SENDING'`)).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].metadata.paymentId, 1);
});

test("concurrent identical receipt requests keep one outbox and one provider send", async t => {
  const f = await fixture(t); await f.pay(); const input = await f.sendInput(), p = provider(f);
  const send = createAttentionFinancialReceiptSender(f.database, f.financial, p.adapter, { scope, now: f.now });
  const results = await Promise.allSettled([send(analyst, f.id, input), send(analyst, f.id, input)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
  assert.equal(p.calls.send, 1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n, 1);
});

test("after upload, revoked payment, changed phone or reassignment prevents the provider POST", async t => {
  for (const mutation of [
    `UPDATE "CreditoAbono" SET estado='ANULADO',"anuladoAt"=now() WHERE id=1`,
    `UPDATE "Credito" SET "clienteTelefono"='3009999999' WHERE id=77`,
    `UPDATE "AttentionConversation" SET "assigneeUserId"=6,"assigneeKey"='analyst:6'`,
  ]) {
    const f = await fixture(t); await f.pay(); const p = provider(f, () => f.db.exec(mutation));
    const send = createAttentionFinancialReceiptSender(f.database, f.financial, p.adapter, { scope, now: f.now });
    const result = await send(analyst, f.id, await f.sendInput()); assert.equal(result.message.deliveryStatus, "failed"); assert.equal(p.calls.send, 0);
    assert.equal((await f.db.query('SELECT "sendStartedAt" FROM "AttentionMetaOutbox"')).rows[0].sendStartedAt, null);
  }
});

test("new latest payment during upload blocks obsolete receipt; closed24h and gates cannot send", async t => {
  const f = await fixture(t); await f.pay(); const p = provider(f, () => f.pay(2, { at: "2026-10-03T14:00:00Z" }));
  const send = createAttentionFinancialReceiptSender(f.database, f.financial, p.adapter, { scope, now: f.now });
  assert.equal((await send(analyst, f.id, await f.sendInput())).message.deliveryStatus, "failed"); assert.equal(p.calls.send, 0);
  f.setNow("2026-10-05T17:00:00Z");
  await assert.rejects(send(analyst, f.id, await f.sendInput({ paymentId: 2 })), { status: 409 });
  f.setNow(instant); p.adapter.status = () => ({ canSend: false, cutoverConfirmed: false });
  await assert.rejects(send(analyst, f.id, await f.sendInput({ paymentId: 2 })), { status: 409 });
});
