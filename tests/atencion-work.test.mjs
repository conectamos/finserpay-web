import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionWorkStore}=await jiti.import("../lib/atencion-work-storage.ts");
const {createAttentionWorkNotificationStore,attentionWorkNotificationEligibleSql}=await jiti.import("../lib/atencion-work-notifications.ts");
const {createAttentionStickerLibrary,readStickerUpload}=await jiti.import("../lib/atencion-sticker-library.ts");
const sharp=(await import("sharp")).default;
const migration=readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8");
const admin={type:"attention",actor:{userId:1,sellerId:null,key:"admin:1",name:"Central",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10}};
const analyst={type:"attention",actor:{...admin.actor,userId:5,key:"analyst:5",name:"Analista",central:false,admin:false,analyst:true}};
const seller={type:"seller",userId:2,userSedeId:20,sellerId:11,sedeId:20,accessSedeId:20,aliadoId:2,supervisor:false,name:"Asesor",key:"seller:2:11"};
function adapter(db){return {$queryRawUnsafe:async(sql,...values)=>{const r=await db.query(sql,values);assert.ok(!r.fields?.some(f=>f.dataTypeID===2278),"No Prisma void result");return r.rows;},$transaction:fn=>db.transaction(tx=>fn(adapter(tx)))};}
async function fixture(t){const db=new PGlite();t.after(()=>db.close());await db.exec(`
  CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text); CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,nombre text,activo bool);
  CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa bool);
  CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,"sedeId" int,"rolId" int,activo bool);
  CREATE TABLE "Vendedor"(id int PRIMARY KEY,nombre text,activo bool,"debeCambiarPin" bool,"tipoPerfil" text);
  CREATE TABLE "SedeVendedor"("sedeId" int,"vendedorId" int,activo bool);
  CREATE TABLE "Credito"(id int PRIMARY KEY,"clienteNombre" text,"clienteDocumento" text,imei text,plataforma text,estado text,"vendedorId" int,"sedeId" int);
  CREATE TABLE "CreditoBorrador"(LIKE "Credito" INCLUDING ALL);
  INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');
  INSERT INTO "Aliado" VALUES(1,'FINSERPAY','FINSER',true),(2,'TIENDA','Tienda',true),(3,'OTRA','Otra',true);
  INSERT INTO "Sede" VALUES(10,'Central',1,true),(20,'Sede tienda',2,true),(30,'Otra sede',3,true);
  INSERT INTO "Usuario" VALUES(1,'Central',10,1,true),(2,'Sede',20,2,true),(5,'Analista',10,3,true),(6,'Otro analista',10,3,true);
  INSERT INTO "Vendedor" VALUES(11,'Asesor',true,false,'VENDEDOR'),(12,'Otro asesor',true,false,'VENDEDOR'),(13,'Supervisor',true,false,'SUPERVISOR');
  INSERT INTO "SedeVendedor" VALUES(20,11,true),(20,12,true),(20,13,true);
  INSERT INTO "CreditoBorrador" VALUES(100,'Cliente real','12345','123456789012345','IPHONE','PROCESO',11,20),(101,'Otro cliente','67890','123456789012346','ANDROID','PROCESO',11,20),(102,'No autorizado','98765','123456789012347','IPHONE','PROCESO',12,20);
  INSERT INTO "Credito" VALUES(200,'Cliente bienvenida','12345','123456789012345','IPHONE','ACTIVO',11,20);
`);await db.exec(migration);const store=createAttentionWorkStore(adapter(db));const create=(extra={})=>store.create(seller,{requestId:randomUUID(),kind:"enrollment",target:"D-100",text:"Revisar pruebas",...extra});return {db,store,create};}
test("asesor crea chat interno con datos reales y reintentos no duplican solicitud ni mensaje",async t=>{const {store,db,create}=await fixture(t);const id=randomUUID(),a=await create({requestId:id}),b=await create({requestId:id}),c=await create();assert.equal(a.item.id,b.item.id);assert.equal(a.item.id,c.item.id);assert.equal(a.item.name,"Cliente real");assert.equal(a.messages.length,1);assert.equal((await db.query('SELECT channel,phone FROM "AttentionConversation"')).rows[0].channel,"internal");assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);assert.equal((await db.query('SELECT estado FROM "CreditoBorrador" WHERE id=100')).rows[0].estado,"PROCESO");});
test("creación rechaza ventas ajenas, Android, bienvenida de borrador y roles de analista",async t=>{const {create,store}=await fixture(t);await assert.rejects(create({target:"D-102"}),{status:403});await assert.rejects(create({target:"D-101"}),/iPhone/);await assert.rejects(create({kind:"welcome"}),/crédito/);await assert.rejects(store.create(admin,{requestId:randomUUID(),kind:"enrollment",target:"D-100"}),{status:403});});
test("asignación mantiene alcance nominal y auditoría; vendedor no puede asignar ni ver notas",async t=>{const {create,store}=await fixture(t);let d=await create();await assert.rejects(store.detail(analyst,d.item.id),{status:404});await assert.rejects(store.mutate(seller,d.item.id,{requestId:randomUUID(),version:1,action:"assign",assigneeKey:"analyst:5"}),{status:403});d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:1,action:"assign",assigneeKey:"analyst:5"});assert.equal((await store.list(analyst,"enrollment")).total,1);d=await store.mutate(analyst,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"note",text:"Nota reservada"});assert.equal(d.notes[0].text,"Nota reservada");assert.equal((await store.detail(seller,d.item.id)).notes.length,0);assert.ok(d.events.some(e=>e.action==="WORK_ASSIGNED"));});
test("mensaje repetido es idempotente; conflicto de versión no pierde mensajes y cierre genérico no omite gestión",async t=>{const {create,store,db}=await fixture(t);let d=await create();const input={requestId:randomUUID(),version:1,action:"message",text:"Aquí está el contexto"};d=await store.mutate(seller,d.item.id,input);await store.mutate(seller,d.item.id,input);assert.equal(d.messages.length,2);await assert.rejects(store.mutate(seller,d.item.id,{...input,requestId:randomUUID()}),{status:409});await assert.rejects(store.mutate(admin,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"state",state:"completed",text:"Intento de omitir checklist"}),{status:409});assert.equal((await store.detail(admin,d.item.id)).item.state,"pending");assert.equal((await db.query('SELECT estado FROM "CreditoBorrador" WHERE id=100')).rows[0].estado,"PROCESO");});
test("una reasignación de venta retira inmediatamente lista, detalle y archivos al asesor anterior",async t=>{const {create,store,db}=await fixture(t);const d=await create();await db.query('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');assert.equal((await store.list(seller,"enrollment")).items.length,0);await assert.rejects(store.detail(seller,d.item.id),{status:404});});
test("supervisor ve la sede pero no envía en nombre del titular ni crea solicitudes ajenas",async t=>{const {create,store}=await fixture(t);const d=await create(),supervisor={...seller,sellerId:13,key:"seller:2:13",supervisor:true};assert.equal((await store.list(supervisor,"enrollment")).total,1);assert.equal((await store.detail(supervisor,d.item.id)).canWrite,false);await assert.rejects(store.mutate(supervisor,d.item.id,{requestId:randomUUID(),version:1,action:"message",text:"no"}),{status:403});await assert.rejects(store.create(supervisor,{requestId:randomUUID(),kind:"enrollment",target:"D-100"}),{status:403});});
test("bienvenida humana o Dapta solo registra modalidad sin iniciar llamadas",async t=>{const {create,store,db}=await fixture(t);let d=await create({kind:"welcome",target:"C-200"});d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:1,action:"call_mode",callMode:"dapta"});assert.equal(d.item.callMode,"dapta");assert.equal(d.operationHref,"/dashboard/aprobaciones?credito=200");assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);});
test("revocación de perfil comercial o analista se revalida en cada acceso",async t=>{const {create,store,db}=await fixture(t);const d=await create();await db.query('UPDATE "Vendedor" SET activo=false WHERE id=11');await assert.rejects(store.detail(seller,d.item.id),{status:403});await db.query('UPDATE "Usuario" SET activo=false WHERE id=1');await assert.rejects(store.list(admin,"enrollment"),{status:403});});
test("soportes privados conservan archivo y autor, deduplican reintentos y excluyen usuarios ajenos",async t=>{const {create,store}=await fixture(t);let d=await create();const content=await sharp({create:{width:40,height:40,channels:3,background:"white"}}).png().toBuffer();const input={requestId:randomUUID(),version:1,fileName:"equipo.png",mimeType:"image/png",content};d=await store.attach(seller,d.item.id,input);await store.attach(seller,d.item.id,input);assert.equal(d.messages.length,2);const fileId=d.messages[1].attachment.id;assert.deepEqual(Buffer.from((await store.media(seller,d.item.id,fileId)).content),content);const staff=await store.detail(admin,d.item.id);assert.match(staff.messages[1].attachment.url,/^\/api\/atencion\/solicitudes\//);await assert.rejects(store.media(analyst,d.item.id,fileId),{status:404});await assert.rejects(store.attach(seller,d.item.id,{...input,requestId:randomUUID(),version:2,content:Buffer.from("not png")}),/archivo|contenido|formato/i);});
test("biblioteca personal valida WebP, propiedad, favoritos, archivo y reintentos sin enviar a Meta",async t=>{const {db}=await fixture(t),library=createAttentionStickerLibrary(adapter(db));const content=await sharp({create:{width:512,height:512,channels:4,background:{r:50,g:100,b:0,alpha:1}}}).webp().toBuffer();const input={requestId:randomUUID(),name:"Gracias",content};let sticker=await library.save(admin.actor,input);assert.equal((await library.save(admin.actor,input)).id,sticker.id);assert.equal((await library.save(admin.actor,{...input,requestId:randomUUID()})).id,sticker.id);assert.equal((await library.list(admin.actor)).items.length,1);await assert.rejects(library.media(analyst.actor,sticker.id),{status:404});sticker=await library.update(admin.actor,sticker.id,{requestId:randomUUID(),version:1,action:"favorite",favorite:true});assert.equal(sticker.favorite,true);await assert.rejects(library.update(admin.actor,sticker.id,{requestId:randomUUID(),version:1,action:"archive"}),{status:409});sticker=await library.update(admin.actor,sticker.id,{requestId:randomUUID(),version:2,action:"archive"});assert.equal(sticker.archived,true);sticker=await library.update(admin.actor,sticker.id,{requestId:randomUUID(),version:3,action:"restore"});assert.equal(sticker.archived,false);assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);});
test("imagen subida se convierte a sticker; formato falso y campos repetidos se rechazan",async()=>{const png=await sharp({create:{width:100,height:60,channels:3,background:"white"}}).png().toBuffer();const form=()=>{const f=new FormData();f.set("requestId",randomUUID());f.set("name","Prueba");f.set("file",new Blob([png],{type:"image/png"}),"foto.png");return f;};const input=await readStickerUpload(new Request("https://example.invalid",{method:"POST",body:form()}));const meta=await sharp(input.content).metadata();assert.equal(meta.format,"webp");assert.equal(meta.width,512);assert.equal(meta.height,512);const bad=form();bad.set("file",new Blob(["not image"],{type:"image/png"}),"foto.png");await assert.rejects(readStickerUpload(new Request("https://example.invalid",{method:"POST",body:bad})),{status:415});const repeated=form();repeated.append("name","Otro");await assert.rejects(readStickerUpload(new Request("https://example.invalid",{method:"POST",body:repeated})),/campos/);});

test("nueva solicitud notifica al equipo activo sin datos privados; reintentos y reutilización no duplican",async t=>{
  const {db,store,create}=await fixture(t),notifications=createAttentionWorkNotificationStore(adapter(db));
  await db.exec(`INSERT INTO "Usuario" VALUES(7,'Inactivo',10,3,false),(8,'Externo',20,3,true),(9,'Cajero',10,2,true)`);
  const requestId=randomUUID(),d=await create({requestId});await create({requestId});await create();
  const rows=(await db.query('SELECT "recipientKey",kind FROM "AttentionWorkNotification" ORDER BY "recipientKey"')).rows;
  assert.deepEqual(rows,[{recipientKey:"user:1",kind:"created"},{recipientKey:"user:5",kind:"created"},{recipientKey:"user:6",kind:"created"}]);
  const team=await notifications.list(analyst),central=await notifications.list(admin);
  assert.equal(team.unreadCount,1);assert.equal(team.items[0].href,"/dashboard/atencion?tipo=enrollment");
  assert.match(central.items[0].href,new RegExp(`solicitud=${d.item.id}$`));
  assert.doesNotMatch(JSON.stringify(team),/Cliente real|12345|Revisar pruebas/);
  await assert.rejects(store.detail(analyst,d.item.id),{status:404});
  await notifications.acknowledge(analyst,{ids:[central.items[0].id]});
  assert.equal((await notifications.list(admin)).unreadCount,1,"cannot acknowledge somebody else's alert");
  await notifications.acknowledge(analyst,{ids:[team.items[0].id]});
  assert.equal((await notifications.list(analyst)).unreadCount,0);
  assert.equal((await notifications.list(admin)).unreadCount,1);
  await store.create({...seller,sellerId:12,key:"seller:2:12"},{requestId,kind:"enrollment",target:"D-102",text:"Otra solicitud"});
  assert.equal((await notifications.list(admin)).unreadCount,2,"a different advisor may use the same client request UUID without suppressing this new case");
});

test("solo respuestas y archivos del analista notifican al titular; las notas y cambios internos no",async t=>{
  const {db,store,create}=await fixture(t),notifications=createAttentionWorkNotificationStore(adapter(db));let d=await create();
  d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"note",text:"Información privada"});
  d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"state",state:"review",text:"Control interno"});
  assert.equal((await notifications.list(seller)).unreadCount,0);
  const reply={requestId:randomUUID(),version:d.item.version,action:"message",text:"Respuesta privada"};
  d=await store.mutate(admin,d.item.id,reply);await store.mutate(admin,d.item.id,reply);
  const content=await sharp({create:{width:20,height:20,channels:3,background:"white"}}).png().toBuffer();
  const file={requestId:randomUUID(),version:d.item.version,fileName:"prueba.png",mimeType:"image/png",content};
  d=await store.attach(admin,d.item.id,file);await store.attach(admin,d.item.id,file);
  const result=await notifications.list(seller);assert.equal(result.unreadCount,2);assert.equal(result.actorKey,"seller:11");
  assert.ok(result.items.every(n=>n.kind==="reply" && n.href===`/dashboard/gestion-comercial?tipo=enrollment&solicitud=${d.item.id}`));
  assert.doesNotMatch(JSON.stringify(result),/Respuesta privada|Información privada|Cliente real|12345|prueba.png/);
  const other={...seller,sellerId:12,key:"seller:2:12"};assert.equal((await notifications.list(other)).items.length,0);
  await notifications.acknowledge(other,{ids:result.items.map(n=>n.id)});assert.equal((await notifications.list(seller)).unreadCount,2);
  await db.query('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');
  assert.equal((await notifications.list(seller)).unreadCount,0);
  assert.equal((await db.query(`SELECT count(*)::int n FROM "AttentionWorkNotification" n WHERE n.kind='reply' AND ${attentionWorkNotificationEligibleSql()}`)).rows[0].n,0,"push also loses eligibility after ownership transfer");
});

