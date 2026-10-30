import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionMetaStore,attentionMetaReplyMessage}=await jiti.import("../lib/atencion-meta-storage.ts");
const {createAttentionStore}=await jiti.import("../lib/atencion-storage.ts");
const {createAttentionReadModel}=await jiti.import("../lib/atencion-read-model.ts");
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const scope={phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const central={userId:1,sellerId:null,key:"admin:1",name:"Central",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10};
const analyst={...central,userId:5,key:"analyst:5",name:"Analista A",central:false,admin:false,analyst:true};
const other={...analyst,userId:6,key:"analyst:6",name:"Analista B"};
const phone="+573001234567",contact="573001234567",instant="2026-10-30T15:00:00.000Z";
const inbound=(data={})=>({id:`wamid.${randomUUID()}`,from:contact,phone,name:"Contacto",timestamp:instant,type:"text",text:"Consulta",...data});
const events=(messages=[],statuses=[])=>({scope,messages,statuses,ignored:0});
const snapshot=(data={})=>({externalId:"dapta-chat",phone,name:"Contacto Dapta",mode:"ai",lastContactAt:null,historyTruncated:false,historyCursor:null,messages:[],...data});
const delivery=(id,data={})=>({id,recipient:contact,timestamp:instant,status:"delivered",errorCodes:[],...data});
const attachment={kind:"image",mimeType:"image/png",fileName:"imagen.png",sha256:"a".repeat(64),size:128};
const metaEnv={WHATSAPP_ATTENTION_ACCESS_TOKEN:"test-only-meta-token",WHATSAPP_ATTENTION_APP_SECRET:"test-only-meta-app-secret",
  WHATSAPP_ATTENTION_VERIFY_TOKEN:"test-only-meta-verify-token",WHATSAPP_ATTENTION_PHONE_NUMBER_ID:scope.phoneNumberId,
  WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:scope.wabaId,WHATSAPP_GRAPH_API_VERSION:"v25.0",
  WHATSAPP_ATTENTION_SEND_ENABLED:"true",WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED:"true"};
const daptaEnv={DAPTA_MCP_API_KEY:"test-only-dapta-token",DAPTA_ATTENTION_WORKSPACE_ID:"7496b9a3-2fe6-4e28-8411-7d54ee788b2c",DAPTA_ATTENTION_AGENT_ID:"6f9560ec-dcfd-4725-bf61-27cd8d528a1c"};
function adapter(db){return {$queryRawUnsafe:async(sql,...values)=>(await db.query(sql,values)).rows,$transaction:fn=>db.transaction(tx=>fn(adapter(tx)))};}
async function fixture(t,opts={}){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);
    CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,nombre text,"aliadoId" integer,activa boolean);
    CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"sedeId" integer,"rolId" integer);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);
    CREATE TABLE "Credito"(id integer PRIMARY KEY,"clienteTelefono" text,"clienteNombre" text,"clienteDocumento" text);
    CREATE TABLE "CreditoBorrador"(id integer PRIMARY KEY,"creditoId" integer,"clienteNombre" text,"clienteDocumento" text,"clienteTelefono" text);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(3,'ANALISTA_APROBACION');
    INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);
    INSERT INTO "Sede" VALUES(10,'Central',1,true);
    INSERT INTO "Usuario" VALUES(1,'Central',true,10,1),(5,'Analista A',true,10,3),(6,'Analista B',true,10,3);`);
  await db.exec(migration);
  let clock=new Date(instant);const database=adapter(db);
  const meta=createAttentionMetaStore(database,{scope,sendingEnabled:true,cutoverConfirmed:true,now:()=>clock,...opts});
  const legacy=createAttentionStore(database);
  const ingest=async(msg=inbound())=>{await meta.ingest(events([msg]));return (await db.query('SELECT * FROM "AttentionConversation" ORDER BY "createdAt" DESC,id DESC')).rows[0]};
  const assign=async(id,actor=analyst)=>db.query('UPDATE "AttentionConversation" SET "assigneeUserId"=$2,"assigneeKey"=$3,"assigneeName"=$4,version=version+1 WHERE id=$1',[id,actor.userId,actor.key,actor.name]);
  const input=async(id,data={})=>({requestId:randomUUID(),version:(await db.query('SELECT version FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].version,text:"Respuesta",...data});
  const queue=async(id,actor=central,data={})=>meta.queueReply(actor,id,await input(id,data));
  return {db,database,meta,legacy,ingest,assign,input,queue,advance:ms=>{clock=new Date(clock.getTime()+ms)}};
}

test("webhook enlaza solo teléfono exacto único, preserva asignación y deduplica wamid",async t=>{
  const f=await fixture(t);await f.legacy.importAttentionSnapshots(central,[snapshot()]);
  const id=(await f.db.query('SELECT id FROM "AttentionConversation"')).rows[0].id;await f.assign(id);
  const msg=inbound({type:"image",text:undefined,media:{id:"987654321",mimeType:"image/png",fileName:"foto.png",caption:"Consulta"}});
  assert.deepEqual(await f.meta.ingest(events([msg])),{messagesImported:1,statusesApplied:0});
  assert.deepEqual(await f.meta.ingest(events([msg])),{messagesImported:0,statusesApplied:0});
  const rows=(await f.db.query('SELECT * FROM "AttentionConversation"')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].externalId,"dapta-chat");assert.equal(rows[0].assigneeKey,analyst.key);assert.equal(rows[0].metaManaged,true);
  const detail=await f.legacy.getAttentionDetail(analyst,id);
  assert.equal(detail.messages.length,1);assert.match(detail.messages[0].attachment.url,new RegExp(`/api/atencion/${id}/messages/`));
  assert.ok(!JSON.stringify(detail).includes("987654321"));assert.ok(!JSON.stringify(detail).includes(msg.id));
  assert.equal((await f.meta.getMedia(analyst,id,detail.messages[0].id)).mediaId,"987654321");
  await assert.rejects(f.meta.getMedia(other,id,detail.messages[0].id),{status:404});
  await f.assign(id,other);await assert.rejects(f.meta.getMedia(analyst,id,detail.messages[0].id),{status:404});
  await assert.rejects(f.meta.ingest({...events([inbound()]),scope:{...scope,wabaId:"wrong"}}),{status:403});
  const audit=(await f.db.query(`SELECT "actorKind","actorKey","userId" FROM "AttentionAudit" WHERE action='META_MESSAGE_RECEIVED'`)).rows;
  assert.deepEqual(audit,[{actorKind:"system",actorKey:"SYSTEM_META",userId:null}]);
});

test("teléfono compartido entre chats no selecciona identidad ni analista arbitrarios",async t=>{
  const f=await fixture(t);await f.legacy.importAttentionSnapshots(central,[snapshot(),snapshot({externalId:"otro-chat"})]);
  const row=await f.ingest();assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,3);
  assert.equal(row.externalId,null);assert.equal(row.assigneeKey,null);assert.equal(row.sedeId,null);
});

test("Meta primero reutiliza chat único para Dapta y conserva actividad, modo e historial nativo",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  await f.db.query(`UPDATE "AttentionConversation" SET mode='human_requested' WHERE id=$1`,[row.id]);
  const old={id:"dapta-old",direction:"inbound",text:"Anterior",sentAt:"2026-10-29T10:00:00Z",author:null};
  const recent={...old,id:"dapta-overlap",text:"Duplicaría el nativo",sentAt:instant};
  const ai={...old,id:"dapta-ai",direction:"outbound",text:"Respuesta IA",sentAt:"2026-10-30T15:01:00.000Z"};
  await f.legacy.importAttentionSnapshots(central,[snapshot({messages:[old,recent,ai],lastContactAt:"2026-10-30T20:00:00Z",historyCursor:"cursor-safe"})]);
  const rows=(await f.db.query('SELECT * FROM "AttentionConversation"')).rows;
  assert.equal(rows.length,1);assert.equal(rows[0].id,row.id);assert.equal(rows[0].externalId,"dapta-chat");assert.equal(rows[0].assigneeKey,analyst.key);
  assert.equal(rows[0].mode,"human_requested");assert.equal(new Date(rows[0].lastContactAt).toISOString(),ai.sentAt);assert.equal(rows[0].daptaMessagesCursor,"cursor-safe");
  assert.deepEqual((await f.db.query('SELECT text FROM "AttentionMessage" ORDER BY "sentAt"')).rows.map(r=>r.text),["Anterior","Consulta","Respuesta IA"]);
});

test("puertas de envío cerradas por defecto y ventana de 24h se verifican antes de crear intención",async t=>{
  const f=await fixture(t,{sendingEnabled:false});const row=await f.ingest();
  assert.equal((await f.meta.getMessaging(central,row.id)).canReply,false);await assert.rejects(f.queue(row.id),{status:409});
  const defaultStore=createAttentionMetaStore(f.database,{scope});assert.equal((await defaultStore.getMessaging(central,row.id)).canReply,false);
  const enabled=createAttentionMetaStore(f.database,{scope,sendingEnabled:true,cutoverConfirmed:true,now:()=>new Date("2026-10-31T15:00:00Z")});
  await assert.rejects(enabled.queueReply(central,row.id,await f.input(row.id)),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
});

test("intención idempotente y reserva exclusiva: ninguna segunda solicitud obtiene el lease",async t=>{
  const f=await fixture(t);const row=await f.ingest();const input=await f.input(row.id);
  const queued=await f.meta.queueReply(central,row.id,input);assert.equal((await f.meta.queueReply(central,row.id,input)).id,queued.id);
  await assert.rejects(f.meta.queueReply(central,row.id,{...input,text:"Distinto"}),{status:409});
  await assert.rejects(f.queue(row.id),{status:409});
  const claims=await Promise.all([f.meta.claimReply(central,row.id,input.requestId),f.meta.claimReply(central,row.id,input.requestId)]);
  assert.equal(claims.filter(c=>c.claimed).length,1);assert.equal(claims.find(c=>!c.claimed).reply.leaseToken,null);
  const claim=claims.find(c=>c.claimed);assert.equal(claim.lastInboundAt,instant);
  await f.meta.beforeSend(central,queued.id,claim.reply.leaseToken);
  await assert.rejects(f.meta.beforeSend(central,queued.id,claim.reply.leaseToken),{status:409});
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" WHERE direction='outbound'`)).rows[0].n,0);
  const accepted=await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.sent1");
  assert.equal(accepted.status,"accepted");assert.equal((await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.sent1")).messageId,accepted.messageId);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" WHERE direction='outbound'`)).rows[0].n,1);
});

test("revalidación impide enviar tras reasignación o revocación de cuenta y no amplía cartera",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  const queued=await f.queue(row.id,analyst);const claim=await f.meta.claimReply(analyst,row.id,queued.requestId);
  await f.assign(row.id,other);await assert.rejects(f.meta.beforeSend(analyst,queued.id,claim.reply.leaseToken),{status:404});
  await assert.rejects(f.meta.findReply(analyst,row.id,queued.requestId),{status:404});
  await f.assign(row.id);await f.db.query('UPDATE "Usuario" SET activo=false WHERE id=5');
  await assert.rejects(f.meta.beforeSend(analyst,queued.id,claim.reply.leaseToken),{status:403});
  assert.equal((await f.db.query(`SELECT status FROM "AttentionMetaOutbox" WHERE id=$1`,[queued.id])).rows[0].status,"queued");
});

test("timeout incierto no reenvía; callback firmado resuelve solo outbox ID, scope y destinatario exactos",async t=>{
  const f=await fixture(t);const row=await f.ingest();const queued=await f.queue(row.id);const claim=await f.meta.claimReply(central,row.id,queued.requestId);
  await f.meta.beforeSend(central,queued.id,claim.reply.leaseToken);
  const failed=await f.meta.failReply(queued.id,claim.reply.leaseToken,{code:"UNSAFE bearer SECRET",uncertain:true});
  assert.equal(failed.status,"uncertain");assert.equal(failed.errorCode,"META_DELIVERY_ERROR");assert.ok(!JSON.stringify(attentionMetaReplyMessage(failed)).includes("SECRET"));
  assert.equal((await f.meta.claimReply(central,row.id,queued.requestId)).claimed,false);await assert.rejects(f.queue(row.id),{status:409});
  for(const data of [{requestId:queued.requestId},{requestId:queued.id,recipient:"573009999999"},{requestId:randomUUID()}]) {
    assert.equal((await f.meta.ingest(events([],[delivery("wamid.ack",data)]))).statusesApplied,0);
    assert.equal((await f.meta.findReply(central,row.id,queued.requestId)).status,"uncertain");
  }
  await f.meta.ingest(events([],[delivery("wamid.ack",{requestId:queued.id})]));
  const confirmed=await f.meta.findReply(central,row.id,queued.requestId);assert.equal(confirmed.status,"delivered");assert.ok(confirmed.messageId);
  assert.equal((await f.meta.ingest(events([],[delivery("wamid.ack",{requestId:queued.id})]))).statusesApplied,0);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" WHERE direction='outbound'`)).rows[0].n,1);
});

