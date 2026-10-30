import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { createAttentionStore } = await jiti.import("../lib/atencion-storage.ts");
const migration = readFileSync(path.join(root, "scripts/setup-atencion.sql"), "utf8");
const central = { userId: 1, sellerId: null, key: "admin:1", name: "Central", central: true, admin: true, analyst: false, supervisor: false, aliadoId: 1, sedeId: 10 };
const ally = { ...central, userId: 2, key: "user:2", name: "Aliado", central: false, aliadoId: 2, sedeId: 20 };
const seller = { ...ally, userId: 3, sellerId: 100, key: "seller:100", name: "Asesora", admin: false };
const otherSeller = { ...seller, sellerId: 101, key: "seller:101", name: "Otro asesor" };
const supervisor = { ...seller, sellerId: 102, key: "seller:102", name: "Supervisor", supervisor: true };
const analyst = { ...central, userId: 5, key: "analyst:5", name: "Analista A", central: false, admin: false, analyst: true };
const otherAnalyst = { ...analyst, userId: 6, key: "analyst:6", name: "Analista B" };
const filters = { search: "", filter: "all", page: 1 };
const fixtureSql = `
CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean DEFAULT true);
CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer,activa boolean DEFAULT true);
CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean DEFAULT true,"sedeId" integer,"rolId" integer);
CREATE TABLE "Vendedor"(id integer PRIMARY KEY,nombre text,activo boolean DEFAULT true);
CREATE TABLE "SedeVendedor"("sedeId" integer,"vendedorId" integer,activo boolean DEFAULT true);
CREATE TABLE "Credito"(id integer PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,"clienteTelefono" text,
 "sedeId" integer,"vendedorId" integer,estado text,"referenciaEquipo" text,"equipoMarca" text,"equipoModelo" text,
 "montoCredito" float,"valorCuota" float,"plazoMeses" integer,"frecuenciaPago" text,"fechaPrimerPago" timestamp,"fechaProximoPago" timestamp,
 "pazYSalvoEmitidoAt" timestamp,"planCapitalVigente" jsonb,"contratoSnapshot" jsonb);
CREATE TABLE "CreditoAbono"(id integer PRIMARY KEY,"creditoId" integer,valor float,estado text,"anuladoAt" timestamp,"metodoPago" text,"fechaAbono" timestamp);
CREATE TABLE "DataCreditoAssessment"(id uuid PRIMARY KEY,"creditId" integer,status text,"createdAt" timestamp,"sedeId" integer,"aliadoId" integer,"sellerId" integer);
CREATE TABLE "CreditoBorrador"(id integer PRIMARY KEY,"creditoId" integer,"clienteNombre" text,"clienteDocumento" text,"clienteTelefono" text,
  "sedeId" integer,"vendedorId" integer,estado text,"dataCreditoAssessmentId" uuid,"createdAt" timestamp,payload jsonb);
INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');
INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true),(2,'ALIADO',true),(3,'OTRO',true);
INSERT INTO "Sede" VALUES(10,'Central',1,true),(20,'Sede propia',2,true),(21,'Otra sede propia',2,true),(30,'Ajena',3,true);
INSERT INTO "Usuario" VALUES(1,'Central',true,10,1),(2,'Aliado',true,20,1),(3,'Acceso sede',true,20,2),(4,'Admin ajeno',true,30,1);
INSERT INTO "Usuario" VALUES(5,'Analista A',true,10,3),(6,'Analista B',true,10,3),(7,'Analista inactivo',false,10,3),(8,'Analista aliado',true,20,3);
INSERT INTO "Vendedor" VALUES(100,'Asesora',true),(101,'Otro asesor',true),(102,'Supervisor',true),(200,'Ajeno',true),(300,'Inactivo',false);
INSERT INTO "SedeVendedor" VALUES(20,100,true),(20,101,true),(20,102,true),(30,200,true),(20,300,true);
INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono","sedeId","vendedorId",estado,"referenciaEquipo","montoCredito","valorCuota","plazoMeses","frecuenciaPago","fechaPrimerPago","contratoSnapshot") VALUES
 (1,'CR1','Persona uno','12345678','3001234567',20,100,'ACTIVO','Equipo A',300,100,3,'QUINCENAL','2026-11-02','{"secret":"DO_NOT_EXPOSE"}'),
 (2,'CR2','Persona uno','12345678','+573001234567',20,100,'ACTIVO','Equipo B',300,100,3,'QUINCENAL','2026-11-02','{}'),
 (3,'CR3','Persona ajena','9999','3001234567',30,200,'ACTIVO','Equipo C',300,100,3,'QUINCENAL','2026-11-02','{}'),
 (4,'CR4','Otro cliente','7777','3000000002',20,101,'ACTIVO','Equipo D',300,100,3,'QUINCENAL',null,'{}');
INSERT INTO "CreditoAbono" VALUES(1,1,100,'ACTIVO',null,'EFECTIVO','2026-10-30'),(2,1,100,'ANULADO','2026-10-30','EFECTIVO','2026-10-30');
INSERT INTO "DataCreditoAssessment" VALUES('00000000-0000-4000-8000-000000000001',1,'APROBADO','2026-10-30',20,2,100);
`;
function adapter(db) {
  return { $queryRawUnsafe: async (sql, ...values) => (await db.query(sql, values)).rows,
    $transaction: (fn) => db.transaction(tx => fn(adapter(tx))) };
}
async function fixture(t, install = true) {
  const db = new PGlite({ parsers: { 1114: value => new Date(`${value.replace(" ", "T")}Z`) } });
  t.after(() => db.close()); await db.exec(fixtureSql); if (install) await db.exec(migration);
  const store = createAttentionStore(adapter(db));
  const create = (actor = central, input = {}) => store.createAttentionCase(actor, { phone: "3001234567", name: "Contacto real", requestId: randomUUID(), ...input });
  const mutation = (action, data = {}) => ({ action, requestId: randomUUID(), version: 1, ...data });
  const act = async (actor, id, action, data = {}) => store.mutateAttentionConversation(actor, id, mutation(action, { version: (await store.getAttentionDetail(actor, id)).conversation.version, ...data }));
  const assign = (id, target = analyst) => act(central, id, "transfer", { assigneeKey: target.key });
  return { db, store, create, mutation, act, assign };
}

