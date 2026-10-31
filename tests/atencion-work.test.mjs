import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";
const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionWorkStore,parseWorkListQuery}=await jiti.import("../lib/atencion-work-storage.ts");
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
async function centralFixture(t){const f=await fixture(t);await f.db.exec('ALTER TABLE "CreditoBorrador" ADD COLUMN "usuarioId" integer; UPDATE "CreditoBorrador" SET "usuarioId"=2;');return f;}
const centralInput=(extra={})=>({requestId:randomUUID(),kind:"enrollment",target:"D-100",text:"Solicitado por administración central",...extra});
test("asesor crea chat interno con datos reales y reintentos no duplican solicitud ni mensaje",async t=>{const {db,create}=await fixture(t);const id=randomUUID(),a=await create({requestId:id}),b=await create({requestId:id}),c=await create();assert.equal(a.item.id,b.item.id);assert.equal(a.item.id,c.item.id);assert.equal(a.item.name,"Cliente real");assert.equal(a.messages.length,1);assert.equal((await db.query('SELECT channel,phone FROM "AttentionConversation"')).rows[0].channel,"internal");assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);assert.equal((await db.query('SELECT estado FROM "CreditoBorrador" WHERE id=100')).rows[0].estado,"PROCESO");});

test("consulta de bandejas valida búsqueda, estado, filtros y parámetros repetidos",()=>{
  assert.deepEqual(parseWorkListQuery(new URLSearchParams()),{kind:"enrollment",page:1,filters:{search:"",filter:"all",state:""}});
  assert.deepEqual(parseWorkListQuery(new URLSearchParams("kind=welcome&page=2&search=  Tienda  &filter=unassigned&state=information")),
    {kind:"welcome",page:2,filters:{search:"Tienda",filter:"unassigned",state:"information"}});
  for(const query of ["kind=credit","page=1e3","page=0","page=10001","filter=mine","state=approved","kind=welcome&kind=welcome","search=a&search=b","filter=all&filter=unread","state=pending&state=review",`search=${"a".repeat(121)}`])
    assert.throws(()=>parseWorkListQuery(new URLSearchParams(query)),{status:400});
});

test("búsqueda y conteo de solicitudes abarcan toda la cola antes de paginar y usan nombres actuales",async t=>{
  const {db,store,create}=await fixture(t);await create();
  const uuid=(base,i)=>`00000000-0000-4000-8000-${String(base+i).padStart(12,"0")}`;
  for(let i=0;i<45;i++){
    await db.query('INSERT INTO "CreditoBorrador" VALUES($1,$2,$3,$4,\'IPHONE\',\'PROCESO\',11,20)',[1000+i,`Cliente actual ${i}`,String(100000+i),String(123456789010000+i)]);
    await db.query('INSERT INTO "AttentionConversation"(id,channel,name,"sedeId",mode,"lastContactAt") VALUES($1,\'internal\',$2,20,\'human\',$3)',[uuid(1000,i),`Nombre anterior ${i}`,new Date(Date.UTC(2026,9,31,12,0)-i*60000).toISOString()]);
    await db.query('INSERT INTO "AttentionWorkRequest"(id,"conversationId",kind,"targetSource","targetId","sellerId","userId","sedeId","aliadoId",state,"updatedAt") VALUES($1,$2,\'enrollment\',\'D\',$3,11,2,20,2,$4,$5)',[uuid(2000,i),uuid(1000,i),1000+i,i===44?"information":"pending",new Date(Date.UTC(2026,9,31,12,0)-i*60000).toISOString()]);
    await db.query('INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",attachment) VALUES($1,$2,\'queue-fixture\',\'inbound\',$3,$4,$5)',[uuid(3000,i),uuid(1000,i),i===44?"":`Mensaje ${i}`,new Date(Date.UTC(2026,9,31,12,0)-i*60000).toISOString(),i===44?{kind:"image",id:uuid(4000,i)}:null]);
  }
  const first=await store.list(admin,"enrollment"),second=await store.list(admin,"enrollment",2);
  assert.equal(first.total,46);assert.equal(first.items.length,40);assert.equal(second.total,46);assert.equal(second.items.length,6);
  assert.equal(first.items.some(item=>item.id===uuid(2000,44)),false);
  const filtered=await store.list(admin,"enrollment",1,{search:"Cliente actual 44",filter:"unassigned",state:"information"});
  assert.equal(filtered.total,1);assert.equal(filtered.items[0].name,"Cliente actual 44");assert.equal(filtered.items[0].preview,"Imagen");
  assert.equal(filtered.items[0].unreadCount,1);assert.equal(filtered.items[0].conversationStatus,"pending");assert.equal(filtered.items[0].lastMessageAt,"2026-10-31T11:16:00.000Z");
  assert.equal((await store.detail(admin,filtered.items[0].id)).item.lastMessageAt,filtered.items[0].lastMessageAt);
  for(const search of ["Tienda","Asesor","Sede tienda"])assert.equal((await store.list(admin,"enrollment",1,{search})).total,46);
  await db.query('UPDATE "CreditoBorrador" SET "clienteNombre"=\'Nombre 100% real\' WHERE id=1044');
  assert.equal((await store.list(admin,"enrollment",1,{search:"%"})).total,1);
  assert.equal((await store.list(admin,"enrollment",1,{search:"' OR true --"})).total,0);
  assert.equal((await store.list(analyst,"enrollment",1,{search:"Cliente"})).total,0,"search cannot expose unassigned cases to an analyst");
});

