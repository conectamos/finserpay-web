import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installWhatsAppAutomationMetaSchema } from "../scripts/whatsapp-automation-meta-schema.mjs";

const root=path.resolve(import.meta.dirname,"..");
const jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createWhatsAppAutomationMetaSender}=await jiti.import("../lib/whatsapp-automation-meta.ts");
const {createWhatsAppAutomationMetaStore}=await jiti.import("../lib/whatsapp-automation-meta-storage.ts");
const {isMetaAutomationConfigured,META_AUTOMATION_TEMPLATES}=await jiti.import("../lib/whatsapp-automation-meta-config.ts");
const {createAttentionMetaStore}=await jiti.import("../lib/atencion-meta-storage.ts");
const scope={phoneNumberId:"1162059967000416",wabaId:"2148284059050848"};
const instant="2026-10-30T20:00:00.000Z",phone="573001234567";
const input=(patch={})=>({operationKey:`bienvenida:credito:${randomUUID()}`,template:"bienvenida",phone,body:["Persona de prueba"],...patch});
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json"}});
function adapter(db){return {$queryRawUnsafe:async(sql,...params)=>(await db.query(sql,params)).rows,$transaction:fn=>db.transaction(tx=>fn(adapter(tx)))};}
async function fixture(t,options={}) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Sede"(id integer PRIMARY KEY);CREATE TABLE "Usuario"(id integer PRIMARY KEY);CREATE TABLE "Vendedor"(id integer PRIMARY KEY);CREATE TABLE "Credito"(id integer PRIMARY KEY);INSERT INTO "Usuario" VALUES(5);`);
  await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  const database=adapter(db);
  const client={query:async(sql,params)=>sql.includes("pg_advisory_lock(")?{rows:[]}:sql.startsWith("BEGIN;")?(await db.exec(sql)).at(-1):db.query(sql,params)};
  await installWhatsAppAutomationMetaSchema(client);
  let clock=Date.parse(instant),messages=0;
  const env={WHATSAPP_AUTOMATIONS_PROVIDER:"meta",WHATSAPP_ATTENTION_SEND_ENABLED:"true",WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED:"true",
    WHATSAPP_ATTENTION_PHONE_NUMBER_ID:scope.phoneNumberId,WHATSAPP_ATTENTION_BUSINESS_ACCOUNT_ID:scope.wabaId,
    WHATSAPP_ATTENTION_ACCESS_TOKEN:`fixture-${randomUUID()}`,WHATSAPP_GRAPH_API_VERSION:"v25.0",...options.env};
  const requests=[];
  const fetcher=async(url,init)=>{
    const u=new URL(url);requests.push({url:u,init});
    if(u.origin==="https://finserpay.com") {
      assert.equal(init.headers,undefined);assert.equal(init.redirect,"error");
      return new Response(Buffer.from([137,80,78,71,13,10,26,10]),{headers:{"Content-Type":"image/png"}});
    }
    assert.equal(u.origin,"https://graph.facebook.com");assert.match(u.pathname,/^\/v25\.0\//);
    assert.equal(init.redirect,"error");assert.equal(init.headers.Authorization,`Bearer ${env.WHATSAPP_ATTENTION_ACCESS_TOKEN}`);
    if(u.pathname.endsWith("/messages")) {
      messages++;const body=JSON.parse(init.body);if(options.send)return options.send(body);
      return reply({messaging_product:"whatsapp",contacts:[{wa_id:phone,input:phone}],messages:[{id:`wamid.mock-${body.biz_opaque_callback_data}`}]});
    }
    if(u.pathname.endsWith("/phone_numbers"))return reply({data:[{id:scope.phoneNumberId,display_phone_number:"+573124085562"}]});
    if(u.pathname.endsWith("/media"))return reply({id:"987654321987654"});
    if(u.pathname.endsWith("/message_templates")) {
      const name=u.searchParams.get("name"),rule=META_AUTOMATION_TEMPLATES[name];
      const row={id:"123456789012345",name,language:rule.language,status:"APPROVED",parameter_format:"POSITIONAL",
        components:[{type:"BODY",text:rule.parameters===0?"Mensaje aprobado":`Hola {{1}}${rule.parameters===2?", {{2}}":""}.`},...(rule.imageEnv?[{type:"HEADER",format:"IMAGE"}]:[])]};
      return reply({data:[options.template?options.template(row):row]});
    }
    return reply({id:scope.phoneNumberId,display_phone_number:options.wrongPhone?"+573000000000":"+573124085562"});
  };
  const senderOptions={database,env,fetcher,now:()=>clock,...options.sender};
  const send=createWhatsAppAutomationMetaSender(senderOptions),store=createWhatsAppAutomationMetaStore(database,{now:()=>new Date(clock)});
  const meta=createAttentionMetaStore(database,{scope,now:()=>new Date(clock)});
  const statuses=events=>meta.ingest({scope,messages:[],statuses:events,ignored:0});
  return {db,database,client,env,requests,send,store,meta,statuses,get messages(){return messages;},advance(ms){clock+=ms;}};
}