const snapshot = (data = {}) => ({ externalId: "provider-chat", phone: "+573001234567", name: "Contacto", mode: "ai",
  lastContactAt: null, historyTruncated: false, historyCursor: null, messages: [], ...data });
const message = (id, sentAt = new Date().toISOString()) => ({ id, direction: "inbound", text: "Consulta real", sentAt, author: null });

test("sin esquema: bandeja pendiente y escrituras rechazadas sin DDL por solicitud", async t => {
  const { store, create } = await fixture(t, false);
  assert.equal((await store.getAttentionInbox(central, filters)).schemaReady, false);
  await assert.rejects(create(), { status: 503 });
});

test("central ve bandeja global; analista solo asignados y pierde acceso tras transferencia", async t => {
  const { store, create, assign, act } = await fixture(t);
  const own = await create(); const other = await create(); await create();
  await assign(own.id); await assign(other.id, otherAnalyst);
  assert.equal((await store.getAttentionInbox(central, filters)).total, 3);
  assert.equal((await store.getAttentionInbox(analyst, filters)).total, 1);
  await assert.rejects(store.getAttentionDetail(analyst, other.id), { status: 404 });
  await assert.rejects(act(analyst, own.id, "transfer", { assigneeKey: otherAnalyst.key }), { status: 403 });
  await assign(own.id, otherAnalyst);
  await assert.rejects(store.getAttentionDetail(analyst, own.id), { status: 404 });
  assert.equal((await store.getAttentionInbox(otherAnalyst, filters)).total, 2);
});

test("vendedor, supervisor y aliado denegados; legacy seller/user no concede acceso al analista", async t => {
  const { store, create, db } = await fixture(t);
  for (const denied of [seller, otherSeller, supervisor, ally]) {
    await assert.rejects(store.getAttentionInbox(denied, filters), { status: 403 });
    await assert.rejects(create(denied), { status: 403 });
  }
  const { id } = await create();
  for (const key of ["user:5", "seller:100", null]) {
    await db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=5,"assigneeKey"=$2 WHERE id=$1', [id,key]);
    await assert.rejects(store.getAttentionDetail(analyst,id), { status: 404 });
  }
  await db.query('UPDATE "AttentionConversation" SET "assigneeKey"=\'analyst:5\',"assigneeSellerId"=100 WHERE id=$1',[id]);
  await assert.rejects(store.getAttentionDetail(analyst,id), { status: 404 });
  assert.equal((await store.getAttentionInbox(central,filters)).total,1);
});

