import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";
import { installWhatsAppAutomationMetaSchema } from "../scripts/whatsapp-automation-meta-schema.mjs";
import { loadApprovalModule } from "./credit-approval-test-loader.mjs";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createWhatsAppAutomationMetaSender } = await jiti.import("../lib/whatsapp-automation-meta.ts");
const { createAttentionMetaStore } = await jiti.import("../lib/atencion-meta-storage.ts");
const metaConfig = await jiti.import("../lib/whatsapp-automation-meta-config.ts");
const approvalErrors = loadApprovalModule("lib/credit-approval-errors.ts");
const { assertMoraActor } = loadApprovalModule("lib/analyst-mora-access.ts", {
  "@/lib/auth": {}, "@/lib/approval-shared-session": {}, "@/lib/roles": {},
  "@/lib/credit-approval-errors": approvalErrors,
});
const { createMoraExtensionWhatsAppService } = loadApprovalModule("lib/mora-extension-whatsapp.ts", {
  "@/lib/analyst-mora-access": { assertMoraActor },
  "@/lib/colombia-date": loadApprovalModule("lib/colombia-date.ts"),
  "@/lib/credit-approval-errors": approvalErrors,
  "@/lib/whatsapp": loadApprovalModule("lib/whatsapp.ts"),
  "@/lib/whatsapp-automation-provider": {
    isMetaAutomationConfigured: metaConfig.isMetaAutomationConfigured,
    sendMetaAutomation: () => { throw new Error("A simulated sender is required"); },
  },
});
const scope = { phoneNumberId: "1162059967000416", wabaId: "2148284059050848" };
const instant = "2026-11-03T17:00:00.000Z";
const actor = { id: 1, nombre: "Administradora", centralAdmin: true };
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const plain = value => JSON.parse(JSON.stringify(value));

function adapter(connection) {
  return {
    $queryRawUnsafe: async (sql, ...params) => (await connection.query(sql, params)).rows,
    $transaction: fn => connection.transaction(tx => fn(adapter(tx))),
  };
}

