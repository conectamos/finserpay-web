import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { assertAttentionCurrentActor, type AttentionDatabase, type AttentionDb } from "./atencion-storage";
import { attentionWorkKinds, attentionWorkStates, type AttentionWorkActor, type AttentionWorkDetail, type AttentionWorkItem, type AttentionWorkKind } from "./atencion-work-types";
import type { AttentionMessage, AttentionNote } from "./atencion-types";
import { validateMetaAttentionMedia } from "./atencion-meta";

type Row = AttentionWorkItem & { targetSource: "D" | "C"; targetId: number; sellerId: number; userId: number; sedeId: number; aliadoId: number };
type Target = { id:number; name:string; document:string|null; imei:string|null; platform:string|null; state:string; sellerId:number|null; sedeId:number; aliadoId:number; advisor:string; ally:string; branch:string };
const identity = (a:AttentionWorkActor) => a.type === "attention" ? {userId:a.actor.userId,sellerId:null,key:a.actor.key,name:a.actor.name} : a;
const iso = (value:unknown) => new Date(value as string).toISOString();
const selected = `w.*,c.name,c."assigneeName" AS assignee,c."assigneeKey",v.nombre AS advisor,a.nombre AS ally,s.nombre AS branch`;
const join = `FROM "AttentionWorkRequest" w JOIN "AttentionConversation" c ON c.id=w."conversationId" JOIN "Vendedor" v ON v.id=w."sellerId" JOIN "Sede" s ON s.id=w."sedeId" JOIN "Aliado" a ON a.id=w."aliadoId"`;
function dto(r:Row):AttentionWorkItem{return {id:r.id,conversationId:r.conversationId,kind:r.kind,target:`${r.targetSource}-${r.targetId}`,state:r.state,callMode:r.callMode,name:r.name,advisor:r.advisor,ally:r.ally,branch:r.branch,assignee:r.assignee,assigneeKey:r.assigneeKey,version:r.version,createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt)};}
function scope(a:AttentionWorkActor){return a.type === "attention" ? {sql:`($1::boolean OR (c."assigneeUserId"=$2 AND c."assigneeKey"=$3 AND c."assigneeSellerId" IS NULL))`,values:[a.actor.central,a.actor.userId,a.actor.key]} : {sql:`w."aliadoId"=$1 AND (w."sellerId"=$2 OR ($3::boolean AND w."sedeId"=$4)) AND EXISTS(SELECT 1 FROM (SELECT 'D' AS source,id,"vendedorId","sedeId" FROM "CreditoBorrador" UNION ALL SELECT 'C',id,"vendedorId","sedeId" FROM "Credito") owner JOIN "Sede" os ON os.id=owner."sedeId" WHERE owner.source=w."targetSource" AND owner.id=w."targetId" AND os."aliadoId"=$1 AND (owner."vendedorId"=$2 OR ($3::boolean AND owner."sedeId"=$4)))`,values:[a.aliadoId,a.sellerId,a.supervisor,a.sedeId]};}
export function parseWorkTarget(value:unknown){const match=typeof value==="string"?/^([DC])-([1-9]\d{0,9})$/.exec(value):null;if(!match)throw new AttentionError("Selecciona una solicitud o crédito existente.");return {source:match[1] as "D"|"C",id:Number(match[2])};}
export function parseWorkKind(value:unknown):AttentionWorkKind{if(value!=="enrollment"&&value!=="welcome")throw new AttentionError("Tipo de solicitud inválido.");return value;}
async function target(db:AttentionDb,source:"D"|"C",id:number):Promise<Target>{
  const table=source==="D"?'"CreditoBorrador"':'"Credito"';
  const [r]=await db.$queryRawUnsafe<Target[]>(`SELECT d.id,d."clienteNombre" AS name,d."clienteDocumento" AS document,d.imei,upper(COALESCE(to_jsonb(d)->>'plataforma',to_jsonb(d)->'contratoSnapshot'->>'plataforma','')) AS platform,d.estado AS state,d."vendedorId" AS "sellerId",d."sedeId",s."aliadoId",v.nombre AS advisor,a.nombre AS ally,s.nombre AS branch FROM ${table} d JOIN "Sede" s ON s.id=d."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" LEFT JOIN "Vendedor" v ON v.id=d."vendedorId" WHERE d.id=$1 FOR SHARE OF d,s,a`,id);
  if(!r)throw new AttentionError("La operación vinculada ya no está disponible.",404);return r;
}
export function createAttentionWorkStore(database:AttentionDatabase){
  async function transaction<T>(a:AttentionWorkActor,run:(db:AttentionDb)=>Promise<T>){return database.$transaction(async db=>{
    if(a.type==="attention")await assertAttentionCurrentActor(db,a.actor);else{
      const [current]=await db.$queryRawUnsafe<{name:string;supervisor:boolean}[]>(`SELECT v.nombre AS name,upper(v."tipoPerfil")='SUPERVISOR' AS supervisor FROM "Usuario" u JOIN "Sede" us ON us.id=u."sedeId" JOIN "Aliado" ua ON ua.id=us."aliadoId" JOIN "Vendedor" v ON v.id=$2 JOIN "SedeVendedor" sv ON sv."vendedorId"=v.id AND sv."sedeId"=$3 JOIN "Sede" s ON s.id=$4 JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.id=$1 AND u."sedeId"=$5 AND u.activo AND us.activa AND ua.activo AND v.activo AND NOT v."debeCambiarPin" AND sv.activo AND s.activa AND a.activo AND a.id=$6 AND upper(v."tipoPerfil") IN ('VENDEDOR','SUPERVISOR') FOR SHARE OF u,us,ua,v,sv,s,a`,a.userId,a.sellerId,a.accessSedeId,a.sedeId,a.userSedeId,a.aliadoId);
      if(!current||current.supervisor!==a.supervisor||a.key!==`seller:${a.userId}:${a.sellerId}`)throw new AttentionError("El perfil comercial ya no está autorizado.",403);
      a={...a,name:current.name};
    }
    const [schema]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionWorkRequest"') IS NOT NULL AS ready`);
    if(!schema?.ready)throw new AttentionError("La bandeja de solicitudes está pendiente de instalar.",503);
    return run(db);
  },{isolationLevel:"ReadCommitted",timeout:20000,maxWait:10000});}
  async function row(db:AttentionDb,a:AttentionWorkActor,id:string){const access=scope(a);const [r]=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected} ${join} WHERE ${access.sql} AND w.id=$${access.values.length+1}::uuid FOR UPDATE OF w,c`,...access.values,attentionUuid(id));if(!r)throw new AttentionError("Solicitud no encontrada o no autorizada.",404);
    if(a.type==="seller"){const t=await target(db,r.targetSource,r.targetId);if(t.aliadoId!==a.aliadoId||!(t.sellerId===a.sellerId||a.supervisor&&t.sedeId===a.sedeId))throw new AttentionError("La operación ya no pertenece a tu alcance.",403);}return r;}
  async function intent(db:AttentionDb,a:AttentionWorkActor,requestId:unknown,input:unknown){const who=identity(a),id=attentionUuid(requestId),fingerprint=createHash("sha256").update(JSON.stringify(input)).digest("hex");
    for(const ns of ["attention:","attention:meta:request:"])await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`${ns}${who.key}:${id}`);
    const [old]=await db.$queryRawUnsafe<{fingerprint:string;resultId:string}[]>(`SELECT fingerprint,"resultId" FROM "AttentionRequest" WHERE "actorKey"=$1 AND "requestId"=$2::uuid`,who.key,id);
    if(old){if(old.fingerprint!==fingerprint)throw new AttentionError("Este intento ya tiene otro contenido.",409);return {id,replay:old.resultId};}
    const [collision]=await db.$queryRawUnsafe<{exists:boolean}[]>(`SELECT EXISTS(SELECT 1 FROM "AttentionMetaOutbox" WHERE "actorKey"=$1 AND "requestId"=$2::uuid)`,who.key,id);if(collision?.exists)throw new AttentionError("El identificador ya corresponde a un mensaje.",409);
    await db.$queryRawUnsafe(`INSERT INTO "AttentionRequest"("actorKey","requestId",fingerprint) VALUES($1,$2::uuid,$3) RETURNING "requestId"`,who.key,id,fingerprint);return {id,replay:null};
  }
  async function audit(db:AttentionDb,a:AttentionWorkActor,r:Row,requestId:string,action:string,metadata:object={}){const who=identity(a);await db.$queryRawUnsafe(`UPDATE "AttentionRequest" SET "resultId"=$3::uuid WHERE "actorKey"=$1 AND "requestId"=$2::uuid RETURNING "requestId"`,who.key,requestId,r.id);await db.$queryRawUnsafe(`INSERT INTO "AttentionAudit"("conversationId","userId","sellerId","actorKey",action,metadata) VALUES($1::uuid,$2,$3,$4,$5,$6::jsonb) RETURNING id`,r.conversationId,who.userId,who.sellerId,who.key,action,JSON.stringify({workId:r.id,author:who.name,requestId,...metadata}));}
  async function detail(db:AttentionDb,a:AttentionWorkActor,r:Row):Promise<AttentionWorkDetail>{
    const t=await target(db,r.targetSource,r.targetId),isStaff=a.type==="attention";
    const messages=await db.$queryRawUnsafe<AttentionMessage[]>(`SELECT id,direction,text,"sentAt",author,attachment FROM "AttentionMessage" WHERE "conversationId"=$1::uuid ORDER BY "sentAt" DESC,id DESC LIMIT 201`,r.conversationId);
    const notes=isStaff?await db.$queryRawUnsafe<AttentionNote[]>(`SELECT id,text,author,"createdAt" FROM "AttentionNote" WHERE "conversationId"=$1::uuid ORDER BY "createdAt" DESC,id DESC LIMIT 100`,r.conversationId):[];
    const events=await db.$queryRawUnsafe<{id:string;action:string;author:string;at:string;state:string|null}[]>(`SELECT id::text,action,metadata->>'author' AS author,"createdAt" AS at,metadata->>'state' AS state FROM "AttentionAudit" WHERE "conversationId"=$1::uuid AND action IN ('WORK_CREATED','WORK_STATE','WORK_ASSIGNED','WORK_CALL_MODE') ORDER BY "createdAt" DESC,id DESC LIMIT 100`,r.conversationId);
    const team=isStaff&&a.actor.central?await db.$queryRawUnsafe<{key:string;name:string}[]>(`SELECT 'analyst:'||u.id AS key,u.nombre AS name FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.activo AND s.activa AND a.activo AND upper(trim(a.codigo))='FINSERPAY' AND upper(trim(r.nombre))='ANALISTA_APROBACION' ORDER BY u.nombre`):[];
    const operationHref=isStaff?(r.kind==="enrollment"?`/dashboard/aprobaciones/enrolamiento?documento=${encodeURIComponent(t.document||"")}&imei=${encodeURIComponent(t.imei||"")}`:`/dashboard/aprobaciones?credito=${r.targetId}`):(r.targetSource==="D"?`/dashboard/creditos?draft=${r.targetId}&mode=create-client`:`/dashboard/solicitudes?id=C-${r.targetId}`);
    return {item:dto({...r,name:t.name}),messages:messages.slice(0,200).reverse().map(m=>({...m,sentAt:iso(m.sentAt),...(m.attachment?{attachment:{...m.attachment,url:`/api/${isStaff?"atencion/solicitudes":"ventas/atencion"}/${r.id}/files/${m.attachment.id}`}}:{})})),notes:notes.map(n=>({...n,createdAt:iso(n.createdAt)})),canManage:isStaff,canWrite:r.state!=="completed"&&(isStaff||a.sellerId===t.sellerId),canAssign:isStaff&&a.actor.central,historyTruncated:messages.length>200,document:t.document,imei:t.imei,operationHref,team,events:events.map(e=>({...e,at:iso(e.at)}))};
  }
  return {
    authorizeEvents:(a:AttentionWorkActor,ids:readonly string[])=>transaction(a,async db=>{if(!ids.length)return false;const access=scope(a),[result]=await db.$queryRawUnsafe<{relevant:boolean}[]>(`SELECT EXISTS(SELECT 1 ${join} WHERE ${access.sql} AND w."conversationId"=ANY($${access.values.length+1}::uuid[])) AS relevant`,...access.values,ids.slice(0,100));return result.relevant;}),
    forConversation:(a:AttentionWorkActor,conversationId:string)=>transaction(a,async db=>{const access=scope(a),[found]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT w.id ${join} WHERE ${access.sql} AND w."conversationId"=$${access.values.length+1}::uuid`,...access.values,attentionUuid(conversationId));return found?detail(db,a,await row(db,a,found.id)):null;}),
    media:(a:AttentionWorkActor,id:string,fileId:string)=>transaction(a,async db=>{await row(db,a,id);const [file]=await db.$queryRawUnsafe<{content:Uint8Array;mimeType:string}[]>(`SELECT content,"mimeType" FROM "AttentionWorkFile" WHERE id=$1::uuid AND "workId"=$2::uuid`,attentionUuid(fileId),id);if(!file)throw new AttentionError("Archivo no encontrado.",404);return file;}),
    attach:(a:AttentionWorkActor,id:string,input:{requestId:string;version:number;fileName:string;mimeType:string;content:Uint8Array})=>transaction(a,async db=>{
      const r=await row(db,a,id),who=identity(a),staff=a.type==="attention";
      if(!staff&&a.sellerId!==r.sellerId)throw new AttentionError("Solo el asesor titular puede enviar soportes.",403);
      if(!["image/jpeg","image/png","application/pdf"].includes(input.mimeType))throw new AttentionError("Adjunta JPG, PNG o PDF.",415);
      const kind=input.mimeType==="application/pdf"?"document":"image",fileName=attentionText(input.fileName,180);
      validateMetaAttentionMedia({bytes:input.content,mimeType:input.mimeType,fileName,kind});
      const req=await intent(db,a,input.requestId,{action:"WORK_FILE",id,version:input.version,fileName,mimeType:input.mimeType,hash:createHash("sha256").update(input.content).digest("hex")});
      if(req.replay)return detail(db,a,await row(db,a,req.replay));
      if(r.state==="completed"||r.version!==input.version)throw new AttentionError("La solicitud cambió o está finalizada. Actualiza antes de adjuntar.",409);
      const [quota]=await db.$queryRawUnsafe<{n:number;size:number}[]>(`SELECT count(*)::int AS n,COALESCE(sum(octet_length(content)),0)::int AS size FROM "AttentionWorkFile" WHERE "workId"=$1::uuid`,id);
      if(quota.n>=100||quota.size+input.content.length>100*1024*1024)throw new AttentionError("Esta solicitud alcanzó el límite de soportes (100 archivos / 100 MB).",409);
      const fileId=randomUUID();await db.$queryRawUnsafe(`INSERT INTO "AttentionWorkFile"(id,"workId",content,"mimeType") VALUES($1::uuid,$2::uuid,$3,$4) RETURNING id`,fileId,id,Buffer.from(input.content),input.mimeType);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,attachment) VALUES($1::uuid,$2::uuid,$3,$4,'',now(),$5,$6::jsonb) RETURNING id`,randomUUID(),r.conversationId,`work:${req.id}`,staff?"outbound":"inbound",who.name,JSON.stringify({id:fileId,kind,fileName,mimeType:input.mimeType,url:`/api/${staff?"atencion/solicitudes":"ventas/atencion"}/${id}/files/${fileId}`}));
      await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,id);
      await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=now(),"lastContactAt"=now() WHERE id=$1::uuid RETURNING id`,r.conversationId);
      await audit(db,a,r,req.id,"WORK_FILE");return detail(db,a,await row(db,a,id));
    }),
    list:(a:AttentionWorkActor,kind:AttentionWorkKind,page=1)=>transaction(a,async db=>{parseWorkKind(kind);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new AttentionError("Página inválida.");const access=scope(a),n=access.values.length;
      const rows=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected} ${join} WHERE ${access.sql} AND w.kind=$${n+1} ORDER BY w."updatedAt" DESC,w.id LIMIT 40 OFFSET $${n+2}`,...access.values,kind,(page-1)*40);
      const [total]=await db.$queryRawUnsafe<{count:number}[]>(`SELECT count(*)::int AS count ${join} WHERE ${access.sql} AND w.kind=$${n+1}`,...access.values,kind);return {items:rows.map(dto),total:total.count,page,pageSize:40};}),
    detail:(a:AttentionWorkActor,id:string)=>transaction(a,async db=>detail(db,a,await row(db,a,id))),
    create:(a:AttentionWorkActor,input:Record<string,unknown>)=>transaction(a,async db=>{
      if(a.type!=="seller")throw new AttentionError("La solicitud debe iniciarse desde el perfil del asesor titular.",403);
      if(Object.keys(input).some(k=>!["requestId","kind","target","text"].includes(k)))throw new AttentionError("La solicitud contiene campos no admitidos.");
      const kind=parseWorkKind(input.kind),ref=parseWorkTarget(input.target),text=attentionText(input.text||"",4000,false),t=await target(db,ref.source,ref.id);
      if(t.sellerId!==a.sellerId||t.aliadoId!==a.aliadoId)throw new AttentionError("Solo el asesor titular puede solicitar la gestión de esta venta.",403);
      if(kind==="enrollment"&&(ref.source!=="D"||t.platform!=="IPHONE"))throw new AttentionError("Selecciona una solicitud de iPhone para pedir enrolamiento.");
      if(kind==="welcome"&&ref.source!=="C")throw new AttentionError("Selecciona el crédito del cliente para solicitar su bienvenida.");
      if(["CANCELADA","ANULADO","ANULADA","RECHAZADA","RECHAZADO"].includes(t.state.toUpperCase()))throw new AttentionError("La operación está cancelada o rechazada.",409);
      const request=await intent(db,a,input.requestId,{action:"WORK_CREATE",kind,target:input.target,text});if(request.replay)return detail(db,a,await row(db,a,request.replay));
      await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention:work:${kind}:${input.target}`);
      const [existing]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionWorkRequest" WHERE kind=$1 AND "targetSource"=$2 AND "targetId"=$3 AND state<>'completed'`,kind,ref.source,ref.id);
      if(existing){const r=await row(db,a,existing.id);await audit(db,a,r,request.id,"WORK_REUSED");return detail(db,a,r);}
      const id=randomUUID(),conversationId=randomUUID();
      await db.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,name,"sedeId",mode,"lastContactAt") VALUES($1::uuid,'internal',$2,$3,'human',now()) RETURNING id`,conversationId,t.name||"Solicitud comercial",t.sedeId);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionWorkRequest"(id,"conversationId",kind,"targetSource","targetId","sellerId","userId","sedeId","aliadoId") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,id,conversationId,kind,ref.source,ref.id,a.sellerId,a.userId,t.sedeId,t.aliadoId);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1::uuid,$2::uuid,$3,'inbound',$4,now(),$5) RETURNING id`,randomUUID(),conversationId,`work:${request.id}`,`${attentionWorkKinds[kind]}${text?`\n${text}`:""}`,a.name);
      const r=await row(db,a,id);await audit(db,a,r,request.id,"WORK_CREATED",{state:"pending"});return detail(db,a,r);
    }),
    mutate:(a:AttentionWorkActor,id:string,input:Record<string,unknown>)=>transaction(a,async db=>{
      const r=await row(db,a,id),who=identity(a);if(Object.keys(input).some(k=>!["requestId","version","action","text","state","assigneeKey","callMode"].includes(k)))throw new AttentionError("Cambio no válido.");
      const action=String(input.action),staff=a.type==="attention";
      if(!["message","note","state","assign","call_mode"].includes(action)||!Number.isSafeInteger(input.version))throw new AttentionError("Acción inválida.");
      if(!staff&&(action!=="message"||a.sellerId!==r.sellerId))throw new AttentionError("No tienes permiso para realizar este cambio.",403);
      const req=await intent(db,a,input.requestId,{workId:id,...input});if(req.replay)return detail(db,a,await row(db,a,req.replay));
      if(input.version!==r.version)throw new AttentionError("La solicitud cambió. Actualiza y revisa antes de continuar.",409);
      if(r.state==="completed"&&action!=="state")throw new AttentionError("La solicitud está finalizada.",409);
      let event="WORK_MESSAGE",meta:object={};
      if(action==="message"||action==="note"){
        const text=attentionText(input.text,4000),messageId=randomUUID();
        if(action==="note")await db.$queryRawUnsafe(`INSERT INTO "AttentionNote"(id,"conversationId",text,author,"userId") VALUES($1::uuid,$2::uuid,$3,$4,$5) RETURNING id`,messageId,r.conversationId,text,who.name,who.userId);
        else await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1::uuid,$2::uuid,$3,$4,$5,now(),$6) RETURNING id`,messageId,r.conversationId,`work:${req.id}`,staff?"outbound":"inbound",text,who.name);
        event=action==="note"?"WORK_NOTE":"WORK_MESSAGE";
      }else if(action==="state"){
        if(!Object.hasOwn(attentionWorkStates,String(input.state)))throw new AttentionError("Estado no válido.");
        const text=attentionText(input.text,4000);
        await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET state=$2 WHERE id=$1::uuid RETURNING id`,id,input.state);
        await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET status=$2,"closedAt"=CASE WHEN $2='closed' THEN now() ELSE NULL END WHERE id=$1::uuid RETURNING id`,r.conversationId,input.state==="completed"?"closed":r.assigneeKey?"open":"pending");
        await db.$queryRawUnsafe(`INSERT INTO "AttentionNote"(id,"conversationId",text,author,"userId") VALUES($1::uuid,$2::uuid,$3,$4,$5) RETURNING id`,randomUUID(),r.conversationId,text,who.name,who.userId);
        event="WORK_STATE";meta={state:input.state};
      }else if(action==="assign"){
        if(a.type!=="attention"||!a.actor.central)throw new AttentionError("Solo administración central puede asignar o transferir esta solicitud.",403);
        if(typeof input.assigneeKey!=="string"||!/^analyst:[1-9]\d{0,9}$/.test(input.assigneeKey))throw new AttentionError("Selecciona un analista.");
        const analystId=Number(input.assigneeKey.split(":")[1]);
        const [assignee]=await db.$queryRawUnsafe<{name:string}[]>(`SELECT u.nombre AS name FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.id=$1 AND u.activo AND s.activa AND a.activo AND upper(trim(a.codigo))='FINSERPAY' AND upper(trim(r.nombre))='ANALISTA_APROBACION' FOR SHARE OF u,r,s,a`,analystId);
        if(!assignee)throw new AttentionError("El analista no está activo.",403);
        await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET "assigneeUserId"=$2,"assigneeKey"=$3,"assigneeName"=$4,"assigneeSellerId"=NULL,status='open',"closedAt"=NULL WHERE id=$1::uuid RETURNING id`,r.conversationId,analystId,input.assigneeKey,assignee.name);
        event="WORK_ASSIGNED";meta={assigneeKey:input.assigneeKey};
      }else{
        if(r.kind!=="welcome"||!["human","dapta","undecided"].includes(String(input.callMode)))throw new AttentionError("Modalidad de bienvenida inválida.");
        await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET "callMode"=$2 WHERE id=$1::uuid RETURNING id`,id,input.callMode);event="WORK_CALL_MODE";meta={callMode:input.callMode};
      }
      await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,id);
      await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=now(),"lastContactAt"=CASE WHEN $2 THEN now() ELSE "lastContactAt" END WHERE id=$1::uuid RETURNING id`,r.conversationId,action==="message");
      await audit(db,a,r,req.id,event,meta);return detail(db,a,await row(db,a,id));
    }),
  };
}
export async function attentionWorkStore(){const {default:prisma}=await import("./prisma");return createAttentionWorkStore(prisma as unknown as AttentionDatabase);}
