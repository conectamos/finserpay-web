import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,".."),jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionWorkStore}=await jiti.import("../lib/atencion-work-storage.ts");
const captureModule=await jiti.import("../lib/atencion-work-capture.ts");
const {createAttentionWorkCaptureStore,ATTENTION_WORK_CAPTURE_MAX_BYTES}=captureModule;
const core=await jiti.import("../lib/atencion-core.ts"),http=await jiti.import("../lib/atencion-http.ts"),metaHttp=await jiti.import("../lib/atencion-meta-http.ts");
const admin={type:"attention",actor:{userId:1,sellerId:null,key:"admin:1",name:"Central artificial",central:true,admin:true,analyst:false,supervisor:false,aliadoId:1,sedeId:10}};
const analyst={type:"attention",actor:{...admin.actor,userId:5,key:"analyst:5",name:"Analista artificial",central:false,admin:false,analyst:true}};
const seller={type:"seller",userId:2,userSedeId:20,sellerId:11,sedeId:20,accessSedeId:20,aliadoId:2,supervisor:false,name:"Asesor artificial",key:"seller:2:11"};
const token=()=>randomBytes(32).toString("hex"),png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]),jpg=new Uint8Array([255,216,255,224,0,0,0,0]);
const photo=(extra={})=>({requestId:randomUUID(),fileName:"foto-artificial.png",mimeType:"image/png",content:png,...extra});
const keys=["expiresAt","id","lastUploadedAt","state","uploadedCount"];
function adapter(db,calls){return {$queryRawUnsafe:async(sql,...values)=>{calls.push({sql,values});return(await db.query(sql,values)).rows;},$transaction:fn=>db.transaction(tx=>fn(adapter(tx,calls)))};}
async function fixture(t){
  const db=new PGlite(),calls=[];t.after(()=>db.close());await db.exec(`
    CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,nombre text,activo bool);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa bool);CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,"sedeId" int,"rolId" int,activo bool);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY,nombre text,activo bool,"debeCambiarPin" bool,"tipoPerfil" text);CREATE TABLE "SedeVendedor"("sedeId" int,"vendedorId" int,activo bool);
    CREATE TABLE "Credito"(id int PRIMARY KEY,"clienteNombre" text,"clienteDocumento" text,imei text,plataforma text,estado text,"vendedorId" int,"sedeId" int);CREATE TABLE "CreditoBorrador"(LIKE "Credito" INCLUDING ALL);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'VENDEDOR'),(3,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY','Central QA',true),(2,'LOCALQA','Aliado artificial',true);
    INSERT INTO "Sede" VALUES(10,'Central QA',1,true),(20,'Sede artificial',2,true);INSERT INTO "Usuario" VALUES(1,'Admin QA',10,1,true),(2,'Sede QA',20,2,true),(5,'Analista QA',10,3,true),(6,'Otro QA',10,3,true),(7,'Otra central QA',10,1,true);
    INSERT INTO "Vendedor" VALUES(11,'Asesor artificial',true,false,'VENDEDOR'),(12,'Otro artificial',true,false,'VENDEDOR'),(13,'Supervisor artificial',true,false,'SUPERVISOR');INSERT INTO "SedeVendedor" VALUES(20,11,true),(20,12,true),(20,13,true);
    INSERT INTO "CreditoBorrador" VALUES(100,'Cliente artificial QA','12345','123456789012345','IPHONE','PROCESO',11,20);INSERT INTO "Credito" VALUES(200,'Bienvenida artificial QA','12345','123456789012345','IPHONE','ACTIVO',11,20);
  `);await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  const database=adapter(db,calls),work=createAttentionWorkStore(database),capture=createAttentionWorkCaptureStore(database),item=await work.create(seller,{requestId:randomUUID(),kind:"enrollment",target:"D-100",text:"Prueba local de captura"});
  return {db,calls,work,capture,item,async start(actor=seller,extra={}){const input={requestId:randomUUID(),version:(await work.detail(actor,item.item.id)).item.version,token:token(),...extra};return {input,session:await capture.create(actor,item.item.id,input)};}};
}
const count=async(db,table)=>(await db.query(`SELECT count(*)::int n FROM "${table}"`)).rows[0].n;

