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
const {createWhatsAppAutomationMetaStore}=await jiti.import("../lib/whatsapp-automation-meta-storage.ts");
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const scope={phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const central={userId:1,sellerId:null,key:"admin:1",name:"Central",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10};
const analyst={...central,userId:5,key:"analyst:5",name:"Analista A",central:false,admin:false,analyst:true};
const other={...analyst,userId:6,key:"analyst:6",name:"Analista B"};
const phone="+573001234567",contact="573001234567",instant="2026-10-30T15:00:00.000Z";
const inbound=(data={})=>({id:`wamid.${randomUUID()}`,from:contact,phone,name:"Contacto",timestamp:instant,type:"text",text:"Consulta",...data});
const echo=(data={})=>({...inbound(),from:"573124085562",to:contact,name:null,text:"Respuesta desde el teléfono",...data});
const events=(messages=[],statuses=[],echoes=[])=>({scope,messages,statuses,echoes,ignored:0});
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
    CREATE TABLE "Credito"(id integer PRIMARY KEY,"clienteTelefono" text,"clienteNombre" text,"clienteDocumento" text,estado text DEFAULT 'ACTIVO');
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
  assert.deepEqual(await f.meta.ingest(events([msg])),{messagesImported:1,echoesImported:0,statusesApplied:0});
  assert.deepEqual(await f.meta.ingest(events([msg])),{messagesImported:0,echoesImported:0,statusesApplied:0});
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

test("respuesta móvil limpia solo entrantes anteriores para equipo y conserva recientes, misma fecha y estado",async t=>{
  const f=await fixture(t);const old=inbound({timestamp:'2026-10-30T14:59:59Z'}),row=await f.ingest(old);await f.assign(row.id);
  const same=inbound(),later=inbound({timestamp:'2026-10-30T15:01:00Z'});
  await f.meta.ingest(events([same,later]));
  await f.db.query(`UPDATE "AttentionConversation" SET status='closed',"closedAt"='2026-10-30T15:02:00Z' WHERE id=$1`,[row.id]);
  const before=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  const notices=[];await f.db.listen('finserpay_attention_changes',value=>notices.push(JSON.parse(value)));
  const response=echo();await f.meta.ingest(events([],[],[response]));
  await f.meta.ingest(events([],[],[response]));
  const reads=(await f.db.query(`SELECT m."metaWamid",r.source,r."actorUserId",reply."metaWamid" AS reply FROM "AttentionTeamReadState" r
    JOIN "AttentionMessage" m ON m.id=r."messageId" JOIN "AttentionMessage" reply ON reply.id=r."replyMessageId"`)).rows;
  assert.deepEqual(reads,[{metaWamid:old.id,source:'business_reply',actorUserId:null,reply:response.id}]);
  for(const actor of [central,analyst])assert.equal((await f.legacy.getAttentionInbox(actor,{search:'',filter:'all',page:1})).conversations[0].unreadCount,2);
  const after=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  for(const key of ['version','status','assigneeKey','lastContactAt','closedAt'])assert.deepEqual(after[key],before[key]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionReadState"')).rows[0].n,0);
  const audit=(await f.db.query(`SELECT "actorKind","actorKey","userId",metadata FROM "AttentionAudit" WHERE action='MESSAGES_TEAM_READ_BUSINESS_REPLY'`)).rows;
  assert.deepEqual(audit,[{actorKind:'system',actorKey:'SYSTEM_META',userId:null,metadata:{count:1}}]);
  assert.ok(notices.some(n=>n.conversationId===row.id&&n.currentUserId===analyst.userId&&n.currentKey===analyst.key&&!('readActorUserId' in n)));
});

test("eco nuevo cubre entradas retrasadas y Dapta anterior, pero eco histórico ni recibos de salida generan lectura compartida",async t=>{
  const f=await fixture(t),row=await f.ingest(inbound({timestamp:'2026-10-30T14:00:00Z'}));
  const response=echo({timestamp:'2026-10-30T15:00:00Z'});await f.meta.ingest(events([],[],[response]));
  const late=inbound({timestamp:'2026-10-30T14:30:00Z'});await f.meta.ingest(events([late]));
  await f.legacy.importAttentionSnapshots(central,[snapshot({messages:[{id:'dapta-late-old',direction:'inbound',text:'Antiguo',sentAt:'2026-10-29T12:00:00Z',author:null}]})]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionTeamReadState"')).rows[0].n,3);
  const current=inbound({timestamp:'2026-10-30T16:00:00Z'});await f.meta.ingest(events([current]));
  await f.meta.ingest(events([], [delivery(response.id,{timestamp:'2026-10-30T16:05:00Z',status:'read'})]));
  assert.equal((await f.legacy.getAttentionInbox(central,{search:'',filter:'all',page:1})).conversations[0].unreadCount,1);
  // Simulate an app echo from a pre-upgrade binary; the additive default is false.
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,"metaWamid","metaPhoneNumberId","deliveryStatus")
    VALUES($1,$2,'meta:wamid.legacy-echo','outbound','Viejo','2026-10-30T18:00:00Z','WhatsApp Business','wamid.legacy-echo',$3,'sent')`,[randomUUID(),row.id,scope.phoneNumberId]);
  await f.meta.ingest(events([inbound({timestamp:'2026-10-30T17:00:00Z'})]));
  assert.equal((await f.legacy.getAttentionInbox(central,{search:'',filter:'all',page:1})).conversations[0].unreadCount,2);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionTeamReadState"')).rows[0].n,3);
});

test("lectura compartida no puede reutilizar UUID del outbox humano y su propia reserva bloquea un envío posterior",async t=>{
  const f=await fixture(t),row=await f.ingest(),input=await f.input(row.id);
  await f.meta.queueReply(central,row.id,input);
  await assert.rejects(f.legacy.markAttentionTeamRead(central,row.id,{requestId:input.requestId,version:input.version}),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionTeamReadState"')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionRequest" WHERE "requestId"=$1',[input.requestId])).rows[0].n,0);
  const mark={requestId:randomUUID(),version:input.version};await f.legacy.markAttentionTeamRead(central,row.id,mark);
  await assert.rejects(f.meta.queueReply(central,row.id,{...input,requestId:mark.requestId}),{status:409});
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
  // Recreate the pre-Meta schema, which also predates realtime triggers.
  await f.db.exec(`DROP TRIGGER attention_realtime_conversation ON "AttentionConversation";
    DROP TRIGGER attention_realtime_message ON "AttentionMessage";
    DROP TABLE "AttentionMetaDelivery","AttentionMetaOutbox","AttentionMetaBinding";
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

test("eco de WhatsApp conserva chat cerrado, analista, modo y ventana; duplica cero y no retrocede actividad",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  await f.db.query(`UPDATE "AttentionConversation" SET status='closed',mode='human',"closedAt"=$2 WHERE id=$1`,[row.id,instant]);
  const before=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  const notifications=[];await f.db.listen("finserpay_attention_changes",payload=>notifications.push(JSON.parse(payload)));
  const msg=echo({timestamp:"2026-10-31T16:00:00.000Z",text:"Mensaje reciente"});
  assert.deepEqual(await f.meta.ingest(events([],[],[msg])),{messagesImported:0,echoesImported:1,statusesApplied:0});
  const newest=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  for(const key of ["status","mode","assigneeUserId","assigneeKey","assigneeName","closedAt","metaLastInboundAt","externalId","sedeId"])assert.deepEqual(newest[key],before[key],key);
  assert.equal(new Date(newest.lastContactAt).toISOString(),msg.timestamp);
  assert.ok(notifications.some(event=>event.conversationId===row.id&&event.currentUserId===analyst.userId));
  assert.ok(!JSON.stringify(notifications).includes("Mensaje reciente"));assert.ok(!JSON.stringify(notifications).includes(phone));
  await f.meta.ingest(events([],[],[echo({timestamp:"2026-10-29T15:00:00.000Z",text:"Historia anterior"})]));
  const historical=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  assert.deepEqual(historical,newest);
  const repeated=await Promise.all([f.meta.ingest(events([],[],[msg])),f.meta.ingest(events([],[],[msg]))]);
  assert.deepEqual(repeated.map(result=>result.echoesImported),[0,0]);
  const detail=await f.legacy.getAttentionDetail(analyst,row.id);
  const inbox=await f.legacy.getAttentionInbox(analyst,{filter:"all",search:"",page:1});
  assert.equal(inbox.conversations[0].preview,"Mensaje reciente");assert.equal(detail.messages.filter(m=>m.direction==="outbound").length,2);
  assert.equal(detail.messages.at(-1).author,"WhatsApp Business");assert.equal(detail.messages.at(-1).deliveryStatus,"sent");
  f.advance(25*3600000);assert.equal((await f.meta.getMessaging(analyst,row.id)).canReply,false);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
});

test("primer eco crea contacto sin inventar nombre, entrante, asignación ni ventana de 24 horas",async t=>{
  const f=await fixture(t);const msg=echo();await f.meta.ingest(events([],[],[msg]));
  const row=(await f.db.query('SELECT * FROM "AttentionConversation"')).rows[0];
  assert.equal(row.phone,phone);assert.equal(row.name,phone);assert.equal(row.metaManaged,true);
  assert.equal(row.metaLastInboundAt,null);assert.equal(row.assigneeKey,null);assert.equal(row.mode,"unknown");
  assert.deepEqual(await f.meta.getMessaging(central,row.id),{windowExpiresAt:null,canReply:false,reason:"Aún no se ha recibido un mensaje del cliente que habilite la ventana de respuesta de 24 horas."});
  await assert.rejects(f.queue(row.id),{status:409});
  const bindings=(await f.db.query('SELECT "contactId","phoneNumberId","wabaId" FROM "AttentionMetaBinding"')).rows;
  assert.deepEqual(bindings,[{contactId:contact,...scope}]);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" WHERE direction='inbound'`)).rows[0].n,0);
  const audit=(await f.db.query(`SELECT "actorKind","actorKey","userId" FROM "AttentionAudit" WHERE action='META_MESSAGE_ECHOED'`)).rows;
  assert.deepEqual(audit,[{actorKind:"system",actorKey:"SYSTEM_META",userId:null}]);
});

test("ecos reutilizan solo teléfono exacto único y no eligen arbitrariamente entre chats compartidos",async t=>{
  const f=await fixture(t);await f.legacy.importAttentionSnapshots(central,[snapshot()]);
  const original=(await f.db.query('SELECT id FROM "AttentionConversation"')).rows[0].id;await f.assign(original);
  assert.equal((await f.meta.getMessaging(analyst,original)).reason,"Este chat aún no está vinculado a la línea de WhatsApp de FINSER PAY. La respuesta por este canal todavía no está disponible.");
  await f.meta.ingest(events([],[],[echo()]));
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,1);
  assert.equal((await f.db.query('SELECT "assigneeKey" FROM "AttentionConversation" WHERE id=$1',[original])).rows[0].assigneeKey,analyst.key);
  const otherPhone="+573009999999";
  await f.legacy.importAttentionSnapshots(central,[snapshot({externalId:"shared-a",phone:otherPhone}),snapshot({externalId:"shared-b",phone:otherPhone})]);
  await f.meta.ingest(events([],[],[echo({to:otherPhone.slice(1),phone:otherPhone})]));
  const shared=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE phone=$1',[otherPhone])).rows;
  assert.equal(shared.length,3);const created=shared.find(row=>row.metaManaged);assert.equal(created.externalId,null);assert.equal(created.assigneeKey,null);assert.equal(created.sedeId,null);
});

test("adjuntos de ecos usan medios privados y autorización actual, nunca URL ni media ID públicos",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  const kinds={image:"image/jpeg",audio:"audio/ogg",video:"video/mp4",document:"application/pdf",sticker:"image/webp"};
  const messages=Object.entries(kinds).map(([kind,mimeType],index)=>echo({type:kind,text:undefined,replyToId:"wamid.parent",
    timestamp:`2026-10-30T15:00:0${index+1}.000Z`,media:{id:`12345678${index}`,mimeType,fileName:`archivo-${index}`,sha256:"a".repeat(64)}}));
  assert.equal((await f.meta.ingest(events([],[],messages))).echoesImported,5);
  const detail=await f.legacy.getAttentionDetail(analyst,row.id),outbound=detail.messages.filter(m=>m.direction==="outbound");
  const inbox=await f.legacy.getAttentionInbox(analyst,{filter:"all",search:"",page:1});
  assert.equal(outbound.length,5);assert.equal(inbox.conversations[0].preview,"Sticker");
  for(const [index,message] of outbound.entries()){
    assert.equal(message.text,"");assert.equal(message.author,"WhatsApp Business");assert.equal(message.attachment.kind,messages[index].type);
    assert.equal(message.attachment.url,`/api/atencion/${row.id}/messages/${message.id}/media`);
    assert.ok(!JSON.stringify(message).includes(messages[index].media.id));assert.ok(!JSON.stringify(message).includes(messages[index].id));
    assert.equal((await f.meta.getMedia(analyst,row.id,message.id)).mediaId,messages[index].media.id);
    await assert.rejects(f.meta.getMedia(other,row.id,message.id),{status:404});
  }
  await f.assign(row.id,other);await assert.rejects(f.meta.getMedia(analyst,row.id,outbound[0].id),{status:404});
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" WHERE "replyToWamid"='wamid.parent'`)).rows[0].n,5);
});

test("ingest revalida negocio, destinatario, teléfono y scope de ecos aun sin pasar por parser",async t=>{
  const f=await fixture(t);
  for(const patch of [{from:"573000000000"},{from:"+573124085562"},{to:"573124085562",phone:"+573124085562"},
    {to:"573009999999"},{phone:"+573009999999"},{to:"+573001234567"},{to:"abc"},{name:"Nombre inventado"}]){
    await assert.rejects(f.meta.ingest(events([],[],[echo(patch)])),{status:403});
  }
  await assert.rejects(f.meta.ingest({...events([],[],[echo()]),scope:{...scope,phoneNumberId:"wrong"}}),{status:403});
  await assert.rejects(f.meta.ingest({...events(),echoes:{}}),{status:400});
  await assert.rejects(f.meta.ingest(events([],[],Array.from({length:1001},()=>echo()))),{status:400});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
});

test("contactos internacionales de eco y entrante se conservan exactos sin inferir un número colombiano ajeno",async t=>{
  const f=await fixture(t);await f.legacy.importAttentionSnapshots(central,[snapshot({phone:"+573612345678"})]);
  const local=(await f.db.query('SELECT id FROM "AttentionConversation"')).rows[0].id;await f.assign(local);
  for(const destination of ["3612345678","1234567"]){
    await f.meta.ingest(events([],[],[echo({to:destination,phone:`+${destination}`})]));
    await f.meta.ingest(events([inbound({from:destination,phone:`+${destination}`})]));
  }
  const chats=(await f.db.query('SELECT id,phone,"assigneeKey" FROM "AttentionConversation" ORDER BY phone')).rows;
  assert.equal(chats.length,3);assert.equal(chats.find(row=>row.id===local).assigneeKey,analyst.key);
  for(const destination of ["3612345678","1234567"]){const created=chats.find(row=>row.phone===`+${destination}`);assert.ok(created);assert.equal(created.assigneeKey,null);}
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage" WHERE "conversationId"=$1',[local])).rows[0].n,0);
  await assert.rejects(f.meta.ingest(events([inbound({from:"3612345678",phone:"+573612345678"})])),{status:403});
});

test("colisión de eco con mensaje CRM conserva autor, texto, estado y propiedad; otro destinatario se rechaza",async t=>{
  const f=await fixture(t);const row=await f.ingest();await f.assign(row.id);
  const q=await f.queue(row.id,analyst),claim=await f.meta.claimReply(analyst,row.id,q.requestId);
  await f.meta.beforeSend(analyst,q.id,claim.reply.leaseToken);await f.meta.acceptReply(q.id,claim.reply.leaseToken,"wamid.crm-echo");
  await f.meta.ingest(events([],[delivery("wamid.crm-echo",{status:"read"})]));
  const before=(await f.db.query('SELECT * FROM "AttentionMessage" WHERE "metaWamid"=$1',["wamid.crm-echo"])).rows[0];
  const conversation=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0];
  assert.equal((await f.meta.ingest(events([],[],[echo({id:"wamid.crm-echo",text:"No sobreescribir",timestamp:"2026-11-01T15:00:00.000Z"})]))).echoesImported,0);
  assert.deepEqual((await f.db.query('SELECT * FROM "AttentionMessage" WHERE id=$1',[before.id])).rows[0],before);
  assert.deepEqual((await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0],conversation);
  await assert.rejects(f.meta.ingest(events([],[],[echo({id:"wamid.crm-echo",to:"573009999999",phone:"+573009999999"})])),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,1);
});