test("plantilla aprobada usa misma línea sin ventana24h, conserva chat/analista/cierre y actor sistema",async t=>{
  const f=await fixture(t),id=randomUUID();
  await f.db.query(`INSERT INTO "AttentionConversation"(id,"externalId",channel,phone,name,status,"closedAt","assigneeUserId","assigneeKey","assigneeName",mode,"daptaMessagesCursor") VALUES($1,'dapta-existing','whatsapp',$2,'Contacto','closed',$3,5,'analyst:5','Analista','human_requested','cursor-previo')`,[id,`+${phone}`,"2026-10-29T10:00:00Z"]);
  const sent=await f.send(input());assert.equal(sent.status,"accepted");assert.match(sent.providerMessageId,/^wamid\./);assert.equal(f.messages,1);
  const chat=(await f.db.query('SELECT * FROM "AttentionConversation"')).rows[0];
  assert.equal(chat.id,id);assert.equal(chat.status,"closed");assert.equal(chat.assigneeKey,"analyst:5");assert.equal(chat.externalId,"dapta-existing");
  assert.equal(chat.mode,"human_requested");assert.equal(chat.daptaMessagesCursor,"cursor-previo");assert.equal(chat.metaLastInboundAt,null);assert.equal(chat.metaManaged,true);
  const message=(await f.db.query('SELECT * FROM "AttentionMessage"')).rows[0];assert.equal(message.author,"Automatización FINSER PAY");assert.equal(message.text,"Hola Persona de prueba.");assert.equal(message.deliveryStatus,"accepted");
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "AttentionMetaOutbox"')).rows[0].n,0);
  assert.ok((await f.db.query('SELECT * FROM "AttentionAudit"')).rows.every(a=>a.actorKind==="system"&&a.actorKey==="SYSTEM_META"&&a.userId===null));
  const body=JSON.parse(f.requests.find(r=>r.url.pathname.endsWith("/messages")).init.body);
  assert.equal(body.biz_opaque_callback_data,sent.outboxId);assert.deepEqual(body.template,{name:"bienvenida",language:{code:"es"},components:[{type:"body",parameters:[{type:"text",text:"Persona de prueba"}]}]});
});

test("idempotencia concurrente y huella impiden segundo POST o cambiar destinatario/contenido",async t=>{
  const f=await fixture(t),intent=input();const results=await Promise.all([f.send(intent),f.send(intent)]);
  assert.equal(f.messages,1);assert.ok(results.some(r=>r.status==="accepted"));
  assert.equal((await f.send(intent)).status,"accepted");assert.equal(f.messages,1);
  assert.equal((await f.send({...intent,body:["Distinto"]})).code,"AUTOMATION_OPERATION_CONFLICT");assert.equal(f.messages,1);
  assert.equal((await f.db.query('SELECT count(*)::int n FROM "WhatsAppAutomationMetaOutbox"')).rows[0].n,1);
});

