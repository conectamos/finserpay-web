import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const { ATTENTION_REALTIME_CHANNEL, createAttentionRealtimeBroker, createAttentionRealtimeStream, authorizeAttentionRealtime, attentionRealtimeSchemaReady, parseAttentionRealtimeChange }=await jiti.import("../lib/atencion-realtime.ts");
const {AttentionError}=await jiti.import("../lib/atencion-core.ts");
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const id="10000000-0000-4000-8000-000000000001";
const admin={userId:1,key:"admin:1",name:"Central",sellerId:null,central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:1};
const analyst={...admin,userId:2,key:"analyst:2",central:false,admin:false,analyst:true};
const second={...analyst,userId:3,key:"analyst:3"};
const change=(overrides={})=>({conversationId:id,previousUserId:null,previousKey:null,previousSellerId:null,currentUserId:2,currentKey:"analyst:2",currentSellerId:null,...overrides});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,"aliadoId" integer,activa boolean);
    CREATE TABLE "Usuario"(id integer PRIMARY KEY,"rolId" integer,"sedeId" integer,activo boolean);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);CREATE TABLE "Credito"(id integer PRIMARY KEY);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);
    INSERT INTO "Sede" VALUES(1,1,true);INSERT INTO "Usuario" VALUES(1,1,1,true),(2,2,1,true),(3,2,1,true);`);
  await db.exec(migration);
  const events=[];await db.listen(ATTENTION_REALTIME_CHANNEL,payload=>events.push(JSON.parse(payload)));
  const adapter={$queryRawUnsafe:async(sql,...values)=>(await db.query(sql,values)).rows};
  const insert=()=>db.query(`INSERT INTO "AttentionConversation"(id,channel,phone,name,"assigneeKey","assigneeUserId") VALUES($1,'whatsapp','+573001234567','PRIVATE_NAME','analyst:2',2)`,[id]);
  return {db,events,adapter,insert};
}

test("notificaciones solo tras commit; rollback, auditoría y actualización idéntica no generan eventos",async t=>{
  const {db,events,insert}=await fixture(t);
  await assert.rejects(db.transaction(async tx=>{await tx.query(`INSERT INTO "AttentionConversation"(id,channel,name) VALUES($1,'internal','rollback')`,[id]);assert.equal(events.length,0);throw new Error("rollback");}));
  assert.equal(events.length,0);await insert();assert.equal(events.length,1);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_NAME"));assert.ok(!JSON.stringify(events).includes("57300"));
  await db.query('UPDATE "AttentionConversation" SET name=name WHERE id=$1',[id]);
  await db.query(`INSERT INTO "AttentionAudit"("conversationId","userId",action) VALUES($1,1,'CONVERSATION_VIEWED')`,[id]);
  assert.equal(events.length,1);
  await db.transaction(async tx=>{await tx.query('UPDATE "AttentionConversation" SET status=\'open\' WHERE id=$1',[id]);assert.equal(events.length,1);});
  assert.equal(events.length,2);
});

test("mensaje, entrega y transferencia notifican; scope alcanza anterior y nuevo analista sin exponer otros chats",async t=>{
  const {db,events,adapter,insert}=await fixture(t);await insert();
  assert.equal(await attentionRealtimeSchemaReady(adapter),true);
  assert.equal(await authorizeAttentionRealtime(adapter,analyst,[events.at(-1)]),true);
  assert.equal(await authorizeAttentionRealtime(adapter,second,[events.at(-1)]),false);
  await db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=3,"assigneeKey"=\'analyst:3\' WHERE id=$1',[id]);
  const transferred=events.at(-1);
  assert.equal(await authorizeAttentionRealtime(adapter,analyst,[transferred]),true);
  assert.equal(await authorizeAttentionRealtime(adapter,second,[transferred]),true);
  await db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES('20000000-0000-4000-8000-000000000001',$1,'meta-message','inbound','PRIVATE_TEXT',now())`,[id]);
  assert.equal(await authorizeAttentionRealtime(adapter,analyst,[events.at(-1)]),false);
  assert.equal(await authorizeAttentionRealtime(adapter,admin,[events.at(-1)]),true);
  assert.ok(!JSON.stringify(events).includes("PRIVATE_TEXT"));
  const count=events.length;await db.query(`UPDATE "AttentionMessage" SET "deliveryStatus"='delivered' WHERE "conversationId"=$1`,[id]);assert.equal(events.length,count+1);
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=3');
  await assert.rejects(authorizeAttentionRealtime(adapter,second,[]),{status:403});
});

test("outbox notifica cambios visibles y no actualizaciones de lease",async t=>{
  const {db,events,insert}=await fixture(t);await insert();
  await db.query(`INSERT INTO "AttentionMetaOutbox"(id,"conversationId","userId","actorKey","authorName","requestId",fingerprint,"conversationVersion","phoneNumberId","wabaId","contactId",text)
    VALUES('30000000-0000-4000-8000-000000000001',$1,1,'admin:1','PRIVATE_AUTHOR','40000000-0000-4000-8000-000000000001','fp',1,'line','account','PRIVATE_CONTACT','PRIVATE_TEXT')`,[id]);
  const count=events.length;
  await db.query('UPDATE "AttentionMetaOutbox" SET "leaseUntil"=now(),"updatedAt"=now()');assert.equal(events.length,count);
  await db.query('UPDATE "AttentionMetaOutbox" SET status=status,"updatedAt"=now()');assert.equal(events.length,count);
  await db.query('UPDATE "AttentionMetaOutbox" SET status=\'accepted\'');assert.equal(events.length,count+1);
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
});

