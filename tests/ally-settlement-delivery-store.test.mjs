import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { loadReissueModule } from "./credit-approval-reissue-fixture.mjs";
import { allySettlementDeliverySchemaStatements } from "../scripts/ally-settlement-delivery-schema.mjs";

const contacts = loadReissueModule("lib/ally-contact.ts");
const types = loadReissueModule("lib/ally-settlement-delivery-types.ts");
const { createSettlementDeliveryStore, enqueueInitialSettlementDeliveries, DeliveryConflictError } = loadReissueModule("lib/ally-settlement-delivery-store.ts", {
  "./ally-contact": contacts,
  "./ally-settlement-delivery-types": types,
});
const pg = new PGlite();
function adapter(client) {
  return {
    $queryRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rows,
    $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).affectedRows || 0,
  };
}
const db = { ...adapter(pg), $transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))) };
const store = createSettlementDeliveryStore(db);
const snapshot = (id = 100, allyId = 1) => ({ id, aliado: { id: allyId, nombre: `Aliado Prueba ${allyId}` }, periodoInicio: "2026-10-01", periodoFin: "2026-10-15", saldoNeto: 123456.78 });
const rows = () => db.$queryRawUnsafe('SELECT * FROM "AllySettlementDeliveryAttempt" ORDER BY "channel","sequence"');
const initial = (value = snapshot()) => db.$transaction((tx) => enqueueInitialSettlementDeliveries(tx, value, 9));
const expire = (id) => db.$executeRawUnsafe('UPDATE "AllySettlementDeliveryAttempt" SET "leaseUntil"=now()-interval \'1 minute\' WHERE "id"=$1', id);
async function claimChannel(channel) {
  const attempt = (await rows()).find((row) => row.channel === channel && row.status === "QUEUED");
  assert.ok(attempt);
  await db.$executeRawUnsafe(`UPDATE "AllySettlementDeliveryAttempt" SET "createdAt"=now()-interval '1 hour' WHERE "id"=$1::uuid`, attempt.id);
  const claimed = await store.claim(attempt.settlementId);
  assert.equal(claimed.channel, channel);
  return claimed;
}

before(async () => {
  await pg.exec(`CREATE TABLE "Aliado" (id integer PRIMARY KEY, nombre text, email text, "telefonoWhatsapp" text);
    CREATE TABLE "LiquidacionAliado" (id integer PRIMARY KEY, "aliadoId" integer NOT NULL REFERENCES "Aliado"(id));`);
  for (const sql of allySettlementDeliverySchemaStatements) await pg.exec(sql);
});
beforeEach(async () => {
  await pg.exec(`TRUNCATE "Aliado", "LiquidacionAliado" CASCADE;
    INSERT INTO "Aliado" VALUES (1,'Aliado Prueba 1','one@example.com','573001234567'),(2,'Aliado Prueba 2','two@example.com','573009876543');
    INSERT INTO "LiquidacionAliado" VALUES (100,1),(200,2);`);
});
after(async () => { await pg.close(); });

test("la transacción revierte liquidación y cola juntas ante error", async () => {
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('INSERT INTO "LiquidacionAliado" VALUES (300,1)');
    await enqueueInitialSettlementDeliveries(tx, snapshot(300), 9);
    throw new Error("rollback de prueba");
  }), /rollback de prueba/);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "LiquidacionAliado" WHERE id=300')).length, 0);
  assert.equal((await rows()).length, 0);
});

test("encolar de nuevo conserva dos canales distintos, destinatarios y payload guardados", async () => {
  await initial();
  await initial();
  const attempts = await rows();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].recipient, "one@example.com");
  assert.equal(attempts[1].recipient, "573001234567");
  assert.equal(attempts[0].status, "QUEUED");
  assert.equal(attempts[1].status, "QUEUED");
  assert.notEqual(attempts[0].requestId, attempts[1].requestId);
  assert.equal(attempts[0].payload.subject, "FINSER PAY | Liquidación del 01/10/2026 al 15/10/2026");
  assert.match(attempts[0].payload.text, /Aliado Prueba 1/);
  assert.match(attempts[0].payload.text, /no confirma un desembolso/);
  assert.deepEqual(attempts[0].payload, attempts[1].payload);
});

test("dos workers concurrentes nunca reservan un mismo intento", async () => {
  await initial();
  const claims = (await Promise.all(Array.from({ length: 8 }, () => store.claim(100)))).filter(Boolean);
  assert.equal(claims.length, 2);
  assert.equal(new Set(claims.map((row) => row.id)).size, 2);
  assert.equal(await store.claim(100), null);
});

