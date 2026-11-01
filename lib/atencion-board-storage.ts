import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, assertAttentionActor, attentionUuid } from "./atencion-core";
import { parseAttentionBoardCards, parseAttentionBoardMove, parseAttentionBoardMutation, parseAttentionBoardSearch } from "./atencion-board-core";
import { assertAttentionCurrentActor, attentionConversationScope, attentionConversationSearch, readAttentionBoardCards,
  type AttentionDatabase, type AttentionDb } from "./atencion-storage";
import type { AttentionActor } from "./atencion-types";
import type { AttentionBoard, AttentionBoardPlacement, AttentionBoardSection, AttentionBoardSectionMutation, AttentionBoardMutationResult,
  AttentionBoardMove, AttentionBoardMoveResult } from "./atencion-board-types";

type Section = Pick<AttentionBoardSection,"id"|"name"|"color"|"position"|"version"> & { id:string; archivedAt:Date|string|null };
const options={isolationLevel:"ReadCommitted" as const,timeout:30000,maxWait:10000};
const pageSize=20;
async function requireSchema(db:AttentionDb){
  const [row]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionBoardSection"') IS NOT NULL
    AND (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name='AttentionConversation'
      AND (column_name='sectionId' AND data_type='uuid' OR column_name='boardVersion' AND data_type='integer')) AS ready`);
  if(!row?.ready)throw new AttentionError("La preparación del tablero de Atención está pendiente.",503);
}
async function audit(db:AttentionDb,actor:AttentionActor,action:string,conversationId:string|null,metadata:object){
  await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","actorKey",action,metadata) VALUES($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`,conversationId,actor.userId,actor.key,action,JSON.stringify(metadata));
}
async function lockBoard(db:AttentionDb){await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('attention:board',0))`);}
async function request(db:AttentionDb,actor:AttentionActor,id:string,input:unknown){
  const key=attentionUuid(id),fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex");
  // Share both existing namespaces: one request UUID cannot become a board,
  // ordinary chat, financial or human-message operation through a race.
  for(const prefix of ["attention:","attention:meta:request:"])await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`${prefix}${actor.key}:${key}`);
  const [prior]=await db.$queryRawUnsafe<{fingerprint:string;resultId:string|null}[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,actor.key,key);
  if(prior){if(prior.fingerprint!==fingerprint)throw new AttentionError("La solicitud ya se utilizó con otros datos.",409);return {replay:true,resultId:prior.resultId};}
  const [message]=await db.$queryRawUnsafe<{present:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid) AS present`,actor.key,key);
  if(message?.present)throw new AttentionError("La solicitud ya corresponde a un mensaje.",409);
  await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES($1,$2::uuid,$3) RETURNING "requestId"`,actor.key,key,fingerprint);
  return {replay:false,resultId:null};
}
async function resultId(db:AttentionDb,actor:AttentionActor,requestId:string,id:string|null){
  await db.$queryRawUnsafe(`UPDATE "AttentionRequest" SET "resultId"=$3::uuid WHERE "actorKey"=$1 AND "requestId"=$2::uuid RETURNING "requestId"`,actor.key,requestId,id);
}
function dto(row:Section,count=0,totalCount=count):AttentionBoardSection{return {id:row.id,name:row.name,color:row.color,position:row.position,version:row.version,count,totalCount};}
async function section(db:AttentionDb,id:string,lock=false){
  const [row]=await db.$queryRawUnsafe<Section[]>(`SELECT * FROM "AttentionBoardSection" WHERE id=$1::uuid AND "archivedAt" IS NULL ${lock?"FOR UPDATE":"FOR SHARE"}`,attentionUuid(id));
  if(!row)throw new AttentionError("La sección ya no está disponible. Actualiza el tablero.",404);
  return row;
}
async function totalForSection(db:AttentionDb,id:string){return (await db.$queryRawUnsafe<{count:number}[]>(`SELECT count(*)::integer AS count FROM "AttentionConversation" WHERE "sectionId"=$1::uuid`,id))[0].count;}

export function createAttentionBoardStore(database:AttentionDatabase){
  const transact=<T>(actor:AttentionActor,run:(db:AttentionDb)=>Promise<T>)=>{
    assertAttentionActor(actor);
    return database.$transaction(async db=>{await assertAttentionCurrentActor(db,actor);await requireSchema(db);return run(db);},options);
  };
  return {
    async get(actor:AttentionActor,search=""):Promise<AttentionBoard>{
      search=parseAttentionBoardSearch(new URLSearchParams({search}));
      return transact(actor,async db=>{
        const access=attentionConversationScope(actor),filter=await attentionConversationSearch(db,actor,search);
        const sections=await db.$queryRawUnsafe<Section[]>(`SELECT * FROM "AttentionBoardSection" WHERE "archivedAt" IS NULL ORDER BY position,id`);
        const counts=await db.$queryRawUnsafe<{sectionId:string|null;count:number;totalCount:number}[]>(`SELECT c."sectionId",count(*)::integer AS "totalCount",
          count(*) FILTER(WHERE ${filter.sql})::integer AS count FROM "AttentionConversation" c WHERE ${access.sql} GROUP BY c."sectionId"`,...filter.values);
        const count=(id:string|null)=>counts.find(row=>row.sectionId===id);
        const empty=count(null);
        await audit(db,actor,"BOARD_VIEWED",null,{sections:sections.length});
        return {sections:[{id:null,name:"Sin sección",color:"slate",position:0,version:0,count:empty?.count??0,totalCount:empty?.totalCount??0},
          ...sections.map(row=>dto(row,count(row.id)?.count??0,count(row.id)?.totalCount??0))],permissions:{manage:actor.central},pageSize};
      });
    },
    async getPlacement(actor:AttentionActor,conversationId:string):Promise<AttentionBoardPlacement>{
      conversationId=attentionUuid(conversationId);
      return transact(actor,async db=>{
        const access=attentionConversationScope(actor);
        const [chat]=await db.$queryRawUnsafe<{id:string;sectionId:string|null;boardVersion:number;assigneeKey:string|null}[]>(`SELECT c.id,c."sectionId",c."boardVersion",c."assigneeKey" FROM "AttentionConversation" c WHERE ${access.sql} AND c.id=$4::uuid`,...access.values,conversationId);
        if(!chat)throw new AttentionError("Conversación no encontrada o no autorizada.",404);
        const sections=await db.$queryRawUnsafe<{id:string;name:string}[]>(`SELECT id,name FROM "AttentionBoardSection" WHERE "archivedAt" IS NULL ORDER BY position,id`);
        return {conversationId:chat.id,sectionId:chat.sectionId,boardVersion:chat.boardVersion,
          sections:[{id:null,name:"Sin sección"},...sections],permissions:{move:actor.central||chat.assigneeKey===actor.key}};
      });
    },
    async cards(actor:AttentionActor,filters:{sectionId:string|null;search:string;page:number}){
      const parsed=parseAttentionBoardCards(new URLSearchParams({sectionId:filters.sectionId??"none",search:filters.search,page:String(filters.page)}));
      return transact(actor,async db=>{
        if(parsed.sectionId)await section(db,parsed.sectionId);
        const cards=await readAttentionBoardCards(db,actor,parsed);
        await audit(db,actor,"BOARD_CARDS_VIEWED",null,{sectionId:parsed.sectionId,page:parsed.page,count:cards.conversations.length});
        return cards;
      });
    },
    async configure(actor:AttentionActor,raw:AttentionBoardSectionMutation):Promise<AttentionBoardMutationResult>{
      const input=parseAttentionBoardMutation(raw as unknown as Record<string,unknown>);
      if(!actor.central)throw new AttentionError("Solo administración central puede configurar las secciones.",403);
      return transact(actor,async db=>{
        await lockBoard(db);
        const operation=await request(db,actor,input.requestId,{kind:"BOARD_SECTION",...input});
        if(operation.replay){
          const [row]=operation.resultId?await db.$queryRawUnsafe<Section[]>(`SELECT * FROM "AttentionBoardSection" WHERE id=$1::uuid AND "archivedAt" IS NULL`,operation.resultId):[];
          return {section:row?dto(row,await totalForSection(db,row.id)):null,unchanged:true};
        }
        let changed=false,row:Section|undefined;
        let previous:{name:string;color:string;position:number;version:number}|null=null;
        if(input.action==="reorder"){
          const current=await db.$queryRawUnsafe<Section[]>(`SELECT * FROM "AttentionBoardSection" WHERE "archivedAt" IS NULL ORDER BY position,id FOR UPDATE`);
          if(current.length!==input.ordered.length||input.ordered.some(item=>!current.some(s=>s.id===item.id&&s.version===item.version)))throw new AttentionError("Las secciones cambiaron. Actualiza antes de guardar su orden.",409);
          for(const [index,item] of input.ordered.entries())if(current.find(s=>s.id===item.id)!.position!==index+1){
            await db.$queryRawUnsafe(`UPDATE "AttentionBoardSection" SET position=$2,version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,item.id,index+1);changed=true;
          }
        }else if(input.action==="create"){
          const [limits]=await db.$queryRawUnsafe<{count:number;position:number}[]>(`SELECT count(*)::integer AS count,COALESCE(max(position),0)::integer AS position FROM "AttentionBoardSection" WHERE "archivedAt" IS NULL`);
          if(limits.count>=20)throw new AttentionError("El tablero admite hasta veinte secciones configurables.",409);
          const [duplicate]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionBoardSection" WHERE lower(name)=lower($1) AND "archivedAt" IS NULL`,input.name);
          if(duplicate)throw new AttentionError("Ya existe una sección con ese nombre.",409);
          [row]=await db.$queryRawUnsafe<Section[]>(`INSERT INTO "AttentionBoardSection"(id,name,color,position,"createdByUserId") VALUES($1::uuid,$2,$3,$4,$5) RETURNING *`,randomUUID(),input.name,input.color,limits.position+1,actor.userId);changed=true;
        }else{
          const current=await section(db,input.id,true);
          previous={name:current.name,color:current.color,position:current.position,version:current.version};
          if(current.version!==input.version)throw new AttentionError("La sección cambió. Actualiza antes de editarla.",409);
          if(input.action==="archive"){
            if(await totalForSection(db,current.id))throw new AttentionError("La sección contiene conversaciones. Muévelas antes de archivarla.",409);
            await db.$queryRawUnsafe(`UPDATE "AttentionBoardSection" SET "archivedAt"=now(),version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,current.id);changed=true;
          }else{
            if(input.action==="rename"){
              const [duplicate]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionBoardSection" WHERE lower(name)=lower($1) AND "archivedAt" IS NULL AND id<>$2::uuid`,input.name,current.id);
              if(duplicate)throw new AttentionError("Ya existe una sección con ese nombre.",409);
            }
            const value=input.action==="rename"?input.name:input.color,key=input.action==="rename"?"name":"color";
            if(current[key]!==value){[row]=await db.$queryRawUnsafe<Section[]>(`UPDATE "AttentionBoardSection" SET ${key}=$2,version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING *`,current.id,value);changed=true;}
            else row=current;
          }
        }
        await resultId(db,actor,input.requestId,row?.id??null);
        if(changed)await audit(db,actor,"BOARD_SECTION_CHANGED",null,{action:input.action,sectionId:row?.id??("id" in input?input.id:null),requestId:input.requestId,
          ...(input.action==="reorder"?{ordered:input.ordered.map(item=>item.id)}:{before:previous,after:row?{name:row.name,color:row.color,position:row.position,version:row.version}:null})});
        return {section:row?dto(row,await totalForSection(db,row.id)):null,unchanged:!changed};
      });
    },
    async move(actor:AttentionActor,conversationId:string,raw:AttentionBoardMove):Promise<AttentionBoardMoveResult>{
      const input=parseAttentionBoardMove(raw as unknown as Record<string,unknown>);conversationId=attentionUuid(conversationId);
      return transact(actor,async db=>{
        await lockBoard(db);
        const access=attentionConversationScope(actor);
        const [chat]=await db.$queryRawUnsafe<{id:string;sectionId:string|null;boardVersion:number}[]>(`SELECT c.id,c."sectionId",c."boardVersion" FROM "AttentionConversation" c WHERE ${access.sql} AND c.id=$4::uuid FOR UPDATE OF c`,...access.values,conversationId);
        if(!chat)throw new AttentionError("Conversación no encontrada o no autorizada.",404);
        const operation=await request(db,actor,input.requestId,{kind:"BOARD_MOVE",conversationId,...input});
        if(operation.replay)return {conversationId,sectionId:chat.sectionId,boardVersion:chat.boardVersion,unchanged:true};
        if(chat.boardVersion!==input.boardVersion)throw new AttentionError("La conversación se movió a otra sección. Actualiza el tablero antes de continuar.",409);
        if(input.sectionId)await section(db,input.sectionId);
        await resultId(db,actor,input.requestId,conversationId);
        if(chat.sectionId===input.sectionId)return {conversationId,sectionId:chat.sectionId,boardVersion:chat.boardVersion,unchanged:true};
        const [updated]=await db.$queryRawUnsafe<{boardVersion:number}[]>(`UPDATE "AttentionConversation" SET "sectionId"=$2::uuid,"boardVersion"="boardVersion"+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING "boardVersion"`,conversationId,input.sectionId);
        await audit(db,actor,"BOARD_CONVERSATION_MOVED",conversationId,{from:chat.sectionId,to:input.sectionId,requestId:input.requestId,boardVersion:updated.boardVersion});
        return {conversationId,sectionId:input.sectionId,boardVersion:updated.boardVersion,unchanged:false};
      });
    },
  };
}
async function runtime(){const {default:prisma}=await import("./prisma");return createAttentionBoardStore(prisma as unknown as AttentionDatabase);}
export async function getAttentionBoard(actor:AttentionActor,search:string){return (await runtime()).get(actor,search);}
export async function getAttentionBoardPlacement(actor:AttentionActor,id:string){return (await runtime()).getPlacement(actor,id);}
export async function getAttentionBoardCards(actor:AttentionActor,filters:{sectionId:string|null;search:string;page:number}){return (await runtime()).cards(actor,filters);}
export async function configureAttentionBoard(actor:AttentionActor,input:AttentionBoardSectionMutation){return (await runtime()).configure(actor,input);}
export async function moveAttentionBoardConversation(actor:AttentionActor,id:string,input:AttentionBoardMove){return (await runtime()).move(actor,id,input);}