test("no leídos de solicitudes respetan al analista nominal y no exponen lecturas al asesor",async t=>{
  const {db,store,create}=await fixture(t);let d=await create();
  d=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"assign",assigneeKey:analyst.actor.key});
  assert.equal((await store.list(analyst,"enrollment",1,{filter:"unread"})).total,1);
  assert.equal((await store.list(admin,"enrollment",1,{filter:"unassigned"})).total,0);
  await db.query('INSERT INTO "AttentionReadState"("userId","messageId","conversationId") VALUES($1,$2,$3)',[analyst.actor.userId,d.messages[0].id,d.item.conversationId]);
  assert.equal((await store.list(analyst,"enrollment",1,{filter:"unread"})).total,0);
  assert.equal((await store.list(admin,"enrollment",1,{filter:"unread"})).items[0].unreadCount,1);
  const commercial=await store.list(seller,"enrollment");assert.equal(Object.hasOwn(commercial.items[0],"unreadCount"),false);
  assert.equal(Object.hasOwn((await store.detail(seller,d.item.id)).item,"unreadCount"),false);
  await assert.rejects(store.list(seller,"enrollment",1,{filter:"unread"}),{status:403});
  d=await store.mutate(seller,d.item.id,{requestId:randomUUID(),version:d.item.version,action:"message",text:"Información nueva del asesor"});
  const nominal=await store.list(analyst,"enrollment",1,{filter:"unread"});
  assert.equal(nominal.total,1);assert.equal(nominal.items[0].unreadCount,1);assert.equal(nominal.items[0].preview,"Información nueva del asesor");
  assert.equal((await store.detail(analyst,d.item.id)).item.unreadCount,1);
  await assert.rejects(store.list(admin,"enrollment",1,{state:"inventado"}),{status:400});
});
test("creación rechaza ventas ajenas, Android, bienvenida de borrador y roles de analista",async t=>{const {create,store}=await fixture(t);await assert.rejects(create({target:"D-102"}),{status:403});await assert.rejects(create({target:"D-101"}),/iPhone/);await assert.rejects(create({kind:"welcome"}),/crédito/);await assert.rejects(store.create(analyst,{requestId:randomUUID(),kind:"enrollment",target:"D-100"}),{status:403});});