test("el teléfono faltante falla por separado y permite reclamar el correo disponible", async () => {
  await db.$executeRawUnsafe('UPDATE "Aliado" SET "telefonoWhatsapp"=NULL WHERE id=1');
  await initial();
  const listing = await store.list(100);
  assert.equal(listing.deliveries.find((row) => row.channel === "WHATSAPP").status, "FAILED");
  assert.match(listing.deliveries.find((row) => row.channel === "WHATSAPP").error, /Falta el teléfono/);
  assert.equal((await store.claim(100)).channel, "EMAIL");
  assert.equal(await store.claim(100), null);
});

test("reintentar un canal fallido congela el nuevo contacto y no reenvía el canal enviado", async () => {
  await initial();
  const mail = await claimChannel("EMAIL");
  await store.beforeSend(mail.id, mail.claimToken);
  await store.accepted(mail.id, "mail-provider-id", mail.claimToken);
  const whatsapp = await claimChannel("WHATSAPP");
  await store.failed(whatsapp.id, "Configuración pendiente", false, whatsapp.claimToken);
  await db.$executeRawUnsafe('UPDATE "Aliado" SET "telefonoWhatsapp"=$1 WHERE id=1', "573002222222");
  const operation = randomUUID();
  const retry = await store.retry(snapshot(), "WHATSAPP", operation, 9);
  assert.equal(retry.recipient, "573002222222");
  assert.equal(retry.sequence, 2);
  assert.equal((await store.retry(snapshot(), "WHATSAPP", operation, 9)).id, retry.id);
  const all = await rows();
  assert.equal(all.filter((row) => row.channel === "EMAIL").length, 1);
  assert.equal(all.find((row) => row.channel === "EMAIL").status, "SENT");
  assert.equal(all.find((row) => row.id === whatsapp.id).recipient, "573001234567");
  assert.equal(all.length, 3);
});

test("el mismo requestId no puede aplicarse a otro canal ni a otra liquidación", async () => {
  const operation = randomUUID();
  await store.retry(snapshot(), "EMAIL", operation, 9);
  await assert.rejects(store.retry(snapshot(), "WHATSAPP", operation, 9), DeliveryConflictError);
  await assert.rejects(store.retry(snapshot(200, 2), "EMAIL", operation, 9), DeliveryConflictError);
  assert.equal((await rows()).length, 1);
});

test("el PDF se guarda una vez por liquidación y todos los canales usan los mismos bytes", async () => {
  const original = Buffer.from("%PDF-1.4\nPDF de prueba uno\n%%EOF");
  const changed = Buffer.from("%PDF-1.4\nNO debe reemplazar\n%%EOF");
  const [emailDoc, whatsappDoc] = await Promise.all([
    store.document(100, async () => original),
    store.document(100, async () => changed),
  ]);
  assert.deepEqual(emailDoc.pdf, whatsappDoc.pdf);
  assert.equal(emailDoc.filename, "liquidacion-aliado-LA-100.pdf");
  const reread = await store.document(100, async () => { throw new Error("No debe regenerar el PDF"); });
  assert.deepEqual(reread.pdf, emailDoc.pdf);
  const [saved] = await db.$queryRawUnsafe('SELECT "sha256" FROM "AllySettlementDocument" WHERE "settlementId"=100');
  assert.equal(saved.sha256, createHash("sha256").update(reread.pdf).digest("hex"));
  const other = await store.document(200, async () => Buffer.from("%PDF-1.4\nOtro aliado\n%%EOF"));
  assert.notDeepEqual(other.pdf, reread.pdf);
});

test("una reserva vencida antes del envío se recupera, una iniciada queda incierta y bloquea reenvíos", async () => {
  await initial();
  const mail = await claimChannel("EMAIL");
  await expire(mail.id);
  await store.recover();
  assert.equal((await rows()).find((row) => row.id === mail.id).status, "QUEUED");
  const reclaimed = await claimChannel("EMAIL");
  assert.equal(reclaimed.id, mail.id);
  await store.beforeSend(mail.id, reclaimed.claimToken);
  await assert.rejects(store.beforeSend(mail.id, reclaimed.claimToken), /perdió su reserva/);
  await expire(mail.id);
  await store.recover();
  assert.equal((await rows()).find((row) => row.id === mail.id).status, "UNCERTAIN");
  const view = (await store.list(100)).deliveries.find((row) => row.channel === "EMAIL");
  assert.equal(view.status, "FAILED");
  assert.equal(view.uncertain, true);
  assert.equal(view.canRetry, false);
  await assert.rejects(store.retry(snapshot(), "EMAIL", randomUUID(), 9), DeliveryConflictError);
  await store.accepted(mail.id, "late-confirmation-id", reclaimed.claimToken);
  assert.equal((await rows()).find((row) => row.id === mail.id).status, "SENT");
});