test("solo analistas nominales activos son asignables; revocación real invalida actores existentes", async t => {
  const { store, create, mutation, db, assign } = await fixture(t); const { id } = await create();
  const team = (await store.getAttentionInbox(central,filters)).team;
  assert.deepEqual(team.map(p=>p.key),["analyst:5","analyst:6"]);
  for (const key of ["analyst:1","analyst:2","analyst:7","analyst:8"]) await assert.rejects(store.mutateAttentionConversation(central,id,mutation("transfer",{assigneeKey:key})),{status:403});
  for (const key of ["user:1","seller:100"]) await assert.rejects(store.mutateAttentionConversation(central,id,mutation("transfer",{assigneeKey:key})),{status:400});
  await assign(id);
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=5');
  await assert.rejects(store.getAttentionDetail(analyst,id),{status:403});
  await db.query('UPDATE "Usuario" SET activo=true,"rolId"=1 WHERE id=5');
  await assert.rejects(store.getAttentionInbox(analyst,filters),{status:403});
  await db.query('UPDATE "Aliado" SET activo=false WHERE id=1');
  await assert.rejects(store.getAttentionInbox(central,filters),{status:403});
});

test("crear/reintentar/notas son idempotentes y la versión evita sobrescribir cambios", async t => {
  const { store, create, mutation } = await fixture(t); const requestId = randomUUID();
  const first=await create(central,{requestId}); assert.deepEqual(await create(central,{requestId}),first);
  await assert.rejects(create(central,{requestId,name:"Alterado"}),{status:409});
  const note=mutation("note",{text:"Una sola nota"});
  await store.mutateAttentionConversation(central,first.id,note); await store.mutateAttentionConversation(central,first.id,note);
  const detail=await store.getAttentionDetail(central,first.id);
  assert.equal(detail.notes.length,1); assert.equal(detail.conversation.version,2);
  assert.equal(detail.conversation.sedeId,null); assert.equal(detail.conversation.assigneeKey,null);
  await assert.rejects(store.mutateAttentionConversation(central,first.id,mutation("close")),{status:409});
  await assert.rejects(create(analyst),{status:403});
});

test("vínculo exacto explícito central permite ficha del analista sin importes ni ampliar cartera", async t => {
  const { store, create, assign, act, db } = await fixture(t); const {id}=await create(); await assign(id);
  const before=(await db.query('SELECT * FROM "Credito" ORDER BY id')).rows;
  assert.equal((await store.getAttentionDetail(central,id)).customer.match,"ambiguous");
  const restricted=await store.getAttentionDetail(analyst,id);
  assert.equal(restricted.customer.match,"restricted"); assert.deepEqual(restricted.customer.candidates,[]);
  assert.equal((await store.getAttentionInbox(analyst,{...filters,search:"Persona uno"})).total,0);
  await assert.rejects(act(analyst,id,"link",{creditId:1}),{status:403});
  await assert.rejects(act(central,id,"link",{creditId:4}),{status:403});
  await act(central,id,"link",{creditId:1});
  const own=await store.getAttentionDetail(analyst,id);
  assert.deepEqual(own.customer.credits.map(c=>c.id),[1]); assert.deepEqual(own.customer.candidates,[]);
  assert.equal(own.customer.financialAllowed,false); assert.equal(own.customer.credits[0].balance,null);
  assert.deepEqual(own.customer.credits[0].payments,[]); assert.equal(own.customer.studies.length,1);
  assert.equal((await store.getAttentionInbox(analyst,{...filters,search:"Persona uno"})).total,1);
  const admin=await store.getAttentionDetail(central,id);
  assert.deepEqual(admin.customer.credits.map(c=>c.id),[2,1]); assert.equal(admin.customer.credits.find(c=>c.id===1).balance,200);
  assert.ok(!JSON.stringify(own).includes("DO_NOT_EXPOSE"));
  assert.deepEqual((await db.query('SELECT * FROM "Credito" ORDER BY id')).rows,before);
  await db.query('UPDATE "Credito" SET "clienteTelefono"=\'3009999999\' WHERE id=1');
  assert.equal((await store.getAttentionDetail(analyst,id)).customer.match,"restricted");
  await assert.rejects(db.query('DELETE FROM "AttentionAudit"'));
});

