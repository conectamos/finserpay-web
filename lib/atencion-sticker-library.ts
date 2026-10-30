import "server-only";
import { createHash } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionUuid, attentionText } from "./atencion-core";
import { assertAttentionCurrentActor, type AttentionDatabase, type AttentionDb } from "./atencion-storage";
import { validateMetaAttentionMedia } from "./atencion-meta";
import { readAttentionSticker } from "./atencion-meta-sticker";
import { readAttentionBody } from "./atencion-meta-http";
import type { AttentionActor } from "./atencion-types";

export type AttentionSavedSticker = {id:string;name:string;favorite:boolean;archived:boolean;animated:boolean;size:number;version:number;mediaUrl:string};
type Row={id:string;name:string;favorite:boolean;archivedAt:Date|null;animated:boolean;size:number;version:number;content:Uint8Array};
const digest=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const dto=(row:Row):AttentionSavedSticker=>({id:row.id,name:row.name,favorite:row.favorite,archived:Boolean(row.archivedAt),animated:row.animated,size:row.size,version:row.version,mediaUrl:`/api/atencion/stickers/${row.id}/media`});
const selected=`id,name,favorite,"archivedAt",animated,size,version`;
export async function readStickerUpload(request:Request){
  const contentType=request.headers.get("content-type")||"";
  if(!/^multipart\/form-data\s*;/i.test(contentType)||contentType.length>250)throw new AttentionError("Adjunta una imagen para guardar el sticker.",415);
  const bytes=await readAttentionBody(request,5*1024*1024+65536);
  let form:FormData;try{form=await new Response(Buffer.from(bytes),{headers:{"Content-Type":contentType}}).formData();}catch{throw new AttentionError("No se pudo leer el archivo.");}
  for(const key of form.keys())if(!["file","name","requestId"].includes(key)||form.getAll(key).length!==1)throw new AttentionError("El formulario contiene campos no admitidos.");
  const requestId=attentionUuid(form.get("requestId")),name=attentionText(form.get("name"),60),file=form.get("file");
  if(!file||typeof file==="string"||!["image/webp","image/png","image/jpeg"].includes(file.type)||!file.size||file.size>5*1024*1024)throw new AttentionError("Usa una imagen JPG, PNG o WebP de hasta 5 MB.");
  let content:Buffer=Buffer.from(await file.arrayBuffer());
  if(file.type!=="image/webp"){
    const sharp=(await import("sharp")).default;
    try{
      const image=sharp(content,{limitInputPixels:16_000_000,pages:1,failOn:"warning"}).timeout({seconds:10});
      const meta=await image.metadata();
      if(!["jpeg","png"].includes(meta.format||"")||meta.pages&&meta.pages>1)throw new Error("format");
      content=await image.rotate().resize(512,512,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).webp({quality:75,effort:4}).toBuffer();
    }catch{throw new AttentionError("No se pudo preparar esta imagen como sticker. Usa JPG o PNG de hasta 16 millones de píxeles.",415);}
  }
  validateMetaAttentionMedia({bytes:content,mimeType:"image/webp",fileName:"sticker.webp",kind:"sticker"});
  return {requestId,name,content};
}
export function createAttentionStickerLibrary(database:AttentionDatabase){
  const transaction=<T>(actor:AttentionActor,run:(db:AttentionDb)=>Promise<T>)=>{
    assertAttentionActor(actor);
    return database.$transaction(async db=>{
      await assertAttentionCurrentActor(db,actor);
      const [schema]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionSticker"') IS NOT NULL AS ready`);
      if(!schema?.ready)throw new AttentionError("La biblioteca de stickers está pendiente de preparar.",503);
      await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention:stickers:${actor.userId}`);
      return run(db);
    },{isolationLevel:"ReadCommitted",timeout:15000,maxWait:10000});
  };
  async function request(db:AttentionDb,actor:AttentionActor,id:string,input:unknown){
    const requestId=attentionUuid(id),fingerprint=digest(JSON.stringify(input));
    for(const prefix of ["attention:","attention:meta:request:"])await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`${prefix}${actor.key}:${requestId}`);
    const [prior]=await db.$queryRawUnsafe<{fingerprint:string;resultId:string}[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,actor.key,requestId);
    if(prior){if(prior.fingerprint!==fingerprint)throw new AttentionError("La solicitud ya tiene otro contenido.",409);return {requestId,replay:prior.resultId};}
    const [collision]=await db.$queryRawUnsafe<{present:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid) AS present`,actor.key,requestId);
    if(collision?.present)throw new AttentionError("La solicitud corresponde a un mensaje.",409);
    await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES($1,$2::uuid,$3) RETURNING "requestId"`,actor.key,requestId,fingerprint);
    return {requestId,replay:null};
  }
  async function finish(db:AttentionDb,actor:AttentionActor,requestId:string,row:Row,action:string){
    await db.$queryRawUnsafe(`UPDATE "AttentionRequest" SET "resultId"=$3::uuid WHERE "actorKey"=$1 AND "requestId"=$2::uuid RETURNING "requestId"`,actor.key,requestId,row.id);
    await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("userId","actorKey",action,metadata) VALUES($1,$2,$3,$4::jsonb) RETURNING id`,actor.userId,actor.key,action,JSON.stringify({stickerId:row.id,requestId}));
    return dto(row);
  }
  async function owned(db:AttentionDb,actor:AttentionActor,id:string,content=false){
    const [row]=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected}${content?",content":""} FROM "AttentionSticker" WHERE id=$1::uuid AND "userId"=$2`,attentionUuid(id),actor.userId);
    if(!row)throw new AttentionError("El sticker no está disponible para tu cuenta.",404);return row;
  }
  return {
    list:(actor:AttentionActor)=>transaction(actor,async db=>({items:(await db.$queryRawUnsafe<Row[]>(`SELECT ${selected} FROM "AttentionSticker" WHERE "userId"=$1 ORDER BY favorite DESC,"createdAt" DESC LIMIT 50`,actor.userId)).map(dto),limit:50})),
    media:(actor:AttentionActor,id:string)=>transaction(actor,async db=>{const row=await owned(db,actor,id,true);return {bytes:row.content,name:row.name};}),
    save:(actor:AttentionActor,input:{requestId:string;name:string;content:Uint8Array})=>transaction(actor,async db=>{
      const name=attentionText(input.name,60);validateMetaAttentionMedia({bytes:input.content,mimeType:"image/webp",fileName:"sticker.webp",kind:"sticker"});
      const sha256=digest(input.content),intent=await request(db,actor,input.requestId,{type:"STICKER_SAVE",name,sha256});
      if(intent.replay)return dto(await owned(db,actor,intent.replay));
      const [existing]=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected} FROM "AttentionSticker" WHERE "userId"=$1 AND sha256=$2`,actor.userId,sha256);
      if(existing)return finish(db,actor,intent.requestId,existing,"STICKER_REUSED");
      const [quota]=await db.$queryRawUnsafe<{count:number;size:number}[]>(`SELECT count(*)::int AS count,COALESCE(sum(size),0)::int AS size FROM "AttentionSticker" WHERE "userId"=$1`,actor.userId);
      if(quota.count>=50||quota.size+input.content.length>10*1024*1024)throw new AttentionError("La biblioteca admite 50 stickers y 10 MB por usuario, incluidos los archivados.",409);
      const [row]=await db.$queryRawUnsafe<Row[]>(`INSERT INTO "AttentionSticker"("userId",name,content,sha256,size,animated) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${selected}`,actor.userId,name,Buffer.from(input.content),sha256,input.content.length,readAttentionSticker(input.content)!.animated);
      return finish(db,actor,intent.requestId,row,"STICKER_SAVED");
    }),
    update:(actor:AttentionActor,id:string,input:Record<string,unknown>)=>transaction(actor,async db=>{
      if(Object.keys(input).some(key=>!["requestId","version","action","favorite"].includes(key))||!["favorite","archive","restore"].includes(String(input.action))||!Number.isSafeInteger(input.version)||Number(input.version)<1||input.action==="favorite"&&typeof input.favorite!=="boolean")throw new AttentionError("Cambio de sticker no válido.");
      const current=await owned(db,actor,id),intent=await request(db,actor,attentionUuid(input.requestId),{type:"STICKER_UPDATE",id,...input});
      if(intent.replay)return dto(await owned(db,actor,intent.replay));
      if(current.version!==input.version)throw new AttentionError("El sticker cambió. Actualiza la biblioteca.",409);
      const [row]=await db.$queryRawUnsafe<Row[]>(`UPDATE "AttentionSticker" SET favorite=$3,"archivedAt"=CASE WHEN $4 THEN COALESCE("archivedAt",now()) ELSE NULL END,version=version+1 WHERE id=$1::uuid AND "userId"=$2 RETURNING ${selected}`,id,actor.userId,input.action==="favorite"?input.favorite:current.favorite,input.action==="archive"?true:input.action==="restore"?false:Boolean(current.archivedAt));
      return finish(db,actor,intent.requestId,row,"STICKER_UPDATED");
    }),
  };
}
export async function attentionStickerLibrary(){const {default:prisma}=await import("./prisma");return createAttentionStickerLibrary(prisma as unknown as AttentionDatabase);}