async function fixture(t, options = {}) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,"aliadoId" integer,activa boolean);
    CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,"rolId" integer,"sedeId" integer,activo boolean);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);
    CREATE TABLE "Credito"(id integer PRIMARY KEY,folio text,"clienteNombre" text,"clienteTelefono" text,estado text,
      "montoCredito" numeric,"bloqueoMora" boolean,"fechaProximoPago" date);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'ANALISTA_APROBACION'),(3,'VENDEDOR');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);
    INSERT INTO "Sede" VALUES(1,1,true);
    INSERT INTO "Usuario" VALUES(1,'Administradora',1,1,true),(2,'Analista',2,1,true),(3,'Vendedor',3,1,true),(4,'Inactiva',1,1,false);`);
  const client = { query: (sql, params) => db.query(sql, params) };
  await installMoraExceptionRequestSchema(client);
  await db.exec(readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8"));
  await installWhatsAppAutomationMetaSchema({ query: async (sql, params) => sql.includes("pg_advisory_lock(") ? { rows: [] }
    : sql.startsWith("BEGIN;") ? (await db.exec(sql)).at(-1) : db.query(sql, params) });
  const database = adapter(db);
  let clock = Date.parse(instant), messages = 0, nextCreditId = 50;
  const sends = [], requests = [];
  const env = { WHATSAPP_AUTOMATIONS_PROVIDER: "meta", WHATSAPP_ATTENTION_SEND_ENABLED: "true",
    WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED: "true", WHATSAPP_ATTENTION_PHONE_NUMBER_ID: scope.phoneNumberId,
    WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID: scope.wabaId, WHATSAPP_ATTENTION_ACCESS_TOKEN: `test-${randomUUID()}`,
    WHATSAPP_GRAPH_API_VERSION: "v25.0", ...options.env };
  const fetcher = async (url, init) => {
    const endpoint = new URL(url); requests.push(endpoint.pathname);
    assert.equal(endpoint.origin, "https://graph.facebook.com", "all provider requests are simulated");
    if (endpoint.pathname.endsWith("/messages")) {
      const body = JSON.parse(init.body); messages++; sends.push(body);
      if (options.post) return options.post(body, messages);
      return reply({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id: `wamid.test-${body.biz_opaque_callback_data}` }] });
    }
    if (endpoint.pathname.endsWith("/phone_numbers")) return reply({ data: [{ id: scope.phoneNumberId, display_phone_number: "+573124085562" }] });
    if (endpoint.pathname.endsWith("/message_templates")) {
      if (options.beforeTemplateMetadata) await options.beforeTemplateMetadata({ db });
      return reply({ data: [{ id: "123456789012345", name: "prorroga_activada", language: "es",
        status: "APPROVED", parameter_format: "POSITIONAL", components: [{ type: "BODY", text: metaConfig.PRORROGA_ACTIVADA_TEMPLATE_BODY }] }] });
    }
    return reply({ id: scope.phoneNumberId, display_phone_number: "+573124085562" });
  };
  const sendMeta = async (input, config) => {
    if (options.beforeNative) await options.beforeNative({ db, input });
    return createWhatsAppAutomationMetaSender({ ...config, database, env, fetcher, now: () => clock })(input);
  };
  const service = () => createMoraExtensionWhatsAppService({ database, env, sendMeta, now: () => new Date(clock) });
  const meta = createAttentionMetaStore(database, { scope, now: () => new Date(clock) });
  async function insert({ expiresOn = "2026-11-06", source = "CENTRAL_DIRECT", phone = "3001234567" } = {}) {
    const id = randomUUID(), creditId = nextCreditId++, direct = source === "CENTRAL_DIRECT";
    await db.query(`INSERT INTO "Credito" VALUES($1,$2,'Cliente sintético',$3,'ACTIVO',700000,true,'2026-11-02')`, [creditId, `FNS-${creditId}`, phone]);
    await db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"installmentNumber","installmentDueDate",
      "expiresOn","promiseAmount","promiseDate",reason,observation,"createdByUserId","createdByName","decidedByUserId","decidedByName",
      "decidedAt","createIdempotencyKey","createRequestHash")
      VALUES($1::uuid,$2,'PRORROGA','APPROVED',$3,$4,$5::date,$6::date,$7,$8::date,'Acuerdo registrado','Condición original',1,'Administradora',1,'Administradora',$9::timestamptz,$10::uuid,$11)`,
    [id, creditId, source, direct ? null : 2, direct ? null : "2026-11-02", expiresOn, direct ? null : 120000,
      direct ? null : "2026-11-05", instant, randomUUID(), "a".repeat(64)]);
    await db.query(`UPDATE "CreditMoraExceptionRequest" SET "activationWhatsApp"="activationWhatsApp"||$2::jsonb WHERE id=$1::uuid`,
      [id, JSON.stringify({ nextAttemptAt: new Date(clock).toISOString() })]);
    return { id, creditId };
  }
  const raw = async id => (await db.query(`SELECT "activationWhatsApp" FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [id])).rows[0].activationWhatsApp;
  const conditions = async id => (await db.query(`SELECT to_jsonb(r)-'activationWhatsApp' AS request,to_jsonb(c) AS credit
    FROM "CreditMoraExceptionRequest" r JOIN "Credito" c ON c.id=r."creditoId" WHERE r.id=$1::uuid`, [id])).rows[0];
  const statuses = events => meta.ingest({ scope, messages: [], statuses: events, ignored: 0 });
  return { db, env, service, insert, raw, conditions, statuses, requests, sends,
    advance(ms) { clock += ms; }, now: () => new Date(clock), get messages() { return messages; } };
}

test("dos workers reclaman una activación una sola vez y el replay no toca condiciones ni crédito", async t => {
  const f = await fixture(t), row = await f.insert({ source: "ANALYST_REQUEST" }), before = await f.conditions(row.id);
  const reports = await Promise.all([f.service().run({ limit: 1 }), f.service().run({ limit: 1 })]);
  assert.equal(reports.reduce((total, report) => total + report.selected, 0), 1);
  assert.equal(f.messages, 1);
  const result = await f.service().read(row.id);
  assert.equal(result.status, "SENT"); assert.equal(result.approvedDays, 3); assert.equal(result.authorizedByName, "Administradora");
  assert.equal(result.canRetry, false); assert.ok(result.sentAt); assert.equal(result.attempts, 1);
  assert.deepEqual(f.sends[0].template.components[0].parameters, [{ type: "text", text: "Cliente sintético" }, { type: "text", text: "3" }]);
  assert.equal((await f.service().run()).selected, 0); assert.equal(f.messages, 1);
  assert.deepEqual(await f.conditions(row.id), before, "WhatsApp no altera versión, condiciones, mora ni pago");
  await assert.rejects(f.service().retry(row.id, actor), error => error.code === "WHATSAPP_RETRY_UNAVAILABLE");
});

test("rechazo definitivo permite reintentar con nueva operación conservando la activación", async t => {
  const f = await fixture(t, { post: (body, attempt) => attempt === 1 ? reply({ error: { code: 131026 } }, 400)
    : reply({ messaging_product: "whatsapp", contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: "wamid.retry-success" }] }) });
  const row = await f.insert(), before = await f.conditions(row.id), activation = await f.raw(row.id);
  assert.equal((await f.service().run({ limit: 1 })).failed, 1);
  const failure = await f.service().read(row.id); assert.equal(failure.status, "FAILED"); assert.equal(failure.canRetry, true);
  assert.equal((await f.service().run({ limit: 1 })).selected, 0, "el backoff impide reenvío inmediato");
  assert.equal((await f.service().retry(row.id, actor)).status, "PENDING");
  assert.equal((await f.service().run({ limit: 1 })).sent, 1); assert.equal(f.messages, 2);
  const keys = (await f.db.query('SELECT "operationKey",status FROM "WhatsAppAutomationMetaOutbox" ORDER BY "operationKey"')).rows;
  assert.equal(keys.length, 2); assert.notEqual(keys[0].operationKey, keys[1].operationKey);
  assert.deepEqual(keys.map(item => item.status), ["failed", "accepted"]);
  const result = await f.service().read(row.id); assert.equal(result.attempts, 2); assert.equal(result.activatedAt, new Date(activation.activatedAt).toISOString());
  assert.deepEqual(await f.conditions(row.id), before);
});

test("timeout conserva la operación y el cron recupera sin duplicar hasta que el webhook concilia", async t => {
  const f = await fixture(t, { post: () => { throw new Error("Simulated loss after POST"); } }), row = await f.insert();
  assert.equal((await f.service().run({ limit: 1 })).pending, 1); assert.equal(f.messages, 1);
  const first = await f.raw(row.id); assert.ok(first.operationKey);
  const pending = await f.service().read(row.id); assert.equal(pending.status, "PENDING"); assert.equal(pending.canRetry, false);
  await assert.rejects(f.service().retry(row.id, actor), error => error.code === "WHATSAPP_RETRY_UNAVAILABLE");
  f.advance(60_000);
  assert.equal((await f.service().run({ limit: 1 })).pending, 1); assert.equal(f.messages, 1);
  assert.equal((await f.raw(row.id)).operationKey, first.operationKey); assert.equal((await f.raw(row.id)).attempts, 1);
  const [outbox] = (await f.db.query('SELECT id FROM "WhatsAppAutomationMetaOutbox"')).rows;
  await f.statuses([{ id: "wamid.late-confirmation", recipient: "573001234567", timestamp: f.now().toISOString(), status: "delivered", errorCodes: [], requestId: outbox.id }]);
  const reconciled = await f.service().read(row.id); assert.equal(reconciled.status, "SENT"); assert.ok(reconciled.sentAt);
  assert.equal(reconciled.error, null); assert.equal((await f.raw(row.id)).status, "PENDING", "el getter consulta el recibo firmado durable");
  f.advance(60_000);
  assert.equal((await f.service().run({ limit: 1 })).sent, 1); assert.equal(f.messages, 1);
  assert.equal((await f.raw(row.id)).status, "SENT");
});

test("cancelación y vencimiento previos evitan cualquier POST y no cambian la decisión", async t => {
  const f = await fixture(t), cancelled = await f.insert(), expired = await f.insert();
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [cancelled.id]);
  f.advance(4 * 86_400_000);
  const before = await Promise.all([f.conditions(cancelled.id), f.conditions(expired.id)]);
  const report = await f.service().run(); assert.equal(report.failed, 2); assert.equal(f.messages, 0); assert.equal(f.requests.length, 0);
  for (const row of [cancelled, expired]) {
    const result = await f.service().read(row.id); assert.equal(result.status, "FAILED"); assert.equal(result.canRetry, false);
  }
  assert.deepEqual(await Promise.all([f.conditions(cancelled.id), f.conditions(expired.id)]), before);
});

test("el guard vuelve a revisar cancelación justo antes del POST final", async t => {
  let target;
  const f = await fixture(t, { beforeNative: async ({ db }) => {
    await db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [target]);
  } });
  const row = await f.insert(); target = row.id;
  const report = await f.service().run({ limit: 1 }); assert.equal(report.failed, 1); assert.equal(f.messages, 0);
  const current = (await f.db.query(`SELECT status,version FROM "CreditMoraExceptionRequest" WHERE id=$1::uuid`, [row.id])).rows[0];
  assert.deepEqual(current, { status: "CANCELLED", version: 2 });
  assert.equal((await f.service().read(row.id)).canRetry, false);
});

for (const field of ["phone", "name"]) test(`el guard detecta cambio de ${field} durante preparación y el reintento usa el contacto actualizado`, async t => {
  let target, changed = false;
  const f = await fixture(t, { beforeTemplateMetadata: async ({ db }) => {
    if (changed) return;
    changed = true;
    if (field === "phone") await db.query(`UPDATE "Credito" SET "clienteTelefono"='3009876543' WHERE id=$1`, [target]);
    else await db.query(`UPDATE "Credito" SET "clienteNombre"='Nombre corregido' WHERE id=$1`, [target]);
  } });
  const row = await f.insert(); target = row.creditId;
  const first = await f.service().run({ limit: 1 });
  assert.equal(first.failed, 1); assert.equal(f.messages, 0, "la validación final impide usar el contacto anterior");
  const failure = await f.raw(row.id);
  assert.equal(failure.error, "EXTENSION_CONTACT_CHANGED"); assert.equal(failure.nextAttemptAt, null);
  assert.equal((await f.service().read(row.id)).canRetry, true);
  f.advance(3_600_000);
  assert.equal((await f.service().run({ limit: 1 })).selected, 0, "una corrección de contacto requiere el reintento autorizado");
  const before = await f.conditions(row.id);
  await f.service().retry(row.id, actor);
  assert.equal((await f.service().run({ limit: 1 })).sent, 1); assert.equal(f.messages, 1);
  assert.equal(f.sends[0].to, field === "phone" ? "573009876543" : "573001234567");
  assert.equal(f.sends[0].template.components[0].parameters[0].text, field === "name" ? "Nombre corregido" : "Cliente sintético");
  assert.deepEqual(await f.conditions(row.id), before, "la notificación y su reintento conservan el crédito y la autorización");
});

test("reintento revalida permisos actuales y actualiza contacto sin tocar condiciones", async t => {
  const f = await fixture(t), row = await f.insert({ phone: "INVALID" });
  await f.service().run({ limit: 1 }); assert.equal(f.messages, 0);
  const failed = await f.raw(row.id);
  for (const invalidActor of [{ id: 3, nombre: "Vendedor", centralAdmin: false }, { id: 4, nombre: "Inactiva", centralAdmin: true },
    { id: 2, nombre: "Administrador falsificado", centralAdmin: true }]) {
    await assert.rejects(f.service().retry(row.id, invalidActor), error => error.code === "FORBIDDEN");
    assert.deepEqual(await f.raw(row.id), failed, "un usuario no autorizado no cambia intentos ni el destinatario");
  }
  await f.db.query(`UPDATE "Credito" SET "clienteTelefono"='3009876543',"clienteNombre"='Nombre corregido' WHERE id=$1`, [row.creditId]);
  const before = await f.conditions(row.id);
  const result = await f.service().retry(row.id, { id: 2, nombre: "Analista", centralAdmin: false });
  assert.equal(result.status, "PENDING"); await f.service().run({ limit: 1 });
  assert.equal(f.messages, 1); assert.equal(f.sends[0].to, "573009876543");
  assert.equal(f.sends[0].template.components[0].parameters[0].text, "Nombre corregido");
  assert.deepEqual(await f.conditions(row.id), before);
});

test("un webhook confirmado conserva enviado aunque la prórroga se cancele antes de recuperarse", async t => {
  const f = await fixture(t, { post: () => { throw new Error("Simulated lost ACK"); } }), row = await f.insert();
  await f.service().run({ limit: 1 });
  const [outbox] = (await f.db.query('SELECT id FROM "WhatsAppAutomationMetaOutbox"')).rows;
  await f.statuses([{ id: "wamid.confirmed-before-cancel", recipient: "573001234567", timestamp: f.now().toISOString(), status: "sent", errorCodes: [], requestId: outbox.id }]);
  await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED',version=version+1 WHERE id=$1::uuid`, [row.id]);
  assert.equal((await f.service().read(row.id)).status, "SENT");
  f.advance(60_000); await f.service().run({ limit: 1 });
  assert.equal((await f.service().read(row.id)).status, "SENT", "conciliar no debe perder la referencia al mensaje ya enviado");
  assert.equal(f.messages, 1);
});

