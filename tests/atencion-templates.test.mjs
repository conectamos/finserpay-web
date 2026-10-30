import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import {createJiti} from "jiti";
import {PGlite} from "@electric-sql/pglite";

const root=path.resolve(import.meta.dirname,".."),jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const templates=await jiti.import("../lib/atencion-meta-templates.ts"),core=await jiti.import("../lib/atencion-core.ts"),http=await jiti.import("../lib/atencion-http.ts");
const {createMetaAttentionAdapter,META_ATTENTION_LINE}=await jiti.import("../lib/atencion-meta.ts");
const {createAttentionMetaStore}=await jiti.import("../lib/atencion-meta-storage.ts");
const {createAttentionMetaService}=await jiti.import("../lib/atencion-meta-service.ts");
const {renderAttentionTemplatePreview}=await jiti.import("../lib/atencion-template-types.ts");
const actor={userId:5,sellerId:null,key:"analyst:5",name:"Analista real",central:false,admin:false,analyst:true,supervisor:false,aliadoId:1,sedeId:10};
const scope={phoneNumberId:META_ATTENTION_LINE.phoneNumberId,wabaId:META_ATTENTION_LINE.wabaId},now="2026-10-30T18:00:00.000Z",phone="12025550100";
const env={WHATSAPP_ATTENTION_ACCESS_TOKEN:"test-attention-token",WHATSAPP_ATTENTION_APP_SECRET:"test-attention-secret",WHATSAPP_ATTENTION_VERIFY_TOKEN:"test-verify-token",
  WHATSAPP_ATTENTION_PHONE_NUMBER_ID:scope.phoneNumberId,WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:scope.wabaId,WHATSAPP_GRAPH_API_VERSION:"v25.0",WHATSAPP_ATTENTION_SEND_ENABLED:"true",WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED:"true"};