test("eco de plantilla ya confirmada no duplica ni sustituye el registro de automatización",async t=>{
  const f=await fixture(t);await f.db.exec(readFileSync(path.join(root,"scripts/setup-whatsapp-automation-meta.sql"),"utf8"));
  const automation=createWhatsAppAutomationMetaStore(f.database,{now:()=>new Date(instant)});
  const {row}=await automation.reserve({operationKey:"bienvenida:credito:123",template:"bienvenida",phone:contact,body:["Cliente de prueba"]});
  await automation.prepare(row.id,row.leaseToken,{text:"Bienvenida aprobada",metadata:{}});await automation.start(row.id,row.leaseToken);await automation.accept(row.id,"wamid.automation-echo");
  await f.meta.ingest(events([],[delivery("wamid.automation-echo",{status:"read"})]));
  const before=(await f.db.query('SELECT * FROM "AttentionMessage" WHERE id=$1',[row.messageId])).rows[0];
  assert.equal((await f.meta.ingest(events([],[],[echo({id:"wamid.automation-echo"})]))).echoesImported,0);
  assert.deepEqual((await f.db.query('SELECT * FROM "AttentionMessage" WHERE id=$1',[row.messageId])).rows[0],before);
  assert.equal(before.author,"Automatización FINSER PAY");assert.equal(before.deliveryStatus,"read");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,1);
});