test("QR liga caso y actor, caduca en veinte minutos y guarda solo hash; GET no expone datos ni archivos",async t=>{
  const f=await fixture(t),{input,session}=await f.start(),before=Date.now();assert.deepEqual(Object.keys(session).sort(),keys);assert.equal(session.state,"open");assert.equal(session.uploadedCount,0);
  assert.ok(new Date(session.expiresAt)-before>19*60000&&new Date(session.expiresAt)-before<=20*60000);
  assert.deepEqual(await f.capture.mobileStatus(input.token),session);assert.deepEqual(await f.capture.status(seller,f.item.item.id,session.id),session);
  assert.deepEqual(await f.capture.create(seller,f.item.item.id,input),session);assert.equal(await count(f.db,"AttentionWorkCaptureSession"),1);
  const persisted=(await f.db.query('SELECT * FROM "AttentionWorkCaptureSession"')).rows[0];assert.equal(persisted.tokenHash.length,64);assert.equal(persisted.actorKey,seller.key);assert.equal(persisted.workId,f.item.item.id);assert.ok(!JSON.stringify(persisted).includes(input.token));
  const audit=(await f.db.query('SELECT metadata FROM "AttentionAudit"')).rows;assert.ok(!JSON.stringify(audit).includes(input.token));
  assert.ok(!JSON.stringify(session).includes("Cliente artificial"));assert.equal(await count(f.db,"AttentionWorkFile"),0);
  for(const extra of [{token:token()},{version:2}])await assert.rejects(f.capture.create(seller,f.item.item.id,{...input,...extra}),{status:409});
  await assert.rejects(f.capture.status({...admin,actor:{...admin.actor,userId:7,key:"admin:7"}},f.item.item.id,session.id),{status:404});
});

test("fotos QR se guardan atómicamente en chat y archivos privados; replay conserva intención original sin duplicar avisos",async t=>{
  const f=await fixture(t),{input,session}=await f.start(),one=photo(),first=await f.capture.upload(input.token,one),notifications=await count(f.db,"AttentionWorkNotification");
  assert.equal(first.uploadedCount,1);assert.ok(first.lastUploadedAt);assert.deepEqual(Object.keys(first).sort(),keys);
  assert.deepEqual(await f.capture.upload(input.token,one),first);assert.equal(await count(f.db,"AttentionWorkFile"),1);assert.equal(await count(f.db,"AttentionMessage"),2);assert.equal(await count(f.db,"AttentionWorkNotification"),notifications);
  assert.deepEqual(await f.capture.create(seller,f.item.item.id,input),first,"create retry conserva versión original tras la foto");
  await f.work.mutate(seller,f.item.item.id,{requestId:randomUUID(),version:(await f.work.detail(seller,f.item.item.id)).item.version,action:"message",text:"Mensaje artificial posterior"});
  const second=await f.capture.upload(input.token,photo({fileName:"foto-artificial.jpg",mimeType:"image/jpeg",content:jpg}));assert.equal(second.uploadedCount,2);assert.equal(second.id,session.id);
  const detail=await f.work.detail(seller,f.item.item.id),attachments=detail.messages.filter(m=>m.attachment);assert.equal(attachments.length,2);assert.equal(attachments[0].direction,"inbound");assert.equal(attachments[0].author,seller.name);assert.ok(attachments[0].attachment.url.startsWith(`/api/ventas/atencion/${f.item.item.id}/files/`));
  assert.deepEqual(new Uint8Array((await f.work.media(seller,f.item.item.id,attachments[0].attachment.id)).content),png);
  assert.equal(await count(f.db,"AttentionMetaOutbox"),0);assert.equal(await count(f.db,"AttentionMetaBinding"),0);assert.equal((await f.db.query('SELECT estado FROM "CreditoBorrador" WHERE id=100')).rows[0].estado,"PROCESO");
  const provenance=(await f.db.query('SELECT "actorKey",metadata FROM "AttentionAudit" WHERE action=\'WORK_FILE\' ORDER BY id')).rows;assert.equal(provenance.length,2);assert.equal(provenance[0].actorKey,seller.key);assert.equal(provenance[0].metadata.source,"qr_capture");assert.equal(provenance[0].metadata.captureSessionId,session.id);
});

