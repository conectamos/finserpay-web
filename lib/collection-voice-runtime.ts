import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { getMoraManagement, createMoraManagement, listMoraPortfolio, parseMoraManagement } from "@/lib/analyst-mora-management";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { matchWelcomeVoiceIdentity } from "@/lib/credit-welcome-voice-core";
import { parseWelcomeVoiceSpokenDocument } from "@/lib/credit-welcome-voice-document";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { collectionCallKey } from "@/lib/dapta-collections-http";
import { collectionCallingAllowed, collectionSlot, colombiaClock, collectionSessionToken, verifyCollectionSessionToken, nextCollectionDate } from "@/lib/collection-voice-policy";

type Attempt={id:string;creditoId:number;debtorKey:string;phone:string;slot:string;status:string;providerCallId:string|null;identityAttempts:number;identityVerifiedAt:Date|null;createdAt:Date;managementId:string|null;followupFor:string|null;testCall:boolean;optOut:boolean;outcome:Record<string,unknown>|null};
const secret=()=>process.env.FINSERPAY_COBRANZA_API_TOKEN||"";
const agent=()=>process.env.FINSERPAY_COBRANZA_AGENT_ID||"";
const actor=()=>Number(process.env.FINSERPAY_COBRANZA_ACTOR_ID);
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"Cache-Control":"private, no-store"}});
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
let schema:Promise<void>|null=null;
export async function ensureCollectionVoiceSchema() {
  if(!schema) schema=(async()=>{
    await ensureAnalystMoraSchema();
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "CollectionVoiceAttempt" (
      "id" UUID PRIMARY KEY,"creditoId" INTEGER NOT NULL REFERENCES "Credito"("id"),"debtorKey" TEXT NOT NULL,
      "phone" TEXT NOT NULL,"slot" TEXT NOT NULL,"status" TEXT NOT NULL,"providerCallId" TEXT UNIQUE,
      "identityAttempts" INTEGER NOT NULL DEFAULT 0,"identityVerifiedAt" TIMESTAMPTZ,"contactedAt" TIMESTAMPTZ,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,"completedAt" TIMESTAMPTZ,
      "managementId" UUID,"optOut" BOOLEAN NOT NULL DEFAULT FALSE,"outcome" JSONB,"callbackHash" TEXT,
      "messageState" TEXT,"messageReceipt" TEXT, UNIQUE("debtorKey","slot"))`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CollectionVoiceAttempt_debtor_created" ON "CollectionVoiceAttempt"("debtorKey","createdAt")`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "CollectionVoiceAttempt" ADD COLUMN IF NOT EXISTS "followupFor" UUID`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "CollectionVoiceAttempt" ADD COLUMN IF NOT EXISTS "testCall" BOOLEAN NOT NULL DEFAULT FALSE`);
  })().catch(error=>{schema=null;throw error;});
  await schema;
}
function webhook(name:string) {
  const value=process.env[name]; if(!value) return null;
  try {const u=new URL(value);return u.protocol==="https:"&&u.hostname==="api.dapta.ai"&&!u.username&&!u.password?value:null;}catch{return null;}
}
function receipt(value:unknown):string|null {
  if(!value||typeof value!=="object") return null;
  const v=value as Record<string,unknown>;
  if(v.error||v.ok===false||v.success===false) return null;
  if(v.ok===true&&typeof v.call_id==="string"&&/^[\w.:-]{8,160}$/.test(v.call_id)) return v.call_id;
  return receipt(v.response??v.result??v.data);
}
async function invoke(url:string,body:unknown) {
  const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(20000),cache:"no-store"});
  if(!r.ok) throw new Error("Proveedor no confirmó la operación");
  const text=await r.text(); if(text.length>131072) throw new Error("Respuesta no válida");
  return JSON.parse(text) as Record<string,unknown>;
}
async function activeSession(body:Record<string,unknown>) {
  const id=verifyCollectionSessionToken(body.event_token,secret()); if(!id) throw new Error("Sesión no autorizada");
  const rows=await prisma.$queryRawUnsafe<Attempt[]>(`SELECT * FROM "CollectionVoiceAttempt" WHERE "id"=$1::uuid`,id);
  const a=rows[0];
  if(!a||a.optOut||+new Date(a.createdAt)<Date.now()-3600000||!["DISPATCHING","DIALING","ACCEPTED","UNKNOWN"].includes(a.status)) throw new Error("Sesión no vigente");
  return a;
}
async function financialContext(id:number,allowFollowup=false) {
  const data=await getMoraManagement(id), latest=data.history[0];
  const due=allowFollowup&&latest?.managementStatus==="ACUERDO_PAGO"&&latest.agreementDate&&latest.agreementDate<=colombiaClock(new Date()).day&&Date.parse(latest.nextFollowUpAt)<=Date.now();
  return {...data,followupFor:due?latest.id:null,suspended:!data.credit.enMora||(latest?.managementStatus==="ACUERDO_PAGO"&&!due)||latest?.resultCode==="PAGO_REALIZADO"||["SOLUCIONADO","CERRADO"].includes(latest?.managementStatus||"")};
}
async function saveManagement(a:Attempt,result:"ACUERDO_PAGO"|"PAGO_REALIZADO"|"MEDIOS_PAGO"|"SIN_RESPUESTA",body:Record<string,unknown>) {
  if(!Number.isSafeInteger(actor())||actor()<1||!agent()) throw new Error("Responsable sin configurar");
  const now=new Date();
  const agreement=result==="ACUERDO_PAGO";
  if(agreement&&(body.agreementConfirmed!=="true"||typeof body.agreementDate!=="string"||typeof body.agreementAmount!=="string")) throw new Error("Falta confirmación explícita del acuerdo");
  const date=agreement?body.agreementDate as string:undefined;
  const input=parseMoraManagement({action:"LLAMADA",actedAt:now.toISOString(),responsibleUserId:actor(),result,
    managementStatus:agreement?"ACUERDO_PAGO":result==="SIN_RESPUESTA"?"SIN_RESPUESTA":result==="PAGO_REALIZADO"?"SEGUIMIENTO":"CONTACTADO",
    comment:`[Dapta Valeria; sesión ${a.id}; llamada ${a.providerCallId||"en curso"}] ${String(body.comment||"Gestión de voz registrada.").slice(0,1200)}`,
    nextFollowUpAt:nextCollectionDate(now,date), idempotencyKey:collectionCallKey(agent(),a.id),
    ...(agreement?{agreementDate:date,agreementAmount:Number(body.agreementAmount)}:{})});
  const recorded=await createMoraManagement(a.creditoId,input,{id:actor(),nombre:"Agente IA",centralAdmin:false});
  await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "managementId"=$2::uuid WHERE "id"=$1::uuid`,a.id,recorded.item.id);
  return recorded;
}
export async function runCollectionVoice(options:{immediate?:boolean;dryRun?:boolean;limit?:number;test?:boolean}={}) {
  const now=new Date(), slot=collectionSlot(now,options.immediate);
  const url=webhook("DAPTA_COBRANZA_CALL_WEBHOOK_URL");
  const report={enabled:process.env.DAPTA_COBRANZA_ENABLED==="true",ready:process.env.DAPTA_COBRANZA_LIVE_READY==="true",inWindow:!!slot,eligible:0,accepted:0,unknown:0,skipped:0};
  if(!slot||secret().length<32||!agent()||!actor()) return report;
  if(!options.dryRun&&((!report.enabled&&!options.test)||!report.ready||!url)) return report;
  await ensureCollectionVoiceSchema();
  let count=0;
  for(let page=1;page<=100;page++) {
    const portfolio=await listMoraPortfolio(new URLSearchParams({page:String(page)}));
    for(const item of portfolio.items) {
      if(count>=(options.limit??3)) return report;
      const context=await financialContext(item.id,true); if(context.suspended){report.skipped++;continue;}
      const c=context.credit,doc=String(c.clienteDocumento||"").replace(/\D/g,"");
      if(options.test&&doc!==process.env.DAPTA_COBRANZA_TEST_DOCUMENT){continue;}
      if(!/^\d{5,15}$/.test(doc)){report.skipped++;continue;}
      const phones=(options.test?[process.env.DAPTA_COBRANZA_TEST_PHONE]:[c.clienteTelefono,...(process.env.DAPTA_COBRANZA_REFERENCES_OWNED==="true"?[c.referenciaFamiliar1Telefono,c.referenciaFamiliar2Telefono]:[])]).map(normalizeColombianMobile).filter((v):v is string=>!!v);
      const unique=[...new Set(phones)];if(!unique.length){report.skipped++;continue;}
      const debtorKey=digest(options.test?"test:"+doc+":"+unique[0]:doc),id=randomUUID();
      const claimed=await prisma.$transaction(async db=>{
        await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`,"collections:"+debtorKey);
        const prior=await db.$queryRawUnsafe<Array<{blocked:boolean;today:number;total:number}>>(`SELECT
          COALESCE(bool_or("optOut" OR "status" IN ('DISPATCHING','DIALING','ACCEPTED','UNKNOWN') OR "outcome"->>'pago_informado'='true' OR ("managementId" IS NULL AND "outcome"->>'acuerdo_confirmado'='true') OR ("contactedAt" AT TIME ZONE 'America/Bogota')::date=$2::date),FALSE) AS blocked,
          count(*) FILTER(WHERE ("createdAt" AT TIME ZONE 'America/Bogota')::date=$2::date)::int AS today,count(*)::int AS total
          FROM "CollectionVoiceAttempt" WHERE "debtorKey"=$1`,debtorKey,colombiaClock(now).day);
        const contacts=await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CreditMoraManagementEvent" m JOIN "Credito" c ON c."id"=m."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND m."actedAt">=date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
          AND ((m."action"='MSJ_TEXTO' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA') OR (m."action"='LLAMADA' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA' AND (m."actedAt" AT TIME ZONE 'America/Bogota')::date=$2::date))`,doc,colombiaClock(now).day);
        // Read the existing WhatsApp outboxes as well as manual portfolio records.
        const other=await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "Credito" c WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND (
          EXISTS(SELECT 1 FROM "CreditDueReminder" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','ACCEPTED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditOverdueDataAttempt" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','ACCEPTED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditWelcomeVoiceEvent" r WHERE r."creditoId"=c."id" AND (r."status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR (r."identityVerifiedAt" AT TIME ZONE 'America/Bogota')::date=$2::date)))`,doc,colombiaClock(now).day);
        const followed=context.followupFor?await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CollectionVoiceAttempt" WHERE "followupFor"=$1::uuid AND "contactedAt" IS NOT NULL`,context.followupFor):[];
        if(prior[0].blocked||prior[0].today>=3||(!options.test&&(contacts[0].n||other[0].n||followed[0]?.n))) return null;
        if(options.dryRun) return {phone:unique[prior[0].total%unique.length]};
        const phone=unique[prior[0].total%unique.length];
        const rows=await db.$queryRawUnsafe<Array<{id:string}>>(`INSERT INTO "CollectionVoiceAttempt"("id","creditoId","debtorKey","phone","slot","status","followupFor","testCall") VALUES($1::uuid,$2,$3,$4,$5,'DISPATCHING',$6::uuid,$7) ON CONFLICT("debtorKey","slot") DO NOTHING RETURNING "id"`,id,c.id,debtorKey,phone,slot,context.followupFor,options.test===true);
        return rows.length?{phone}:null;
      });
      if(!claimed){report.skipped++;continue;}
      count++;report.eligible++;
      if(options.dryRun) continue;
      // A fresh portfolio check immediately before the external request catches payments/agreements since selection.
      if((await financialContext(c.id,!!context.followupFor)).suspended||!collectionCallingAllowed(new Date())) {
        await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "status"='SKIPPED' WHERE "id"=$1::uuid`,id);report.skipped++;continue;
      }
      let callId:string|null=null;
      try{callId=receipt(await invoke(url!,{event_token:collectionSessionToken(id,secret()),credito_id:String(c.id),finser_agent_id:agent(),to_number:"+"+claimed.phone,customer_name:c.clienteNombre}));}catch{/* Unknown dispatch is held, never blindly retried. */}
      await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "status"=$2,"providerCallId"=COALESCE("providerCallId",$3) WHERE "id"=$1::uuid AND "status" IN ('DISPATCHING','DIALING')`,id,callId?"ACCEPTED":"UNKNOWN",callId);
      if(callId) report.accepted++;else report.unknown++;
    }
    if(!portfolio.hasMore) break;
  }
  return report;
}

