import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionUuid } from "./atencion-core";
import { assertAttentionCurrentActor, type AttentionDatabase, type AttentionDb } from "./atencion-storage";
import type { AttentionActor } from "./atencion-types";

export type AttentionBulkClosePreview = {
  reviewToken: string; cutoff: string; expiresAt: string;
  totalCount: number; openCount: number; closeCount: number; unreadCount: number; skippedCount: number;
};
export type AttentionBulkCloseInput = { reviewToken: string; requestId: string; confirmed: true };
export type AttentionBulkCloseResult = { cutoff: string; closedCount: number; readCount: number; skippedCount: number };
type Observation = { id: string; version: number; status: string; canClose: boolean; inboundHash: string; unreadIds: string[] };
type Review = AttentionBulkClosePreview & { observations: Observation[] };
type Chat = { id: string; version: number; status: string; lastContactAt: Date|string|null };
const reviewTtl = 10 * 60_000, maxLookback = 24 * 60 * 60_000;
const transactionOptions = { isolationLevel: "ReadCommitted" as const, timeout: 30_000, maxWait: 10_000 };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (value: Date|string) => new Date(value).toISOString();
function central(actor: AttentionActor) {
  assertAttentionActor(actor);
  if (!actor.central) throw new AttentionError("Solo administración central puede finalizar conversaciones en conjunto.",403);
}
export function parseAttentionBulkCloseInput(body: Record<string,unknown>): AttentionBulkCloseInput {
  if (Object.keys(body).some(key=>!["reviewToken","requestId","confirmed"].includes(key)) || body.confirmed!==true)
    throw new AttentionError("Revisa y confirma el cierre de las conversaciones.");
  return {reviewToken:attentionUuid(body.reviewToken),requestId:attentionUuid(body.requestId),confirmed:true};
}
export function parseAttentionBulkCloseCutoff(params: URLSearchParams, now = new Date()): string {
  if ([...params.keys()].some(key=>key!=="cutoff") || params.getAll("cutoff").length>1)throw new AttentionError("El corte del cierre no es válido.");
  const value=params.get("cutoff")??now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))throw new AttentionError("Selecciona una fecha y hora de corte válida.");
  const elapsed=now.getTime()-Date.parse(value);
  if(elapsed<0 || elapsed>maxLookback)throw new AttentionError("El corte debe estar dentro de las últimas 24 horas y no puede estar en el futuro.");
  return iso(value);
}
async function schema(db: AttentionDb) {
  const required={AttentionConversation:["id","version","status","lastContactAt","closedAt","createdAt","updatedAt"],
    AttentionMessage:["id","conversationId","direction","sentAt"],AttentionReadState:["userId","messageId","conversationId","readAt"],
    AttentionAudit:["userId","actorKey","action","metadata","createdAt"],AttentionRequest:["actorKey","requestId","fingerprint","resultId"],
    AttentionMetaOutbox:["actorKey","requestId","conversationId","status"]};
  const [row]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS expected("table" text,"column" text)
    WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=expected."table" AND c.column_name=expected."column")) AS ready`,
  JSON.stringify(Object.entries(required).flatMap(([table,columns])=>columns.map(column=>({table,column})))));
  if(!row?.ready)throw new AttentionError("La preparación del cierre conjunto de Atención está pendiente.",503);
}
async function audit(db:AttentionDb,actor:AttentionActor,action:string,metadata:object) {
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("userId","actorKey",action,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id`,actor.userId,actor.key,action,JSON.stringify(metadata));
}
const statsSql=`SELECT c.id,
  COALESCE((SELECT md5(string_agg(m.id::text,',' ORDER BY m.id)) FROM "AttentionMessage" m WHERE m."conversationId"=c.id AND m.direction='inbound'),md5('')) AS "inboundHash",
  EXISTS(SELECT 1 FROM "AttentionMessage" m WHERE m."conversationId"=c.id AND m."sentAt">$2::timestamptz) AS "newActivity",
  EXISTS(SELECT 1 FROM "AttentionMetaOutbox" o WHERE o."conversationId"=c.id AND o.status IN ('queued','sending','uncertain')) AS "activeOutbox"
  FROM "AttentionConversation" c WHERE c.id=ANY($1::uuid[])`;