test("replay con bytes/nombre distintos, MIME falso y archivos fuera de límite no escriben ni cuentan fotos",async t=>{
  const f=await fixture(t),{input}=await f.start(),p=photo();await f.capture.upload(input.token,p);
  for(const altered of [{content:jpg,mimeType:"image/jpeg",fileName:"otro.jpg"},{fileName:"otra.png"}])await assert.rejects(f.capture.upload(input.token,{...p,...altered}),{status:409});
  for(const p of [photo({mimeType:"application/pdf",fileName:"qa.pdf"}),photo({content:jpg}),photo({content:new Uint8Array(ATTENTION_WORK_CAPTURE_MAX_BYTES+1)}),photo({content:new Uint8Array()})])await assert.rejects(async()=>f.capture.upload(input.token,p));
  assert.equal(await count(f.db,"AttentionWorkFile"),1);assert.equal((await f.capture.mobileStatus(input.token)).uploadedCount,1);assert.equal(await count(f.db,"AttentionRequest"),2,"solo solicitud original + foto válida");
  const p2=photo({content:new Uint8Array([...png,0])}),status=await f.capture.upload(input.token,p2);assert.equal(status.uploadedCount,2);
});

test("cancelar y reiniciar revoca el enlace anterior y no reactiva tokens al reintentar create",async t=>{
  const f=await fixture(t),old=await f.start(),next=await f.start();assert.equal((await f.capture.mobileStatus(old.input.token)).state,"revoked");await assert.rejects(f.capture.upload(old.input.token,photo()),{status:410});
  assert.equal((await f.capture.create(seller,f.item.item.id,old.input)).state,"revoked");assert.equal((await f.capture.mobileStatus(next.input.token)).state,"open");
  const revoked=await f.capture.revoke(seller,f.item.item.id,next.session.id);assert.equal(revoked.state,"revoked");assert.deepEqual(await f.capture.revoke(seller,f.item.item.id,next.session.id),revoked);await assert.rejects(f.capture.upload(next.input.token,photo()),{status:410});
  assert.equal(await count(f.db,"AttentionWorkFile"),0);assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionAudit" WHERE action=\'WORK_CAPTURE_REVOKED\'')).rows[0].n,1);
});

test("caducidad y finalización bloquean cargas y no amplían el plazo de un intento existente",async t=>{
  const f=await fixture(t),old=await f.start();await f.db.query('UPDATE "AttentionWorkCaptureSession" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1',[old.session.id]);
  const expired=await f.capture.mobileStatus(old.input.token);assert.equal(expired.state,"expired");assert.equal((await f.capture.create(seller,f.item.item.id,old.input)).expiresAt,expired.expiresAt);await assert.rejects(f.capture.upload(old.input.token,photo()),{status:410});
  const next=await f.start();await f.db.query('UPDATE "AttentionWorkRequest" SET state=\'completed\' WHERE id=$1',[f.item.item.id]);
  await assert.rejects(f.capture.mobileStatus(next.input.token),{status:410});await assert.rejects(f.capture.upload(next.input.token,photo()),{status:410});await assert.rejects(f.capture.create(seller,f.item.item.id,{...next.input,requestId:randomUUID(),token:token()}),{status:410});
  assert.equal((await f.capture.revoke(seller,f.item.item.id,next.session.id)).state,"revoked");assert.equal(await count(f.db,"AttentionWorkFile"),0);
});

test("finalizar y reabrir el caso no revive un QR anterior; otro caso nunca comparte su sesión",async t=>{
  const f=await fixture(t),s=await f.start();
  const closed=await f.work.workflowMutate(admin,f.item.item.id,"enrollment",{requestId:randomUUID(),version:1},async()=>({result:{localQA:true},summary:"Cierre artificial QA",complete:true}));
  await f.work.mutate(admin,f.item.item.id,{requestId:randomUUID(),version:closed.detail.item.version,action:"state",state:"review",text:"Reapertura artificial QA"});
  await assert.rejects(f.capture.mobileStatus(s.input.token),{status:409});await assert.rejects(f.capture.upload(s.input.token,photo()),{status:409});
  const renewed=await f.start(),second=await f.work.create(seller,{requestId:randomUUID(),kind:"welcome",target:"C-200",text:"Otro caso artificial QA"});
  await assert.rejects(f.capture.status(seller,second.item.id,renewed.session.id),{status:404});
  const otherToken=token(),other=await f.capture.create(seller,second.item.id,{requestId:randomUUID(),version:1,token:otherToken});
  assert.equal((await f.capture.mobileStatus(renewed.input.token)).state,"open");assert.notEqual(other.id,renewed.session.id);
  await f.capture.upload(renewed.input.token,photo());assert.equal((await f.capture.mobileStatus(otherToken)).uploadedCount,0);assert.equal((await f.work.detail(seller,second.item.id)).messages.length,1);
});

