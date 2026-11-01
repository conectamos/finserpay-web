import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const { createAttentionWorkStore,parseWorkSummaryQuery }=await jiti.import("../lib/atencion-work-storage.ts");
const { AttentionError,attentionUuid }=await jiti.import("../lib/atencion-core.ts");
const { attentionJson,attentionHttpError }=await jiti.import("../lib/atencion-http.ts");
const admin={type:"attention",actor:{userId:1,sellerId:null,key:"admin:1",name:"Central",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10}};
const analyst={type:"attention",actor:{...admin.actor,userId:5,key:"analyst:5",name:"Analista",central:false,admin:false,analyst:true}};
const other={type:"attention",actor:{...analyst.actor,userId:6,key:"analyst:6"}};
const seller={type:"seller",userId:2,userSedeId:20,sellerId:11,sedeId:20,accessSedeId:20,aliadoId:2,supervisor:false,name:"Asesor",key:"seller:2:11"};
const ids=Array.from({length:7},(_,i)=>`00000000-0000-4000-8000-${String(101+i).padStart(12,"0")}`);
async function fixture(t){
  const db=new PGlite(),queries=[];t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,nombre text,activo bool);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa bool);CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,"sedeId" int,"rolId" int,activo bool);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY,nombre text,activo bool,"debeCambiarPin" bool,"tipoPerfil" text);CREATE TABLE "SedeVendedor"("sedeId" int,"vendedorId" int,activo bool);
    CREATE TABLE "Credito"(id int PRIMARY KEY,"clienteNombre" text,"clienteDocumento" text,imei text,plataforma text,estado text,"vendedorId" int,"sedeId" int);CREATE TABLE "CreditoBorrador"(LIKE "Credito" INCLUDING ALL);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY','Central',true),(2,'TIENDA','Aliado',true);
    INSERT INTO "Sede" VALUES(10,'Central',1,true),(20,'Sede',2,true);INSERT INTO "Usuario" VALUES(1,'Central',10,1,true),(2,'Sede',20,2,true),(5,'Analista',10,3,true),(6,'Otro',10,3,true);
    INSERT INTO "Vendedor" VALUES(11,'Asesor',true,false,'VENDEDOR'),(12,'Otro',true,false,'VENDEDOR');INSERT INTO "SedeVendedor" VALUES(20,11,true);
    INSERT INTO "Credito" VALUES(200,'Cliente sensible','DOCUMENTO-PRIVADO','IMEI-PRIVADO','IPHONE','ACTIVO',11,20);`);
  await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  await db.query(`INSERT INTO "AttentionConversation"(id,channel,name,"sedeId",mode,"assigneeKey","assigneeUserId","assigneeName") VALUES($1,'internal','Nombre privado',20,'human','analyst:5',5,'Analista')`,[ids[0]]);
  await db.query(`INSERT INTO "AttentionWorkRequest"(id,"conversationId",kind,"targetSource","targetId","sellerId","userId","sedeId","aliadoId") VALUES($1,$2,'welcome','C',200,11,2,20,2)`,[ids[1],ids[0]]);
  for(let i=0;i<5;i++)await db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1,$2,$3,$4,'CUERPO-PRIVADO',$5,'AUTOR-PRIVADO')`,[ids[i+2],ids[0],`test:${i}`,i===3?"outbound":"inbound",`2026-10-31T15:0${i}:00.000Z`]);
  const adapter=client=>({$queryRawUnsafe:async(sql,...values)=>{queries.push(sql);return(await client.query(sql,values)).rows;},$transaction:fn=>client.transaction(tx=>fn(adapter(tx)))});
  return {db,queries,store:createAttentionWorkStore(adapter(db)),read:actor=>createAttentionWorkStore(adapter(db)).summary(actor,ids[1],"C-200")};
}