test("central solicita enrolamiento sin suplantar al titular, conserva cuenta comercial y deduplica entre actores",async t=>{
  const {db,store,create}=await centralFixture(t),input=centralInput(),d=await store.create(admin,input);
  assert.equal(d.item.advisor,"Asesor");assert.equal(d.item.ally,"Tienda");assert.equal(d.messages[0].author,"Central");
  assert.deepEqual((await db.query('SELECT "sellerId","userId","sedeId","aliadoId" FROM "AttentionWorkRequest"')).rows,[{sellerId:11,userId:2,sedeId:20,aliadoId:2}]);
  assert.deepEqual((await db.query('SELECT "userId","sellerId","actorKey",metadata->>\'author\' AS author FROM "AttentionAudit" WHERE action=\'WORK_CREATED\'')).rows,[{userId:1,sellerId:null,actorKey:"admin:1",author:"Central"}]);
  assert.equal((await store.create(admin,input)).item.id,d.item.id);assert.equal((await create()).item.id,d.item.id);
  assert.deepEqual((await db.query('SELECT "recipientKey",kind FROM "AttentionWorkNotification" ORDER BY "recipientKey"')).rows,[{recipientKey:"user:5",kind:"created"},{recipientKey:"user:6",kind:"created"}]);
  let current=await store.mutate(admin,d.item.id,{requestId:randomUUID(),version:1,action:"assign",assigneeKey:analyst.actor.key});
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=1');
  await store.mutate(analyst,d.item.id,{requestId:randomUUID(),version:current.item.version,action:"message",text:"Respuesta interna del analista"});
  const notifications=createAttentionWorkNotificationStore(adapter(db));assert.equal((await notifications.list(seller)).items.filter(n=>n.kind==="reply").length,1,"el aviso del titular no depende de la cuenta del administrador que abrió el caso");
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionWorkRequest"')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
  assert.equal((await db.query('SELECT estado FROM "CreditoBorrador" WHERE id=100')).rows[0].estado,"PROCESO");
});

test("central reutiliza la solicitud previa del asesor sin reemplazar autor ni repetir mensajes o avisos",async t=>{
  const {db,store,create}=await centralFixture(t),original=await create(),before=(await db.query('SELECT count(*)::int n FROM "AttentionWorkNotification"')).rows[0].n;
  const reused=await store.create(admin,centralInput());assert.equal(reused.item.id,original.item.id);assert.equal(reused.messages.length,1);assert.equal(reused.messages[0].author,"Asesor");
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionWorkNotification"')).rows[0].n,before);
  assert.equal((await db.query('SELECT "userId" FROM "AttentionWorkRequest"')).rows[0].userId,2);
});

test("central conserva otro acceso comercial explícito del titular y rechaza su revocación sin escoger uno distinto",async t=>{
  const {db,store}=await centralFixture(t);await db.exec('INSERT INTO "Sede" VALUES(21,\'Otra sede del mismo aliado\',2,true); INSERT INTO "Usuario" VALUES(4,\'Otro acceso comercial válido\',21,2,true);');
  const anotherAccount={...seller,userId:4,userSedeId:21,key:"seller:4:11"};
  const original=await store.create(anotherAccount,centralInput()),reused=await store.create(admin,centralInput());
  assert.equal(reused.item.id,original.item.id);assert.equal((await db.query('SELECT "userId" FROM "AttentionWorkRequest"')).rows[0].userId,4);
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=4');await assert.rejects(store.create(admin,centralInput()),{status:409});
  assert.equal((await db.query('SELECT "userId" FROM "AttentionWorkRequest"')).rows[0].userId,4);assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionWorkRequest"')).rows[0].n,1);
});

test("un borrador del admin central resuelve solo el acceso USUARIO único de su sede y conserva autoría nominal",async t=>{
  const {db,store}=await centralFixture(t);await db.exec('UPDATE "CreditoBorrador" SET "usuarioId"=1 WHERE id=100; INSERT INTO "Rol" VALUES(4,\'USUARIO\'); INSERT INTO "Usuario" VALUES(4,\'Acceso comercial de sede\',20,4,true),(7,\'Otra administración\',10,1,true);');
  const d=await store.create(admin,centralInput());assert.equal(d.messages[0].author,"Central");
  assert.equal((await db.query('SELECT "userId" FROM "AttentionWorkRequest"')).rows[0].userId,4);
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=1');
  const another={type:"attention",actor:{...admin.actor,userId:7,key:"admin:7",name:"Otra administración"}};
  assert.equal((await store.create(another,centralInput())).item.id,d.item.id,"desactivar al autor central no retira la cuenta comercial real ni provoca otro caso");
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionWorkRequest"')).rows[0].n,1);
});