test("cada carga revalida cuenta, sede, aliado, perfil y PIN comercial actuales",async t=>{
  const f=await fixture(t),s=await f.start();
  for(const [deny,restore] of [
    ['UPDATE "Usuario" SET activo=false WHERE id=2','UPDATE "Usuario" SET activo=true WHERE id=2'],
    ['UPDATE "Sede" SET activa=false WHERE id=20','UPDATE "Sede" SET activa=true WHERE id=20'],
    ['UPDATE "Aliado" SET activo=false WHERE id=2','UPDATE "Aliado" SET activo=true WHERE id=2'],
    ['UPDATE "Vendedor" SET "debeCambiarPin"=true WHERE id=11','UPDATE "Vendedor" SET "debeCambiarPin"=false WHERE id=11'],
    ['UPDATE "Vendedor" SET "tipoPerfil"=\'SUPERVISOR\' WHERE id=11','UPDATE "Vendedor" SET "tipoPerfil"=\'VENDEDOR\' WHERE id=11'],
    ['UPDATE "SedeVendedor" SET activo=false WHERE "vendedorId"=11','UPDATE "SedeVendedor" SET activo=true WHERE "vendedorId"=11'],
  ]){await f.db.exec(deny);await assert.rejects(f.capture.mobileStatus(s.input.token),{status:403});await assert.rejects(f.capture.upload(s.input.token,photo()),{status:403});await f.db.exec(restore);}
  assert.equal(await count(f.db,"AttentionWorkFile"),0);assert.equal((await f.capture.mobileStatus(s.input.token)).state,"open");
  const a=await f.start(admin);await f.db.exec('UPDATE "Usuario" SET "rolId"=3 WHERE id=1');await assert.rejects(f.capture.upload(a.input.token,photo()),{status:403});
});

test("analistas requieren asignación y la transferencia invalida incluso el QR del administrador global",async t=>{
  const f=await fixture(t);await assert.rejects(f.start(analyst),{status:404});
  await f.work.mutate(admin,f.item.item.id,{requestId:randomUUID(),version:1,action:"assign",assigneeKey:analyst.actor.key});
  const a=await f.start(analyst),central=await f.start(admin);
  await f.work.mutate(admin,f.item.item.id,{requestId:randomUUID(),version:(await f.work.detail(admin,f.item.item.id)).item.version,action:"assign",assigneeKey:"analyst:6"});
  await assert.rejects(f.capture.upload(a.input.token,photo()),{status:404});await assert.rejects(f.capture.upload(central.input.token,photo()),{status:409});
  await f.work.mutate(admin,f.item.item.id,{requestId:randomUUID(),version:(await f.work.detail(admin,f.item.item.id)).item.version,action:"assign",assigneeKey:analyst.actor.key});
  await assert.rejects(f.capture.mobileStatus(a.input.token),{status:409});await assert.rejects(f.capture.mobileStatus(central.input.token),{status:409});
  const renewed=await f.start(admin);await f.capture.upload(renewed.input.token,photo());const msg=(await f.work.detail(admin,f.item.item.id)).messages.at(-1);assert.equal(msg.author,admin.actor.name);assert.equal(msg.direction,"outbound");
  const event=(await f.db.query('SELECT "userId","sellerId","actorKey" FROM "AttentionAudit" WHERE action=\'WORK_FILE\'')).rows[0];assert.deepEqual(event,{userId:1,sellerId:null,actorKey:"admin:1"});
});