export async function runCollectionMessages() {
  const url=webhook("DAPTA_COBRANZA_MESSAGE_WEBHOOK_URL");
  if(process.env.DAPTA_COBRANZA_LIVE_READY!=="true"||!url||!collectionCallingAllowed(new Date())) return;
  await ensureCollectionVoiceSchema();
  const rows=await prisma.$queryRawUnsafe<Attempt[]>(`UPDATE "CollectionVoiceAttempt" SET "messageState"='SENDING' WHERE "id" IN (SELECT "id" FROM "CollectionVoiceAttempt" WHERE "messageState"='PENDING' AND NOT "optOut" ORDER BY "createdAt" LIMIT 3 FOR UPDATE SKIP LOCKED) RETURNING *`);
  for(const a of rows) {
    let messageId:string|null=null;
    try {
      const context=await getMoraManagement(a.creditoId);
      const response=await invoke(url,{to_number:"+"+a.phone,nombre_cliente:context.credit.clienteNombre,
        template:a.outcome?.pago_informado===true?"soporte":"medios",event_id:a.id});
      let current:unknown=response;
      for(let depth=0;depth<4;depth++) {
        if(!current||typeof current!=="object")break;
        const v=current as Record<string,unknown>;
        if(v.error||v.ok===false||v.success===false)break;
        if(typeof v.message_id==="string"&&v.message_id){messageId=v.message_id;break;}
        current=v.response??v.result??v.data;
      }
    }catch{/* Unknown send is held for reconciliation rather than repeated. */}
    await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "messageState"=$2,"messageReceipt"=$3 WHERE "id"=$1::uuid`,a.id,messageId?"ACCEPTED":"UNKNOWN",messageId);
  }
}

async function operation(body:Record<string,unknown>) {
  if(body.action==="testcall") return runCollectionVoice({dryRun:body.dryRun!==false,immediate:true,limit:1,test:true});
  if(body.action==="dispatch") return runCollectionVoice({dryRun:body.dryRun!==false,immediate:body.immediate===true,limit:Math.min(5,Math.max(1,Number(body.limit)||3))});
  await ensureCollectionVoiceSchema();
  if(body.action==="authorize") {
    const a=await activeSession(body);
    const testAuthorized=a.testCall&&normalizeColombianMobile(process.env.DAPTA_COBRANZA_TEST_PHONE)===a.phone;
    if(a.status!=="DISPATCHING"||(!testAuthorized&&process.env.DAPTA_COBRANZA_ENABLED!=="true")||process.env.DAPTA_COBRANZA_LIVE_READY!=="true"||!collectionCallingAllowed(new Date())||(await financialContext(a.creditoId,!!a.followupFor)).suspended)
      return {ok:false,allowed:false};
    const claimed=await prisma.$queryRawUnsafe<Array<{id:string}>>(`UPDATE "CollectionVoiceAttempt" SET "status"='DIALING' WHERE "id"=$1::uuid AND "status"='DISPATCHING' RETURNING "id"`,a.id);
    if(!claimed.length) return {ok:false,allowed:false};
    return {ok:true,allowed:true,to_number:"+"+a.phone,credito_id:String(a.creditoId),finser_agent_id:agent()};
  }
  if(body.action==="identity") {
    const a=await activeSession(body);
    const counts=await prisma.$queryRawUnsafe<Array<{identityAttempts:number}>>(`UPDATE "CollectionVoiceAttempt" SET "identityAttempts"="identityAttempts"+1 WHERE "id"=$1::uuid AND "identityAttempts"<3 RETURNING "identityAttempts"`,a.id);
    if(!counts.length) return {ok:false,verified:false,review:true};
    const context=await financialContext(a.creditoId,!!a.followupFor);
    if(!matchWelcomeVoiceIdentity({name:context.credit.clienteNombre,document:context.credit.clienteDocumento},{name:body.name,document:parseWelcomeVoiceSpokenDocument(body.document)})) return {ok:true,verified:false,review:counts[0].identityAttempts>=3};
    await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "identityVerifiedAt"=CURRENT_TIMESTAMP,"contactedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,a.id);
    if(context.suspended) return {ok:true,verified:true,suspend:true};
    return {ok:true,verified:true,suspend:false,followup:!!a.followupFor,credito:{numero:context.credit.numeroCreditoVisible,valorVencido:context.credit.valorVencido,diasMora:context.credit.diasMora},bloqueoAplica:null,reporteHabilitado:null,trasladoPrejuridico:null,evaluacionJudicialDecidida:null};
  }
  if(body.action==="register") {
    const a=await activeSession(body); if(!a.identityVerifiedAt) throw new Error("Verifique la titularidad");
    if(a.managementId) return {ok:true,registrado:false,alreadyRegistered:true,review:true};
    if((await financialContext(a.creditoId,!!a.followupFor)).suspended) return {ok:true,registrado:false,suspend:true};
    if(!["ACUERDO_PAGO","PAGO_REALIZADO"].includes(String(body.result))) throw new Error("Resultado no admitido");
    if(a.testCall) return {ok:true,registrado:false,test:true,review:true,message:"Prueba autorizada: no se modifica la cartera real."};
    const saved=await saveManagement(a,body.result as "ACUERDO_PAGO"|"PAGO_REALIZADO"|"MEDIOS_PAGO",body);
    return {ok:true,registrado:true,item:saved.item};
  }
  if(body.action==="optout") {
    const a=await activeSession(body);
    await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "optOut"=TRUE,"contactedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,a.id);
    return {ok:true,registrado:true};
  }
  if(body.action==="postcall") {
    const call=body.call as Record<string,unknown>|undefined;
    if(!call||typeof call.call_id!=="string") throw new Error("Falta evento real de llamada");
    let vars=call.dynamic_variables??call.llm_dynamic_variables;
    if(typeof vars==="string") vars=JSON.parse(vars);
    const id=verifyCollectionSessionToken((vars as Record<string,unknown>|undefined)?.event_token,secret());if(!id) throw new Error("Evento no autorizado");
    const rows=await prisma.$queryRawUnsafe<Attempt[]>(`SELECT * FROM "CollectionVoiceAttempt" WHERE "id"=$1::uuid`,id);
    const a=rows[0];if(!a||(a.providerCallId&&a.providerCallId!==call.call_id)) throw new Error("Llamada no vinculada");
    const analysis=((call.call_analysis as Record<string,unknown>|undefined)?.custom_analysis_data||{}) as Record<string,unknown>;
    const noAnswer=["dial_no_answer","dial_busy","dial_failed","voicemail_reached"].includes(String(call.disconnection_reason));
    const hash=digest(JSON.stringify(call));
    const updated=await prisma.$queryRawUnsafe<Array<{id:string}>>(`UPDATE "CollectionVoiceAttempt" SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP,"providerCallId"=$2,"outcome"=$3::jsonb,"callbackHash"=$4,"optOut"="optOut" OR $5,"contactedAt"=CASE WHEN $6 THEN COALESCE("contactedAt",CURRENT_TIMESTAMP) ELSE "contactedAt" END WHERE "id"=$1::uuid AND "callbackHash" IS NULL RETURNING "id"`,id,call.call_id,JSON.stringify(analysis),hash,analysis.finalizar_solicitado===true,!noAnswer);
    if(!updated.length) {
      const prior=await prisma.$queryRawUnsafe<Array<{callbackHash:string}>>(`SELECT "callbackHash" FROM "CollectionVoiceAttempt" WHERE "id"=$1::uuid`,id);
      if(prior[0]?.callbackHash!==hash) throw new Error("Evento de cierre en conflicto");
      return {ok:true,processed:true,duplicate:true};
    }
    let registered=!!a.managementId;
    if(!a.testCall&&!a.managementId&&!a.optOut&&(noAnswer||(a.identityVerifiedAt&&analysis.resultado_gestion==="MEDIOS_PAGO"))) {
      try{
        await saveManagement(a,noAnswer?"SIN_RESPUESTA":"MEDIOS_PAGO",{comment:noAnswer?"El proveedor informó que no hubo respuesta.":String(analysis.observacion_gestion||"Se informaron medios de pago durante la llamada.")});
        registered=true;
      }catch{/* Retained in call ledger for review; never claim a portfolio record. */}
    }
    // A template is sent only if the caller requested that information. Its
    // receipt is tracked independently from the portfolio record.
    if(a.identityVerifiedAt&&analysis.whatsapp_solicitado===true&&!analysis.finalizar_solicitado) {
      await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "messageState"='PENDING' WHERE "id"=$1::uuid`,id);
    }
    return {ok:true,processed:true,registrado:registered};
  }
  throw new Error("Operación no admitida");
}
export async function collectionVoiceOperation(request:Request) {
  const configured=secret(),supplied=request.headers.get("authorization")||"";
  if(configured.length<32) return json({ok:false,error:"Integración sin configurar"},503);
  const expected=Buffer.from("Bearer "+configured),received=Buffer.from(supplied);
  if(expected.length!==received.length||!timingSafeEqual(expected,received)) return json({ok:false,error:"No autorizado"},401);
  if(!request.headers.get("content-type")?.startsWith("application/json")) return json({ok:false,error:"Use JSON"},415);
  try {
    const reader=request.body?.getReader();if(!reader) throw new Error("Solicitud vacía");
    let size=0;const chunks:Uint8Array[]=[];
    while(true){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536){await reader.cancel();return json({ok:false,error:"Solicitud extensa"},413);}chunks.push(p.value);}
    const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if(!body||typeof body!=="object"||Array.isArray(body)) throw new Error("Solicitud inválida");
    return json(await operation(body));
  } catch { return json({ok:false,error:"Operación no confirmada; requiere revisión"},409); }
}