test("asignación y seguimiento notifican solo al responsable actual y revocan entrega al transferir",async t=>{
  const {db,store,create}=await fixture(t),notifications=createAttentionWorkNotificationStore(adapter(db));let d=await create({kind:"welcome",target:"C-200"});
  const assigned={requestId:randomUUID(),version:1,action:"assign",assigneeKey:"analyst:5"};
  d=await store.mutate(admin,d.item.id,assigned);await store.mutate(admin,d.item.id,assigned);
  const followup={requestId:randomUUID(),version:d.item.version,action:"message",text:"Necesito la llamada"};
  d=await store.mutate(seller,d.item.id,followup);await store.mutate(seller,d.item.id,followup);
  let result=await notifications.list(analyst);assert.equal(result.unreadCount,3);
  assert.deepEqual(result.items.map(n=>n.kind).sort(),["assigned","created","followup"]);
  assert.ok(result.items.every(n=>n.href.endsWith(`solicitud=${d.item.id}`)));
  d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"assign",assigneeKey:"analyst:6"});
  result=await notifications.list(analyst);assert.deepEqual(result.items.map(n=>n.kind),["created"]);
  assert.equal(result.items[0].href,"/dashboard/atencion?tipo=welcome");
  assert.equal((await db.query(`SELECT count(*)::int n FROM "AttentionWorkNotification" n WHERE n."recipientKey"='user:5' AND n.kind<>'created' AND ${attentionWorkNotificationEligibleSql()}`)).rows[0].n,0);
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=5');await assert.rejects(notifications.list(analyst),{status:403});
  assert.equal((await db.query(`SELECT count(*)::int n FROM "AttentionWorkNotification" n WHERE n."recipientKey"='user:5' AND ${attentionWorkNotificationEligibleSql()}`)).rows[0].n,0);
});

