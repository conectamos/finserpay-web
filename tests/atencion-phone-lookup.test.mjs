import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root, "server-only": path.join(root, "node_modules/next/dist/compiled/server-only/empty.js") } });
const { createAttentionStore } = await jiti.import("../lib/atencion-storage.ts");
const migration = readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8");
const central = { userId: 1, sellerId: null, key: "admin:1", name: "Central de prueba", central: true, admin: true, analyst: false, supervisor: false, aliadoId: 1, sedeId: 10 };
const analyst = { ...central, userId: 5, key: "analyst:5", name: "Analista de prueba", central: false, admin: false, analyst: true };
const otherAnalyst = { ...analyst, userId: 6, key: "analyst:6" };
const phone = "+573001234567";
function adapter(db, calls) {
  return { $queryRawUnsafe: async (sql, ...values) => { calls.push({ sql, values }); return (await db.query(sql, values)).rows; }, $transaction: fn => db.transaction(tx => fn(adapter(tx, calls))) };
}
async function fixture(t, install = true) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa boolean);
    CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,"sedeId" int,"rolId" int,activo boolean);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY,nombre text);
    CREATE TABLE "Credito"(id int PRIMARY KEY);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'USUARIO'),(3,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true),(2,'ALIADO',true);
    INSERT INTO "Sede" VALUES(10,'Central de prueba',1,true),(20,'Sede de prueba',2,true);
    INSERT INTO "Usuario" VALUES(1,'Central de prueba',10,1,true),(2,'Cuenta comercial',20,1,true),(5,'Analista de prueba',10,3,true),(6,'Otro analista',10,3,true);
    INSERT INTO "Vendedor" VALUES(99,'Asesor de prueba');`);
  if (install) await db.exec(migration);
  const calls = [], store = createAttentionStore(adapter(db, calls));
  const seed = async (overrides = {}) => {
    const row = { id: randomUUID(), name: "Contacto artificial", phone, channel: "whatsapp", status: "pending", assigneeUserId: null, assigneeKey: null, assigneeSellerId: null, ...overrides };
    await db.query('INSERT INTO "AttentionConversation"(id,name,phone,channel,status,"assigneeUserId","assigneeKey","assigneeSellerId",tags) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [row.id,row.name,row.phone,row.channel,row.status,row.assigneeUserId,row.assigneeKey,row.assigneeSellerId,["Etiqueta privada de prueba"]]);
    return row;
  };
  const work = async row => db.query('INSERT INTO "AttentionWorkRequest"(id,"conversationId",kind,"targetSource","targetId","sellerId","userId","sedeId","aliadoId") VALUES($1,$2,\'enrollment\',\'D\',100,99,2,20,2)', [randomUUID(),row.id]);
  return { db, calls, store, seed, work };
}

test("búsqueda exacta normaliza Colombia sin prefijos, sufijos ni coincidencias ILIKE y omite chats internos/solicitudes", async t => {
  const f = await fixture(t), expected = await f.seed({ status: "closed" });
  await f.seed({ phone: "+5730012345678" }); await f.seed({ phone: "+13001234567" }); await f.seed({ phone: "+573001234568" });
  await f.seed({ channel: "internal" }); await f.work(await f.seed({ name: "Solicitud que no debe aparecer" }));
  const before = (await f.db.query('SELECT id,status,version,"assigneeKey" FROM "AttentionConversation" ORDER BY id')).rows;
  for (const input of ["3001234567", "300 123 4567", "+57 (300) 123-4567", "00573001234567", phone]) {
    const result = await f.store.findAttentionConversationsByPhone(central, input);
    assert.deepEqual(result, { matches: [{ id: expected.id, name: expected.name, phone, status: "closed" }], total: 1 });
    assert.deepEqual(Object.keys(result.matches[0]).sort(), ["id","name","phone","status"]);
  }
  const queries = f.calls.filter(call => call.sql.includes("NOT EXISTS") && call.sql.includes('"AttentionWorkRequest"'));
  assert.ok(queries.length >= 10); assert.ok(queries.every(call => !/ILIKE|LIKE\s/i.test(call.sql) && !call.sql.includes(phone) && call.values.at(-1) === phone));
  assert.deepEqual((await f.db.query('SELECT id,status,version,"assigneeKey" FROM "AttentionConversation" ORDER BY id')).rows, before);
  for (const table of ["AttentionAudit","AttentionRequest","AttentionMetaBinding","AttentionMetaOutbox","AttentionMetaDelivery"]) assert.equal((await f.db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n, 0);
});

test("coincidencias duplicadas permanecen explícitas: devuelve hasta diez con total sin elegir ni crear", async t => {
  const f = await fixture(t), ids = [];
  for (let i = 0; i < 13; i++) ids.push((await f.seed({ name: `Contacto artificial ${i}`, status: i % 2 ? "open" : "pending" })).id);
  const result = await f.store.findAttentionConversationsByPhone(central, phone);
  assert.equal(result.total, 13); assert.equal(result.matches.length, 10); assert.ok(result.matches.every(match => ids.includes(match.id)));
  assert.equal(new Set(result.matches.map(match => match.id)).size, 10);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n, 13);
  assert.deepEqual(await f.store.findAttentionConversationsByPhone(central, "+573009999999"), { matches: [], total: 0 });
});

test("filas y total respetan al analista nominal y retiran inmediatamente chats transferidos", async t => {
  const f = await fixture(t), mine = await f.seed({ assigneeUserId: 5, assigneeKey: "analyst:5" });
  await f.seed({ assigneeUserId: 6, assigneeKey: "analyst:6" }); await f.seed();
  await f.seed({ assigneeUserId: 5, assigneeKey: "analyst:6" }); await f.seed({ assigneeUserId: 5, assigneeKey: "analyst:5", assigneeSellerId: 99 });
  await f.seed({ channel: "internal", assigneeUserId: 5, assigneeKey: "analyst:5" });
  await f.work(await f.seed({ assigneeUserId: 5, assigneeKey: "analyst:5" }));
  const own = await f.store.findAttentionConversationsByPhone(analyst, phone);
  assert.equal(own.total, 1); assert.deepEqual(own.matches.map(match => match.id), [mine.id]);
  assert.equal((await f.store.findAttentionConversationsByPhone(otherAnalyst, phone)).total, 1);
  assert.equal((await f.store.findAttentionConversationsByPhone(central, phone)).total, 5);
  await f.db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=6,"assigneeKey"=\'analyst:6\' WHERE id=$1', [mine.id]);
  assert.deepEqual(await f.store.findAttentionConversationsByPhone(analyst, phone), { matches: [], total: 0 });
  assert.equal((await f.store.findAttentionConversationsByPhone(otherAnalyst, phone)).total, 2);
});

test("cada lectura vuelve a validar usuario, rol, sede y aliado; no acepta un perfil comercial", async t => {
  const f = await fixture(t); await f.seed({ assigneeUserId: 5, assigneeKey: "analyst:5" });
  for (const [change, reset] of [
    ['UPDATE "Usuario" SET activo=false WHERE id=5','UPDATE "Usuario" SET activo=true WHERE id=5'],
    ['UPDATE "Usuario" SET "rolId"=1 WHERE id=5','UPDATE "Usuario" SET "rolId"=3 WHERE id=5'],
    ['UPDATE "Sede" SET activa=false WHERE id=10','UPDATE "Sede" SET activa=true WHERE id=10'],
    ['UPDATE "Aliado" SET activo=false WHERE id=1','UPDATE "Aliado" SET activo=true WHERE id=1'],
  ]) { await f.db.exec(change); await assert.rejects(f.store.findAttentionConversationsByPhone(analyst, phone), { status: 403 }); await f.db.exec(reset); }
  await assert.rejects(f.store.findAttentionConversationsByPhone({ ...central, userId: 2, key: "admin:2", sedeId: 20, aliadoId: 2 }, phone), { status: 403 });
  await assert.rejects(f.store.findAttentionConversationsByPhone({ ...analyst, sellerId: 99, key: "seller:99" }, phone), { status: 403 });
});

test("datos de teléfono inválidos y esquemas pendientes fallan sin consultas amplias ni preparación automática", async t => {
  const f = await fixture(t);
  for (const input of [undefined,null,{},[],3001234567,"","   ","cliente","%3001234567","3001234567' OR true --","3001234567 ext 2","3".repeat(41)]) await assert.rejects(f.store.findAttentionConversationsByPhone(central, input), { status: 400 });
  assert.equal(f.calls.length, 0);
  await f.db.exec('DROP TABLE "AttentionWorkRequest" CASCADE'); await assert.rejects(f.store.findAttentionConversationsByPhone(central, phone), { status: 503 });
  const pending = await fixture(t, false); await assert.rejects(pending.store.findAttentionConversationsByPhone(central, phone), { status: 503 });
  assert.ok(f.calls.every(call => !/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(call.sql)));
});

function compile(file, mocks) {
  const mod = { exports: {} }, source = ts.transpileModule(readFileSync(path.join(root,file),"utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require","module","exports",source)(name => { assert.ok(name in mocks, `No live dependency allowed: ${name}`); return mocks[name]; },mod,mod.exports);
  return mod.exports;
}
const core = compile("lib/atencion-core.ts", {});
class AttentionDaptaError extends Error {}
class AttentionMetaError extends Error {}
const http = compile("lib/atencion-http.ts", { "./atencion-core": core, "./atencion-dapta": { AttentionDaptaError }, "./atencion-meta": { AttentionMetaError } });
function route(options = {}) {
  const calls = { access: 0, lookup: [] }, lookup = options.result || { matches: [], total: 0 };
  const handlers = compile("app/api/atencion/phone/route.ts", {
    "@/lib/atencion-core": { ...core, getAttentionAccess: async () => { calls.access++; if(options.accessError) throw options.accessError; return analyst; } },
    "@/lib/atencion-storage": { findAttentionConversationsByPhone: async (...args) => { calls.lookup.push(args); if(options.storeError) throw options.storeError; return lookup; } },
    "@/lib/atencion-http": http,
  });
  return { ...handlers, calls };
}
const request = query => new Request("https://finser.example/api/atencion/phone" + (query ? "?" + query : ""));
const privateResponse = response => { assert.match(response.headers.get("cache-control"),/private, no-store/); assert.equal(response.headers.get("vary"),"Cookie"); assert.equal(response.headers.get("x-content-type-options"),"nosniff"); };

test("GET exige sesión y un único teléfono válido; normaliza antes de acceder y devuelve respuesta privada", async () => {
  const denied = route({ accessError: new core.AttentionError("Sesión requerida",401) }), unavailable = await denied.GET(request("phone=3001234567"));
  assert.equal(unavailable.status,401); assert.equal(denied.calls.lookup.length,0); privateResponse(unavailable);
  const f = route(), response = await f.GET(request("phone=" + encodeURIComponent("+57 (300) 123-4567")));
  assert.equal(response.status,200); assert.deepEqual(f.calls.lookup,[[analyst,phone]]); assert.deepEqual(await response.json(),{matches:[],total:0}); privateResponse(response);
  for (const query of ["","phone=","phone=cliente","phone=%25","phone=3001234567&phone=3001234567","phone[]=3001234567","phone=3001234567&userId=1","phone="+"3".repeat(41)]) {
    const invalid = route(), result = await invalid.GET(request(query)); assert.equal(result.status,400,query); assert.equal(invalid.calls.lookup.length,0); privateResponse(result);
  }
  assert.equal(f.POST,undefined);
});

test("GET conserva denegación/revocación y oculta fallos internos sin llamar a proveedores", async () => {
  for (const status of [403,503]) { const f = route({ storeError:new core.AttentionError("Acceso no disponible",status) }), response = await f.GET(request("phone=3001234567")); assert.equal(response.status,status); privateResponse(response); }
  const f = route({ storeError:new Error("SQL postgresql://credential.invalid DO_NOT_EXPOSE") }), response = await f.GET(request("phone=3001234567"));
  assert.equal(response.status,500); assert.doesNotMatch(JSON.stringify(await response.json()),/credential|SQL|DO_NOT_EXPOSE/); privateResponse(response);
});