test("incertidumbre tras vencer conserva correlación y permite conciliar sin otro POST", async t => {
  const f = await fixture(t, { post: () => { throw new Error("Simulated lost ACK"); } }), row = await f.insert();
  await f.service().run({ limit: 1 });
  const initial = await f.raw(row.id), [outbox] = (await f.db.query('SELECT id FROM "WhatsAppAutomationMetaOutbox"')).rows;
  f.advance(4 * 86_400_000);
  assert.equal((await f.service().run({ limit: 1 })).pending, 1);
  assert.equal((await f.raw(row.id)).operationKey, initial.operationKey);
  assert.equal((await f.service().read(row.id)).canRetry, false); assert.equal(f.messages, 1);
  await f.statuses([{ id: "wamid.confirmed-after-expiry", recipient: "573001234567", timestamp: f.now().toISOString(), status: "delivered", errorCodes: [], requestId: outbox.id }]);
  assert.equal((await f.service().read(row.id)).status, "SENT");
  f.advance(60_000); assert.equal((await f.service().run({ limit: 1 })).sent, 1); assert.equal(f.messages, 1);
});

test("fallo de entrega firmado admite solo reintento manual con una nueva operación", async t => {
  const f = await fixture(t), row = await f.insert(), before = await f.conditions(row.id);
  await f.service().run({ limit: 1 });
  const [outbox] = (await f.db.query('SELECT id,wamid FROM "WhatsAppAutomationMetaOutbox"')).rows;
  await f.statuses([{ id: outbox.wamid, recipient: "573001234567", timestamp: f.now().toISOString(), status: "failed", errorCodes: [131026], requestId: outbox.id }]);
  const failed = await f.service().read(row.id); assert.equal(failed.status, "FAILED"); assert.equal(failed.canRetry, true);
  f.advance(3_600_000); assert.equal((await f.service().run({ limit: 1 })).selected, 0); assert.equal(f.messages, 1);
  await f.service().retry(row.id, actor);
  assert.equal((await f.service().run({ limit: 1 })).sent, 1); assert.equal(f.messages, 2);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "WhatsAppAutomationMetaOutbox"')).rows[0].n, 2);
  assert.deepEqual(await f.conditions(row.id), before);
});

test("integración deshabilitada deja pendiente para el worker sin enviar ni reclamar", async t => {
  const f = await fixture(t, { env: { WHATSAPP_ATTENTION_SEND_ENABLED: "false" } }), row = await f.insert(), before = await f.raw(row.id);
  const result = await f.service().run(); assert.equal(result.configured, false); assert.equal(result.selected, 0);
  assert.deepEqual(await f.raw(row.id), before); assert.equal(f.messages, 0); assert.equal(f.requests.length, 0);
  assert.equal(plain(await f.service().read(row.id)).status, "PENDING");
});
