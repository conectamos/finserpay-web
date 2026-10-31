import assert from "node:assert/strict";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createAttentionWorkStore } = await jiti.import("../lib/atencion-work-storage.ts");
const { createAttentionPushStore } = await jiti.import("../lib/atencion-push-storage.ts");
const { dispatchAttentionPush } = await jiti.import("../lib/atencion-push-worker.ts");
const { validateAttentionPushSubscription, attentionPushPayload, attentionPushRetry } = await jiti.import("../lib/atencion-push-core.ts");
const migrations = ["setup-atencion.sql", "setup-atencion-push.sql"].map(file => readFileSync(path.join(root, "scripts", file), "utf8"));
const admin = { type: "attention", actor: { userId: 1, sellerId: null, key: "admin:1", name: "Central", central: true, admin: true, analyst: false, supervisor: false, aliadoId: 1, sedeId: 10 } };
const analyst = { type: "attention", actor: { ...admin.actor, userId: 5, key: "analyst:5", name: "Analista", central: false, admin: false, analyst: true } };
const seller = { type: "seller", userId: 2, userSedeId: 20, sellerId: 11, sedeId: 20, accessSedeId: 20, aliadoId: 2, supervisor: false, name: "Asesor", key: "seller:2:11" };
function adapter(db) { return { $queryRawUnsafe: async (sql, ...values) => { const result = await db.query(sql, values); assert.ok(!result.fields?.some(f => f.dataTypeID === 2278)); return result.rows; }, $transaction: fn => db.transaction(tx => fn(adapter(tx))) }; }
function subscription(suffix = randomUUID()) {
  const key = createECDH("prime256v1"); key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: key.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
}
async function fixture(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`
    CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text); CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,nombre text,activo bool);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa bool);
    CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,"sedeId" int,"rolId" int,activo bool);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY,nombre text,activo bool,"debeCambiarPin" bool,"tipoPerfil" text);
    CREATE TABLE "SedeVendedor"("sedeId" int,"vendedorId" int,activo bool);
    CREATE TABLE "Credito"(id int PRIMARY KEY,"clienteNombre" text,"clienteDocumento" text,imei text,plataforma text,estado text,"vendedorId" int,"sedeId" int);
    CREATE TABLE "CreditoBorrador"(LIKE "Credito" INCLUDING ALL);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY','FINSER',true),(2,'TIENDA','Tienda',true);
    INSERT INTO "Sede" VALUES(10,'Central',1,true),(20,'Sede tienda',2,true);
    INSERT INTO "Usuario" VALUES(1,'Central',10,1,true),(2,'Sede',20,2,true),(5,'Analista',10,3,true),(6,'Otro analista',10,3,true);
    INSERT INTO "Vendedor" VALUES(11,'Asesor',true,false,'VENDEDOR'),(12,'Otro asesor',true,false,'VENDEDOR');
    INSERT INTO "SedeVendedor" VALUES(20,11,true),(20,12,true);
    INSERT INTO "CreditoBorrador" VALUES(100,'Cliente sintético privado','12345','123456789012345','IPHONE','PROCESO',11,20);
    INSERT INTO "Credito" VALUES(200,'Cliente bienvenida sintético','12345','123456789012345','IPHONE','ACTIVO',11,20);
  `);
  for (const migration of migrations) await db.exec(migration);
  const database = adapter(db), store = createAttentionWorkStore(database), push = createAttentionPushStore(database);
  const create = () => store.create(seller, { requestId: randomUUID(), kind: "enrollment", target: "D-100", text: "Datos privados que no van al push" });
  const mutate = (detail, actor, action, extra = {}) => store.mutate(actor, detail.item.id, { requestId: randomUUID(), version: detail.item.version, action, ...extra });
  return { db, database, store, push, create, mutate };
}

test("push acepta proveedores conocidos y rechaza SSRF, credenciales URL y claves falsas", () => {
  const valid = subscription();
  for (const endpoint of [valid.endpoint, "https://web.push.apple.com/QABC", "https://updates.push.services.mozilla.com/wpush/v2/test", "https://wns2.notify.windows.com/test"]) {
    assert.equal(validateAttentionPushSubscription({ ...valid, endpoint }).endpoint, endpoint);
  }
  for (const endpoint of ["https://127.0.0.1/private", "https://localhost/x", "http://fcm.googleapis.com/x", "https://fcm.googleapis.com.attacker.test/x", "https://attacker.test/push.apple.com", "https://name:pass@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", valid.endpoint + "#secret", "https://push.apple.com.attacker.test/x"]) {
    assert.throws(() => validateAttentionPushSubscription({ ...valid, endpoint }));
  }
  for (const keys of [{ ...valid.keys, auth: "short" }, { ...valid.keys, p256dh: randomBytes(65).toString("base64url") }, { auth: valid.keys.auth }]) {
    assert.throws(() => validateAttentionPushSubscription({ ...valid, keys }));
  }
});