test("callback de una intención queued no puede inventar un envío",async t=>{
  const f=await fixture(t);const row=await f.ingest();const queued=await f.queue(row.id);
  assert.equal((await f.meta.ingest(events([],[delivery("wamid.not-sent",{requestId:queued.id})]))).statusesApplied,0);
  assert.equal((await f.meta.findReply(central,row.id,queued.requestId)).status,"queued");
});

test("recibo sent anterior a failed no lo revive; delivered/read sí prueba entrega real",async t=>{
  const f=await fixture(t);const row=await f.ingest();const q=await f.queue(row.id);const c=await f.meta.claimReply(central,row.id,q.requestId);await f.meta.beforeSend(central,q.id,c.reply.leaseToken);
  await f.meta.acceptReply(q.id,c.reply.leaseToken,"wamid.order");
  const sent=delivery("wamid.order",{status:"sent",timestamp:"2026-10-30T15:00:01Z"});
  await f.meta.ingest(events([],[sent,delivery("wamid.order",{status:"failed",timestamp:"2026-10-30T15:00:02Z",errorCodes:[131000]}),sent]));
  assert.equal((await f.meta.findReply(central,row.id,q.requestId)).status,"failed");
  await f.meta.ingest(events([],[delivery("wamid.order",{status:"read",timestamp:"2026-10-30T15:00:03Z"})]));
  assert.equal((await f.meta.findReply(central,row.id,q.requestId)).status,"read");
});