test("creación central limita tipo y fuente antes del intento y no habilita otras gestiones ni analistas",async t=>{
  const {db,store}=await centralFixture(t);
  for(const input of [centralInput({kind:"welcome",target:"C-200"}),centralInput({kind:"welcome"}),centralInput({target:"C-200"})])await assert.rejects(store.create(admin,input),{status:403});
  await assert.rejects(store.create(admin,centralInput({target:"D-101"})),/iPhone/);
  await assert.rejects(store.create(analyst,centralInput()),{status:403});
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionRequest"')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionWorkRequest"')).rows[0].n,0);
});

test("central no inventa titular ni cuenta: vínculos ausentes, ambiguos o revocados fallan sin crear ni avisar",async t=>{
  const {db,store}=await centralFixture(t);await db.exec('INSERT INTO "Rol" VALUES(4,\'USUARIO\'); INSERT INTO "Usuario" VALUES(4,\'Acceso comercial uno\',20,4,true),(8,\'Acceso comercial dos\',20,4,false);');
  const reset='UPDATE "CreditoBorrador" SET "vendedorId"=11,"usuarioId"=2,"sedeId"=20 WHERE id=100; UPDATE "Vendedor" SET activo=true,"debeCambiarPin"=false WHERE id=11; UPDATE "SedeVendedor" SET activo=true WHERE "vendedorId"=11; UPDATE "Usuario" SET activo=true WHERE id=2; UPDATE "Usuario" SET activo=false WHERE id=8; UPDATE "Sede" SET activa=true WHERE id=20;';
  for(const mutation of [
    'UPDATE "CreditoBorrador" SET "vendedorId"=NULL WHERE id=100',
    'UPDATE "Vendedor" SET activo=false WHERE id=11',
    'UPDATE "Vendedor" SET "debeCambiarPin"=true WHERE id=11',
    'UPDATE "SedeVendedor" SET activo=false WHERE "vendedorId"=11',
    'UPDATE "CreditoBorrador" SET "usuarioId"=999 WHERE id=100',
    'UPDATE "Usuario" SET activo=false WHERE id=2',
    'UPDATE "CreditoBorrador" SET "usuarioId"=5 WHERE id=100',
    'UPDATE "Sede" SET activa=false WHERE id=20',
    'UPDATE "CreditoBorrador" SET "usuarioId"=1 WHERE id=100; UPDATE "Usuario" SET activo=false WHERE id=4',
    'UPDATE "CreditoBorrador" SET "usuarioId"=1 WHERE id=100; UPDATE "Usuario" SET activo=true WHERE id IN (4,8)',
  ]){
    await db.exec(reset+' UPDATE "Usuario" SET activo=true WHERE id=4; '+mutation);
    await assert.rejects(store.create(admin,centralInput()),{status:409});
    for(const table of ["AttentionWorkRequest","AttentionConversation","AttentionMessage","AttentionWorkNotification","AttentionRequest"])assert.equal((await db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n,0,table);
  }
});

test("central revalida transferencias y revocaciones sin reasignar ni sobrescribir el caso activo",async t=>{
  const {db,store}=await centralFixture(t),input=centralInput(),d=await store.create(admin,input);
  await db.query('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');
  await assert.rejects(store.create(admin,centralInput()),{status:409});await assert.rejects(store.create(admin,input),{status:409});
  assert.equal((await store.list(seller,"enrollment")).total,0);await assert.rejects(store.detail(seller,d.item.id),{status:404});
  await db.query('UPDATE "CreditoBorrador" SET "vendedorId"=11 WHERE id=100');
  await db.query('UPDATE "Usuario" SET activo=false WHERE id=2');await assert.rejects(store.create(admin,centralInput()),{status:409});
  await db.query('UPDATE "Usuario" SET activo=true WHERE id=2');await db.query('UPDATE "Usuario" SET activo=false WHERE id=1');await assert.rejects(store.create(admin,centralInput()),{status:403});
  assert.deepEqual((await db.query('SELECT "sellerId","userId",version FROM "AttentionWorkRequest"')).rows,[{sellerId:11,userId:2,version:1}]);
  assert.equal((await db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,1);
});
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