test("timeout queda incierto sin reintento; recibo firmado correlaciona solo outbox+scope+destinatario",async t=>{
  const f=await fixture(t,{send:()=>{throw new Error("transport secret must stay private");}}),intent=input();
  const sent=await f.send(intent);assert.equal(sent.status,"unknown");assert.equal(JSON.stringify(sent).includes("secret"),false);
  await f.send(intent);assert.equal(f.messages,1);
  const event={id:"wamid.delivered-late",recipient:phone,timestamp:instant,status:"delivered",errorCodes:[],requestId:sent.outboxId};
  assert.equal((await f.statuses([{...event,recipient:"573009999999"}])).statusesApplied,0);
  await assert.rejects(f.meta.ingest({scope:{...scope,wabaId:"different"},messages:[],statuses:[event],ignored:0}));
  assert.equal((await f.statuses([event])).statusesApplied,1);
  assert.equal((await f.send(intent)).status,"accepted");assert.equal(f.messages,1);
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox"')).rows[0].status,"delivered");
  assert.equal((await f.db.query('SELECT "deliveryStatus" FROM "AttentionMessage"')).rows[0].deliveryStatus,"delivered");
});

test("callback anterior a ACK prevalece ante fallo tardío y recibos fuera de orden no rebajan entrega",async t=>{
  let f;f=await fixture(t,{send:async body=>{
    await f.statuses([{id:"wamid.early",recipient:phone,timestamp:instant,status:"read",errorCodes:[],requestId:body.biz_opaque_callback_data}]);
    throw new Error("timeout after provider accepted");
  }});
  const sent=await f.send(input());assert.equal(sent.status,"accepted");assert.equal(sent.providerMessageId,"wamid.early");
  await f.statuses([{id:"wamid.early",recipient:phone,timestamp:"2026-10-30T19:00:00Z",status:"failed",errorCodes:[131026],requestId:sent.outboxId}]);
  assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox"')).rows[0].status,"read");
});

test("validación de catálogo/scope rechaza no aprobada, parámetros/cabecera alterados y no usa OTP",async t=>{
  for(const options of [{template:r=>({...r,status:"PAUSED"})},{template:r=>({...r,parameter_format:"NAMED"})},{template:r=>({...r,components:[{type:"BODY",text:"Hola {{2}}"}]})},{wrongPhone:true}]) {
    const f=await fixture(t,options);const sent=await f.send(input());assert.equal(sent.status,"failed");assert.equal(f.messages,0);
  }
  const f=await fixture(t,{env:{WHATSAPP_ATTENTION_ACCESS_TOKEN:"",WHATSAPP_ACCESS_TOKEN:"otp-do-not-use"}});
  assert.equal(isMetaAutomationConfigured(f.env),false);assert.equal((await f.send(input())).status,"failed");assert.equal(f.requests.length,0);
});

test("withSendGuard envuelve solo HTTP después de persistir sending y fallo previo no manda",async t=>{
  let f,inside=false;
  f=await fixture(t,{sender:{withSendGuard:async send=>{
    assert.equal((await f.db.query('SELECT status FROM "WhatsAppAutomationMetaOutbox"')).rows[0].status,"sending");
    inside=true;const ack=await send();inside=false;return ack;
  }},send:()=>{assert.equal(inside,true);return reply({messaging_product:"whatsapp",contacts:[{wa_id:phone,input:phone}],messages:[{id:"wamid.guarded"}]});}});
  assert.equal((await f.send(input())).status,"accepted");
  const rejected=await fixture(t,{sender:{withSendGuard:async()=>{throw new Error("Credit already paid");}}});
  assert.equal((await rejected.send(input())).status,"failed");assert.equal(rejected.messages,0);
});

test("revalidación justo antes dePOST conserva pausa/flags y no toca destino ni envía al vencer",async t=>{
  let f;f=await fixture(t,{sender:{beforeSend:async()=>{f.env.WHATSAPP_ATTENTION_AI_CUTOVER_CONFIRMED="false";}}});
  assert.equal((await f.send(input())).code,"META_AUTOMATION_DISABLED");assert.equal(f.messages,0);
  const expired=await fixture(t,{sender:{beforeSend:async()=>{expired.advance(20000);}}});
  assert.equal((await expired.send(input())).code,"AUTOMATION_DEADLINE");assert.equal(expired.messages,0);
});