test("prospecto global existente resuelve para central sin duplicar ni exponer payload al analista", async t => {
  const {store,create,assign,db}=await fixture(t);
  await db.query(`INSERT INTO "CreditoBorrador" VALUES(1,null,'Prospecto oficial','123456','003001111111',20,100,'ABIERTO',null,'2026-10-30','{"secret":"DRAFT_PRIVATE"}')`);
  const {id}=await create(central,{phone:"3001111111",name:"+573001111111"}); await assign(id);
  const detail=await store.getAttentionDetail(central,id);
  assert.equal(detail.customer.match,"linked"); assert.equal(detail.customer.name,"Prospecto oficial");
  assert.equal(detail.conversation.name,"Prospecto oficial"); assert.equal(detail.customer.studies[0].id,"D-1");
  assert.ok(!JSON.stringify(detail).includes("DRAFT_PRIVATE"));
  assert.equal((await store.getAttentionInbox(central,{...filters,search:"Prospecto oficial"})).total,1);
  assert.equal((await store.getAttentionInbox(analyst,{...filters,search:"Prospecto oficial"})).total,0);
  assert.equal((await store.getAttentionDetail(analyst,id)).customer.match,"restricted");
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM "CreditoBorrador"')).rows[0].n,1);
});

test("tareas, notas y solicitud humana son locales y no fabrican mensajes ni disponibilidad", async t => {
  const {store,create,assign,act}=await fixture(t); const {id}=await create(); await assign(id);
  await act(analyst,id,"claim"); await act(analyst,id,"task",{text:"Revisar documentación",dueAt:"2026-11-01T15:00:00Z"});
  const detail=await store.getAttentionDetail(analyst,id);
  await act(analyst,id,"complete_task",{taskId:detail.tasks[0].id}); await act(analyst,id,"human_request");
  const after=await store.getAttentionDetail(analyst,id);
  assert.equal(after.conversation.mode,"human_requested"); assert.equal(after.messages.length,0); assert.ok(after.tasks[0].completedAt);
  assert.equal(after.permissions.assign,false); assert.equal(after.permissions.canSend,false);
  await assert.rejects(act(central,id,"claim"),{status:403});
});

test("importación global solo central deduplica mensajes y conserva sede/asignación legacy sin inventar otra", async t => {
  const {store,db}=await fixture(t); const initial=[snapshot({messages:[message("first")]})];
  await assert.rejects(store.importAttentionSnapshots(analyst,initial),{status:403});
  assert.deepEqual(await store.importAttentionSnapshots(central,initial),{imported:1,messagesImported:1});
  const chat=(await store.getAttentionInbox(central,filters)).conversations[0];
  assert.equal(chat.sedeId,null); assert.equal(chat.assigneeKey,null);
  assert.equal((await store.getAttentionInbox(analyst,filters)).total,0);
  await db.query('UPDATE "AttentionConversation" SET "sedeId"=20,"assigneeKey"=\'seller:100\',"assigneeSellerId"=100 WHERE id=$1',[chat.id]);
  assert.deepEqual(await store.importAttentionSnapshots(central,initial),{imported:0,messagesImported:0});
  const after=(await store.getAttentionDetail(central,chat.id)).conversation;
  assert.equal(after.sedeId,20); assert.equal(after.assigneeKey,"seller:100");
  await assert.rejects(store.importAttentionSnapshots(central,[snapshot({phone:"3009999999"})]),{status:409});
});

test("bandeja ordena por contacto real: historial, cursor y notas no adelantan un chat antiguo", async t => {
  const {store,db,act,create}=await fixture(t);
  const recent=snapshot({externalId:"recent-chat",name:"Contacto reciente",lastContactAt:"2026-10-30T10:00:00Z",
    messages:[{...message("recent","2026-10-30T10:00:00Z"),text:"Último mensaje reciente"}]});
  const older=snapshot({externalId:"older-chat",name:"Contacto anterior",lastContactAt:"2026-10-29T10:00:00Z",
    messages:[{...message("older-latest","2026-10-29T10:00:00Z"),text:"Último mensaje anterior"}]});
  await store.importAttentionSnapshots(central,[recent,older]);
  const initial=(await store.getAttentionInbox(central,filters)).conversations;
  const oldId=initial.find(chat=>chat.name===older.name).id;
  await db.query(`UPDATE "AttentionConversation" SET "updatedAt"='2000-01-01T00:00:00Z' WHERE "externalId"=$1`,[recent.externalId]);
  const check=async()=>{
    const chats=(await store.getAttentionInbox(central,filters)).conversations;
    assert.deepEqual(chats.slice(0,2).map(chat=>chat.name),[recent.name,older.name]);
    assert.ok(new Date(chats[1].updatedAt)>new Date(chats[0].updatedAt),"la sincronización técnica del chat antiguo es más reciente");
    assert.equal(chats[1].lastContactAt,"2026-10-29T10:00:00.000Z");
    assert.equal(chats[1].preview,"Último mensaje anterior","una página histórica no reemplaza la vista previa más reciente");
  };
  await store.importAttentionSnapshots(central,[{...older,historyCursor:"historical-page",lastContactAt:"2026-10-01T10:00:00Z",
    messages:[{...message("historical","2026-10-01T10:00:00Z"),text:"Mensaje histórico"}]}]);
  await check();
  await store.importAttentionSnapshots(central,[{...older,historyCursor:"next-page",messages:[]}]);
  await check();
  await act(central,oldId,"note",{text:"Nota interna posterior"});
  await check();
  const internal=await create();
  await check();
  assert.equal((await store.getAttentionInbox(central,filters)).conversations.at(-1).id,internal.id);
});

