import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { PGlite } from "@electric-sql/pglite";
import { installCreditDueReminderSchema } from "../scripts/credit-due-reminders-schema.mjs";
import { installCreditOverdueDataSchema } from "../scripts/credit-overdue-data-schema.mjs";
import { installMoraExceptionRequestSchema } from "../scripts/mora-exception-requests-schema.mjs";
import { installAnalystMoraSchema } from "../scripts/analyst-mora-schema.mjs";

const root=path.resolve(import.meta.dirname,".."),jiti=createJiti(import.meta.url,{alias:{"@":root,"server-only":path.join(root,"node_modules/next/dist/compiled/server-only/empty.js")}});
const {createAttentionCollectionTemplateStore}=await jiti.import("../lib/atencion-collection-template-storage.ts");
const policy=await jiti.import("../lib/atencion-collection-template-policy.ts");
const actor={userId:5,sellerId:null,key:"analyst:5",name:"Untrusted display",central:false,admin:false,analyst:true,supervisor:false,aliadoId:1,sedeId:10};
const central={...actor,userId:1,key:"admin:1",central:true,admin:true,analyst:false};
const phone="+573001234567";
async function fixture(t,instant="2026-10-01T17:00:00Z"){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`CREATE TABLE "Rol"(id int PRIMARY KEY,nombre text);CREATE TABLE "Aliado"(id int PRIMARY KEY,codigo text,activo boolean);
    CREATE TABLE "Sede"(id int PRIMARY KEY,nombre text,"aliadoId" int,activa boolean);CREATE TABLE "Usuario"(id int PRIMARY KEY,nombre text,activo boolean,"sedeId" int,"rolId" int);
    CREATE TABLE "Vendedor"(id int PRIMARY KEY);
    CREATE TABLE "Credito"(id int PRIMARY KEY,folio text,"clienteNombre" text,"clienteDocumento" text,"clienteTipoDocumento" text DEFAULT 'CC',"clienteTelefono" text,
      estado text DEFAULT 'ACTIVO',"montoCredito" float DEFAULT 400,"valorCuota" float DEFAULT 100,"plazoMeses" int DEFAULT 4,"frecuenciaPago" text DEFAULT 'QUINCENAL',
      "fechaPrimerPago" timestamp DEFAULT '2026-10-02 12:00:00',"fechaProximoPago" timestamp,"pazYSalvoEmitidoAt" timestamp,"planCapitalVigente" jsonb);
    CREATE TABLE "CreditoAbono"(id int PRIMARY KEY,"creditoId" int,valor float,"fechaAbono" timestamp,"createdAt" timestamp DEFAULT '2026-10-01 12:00:00',"metodoPago" text DEFAULT 'EFECTIVO',observacion text,estado text DEFAULT 'ACTIVO',"anuladoAt" timestamp);
    CREATE TABLE "ExcepcionBloqueoMora"(documento text,activa boolean,"fechaFin" timestamp);
    CREATE TABLE "CollectionVoiceAttempt"(id uuid,"debtorKey" text,"optOut" boolean,status text,"contactedAt" timestamptz,outcome jsonb,"managementId" uuid);
    CREATE TABLE "CreditWelcomeVoiceEvent"(id uuid,"creditoId" int,status text,"identityVerifiedAt" timestamptz);
    INSERT INTO "Rol" VALUES(1,'ADMIN'),(3,'ANALISTA_APROBACION');INSERT INTO "Aliado" VALUES(1,'FINSERPAY',true);INSERT INTO "Sede" VALUES(10,'Central',1,true);
    INSERT INTO "Usuario" VALUES(1,'Administrador real',true,10,1),(5,'Analista real',true,10,3),(6,'Otro analista',true,10,3);
    INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(77,'FC-77','Cliente sintético','100000077','3001234567');`);
  await db.exec(readFileSync(path.join(root,"scripts/setup-atencion.sql"),"utf8"));
  const client={query:(sql,args=[])=>db.query(sql,args)};
  for(const install of [installMoraExceptionRequestSchema,installAnalystMoraSchema,installCreditDueReminderSchema,installCreditOverdueDataSchema])await install(client);
  let clock=new Date(instant),depth=0;
  const wrap=connection=>({$queryRawUnsafe:async(sql,...args)=>(await connection.query(sql,args)).rows,$transaction:run=>connection.transaction(async tx=>{depth++;try{return await run(wrap(tx));}finally{depth--;}})});
  const id=randomUUID();await db.query(`INSERT INTO "AttentionConversation"(id,phone,name,channel,"assigneeUserId","assigneeKey") VALUES($1,$2,'Contacto','whatsapp',5,'analyst:5')`,[id,phone]);
  const store=createAttentionCollectionTemplateStore(wrap(db),{now:()=>clock});
  const option=async(name="1_dia_falta",creditId=77,who=actor)=>(await store.list(who,id)).credits.find(c=>c.id===creditId)?.options.find(o=>o.templateName===name);
  async function prepare(name="1_dia_falta",creditId=77){
    const selected=await option(name,creditId);assert.equal(selected?.eligible,true,selected?.reason);const review=selected.review;
    const requestId=randomUUID(),version=(await db.query('SELECT version FROM "AttentionConversation" WHERE id=$1',[id])).rows[0].version;
    const snapshot={financial:{creditId,templateName:name,reviewHash:review.reviewHash},parameters:review.parameters};
    await db.query(`INSERT INTO "AttentionMetaOutbox"(id,"conversationId","userId","actorKey","authorName","requestId",fingerprint,"conversationVersion","phoneNumberId","wabaId","contactId",text,template)
      VALUES($1,$2,5,'analyst:5','Analista real',$3,$4,$5,'1162059967000416','2148284059050848',$6,'Plantilla',$7)`,[requestId,id,randomUUID(),"a".repeat(64),version,phone.slice(1),JSON.stringify(snapshot)]);
    return {review,input:{requestId,version,creditId,templateName:name,reviewHash:review.reviewHash}};
  }
  const reserve=async(name="1_dia_falta",creditId=77)=>{const prepared=await prepare(name,creditId);return {...prepared,reservation:await store.claim(actor,id,prepared.input)};};
  const pay=(amount=25)=>db.query(`INSERT INTO "CreditoAbono"(id,"creditoId",valor,"fechaAbono") VALUES(1,77,$1,'2026-10-01 12:00:00')`,[amount]);
  return {db,store,id,option,prepare,reserve,pay,setNow:value=>{clock=new Date(value);},inTransaction:()=>depth>0};
}