test("recibos de ecos coinciden con destinatario, reconcilian llegada anticipada y nunca inventan outbox",async t=>{
  const f=await fixture(t);const msg=echo({id:"wamid.echo-receipts"});
  const early=delivery(msg.id,{status:"delivered",timestamp:"2026-10-30T15:01:00.000Z"});
  assert.equal((await f.meta.ingest(events([],[early]))).statusesApplied,0);
  assert.equal((await f.meta.ingest(events([],[],[msg]))).statusesApplied,1);
  const get=async()=>(await f.db.query('SELECT * FROM "AttentionMessage" WHERE "metaWamid"=$1',[msg.id])).rows[0];
  assert.equal((await get()).deliveryStatus,"delivered");
  for(const patch of [{recipient:"573009999999"},{requestId:randomUUID()}])assert.equal((await f.meta.ingest(events([],[delivery(msg.id,{status:"read",timestamp:"2026-10-30T15:02:00Z",...patch})]))).statusesApplied,0);
  assert.equal((await get()).deliveryStatus,"delivered");
  await f.meta.ingest(events([],[delivery(msg.id,{status:"read",timestamp:"2026-10-30T15:03:00Z"})]));
  const read=await get();assert.equal(read.deliveryStatus,"read");
  await f.meta.ingest(events([],[early,delivery(msg.id,{status:"failed",timestamp:"2026-10-30T15:04:00Z"})]));
  assert.equal((await get()).deliveryStatus,"read");
  await f.meta.ingest(events([],[],[msg]));assert.equal((await get()).deliveryStatus,"read");
  const failed=echo({id:"wamid.echo-failed"});await f.meta.ingest(events([],[],[failed]));
  await f.meta.ingest(events([],[delivery(failed.id,{status:"failed",timestamp:"2026-10-30T15:02:00Z"}),delivery(failed.id,{status:"sent",timestamp:"2026-10-30T15:01:00Z"})]));
  assert.equal((await f.db.query('SELECT "deliveryStatus" FROM "AttentionMessage" WHERE "metaWamid"=$1',[failed.id])).rows[0].deliveryStatus,"failed");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
});

