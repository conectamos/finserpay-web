import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";

const root=path.resolve(import.meta.dirname,".."),jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const bulk=await jiti.import("../lib/atencion-bulk-close.ts"),http=await jiti.import("../lib/atencion-http.ts"),core=await jiti.import("../lib/atencion-core.ts");
const admin={userId:1,sellerId:null,key:"admin:1",name:"Nombre en sesión desactualizado",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10};
const other={...admin,userId:2,key:"admin:2"},analyst={...admin,userId:5,key:"analyst:5",central:false,admin:false,analyst:true};
const clock="2030-10-30T21:20:00.000Z",cutoff="2030-10-30T21:19:13.000Z",older="2030-10-30T20:00:00.000Z",later="2030-10-30T21:19:14.000Z";
function database(db){return {$queryRawUnsafe:async(sql,...args)=>(await db.query(sql,args)).rows,$transaction:run=>db.transaction(tx=>run(database(tx)))};}
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close());let current=new Date(clock);
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,"aliadoId" integer,activa boolean);CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"sedeId" integer,"rolId" integer);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);CREATE TABLE "Credito"(id integer PRIMARY KEY);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);INSERT INTO "Sede" VALUES(10,1,true);
    INSERT INTO "Usuario" VALUES(1,'Administrador nominal real',true,10,1),(2,'Otro administrador',true,10,1),(5,'Analista',true,10,2);`);
  await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  const store=bulk.createAttentionBulkCloseStore(database(db),{now:()=>current});
  async function chat(patch={}){
    const id=randomUUID();await db.query(`INSERT INTO "AttentionConversation"(id,channel,name,status,mode,"assigneeKey","assigneeUserId","assigneeName",tags,"lastContactAt","createdAt","sectionId","boardVersion")
      VALUES($1,'whatsapp','PRIVATE CONTACT',$2,'human','analyst:5',5,'Analista','["Etiqueta manual"]',$3,$4,'f15e0001-0c30-5000-8000-000000000001',7)`,[id,patch.status??"open",patch.activity??older,patch.createdAt??older]);return id;
  }
  async function message(id,sentAt=older,direction="inbound"){
    const messageId=randomUUID();await db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES($1,$2,$3,$4,'PRIVATE MESSAGE',$5)`,[messageId,id,messageId,direction,sentAt]);return messageId;
  }
  async function outbox(id,status="queued",requestId=randomUUID()){
    await db.query(`INSERT INTO "AttentionMetaOutbox"(id,"conversationId","userId","actorKey","authorName","requestId",fingerprint,"conversationVersion","phoneNumberId","wabaId","contactId",text,status)
      VALUES($1,$2,1,'admin:1','Admin',$3,'test',1,'line','waba','phone','Pendiente',$4)`,[randomUUID(),id,requestId,status]);return requestId;
  }
  return {db,store,chat,message,outbox,setNow:value=>{current=new Date(value);},input:review=>({reviewToken:review.reviewToken,requestId:randomUUID(),confirmed:true})};
}
test("cierre conjunto conserva secciones/asignación/historia y sólo acredita lectura a su administrador",async t=>{
  const f=await fixture(t),id=await f.chat(),first=await f.message(id),second=await f.message(id),outbound=await f.message(id,older,"outbound");
  const before=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];
  const review=await f.store.preview(admin,cutoff);assert.deepEqual([review.totalCount,review.openCount,review.closeCount,review.unreadCount,review.skippedCount],[1,1,1,2,0]);
  assert.ok(!JSON.stringify(review).includes(id));assert.ok(!JSON.stringify(review).includes("PRIVATE"));
  const result=await f.store.close(admin,f.input(review));assert.deepEqual(result,{cutoff,closedCount:1,readCount:2,skippedCount:0});
  const after=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];assert.equal(after.status,"closed");assert.equal(after.closedAt.toISOString(),cutoff);assert.equal(after.version,before.version+1);
  for(const key of ["sectionId","boardVersion","assigneeKey","assigneeUserId","assigneeName","mode","tags","lastContactAt"])assert.deepEqual(after[key],before[key]);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,3);
  const reads=(await f.db.query('SELECT "userId","messageId" FROM "AttentionReadState" ORDER BY "messageId"')).rows;assert.deepEqual(reads.map(r=>r.messageId),[first,second].sort());assert.ok(reads.every(r=>r.userId===1));assert.ok(!reads.some(r=>r.messageId===outbound));
  const completed=(await f.db.query(`SELECT metadata FROM "AttentionAudit" WHERE action='BULK_CLOSE_COMPLETED'`)).rows[0].metadata;assert.equal(completed.actorName,"Administrador nominal real");
});
test("corte excluye actividad y chats posteriores; marca sólo mensajes anteriores observados",async t=>{
  const f=await fixture(t),active=await f.chat({activity:later}),newChat=await f.chat({createdAt:later}),safe=await f.chat();
  const old=await f.message(active),fresh=await f.message(active,later),newId=await f.message(newChat,older);await f.message(safe);
  const review=await f.store.preview(admin,cutoff);assert.deepEqual([review.totalCount,review.closeCount,review.unreadCount,review.skippedCount],[2,1,2,1]);
  const result=await f.store.close(admin,f.input(review));assert.deepEqual([result.closedCount,result.readCount,result.skippedCount],[1,2,1]);
  assert.equal((await f.db.query('SELECT status FROM "AttentionConversation" WHERE id=$1',[active])).rows[0].status,"open");
  assert.equal((await f.db.query('SELECT status FROM "AttentionConversation" WHERE id=$1',[newChat])).rows[0].status,"open");
  const reads=(await f.db.query('SELECT "messageId" FROM "AttentionReadState"')).rows.map(row=>row.messageId);assert.ok(reads.includes(old));assert.ok(!reads.includes(fresh));assert.ok(!reads.includes(newId));
});
test("entrante posterior a revisión, incluso atrasado de fecha, impide cierre y queda sin leer",async t=>{
  const f=await fixture(t),id=await f.chat(),observed=await f.message(id),review=await f.store.preview(admin,cutoff);
  const delayed=await f.message(id,older);const result=await f.store.close(admin,f.input(review));assert.deepEqual([result.closedCount,result.readCount,result.skippedCount],[0,1,1]);
  assert.equal((await f.db.query('SELECT status FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].status,"open");
  assert.deepEqual((await f.db.query('SELECT "messageId" FROM "AttentionReadState"')).rows,[{messageId:observed}]);assert.notEqual(observed,delayed);
});
test("ingest nativo posterior al corte reabre como pendiente y conserva mensaje nuevo sin leer",async t=>{
  const f=await fixture(t),id=await f.chat();await f.message(id);await f.db.query('UPDATE "AttentionConversation" SET phone=$2 WHERE id=$1',[id,"+573001234567"]);
  const review=await f.store.preview(admin,cutoff);await f.store.close(admin,f.input(review));
  const {createAttentionMetaStore}=await jiti.import("../lib/atencion-meta-storage.ts"),{META_ATTENTION_LINE}=await jiti.import("../lib/atencion-meta.ts");
  const scope={phoneNumberId:META_ATTENTION_LINE.phoneNumberId,wabaId:META_ATTENTION_LINE.wabaId},meta=createAttentionMetaStore(database(f.db),{scope,now:()=>new Date(clock)});
  await meta.ingest({scope,messages:[{id:"wamid.after-bulk-cutoff",from:"573001234567",phone:"+573001234567",name:null,timestamp:later,type:"text",text:"Mensaje posterior al corte"}],statuses:[],ignored:0});
  const row=(await f.db.query('SELECT status,"closedAt","assigneeUserId","sectionId","boardVersion" FROM "AttentionConversation" WHERE id=$1',[id])).rows[0];
  assert.equal(row.status,"pending");assert.equal(row.closedAt,null);assert.equal(row.assigneeUserId,5);assert.equal(row.boardVersion,7);assert.equal(row.sectionId,"f15e0001-0c30-5000-8000-000000000001");
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionMessage" m WHERE m."conversationId"=$1 AND m.direction='inbound'
    AND NOT EXISTS(SELECT 1 FROM "AttentionReadState" r WHERE r."userId"=1 AND r."messageId"=m.id)`,[id])).rows[0].n,1);
});
test("volumen de 1.298 chats se confirma atómicamente con consultas agrupadas",async t=>{
  const f=await fixture(t),rows=Array.from({length:1298},()=>({id:randomUUID(),messageId:randomUUID()})),body=JSON.stringify(rows);
  await f.db.query(`INSERT INTO "AttentionConversation"(id,channel,name,"createdAt","lastContactAt")
    SELECT id,'whatsapp','Volumen QA',$2::timestamptz,$2::timestamptz FROM jsonb_to_recordset($1::jsonb) AS data(id uuid,"messageId" uuid)`,[body,older]);
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt")
    SELECT "messageId",id,"messageId"::text,'inbound','QA',$2::timestamptz FROM jsonb_to_recordset($1::jsonb) AS data(id uuid,"messageId" uuid)`,[body,older]);
  const review=await f.store.preview(admin,cutoff);assert.equal(review.totalCount,1298);assert.equal(review.closeCount,1298);assert.equal(review.unreadCount,1298);
  assert.deepEqual(await f.store.close(admin,f.input(review)),{cutoff,closedCount:1298,readCount:1298,skippedCount:0});
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionConversation" WHERE status='closed' AND "closedAt"=$1`,[cutoff])).rows[0].n,1298);
});
test("versión cambiada y outbox activo se omiten; movimiento de tablero independiente no impide cierre",async t=>{
  const f=await fixture(t),changed=await f.chat(),board=await f.chat(),queued=await f.chat(),sending=await f.chat(),uncertain=await f.chat();
  for(const id of [changed,board,queued,sending,uncertain])await f.message(id);
  await f.outbox(queued);const review=await f.store.preview(admin,cutoff);assert.equal(review.skippedCount,1);
  await f.db.query('UPDATE "AttentionConversation" SET version=version+1 WHERE id=$1',[changed]);
  await f.db.query('UPDATE "AttentionConversation" SET "sectionId"=NULL,"boardVersion"="boardVersion"+1 WHERE id=$1',[board]);
  await f.outbox(sending,"sending");await f.outbox(uncertain,"uncertain");
  const result=await f.store.close(admin,f.input(review));assert.deepEqual([result.closedCount,result.readCount,result.skippedCount],[1,5,4]);
  assert.deepEqual((await f.db.query('SELECT status,"boardVersion","sectionId" FROM "AttentionConversation" WHERE id=$1',[board])).rows[0],{status:"closed",boardVersion:8,sectionId:null});
  assert.deepEqual((await f.db.query('SELECT status FROM "AttentionMetaOutbox" ORDER BY status')).rows.map(row=>row.status),["queued","sending","uncertain"]);
});
test("replay concurrente y vencido devuelve resultado único sin releer mensajes nuevos",async t=>{
  const f=await fixture(t),id=await f.chat();await f.message(id);const review=await f.store.preview(admin,cutoff),input=f.input(review);
  const results=await Promise.all([f.store.close(admin,input),f.store.close(admin,input)]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].closedCount,1);
  const late=await f.message(id,later);await f.db.query(`UPDATE "AttentionConversation" SET status='open',"closedAt"=NULL,version=version+1,"lastContactAt"=$2 WHERE id=$1`,[id,later]);
  f.setNow("2030-10-30T23:00:00.000Z");assert.deepEqual(await f.store.close(admin,input),results[0]);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='BULK_CLOSE_COMPLETED'`)).rows[0].n,1);
  assert.equal((await f.db.query('SELECT status FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].status,"open");assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionReadState" WHERE "messageId"=$1',[late])).rows[0].n,0);
});
test("error final revierte cierres, lecturas, ledger y notificaciones en la misma transacción",async t=>{
  const f=await fixture(t),id=await f.chat();await f.message(id);const review=await f.store.preview(admin,cutoff),input=f.input(review),events=[];
  await f.db.listen("finserpay_attention_changes",payload=>events.push(payload));
  await f.db.exec(`CREATE FUNCTION reject_bulk_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='BULK_CLOSE_COMPLETED' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_bulk_audit BEFORE INSERT ON "AttentionAudit" FOR EACH ROW EXECUTE FUNCTION reject_bulk_audit();`);
  await assert.rejects(f.store.close(admin,input));assert.equal((await f.db.query('SELECT status FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].status,"open");
  for(const table of ["AttentionReadState","AttentionRequest"])assert.equal((await f.db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n,0);assert.deepEqual(events,[]);
  await f.db.exec('DROP TRIGGER reject_bulk_audit ON "AttentionAudit"');assert.equal((await f.store.close(admin,input)).closedCount,1);
});
test("sólo cuenta central vigente puede revisar o confirmar su propio snapshot; TTL y esquema fallan cerrados",async t=>{
  const f=await fixture(t),id=await f.chat();await f.message(id);
  await assert.rejects(f.store.preview(analyst,cutoff),{status:403});const review=await f.store.preview(admin,cutoff);
  await assert.rejects(f.store.close(other,f.input(review)),{status:404});
  await f.db.query('UPDATE "Usuario" SET activo=false WHERE id=1');await assert.rejects(f.store.close(admin,f.input(review)),{status:403});await f.db.query('UPDATE "Usuario" SET activo=true WHERE id=1');
  f.setNow("2030-10-30T21:31:00.000Z");await assert.rejects(f.store.close(admin,f.input(review)),{status:409});f.setNow(clock);
  const messageRequest=await f.outbox(id);await assert.rejects(f.store.close(admin,{...f.input(review),requestId:messageRequest}),{status:409});
  await f.db.exec('DROP TABLE "AttentionReadState"');await assert.rejects(f.store.preview(admin,cutoff),{status:503});
  assert.equal((await f.db.query(`SELECT to_regclass('public."AttentionReadState"') AS name`)).rows[0].name,null);
});
test("validación explícita no acepta futuro, corte de más de 24 horas ni parámetros repetidos",()=>{
  assert.equal(bulk.parseAttentionBulkCloseCutoff(new URLSearchParams({cutoff}),new Date(clock)),cutoff);
  for(const text of ["cutoff=invalid",`cutoff=${cutoff}&cutoff=${cutoff}`,"cutoff=2030-10-30T23:00:00Z","cutoff=2030-10-29T20:00:00Z","other=value"])
    assert.throws(()=>bulk.parseAttentionBulkCloseCutoff(new URLSearchParams(text),new Date(clock)),{status:400});
  const valid={reviewToken:randomUUID(),requestId:randomUUID(),confirmed:true};
  for(const patch of [{confirmed:false},{confirmed:undefined},{cutoff},{messageIds:[]},{reviewToken:"bad"}])assert.throws(()=>bulk.parseAttentionBulkCloseInput({...valid,...patch}),{status:400});
});
function endpoint(deps,who=admin){
  const file=path.join(root,"app/api/atencion/close-all/route.ts"),source=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const output={exports:{}};const requires={"@/lib/atencion-core":{getAttentionAccess:async()=>{if(who instanceof Error)throw who;return who;}},"@/lib/atencion-http":http,"@/lib/atencion-bulk-close":{...bulk,...deps}};
  new Function("require","module","exports",source)(id=>{assert.ok(requires[id],id);return requires[id];},output,output.exports);return output.exports;
}
test("ruta requiere sesión, origen propio, JSON y confirmación; respuestas privadas sin snapshot interno",async()=>{
  let writes=0;const origin="https://finser.example",route=endpoint({previewAttentionBulkClose:async()=>({totalCount:3}),closeAttentionConversations:async()=>{writes++;return {closedCount:3};}});
  const input={reviewToken:randomUUID(),requestId:randomUUID(),confirmed:true},request=(body=input,host=origin)=>new Request(`${origin}/api/atencion/close-all`,{method:"POST",headers:{origin:host,"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await route.POST(request(input,"https://evil.example"))).status,403);assert.equal((await route.POST(request({...input,confirmed:false}))).status,400);assert.equal(writes,0);
  const result=await route.POST(request());assert.equal(result.status,200);assert.match(result.headers.get("cache-control"),/private, no-store/);assert.equal(writes,1);
  assert.equal((await endpoint({},new core.AttentionError("Sin sesión",401)).GET(new Request(`${origin}/api/atencion/close-all`))).status,401);
});