test("política reusa fechas de cuota, alias hoyvence y parámetros registrados; no habilita promesas de bloqueo",()=>{
  assert.equal(policy.isAttentionCollectionTemplate("cuotavencida"),false);assert.equal(policy.isAttentionCollectionTemplate("vencido"),false);
  assert.equal(policy.attentionCollectionReminderKey("fechap"),policy.attentionCollectionReminderKey("hoyvence"));
  const credit={id:77,clienteNombre:"Cliente",clienteTelefono:"3001234567",estado:"ACTIVO",montoCredito:400,valorCuota:100,plazoMeses:4,frecuenciaPago:"QUINCENAL",fechaPrimerPago:"2026-10-02T12:00:00Z",abonos:[]};
  const at=(templateName,date)=>policy.attentionCollectionReview(credit,{templateName,phone,creditNumber:"FC-77",now:new Date(date),coveredCredits:[{id:77,number:"FC-77"}],financialSnapshot:credit});
  assert.equal(at("2dias","2026-09-30T17:00:00Z").eligible,true);assert.equal(at("1_dia_falta","2026-10-01T17:00:00Z").eligible,true);
  assert.deepEqual(at("fechap","2026-10-02T17:00:00Z").review.parameters,{"body:1":"Cliente","body:2":"02/10/2026"});
  assert.equal(at("hoyvence","2026-10-01T17:00:00Z").eligible,false);assert.equal(at("hoyvence","2026-10-02T04:59:00Z").eligible,false);
  assert.equal(at("data","2026-10-22T17:00:00Z").eligible,true);assert.equal(at("data","2026-10-23T17:00:00Z").eligible,false);
});

