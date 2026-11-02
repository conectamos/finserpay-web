import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {PGlite} from "@electric-sql/pglite";
import {createJiti} from "jiti";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root}});
const {createAttentionDaptaEventStore}=await jiti.import("../lib/atencion-dapta-event-storage.ts");
const {parseDaptaAttentionEvent}=await jiti.import("../lib/atencion-dapta-events.ts");
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const scope={workspaceId:"7496b9a3-2fe6-4e28-8411-7d54ee788b2c",agentId:"6f9560ec-dcfd-4725-bf61-27cd8d528a1c",agentChannelId:"6933b28b-b0a1-400c-aa1e-54f75bfbbd91",phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const instant="2026-11-02T01:00:00.000Z",contact="12025550100";
function adapter(db){return{$queryRawUnsafe:async(sql,...values)=>(await db.query(sql,values)).rows,$transaction:fn=>db.transaction(tx=>fn(adapter(tx)))};}
function native(data={}){const conversationId=data.externalConversationId||randomUUID(),messageId=data.messageId||randomUUID(),recipient=data.contactId||contact,inbound=data.inbound===true;return parseDaptaAttentionEvent({
  event:inbound?"new_message_received":"new_message_sent",delivery_id:data.deliveryId||randomUUID(),created_at:instant,workspace_id:scope.workspaceId,agent_id:scope.agentId,agent_channel_id:scope.agentChannelId,phone_number:scope.phoneNumberId,
  conversation:{id:conversationId,organization_id:scope.workspaceId,text_agent_id:scope.agentId,channel_type:"meta_whatsapp",channel_identifier:recipient,metadata:{organization_id:scope.workspaceId,agent_channel_type:"meta_whatsapp",channel_id:scope.agentChannelId}},
  message:{id:messageId,conversation_id:conversationId,direction:inbound?"inbound":"outbound",content_type:"text",content:"NO GUARDAR PENDING",sender_identifier:recipient,recipient_identifier:inbound?scope.phoneNumberId:recipient,status:inbound?"delivered":"pending",created_at:instant,metadata:inbound?{}:{agent_attribution:{agent_id:scope.agentId}}},
},scope,new Date(instant),{allowInbound:inbound});}
function confirmed(job,data={}){return{source:{workspaceId:scope.workspaceId,agentId:scope.agentId,externalConversationId:job.externalConversationId,contactId:job.contactId},message:{id:job.messageId,direction:"outbound",contentType:"text",status:"delivered",text:"Respuesta artificial confirmada",sentAt:instant,...data}};}
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec('CREATE TABLE "Usuario"(id integer PRIMARY KEY); CREATE TABLE "Sede"(id integer PRIMARY KEY); CREATE TABLE "Vendedor"(id integer PRIMARY KEY); CREATE TABLE "Credito"(id integer PRIMARY KEY); INSERT INTO "Usuario" VALUES(7)');
  await db.exec(migration);let clock=new Date(instant);const database=adapter(db),store=createAttentionDaptaEventStore(database,{scope,now:()=>clock});
  const chat=async({externalId=null,recipient=contact,binding=true,status="closed",mode="human_requested"}={})=>{
    const id=randomUUID(),tel=recipient.startsWith("CO.")?null:"+"+recipient;
    await db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name,status,mode,"assigneeUserId","assigneeKey","assigneeName",version,"closedAt") VALUES($1,$2,'whatsapp',$3,'Contacto artificial',$4,$5,7,'analyst:7','Analista',7,'2026-11-02T00:50:00Z')`,[id,externalId,tel,status,mode]);
    if(binding)await db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,scope.phoneNumberId,scope.wabaId,recipient]);
    return id;
  };
  return{db,database,store,chat,advance:ms=>{clock=new Date(clock.getTime()+ms)}};
}

test("event queue is durable, does not portray pending as sent, and repeated delivery is idempotent",async t=>{
  const f=await fixture(t),id=await f.chat(),event=native();
  const first=await f.store.ingest(event),second=await f.store.ingest(event);
  assert.equal(first.linked,true);assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(first.id,second.id);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
  const [row]=(await f.db.query('SELECT * FROM "AttentionDaptaEvent"')).rows;assert.equal(row.conversationId,id);assert.equal(row.status,"pending");assert.equal(JSON.stringify(row).includes("NO GUARDAR"),false);
  assert.equal((await f.db.query('SELECT "externalId" FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].externalId,event.externalConversationId);
  await assert.rejects(f.store.ingest({...native(),deliveryId:event.deliveryId}),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionDaptaEvent"')).rows[0].n,1);
});
test("a confirmed exact UUID enters its bound chat with a system audit and SSE without reopening or reassigning",async t=>{
  const f=await fixture(t),id=await f.chat(),event=native();await f.store.ingest(event);
  const notices=[];await f.db.listen("finserpay_attention_changes",value=>notices.push(JSON.parse(value)));
  const [job]=await f.store.claim();assert.ok(job.leaseToken);assert.deepEqual(await f.store.persistConfirmed(job,confirmed(job)),{imported:true,pendingBinding:false});
  const [row]=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[id])).rows;
  assert.equal(row.status,"closed");assert.equal(row.mode,"human_requested");assert.equal(row.assigneeKey,"analyst:7");assert.equal(row.version,8);
  const [message]=(await f.db.query('SELECT * FROM "AttentionMessage"')).rows;assert.equal(message.externalId,event.messageId);assert.equal(message.author,"Diana");assert.equal(message.deliveryStatus,"delivered");assert.equal(message.metaWamid,null);assert.equal(message.metaPhoneNumberId,null);
  const [audit]=(await f.db.query(`SELECT "actorKind","actorKey","userId",metadata FROM "AttentionAudit" WHERE action='DAPTA_RESPONSE_IMPORTED'`)).rows;
  assert.deepEqual(audit,{actorKind:"system",actorKey:"SYSTEM_DAPTA",userId:null,metadata:{eventId:job.id,count:1}});
  assert.ok(notices.some(n=>n.conversationId===id&&n.currentUserId===7));assert.equal(JSON.stringify(notices).includes("Respuesta artificial"),false);
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"complete");assert.deepEqual(await f.store.claim(),[]);
});
test("leases coordinate replicas, survive a reader restart and reject a stale worker",async t=>{
  const f=await fixture(t);await f.chat();await f.store.ingest(native());
  const [first]=await f.store.claim();assert.deepEqual(await f.store.claim(),[]);
  f.advance(90_001);const other=createAttentionDaptaEventStore(f.database,{scope,now:()=>new Date(Date.parse(instant)+90_001)});const [recovered]=await other.claim();
  assert.notEqual(first.leaseToken,recovered.leaseToken);assert.equal(recovered.attempts,2);
  await assert.rejects(f.store.persistConfirmed(first,confirmed(first)),{code:"DAPTA_EVENT_LEASE_LOST"});
  await other.persistConfirmed(recovered,confirmed(recovered));assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,1);
});
test("retry preserves its own pagination checkpoint and honors a rate limit without advancing broad import",async t=>{
  const f=await fixture(t),id=await f.chat();await f.store.ingest(native());const[job]=await f.store.claim();
  await f.store.retry(job,{delaySeconds:60,code:"DAPTA_RATE_LIMITED",historyCursor:"opaque-forward-page"});assert.deepEqual(await f.store.claim(),[]);
  f.advance(60_000);const[next]=await f.store.claim();assert.equal(next.historyCursor,"opaque-forward-page");assert.equal(next.attempts,2);
  assert.equal((await f.db.query('SELECT "daptaMessagesCursor" FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].daptaMessagesCursor,null);
  await f.store.retry(next,{delaySeconds:1,code:"DAPTA_FAILED"});f.advance(2000);assert.deepEqual(await f.store.claim(),[]);
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"blocked");
});
test("an unbound contact waits instead of selecting a same-phone chat; a later exact Meta binding resolves it",async t=>{
  const f=await fixture(t),event=native();await f.chat({binding:false});assert.equal((await f.store.ingest(event)).linked,false);
  const[job]=await f.store.claim();assert.deepEqual(await f.store.persistConfirmed(job,confirmed(job)),{imported:false,pendingBinding:true});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
  const id=await f.chat();await f.store.persistConfirmed(job,confirmed(job));assert.equal((await f.db.query('SELECT "conversationId" FROM "AttentionMessage"')).rows[0].conversationId,id);
});
test("external and Meta bindings that disagree never merge conversations or overwrite identities",async t=>{
  const f=await fixture(t),event=native();await f.chat();await f.chat({externalId:event.externalConversationId,binding:false});
  await assert.rejects(f.store.ingest(event),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionDaptaEvent"')).rows[0].n,0);
});
test("a legacy same-phone external identity cannot bind a chat belonging to another Meta line",async t=>{
  const f=await fixture(t),event=native(),id=await f.chat({externalId:event.externalConversationId,binding:false});
  await f.db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,"1162059967000417",scope.wabaId,contact]);
  await assert.rejects(f.store.ingest(event),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionDaptaEvent"')).rows[0].n,0);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
});
test("an exact current-line binding does not excuse a foreign WABA on the same conversation",async t=>{
  const f=await fixture(t),event=native(),id=await f.chat();
  await f.db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,$3,$4,$5)`,[randomUUID(),id,scope.phoneNumberId,"2148284059050849","12025550199"]);
  await assert.rejects(f.store.ingest(event),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  assert.equal((await f.db.query('SELECT "externalId" FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].externalId,null);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionDaptaEvent"')).rows[0].n,0);
});
test("persist revalidates the whole conversation binding after a scope changes following ingest",async t=>{
  const f=await fixture(t),event=native(),id=await f.chat();await f.store.ingest(event);const[job]=await f.store.claim();
  await f.db.query(`UPDATE "AttentionMetaBinding" SET "phoneNumberId"=$2 WHERE "conversationId"=$1`,[id,"1162059967000417"]);
  await assert.rejects(f.store.persistConfirmed(job,confirmed(job)),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
  const[row]=(await f.db.query('SELECT status,"leaseToken" FROM "AttentionDaptaEvent"')).rows;
  assert.equal(row.status,"pending");assert.equal(row.leaseToken,job.leaseToken);
});
test("a BSUID binds only through its exact current-line Meta identity and never becomes a phone",async t=>{
  const f=await fixture(t),recipient="CO.A1b2C3",event=native({contactId:recipient}),id=await f.chat({recipient});
  await f.store.ingest(event);const[job]=await f.store.claim();assert.equal(job.phone,null);await f.store.persistConfirmed(job,confirmed(job));
  assert.equal((await f.db.query('SELECT phone FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].phone,null);
  assert.equal((await f.db.query('SELECT "conversationId" FROM "AttentionMessage"')).rows[0].conversationId,id);
});
test("a pending, foreign or altered confirmation cannot be stored and a duplicate legacy UUID is not repeated",async t=>{
  const f=await fixture(t),id=await f.chat(),event=native();await f.store.ingest(event);const[job]=await f.store.claim();
  for(const mutation of [value=>{value.message.status="pending";},value=>{value.source.contactId="12025550199";},value=>{value.message.id=randomUUID();},value=>{value.source.externalConversationId=randomUUID();},value=>{value.message.direction="inbound";}]){
    const value=confirmed(job);mutation(value);await assert.rejects(f.store.persistConfirmed(job,value),{code:"DAPTA_EVENT_SCOPE_MISMATCH"});
  }
  await assert.rejects(f.store.persistConfirmed(job,confirmed(job,{sentAt:"2026-11-02T00:59:59Z"})),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES($1,$2,$3,'outbound','Respuesta artificial confirmada',$4)`,[randomUUID(),id,event.messageId,instant]);
  assert.deepEqual(await f.store.persistConfirmed(job,confirmed(job)),{imported:false,pendingBinding:false});assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,1);
});
test("queue expiry stops polling and the audit actor cannot impersonate a nominal user",async t=>{
  const f=await fixture(t);await f.store.ingest(native());f.advance(15*60*1000+1);assert.deepEqual(await f.store.claim(),[]);
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"blocked");
  await assert.rejects(f.db.query(`INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','SYSTEM_UNKNOWN','BAD')`));
  await assert.rejects(f.db.query(`INSERT INTO "AttentionAudit"("actorKind","actorKey","userId",action) VALUES('system','SYSTEM_DAPTA',7,'BAD')`));
  await f.db.exec(migration);assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionDaptaEvent"')).rows[0].n,1);
});
test("a worker neither claims nor expires another configured channel's jobs",async t=>{
  const f=await fixture(t);await f.store.ingest(native());
  await f.db.query(`UPDATE "AttentionDaptaEvent" SET "agentChannelId"=$1`,[randomUUID()]);f.advance(20*60*1000);
  assert.deepEqual(await f.store.claim(),[]);assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"pending");
});

test("a fresh incoming witness resolves the exact internal chat without duplicating native messages or changing its assignment",async t=>{
  const f=await fixture(t),id=await f.chat(),event=native({inbound:true});await f.store.ingest(event);const[job]=await f.store.claim();
  const proof={...confirmed(job,{direction:"inbound",text:"CONFIRMO PR-0123456789ABCDEF"}),verification:{fresh:true,kind:"lead"}};
  assert.deepEqual(await f.store.getVerifiedConversation(job,proof),{conversationId:id});
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"pending");
  await assert.rejects(f.store.persistConfirmed(job,proof),{code:"DAPTA_EVENT_SCOPE_MISMATCH"});
  assert.deepEqual(await f.store.completeVerifiedInbound(job,proof),{imported:false,pendingBinding:false});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
  const c=(await f.db.query('SELECT status,"assigneeKey",version FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];
  assert.deepEqual(c,{status:"closed",assigneeKey:"analyst:7",version:7});
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"complete");
});
test("inbound identity, live provenance and timestamp are checked again before the financial context can be exposed",async t=>{
  const f=await fixture(t);await f.chat();await f.store.ingest(native({inbound:true}));const[job]=await f.store.claim();
  const make=()=>({...confirmed(job,{direction:"inbound"}),verification:{fresh:true,kind:"lead"}});
  for(const mutate of [p=>{p.verification.kind="agent";},p=>{p.verification.fresh=false;},p=>{p.message.direction="outbound";},p=>{p.source.contactId="12025550199";},p=>{p.message.id=randomUUID();}]){
    const p=make();mutate(p);await assert.rejects(f.store.getVerifiedConversation(job,p),{code:"DAPTA_EVENT_SCOPE_MISMATCH"});
  }
  const old=make();old.message.sentAt="2026-11-02T00:59:59Z";
  await assert.rejects(f.store.getVerifiedConversation(job,old),{code:"DAPTA_EVENT_IDENTITY_CONFLICT"});
  assert.equal((await f.db.query('SELECT status FROM "AttentionDaptaEvent"')).rows[0].status,"pending");
});
test("financial audit identity permits only the explicit system actor without a nominal user or seller",async t=>{
  const f=await fixture(t);
  await f.db.query(`INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','SYSTEM_DIANA','EXTENSION_TEST')`);
  for(const sql of [`INSERT INTO "AttentionAudit"("actorKind","actorKey","userId",action) VALUES('system','SYSTEM_DIANA',7,'BAD')`,
    `INSERT INTO "AttentionAudit"("actorKind","actorKey",action) VALUES('system','SYSTEM_OTHER','BAD')`])await assert.rejects(f.db.query(sql));
});