test("cambiar titular, identidad o plataforma invalida la captura; un supervisor ajeno no obtiene permiso de escritura",async t=>{
  const f=await fixture(t),s=await f.start(),a=await f.start(admin);
  await f.db.exec('UPDATE "CreditoBorrador" SET "vendedorId"=12 WHERE id=100');await assert.rejects(f.capture.upload(s.input.token,photo()));await assert.rejects(f.capture.upload(a.input.token,photo()),{status:409});await f.db.exec('UPDATE "CreditoBorrador" SET "vendedorId"=11 WHERE id=100');
  for(const [change,restore] of [['"clienteDocumento"=\'99999\'','"clienteDocumento"=\'12345\''],['imei=\'123456789012346\'','imei=\'123456789012345\''],['plataforma=\'ANDROID\'','plataforma=\'IPHONE\'']]){await f.db.exec(`UPDATE "CreditoBorrador" SET ${change} WHERE id=100`);await assert.rejects(f.capture.upload(a.input.token,photo()),{status:409});await f.db.exec(`UPDATE "CreditoBorrador" SET ${restore} WHERE id=100`);}
  await assert.rejects(f.capture.create({...seller,sellerId:13,key:"seller:2:13",supervisor:true},f.item.item.id,{requestId:randomUUID(),version:1,token:token()}),{status:403});assert.equal(await count(f.db,"AttentionWorkFile"),0);
});

test("cuotas y fallo de notificación revierten archivo, mensaje, ledger y conteo en la misma transacción",async t=>{
  const f=await fixture(t);await f.work.mutate(admin,f.item.item.id,{requestId:randomUUID(),version:1,action:"assign",assigneeKey:analyst.actor.key});const s=await f.start();
  await f.db.query('INSERT INTO "AttentionWorkFile"(id,"workId",content,"mimeType") SELECT gen_random_uuid(),$1::uuid,decode(\'ffd8ff\',\'hex\'),\'image/jpeg\' FROM generate_series(1,100)',[f.item.item.id]);await assert.rejects(f.capture.upload(s.input.token,photo()),{status:409});assert.equal((await f.capture.mobileStatus(s.input.token)).uploadedCount,0);assert.equal(await count(f.db,"AttentionMessage"),1);
  await f.db.exec('DELETE FROM "AttentionWorkFile";CREATE FUNCTION qa_reject_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'QA rollback\'; END $$;CREATE TRIGGER qa_reject_notification BEFORE INSERT ON "AttentionWorkNotification" FOR EACH ROW EXECUTE FUNCTION qa_reject_notification();');
  await assert.rejects(f.capture.upload(s.input.token,photo()),/QA rollback/);assert.equal(await count(f.db,"AttentionWorkFile"),0);assert.equal(await count(f.db,"AttentionMessage"),1);assert.equal(await count(f.db,"AttentionRequest"),2);assert.equal((await f.capture.mobileStatus(s.input.token)).uploadedCount,0);
});

test("datos inválidos y tabla pendiente fallan sin crear sesiones ni cargar proveedores",async t=>{
  const f=await fixture(t),base={requestId:randomUUID(),version:1,token:token()};
  for(const input of [null,[],{...base,token:"corto"},{...base,version:"1"},{...base,requestId:"x"},{...base,target:"D-100"}])await assert.rejects(async()=>f.capture.create(seller,f.item.item.id,input),{status:400});
  assert.equal(await count(f.db,"AttentionWorkCaptureSession"),0);await assert.rejects(f.capture.mobileStatus(token()),{status:404});await assert.rejects(f.capture.mobileStatus("bad"),{status:401});
  await f.db.exec('DROP TABLE "AttentionWorkCaptureSession"');await assert.rejects(f.capture.create(seller,f.item.item.id,base),{status:503});await assert.rejects(f.capture.mobileStatus(base.token),{status:503});
});