test("HTTP rechazo Graph definitivo falla; respuesta ambigua queda UNKNOWN sin retry",async t=>{
  for(const [response,status] of [[reply({error:{code:131026,message:"private provider text"}},400),"failed"],[reply({error:{code:2}},500),"unknown"],[reply({messages:[]}),"unknown"]]) {
    const f=await fixture(t,{send:()=>response});const result=await f.send(input());assert.equal(result.status,status);assert.equal(JSON.stringify(result).includes("private provider"),false);
  }
});

test("recuperación de reserva vencida no reclama ni reenvía; callback de queued sinPOST se ignora",async t=>{
  const f=await fixture(t),intent=input();const reserved=await f.store.reserve(intent);
  const event={id:"wamid.spoofed-before-send",recipient:phone,timestamp:instant,status:"sent",errorCodes:[],requestId:reserved.row.id};
  assert.equal((await f.statuses([event])).statusesApplied,0);
  f.advance(121000);assert.equal((await f.store.reserve(intent)).row.status,"failed");assert.equal((await f.send(intent)).status,"failed");assert.equal(f.messages,0);
  const second=input();const leased=await f.store.reserve(second);await f.store.prepare(leased.row.id,leased.row.leaseToken,{text:"Validado",metadata:{}});await f.store.start(leased.row.id,leased.row.leaseToken);
  f.advance(121000);assert.equal((await f.store.reserve(second)).row.status,"uncertain");assert.equal((await f.send(second)).status,"unknown");assert.equal(f.messages,0);
});

test("migración aditiva idempotente verifica claves text[] y falla esquema preexistente incompatible",async t=>{
  const f=await fixture(t);await installWhatsAppAutomationMetaSchema(f.client);
  await f.db.exec('ALTER TABLE "WhatsAppAutomationMetaOutbox" DROP CONSTRAINT "WhatsAppAutomationMetaOutbox_operationKey_key"');
  await assert.rejects(installWhatsAppAutomationMetaSchema(f.client),/SCHEMA_KEYS/);
});

test("imágenes aprobadas se descargan sin credenciales, suben aMeta y conservan mediaId privado enCRM",async t=>{
  const f=await fixture(t,{env:{WHATSAPP_AUTOMATIONS_2DIAS_HEADER_IMAGE_URL:"https://finserpay.com/whatsapp/templates/2dias.png",
    WHATSAPP_AUTOMATIONS_CUOTAVENCIDA_HEADER_IMAGE_URL:"https://finserpay.com/whatsapp/templates/cuotavencida.png",WHATSAPP_AUTOMATIONS_BLOQUEO_HEADER_IMAGE_URL:"https://finserpay.com/whatsapp/templates/bloqueo.png"}});
  for(const template of ["2dias","cuotavencida","bloqueo"]) {
    assert.equal(isMetaAutomationConfigured(f.env,template),true);
    const sent=await f.send(input({template,body:template==="bloqueo"?[]:["Persona"]}));assert.equal(sent.status,"accepted");
    const posted=JSON.parse(f.requests.filter(r=>r.url.pathname.endsWith("/messages")).at(-1).init.body);
    assert.equal(posted.template.language.code,template==="cuotavencida"?"es_AR":"es");
    assert.deepEqual(posted.template.components[0],{type:"header",parameters:[{type:"image",image:{id:"987654321987654"}}]});
    assert.equal(posted.template.components.length,template==="bloqueo"?1:2);
  }
  const attachments=(await f.db.query('SELECT attachment FROM "AttentionMessage"')).rows.map(r=>r.attachment);
  assert.ok(attachments.every(a=>a.mediaId==="987654321987654"&&a.mimeType==="image/png"&&a.kind==="image"));
  const previous=f.requests.length;
  for(const url of ["http://finserpay.com/whatsapp/templates/2dias.png","https://localhost/image.png","https://finserpay.com/private.png","https://finserpay.com/whatsapp/templates/bloqueo.png","https://finserpay.com/whatsapp/templates/2dias.png?token=x","https://finserpay.com@127.0.0.1/whatsapp/templates/2dias.png"])
    assert.equal((await f.send(input({template:"2dias",headerImageUrl:url}))).code,"INVALID_TEMPLATE_IMAGE");
  assert.equal(f.requests.length,previous);
});