test("fallo de eco en el mismo segundo prevalece sobre sent antes o después de importar el eco",async t=>{
  const f=await fixture(t);
  for(const before of [false,true]){
    const msg=echo(),receipt=delivery(msg.id,{status:"failed"});
    if(before)await f.meta.ingest(events([],[receipt]));
    await f.meta.ingest(events([],[],[msg]));
    if(!before)await f.meta.ingest(events([],[receipt]));
    await f.meta.ingest(events([],[delivery(msg.id,{status:"sent"})]));
    assert.equal((await f.db.query('SELECT "deliveryStatus" FROM "AttentionMessage" WHERE "metaWamid"=$1',[msg.id])).rows[0].deliveryStatus,"failed");
  }
});

test("identificador externo ya existente se conserva y un eco inválido revierte todo el lote",async t=>{
  const f=await fixture(t);const row=await f.ingest();const id=randomUUID(),msg=echo({id:"wamid.external-existing"});
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1,$2,$3,'outbound','Histórico',$4,'Autor anterior')`,[id,row.id,`meta:${msg.id}`,instant]);
  const before=(await f.db.query('SELECT * FROM "AttentionMessage" WHERE id=$1',[id])).rows[0];
  assert.equal((await f.meta.ingest(events([],[],[msg]))).echoesImported,0);
  assert.deepEqual((await f.db.query('SELECT * FROM "AttentionMessage" WHERE id=$1',[id])).rows[0],before);
  const invalid=echo({to:"573009999999",phone:"+573009999999",id:"wamid.z-invalid",text:"",type:"image",media:{id:"bad id",mimeType:"image/jpeg"}});
  await assert.rejects(f.meta.ingest(events([],[],[echo({id:"wamid.a-valid"}),invalid])),{status:400});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,2);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,1);
});


const bsuid="CO.1234567890123456",otherBsuid="CO.2234567890123456";
const opaqueInbound=(data={})=>inbound({from:bsuid,userId:bsuid,phone:null,username:"Juan_esteban429",name:"Juan Esteban",...data});

test("BSUID recibe texto y medios privados, aparece por usuario y responde sin inventar un teléfono ni crédito",async t=>{
  const f=await fixture(t);await f.db.query(`INSERT INTO "Credito"(id,"clienteTelefono","clienteNombre","clienteDocumento") VALUES(7,$1,'Otro cliente','123')`,[phone]);
  const first=opaqueInbound(),row=await f.ingest(first);await f.assign(row.id);
  assert.equal(row.phone,null);assert.equal(row.name,"Juan Esteban · @Juan_esteban429");
  const image=opaqueInbound({type:"image",text:undefined,media:{id:"987654321",mimeType:"image/png",fileName:"foto.png"}});
  const video=opaqueInbound({type:"video",text:undefined,media:{id:"987654322",mimeType:"video/mp4",fileName:"video.mp4"}});
  await f.meta.ingest(events([image,video]));assert.deepEqual(await f.meta.ingest(events([first,image,video])),{messagesImported:0,echoesImported:0,statusesApplied:0});
  const inbox=await f.legacy.getAttentionInbox(analyst,{search:"@Juan_esteban429",filter:"all",page:1});assert.equal(inbox.total,1);assert.equal(inbox.conversations[0].phone,null);assert.deepEqual(inbox.conversations[0].autoTags,[]);
  const detail=await f.legacy.getAttentionDetail(analyst,row.id);assert.equal(detail.messages.length,3);assert.equal(detail.customer.match,"none");
  const media=detail.messages.find(message=>message.attachment?.kind==="image");assert.equal((await f.meta.getMedia(analyst,row.id,media.id)).mediaId,"987654321");
  await assert.rejects(f.meta.getMedia(other,row.id,media.id),{status:404});assert.equal((await f.meta.getMessaging(analyst,row.id)).canReply,true);
  assert.equal((await f.meta.getTemplateAccess(analyst,row.id)).canSend,false);
  const queued=await f.queue(row.id,analyst),claim=await f.meta.claimReply(analyst,row.id,queued.requestId);assert.equal(queued.contactId,bsuid);
  await f.meta.beforeSend(analyst,queued.id,claim.reply.leaseToken);const ack=await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.bsuid-reply");
  assert.equal(ack.contactId,bsuid);await f.meta.ingest(events([],[delivery(ack.wamid,{recipient:bsuid,userId:bsuid,status:"read"})]));assert.equal((await f.meta.findReply(analyst,row.id,queued.requestId)).status,"read");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation" WHERE phone IS NOT NULL')).rows[0].n,0);
});

test("alias coacreditado conserva el chat, el intento telefónico, las plantillas y el historial de WhatsApp Business",async t=>{
  const f=await fixture(t),first=inbound(),row=await f.ingest(first),queued=await f.queue(row.id),claim=await f.meta.claimReply(central,row.id,queued.requestId);
  const version=(await f.db.query('SELECT version FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0].version;
  await f.meta.ingest(events([{...first,userId:bsuid,username:"Juan_esteban429"}]));
  assert.equal((await f.db.query('SELECT version FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0].version,version);
  assert.deepEqual((await f.db.query('SELECT "contactId" FROM "AttentionMetaBinding" ORDER BY "contactId"')).rows.map(value=>value.contactId),[contact,bsuid].sort());
  await f.meta.beforeSend(central,queued.id,claim.reply.leaseToken);await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.phone-alias-reply");
  await f.meta.ingest(events([],[delivery("wamid.phone-alias-reply",{recipient:bsuid,userId:bsuid,status:"read"})]));assert.equal((await f.meta.findReply(central,row.id,queued.requestId)).status,"read");
  await f.meta.ingest(events([opaqueInbound()]));const capability=await f.meta.getTemplateAccess(central,row.id);assert.equal(capability.canSend,true);assert.equal(capability.requiresBindingConfirmation,false);
  const next=await f.queue(row.id);assert.equal(next.contactId,contact);await f.meta.cancelReply(central,row.id,next.requestId);
  const app=echo({to:bsuid,userId:bsuid,phone:null,username:"Juan_esteban429"});await f.meta.ingest(events([],[],[app]));
  assert.equal((await f.db.query('SELECT name FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0].name,"Juan Esteban · @Juan_esteban429");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,1);assert.equal((await f.db.query('SELECT phone FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0].phone,phone);
  await f.meta.ingest(events([],[delivery(app.id,{recipient:contact,status:"read"})]));assert.equal((await f.db.query('SELECT "deliveryStatus" FROM "AttentionMessage" WHERE "metaWamid"=$1',[app.id])).rows[0].deliveryStatus,"read");
});

test("un intento BSUID sigue fijado cuando un evento repetido acredita después el teléfono",async t=>{
  const f=await fixture(t),first=opaqueInbound(),row=await f.ingest(first),queued=await f.queue(row.id),claim=await f.meta.claimReply(central,row.id,queued.requestId);
  await f.meta.ingest(events([{...first,from:contact,phone,userId:bsuid}]));
  assert.equal((await f.db.query('SELECT phone FROM "AttentionConversation" WHERE id=$1',[row.id])).rows[0].phone,phone);
  await f.meta.beforeSend(central,queued.id,claim.reply.leaseToken);await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.pinned-bsuid");
  const later=await f.queue(row.id);assert.equal(later.contactId,contact);assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,1);
});

test("colisiones entre teléfono y BSUID, cuentas ajenas y parejas incoherentes no fusionan ni importan mensajes",async t=>{
  const f=await fixture(t);await f.ingest();await f.ingest(opaqueInbound({name:"Contacto",username:null}));
  const before=(await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n;
  await assert.rejects(f.meta.ingest(events([inbound({userId:bsuid})])),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,before);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionConversation"')).rows[0].n,2);
  for(const message of [inbound({phone:null}),opaqueInbound({phone}),inbound({userId:"@nombre"}),opaqueInbound({userId:otherBsuid})])await assert.rejects(f.meta.ingest(events([message])),{status:403});
  await f.db.query(`UPDATE "AttentionMetaBinding" SET "wabaId"='foreign-account' WHERE "contactId"=$1`,[bsuid]);
  await assert.rejects(f.meta.ingest(events([opaqueInbound()])),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,before);
});

test("estados anticipados BSUID se reaplican localmente al acreditar alias y ecos opacos conservan recibos y dedupe",async t=>{
  const f=await fixture(t),row=await f.ingest(),queued=await f.queue(row.id),claim=await f.meta.claimReply(central,row.id,queued.requestId);
  await f.meta.beforeSend(central,queued.id,claim.reply.leaseToken);await f.meta.acceptReply(queued.id,claim.reply.leaseToken,"wamid.pending-alias");
  assert.equal((await f.meta.ingest(events([],[delivery("wamid.pending-alias",{recipient:bsuid,userId:bsuid,status:"read"})]))).statusesApplied,0);
  assert.equal((await f.meta.ingest(events([inbound({userId:bsuid})]))).statusesApplied,1);assert.equal((await f.meta.findReply(central,row.id,queued.requestId)).status,"read");
  const app=echo({id:"wamid.bsuid-echo",to:otherBsuid,userId:otherBsuid,phone:null,username:"otro_usuario"});
  await f.meta.ingest(events([],[delivery(app.id,{recipient:otherBsuid,userId:otherBsuid,status:"read"})]));
  assert.equal((await f.meta.ingest(events([],[],[app]))).statusesApplied,1);assert.equal((await f.meta.ingest(events([],[],[app]))).echoesImported,0);
  const opaque=(await f.db.query('SELECT c.* FROM "AttentionConversation" c JOIN "AttentionMetaBinding" b ON b."conversationId"=c.id WHERE b."contactId"=$1',[otherBsuid])).rows[0];
  assert.equal(opaque.phone,null);assert.equal(opaque.name,"@otro_usuario");assert.equal((await f.meta.getMessaging(central,opaque.id)).canReply,false);
  assert.equal((await f.db.query('SELECT "deliveryStatus" FROM "AttentionMessage" WHERE "metaWamid"=$1',[app.id])).rows[0].deliveryStatus,"read");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,1);
});

test("automatizaciones numéricas aceptan estado BSUID solo tras alias acreditado de la misma conversación",async t=>{
  const f=await fixture(t);await f.db.exec(readFileSync(path.join(root,"scripts/setup-whatsapp-automation-meta.sql"),"utf8"));
  const automation=createWhatsAppAutomationMetaStore(f.database,{now:()=>new Date(instant)}),{row}=await automation.reserve({operationKey:"bienvenida:credito:456",template:"bienvenida",phone:contact,body:["Cliente de prueba"]});
  await automation.prepare(row.id,row.leaseToken,{text:"Bienvenida",metadata:{}});await automation.start(row.id,row.leaseToken);await automation.accept(row.id,"wamid.automation-user-id");
  assert.equal((await f.meta.ingest(events([],[delivery("wamid.automation-user-id",{recipient:bsuid,userId:bsuid,status:"read"})]))).statusesApplied,0);
  assert.equal((await f.meta.ingest(events([inbound({userId:bsuid})]))).statusesApplied,1);
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1',[row.id])).rows[0].status,"read");
  assert.equal((await f.db.query(`SELECT recipient FROM "AttentionMetaDelivery" WHERE wamid='wamid.automation-user-id'`)).rows[0].recipient,bsuid,"el estado anterior no aprende ni modifica alias");
  const later=delivery("wamid.automation-user-id",{recipient:bsuid,userId:bsuid,status:"delivered",timestamp:"2026-10-30T15:01:00Z"});await f.meta.ingest(events([],[later]));
  assert.equal((await f.db.query(`SELECT recipient FROM "AttentionMetaDelivery" WHERE status='delivered'`)).rows[0].recipient,contact);
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1',[row.id])).rows[0].status,"read");
});

test("un estado dual contradictorio no avanza automatizaciones ni se guarda sin su contradicción para replay",async t=>{
  const f=await fixture(t);await f.db.exec(readFileSync(path.join(root,"scripts/setup-whatsapp-automation-meta.sql"),"utf8"));
  const automation=createWhatsAppAutomationMetaStore(f.database,{now:()=>new Date(instant)}),{row}=await automation.reserve({operationKey:"bienvenida:credito:457",template:"bienvenida",phone:contact,body:["Cliente de prueba"]});
  await automation.prepare(row.id,row.leaseToken,{text:"Bienvenida",metadata:{}});await automation.start(row.id,row.leaseToken);await automation.accept(row.id,"wamid.automation-conflicting-alias");
  await f.ingest(opaqueInbound());
  const conflict=delivery("wamid.automation-conflicting-alias",{recipient:contact,userId:bsuid,status:"read"});
  assert.equal((await f.meta.ingest(events([],[conflict]))).statusesApplied,0);
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1',[row.id])).rows[0].status,"accepted");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaDelivery"')).rows[0].n,0);
  await f.db.query(`UPDATE "AttentionMetaBinding" SET "wabaId"='foreign-account' WHERE "contactId"=$1`,[bsuid]);
  assert.equal((await f.meta.ingest(events([],[{...conflict,timestamp:"2026-10-30T15:01:00Z"}]))).statusesApplied,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaDelivery"')).rows[0].n,0);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='META_DELIVERY_IDENTITY_REJECTED' AND metadata='{}'::jsonb`)).rows[0].n,2);
  assert.equal((await f.meta.ingest(events([],[delivery(conflict.id,{status:"delivered"})]))).statusesApplied,1,"legacy telefónico conserva funcionamiento");
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox" WHERE id=$1',[row.id])).rows[0].status,"delivered");
});