test("payload de pantalla bloqueada es genérico y reintentos son acotados", () => {
  const payload = attentionPushPayload("test-event", "reply", "enrollment");
  assert.equal(payload.tag, "work-test-event");
  assert.equal(payload.url, "/dashboard?notifications=1");
  assert.equal(Object.keys(payload).sort().join(","), "body,tag,title,url");
  assert.equal(attentionPushRetry(410, 1).remove, true);
  assert.equal(attentionPushRetry(404, 1).remove, true);
  assert.equal(attentionPushRetry(429, 1).terminal, false);
  assert.equal(attentionPushRetry(503, 6).terminal, true);
  assert.equal(attentionPushRetry(400, 1).terminal, true);
});

test("suscripción se liga al perfil activo, no permite bajas ajenas y exige reactivar al cambiar perfil", async t => {
  const f = await fixture(t), device = subscription();
  const first = await f.push.subscribe(admin, device);
  assert.equal((await f.push.status(admin, device.endpoint)).subscribed, true);
  assert.equal((await f.push.status(seller, device.endpoint)).subscribed, false);
  await f.push.unsubscribe(seller, device.endpoint);
  assert.equal((await f.push.status(admin, device.endpoint)).subscribed, true);
  const rebound = await f.push.subscribe(seller, device);
  assert.equal(first.id, rebound.id);
  assert.equal((await f.push.status(admin, device.endpoint)).subscribed, false);
  assert.equal((await f.push.status(seller, device.endpoint)).subscribed, true);
  await f.db.query('UPDATE "Vendedor" SET activo=false WHERE id=11');
  await assert.rejects(f.push.subscribe(seller, subscription()), { status: 403 });
  await assert.rejects(f.push.status(seller, device.endpoint), { status: 403 });
});

test("cada perfil admite hasta diez dispositivos y una baja libera el cupo", async t => {
  const f = await fixture(t), devices = Array.from({ length: 10 }, () => subscription());
  for (const device of devices) await f.push.subscribe(admin, device);
  await f.push.subscribe(admin, devices[0]);
  await assert.rejects(f.push.subscribe(admin, subscription()), { status: 409 });
  await f.push.unsubscribe(admin, devices[0].endpoint);
  await f.push.subscribe(admin, subscription());
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionPushSubscription"')).rows[0].n, 10);
});

test("worker entrega un aviso nuevo una vez y conserva mensajes privados fuera del payload", async t => {
  const f = await fixture(t), device = subscription(), calls = [];
  await f.push.subscribe(analyst, device); await f.create();
  const send = async (sub, payload) => calls.push({ sub, payload: JSON.parse(payload) });
  assert.equal((await dispatchAttentionPush(f.database, send)).sent, 1);
  assert.equal((await dispatchAttentionPush(f.database, send)).sent, 0);
  assert.equal(calls.length, 1); assert.equal(calls[0].sub.endpoint, device.endpoint);
  assert.doesNotMatch(JSON.stringify(calls[0].payload), /12345|Cliente sintético|Datos privados/);
  assert.equal((await f.db.query('SELECT attempts FROM "AttentionPushDelivery"')).rows[0].attempts, 1);
});

test("fallo temporal persiste y reintenta al vencer plazo; 410 elimina el dispositivo", async t => {
  const f = await fixture(t), device = subscription();
  await f.push.subscribe(analyst, device); await f.create();
  assert.equal((await dispatchAttentionPush(f.database, async () => { throw Object.assign(new Error("synthetic"), { statusCode: 503 }); })).failed, 1);
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Retry too early"))).processed, 0);
  await f.db.query('UPDATE "AttentionPushDelivery" SET "nextAttemptAt"=now()-interval \'1 second\'');
  assert.equal((await dispatchAttentionPush(f.database, async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); })).failed, 1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionPushSubscription"')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionPushDelivery"')).rows[0].n, 0);
});

test("dos workers no envían simultáneamente la misma entrega", async t => {
  const f = await fixture(t); await f.push.subscribe(analyst, subscription()); await f.create();
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  let count = 0;
  const first = dispatchAttentionPush(f.database, async () => { count++; entered(); await gate; });
  await started;
  const second = await dispatchAttentionPush(f.database, async () => { count++; });
  assert.equal(second.processed, 0); release(); await first; assert.equal(count, 1);
});