const raw=(patch={})=>({id:"12345678901",name:"soporte",language:"es",category:"UTILITY",status:"APPROVED",parameter_format:"POSITIONAL",components:[{type:"HEADER",format:"TEXT",text:"Atención {{1}}"},{type:"BODY",text:"Hola {{1}}, revisamos tu consulta. Hola {{1}}."},{type:"FOOTER",text:"FINSER PAY"},{type:"BUTTONS",buttons:[{type:"QUICK_REPLY",text:"Continuar"},{type:"URL",text:"Ver caso",url:"https://finserpay.com/caso/{{1}}"}]}],...patch});
const definition=()=>templates.readMetaManualTemplate(raw());
const parameters={"header:1":"FINSER PAY","body:1":"María","button:1":"CASO-15"};
const intent=(patch={})=>({requestId:randomUUID(),version:1,templateKey:definition().key,revision:definition().revision,parameters:{...parameters},confirmed:true,...patch});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});
function database(db){return {$queryRawUnsafe:async(sql,...args)=>(await db.query(sql,args)).rows,$transaction:run=>db.transaction(tx=>run(database(tx)))};}
async function fixture(t,options={}){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id integer PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id integer PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id integer PRIMARY KEY,"aliadoId" integer,activa boolean);CREATE TABLE "Usuario"(id integer PRIMARY KEY,nombre text,activo boolean,"sedeId" integer,"rolId" integer);
    CREATE TABLE "Vendedor"(id integer PRIMARY KEY);CREATE TABLE "Credito"(id integer PRIMARY KEY);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(2,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);INSERT INTO "Sede" VALUES(10,1,true);
    INSERT INTO "Usuario" VALUES(1,'Central',true,10,1),(5,'Analista real',true,10,2),(6,'Otro analista',true,10,2);`);
  await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  const id=randomUUID();await db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name,status,mode,"assigneeUserId","assigneeKey","assigneeName","closedAt") VALUES($1,'dapta-historical','whatsapp',$2,'Contacto','closed','human',5,'analyst:5','Analista real',$3)`,[id,`+${phone}`,"2026-10-29T18:00:00Z"]);
  const calls={get:0,post:[],catalogue:0},runtimeEnv={...env,...options.env};
  const adapter=createMetaAttentionAdapter({env:runtimeEnv,now:()=>Date.parse(now),fetch:async(url,init)=>{
    const u=new URL(url);assert.equal(u.origin,"https://graph.facebook.com");assert.equal(init.headers.Authorization,`Bearer ${runtimeEnv.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);assert.equal(init.redirect,"error");
    if(init.method==="POST"){
      const payload=JSON.parse(init.body);calls.post.push(payload);if(options.post)return options.post(payload);
      return json({messaging_product:"whatsapp",contacts:[{input:phone,wa_id:phone}],messages:[{id:`wamid.template-${payload.biz_opaque_callback_data}`}]});
    }
    calls.get++;
    if(u.pathname.endsWith("/message_templates")){calls.catalogue++;await options.onCatalogue?.(calls.catalogue,db,id);return json({data:options.catalogue?options.catalogue(calls.catalogue):[raw()]});}
    if(u.pathname.endsWith("/phone_numbers"))return json({data:[{id:scope.phoneNumberId,display_phone_number:META_ATTENTION_LINE.displayPhone}]});
    return json({id:scope.phoneNumberId,display_phone_number:options.wrongLine?"+573000000000":META_ATTENTION_LINE.displayPhone});
  }});
  const store=createAttentionMetaStore(database(db),{scope,sendingEnabled:adapter.status().canSend,cutoverConfirmed:adapter.status().cutoverConfirmed,now:()=>new Date(now)});
  const service=createAttentionMetaService(store,adapter);
  return {db,id,calls,adapter,store,service};
}

test("catálogo aprobado sanea identidad privada, razones de disponibilidad y preview exacto",()=>{
  const d=definition(),publicTemplate=templates.publicMetaTemplate(d);
  assert.equal(d.available,true);assert.equal(d.parameters.filter(p=>p.key==="body:1").length,1);
  assert.ok(!JSON.stringify(publicTemplate).includes(d.providerId));assert.ok(!Object.hasOwn(publicTemplate,"format"));
  const compiled=templates.compileMetaTemplate({definition:d,parameters});
  assert.equal(compiled.text,renderAttentionTemplatePreview(publicTemplate,parameters));assert.match(compiled.text,/Hola María.*Hola María/s);assert.match(compiled.text,/https:\/\/finserpay.com\/caso\/CASO-15/);
  assert.match(renderAttentionTemplatePreview(publicTemplate,{}),/\{\{1\}\}/);
  assert.deepEqual(compiled.template.components[0],{type:"header",parameters:[{type:"text",text:"FINSER PAY"}]});
  assert.equal(compiled.template.components[2].sub_type,"quick_reply");assert.equal(compiled.template.components[3].sub_type,"url");
  for(const name of ["bienvenida","1_dia_falta","hoyvence","data","2dias","cuotavencida","bloqueo","liquidacion_aliado_pdf","liquidacion_aliado","vencido","fechap"]){const blocked=templates.readMetaManualTemplate(raw({name}));assert.equal(blocked.available,false);assert.throws(()=>templates.compileMetaTemplate({definition:blocked,parameters}),{status:409});}
  for(const patch of [{category:"AUTHENTICATION"},{category:undefined},{category:"UNKNOWN"},{parameter_format:"NAMED"},{components:[{type:"BODY",text:"Hola"},{type:"HEADER",format:"IMAGE"}]},{components:[{type:"BODY",text:"Hola {{2}}"}]},{components:[{type:"BODY",text:"Hola"},{type:"BUTTONS",buttons:[{type:"FLOW",text:"Flujo"}]}]}])assert.equal(templates.readMetaManualTemplate(raw(patch)).available,false);
  assert.equal(templates.readMetaManualTemplate(raw({status:"PAUSED"})),null);assert.equal(templates.readMetaManualTemplate(raw({status:"REJECTED"})),null);
});

test("intención estricta exige confirmación y parámetros exactos sin campos arbitrarios, URL externa ni tokens sin completar",()=>{
  assert.deepEqual(templates.parseAttentionTemplateIntent(intent()).parameters,{"body:1":"María","button:1":"CASO-15","header:1":"FINSER PAY"});
  for(const patch of [{confirmed:false},{confirmed:undefined},{requestId:"bad"},{version:0},{providerId:"123456"},{mediaUrl:"https://evil.example"},{parameters:null},{parameters:{"body:1":"A\nB"}},{parameters:JSON.parse('{"__proto__":"bad"}')}])assert.throws(()=>templates.parseAttentionTemplateIntent(intent(patch)),{status:400});
  for(const values of [{...parameters,"body:2":"extra"},{...parameters,"body:1":"{{1}}"},{...parameters,"button:1":"https://evil.example"},{...parameters,"header:1":"a".repeat(61)}])assert.throws(()=>templates.compileMetaTemplate({definition:definition(),parameters:values}),{status:400});
  assert.equal(templates.readMetaManualTemplate(raw({components:[{type:"BODY",text:"Hola"},{type:"BUTTONS",buttons:[{type:"URL",text:"Enlace",url:"https://example.com{{1}}"}]}]})).available,false);
});

test("envío manual aprobado fuera de 24h vincula chat histórico único y preserva cierre, analista e historial",async t=>{
  const f=await fixture(t),catalogue=await f.service.templates(actor,f.id);
  assert.equal(catalogue.canSend,true);assert.equal(catalogue.requiresBindingConfirmation,true);assert.equal(catalogue.templates.length,1);assert.equal(f.calls.post.length,0);
  const input=intent(),sent=await f.service.sendTemplate(actor,f.id,input);
  assert.equal(sent.message.deliveryStatus,"accepted");assert.equal(sent.message.author,actor.name);assert.equal(sent.uncertain,false);
  const [row]=(await f.db.query('SELECT * FROM "AttentionConversation" WHERE id=$1',[f.id])).rows;
  assert.equal(row.externalId,"dapta-historical");assert.equal(row.status,"closed");assert.equal(row.mode,"human");assert.equal(row.assigneeKey,actor.key);assert.equal(row.metaLastInboundAt,null);assert.equal(row.metaManaged,true);
  assert.equal((await f.store.getMessaging(actor,f.id)).canReply,false);
  assert.equal(f.calls.post.length,1);assert.equal(f.calls.post[0].type,"template");assert.equal(f.calls.post[0].to,phone);
  const outbox=(await f.db.query('SELECT * FROM "AttentionMetaOutbox"')).rows[0];assert.equal(outbox.template.definition.name,"soporte");assert.equal(outbox.authorName,actor.name);
  const replay=await f.service.sendTemplate(actor,f.id,input);assert.equal(replay.message.id,sent.message.id);assert.equal(f.calls.post.length,1);
  await assert.rejects(f.service.sendTemplate(actor,f.id,{...input,parameters:{...parameters,"body:1":"Otra"}}),{status:409});
});

test("autorización por asignación, flags, versión y destinatario ambiguo impiden vincular o enviar",async t=>{
  const f=await fixture(t);await assert.rejects(f.service.templates({...actor,userId:6,key:"analyst:6"},f.id),{status:404});assert.equal(f.calls.get,0);
  await assert.rejects(f.service.sendTemplate(actor,f.id,intent({version:2})),{status:409});assert.equal(f.calls.post.length,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaBinding"')).rows[0].n,0);
  await f.db.query(`INSERT INTO "AttentionConversation"(id,channel,phone,name) VALUES($1,'whatsapp',$2,'Duplicado')`,[randomUUID(),`+${phone}`]);
  assert.equal((await f.service.templates(actor,f.id)).canSend,false);await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:409});
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
  const disabled=createAttentionMetaStore(database(f.db),{scope,sendingEnabled:false,cutoverConfirmed:true});assert.equal((await disabled.getTemplateAccess(actor,f.id)).canSend,false);
});

test("binding a otro canal o contacto nunca se sustituye para enviar plantilla",async t=>{
  const f=await fixture(t);await f.db.query(`INSERT INTO "AttentionMetaBinding"(id,"conversationId","phoneNumberId","wabaId","contactId") VALUES($1,$2,'999999','888888',$3)`,[randomUUID(),f.id,phone]);
  assert.equal((await f.service.templates(actor,f.id)).canSend,false);await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:409});assert.equal(f.calls.post.length,0);
});

test("plantilla modificada o desautorizada se rechaza antes del único POST y requiere nueva revisión",async t=>{
  const f=await fixture(t,{catalogue:count=>count===1?[raw()]:[raw({components:[{type:"BODY",text:"Contenido cambiado {{1}}"}]})]});
  await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:409});assert.equal(f.calls.post.length,0);
  assert.equal((await f.db.query('SELECT status FROM "AttentionMetaOutbox"')).rows[0].status,"failed");
  const blocked=await fixture(t,{catalogue:()=>[raw({status:"PAUSED"})]});await assert.rejects(blocked.service.sendTemplate(actor,blocked.id,intent()),{status:409});assert.equal(blocked.calls.post.length,0);
});

test("reasignación durante lectura de Meta se revalida antes de enviar; catálogo no revela datos tras revocación",async t=>{
  const f=await fixture(t,{onCatalogue:async(count,db,id)=>{if(count===2)await db.query(`UPDATE "AttentionConversation" SET "assigneeUserId"=6,"assigneeKey"='analyst:6',version=version+1 WHERE id=$1`,[id]);}});
  await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:404});assert.equal(f.calls.post.length,0);
  assert.equal((await f.db.query('SELECT status FROM "AttentionMetaOutbox"')).rows[0].status,"failed");
  const revoked=await fixture(t,{onCatalogue:async(_count,db)=>db.query('UPDATE "Usuario" SET activo=false WHERE id=5')});
  await assert.rejects(revoked.service.templates(actor,revoked.id),{status:403});
});

test("timeout incierto conserva intento, no repite POST y callback exacto acredita entrega con autor original",async t=>{
  const f=await fixture(t,{post:()=>{throw new Error("private provider information");}}),input=intent();
  const first=await f.service.sendTemplate(actor,f.id,input);assert.equal(first.uncertain,true);assert.equal(first.message.deliveryStatus,"uncertain");
  assert.ok(!JSON.stringify(first).includes("private provider"));assert.equal((await f.service.sendTemplate(actor,f.id,input)).uncertain,true);assert.equal(f.calls.post.length,1);
  await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:409});
  const outbox=(await f.db.query('SELECT id FROM "AttentionMetaOutbox"')).rows[0];
  await f.store.ingest({scope,messages:[],statuses:[{id:"wamid.manual-confirmed",recipient:phone,timestamp:now,status:"read",errorCodes:[],requestId:outbox.id}],ignored:0});
  const found=await f.service.find(actor,f.id,input.requestId);assert.equal(found.message.deliveryStatus,"read");assert.equal(found.message.author,actor.name);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,1);assert.equal(f.calls.post.length,1);
});

test("rechazo definitivo no reintenta y cancelación durable impide POST atrasado de plantilla",async t=>{
  const f=await fixture(t,{post:()=>json({error:{code:132000}},400)}),input=intent();
  assert.equal((await f.service.sendTemplate(actor,f.id,input)).message.deliveryStatus,"failed");
  assert.equal((await f.service.sendTemplate(actor,f.id,input)).message.deliveryStatus,"failed");assert.equal(f.calls.post.length,1);
  const cancelled=intent();await f.store.cancelReply(actor,f.id,cancelled.requestId);await assert.rejects(f.service.sendTemplate(actor,f.id,cancelled),{status:409});assert.equal(f.calls.post.length,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMessage"')).rows[0].n,0);
});

test("competencia sobre mismo UUID produce un solo POST; ausencia de migración no escribe ni ejecuta DDL",async t=>{
  const f=await fixture(t),input=intent();const responses=await Promise.all([f.service.sendTemplate(actor,f.id,input),f.service.sendTemplate(actor,f.id,input)]);
  assert.equal(f.calls.post.length,1);assert.ok(responses.some(result=>result.message.deliveryStatus==="accepted"));
  await f.db.exec('ALTER TABLE "AttentionMetaOutbox" DROP COLUMN template');
  await assert.rejects(f.service.templates(actor,f.id),{status:503});await assert.rejects(f.service.sendTemplate(actor,f.id,intent()),{status:503});
});

function endpoint(service,store,who=actor){
  const file=path.join(root,"app/api/atencion/[id]/templates/route.ts"),source=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const output={exports:{}};const requires={"@/lib/atencion-core":{getAttentionAccess:async()=>{if(who instanceof Error)throw who;return who;}},"@/lib/atencion-http":http,
    "@/lib/atencion-meta-service":{attentionMetaRuntime:async()=>({service,store})},"@/lib/atencion-meta-templates":templates};
  new Function("require","module","exports",source)(id=>{assert.ok(requires[id],id);return requires[id];},output,output.exports);return output.exports;
}
test("ruta exige sesión, origen, chat y confirmación; 202 incierto y respuestas privadas",async()=>{
  let sends=0;const id=randomUUID(),context={params:Promise.resolve({id})},origin="https://finser.example";
  const service={templates:async()=>({templates:[],canSend:true}),sendTemplate:async()=>{sends++;return {message:{deliveryStatus:"uncertain"},uncertain:true};}};
  const store={getTemplateAccess:async()=>({canSend:true})},route=endpoint(service,store);
  const request=(body=intent(),host=origin)=>new Request(`${origin}/api/atencion/${id}/templates`,{method:"POST",headers:{origin:host,"content-type":"application/json"},body:JSON.stringify(body)});
  assert.equal((await route.POST(request(intent(),"https://evil.example"),context)).status,403);
  assert.equal((await route.POST(request(intent({confirmed:false})),context)).status,400);assert.equal(sends,0);
  const response=await route.POST(request(),context);assert.equal(response.status,202);assert.match(response.headers.get("cache-control"),/private, no-store/);
  assert.equal((await endpoint(service,store,new core.AttentionError("Sin sesión",401)).GET(new Request(origin),context)).status,401);
  assert.equal((await endpoint(service,{getTemplateAccess:async()=>{throw new core.AttentionError("Sin asignación",404);}}).POST(request(),context)).status,404);assert.equal(sends,1);
});
