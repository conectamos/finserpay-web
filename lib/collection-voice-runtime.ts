import "server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import prisma from "@/lib/prisma";
import { getMoraManagement, createMoraManagement, createCreditManagement, listMoraPortfolio, parseMoraManagement } from "@/lib/analyst-mora-management";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { matchWelcomeVoiceIdentity } from "@/lib/credit-welcome-voice-core";
import { parseWelcomeVoiceSpokenDocument } from "@/lib/credit-welcome-voice-document";
import { normalizeColombianMobile } from "@/lib/dapta-welcome";
import { collectionCallKey } from "@/lib/dapta-collections-http";
import { collectionCallingAllowed, collectionSlot, colombiaClock, collectionSessionToken, verifyCollectionSessionToken, nextCollectionDate, collectionPortfolioEligibility } from "@/lib/collection-voice-policy";

type Attempt={id:string;creditoId:number;debtorKey:string;phone:string;slot:string;status:string;providerCallId:string|null;identityAttempts:number;identityVerifiedAt:Date|null;createdAt:Date;completedAt?:Date|null;contactedAt?:Date|null;managementId:string|null;followupFor:string|null;testCall:boolean;manualRequested?:boolean;optOut:boolean;outcome:Record<string,unknown>|null};
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
    await prisma.$executeRawUnsafe(`ALTER TABLE "CollectionVoiceAttempt" ADD COLUMN IF NOT EXISTS "manualRequested" BOOLEAN NOT NULL DEFAULT FALSE`);
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
  const data=await getMoraManagement(id);
  const now=new Date();
  const due=collectionPortfolioEligibility(data.credit.enMora,data.history,now,true);
  if(due.followupFor) {
    const completed=await prisma.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CollectionVoiceAttempt" WHERE "followupFor"=$1::uuid AND "contactedAt" IS NOT NULL AND NOT "testCall"`,due.followupFor);
    // A completed follow-up must not exclude a still-overdue credit forever.
    // It returns to ordinary selection, retaining daily contact/opt-out limits.
    if(completed[0]?.n) return {...data,...collectionPortfolioEligibility(data.credit.enMora,data.history,now,true,true)};
  }
  return {...data,...collectionPortfolioEligibility(data.credit.enMora,data.history,now,allowFollowup)};
}
async function saveManagement(a:Attempt,result:"ACUERDO_PAGO"|"PAGO_REALIZADO"|"MEDIOS_PAGO"|"SIN_RESPUESTA"|"LLAMADA_INCOMPLETA",body:Record<string,unknown>,occurredAt?:Date) {
  if(!Number.isSafeInteger(actor())||actor()<1||!agent()) throw new Error("Responsable sin configurar");
  const key=collectionCallKey(agent(),a.id);
  const existing=await prisma.$queryRawUnsafe<Array<{id:string}>>(`SELECT "id" FROM "CreditMoraManagementEvent" WHERE "idempotencyKey"=$1::uuid`,key);
  if(existing[0]) {
    await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "managementId"=$2::uuid WHERE "id"=$1::uuid`,a.id,existing[0].id);
    return {item:existing[0]};
  }
  const now=new Date();
  const agreement=result==="ACUERDO_PAGO";
  if(agreement&&(body.agreementConfirmed!=="true"||typeof body.agreementDate!=="string"||typeof body.agreementAmount!=="string")) throw new Error("Falta confirmación explícita del acuerdo");
  if(agreement&&!/^[1-9]\d{0,11}(?:\.\d{1,2})?$/.test(body.agreementAmount as string)) throw new Error("Valor del acuerdo ambiguo");
  const date=agreement?body.agreementDate as string:undefined;
  const input=parseMoraManagement({action:"LLAMADA",actedAt:(occurredAt||now).toISOString(),responsibleUserId:actor(),result,
    managementStatus:agreement?"ACUERDO_PAGO":result==="SIN_RESPUESTA"?"SIN_RESPUESTA":["PAGO_REALIZADO","LLAMADA_INCOMPLETA"].includes(result)?"SEGUIMIENTO":"CONTACTADO",
    comment:`[Dapta Valeria; sesión ${a.id}; llamada ${a.providerCallId||"en curso"}] ${String(body.comment||"Gestión de voz registrada.").slice(0,1200)}`,
    nextFollowUpAt:nextCollectionDate(now,date), idempotencyKey:collectionCallKey(agent(),a.id),
    ...(agreement?{agreementDate:date,agreementAmount:Number(body.agreementAmount)}:{})});
  const record = a.manualRequested ? createCreditManagement : createMoraManagement;
  const recorded=await record(a.creditoId,input,{id:actor(),nombre:"Agente IA",centralAdmin:false});
  await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "managementId"=$2::uuid WHERE "id"=$1::uuid`,a.id,recorded.item.id);
  return recorded;
}
export async function runCollectionVoice(options:{immediate?:boolean;dryRun?:boolean;limit?:number;test?:boolean;creditId?:number;requestId?:string;beforeDispatch?:()=>Promise<void>}={}) {
  const now=new Date(), window=collectionSlot(now,options.immediate);
  const slot=window&&options.test?window+":"+Math.floor(+now/60000):window;
  const url=webhook("DAPTA_COBRANZA_CALL_WEBHOOK_URL");
  const report={enabled:process.env.DAPTA_COBRANZA_ENABLED==="true",ready:process.env.DAPTA_COBRANZA_LIVE_READY==="true",inWindow:!!slot,eligible:0,accepted:0,unknown:0,skipped:0};
  if(!slot||secret().length<32||!agent()||!actor()) return report;
  if(!options.dryRun&&((!report.enabled&&!options.test)||!report.ready||!url)) return report;
  await ensureCollectionVoiceSchema();
  let count=0;
  for(let page=1;page<=100;page++) {
    const portfolio=options.creditId!==undefined?{items:[{id:options.creditId}],hasMore:false}:await listMoraPortfolio(new URLSearchParams({page:String(page)}));
    for(const item of portfolio.items) {
      // A nominal analyst's selected-credit action must never dispatch another account.
      if(options.creditId!==undefined&&item.id!==options.creditId) continue;
      if(count>=(options.limit??3)) return report;
      const context=await financialContext(item.id,true); if(context.suspended){report.skipped++;continue;}
      const c=context.credit,doc=String(c.clienteDocumento||"").replace(/\D/g,"");
      if(options.test&&doc!==process.env.DAPTA_COBRANZA_TEST_DOCUMENT){continue;}
      if(!/^\d{5,15}$/.test(doc)){report.skipped++;continue;}
      const phones=(options.test?[process.env.DAPTA_COBRANZA_TEST_PHONE]:[c.clienteTelefono,...(options.creditId===undefined&&process.env.DAPTA_COBRANZA_REFERENCES_OWNED==="true"?[c.referenciaFamiliar1Telefono,c.referenciaFamiliar2Telefono]:[])]).map(normalizeColombianMobile).filter((v):v is string=>!!v);
      const unique=[...new Set(phones)];if(!unique.length){report.skipped++;continue;}
      const debtorKey=digest(options.test?"test:"+doc+":"+unique[0]:doc),id=options.creditId!==undefined&&options.requestId?options.requestId:randomUUID();
      const claimed=await prisma.$transaction(async db=>{
        await db.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))::text`,"collections:"+debtorKey);
        const prior=await db.$queryRawUnsafe<Array<{blocked:boolean;today:number;total:number}>>(`SELECT
          COALESCE(bool_or("optOut" OR "status" IN ('DISPATCHING','DIALING','ACCEPTED','UNKNOWN') OR "outcome"->>'pago_informado'='true' OR ("managementId" IS NULL AND "outcome"->>'acuerdo_confirmado'='true') OR (NOT $3::boolean AND ("contactedAt" AT TIME ZONE 'America/Bogota')::date=$2::date)),FALSE) AS blocked,
          count(*) FILTER(WHERE ("createdAt" AT TIME ZONE 'America/Bogota')::date=$2::date)::int AS today,count(*)::int AS total
          FROM "CollectionVoiceAttempt" WHERE "debtorKey"=$1`,debtorKey,colombiaClock(now).day,options.test===true);
        const contacts=await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CreditMoraManagementEvent" m JOIN "Credito" c ON c."id"=m."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND m."actedAt">=date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
          AND ((m."action"='MSJ_TEXTO' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA') OR (m."action"='LLAMADA' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA' AND (m."actedAt" AT TIME ZONE 'America/Bogota')::date=$2::date))`,doc,colombiaClock(now).day);
        // Provider acceptance of a WhatsApp send does not establish human contact. Only unresolved sends retain a cross-campaign hold.
        const other=await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "Credito" c WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND (
          EXISTS(SELECT 1 FROM "CreditDueReminder" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditOverdueDataAttempt" r WHERE r."creditoId"=c."id" AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days') OR
          EXISTS(SELECT 1 FROM "CreditWelcomeVoiceEvent" r WHERE r."creditoId"=c."id" AND (r."status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR (r."identityVerifiedAt" AT TIME ZONE 'America/Bogota')::date=$2::date)))`,doc,colombiaClock(now).day);
        const followed=context.followupFor?await db.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CollectionVoiceAttempt" WHERE "followupFor"=$1::uuid AND "contactedAt" IS NOT NULL`,context.followupFor):[];
        if(prior[0].blocked||prior[0].today>=3||(!options.test&&(contacts[0].n||other[0].n||followed[0]?.n))) return null;
        if(options.dryRun) return {phone:unique[prior[0].total%unique.length]};
        const phone=unique[prior[0].total%unique.length];
        const rows=await db.$queryRawUnsafe<Array<{id:string}>>(`INSERT INTO "CollectionVoiceAttempt"("id","creditoId","debtorKey","phone","slot","status","followupFor","testCall","manualRequested") VALUES($1::uuid,$2,$3,$4,$5,'DISPATCHING',$6::uuid,$7,$8) ON CONFLICT("debtorKey","slot") DO NOTHING RETURNING "id"`,id,c.id,debtorKey,phone,slot,context.followupFor,options.test===true,options.creditId!==undefined);
        return rows.length?{phone}:null;
      });
      if(!claimed){report.skipped++;continue;}
      count++;report.eligible++;
      if(options.dryRun) continue;
      // A fresh portfolio check immediately before the external request catches payments/agreements since selection.
      if((await financialContext(c.id,!!context.followupFor)).suspended||!collectionCallingAllowed(new Date())) {
        await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "status"='SKIPPED' WHERE "id"=$1::uuid`,id);report.skipped++;continue;
      }
      try { await options.beforeDispatch?.(); }
      catch(error) {
        await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "status"='SKIPPED' WHERE "id"=$1::uuid AND "status"='DISPATCHING'`,id);
        throw error;
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

/** Read-only explanation of the same manual-dispatch gates. No calls or ledger writes. */
async function auditCollectionVoice() {
  const now=new Date(),day=colombiaClock(now).day,slot=collectionSlot(now,true);
  const items:Array<Record<string,unknown>>=[];
  for(let page=1;page<=100;page++) {
    const portfolio=await listMoraPortfolio(new URLSearchParams({page:String(page)}));
    for(const item of portfolio.items) {
      const context=await financialContext(item.id,true),c=context.credit;
      const reasons:Array<{code:string;detail:string}>=[];
      const reviews:string[]=[];
      const add=(code:string,detail:string)=>reasons.push({code,detail});
      if(!context.credit.enMora) add("SIN_MORA_ACTUAL","La consulta actual ya no tiene saldo en mora.");
      else if(context.suspended) {
        if(context.history[0]?.resultCode==="PAGO_REALIZADO") add("PAGO_INFORMADO","La última gestión informa pago pendiente de validación.");
        else {
          const a=context.history.find(h=>h.resultCode==="ACUERDO_PAGO"||h.managementStatus==="ACUERDO_PAGO");
          add("ACUERDO_PROTEGIDO",a?`Acuerdo ${a.agreementDate||"sin fecha válida"}; próxima gestión ${a.nextFollowUpAt}.`:"Expediente suspendido para revisión.");
        }
      }
      const doc=String(c.clienteDocumento||"").replace(/\D/g,"");
      if(!/^\d{5,15}$/.test(doc)) add("DOCUMENTO_INVALIDO","No hay documento válido para coordinar intentos por titular.");
      const phones=[c.clienteTelefono,...(process.env.DAPTA_COBRANZA_REFERENCES_OWNED==="true"?[c.referenciaFamiliar1Telefono,c.referenciaFamiliar2Telefono]:[])].map(normalizeColombianMobile).filter(Boolean);
      if(!phones.length) add("SIN_TELEFONO_VALIDO","No hay celular válido entre los teléfonos autorizados disponibles.");
      let attempts:Attempt[]=[];
      let contacts:Array<{id:string;creditoId:number;action:string;actedAt:Date;resultCode:string|null;comment:string}>=[];
      let other:Array<{source:string;status:string;at:Date}>=[];
      if(/^\d{5,15}$/.test(doc)) {
        attempts=await prisma.$queryRawUnsafe<Attempt[]>(`/* collection-audit-attempts */ SELECT * FROM "CollectionVoiceAttempt" WHERE "debtorKey"=$1 ORDER BY "createdAt" DESC`,digest(doc));
        contacts=await prisma.$queryRawUnsafe<typeof contacts>(`/* collection-audit-contacts */ SELECT m."id",m."creditoId",m."action",m."actedAt",m."resultCode",m."comment" FROM "CreditMoraManagementEvent" m JOIN "Credito" c ON c."id"=m."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND m."actedAt">=date_trunc('week',CURRENT_TIMESTAMP AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota'
          AND ((m."action"='MSJ_TEXTO' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA') OR (m."action"='LLAMADA' AND m."resultCode" IS DISTINCT FROM 'SIN_RESPUESTA' AND (m."actedAt" AT TIME ZONE 'America/Bogota')::date=$2::date)) ORDER BY m."actedAt" DESC`,doc,day);
        other=await prisma.$queryRawUnsafe<typeof other>(`/* collection-audit-other */ SELECT 'Recordatorio WhatsApp' AS source,r."status",r."claimedAt" AS at FROM "CreditDueReminder" r JOIN "Credito" c ON c."id"=r."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days'
          UNION ALL SELECT 'Campaña Datos WhatsApp',r."status",r."claimedAt" FROM "CreditOverdueDataAttempt" r JOIN "Credito" c ON c."id"=r."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND r."status" IN ('CLAIMED','UNKNOWN') AND r."claimedAt">=CURRENT_TIMESTAMP-interval '7 days'
          UNION ALL SELECT 'Bienvenida voz',r."status",r."createdAt" FROM "CreditWelcomeVoiceEvent" r JOIN "Credito" c ON c."id"=r."creditoId"
          WHERE regexp_replace(COALESCE(c."clienteDocumento",''),'[^0-9]','','g')=$1 AND (r."status" IN ('DISPATCHING','ACCEPTED','UNKNOWN') OR (r."identityVerifiedAt" AT TIME ZONE 'America/Bogota')::date=$2::date)`,doc,day);
        const today=attempts.filter(a=>colombiaClock(new Date(a.createdAt)).day===day);
        if(attempts.some(a=>a.optOut)) add("EXCLUSION_CONTACTO","Existe solicitud de finalizar/exclusión en el libro de llamadas.");
        for(const a of attempts.filter(a=>["DISPATCHING","DIALING","ACCEPTED","UNKNOWN"].includes(a.status))) add("LLAMADA_ACTIVA_O_INCIERTA",`${a.status}; llamada ${a.providerCallId||a.id}; creada ${new Date(a.createdAt).toISOString()}.`);
        if(attempts.some(a=>String(a.outcome?.pago_informado)==="true")) add("PAGO_INFORMADO_EN_LLAMADA","Un evento de llamada informa pago; el bloqueo no se libera automáticamente.");
        if(attempts.some(a=>!a.managementId&&String(a.outcome?.acuerdo_confirmado)==="true")) add("ACUERDO_SIN_REGISTRO","Hay confirmación de acuerdo sin gestión vinculada; requiere conciliación.");
        if(attempts.some(a=>a.contactedAt&&colombiaClock(new Date(a.contactedAt)).day===day)) add("CONTACTO_MARCADO_HOY","El libro de llamadas tiene contacto marcado hoy para este titular.");
        if(today.length>=3) add("LIMITE_TRES_INTENTOS",`${today.length} intentos acumulados hoy por titular.`);
        if(slot&&attempts.some(a=>a.slot===slot)) add("YA_INTENTADO_EN_ESTE_LOTE","Ya existe intento en la ventana manual actual; la clave única impide duplicarlo.");
        for(const m of contacts) add(m.action==="MSJ_TEXTO"?"GESTION_TEXTO_SEMANA":"GESTION_LLAMADA_HOY",`${m.action}; ${m.resultCode||"resultado histórico"}; crédito ${m.creditoId}; ${new Date(m.actedAt).toISOString()}.`);
        for(const o of other) add("OTRA_CAMPANA",`${o.source}; ${o.status}; ${new Date(o.at).toISOString()}.`);
        if(other.some(o=>o.status==="ACCEPTED")) reviews.push("Otra campaña aceptada bloquea el selector; aceptación no demuestra entrega, lectura ni contacto humano.");
        if(other.some(o=>o.status==="UNKNOWN")||attempts.some(a=>a.status==="UNKNOWN")) reviews.push("Existe un envío incierto: conciliar con el proveedor antes de repetir.");
        if(contacts.some(m=>m.resultCode==="LLAMADA_INCOMPLETA"&&/inactivity|invalid_destination/.test(m.comment))) reviews.push("Una llamada incompleta por inactividad/destino inválido está contando como contacto de hoy; revisar esa clasificación.");
        if(context.followupFor) {
          const done=await prisma.$queryRawUnsafe<Array<{n:number}>>(`SELECT count(*)::int n FROM "CollectionVoiceAttempt" WHERE "followupFor"=$1::uuid AND "contactedAt" IS NOT NULL`,context.followupFor);
          if(done[0]?.n) add("SEGUIMIENTO_YA_CONTACTADO","El vínculo del acuerdo ya tiene contacto en el libro de seguimiento.");
        }
      }
      if(!slot) add("FUERA_HORARIO","La ejecución manual está fuera del horario de contacto configurado.");
      if(process.env.DAPTA_COBRANZA_ENABLED!=="true"||process.env.DAPTA_COBRANZA_LIVE_READY!=="true") add("AUTOMATIZACION_NO_ACTIVA","La automatización no está habilitada y lista.");
      if(!agent()||!actor()||!webhook("DAPTA_COBRANZA_CALL_WEBHOOK_URL")) add("CONFIGURACION_INCOMPLETA","Falta agente, responsable o webhook válido para despachar.");
      items.push({creditoId:item.id,numero:c.numeroCreditoVisible,cliente:c.clienteNombre,diasMora:c.diasMora,valorVencido:c.valorVencido,estado:context.history[0]?.managementStatus||"PENDIENTE",followupFor:context.followupFor,eligible:reasons.length===0,reasons,reviews,attemptsToday:attempts.filter(a=>colombiaClock(new Date(a.createdAt)).day===day).map(a=>({id:a.id,callId:a.providerCallId,status:a.status,at:a.createdAt,registered:!!a.managementId})),otherCampaigns:other});
    }
    if(!portfolio.hasMore) break;
  }
  return {ok:true,readOnly:true,asOf:now.toISOString(),scope:"Estado actual de los controles; no reconstruye decisiones pasadas sin instantánea histórica.",total:items.length,items};
}

async function operation(body:Record<string,unknown>) {
  if(body.action==="testcall") return runCollectionVoice({dryRun:body.dryRun!==false,immediate:true,limit:1,test:true});
  if(body.action==="dispatch") return runCollectionVoice({dryRun:body.dryRun!==false,immediate:body.immediate===true,limit:Math.min(5,Math.max(1,Number(body.limit)||3))});
  await ensureCollectionVoiceSchema();
  if(body.action==="audit") return auditCollectionVoice();
  if(body.action==="authorize") {
    const a=await activeSession(body);
    const testAuthorized=a.testCall&&normalizeColombianMobile(process.env.DAPTA_COBRANZA_TEST_PHONE)===a.phone;
    const context=await financialContext(a.creditoId,!!a.followupFor);
    if(a.status!=="DISPATCHING"||(!testAuthorized&&process.env.DAPTA_COBRANZA_ENABLED!=="true")||process.env.DAPTA_COBRANZA_LIVE_READY!=="true"||!collectionCallingAllowed(new Date())||context.suspended||
      (a.manualRequested&&(context.credit.prorrogaActiva||normalizeColombianMobile(context.credit.clienteTelefono)!==a.phone)))
      return {ok:false,allowed:false};
    const claimed=await prisma.$queryRawUnsafe<Array<{id:string}>>(`UPDATE "CollectionVoiceAttempt" SET "status"='DIALING' WHERE "id"=$1::uuid AND "status"='DISPATCHING' RETURNING "id"`,a.id);
    if(!claimed.length) return {ok:false,allowed:false};
    return {ok:true,allowed:true,to_number:"+"+a.phone,credito_id:String(a.creditoId),finser_agent_id:agent(),customer_name:context.credit.clienteNombre};
  }
  if(body.action==="identity") {
    const a=await activeSession(body);
    const counts=await prisma.$queryRawUnsafe<Array<{identityAttempts:number}>>(`UPDATE "CollectionVoiceAttempt" SET "identityAttempts"="identityAttempts"+1 WHERE "id"=$1::uuid AND "identityAttempts"<3 RETURNING "identityAttempts"`,a.id);
    if(!counts.length) return {ok:false,verified:false,review:true};
    const context=await financialContext(a.creditoId,!!a.followupFor);
    const normalizedName=(v:unknown)=>typeof v==="string"?v.normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().replace(/\s+/g," ").toLowerCase():"";
    const c=context.credit;
    const authorizedPhones=[c.clienteTelefono,...(process.env.DAPTA_COBRANZA_REFERENCES_OWNED==="true"?[c.referenciaFamiliar1Telefono,c.referenciaFamiliar2Telefono]:[])].map(normalizeColombianMobile).filter(Boolean);
    const authorizedTest=a.testCall&&String(c.clienteDocumento).replace(/\D/g,"")===process.env.DAPTA_COBRANZA_TEST_DOCUMENT&&normalizeColombianMobile(process.env.DAPTA_COBRANZA_TEST_PHONE)===a.phone;
    // User-authorized brief confirmation is bound to this credit's full registered
    // name and its current titular numbers (or the explicitly isolated test).
    const namedConfirmation=body.holderConfirmed==="true"&&!!normalizedName(c.clienteNombre)&&normalizedName(body.name)===normalizedName(c.clienteNombre)&&(authorizedPhones.includes(a.phone)||authorizedTest);
    const originalVerification=matchWelcomeVoiceIdentity({name:c.clienteNombre,document:c.clienteDocumento},{name:body.name,document:parseWelcomeVoiceSpokenDocument(body.document)});
    if(!namedConfirmation&&!originalVerification) return {ok:true,verified:false,review:counts[0].identityAttempts>=3};
    await prisma.$executeRawUnsafe(`UPDATE "CollectionVoiceAttempt" SET "identityVerifiedAt"=CURRENT_TIMESTAMP,"contactedAt"=CURRENT_TIMESTAMP WHERE "id"=$1::uuid`,a.id);
    if(context.suspended||(a.manualRequested&&context.credit.prorrogaActiva)) return {ok:true,verified:true,suspend:true};
    return {ok:true,verified:true,suspend:false,followup:!!a.followupFor,credito:{numero:context.credit.numeroCreditoVisible,valorVencido:context.credit.valorVencido,diasMora:context.credit.diasMora,valorUnaCuotaVencida:context.credit.valorUnaCuotaVencida},bloqueoAplica:null,reporteHabilitado:null,trasladoPrejuridico:null,evaluacionJudicialDecidida:null};
  }
  if(body.action==="register") {
    const a=await activeSession(body); if(!a.identityVerifiedAt) throw new Error("Verifique la titularidad");
    if(a.managementId) return {ok:true,registrado:false,alreadyRegistered:true,review:true};
    const context=await financialContext(a.creditoId,!!a.followupFor);
    // Preserve an explicit, verified payment report from a call already under
    // way after a payment is posted; this records history, never another charge.
    const completedPaymentReport=a.manualRequested&&!context.credit.enMora&&body.result==="PAGO_REALIZADO";
    if((context.suspended||(a.manualRequested&&context.credit.prorrogaActiva))&&!completedPaymentReport) return {ok:true,registrado:false,suspend:true};
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
    const noAnswer=["dial_no_answer","dial_busy","dial_failed","voicemail_reached","invalid_destination"].includes(String(call.disconnection_reason));
    const hash=digest(JSON.stringify(call));
    const updated=await prisma.$queryRawUnsafe<Array<{id:string}>>(`UPDATE "CollectionVoiceAttempt" SET "status"='COMPLETED',"completedAt"=CURRENT_TIMESTAMP,"providerCallId"=$2,"outcome"=$3::jsonb,"callbackHash"=$4,"optOut"="optOut" OR $5,"contactedAt"=CASE WHEN $6 THEN COALESCE("contactedAt",CURRENT_TIMESTAMP) ELSE "contactedAt" END WHERE "id"=$1::uuid AND "callbackHash" IS NULL RETURNING "id"`,id,call.call_id,JSON.stringify(analysis),hash,analysis.finalizar_solicitado===true,!noAnswer);
    if(!updated.length) {
      const prior=await prisma.$queryRawUnsafe<Array<{callbackHash:string}>>(`SELECT "callbackHash" FROM "CollectionVoiceAttempt" WHERE "id"=$1::uuid`,id);
      if(prior[0]?.callbackHash!==hash) throw new Error("Evento de cierre en conflicto");
      if(a.managementId||a.testCall) return {ok:true,processed:true,duplicate:true};
      // Retry only the missing portfolio record from the identical authenticated
      // closure. The call and message queue are not replayed.
    }
    let registered=!!a.managementId;
    if(!a.testCall&&!a.managementId) {
      try{
        const result=noAnswer?"SIN_RESPUESTA":a.identityVerifiedAt&&analysis.resultado_gestion==="MEDIOS_PAGO"?"MEDIOS_PAGO":"LLAMADA_INCOMPLETA";
        const reason=String(call.disconnection_reason||"sin motivo informado");
        // A closure is an auditable attempt, even without verification or an
        // agreement. Never infer a payment/commitment from post-call extraction.
        // Do not replace a newer agreement or payment with a closure record.
        const context=await financialContext(a.creditoId,!!a.followupFor);
        const closureTime=a.completedAt?new Date(a.completedAt):new Date();
        const newer=context.history[0]&&Date.parse(context.history[0].actedAt)>+closureTime;
        if((!context.suspended||(a.manualRequested&&!context.credit.enMora))&&!newer) {
          await saveManagement(a,result,{comment:`Cierre del proveedor: ${reason}. ${String(analysis.observacion_gestion||"No se obtuvo un resultado de cobro confirmado.").slice(0,1000)}`},closureTime);
          registered=true;
        }
      }catch{/* Retained in call ledger for review; never claim a portfolio record. */}
    }
    // A template is sent only if the caller requested that information. Its
    // receipt is tracked independently from the portfolio record.
      if(updated.length&&a.identityVerifiedAt&&analysis.whatsapp_solicitado===true&&!analysis.finalizar_solicitado) {
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