test("cancelación durable impide un POST atrasado incluso cuando la consulta inicial no encontró nada",async t=>{
  const f=await fixture(t);const row=await f.ingest();const input=await f.input(row.id);
  assert.equal(await f.meta.findReply(central,row.id,input.requestId),null);
  assert.deepEqual(await f.meta.cancelReply(central,row.id,input.requestId),{cancelled:true});
  await assert.rejects(f.meta.queueReply(central,row.id,input),{status:409});
  assert.deepEqual(await f.meta.cancelReply(central,row.id,input.requestId),{cancelled:true});
  const q=await f.queue(row.id);const c=await f.meta.claimReply(central,row.id,q.requestId);await f.meta.cancelReply(central,row.id,q.requestId);
  await assert.rejects(f.meta.beforeSend(central,q.id,c.reply.leaseToken),{status:409});
  assert.equal((await f.meta.findReply(central,row.id,q.requestId)).errorCode,"USER_CANCELLED");
  const posted=await f.queue(row.id);const active=await f.meta.claimReply(central,row.id,posted.requestId);await f.meta.beforeSend(central,posted.id,active.reply.leaseToken);
  await assert.rejects(f.meta.cancelReply(central,row.id,posted.requestId),{status:409});
  const incompatible=randomUUID();await f.db.query(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES($1,$2,'OTHER_ACTION')`,[central.key,incompatible]);
  await assert.rejects(f.meta.cancelReply(central,row.id,incompatible),{status:409});
});

test("recibos adelantados se reconcilian al ACK y estados fuera de orden no degradan read",async t=>{
  const f=await fixture(t);const row=await f.ingest();const q=await f.queue(row.id);const c=await f.meta.claimReply(central,row.id,q.requestId);await f.meta.beforeSend(central,q.id,c.reply.leaseToken);
  await f.meta.ingest(events([],[delivery("wamid.early",{status:"read",timestamp:"2026-10-30T15:01:00Z"})]));
  const ack=await f.meta.acceptReply(q.id,c.reply.leaseToken,"wamid.early");assert.equal(ack.status,"read");
  await f.meta.ingest(events([],[delivery("wamid.early",{status:"sent",timestamp:"2026-10-30T15:00:01Z"}),delivery("wamid.early",{status:"failed",timestamp:"2026-10-30T15:02:00Z",errorCodes:[131000]})]));
  assert.equal((await f.meta.findReply(central,row.id,q.requestId)).status,"read");
  await f.assign(row.id);const detail=await f.legacy.getAttentionDetail(analyst,row.id);assert.equal(detail.messages.find(m=>m.id===ack.messageId).deliveryStatus,"read");
});

test("lease vencido tras POST queda incierto; lease previo al POST se puede reclamar sin duplicar intención",async t=>{
  const f=await fixture(t);const row=await f.ingest();const q=await f.queue(row.id);const c1=await f.meta.claimReply(central,row.id,q.requestId);
  f.advance(121000);const c2=await f.meta.claimReply(central,row.id,q.requestId);assert.equal(c2.claimed,true);assert.notEqual(c2.reply.leaseToken,c1.reply.leaseToken);
  await assert.rejects(f.meta.beforeSend(central,q.id,c1.reply.leaseToken),{status:409});await f.meta.beforeSend(central,q.id,c2.reply.leaseToken);
  f.advance(121000);const c3=await f.meta.claimReply(central,row.id,q.requestId);assert.equal(c3.claimed,false);assert.equal(c3.reply.status,"uncertain");
});

test("consulta de estado recupera leases abandonados sin repetir POST ni dejar queued eterno",async t=>{
  const f=await fixture(t);const row=await f.ingest();const first=await f.queue(row.id);const lease=await f.meta.claimReply(central,row.id,first.requestId);
  f.advance(121000);assert.equal((await f.meta.findReply(central,row.id,first.requestId)).status,"failed");
  await assert.rejects(f.meta.beforeSend(central,first.id,lease.reply.leaseToken),{status:409});
  const second=await f.queue(row.id);const active=await f.meta.claimReply(central,row.id,second.requestId);await f.meta.beforeSend(central,second.id,active.reply.leaseToken);
  f.advance(121000);assert.equal((await f.meta.findReply(central,row.id,second.requestId)).status,"uncertain");
  await assert.rejects(f.queue(row.id),{status:409});
  const another=await f.ingest(inbound({from:"573002222222",phone:"+573002222222"}));const unclaimed=await f.queue(another.id);
  await f.db.query('UPDATE "AttentionMetaOutbox" SET "createdAt"=$2 WHERE id=$1',[unclaimed.id,"2026-10-30T14:00:00Z"]);
  assert.equal((await f.meta.findReply(central,another.id,unclaimed.requestId)).status,"failed");
});

test("adjunto se guarda separado de input, no se envía antes de subir y queda URL privada después de ACK",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);const q=await f.queue(row.id,analyst,{text:"",attachment});
  const c=await f.meta.claimReply(analyst,row.id,q.requestId);await assert.rejects(f.meta.beforeSend(analyst,q.id,c.reply.leaseToken),{status:409});
  await assert.rejects(f.meta.setUploadedMedia(other,q.id,c.reply.leaseToken,"123456789"),{status:404});
  await f.meta.setUploadedMedia(analyst,q.id,c.reply.leaseToken,"123456789");await f.meta.beforeSend(analyst,q.id,c.reply.leaseToken);
  const accepted=await f.meta.acceptReply(q.id,c.reply.leaseToken,"wamid.media-out");const publicMessage=attentionMetaReplyMessage(accepted);
  assert.match(publicMessage.attachment.url,/\/media$/);assert.ok(!JSON.stringify(publicMessage).includes("123456789"));
  assert.equal((await f.meta.getMedia(analyst,row.id,accepted.messageId)).mediaId,"123456789");
  const wrongChannel=createAttentionMetaStore(f.database,{scope:{...scope,wabaId:"99999"}});await assert.rejects(wrongChannel.getMedia(analyst,row.id,accepted.messageId),{status:409});
});

test("auditoría exige usuario real o SYSTEM_META explícito y sigue inmutable",async t=>{
  const f=await fixture(t);
  for(const sql of [`INSERT INTO "AttentionAudit"(action) VALUES('anonymous')`,`INSERT INTO "AttentionAudit"("actorKind",action) VALUES('system','anonymous')`,
    `INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','another-service','anonymous')`,`INSERT INTO "AttentionAudit"("actorKind","actorKey","userId",action) VALUES('system','SYSTEM_META',1,'fake')`])await assert.rejects(f.db.query(sql));
  await f.db.query(`INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','SYSTEM_META','allowed')`);
  await assert.rejects(f.db.query('DELETE FROM "AttentionAudit"'));
});

test("detalle y capacidad siguen leyendo el esquema anterior sin Meta ni DDL en requests",async t=>{
  const f=await fixture(t);await f.legacy.importAttentionSnapshots(central,[snapshot({phone:null})]);
  const id=(await f.db.query('SELECT id FROM "AttentionConversation"')).rows[0].id;
  await f.db.exec(`DROP TABLE "AttentionMetaDelivery","AttentionMetaOutbox","AttentionMetaBinding";
    ALTER TABLE "AttentionConversation" DROP COLUMN "metaManaged",DROP COLUMN "metaLastInboundAt";
    ALTER TABLE "AttentionMessage" DROP COLUMN "metaWamid",DROP COLUMN "metaPhoneNumberId",DROP COLUMN attachment,DROP COLUMN "deliveryStatus",DROP COLUMN "deliveryAt",DROP COLUMN "replyToWamid";
    ALTER TABLE "AttentionAudit" DROP CONSTRAINT "AttentionAudit_actor",DROP COLUMN "actorKind",DROP COLUMN "actorKey";`);
  assert.equal((await f.legacy.getAttentionDetail(central,id)).messages.length,0);
  assert.equal((await f.meta.getMessaging(central,id)).canReply,false);
  await assert.rejects(f.queue(id),{status:503});
  assert.equal((await f.db.query(`SELECT to_regclass('public."AttentionMetaBinding"') AS t`)).rows[0].t,null);
});

test("lecturas enriquecidas usan gates reales, binding y ventana sin red ni pérdida de historial",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("No provider network allowed during polling");});
  const detail=await f.legacy.getAttentionDetail(analyst,row.id);
  const read=env=>createAttentionReadModel({database:f.database,env,now:()=>new Date(instant)});
  const missing=await read(daptaEnv).integration(true);assert.equal(missing.canSync,true);assert.equal(missing.canSend,false);assert.equal(missing.status,"read_only");
  const fallback=await read(daptaEnv).detail(analyst,detail);assert.equal(fallback.permissions.canSend,false);assert.equal(fallback.messaging.canReply,false);assert.deepEqual(fallback.messages,detail.messages);
  for(const overrides of [{WHATSAPP_ATTENTION_SEND_ENABLED:"false"},{WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED:"false"},{WHATSAPP_ATTENTION_ACCESS_TOKEN:undefined}]){
    const model=read({...daptaEnv,...metaEnv,...overrides});assert.equal((await model.integration(true)).canSend,false);assert.equal((await model.integration(true)).canSync,true);
    assert.equal((await model.detail(analyst,detail)).permissions.canSend,false);
  }
  const model=read({...daptaEnv,...metaEnv});assert.equal((await model.integration(true)).canSend,true);assert.equal((await model.integration(false)).canSend,false);
  const enabled=await model.detail(analyst,detail);assert.equal(enabled.permissions.canSend,true);assert.equal(enabled.messaging.canReply,true);assert.equal(enabled.messaging.windowExpiresAt,"2026-10-31T15:00:00.000Z");assert.deepEqual(enabled.messages,detail.messages);
  const expired=createAttentionReadModel({database:f.database,env:metaEnv,now:()=>new Date("2026-10-31T15:00:00Z")});assert.equal((await expired.detail(analyst,detail)).permissions.canSend,false);
  await f.assign(row.id,other);await assert.rejects(model.detail(analyst,detail),{status:404});
});

test("lecturas Meta sin migración conservan detalle y no anuncian envío habilitado",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);const detail=await f.legacy.getAttentionDetail(analyst,row.id);
  await f.db.exec('DROP TABLE "AttentionMetaDelivery","AttentionMetaOutbox","AttentionMetaBinding"');
  const model=createAttentionReadModel({database:f.database,env:{...daptaEnv,...metaEnv},now:()=>new Date(instant)});
  const status=await model.integration(true);assert.equal(status.canSend,false);assert.equal(status.canSync,true);assert.equal(status.status,"meta_pending");
  const enriched=await model.detail(analyst,detail);assert.equal(enriched.permissions.canSend,false);assert.deepEqual(enriched.messages,detail.messages);
});