test("Meta opaco sin teléfono sigue siendo chat real sin identificar cliente y acepta teléfono verificable posterior", async t => {
  const {store,assign,act}=await fixture(t);
  await store.importAttentionSnapshots(central,[snapshot({phone:null,name:null,messages:[message("meta-inbound")]})]);
  const {id}=(await store.getAttentionInbox(central,filters)).conversations[0]; await assign(id);
  const detail=await store.getAttentionDetail(analyst,id);
  assert.equal(detail.conversation.phone,null); assert.equal(detail.conversation.name,"Contacto de WhatsApp");
  assert.equal(detail.customer.match,"none"); assert.equal(detail.messages.length,1);
  await assert.rejects(act(central,id,"link",{creditId:1}),{status:403});
  await store.importAttentionSnapshots(central,[snapshot()]);
  assert.equal((await store.getAttentionDetail(central,id)).conversation.phone,"+573001234567");
  await store.importAttentionSnapshots(central,[snapshot({phone:null})]);
  assert.equal((await store.getAttentionDetail(central,id)).conversation.phone,"+573001234567");
});

test("modo desconocido nuevo no deja una etiqueta IA obsoleta", async t => {
  const {store}=await fixture(t);
  await store.importAttentionSnapshots(central,[snapshot({mode:"ai"})]);
  const {id}=(await store.getAttentionInbox(central,filters)).conversations[0];
  await store.importAttentionSnapshots(central,[snapshot({mode:"unknown"})]);
  assert.equal((await store.getAttentionDetail(central,id)).conversation.mode,"unknown");
});

test("respuestas rápidas requieren aprobación central y reintentos no duplican", async t => {
  const {store}=await fixture(t); const input={title:"Saludo",text:"Texto aprobado",requestId:randomUUID()};
  await assert.rejects(store.saveAttentionQuickReply(analyst,input),{status:403});
  await store.saveAttentionQuickReply(central,input); await store.saveAttentionQuickReply(central,input);
  assert.equal((await store.getAttentionInbox(analyst,filters)).quickReplies.length,1);
});

test("batch reabre por nuevo inbound posterior a closedAt incluso si notas cambiaron updatedAt", async t => {
  const {store,assign,act,db}=await fixture(t);
  await store.importAttentionSnapshots(central,[snapshot()]);
  const {id}=(await store.getAttentionInbox(central,filters)).conversations[0]; await assign(id);
  await act(analyst,id,"human_request"); await act(analyst,id,"close");
  await db.query(`UPDATE "AttentionConversation" SET "closedAt"='2026-10-30T10:00:00Z' WHERE id=$1`,[id]);
  await act(analyst,id,"note",{text:"Nota tras cerrar"});
  await db.query(`UPDATE "AttentionConversation" SET "updatedAt"='2026-10-30T10:06:00Z' WHERE id=$1`,[id]);
  await store.importAttentionSnapshots(central,[snapshot({messages:[message("old","2026-10-30T09:59:00Z")]})]);
  assert.equal((await store.getAttentionDetail(analyst,id)).conversation.status,"closed");
  const messages=Array.from({length:300},(_,i)=>message(`new-${i}`,"2026-10-30T10:05:00Z"));
  assert.equal((await store.importAttentionSnapshots(central,[snapshot({mode:"human",messages})])).messagesImported,300);
  const after=await store.getAttentionDetail(analyst,id);
  assert.equal(after.conversation.status,"pending"); assert.equal(after.conversation.mode,"human_requested"); assert.equal(after.messages.length,301);
  assert.equal((await store.importAttentionSnapshots(central,[snapshot({mode:"human",messages})])).messagesImported,0);
});

