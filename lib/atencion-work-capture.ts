import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, attentionUuid } from "./atencion-core";
import type { AttentionDatabase, AttentionDb } from "./atencion-storage";
import { createAttentionWorkStore, type AttentionWorkCaptureContext } from "./atencion-work-storage";
import type { AttentionWorkActor } from "./atencion-work-types";

export const ATTENTION_WORK_CAPTURE_TTL_MINUTES=20;
export const ATTENTION_WORK_CAPTURE_MAX_BYTES=5*1024*1024;
export type AttentionWorkCaptureStatus={id:string;expiresAt:string;state:"open"|"revoked"|"expired";uploadedCount:number;lastUploadedAt:string|null};
type Capture={id:string;workId:string;actorKey:string;actor:AttentionWorkActor;requestId:string;requestVersion:number;tokenHash:string;bindingHash:string;expiresAt:Date|string;revokedAt:Date|string|null;uploadedCount:number;lastUploadedAt:Date|string|null};
const actorKey=(actor:AttentionWorkActor)=>actor.type==="attention"?actor.actor.key:actor.key;
const hash=(token:string)=>createHash("sha256").update(token).digest("hex");
export function attentionWorkCaptureToken(value:unknown){if(typeof value!=="string"||!/^[0-9a-f]{64}$/.test(value))throw new AttentionError("El enlace de captura no es válido.",401);return value;}
function dto(row:Capture):AttentionWorkCaptureStatus{return {id:row.id,expiresAt:new Date(row.expiresAt).toISOString(),state:row.revokedAt?"revoked":new Date(row.expiresAt).getTime()<=Date.now()?"expired":"open",uploadedCount:row.uploadedCount,lastUploadedAt:row.lastUploadedAt?new Date(row.lastUploadedAt).toISOString():null};}
async function schema(db:AttentionDb){const [r]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionWorkCaptureSession"') IS NOT NULL AS ready`);if(!r?.ready)throw new AttentionError("La captura de fotos está pendiente de instalar.",503);}
function current(context:AttentionWorkCaptureContext,row:Capture,active=false){
  if(context.closed)throw new AttentionError("La solicitud está finalizada. La captura ya no está disponible.",410);
  if(row.bindingHash!==context.bindingHash)throw new AttentionError("La solicitud cambió de responsable o de operación. Abre una nueva captura desde el chat.",409);
  if(active&&dto(row).state!=="open")throw new AttentionError("El enlace de captura caducó o fue cancelado. Abre uno nuevo desde el chat.",410);
}
async function audit(context:AttentionWorkCaptureContext,sessionId:string,action:string){
  const a=context.actor,who=a.type==="attention"?{userId:a.actor.userId,sellerId:null,key:a.actor.key,name:a.actor.name}:a;
  await context.db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId","actorKey",action,metadata) VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb) RETURNING id`,context.conversationId,who.userId,who.sellerId,who.key,action,JSON.stringify({workId:context.workId,captureSessionId:sessionId,source:"qr_capture",author:who.name}));
}

/** A QR is an upload capability for one case; it cannot read messages, documents or customer data. */
export function createAttentionWorkCaptureStore(database:AttentionDatabase){
  const work=createAttentionWorkStore(database);
  async function owned(context:AttentionWorkCaptureContext,id:string){
    await schema(context.db);
    const [row]=await context.db.$queryRawUnsafe<Capture[]>(`SELECT * FROM "AttentionWorkCaptureSession" WHERE id=$1::uuid AND "workId"=$2::uuid AND "actorKey"=$3 FOR UPDATE`,attentionUuid(id),context.workId,actorKey(context.actor));
    if(!row)throw new AttentionError("Captura no encontrada o no autorizada.",404);return row;
  }
  async function bearer<T>(token:unknown,run:(context:AttentionWorkCaptureContext,row:Capture)=>Promise<T>){
    const tokenHash=hash(attentionWorkCaptureToken(token));
    // Preliminary lookup is read-only. Locks always start with actor, work/conversation and target.
    await schema(database);
    const [found]=await database.$queryRawUnsafe<Capture[]>(`SELECT * FROM "AttentionWorkCaptureSession" WHERE "tokenHash"=$1`,tokenHash);
    if(!found)throw new AttentionError("El enlace de captura no está disponible.",404);
    return work.captureAccess(found.actor,found.workId,async context=>{
      const row=await owned(context,found.id);
      if(row.tokenHash!==tokenHash)throw new AttentionError("El enlace de captura no está disponible.",404);
      current(context,row);return run(context,row);
    });
  }
  return {
    create:(actor:AttentionWorkActor,id:string,input:Record<string,unknown>)=>{
      if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(k=>!["requestId","version","token"].includes(k)))throw new AttentionError("Datos de captura inválidos.");
      const requestId=attentionUuid(input.requestId),version=input.version;
      if(!Number.isSafeInteger(version)||Number(version)<1)throw new AttentionError("Versión de solicitud inválida.");
      let token:string;try{token=attentionWorkCaptureToken(input.token);}catch{throw new AttentionError("Genera un enlace de captura válido.");}
      const tokenHash=hash(token);
      return work.captureAccess(actor,id,async context=>{
        await schema(context.db);
        await context.db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention:capture:create:${actorKey(context.actor)}:${requestId}`);
        const [prior]=await context.db.$queryRawUnsafe<Capture[]>(`SELECT * FROM "AttentionWorkCaptureSession" WHERE "actorKey"=$1 AND "requestId"=$2::uuid FOR UPDATE`,actorKey(context.actor),requestId);
        if(prior){
          if(prior.workId!==context.workId||prior.tokenHash!==tokenHash||prior.requestVersion!==version)throw new AttentionError("Este intento de captura ya tiene otro contenido.",409);
          current(context,prior);return dto(prior);
        }
        if(context.closed)throw new AttentionError("La solicitud está finalizada. La captura ya no está disponible.",410);
        if(context.version!==version)throw new AttentionError("La solicitud cambió. Actualiza antes de abrir la captura.",409);
        await context.db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention:capture:token:${tokenHash}`);
        const [collision]=await context.db.$queryRawUnsafe<{exists:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "AttentionWorkCaptureSession" WHERE "tokenHash"=$1) AS exists`,tokenHash);
        if(collision.exists)throw new AttentionError("Genera un nuevo enlace de captura.",409);
        await context.db.$queryRawUnsafe(`UPDATE "AttentionWorkCaptureSession" SET "revokedAt"=now() WHERE "workId"=$1::uuid AND "actorKey"=$2 AND "revokedAt" IS NULL RETURNING id`,context.workId,actorKey(context.actor));
        const [created]=await context.db.$queryRawUnsafe<Capture[]>(`INSERT INTO "AttentionWorkCaptureSession"(id,"workId","actorKey",actor,"requestId","requestVersion","tokenHash","bindingHash","expiresAt") VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid,$6,$7,$8,now()+interval '20 minutes') RETURNING *`,randomUUID(),context.workId,actorKey(context.actor),JSON.stringify(context.actor),requestId,version,tokenHash,context.bindingHash);
        await audit(context,created.id,"WORK_CAPTURE_CREATED");return dto(created);
      });
    },
    status:(actor:AttentionWorkActor,id:string,sessionId:string)=>work.captureAccess(actor,id,async context=>{const row=await owned(context,sessionId);current(context,row);return dto(row);}),
    revoke:(actor:AttentionWorkActor,id:string,sessionId:string)=>work.captureAccess(actor,id,async context=>{
      const row=await owned(context,sessionId);
      if(!row.revokedAt){await context.db.$queryRawUnsafe(`UPDATE "AttentionWorkCaptureSession" SET "revokedAt"=now() WHERE id=$1::uuid RETURNING id`,row.id);await audit(context,row.id,"WORK_CAPTURE_REVOKED");}
      const [updated]=await context.db.$queryRawUnsafe<Capture[]>(`SELECT * FROM "AttentionWorkCaptureSession" WHERE id=$1::uuid`,row.id);return dto(updated);
    }),
    mobileStatus:(token:unknown)=>bearer(token,async(_context,row)=>dto(row)),
    upload:(token:unknown,input:{requestId:string;fileName:string;mimeType:string;content:Uint8Array})=>{
      const requestId=attentionUuid(input.requestId);
      if(!["image/jpeg","image/png"].includes(input.mimeType))throw new AttentionError("La captura solo admite JPG o PNG.",415);
      if(!(input.content instanceof Uint8Array)||input.content.length<1||input.content.length>ATTENTION_WORK_CAPTURE_MAX_BYTES)throw new AttentionError("La foto debe pesar hasta 5 MB.",413);
      return bearer(token,async(context,row)=>{
        current(context,row,true);
        const attached=await context.attach({...input,requestId,captureSessionId:row.id});
        if(!attached.alreadyApplied)await context.db.$queryRawUnsafe(`UPDATE "AttentionWorkCaptureSession" SET "uploadedCount"="uploadedCount"+1,"lastUploadedAt"=now() WHERE id=$1::uuid RETURNING id`,row.id);
        const [updated]=await context.db.$queryRawUnsafe<Capture[]>(`SELECT * FROM "AttentionWorkCaptureSession" WHERE id=$1::uuid`,row.id);return dto(updated);
      });
    },
  };
}
export async function attentionWorkCaptureStore(){const {default:prisma}=await import("./prisma");return createAttentionWorkCaptureStore(prisma as unknown as AttentionDatabase);}