test("fallo de notificaciones revierte la respuesta completa en su misma transacción",async t=>{
  const {db,store,create}=await fixture(t),d=await create();
  await db.exec(`CREATE FUNCTION reject_work_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END; $$;
    CREATE TRIGGER reject_work_notification BEFORE INSERT ON "AttentionWorkNotification" FOR EACH ROW EXECUTE FUNCTION reject_work_notification()`);
  const before=(await store.detail(admin,d.item.id)).messages.length,requestId=randomUUID();
  await assert.rejects(store.mutate(admin,d.item.id,{requestId,version:1,action:"message",text:"No debe persistir"}),/test rollback/);
  const after=await store.detail(admin,d.item.id);assert.equal(after.messages.length,before);assert.equal(after.item.version,1);
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionRequest" WHERE "requestId"=$1::uuid',[requestId])).rows[0].n,0);
});

test("gestión autorizada guarda resultado, cierre, mensaje y aviso atómicos; replay no repite dominio",async t=>{
  const {db,store,create}=await fixture(t),d=await create();let calls=0;
  const input={requestId:randomUUID(),version:1,action:"test_domain"};
  const apply=ctx=>{calls++;assert.equal(ctx.work.targetId,100);assert.equal(ctx.target.document,"12345");return Promise.resolve({result:{reviewId:"test-review"},summary:"Confirmación de prueba",complete:true});};
  const first=await store.workflowMutate(admin,d.item.id,"enrollment",input,apply);
  const replay=await store.workflowMutate(admin,d.item.id,"enrollment",input,apply);
  assert.equal(calls,1);assert.equal(first.detail.item.state,"completed");assert.equal(first.detail.messages.length,2);
  assert.equal(replay.alreadyApplied,true);assert.deepEqual(replay.result,first.result);
  assert.equal((await db.query(`SELECT count(*)::int n FROM "AttentionAudit" WHERE action='WORK_WORKFLOW'`)).rows[0].n,1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM "AttentionWorkNotification" WHERE kind='reply'`)).rows[0].n,1);
  await assert.rejects(store.mutate(seller,d.item.id,{requestId:randomUUID(),version:first.detail.item.version,action:"message",text:"nuevo"}),{status:409});
});

test("gestión bloquea roles, asignación, tipo y operación transferida sin ejecutar dominio",async t=>{
  const {db,store,create}=await fixture(t),d=await create();const input={requestId:randomUUID(),version:1};let calls=0;
  const apply=async()=>{calls++;return {result:{},summary:"No debe ocurrir",complete:true};};
  await assert.rejects(store.workflowMutate(seller,d.item.id,"enrollment",input,apply),{status:403});
  await assert.rejects(store.workflowMutate(analyst,d.item.id,"enrollment",input,apply),{status:404});
  await assert.rejects(store.workflowMutate(admin,d.item.id,"welcome",input,apply),{status:409});
  await db.query('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');
  await assert.rejects(store.workflowRead(admin,d.item.id,"enrollment",apply),{status:409});
  await assert.rejects(store.workflowMutate(admin,d.item.id,"enrollment",input,apply),{status:409});assert.equal(calls,0);
});

test("cambio de titular o identidad durante dominio revierte todo y seguimiento mantiene revisión",async t=>{
  const {db,store,create}=await fixture(t),d=await create();
  await assert.rejects(store.workflowMutate(admin,d.item.id,"enrollment",{requestId:randomUUID(),version:1},async ctx=>{
    await ctx.db.$queryRawUnsafe('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100 RETURNING id');
    return {result:{},summary:"Nunca se publica",complete:true};
  }),{status:409});
  assert.equal((await db.query('SELECT "vendedorId" FROM "CreditoBorrador" WHERE id=100')).rows[0].vendedorId,11);
  await assert.rejects(store.workflowMutate(admin,d.item.id,"enrollment",{requestId:randomUUID(),version:1},async ctx=>{
    await ctx.db.$queryRawUnsafe('UPDATE "CreditoBorrador" SET imei=\'999999999999999\' WHERE id=100 RETURNING id');
    return {result:{},summary:"Nunca se publica",complete:true};
  }),{status:409});
  assert.equal((await store.detail(admin,d.item.id)).messages.length,1);
  const followup=await store.workflowMutate(admin,d.item.id,"enrollment",{requestId:randomUUID(),version:1},async()=>({result:{reason:"test"},summary:"Seguimiento",complete:false,nextState:"review"}));
  assert.equal(followup.detail.item.state,"review");
});