function compile(file,mocks){const mod={exports:{}},source=ts.transpileModule(readFileSync(path.join(root,file),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;new Function("require","module","exports",source)(name=>{assert.ok(name in mocks,`No live dependency: ${name}`);return mocks[name];},mod,mod.exports);return mod.exports;}
function handlers(){
  const calls=[],status={id:randomUUID(),expiresAt:new Date(Date.now()+20*60000).toISOString(),state:"open",uploadedCount:0,lastUploadedAt:null},store=Object.fromEntries(["create","status","revoke","mobileStatus","upload"].map(name=>[name,async(...args)=>{calls.push({name,args});return status;}]));
  const handlers=compile("lib/atencion-work-capture-http.ts",{"server-only":{},"./atencion-core":core,"./atencion-http":http,"./atencion-meta-http":metaHttp,"./atencion-work-access":{getAttentionWorkAccess:async mode=>{calls.push({name:"access",args:[mode]});return seller;}},"./atencion-work-capture":{...captureModule,attentionWorkCaptureStore:async()=>store}});
  return {...handlers,calls,status};
}
const privateResponse=r=>{assert.match(r.headers.get("cache-control"),/private, no-store/);assert.equal(r.headers.get("vary"),"Cookie, Authorization");assert.equal(r.headers.get("referrer-policy"),"no-referrer");};

test("HTTP exige origen, token en Authorization y campos únicos; móvil devuelve ack privado sin sesión de usuario",async()=>{
  const h=handlers(),bearer=token(),base="https://finser.example/api/atencion/captura",header={authorization:`Bearer ${bearer}`};
  let r=await h.attentionWorkCaptureMobileHandlers.status(new Request(base,{headers:header}));assert.equal(r.status,200);assert.deepEqual(await r.json(),h.status);privateResponse(r);assert.ok(!h.calls.some(call=>call.name==="access"));
  for(const request of [new Request(base),new Request(base+`?token=${bearer}`,{headers:header}),new Request(base,{headers:{authorization:"Bearer bad"}})]){r=await h.attentionWorkCaptureMobileHandlers.status(request);assert.ok([400,401].includes(r.status));assert.ok(!JSON.stringify(await r.json()).includes(bearer));privateResponse(r);}
  const form=()=>{const f=new FormData();f.set("requestId",randomUUID());f.set("file",new File([png],"prueba-artificial.png",{type:"image/png"}));return f;};
  r=await h.attentionWorkCaptureMobileHandlers.upload(new Request(base,{method:"POST",headers:{...header,origin:"https://foreign.invalid"},body:form()}));assert.equal(r.status,403);
  const duplicate=form();duplicate.append("requestId",randomUUID());r=await h.attentionWorkCaptureMobileHandlers.upload(new Request(base,{method:"POST",headers:{...header,origin:"https://finser.example"},body:duplicate}));assert.equal(r.status,400);
  r=await h.attentionWorkCaptureMobileHandlers.upload(new Request(base,{method:"POST",headers:{...header,origin:"https://finser.example"},body:form()}));assert.equal(r.status,200);privateResponse(r);assert.equal(h.calls.filter(call=>call.name==="upload").length,1);assert.deepEqual(h.calls.find(call=>call.name==="upload").args[1].content,png);
  const ctx={params:Promise.resolve({id:randomUUID(),sessionId:randomUUID()})},desktop=h.attentionWorkCaptureHandlers("seller");r=await desktop.create(new Request("https://finser.example/api/ventas/atencion/qa/capture",{method:"POST",headers:{origin:"https://finser.example","content-type":"application/json"},body:JSON.stringify({requestId:randomUUID(),version:1,token:bearer})}),ctx);assert.equal(r.status,201);privateResponse(r);assert.ok(h.calls.some(call=>call.name==="access"&&call.args[0]==="seller"));
});

test("rutas nuevas solo exponen los métodos previstos y params asíncronos",()=>{
  const called=[],fake={attentionWorkCaptureHandlers:mode=>{called.push(mode);return {create:()=>"create",status:()=>"status",revoke:()=>"revoke"};},attentionWorkCaptureMobileHandlers:{status:()=>"mobile-status",upload:()=>"mobile-upload"}};
  for(const mode of ["ventas/atencion","atencion/solicitudes"]){const route=compile(`app/api/${mode}/[id]/capture/route.ts`,{"@/lib/atencion-work-capture-http":fake}),single=compile(`app/api/${mode}/[id]/capture/[sessionId]/route.ts`,{"@/lib/atencion-work-capture-http":fake});assert.equal(route.POST(),"create");assert.equal(route.GET,undefined);assert.equal(single.GET(),"status");assert.equal(single.DELETE(),"revoke");assert.equal(single.POST,undefined);assert.equal(route.dynamic,"force-dynamic");}
  const mobile=compile("app/api/atencion/captura/route.ts",{"@/lib/atencion-work-capture-http":fake});assert.equal(mobile.GET(),"mobile-status");assert.equal(mobile.POST(),"mobile-upload");assert.deepEqual(called,["seller","seller","seller","attention","attention","attention"]);
});