/** Private immutable review in the existing audit ledger; no DDL or provider calls. */
export function createAttentionBulkCloseStore(database: AttentionDatabase, options:{now?:()=>Date}={}) {
  const now=options.now??(()=>new Date());
  const transact=<T>(actor:AttentionActor,run:(db:AttentionDb,nominal:AttentionActor)=>Promise<T>)=>{
    central(actor);
    return database.$transaction(async db=>{
      await assertAttentionCurrentActor(db,actor);await schema(db);
      const [user]=await db.$queryRawUnsafe<{name:string}[]>(`SELECT nombre AS name FROM "Usuario" WHERE id=$1`,actor.userId);
      return run(db,{...actor,name:user.name});
    },transactionOptions);
  };
  return {
    async preview(actor:AttentionActor,rawCutoff?:string):Promise<AttentionBulkClosePreview> {
      const cutoff=parseAttentionBulkCloseCutoff(new URLSearchParams(rawCutoff===undefined?{}:{cutoff:rawCutoff}),now());
      return transact(actor,async(db,nominal)=>{
        const chats=await db.$queryRawUnsafe<Chat[]>(`SELECT id,version,status,"lastContactAt" FROM "AttentionConversation" WHERE "createdAt"<=$1::timestamptz ORDER BY id LIMIT 10001 FOR SHARE`,cutoff);
        if(chats.length>10000)throw new AttentionError("Hay demasiadas conversaciones para esta revisión conjunta.",503);
        const stats=await db.$queryRawUnsafe<{id:string;inboundHash:string;newActivity:boolean;activeOutbox:boolean}[]>(statsSql,chats.map(chat=>chat.id),cutoff);
        const unread=await db.$queryRawUnsafe<{id:string;conversationId:string}[]>(`SELECT m.id,m."conversationId" FROM "AttentionMessage" m
          WHERE m."conversationId"=ANY($1::uuid[]) AND m.direction='inbound' AND m."sentAt"<=$2::timestamptz
          AND NOT EXISTS(SELECT 1 FROM "AttentionReadState" r WHERE r."userId"=$3 AND r."messageId"=m.id) ORDER BY m.id LIMIT 250001`,chats.map(chat=>chat.id),cutoff,actor.userId);
        if(unread.length>250000)throw new AttentionError("Hay demasiados mensajes para esta revisión conjunta.",503);
        const byChat=new Map(stats.map(row=>[row.id,row])),idsByChat=new Map<string,string[]>();
        for(const message of unread){const values=idsByChat.get(message.conversationId)||[];values.push(message.id);idsByChat.set(message.conversationId,values);}
        const observations:Observation[]=chats.map(chat=>{
          const current=byChat.get(chat.id)!;
          return {id:chat.id,version:chat.version,status:chat.status,inboundHash:current.inboundHash,unreadIds:idsByChat.get(chat.id)||[],
            canClose:chat.status!=="closed"&&!current.newActivity&&!current.activeOutbox&&(!chat.lastContactAt||new Date(chat.lastContactAt)<=new Date(cutoff))};
        });
        const openCount=observations.filter(row=>row.status!=="closed").length,closeCount=observations.filter(row=>row.canClose).length;
        const preview={reviewToken:randomUUID(),cutoff,expiresAt:new Date(now().getTime()+reviewTtl).toISOString(),totalCount:chats.length,openCount,closeCount,unreadCount:unread.length,skippedCount:openCount-closeCount};
        await audit(db,nominal,"BULK_CLOSE_REVIEWED",{...preview,observations,actorName:nominal.name});
        return preview;
      });
    },
    async close(actor:AttentionActor,raw:AttentionBulkCloseInput):Promise<AttentionBulkCloseResult> {
      const input=parseAttentionBulkCloseInput(raw as unknown as Record<string,unknown>);
      return transact(actor,async(db,nominal)=>{
        // Serialize bulk requests, then lock chats before shared request locks:
        // ordinary chat writes use that same conversation -> request lock order.
        await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:bulk-close',0))`);
        const [stored]=await db.$queryRawUnsafe<{metadata:Review;createdAt:Date|string}[]>(`SELECT metadata,"createdAt" FROM "AttentionAudit"
          WHERE action='BULK_CLOSE_REVIEWED' AND "userId"=$1 AND "actorKey"=$2 AND metadata->>'reviewToken'=$3 ORDER BY id DESC LIMIT 1`,actor.userId,actor.key,input.reviewToken);
        if(!stored)throw new AttentionError("La revisión no existe o pertenece a otra cuenta.",404);
        const review=stored.metadata;
        const chats=await db.$queryRawUnsafe<Chat[]>(`SELECT id,version,status,"lastContactAt" FROM "AttentionConversation" WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`,review.observations.map(chat=>chat.id));
        for(const prefix of ["attention:","attention:meta:request:"])await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`${prefix}${actor.key}:${input.requestId}`);
        const fingerprint=hash({kind:"BULK_CLOSE",...input});
        const [prior]=await db.$queryRawUnsafe<{fingerprint:string}[]>(`SELECT fingerprint FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,actor.key,input.requestId);
        if(prior){
          if(prior.fingerprint!==fingerprint)throw new AttentionError("La solicitud ya se utilizó con otros datos.",409);
          const [done]=await db.$queryRawUnsafe<{metadata:{result:AttentionBulkCloseResult}}[]>(`SELECT metadata FROM "AttentionAudit" WHERE action='BULK_CLOSE_COMPLETED' AND "userId"=$1 AND "actorKey"=$2 AND metadata->>'requestId'=$3 ORDER BY id DESC LIMIT 1`,actor.userId,actor.key,input.requestId);
          if(!done)throw new AttentionError("No fue posible recuperar el resultado confirmado.",503);
          return done.metadata.result;
        }
        if(new Date(review.expiresAt)<=now()||new Date(stored.createdAt)>now()||new Date(review.cutoff)>now())throw new AttentionError("La revisión venció. Actualiza el resumen antes de confirmar.",409);
        const [collision]=await db.$queryRawUnsafe<{present:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid) AS present`,actor.key,input.requestId);
        if(collision?.present)throw new AttentionError("La solicitud ya corresponde a un mensaje.",409);
        await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint,"resultId") VALUES($1,$2::uuid,$3,$4::uuid) RETURNING "requestId"`,actor.key,input.requestId,fingerprint,input.reviewToken);
        const stats=await db.$queryRawUnsafe<{id:string;inboundHash:string;newActivity:boolean;activeOutbox:boolean}[]>(statsSql,chats.map(chat=>chat.id),review.cutoff);
        const byId=new Map(chats.map(chat=>[chat.id,chat])),byStats=new Map(stats.map(row=>[row.id,row]));
        const closable=review.observations.filter(observed=>{
          const chat=byId.get(observed.id),current=byStats.get(observed.id);
          return observed.canClose&&chat&&current&&chat.status!=="closed"&&chat.version===observed.version&&current.inboundHash===observed.inboundHash
            &&!current.newActivity&&!current.activeOutbox&&(!chat.lastContactAt||new Date(chat.lastContactAt)<=new Date(review.cutoff));
        }).map(chat=>chat.id);
        const closed=await db.$queryRawUnsafe<{id:string}[]>(`UPDATE "AttentionConversation" SET status='closed',"closedAt"=$2::timestamptz,version=version+1,"updatedAt"=now()
          WHERE id=ANY($1::uuid[]) RETURNING id`,closable,review.cutoff);
        const observedReads=review.observations.flatMap(chat=>chat.unreadIds.map(messageId=>({messageId,conversationId:chat.id})));
        const read=await db.$queryRawUnsafe<{conversationId:string}[]>(`INSERT INTO "AttentionReadState"("userId","messageId","conversationId")
          SELECT $1,m.id,m."conversationId" FROM jsonb_to_recordset($2::jsonb) AS observed("messageId" uuid,"conversationId" uuid)
          JOIN "AttentionMessage" m ON m.id=observed."messageId" AND m."conversationId"=observed."conversationId"
          WHERE m.direction='inbound' AND m."sentAt"<=$3::timestamptz AND m."conversationId"=ANY($4::uuid[])
          ON CONFLICT("userId","messageId") DO NOTHING RETURNING "conversationId"`,actor.userId,JSON.stringify(observedReads),review.cutoff,chats.map(chat=>chat.id));
        const result={cutoff:review.cutoff,closedCount:closed.length,readCount:read.length,skippedCount:review.openCount-closed.length};
        await audit(db,nominal,"BULK_CLOSE_COMPLETED",{reviewToken:input.reviewToken,requestId:input.requestId,actorName:nominal.name,result,closedIds:closed.map(chat=>chat.id)});
        const changedIds=[...new Set(read.map(row=>row.conversationId))];
        if(changedIds.length)await db.$queryRawUnsafe(`SELECT pg_notify('finserpay_attention_changes',json_build_object('conversationId',id,
          'previousUserId',NULL,'previousKey',NULL,'previousSellerId',NULL,'currentUserId',$2::integer,'currentKey',$3::text,'currentSellerId',NULL,'readActorUserId',$2::integer)::text)
          FROM unnest($1::uuid[]) AS id`,changedIds,actor.userId,actor.key);
        return result;
      });
    },
  };
}
async function runtime(){const {default:prisma}=await import("./prisma");return createAttentionBulkCloseStore(prisma as unknown as AttentionDatabase);}
export async function previewAttentionBulkClose(actor:AttentionActor,cutoff?:string){return (await runtime()).preview(actor,cutoff);}
export async function closeAttentionConversations(actor:AttentionActor,input:AttentionBulkCloseInput){return (await runtime()).close(actor,input);}