test("resumen cuenta inbounds reales por usuario, no marca leídos ni consulta cuerpos o documentos",async t=>{
  const f=await fixture(t),before=(await f.db.query(`SELECT (SELECT count(*) FROM "AttentionReadState") reads,(SELECT count(*) FROM "AttentionAudit") audits,(SELECT version FROM "AttentionWorkRequest" LIMIT 1) version`)).rows;
  const result=await f.read(analyst);
  assert.deepEqual(result,{workId:ids[1],kind:"welcome",target:"C-200",unreadCount:4,lastInbound:{id:ids[6],sentAt:"2026-10-31T15:04:00.000000Z"},lastUnreadInbound:{id:ids[6],sentAt:"2026-10-31T15:04:00.000000Z"}});
  assert.deepEqual((await f.db.query(`SELECT (SELECT count(*) FROM "AttentionReadState") reads,(SELECT count(*) FROM "AttentionAudit") audits,(SELECT version FROM "AttentionWorkRequest" LIMIT 1) version`)).rows,before);
  assert.ok(f.queries.every(sql=>!/^\s*(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql)));
  assert.ok(f.queries.every(sql=>!sql.includes('m.text')&&!sql.includes('clienteDocumento')&&!sql.includes('attachment')&&!sql.includes('AttentionNote')));
  assert.ok(!JSON.stringify(result).includes("PRIVADO"));
  await f.db.query(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId") VALUES(5,$1,$2)`,[ids[6],ids[0]]);
  const mine=await f.read(analyst),central=await f.read(admin);assert.equal(mine.unreadCount,3);assert.equal(mine.lastUnreadInbound.id,ids[4]);assert.equal(mine.lastInbound.id,ids[6]);assert.equal(central.unreadCount,4);
  await f.db.query(`INSERT INTO "AttentionTeamReadState"("messageId","conversationId",source,"actorUserId") VALUES($1,$2,'manual',1)`,[ids[4],ids[0]]);
  assert.equal((await f.read(analyst)).unreadCount,2);assert.equal((await f.read(admin)).unreadCount,3);
  const newInbound="00000000-0000-4000-8000-000000000108";
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES($1,$2,'new-inbound','inbound','NO EXPONER','2026-10-31T15:05:00Z')`,[newInbound,ids[0]]);
  await f.db.query(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId") VALUES(5,$1,$2)`,[ids[2],ids[0]]);
  const sameCount=await f.read(analyst);assert.equal(sameCount.unreadCount,2);assert.equal(sameCount.lastUnreadInbound.id,newInbound,"un mensaje nuevo cambia el marcador aunque otro haya sido leído");
  await f.db.query(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId") SELECT 5,id,"conversationId" FROM "AttentionMessage" WHERE direction='inbound' ON CONFLICT DO NOTHING`);
  const zero=await f.read(analyst);assert.equal(zero.unreadCount,0);assert.equal(zero.lastUnreadInbound,null);assert.equal(zero.lastInbound.id,newInbound);
});

test("marcadores conservan orden de microsegundos UTC y usan UUID únicamente en empates exactos",async t=>{
  const f=await fixture(t),older="00000000-0000-4000-8000-000000000119",newer="00000000-0000-4000-8000-000000000110",tied="00000000-0000-4000-8000-000000000120";
  await f.db.exec(`SET TIME ZONE 'America/Bogota'`);
  for(const [id,at] of [[older,"2026-10-31T10:05:00.123001-05:00"],[newer,"2026-10-31T15:05:00.123999Z"]])
    await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES($1::uuid,$2::uuid,$1::uuid::text,'inbound','PRIVADO',$3)`,[id,ids[0],at]);
  const initial=await f.read(analyst);assert.equal(initial.lastInbound.id,newer);assert.equal(initial.lastUnreadInbound.sentAt,"2026-10-31T15:05:00.123999Z");
  await f.db.query(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId") VALUES(5,$1,$2)`,[newer,ids[0]]);
  const afterRead=await f.read(analyst);assert.equal(afterRead.lastInbound.sentAt,"2026-10-31T15:05:00.123999Z");
  assert.equal(afterRead.lastUnreadInbound.id,older);assert.equal(afterRead.lastUnreadInbound.sentAt,"2026-10-31T15:05:00.123001Z");
  assert.equal(Date.parse(afterRead.lastUnreadInbound.sentAt),Date.parse(initial.lastUnreadInbound.sentAt),"Date por sí solo pierde la precisión que distingue estos mensajes");
  assert.ok(afterRead.lastUnreadInbound.sentAt<initial.lastUnreadInbound.sentAt,"el marcador que retrocede no debe parecer un mensaje nuevo por tener un UUID mayor");
  await f.db.query(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt") VALUES($1::uuid,$2::uuid,$1::uuid::text,'inbound','PRIVADO','2026-10-31T15:05:00.123001Z')`,[tied,ids[0]]);
  const exactTie=await f.read(analyst);assert.equal(exactTie.lastUnreadInbound.id,tied);assert.equal(exactTie.lastUnreadInbound.sentAt,afterRead.lastUnreadInbound.sentAt);
});

test("resumen rechaza otro analista, actor revocado, perfil comercial y vínculo alterado",async t=>{
  const f=await fixture(t);
  await assert.rejects(f.read(other),{status:404});await assert.rejects(f.read(seller),{status:403});
  await assert.rejects(f.store.summary(analyst,ids[1],"C-201"),{status:404});await assert.rejects(f.store.summary(analyst,ids[1],"D-200"),{status:400});
  await f.db.exec(`UPDATE "Usuario" SET activo=false WHERE id=5`);await assert.rejects(f.read(analyst),{status:403});
  await f.db.exec(`UPDATE "Usuario" SET activo=true WHERE id=5;UPDATE "AttentionConversation" SET "assigneeUserId"=6,"assigneeKey"='analyst:6'`);
  await assert.rejects(f.read(analyst),{status:404});assert.equal((await f.read(other)).unreadCount,4);
  await f.db.exec(`UPDATE "Credito" SET "vendedorId"=12 WHERE id=200`);await assert.rejects(f.read(admin),{status:404});
});

test("finalizadas y conversaciones sin mensajes conservan conteo real sin habilitar acciones",async t=>{
  const f=await fixture(t);await f.db.exec(`UPDATE "AttentionWorkRequest" SET state='completed'`);assert.equal((await f.read(analyst)).unreadCount,4);
  await f.db.exec(`DELETE FROM "AttentionMessage"`);const empty=await f.read(analyst);assert.equal(empty.unreadCount,0);assert.equal(empty.lastInbound,null);assert.equal(empty.lastUnreadInbound,null);
  await f.db.exec(`UPDATE "AttentionWorkRequest" SET kind='enrollment'`);await assert.rejects(f.read(analyst),{status:404});
});

test("query del resumen exige un único target C existente en rango y no admite parámetros extra",()=>{
  assert.equal(parseWorkSummaryQuery(new URLSearchParams("target=C-200")),"C-200");
  for(const query of ["","target=D-200","target=C-0","target=C-0200","target=C-2147483648","target=C-200&target=C-200","target=C-200&kind=welcome","target=C-200&read=true"])
    assert.throws(()=>parseWorkSummaryQuery(new URLSearchParams(query)),{status:400});
});

test("GET privado solo entrega resumen de la cuenta nominal y propaga revocación sin llamar detalle ni escritura",async()=>{
  const calls=[];let actor=analyst,failure=null;
  const dependencies={"./atencion-work-access":{getAttentionWorkAccess:async()=>{if(failure)throw failure;return actor;}},
    "./atencion-work-storage":{parseWorkSummaryQuery,attentionWorkStore:async()=>({summary:async(...args)=>{calls.push(args);return{workId:ids[1],kind:"welcome",target:"C-200",unreadCount:2,lastInbound:null,lastUnreadInbound:null};}})},
    "./atencion-core":{AttentionError,attentionUuid},"./atencion-http":{attentionJson,attentionHttpError},"./atencion-meta-http":{}};
  const loaded={exports:{}};runInNewContext(ts.transpileModule(readFileSync(path.join(root,"lib/atencion-work-http.ts"),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:loaded,exports:loaded.exports,URL,Response,require:name=>{assert.ok(name in dependencies,name);return dependencies[name];}});
  const get=loaded.exports.attentionWorkHandlers("attention").summary,context={params:Promise.resolve({id:ids[1]})};
  const response=await get(new Request(`https://finserpay.test/api/atencion/solicitudes/${ids[1]}/resumen?target=C-200`),context);
  assert.equal(response.status,200);assert.match(response.headers.get("Cache-Control"),/private, no-store/);assert.equal(response.headers.get("Vary"),"Cookie");assert.equal(calls.length,1);assert.equal(calls[0][0],analyst);assert.equal(calls[0][2],"C-200");
  actor=seller;assert.equal((await get(new Request("https://finserpay.test/resumen?target=C-200"),context)).status,403);assert.equal(calls.length,1);
  actor=analyst;assert.equal((await get(new Request("https://finserpay.test/resumen?target=C-200&read=true"),context)).status,400);assert.equal(calls.length,1);
  failure=new AttentionError("Acceso revocado",403);assert.equal((await get(new Request("https://finserpay.test/resumen?target=C-200"),context)).status,403);assert.equal(calls.length,1);
  assert.ok(!readFileSync(path.join(root,"app/api/atencion/solicitudes/[id]/resumen/route.ts"),"utf8").includes("POST"));
});