test("alcance nominal, identidad ambigua y ausencia de controles fallan cerrados sin DDL",async t=>{
  const f=await fixture(t);assert.equal((await f.option()).eligible,true);
  await assert.rejects(f.store.list({...actor,userId:6,key:"analyst:6"},f.id),{status:404});assert.equal((await f.option("1_dia_falta",77,central)).eligible,true);
  await f.db.exec('UPDATE "Usuario" SET activo=false WHERE id=5');await assert.rejects(f.store.list(actor,f.id),{status:403});await f.db.exec('UPDATE "Usuario" SET activo=true WHERE id=5');
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(78,'FC-78','Otra identidad','100000078','3001234567')`);
  assert.equal((await f.store.list(actor,f.id)).credits.length,0);
  await f.db.query('UPDATE "AttentionConversation" SET "linkedCreditId"=77 WHERE id=$1',[f.id]);f.setNow("2026-10-22T17:00:00Z");
  assert.match((await f.option("data")).reason,/distintas identidades/);
  await f.db.exec('ALTER TABLE "CollectionVoiceAttempt" DROP COLUMN "optOut"');await assert.rejects(f.store.list(actor,f.id),{status:503});
});

test("reserva nominal usa ledger cron, persiste autor real, y alias fecha no duplica hoyvence",async t=>{
  const f=await fixture(t,"2026-10-02T17:00:00Z"),r=await f.reserve("fechap");
  assert.equal((await f.store.claim(actor,f.id,r.input)).claimId,r.reservation.claimId);
  const ledger=(await f.db.query('SELECT * FROM "CreditDueReminder"')).rows[0];assert.equal(ledger.templateKey,"recordatorio_hoyvence_cuota");
  assert.equal((await f.option("hoyvence")).eligible,false);
  let sends=0;await f.store.withSendGuard(actor,f.id,r.reservation,async()=>{assert.equal(f.inTransaction(),true);sends++;return "ACK";});
  await f.store.finish(r.reservation,{status:"ACCEPTED",providerReference:"wamid.test",started:true});
  await f.store.finish(r.reservation,{status:"ACCEPTED",providerReference:"wamid.test",started:true});
  assert.equal(sends,1);assert.equal((await f.db.query('SELECT status FROM "CreditDueReminder"')).rows[0].status,"ACCEPTED");
  const history=(await f.db.query('SELECT * FROM "CreditCollectionCommunicationEvent" ORDER BY stage')).rows;
  assert.equal(history.length,2);assert.ok(history.every(row=>row.actorName==="Analista real"));
  await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,async()=>sends++),{status:409});assert.equal(sends,1);
  await assert.rejects(f.db.exec('DELETE FROM "CreditCollectionCommunicationEvent"'),/inmutable/);
});

test("pago posterior a revisión o previo al POST impide enviar y libera sólo reserva conocida sin envío",async t=>{
  const f=await fixture(t),prepared=await f.prepare();await f.pay(25);
  await assert.rejects(f.store.claim(actor,f.id,prepared.input),{status:409});assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditDueReminder"')).rows[0].n,0);
  const r=await f.reserve();await f.db.exec('UPDATE "CreditoAbono" SET valor=50 WHERE id=1');let sends=0;
  await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,async()=>sends++),{status:409});assert.equal(sends,0);
  await f.store.finish(r.reservation,{status:"FAILED",started:false});assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditDueReminder"')).rows[0].n,0);
  assert.equal((await f.option()).eligible,true);assert.equal((await f.db.query(`SELECT stage FROM "CreditCollectionCommunicationEvent" WHERE stage='SKIPPED'`)).rows.length,1);
});

test("prórroga, cambio de teléfono, reasignación y revocación inmediatamente antes del POST no envían",async t=>{
  const f=await fixture(t),r=await f.reserve();let sends=0;const send=async()=>sends++;
  const extensionId=randomUUID();await f.db.query(`INSERT INTO "CreditMoraExceptionRequest"(id,"creditoId",type,status,source,"expiresOn",reason,observation,"createdByUserId","createdByName","decidedByUserId","decidedByName","decidedAt","createIdempotencyKey","createRequestHash")
    VALUES($1,77,'PRORROGA','APPROVED','CENTRAL_DIRECT','2099-12-31','Prueba sintética','Prueba sintética',5,'Analista real',5,'Analista real','2026-10-01T17:00:00Z',$2,$3)`,[extensionId,randomUUID(),"a".repeat(64)]);
  await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,send),{status:409});await f.db.query(`UPDATE "CreditMoraExceptionRequest" SET status='CANCELLED' WHERE id=$1`,[extensionId]);
  await f.db.exec(`INSERT INTO "ExcepcionBloqueoMora" VALUES('100000077',true,'2099-12-31')`);
  await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,send),{status:409});await f.db.exec('DELETE FROM "ExcepcionBloqueoMora"');
  await f.db.exec(`UPDATE "Credito" SET "clienteTelefono"='3009999999' WHERE id=77`);await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,send),{status:409});await f.db.exec(`UPDATE "Credito" SET "clienteTelefono"='3001234567' WHERE id=77`);
  await f.db.query(`UPDATE "AttentionConversation" SET "assigneeUserId"=6,"assigneeKey"='analyst:6' WHERE id=$1`,[f.id]);await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,send),{status:404});
  await f.db.query(`UPDATE "AttentionConversation" SET "assigneeUserId"=5,"assigneeKey"='analyst:5' WHERE id=$1`,[f.id]);await f.db.exec('UPDATE "Usuario" SET activo=false WHERE id=5');await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,send),{status:403});
  assert.equal(sends,0);
});

test("optout, acuerdos y reservas cron existentes bloquean nuevos contactos; desconocido nunca libera ledger",async t=>{
  const f=await fixture(t),key=createHash("sha256").update("100000077").digest("hex");
  await f.db.query(`INSERT INTO "CollectionVoiceAttempt"(id,"debtorKey","optOut",status) VALUES($1,$2,true,'FAILED')`,[randomUUID(),key]);assert.equal((await f.option()).eligible,false);
  await f.db.exec('DELETE FROM "CollectionVoiceAttempt"');
  const r=await f.reserve();await f.store.withSendGuard(actor,f.id,r.reservation,async()=>"POST started");
  await f.store.finish(r.reservation,{status:"UNKNOWN",started:true});await f.store.finish(r.reservation,{status:"FAILED",started:false});
  assert.equal((await f.db.query('SELECT status FROM "CreditDueReminder"')).rows[0].status,"UNKNOWN");assert.equal((await f.option()).eligible,false);
  assert.equal((await f.db.query(`SELECT count(*)::int n FROM "CreditCollectionCommunicationEvent" WHERE stage='SKIPPED'`)).rows[0].n,0);
});

test("gestión de contacto posterior a la reserva y cambio de día impiden POST sin alterar historia",async t=>{
  const f=await fixture(t),r=await f.reserve();let sends=0;
  f.setNow("2026-10-02T17:00:00Z");await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,async()=>sends++),{status:409});f.setNow("2026-10-01T17:00:00Z");
  await f.db.query(`INSERT INTO "CreditMoraManagementEvent"(id,"creditoId",action,"actedAt","responsibleUserId","responsibleName",result,comment,"nextFollowUpAt","managementStatus","actorUserId","actorName","idempotencyKey","requestHash","resultCode")
    VALUES($1,77,'MSJ_TEXTO','2026-10-01T16:00:00Z',5,'Analista real','Contacto confirmado','Comentario de prueba','2026-10-02T13:00:00Z','CONTACTADO',5,'Analista real',$2,$3,'RECORDATORIO_PAGO')`,[randomUUID(),randomUUID(),"a".repeat(64)]);
  await assert.rejects(f.store.withSendGuard(actor,f.id,r.reservation,async()=>sends++),{status:409});assert.equal(sends,0);
  assert.match((await f.option()).reason,/contacto, acuerdo/);
});

test("Datos comparte cobertura del cron, revisa todos los créditos del titular y detecta cambios de cohorte",async t=>{
  const f=await fixture(t,"2026-10-22T17:00:00Z");
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(78,'FC-78','Cliente sintético','100000077','3001234567')`);
  const prepared=await f.prepare("data");assert.deepEqual(prepared.review.coveredCredits.map(c=>c.id),[77,78]);
  const reservation=await f.store.claim(actor,f.id,prepared.input);
  assert.deepEqual((await f.db.query('SELECT "creditoId" FROM "CreditOverdueDataCoverage" ORDER BY "creditoId"')).rows.map(r=>r.creditoId),[77,78]);
  assert.equal((await f.option("data",78)).eligible,false);
  await f.db.exec(`INSERT INTO "Credito"(id,folio,"clienteNombre","clienteDocumento","clienteTelefono") VALUES(79,'FC-79','Cliente sintético','100000077','3001234567')`);
  let sends=0;await assert.rejects(f.store.withSendGuard(actor,f.id,reservation,async()=>sends++),{status:409});assert.equal(sends,0);
  await f.store.finish(reservation,{status:"FAILED",started:false});assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditOverdueDataCoverage"')).rows[0].n,0);
  const current=await f.reserve("data");assert.deepEqual(current.review.coveredCredits.map(c=>c.id),[77,78,79]);
  await f.store.withSendGuard(actor,f.id,current.reservation,async()=>{assert.equal(f.inTransaction(),true);sends++;});await f.store.finish(current.reservation,{status:"ACCEPTED",started:true});
  assert.equal(sends,1);assert.equal((await f.db.query('SELECT count(*)::int n FROM "CreditOverdueDataCoverage"')).rows[0].n,3);
});