test("antes de enviar se rechaza una reserva expirada y una respuesta tardía no degrada SENT", async () => {
  await initial();
  const mail = await claimChannel("EMAIL");
  await expire(mail.id);
  await assert.rejects(store.beforeSend(mail.id, mail.claimToken), /perdió su reserva/);
  await store.recover();
  const current = await claimChannel("EMAIL");
  await store.beforeSend(mail.id, current.claimToken);
  await store.accepted(mail.id, "confirmed", current.claimToken);
  await store.failed(mail.id, "late failure", true, current.claimToken);
  assert.equal((await rows()).find((row) => row.id === mail.id).status, "SENT");
});

test("un requestId recibido mientras estaba pendiente sigue idempotente tras completar el envío", async () => {
  await initial();
  const operation = randomUUID();
  const pending = await store.retry(snapshot(), "EMAIL", operation, 9);
  const claimed = await claimChannel("EMAIL");
  await store.beforeSend(pending.id, claimed.claimToken);
  await store.accepted(pending.id, "mail-completed-id", claimed.claimToken);
  const replay = await store.retry(snapshot(), "EMAIL", operation, 9);
  assert.equal(replay.id, pending.id);
  assert.equal((await rows()).filter((row) => row.channel === "EMAIL").length, 1);
});

test("webhook de WhatsApp no puede alterar otro destinatario o providerId", async () => {
  await initial();
  const whatsapp = await claimChannel("WHATSAPP");
  await store.beforeSend(whatsapp.id, whatsapp.claimToken);
  await store.accepted(whatsapp.id, "wamid.test-one", whatsapp.claimToken);
  const base = { attemptId: whatsapp.id, providerId: "wamid.test-one", recipient: "573001234567", status: "failed", timestamp: new Date("2099-01-01") };
  await store.reconcileWhatsApp({ ...base, recipient: "573009876543" });
  await store.reconcileWhatsApp({ ...base, providerId: "wamid.other" });
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "SENT");
  await store.reconcileWhatsApp(base);
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "FAILED");
});

test("webhooks fuera de orden no reemplazan el último resultado confirmado", async () => {
  await initial();
  const whatsapp = await claimChannel("WHATSAPP");
  await store.beforeSend(whatsapp.id, whatsapp.claimToken);
  const base = { attemptId: whatsapp.id, providerId: "wamid.ordered", recipient: "573001234567" };
  await store.reconcileWhatsApp({ ...base, status: "failed", timestamp: new Date("2099-01-02") });
  await store.reconcileWhatsApp({ ...base, status: "sent", timestamp: new Date("2099-01-01") });
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "FAILED");
  await store.reconcileWhatsApp({ ...base, status: "delivered", timestamp: new Date("2099-01-03") });
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "SENT");
});

test("un fallo en el mismo segundo prevalece y un sent tardío con esa fecha no lo borra", async () => {
  await initial();
  const whatsapp = await claimChannel("WHATSAPP");
  await store.beforeSend(whatsapp.id, whatsapp.claimToken);
  const base = {
    attemptId: whatsapp.id, providerId: "wamid.equal-second", recipient: "573001234567",
    timestamp: new Date("2099-01-02T12:00:00.000Z"),
  };
  await store.reconcileWhatsApp({ ...base, status: "sent" });
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "SENT");
  await store.reconcileWhatsApp({ ...base, status: "failed" });
  assert.equal((await rows()).find((row) => row.id === whatsapp.id).status, "FAILED");
  await store.reconcileWhatsApp({ ...base, status: "sent" });
  const final = (await rows()).find((row) => row.id === whatsapp.id);
  assert.equal(final.status, "FAILED");
  assert.match(final.error, /Meta informó un fallo/);
  assert.equal(new Date(final.providerEventAt).getTime(), base.timestamp.getTime());
});

test("el worker vencido no inicia un envío ni sobrescribe el resultado de una nueva reserva", async () => {
  await initial();
  const old = await claimChannel("EMAIL");
  await expire(old.id);
  await store.recover();
  const current = await claimChannel("EMAIL");
  assert.equal(current.id, old.id);
  assert.ok(current.claimToken);
  assert.notEqual(current.claimToken, old.claimToken);
  await assert.rejects(store.beforeSend(old.id, old.claimToken), /perdió su reserva/);
  await store.beforeSend(current.id, current.claimToken);
  await store.failed(old.id, "Fallo tardío de worker vencido", false, old.claimToken);
  await store.accepted(old.id, "provider-vencido", old.claimToken);
  const processing = (await rows()).find((row) => row.id === current.id);
  assert.equal(processing.status, "PROCESSING");
  assert.equal(processing.providerId, null);
  await store.accepted(current.id, "provider-vigente", current.claimToken);
  const sent = (await rows()).find((row) => row.id === current.id);
  assert.equal(sent.status, "SENT");
  assert.equal(sent.providerId, "provider-vigente");
});