test("notas recientes y tareas pendientes tienen prioridad con truncamiento visible", async t => {
  const {store,create,act,db}=await fixture(t); const {id}=await create();
  const notes=Array.from({length:300},(_,i)=>({id:randomUUID(),text:`Nota ${i}`,createdAt:new Date(Date.UTC(2026,0,1,0,i)).toISOString()}));
  await db.query(`INSERT INTO "AttentionNote"(id,"conversationId",text,author,"userId","createdAt")
    SELECT n.id,$1::uuid,n.text,'Central',1,n."createdAt" FROM jsonb_to_recordset($2::jsonb) AS n(id uuid,text text,"createdAt" timestamptz)`,[id,JSON.stringify(notes)]);
  await act(central,id,"note",{text:"Nota reciente"});
  const tasks=Array.from({length:300},(_,i)=>({id:randomUUID(),title:`Finalizada ${i}`}));
  await db.query(`INSERT INTO "AttentionTask"(id,"conversationId",title,author,"userId","completedAt")
    SELECT t.id,$1::uuid,t.title,'Central',1,now() FROM jsonb_to_recordset($2::jsonb) AS t(id uuid,title text)`,[id,JSON.stringify(tasks)]);
  await act(central,id,"task",{text:"Pendiente",dueAt:"2026-11-01T15:00:00Z"});
  const detail=await store.getAttentionDetail(central,id);
  assert.equal(detail.notesTruncated,true); assert.equal(detail.tasksTruncated,true); assert.equal(detail.notes.length,300);
  assert.equal(detail.notes.at(-1).text,"Nota reciente"); assert.equal(detail.tasks[0].title,"Pendiente");
});

test("checkpoint es global, transaccional y privado de central; errores revierten batch", async t => {
  const {store}=await fixture(t);
  await store.importAttentionSnapshots(central,[snapshot({historyCursor:"opaque-300"}),snapshot({externalId:"other-chat",historyCursor:"other-cursor"})]);
  await assert.rejects(store.getAttentionHistoryCursors(analyst),{status:403});
  const original={"provider-chat":"opaque-300","other-chat":"other-cursor"};
  assert.deepEqual(await store.getAttentionHistoryCursors(central),original);
  await assert.rejects(store.importAttentionSnapshots(central,[snapshot({historyCursor:"opaque-600"}),snapshot({externalId:"zz-invalid",historyCursor:"bad cursor"})]),{status:400});
  assert.deepEqual(await store.getAttentionHistoryCursors(central),original);
  await store.importAttentionSnapshots(central,[snapshot({historyCursor:"opaque-600"})]);
  assert.equal((await store.getAttentionHistoryCursors(central))["provider-chat"],"opaque-600");
  const inbox=await store.getAttentionInbox(central,filters); const detail=await store.getAttentionDetail(central,inbox.conversations[0].id);
  for(const output of [inbox,detail]) assert.ok(!JSON.stringify(output).includes("opaque-")&&!JSON.stringify(output).includes("daptaMessagesCursor"));
});

test("dashboard usa conversaciones inbound únicas por día Bogotá y respeta asignación en todo dato", async t => {
  const {store,assign,act}=await fixture(t);
  const today=(new Date()).toLocaleDateString("en-CA",{timeZone:"America/Bogota"}); const midday=`${today}T17:00:00Z`;
  await store.importAttentionSnapshots(central,[snapshot({messages:[message("a",midday),message("b",midday)]}),snapshot({externalId:"other-chat",messages:[message("c",midday)]})]);
  const chats=(await store.getAttentionInbox(central,filters)).conversations;
  const own=chats.find(c=>c.externalId==="provider-chat"); const other=chats.find(c=>c.externalId==="other-chat");
  await assign(own.id); await assign(other.id,otherAnalyst); await act(analyst,own.id,"note",{text:"Seguimiento"});
  const full=await store.getAttentionInbox(central,{...filters,search:"No existe"});
  assert.equal(full.total,0); assert.equal(full.dashboard.daily.find(d=>d.date===today).count,2);
  assert.equal(full.dashboard.team.find(p=>p.key===analyst.key).assigned,1);
  const scoped=await store.getAttentionInbox(analyst,filters);
  assert.equal(scoped.dashboard.daily.find(d=>d.date===today).count,1); assert.equal(scoped.dashboard.daily.length,7);
  assert.deepEqual(scoped.dashboard.team.map(p=>p.key),[analyst.key]);
  assert.ok(scoped.dashboard.activity.every(a=>a.conversationId===own.id));
  assert.ok(scoped.dashboard.activeConversations.every(c=>c.id===own.id));
});