test("broker comparte LISTEN y reconecta después de perder PostgreSQL",async t=>{
  const clients=[];
  class FakeClient extends EventEmitter {calls=[];async connect(){this.calls.push("connect");}async query(sql){this.calls.push(sql);}async end(){this.calls.push("end");}}
  const broker=createAttentionRealtimeBroker({createClient:()=>{const client=new FakeClient();clients.push(client);return client;},retryMs:5,random:()=>0.5});
  t.after(()=>broker.close());const first=[],second=[];
  const off=broker.subscribe(event=>first.push(event));broker.subscribe(event=>second.push(event));await wait(20);
  assert.equal(clients.length,1);assert.equal(clients[0].calls.filter(value=>value.startsWith("LISTEN")).length,1);
  clients[0].emit("notification",{channel:ATTENTION_REALTIME_CHANNEL,payload:JSON.stringify(change())});assert.equal(first.at(-1).kind,"change");
  clients[0].emit("error",new Error("private-db-error"));await wait(30);
  assert.equal(clients.length,2);assert.equal(broker.connected(),true);assert.ok(first.some(event=>event.kind==="disconnected"));
  off();clients[1].emit("notification",{channel:ATTENTION_REALTIME_CHANNEL,payload:JSON.stringify(change())});assert.equal(second.at(-1).kind,"change");
  assert.equal(parseAttentionRealtimeChange('{"conversationId":"invalid"}'),null);
});

function fakeBroker(){let listener;return {connected:()=>true,subscribe(fn){listener=fn;queueMicrotask(()=>fn({kind:"connected"}));return()=>{listener=null;};},close(){listener=null;},emit(event){listener?.(event);}};}
async function collect(reader,until){let text="";const decoder=new TextDecoder();while(!until(text)){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value);}return text;}
test("SSE envía invalidaciones sin PII, coalesce y cierra al revocar rol en heartbeat",async()=>{
  const broker=fakeBroker();const abort=new AbortController();let allowed=true;let checks=0;
  const stream=createAttentionRealtimeStream({actor:analyst,signal:abort.signal,broker,heartbeatMs:80,lifetimeMs:1000,retryMs:5,
    authorize:async changes=>{checks++;if(!allowed)throw new AttentionError("revoked",403);return changes.some(item=>item.currentUserId===2);}});
  const reader=stream.getReader();let text=await collect(reader,value=>value.includes("event: ready"));
  broker.emit({kind:"change",change:change({currentUserId:3,currentKey:"analyst:3"})});
  for(let n=0;n<8;n++)broker.emit({kind:"change",change:change()});
  text+=await collect(reader,value=>value.includes("conversation_changed"));
  assert.ok(!text.includes(id));assert.ok(!text.includes("analyst:"));assert.ok(checks<=3);
  allowed=false;text+=await collect(reader,value=>value.includes("unauthorized"));
  assert.equal((await reader.read()).done,true);assert.ok(text.includes("event: unauthorized"));
});

test("SSE cancela suscripción al cerrar consumidor y vence para reconectar",async()=>{
  const broker=fakeBroker();const abort=new AbortController();
  const stream=createAttentionRealtimeStream({actor:admin,signal:abort.signal,broker,authorize:async()=>true,lifetimeMs:70,heartbeatMs:20});
  const reader=stream.getReader();const text=await collect(reader,()=>false);assert.ok(text.includes("retry:"));
  const another=createAttentionRealtimeStream({actor:admin,signal:abort.signal,broker,authorize:async()=>true,lifetimeMs:1000});
  const next=another.getReader();await next.read();abort.abort();assert.equal((await next.read()).done,true);
});

test("cien chats ajenos no consultan autorización ni notifican al analista",async()=>{
  const broker=fakeBroker();const abort=new AbortController();let checks=0;
  const reader=createAttentionRealtimeStream({actor:analyst,signal:abort.signal,broker,heartbeatMs:2000,lifetimeMs:3000,
    authorize:async()=>{checks++;return false;}}).getReader();
  await collect(reader,text=>text.includes("event: ready"));const initial=checks;
  for(let i=0;i<100;i++)broker.emit({kind:"change",change:change({currentUserId:3,currentKey:"analyst:3"})});
  await wait(90);assert.equal(checks,initial);abort.abort();
  const remaining=await collect(reader,()=>false);assert.ok(!remaining.includes("conversation_changed"));
});

test("coalescer conserva revocación aunque otro commit observó asignación anterior",async()=>{
  const broker=fakeBroker();const abort=new AbortController();let checked=[];
  const reader=createAttentionRealtimeStream({actor:analyst,signal:abort.signal,broker,heartbeatMs:2000,lifetimeMs:3000,
    authorize:async changes=>{checked=changes;return changes.some(item=>item.previousUserId===2&&item.previousKey==="analyst:2");}}).getReader();
  await collect(reader,text=>text.includes("event: ready"));
  broker.emit({kind:"change",change:change({currentUserId:3,currentKey:"analyst:3",previousUserId:2,previousKey:"analyst:2"})});
  broker.emit({kind:"change",change:change()});
  const text=await collect(reader,value=>value.includes("conversation_changed"));
  assert.equal(checked[0].previousUserId,2);assert.ok(!text.includes(id));abort.abort();await collect(reader,()=>false);
});