test("avisos leídos, anteriores al alta, dispositivos vencidos y analistas revocados no se envían", async t => {
  const f = await fixture(t); await f.create();
  await f.push.subscribe(analyst, subscription());
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Old alert"))).sent, 0);
  await f.db.query('UPDATE "AttentionPushSubscription" SET "createdAt"=now()-interval \'1 day\',"expiresAt"=now()-interval \'1 second\'');
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Expired subscription"))).sent, 0);
  await f.db.query('UPDATE "AttentionPushSubscription" SET "expiresAt"=now()+interval \'1 day\'');
  await f.db.query('UPDATE "Usuario" SET activo=false WHERE id=5');
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Revoked analyst"))).sent, 0);
  await f.db.query('UPDATE "Usuario" SET activo=true WHERE id=5');
  await f.db.query('UPDATE "AttentionWorkNotification" SET "readAt"=now()');
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Read alert"))).sent, 0);
});

test("una transferencia cancela avisos privados pendientes al analista anterior", async t => {
  const f = await fixture(t); await f.push.subscribe(analyst, subscription()); let d = await f.create();
  await f.db.query('UPDATE "AttentionWorkNotification" SET "readAt"=now() WHERE kind=\'created\'');
  d = await f.mutate(d, admin, "assign", { assigneeKey: "analyst:5" });
  await dispatchAttentionPush(f.database, async () => { throw Object.assign(new Error("retry"), { statusCode: 503 }); });
  d = await f.mutate(d, admin, "assign", { assigneeKey: "analyst:6" });
  await f.db.query('UPDATE "AttentionPushDelivery" SET "nextAttemptAt"=now()-interval \'1 second\'');
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Transferred case"))).sent, 0);
  assert.equal((await f.db.query('SELECT "errorCode" FROM "AttentionPushDelivery"')).rows[0].errorCode, "cancelled");
});

test("respuesta al asesor pierde elegibilidad si la venta deja de pertenecerle", async t => {
  const f = await fixture(t); await f.push.subscribe(seller, subscription()); let d = await f.create();
  d = await f.mutate(d, admin, "message", { text: "Soporte privado recibido" });
  await f.db.query('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');
  assert.equal((await dispatchAttentionPush(f.database, async () => assert.fail("Previous owner"))).sent, 0);
  await f.db.query('UPDATE "CreditoBorrador" SET "vendedorId"=11 WHERE id=100');
  let payload;
  assert.equal((await dispatchAttentionPush(f.database, async (_sub, body) => { payload = body; })).sent, 1);
  assert.match(payload, /Recibiste una respuesta/); assert.doesNotMatch(payload, /Soporte privado/);
});

function workerFixture(windows = []) {
  const events = {}, shown = [], opened = [];
  const self = {
    location: { origin: "https://finser.test" },
    addEventListener: (type, callback) => { events[type] = callback; },
    skipWaiting: async () => {},
    registration: { showNotification: async (...args) => { shown.push(args); } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async url => { opened.push(url); } },
  };
  runInNewContext(readFileSync(path.join(root, "public/dashboard/notifications-sw.js"), "utf8"), { self, URL });
  return { events, shown, opened };
}

test("service worker siempre muestra aviso visible y nunca usa un destino externo del payload", async () => {
  const f = workerFixture(); let completion;
  f.events.push({ data: { json: () => ({ body: "Aviso sintético", tag: "work-event", url: "https://attacker.test/" }) }, waitUntil: value => { completion = value; } });
  await completion;
  assert.equal(f.shown[0][0], "FINSER PAY · Solicitudes");
  assert.equal(f.shown[0][1].data.url, "/dashboard?notifications=1");
  f.events.push({ data: { json: () => { throw new Error("invalid JSON"); } }, waitUntil: value => { completion = value; } });
  await completion;
  assert.match(f.shown[1][1].body, /nueva notificación/);
  assert.equal("fetch" in f.events, false, "No cache of authenticated dashboards or APIs");
});

test("clic de push conserva borrador de una pestaña existente y abre la campana", async () => {
  const messages = []; let focused = 0, navigated = 0, closed = 0, completion;
  const f = workerFixture([{ url: "https://finser.test/dashboard/gestion-comercial", postMessage: message => messages.push(message), focus: async () => { focused++; }, navigate: async () => { navigated++; } }]);
  f.events.notificationclick({ notification: { close: () => { closed++; }, data: { url: "https://attacker.test/" } }, waitUntil: value => { completion = value; } });
  await completion;
  assert.equal(messages[0].type, "FINSERPAY_OPEN_NOTIFICATIONS"); assert.equal(focused, 1);
  assert.equal(navigated, 0); assert.equal(closed, 1); assert.equal(f.opened.length, 0);
});

test("clic sin dashboard abre exclusivamente la plataforma y no redirige el portal de clientes", async () => {
  let completion;
  const f = workerFixture([{ url: "https://finser.test/clientes", focus: () => assert.fail("Customer tab must stay untouched") }, { url: "https://attacker.test/dashboard", focus: () => assert.fail("Foreign origin") }]);
  f.events.notificationclick({ notification: { close: () => {} }, waitUntil: value => { completion = value; } });
  await completion;
  assert.deepEqual(f.opened, ["/dashboard?notifications=1"]);
});
