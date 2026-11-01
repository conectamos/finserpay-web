import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { AttentionError, attentionText, attentionUuid } from "./atencion-core";
import { type AttentionDatabase, type AttentionDb } from "./atencion-storage";
import { assertAttentionWorkCurrentActor } from "./atencion-work-actor";
import { notifyAttentionWork } from "./atencion-work-notifications";
import { attentionWorkKinds, attentionWorkStates, type AttentionWorkActor, type AttentionWorkDetail, type AttentionWorkItem, type AttentionWorkKind, type AttentionWorkListFilters, type AttentionWorkSummary } from "./atencion-work-types";
import type { AttentionActor, AttentionMessage, AttentionNote } from "./atencion-types";
import { validateMetaAttentionMedia } from "./atencion-meta";
import { attentionUnreadPredicate } from "./atencion-team-read";

type Row = AttentionWorkItem & { targetSource: "D" | "C"; targetId: number; sellerId: number; userId: number; sedeId: number; aliadoId: number };
type Target = { id:number; name:string; document:string|null; imei:string|null; deviceReference:string|null; platform:string|null; state:string; sellerId:number|null; sedeId:number; aliadoId:number; advisor:string; ally:string; branch:string };
export type AttentionWorkWorkflowContext = {db:AttentionDb;actor:AttentionActor;work:Row;target:Target};
type WorkFileInput={requestId:string;version?:number;fileName:string;mimeType:string;content:Uint8Array;captureSessionId?:string};
export type AttentionWorkCaptureContext={db:AttentionDb;actor:AttentionWorkActor;workId:string;conversationId:string;version:number;closed:boolean;bindingHash:string;attach:(input:WorkFileInput)=>Promise<{fileId:string;alreadyApplied:boolean}>};
const identity = (a:AttentionWorkActor) => a.type === "attention" ? {userId:a.actor.userId,sellerId:null,key:a.actor.key,name:a.actor.name} : a;
const iso = (value:unknown) => new Date(value as string).toISOString();
const currentNameSql = `COALESCE(CASE w."targetSource" WHEN 'D' THEN
  (SELECT NULLIF(t."clienteNombre",'') FROM "CreditoBorrador" t WHERE t.id=w."targetId")
  WHEN 'C' THEN (SELECT NULLIF(t."clienteNombre",'') FROM "Credito" t WHERE t.id=w."targetId") END,c.name)`;
const previewSql = `CASE WHEN NULLIF(btrim(m.text),'') IS NOT NULL THEN left(m.text,160)
  ELSE CASE m.attachment->>'kind' WHEN 'image' THEN 'Imagen' WHEN 'audio' THEN 'Audio' WHEN 'video' THEN 'Video'
    WHEN 'document' THEN 'Documento' WHEN 'sticker' THEN 'Sticker' ELSE NULL END END`;
const selected = `w.*,${currentNameSql} AS name,c."assigneeName" AS assignee,c."assigneeKey",c.status AS "conversationStatus",
  v.nombre AS advisor,a.nombre AS ally,s.nombre AS branch,
  (SELECT ${previewSql} FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS preview,
  (SELECT m."sentAt" FROM "AttentionMessage" m WHERE m."conversationId"=c.id ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS "lastMessageAt"`;
const join = `FROM "AttentionWorkRequest" w JOIN "AttentionConversation" c ON c.id=w."conversationId" JOIN "Vendedor" v ON v.id=w."sellerId" JOIN "Sede" s ON s.id=w."sedeId" JOIN "Aliado" a ON a.id=w."aliadoId"`;
function dto(r:Row):AttentionWorkItem{return {id:r.id,conversationId:r.conversationId,kind:r.kind,target:`${r.targetSource}-${r.targetId}`,state:r.state,callMode:r.callMode,name:r.name,advisor:r.advisor,ally:r.ally,branch:r.branch,assignee:r.assignee,assigneeKey:r.assigneeKey,version:r.version,createdAt:iso(r.createdAt),updatedAt:iso(r.updatedAt),
  preview:r.preview??null,lastMessageAt:r.lastMessageAt?iso(r.lastMessageAt):null,conversationStatus:r.conversationStatus,
  ...(typeof r.unreadCount==="number"?{unreadCount:r.unreadCount}:{})};}
function scope(a:AttentionWorkActor){return a.type === "attention" ? {sql:`($1::boolean OR (c."assigneeUserId"=$2 AND c."assigneeKey"=$3 AND c."assigneeSellerId" IS NULL))`,values:[a.actor.central,a.actor.userId,a.actor.key]} : {sql:`w."aliadoId"=$1 AND (w."sellerId"=$2 OR ($3::boolean AND w."sedeId"=$4)) AND EXISTS(SELECT 1 FROM (SELECT 'D' AS source,id,"vendedorId","sedeId" FROM "CreditoBorrador" UNION ALL SELECT 'C',id,"vendedorId","sedeId" FROM "Credito") owner JOIN "Sede" os ON os.id=owner."sedeId" WHERE owner.source=w."targetSource" AND owner.id=w."targetId" AND os."aliadoId"=$1 AND (owner."vendedorId"=$2 OR ($3::boolean AND owner."sedeId"=$4)))`,values:[a.aliadoId,a.sellerId,a.supervisor,a.sedeId]};}
function unreadSql(a:AttentionWorkActor){return a.type==="attention"?`(SELECT count(*)::integer FROM "AttentionMessage" m WHERE m."conversationId"=c.id AND m.direction='inbound' AND ${attentionUnreadPredicate})`:"NULL::integer";}
function workListFilters(input:Partial<AttentionWorkListFilters>={}):AttentionWorkListFilters{
  if(!input||typeof input!=="object"||Array.isArray(input))throw new AttentionError("Filtros de solicitud inválidos.");
  const search=attentionText(input.search??"",120,false).normalize("NFKC"),filter=input.filter??"all",state=input.state??"";
  if(!["all","unread","unassigned"].includes(filter)||state!==""&&state!=="active"&&!Object.hasOwn(attentionWorkStates,state))throw new AttentionError("Filtros de solicitud inválidos.");
  return {search,filter,state};
}
export function parseWorkListQuery(params:URLSearchParams){
  if(["kind","page","search","filter","state"].some(key=>params.getAll(key).length>1))throw new AttentionError("No repitas parámetros de solicitudes.");
  const page=params.get("page")||"1";
  if(!/^\d+$/.test(page)||Number(page)<1||Number(page)>10000)throw new AttentionError("Página inválida.");
  return {kind:parseWorkKind(params.get("kind")||"enrollment"),page:Number(page),filters:workListFilters({search:params.get("search")||"",filter:(params.get("filter")||"all") as AttentionWorkListFilters["filter"],state:(params.get("state")||"") as AttentionWorkListFilters["state"]})};
}
export function parseWorkTarget(value:unknown){const match=typeof value==="string"?/^([DC])-([1-9]\d{0,9})$/.exec(value):null;if(!match)throw new AttentionError("Selecciona una solicitud o crédito existente.");return {source:match[1] as "D"|"C",id:Number(match[2])};}
export function parseWorkKind(value:unknown):AttentionWorkKind{if(value!=="enrollment"&&value!=="welcome")throw new AttentionError("Tipo de solicitud inválido.");return value;}
export function parseWorkSummaryQuery(params:URLSearchParams){
  if([...params.keys()].some(key=>key!=="target")||params.getAll("target").length!==1)throw new AttentionError("Indica una sola operación vinculada.");
  const ref=parseWorkTarget(params.get("target"));
  if(ref.source!=="C"||ref.id>2147483647)throw new AttentionError("Selecciona el crédito de la bienvenida.");
  return `C-${ref.id}`;
}
async function target(db:AttentionDb,source:"D"|"C",id:number,lock=true):Promise<Target>{
  const table=source==="D"?'"CreditoBorrador"':'"Credito"';
  const equipment=source==="D"?"to_jsonb(d)->'payload'":"to_jsonb(d)";
  const reference=`COALESCE(NULLIF(btrim(${equipment}->>'referenciaEquipo'),''),NULLIF(concat_ws(' ',NULLIF(btrim(${equipment}->>'equipoMarca'),''),NULLIF(btrim(${equipment}->>'equipoModelo'),'')),''))`;
  const [r]=await db.$queryRawUnsafe<Target[]>(`SELECT d.id,d."clienteNombre" AS name,d."clienteDocumento" AS document,d.imei,${reference} AS "deviceReference",upper(COALESCE(to_jsonb(d)->>'plataforma',to_jsonb(d)->'contratoSnapshot'->>'plataforma','')) AS platform,d.estado AS state,d."vendedorId" AS "sellerId",d."sedeId",s."aliadoId",v.nombre AS advisor,a.nombre AS ally,s.nombre AS branch FROM ${table} d JOIN "Sede" s ON s.id=d."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" LEFT JOIN "Vendedor" v ON v.id=d."vendedorId" WHERE d.id=$1 ${lock?"FOR SHARE OF d,s,a":""}`,id);
  if(!r)throw new AttentionError("La operación vinculada ya no está disponible.",404);return r;
}
/** Resolve the real commercial notification account; the acting administrator remains the audit author. */
async function centralEnrollmentOwner(db:AttentionDb,t:Target):Promise<{sellerId:number;userId:number}>{
  const invalidSeller="Asigna un asesor titular activo a la sede de la venta antes de solicitar el enrolamiento.";
  if(!Number.isSafeInteger(t.sellerId)||Number(t.sellerId)<1)throw new AttentionError(invalidSeller,409);
  const [seller]=await db.$queryRawUnsafe<{id:number}[]>(`SELECT v.id FROM "Vendedor" v
    JOIN "SedeVendedor" sv ON sv."vendedorId"=v.id JOIN "Sede" s ON s.id=sv."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId"
    WHERE v.id=$1 AND s.id=$2 AND a.id=$3 AND v.activo AND NOT v."debeCambiarPin"
    AND upper(trim(v."tipoPerfil")) IN ('VENDEDOR','SUPERVISOR') AND sv.activo AND s.activa AND a.activo
    FOR SHARE OF v,sv,s,a`,t.sellerId,t.sedeId,t.aliadoId);
  if(!seller)throw new AttentionError(invalidSeller,409);
  const [origin]=await db.$queryRawUnsafe<{id:number;active:boolean;siteActive:boolean;allyActive:boolean;allyId:number;role:string;allyCode:string}[]>(`SELECT u.id,u.activo AS active,
    s.activa AS "siteActive",a.activo AS "allyActive",a.id AS "allyId",upper(trim(r.nombre)) AS role,upper(trim(a.codigo)) AS "allyCode"
    FROM "CreditoBorrador" d JOIN "Usuario" u ON u.id=d."usuarioId" JOIN "Rol" r ON r.id=u."rolId"
    JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE d.id=$1 FOR SHARE OF u,r,s,a`,t.id);
  const invalidAccount="La venta no tiene una cuenta comercial activa vinculada. Revisa el acceso de la sede antes de solicitar el enrolamiento.";
  if(!origin)throw new AttentionError(invalidAccount,409);
  if(origin.role!=="ADMIN"||origin.allyCode!=="FINSERPAY"){
    if(!origin.active||!origin.siteActive||!origin.allyActive||origin.allyId!==t.aliadoId||origin.role==="ANALISTA_APROBACION")throw new AttentionError(invalidAccount,409);
    return {sellerId:seller.id,userId:origin.id};
  }
  // Sede administration provisions its commercial access with role USUARIO. An ambiguous site has no canonical fallback.
  const accounts=await db.$queryRawUnsafe<{id:number}[]>(`SELECT u.id FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId"
    JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE s.id=$1 AND a.id=$2
    AND upper(trim(r.nombre))='USUARIO' AND u.activo AND s.activa AND a.activo ORDER BY u.id LIMIT 2 FOR SHARE OF u,r,s,a`,t.sedeId,t.aliadoId);
  if(accounts.length!==1)throw new AttentionError(accounts.length?"La sede tiene varios accesos comerciales activos. Define su cuenta de acceso antes de solicitar el enrolamiento.":invalidAccount,409);
  return {sellerId:seller.id,userId:accounts[0].id};
}
export function createAttentionWorkStore(database:AttentionDatabase){
  async function transaction<T>(a:AttentionWorkActor,run:(db:AttentionDb,current:AttentionWorkActor)=>Promise<T>){return database.$transaction(async db=>{
    a=await assertAttentionWorkCurrentActor(db,a);
    const [schema]=await db.$queryRawUnsafe<{ready:boolean}[]>(`SELECT to_regclass('public."AttentionWorkRequest"') IS NOT NULL AS ready`);
    if(!schema?.ready)throw new AttentionError("La bandeja de solicitudes está pendiente de instalar.",503);
    return run(db,a);
  },{isolationLevel:"ReadCommitted",timeout:20000,maxWait:10000});}
  async function row(db:AttentionDb,a:AttentionWorkActor,id:string){const access=scope(a);const [r]=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected},${unreadSql(a)} AS "unreadCount" ${join} WHERE ${access.sql} AND w.id=$${access.values.length+1}::uuid FOR UPDATE OF w,c`,...access.values,attentionUuid(id));if(!r)throw new AttentionError("Solicitud no encontrada o no autorizada.",404);
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
    const events=await db.$queryRawUnsafe<{id:string;action:string;author:string;at:string;state:string|null}[]>(`SELECT id::text,action,metadata->>'author' AS author,"createdAt" AS at,metadata->>'state' AS state FROM "AttentionAudit" WHERE "conversationId"=$1::uuid AND action IN ('WORK_CREATED','WORK_STATE','WORK_ASSIGNED','WORK_CALL_MODE','WORK_WORKFLOW') ORDER BY "createdAt" DESC,id DESC LIMIT 100`,r.conversationId);
    const team=isStaff&&a.actor.central?await db.$queryRawUnsafe<{key:string;name:string}[]>(`SELECT 'analyst:'||u.id AS key,u.nombre AS name FROM "Usuario" u JOIN "Rol" r ON r.id=u."rolId" JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.activo AND s.activa AND a.activo AND upper(trim(a.codigo))='FINSERPAY' AND upper(trim(r.nombre))='ANALISTA_APROBACION' ORDER BY u.nombre`):[];
    const operationHref=isStaff?(r.kind==="enrollment"?`/dashboard/aprobaciones/enrolamiento?documento=${encodeURIComponent(t.document||"")}&imei=${encodeURIComponent(t.imei||"")}`:`/dashboard/aprobaciones?credito=${r.targetId}`):(r.targetSource==="D"?`/dashboard/creditos?draft=${r.targetId}&mode=create-client`:`/dashboard/solicitudes?id=C-${r.targetId}`);
    return {item:dto({...r,name:t.name}),messages:messages.slice(0,200).reverse().map(m=>({...m,sentAt:iso(m.sentAt),...(m.attachment?{attachment:{...m.attachment,url:`/api/${isStaff?"atencion/solicitudes":"ventas/atencion"}/${r.id}/files/${m.attachment.id}`}}:{})})),notes:notes.map(n=>({...n,createdAt:iso(n.createdAt)})),canManage:isStaff,canWrite:r.state!=="completed"&&(isStaff||a.sellerId===t.sellerId),canAssign:isStaff&&a.actor.central,historyTruncated:messages.length>200,document:t.document,imei:t.imei,deviceReference:t.deviceReference,operationHref,team,events:events.map(e=>({...e,at:iso(e.at)}))};
  }
  async function workflowContext(db:AttentionDb,a:AttentionWorkActor,id:string,kind:AttentionWorkKind,lockTarget=true):Promise<AttentionWorkWorkflowContext>{
    if(a.type!=="attention")throw new AttentionError("Solo el equipo autorizado puede completar esta gestión.",403);
    const work=await row(db,a,id);if(work.kind!==kind||work.targetSource!==(kind==="enrollment"?"D":"C"))throw new AttentionError("La solicitud no corresponde a esta gestión.",409);
    const t=await target(db,work.targetSource,work.targetId,lockTarget);
    if(t.sellerId!==work.sellerId||t.sedeId!==work.sedeId||t.aliadoId!==work.aliadoId)throw new AttentionError("La venta cambió de asesor o sede. Revisa la vinculación antes de continuar.",409);
    return {db,actor:a.actor,work,target:t};
  }
  /** Same atomic file/message/quota path for authenticated uploads and scoped QR captures. */
  async function attachInTransaction(db:AttentionDb,a:AttentionWorkActor,r:Row,input:WorkFileInput){
    const id=r.id,who=identity(a),staff=a.type==="attention";
    if(!staff&&a.sellerId!==r.sellerId)throw new AttentionError("Solo el asesor titular puede enviar soportes.",403);
    if(!["image/jpeg","image/png","application/pdf"].includes(input.mimeType))throw new AttentionError("Adjunta JPG, PNG o PDF.",415);
    const kind=input.mimeType==="application/pdf"?"document":"image",fileName=attentionText(input.fileName,180);
    validateMetaAttentionMedia({bytes:input.content,mimeType:input.mimeType,fileName,kind});
    const hash=createHash("sha256").update(input.content).digest("hex");
    const req=await intent(db,a,input.requestId,input.captureSessionId
      ?{action:"WORK_CAPTURE_FILE",id,captureSessionId:input.captureSessionId,fileName,mimeType:input.mimeType,hash}
      :{action:"WORK_FILE",id,version:input.version,fileName,mimeType:input.mimeType,hash});
    const externalId=input.captureSessionId?`capture:${input.captureSessionId}:${req.id}`:`work:${req.id}`;
    if(req.replay){
      const [message]=await db.$queryRawUnsafe<{fileId:string}[]>(`SELECT attachment->>'id' AS "fileId" FROM "AttentionMessage" WHERE "conversationId"=$1::uuid AND "externalId"=$2`,r.conversationId,externalId);
      if(req.replay!==r.id||!message?.fileId)throw new AttentionError("No se encontró el archivo de este intento. Actualiza la solicitud.",409);
      return {fileId:message.fileId,alreadyApplied:true};
    }
    if(r.state==="completed"||(!input.captureSessionId&&r.version!==input.version))throw new AttentionError("La solicitud cambió o está finalizada. Actualiza antes de adjuntar.",409);
    const [quota]=await db.$queryRawUnsafe<{n:number;size:number}[]>(`SELECT count(*)::int AS n,COALESCE(sum(octet_length(content)),0)::int AS size FROM "AttentionWorkFile" WHERE "workId"=$1::uuid`,id);
    if(quota.n>=100||quota.size+input.content.length>100*1024*1024)throw new AttentionError("Esta solicitud alcanzó el límite de soportes (100 archivos / 100 MB).",409);
    const fileId=randomUUID();await db.$queryRawUnsafe(`INSERT INTO "AttentionWorkFile"(id,"workId",content,"mimeType") VALUES($1::uuid,$2::uuid,$3,$4) RETURNING id`,fileId,id,Buffer.from(input.content),input.mimeType);
    await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author,attachment) VALUES($1::uuid,$2::uuid,$3,$4,'',now(),$5,$6::jsonb) RETURNING id`,randomUUID(),r.conversationId,externalId,staff?"outbound":"inbound",who.name,JSON.stringify({id:fileId,kind,fileName,mimeType:input.mimeType,url:`/api/${staff?"atencion/solicitudes":"ventas/atencion"}/${id}/files/${fileId}`}));
    await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,id);
    await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET version=version+1,"updatedAt"=now(),"lastContactAt"=now() WHERE id=$1::uuid RETURNING id`,r.conversationId);
    await audit(db,a,r,req.id,"WORK_FILE",input.captureSessionId?{source:"qr_capture",captureSessionId:input.captureSessionId}:{});
    await notifyAttentionWork(db,a,r,`file:${req.id}`,staff?"reply":"followup");
    return {fileId,alreadyApplied:false};
  }
  return {
    summary:async(a:AttentionWorkActor,id:string,expectedTarget:string):Promise<AttentionWorkSummary>=>{
      if(a.type!=="attention")throw new AttentionError("Usa tu cuenta personal de Atención.",403);
      const ref=parseWorkTarget(expectedTarget);
      if(ref.source!=="C"||ref.id>2147483647)throw new AttentionError("Selecciona el crédito de la bienvenida.");
      return transaction(a,async(db,current)=>{
        const access=scope(current);
        type SummaryRow=Omit<AttentionWorkSummary,"target">;
        const [result]=await db.$queryRawUnsafe<SummaryRow[]>(`SELECT w.id AS "workId",w.kind,
          ${unreadSql(current)} AS "unreadCount",
          (SELECT json_build_object('id',m.id,'sentAt',to_char(m."sentAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM "AttentionMessage" m
            WHERE m."conversationId"=c.id AND m.direction='inbound' ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS "lastInbound",
          (SELECT json_build_object('id',m.id,'sentAt',to_char(m."sentAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) FROM "AttentionMessage" m
            WHERE m."conversationId"=c.id AND m.direction='inbound' AND ${attentionUnreadPredicate}
            ORDER BY m."sentAt" DESC,m.id DESC LIMIT 1) AS "lastUnreadInbound"
          ${join} JOIN "Credito" owner ON owner.id=w."targetId"
          JOIN "Sede" owner_sede ON owner_sede.id=owner."sedeId"
          WHERE ${access.sql} AND w.id=$${access.values.length+1}::uuid
          AND w.kind='welcome' AND w."targetSource"='C' AND w."targetId"=$${access.values.length+2}
          AND owner."vendedorId"=w."sellerId" AND owner."sedeId"=w."sedeId" AND owner_sede."aliadoId"=w."aliadoId"`,
        ...access.values,attentionUuid(id),ref.id);
        if(!result)throw new AttentionError("Solicitud no encontrada o no autorizada para este crédito.",404);
        // Preserve SQL microseconds so cursor ordering matches sentAt,id without inventing an advance on reads.
        const marker=(value:SummaryRow["lastInbound"])=>value?{id:value.id,sentAt:value.sentAt}:null;
        return {workId:result.workId,kind:"welcome",target:`C-${ref.id}`,unreadCount:result.unreadCount,
          lastInbound:marker(result.lastInbound),lastUnreadInbound:marker(result.lastUnreadInbound)};
      });
    },
    captureAccess:<T>(a:AttentionWorkActor,id:string,run:(context:AttentionWorkCaptureContext)=>Promise<T>)=>transaction(a,async(db,current)=>{
      const r=await row(db,current,id),t=await target(db,r.targetSource,r.targetId);
      if(current.type==="seller"&&current.sellerId!==t.sellerId)throw new AttentionError("Solo el asesor titular puede enviar soportes.",403);
      if(t.sellerId!==r.sellerId||t.sedeId!==r.sedeId||t.aliadoId!==r.aliadoId)throw new AttentionError("La venta cambió de asesor o sede. Abre una nueva captura desde la solicitud vigente.",409);
      const [assignment]=await db.$queryRawUnsafe<{revision:string}[]>(`SELECT COALESCE(max(id),0)::text AS revision FROM "AttentionAudit" WHERE "conversationId"=$1::uuid AND (action='WORK_ASSIGNED' OR (action IN ('WORK_STATE','WORK_WORKFLOW') AND metadata->>'state'='completed'))`,r.conversationId);
      const bindingHash=createHash("sha256").update(JSON.stringify([r.id,r.targetSource,r.targetId,r.sellerId,r.userId,r.sedeId,r.aliadoId,t.document,t.imei,t.platform,r.assigneeKey,assignment.revision])).digest("hex");
      return run({db,actor:current,workId:r.id,conversationId:r.conversationId,version:r.version,closed:r.state==="completed",bindingHash,attach:input=>attachInTransaction(db,current,r,input)});
    }),
    workflowRead:<T>(a:AttentionWorkActor,id:string,kind:AttentionWorkKind,run:(context:AttentionWorkWorkflowContext)=>Promise<T>)=>transaction(a,async db=>{
      const context=await workflowContext(db,a,id,kind,false),result=await run(context),finalContext=await workflowContext(db,a,id,kind);
      if(finalContext.target.document!==context.target.document||finalContext.target.imei!==context.target.imei)throw new AttentionError("La identidad de la operación cambió. Actualiza antes de continuar.",409);
      return result;
    }),
    workflowMutate:<T extends Record<string,unknown>>(a:AttentionWorkActor,id:string,kind:AttentionWorkKind,input:Record<string,unknown>,run:(context:AttentionWorkWorkflowContext)=>Promise<{result:T;summary:string;complete:boolean;nextState?:"review"|"information"}>)=>transaction(a,async db=>{
      const context=await workflowContext(db,a,id,kind,false),r=context.work;
      if(!Number.isSafeInteger(input.version)||Number(input.version)<1)throw new AttentionError("Versión inválida.");
      const req=await intent(db,a,input.requestId,{action:"WORK_WORKFLOW",workId:id,kind,input});
      if(req.replay){
        await workflowContext(db,a,id,kind);
        const [event]=await db.$queryRawUnsafe<{result:T}[]>(`SELECT metadata->'result' AS result FROM "AttentionAudit" WHERE "conversationId"=$1::uuid AND action='WORK_WORKFLOW' AND "actorKey"=$2 AND metadata->>'requestId'=$3 ORDER BY id DESC LIMIT 1`,r.conversationId,identity(a).key,req.id);
        if(!event)throw new AttentionError("No se encontró el resultado de este intento. Actualiza la solicitud.",409);
        return {detail:await detail(db,a,r),result:event.result,alreadyApplied:true};
      }
      if(r.state==="completed"||r.version!==input.version)throw new AttentionError("La solicitud cambió o está finalizada. Actualiza antes de continuar.",409);
      const outcome=await run(context),summary=attentionText(outcome.summary,4000);
      // Domain helpers acquire their own canonical locks first. Recheck ownership/identity under row locks before commit.
      const finalContext=await workflowContext(db,a,id,kind);
      if(finalContext.target.document!==context.target.document||finalContext.target.imei!==context.target.imei)throw new AttentionError("La identidad de la operación cambió. Actualiza antes de continuar.",409);
      const nextState=outcome.complete?"completed":outcome.nextState??r.state;
      if(!Object.hasOwn(attentionWorkStates,nextState))throw new AttentionError("Estado de gestión inválido.");
      await db.$queryRawUnsafe(`UPDATE "AttentionWorkRequest" SET state=$2,version=version+1,"updatedAt"=now() WHERE id=$1::uuid RETURNING id`,r.id,nextState);
      await db.$queryRawUnsafe(`UPDATE "AttentionConversation" SET status=CASE WHEN $2 THEN 'closed' ELSE status END,"closedAt"=CASE WHEN $2 THEN now() ELSE "closedAt" END,version=version+1,"updatedAt"=now(),"lastContactAt"=now() WHERE id=$1::uuid RETURNING id`,r.conversationId,outcome.complete);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1::uuid,$2::uuid,$3,'outbound',$4,now(),$5) RETURNING id`,randomUUID(),r.conversationId,`workflow:${identity(a).key}:${req.id}`,summary,identity(a).name);
      await audit(db,a,r,req.id,"WORK_WORKFLOW",{state:nextState,kind,result:outcome.result});
      await notifyAttentionWork(db,a,r,`workflow:${identity(a).key}:${req.id}`,"reply");
      return {detail:await detail(db,a,await row(db,a,id)),result:outcome.result,alreadyApplied:false};
    }),
    authorizeEvents:(a:AttentionWorkActor,ids:readonly string[])=>transaction(a,async db=>{if(!ids.length)return false;const access=scope(a),[result]=await db.$queryRawUnsafe<{relevant:boolean}[]>(`SELECT EXISTS(SELECT 1 ${join} WHERE ${access.sql} AND w."conversationId"=ANY($${access.values.length+1}::uuid[])) AS relevant`,...access.values,ids.slice(0,100));return result.relevant;}),
    forConversation:(a:AttentionWorkActor,conversationId:string)=>transaction(a,async db=>{const access=scope(a),[found]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT w.id ${join} WHERE ${access.sql} AND w."conversationId"=$${access.values.length+1}::uuid`,...access.values,attentionUuid(conversationId));return found?detail(db,a,await row(db,a,found.id)):null;}),
    media:(a:AttentionWorkActor,id:string,fileId:string)=>transaction(a,async db=>{await row(db,a,id);const [file]=await db.$queryRawUnsafe<{content:Uint8Array;mimeType:string}[]>(`SELECT content,"mimeType" FROM "AttentionWorkFile" WHERE id=$1::uuid AND "workId"=$2::uuid`,attentionUuid(fileId),id);if(!file)throw new AttentionError("Archivo no encontrado.",404);return file;}),
    attach:(a:AttentionWorkActor,id:string,input:{requestId:string;version:number;fileName:string;mimeType:string;content:Uint8Array})=>transaction(a,async db=>{
      const r=await row(db,a,id);await attachInTransaction(db,a,r,input);
      return detail(db,a,await row(db,a,id));
    }),
    list:(a:AttentionWorkActor,kind:AttentionWorkKind,page=1,rawFilters:Partial<AttentionWorkListFilters>={})=>transaction(a,async db=>{parseWorkKind(kind);if(!Number.isSafeInteger(page)||page<1||page>10000)throw new AttentionError("Página inválida.");const access=scope(a),n=access.values.length,filters=workListFilters(rawFilters);
      if(filters.filter==="unread"&&a.type!=="attention")throw new AttentionError("La lectura de mensajes de esta bandeja corresponde al equipo de Atención.",403);
      const search=filters.search?`%${filters.search.replace(/[!%_]/g,char=>`!${char}`)}%`:null;
      const where=`${access.sql} AND w.kind=$${n+1} AND ($${n+2}::text IS NULL OR ${currentNameSql} ILIKE $${n+2} ESCAPE '!' OR a.nombre ILIKE $${n+2} ESCAPE '!' OR v.nombre ILIKE $${n+2} ESCAPE '!' OR s.nombre ILIKE $${n+2} ESCAPE '!')
        AND ($${n+3}::text='all' OR ($${n+3}='unread' AND ${unreadSql(a)}>0) OR ($${n+3}='unassigned' AND c."assigneeKey" IS NULL AND c."assigneeUserId" IS NULL AND c."assigneeSellerId" IS NULL))
        AND ($${n+4}::text='' OR ($${n+4}='active' AND w.state<>'completed') OR w.state=$${n+4})`;
      const values=[...access.values,kind,search,filters.filter,filters.state];
      const rows=await db.$queryRawUnsafe<Row[]>(`SELECT ${selected},${unreadSql(a)} AS "unreadCount" ${join} WHERE ${where} ORDER BY w."updatedAt" DESC,w.id LIMIT 40 OFFSET $${n+5}`,...values,(page-1)*40);
      const [total]=await db.$queryRawUnsafe<{count:number}[]>(`SELECT count(*)::int AS count ${join} WHERE ${where}`,...values);return {items:rows.map(dto),total:total.count,page,pageSize:40};}),
    detail:(a:AttentionWorkActor,id:string)=>transaction(a,async db=>detail(db,a,await row(db,a,id))),
    create:(a:AttentionWorkActor,input:Record<string,unknown>)=>transaction(a,async db=>{
      const central=a.type==="attention"&&a.actor.central;
      if(a.type!=="seller"&&!central)throw new AttentionError("La solicitud debe iniciarse desde el perfil del asesor titular o administración central.",403);
      if(Object.keys(input).some(k=>!["requestId","kind","target","text"].includes(k)))throw new AttentionError("La solicitud contiene campos no admitidos.");
      const kind=parseWorkKind(input.kind),ref=parseWorkTarget(input.target),text=attentionText(input.text||"",4000,false);
      if(central&&(kind!=="enrollment"||ref.source!=="D"))throw new AttentionError("Administración central solo puede solicitar el enrolamiento de un borrador de iPhone.",403);
      const t=await target(db,ref.source,ref.id);
      if(a.type==="seller"&&(t.sellerId!==a.sellerId||t.aliadoId!==a.aliadoId))throw new AttentionError("Solo el asesor titular puede solicitar la gestión de esta venta.",403);
      if(kind==="enrollment"&&(ref.source!=="D"||t.platform!=="IPHONE"))throw new AttentionError("Selecciona una solicitud de iPhone para pedir enrolamiento.");
      if(kind==="welcome"&&ref.source!=="C")throw new AttentionError("Selecciona el crédito del cliente para solicitar su bienvenida.");
      if(["CANCELADA","ANULADO","ANULADA","RECHAZADA","RECHAZADO"].includes(t.state.toUpperCase()))throw new AttentionError("La operación está cancelada o rechazada.",409);
      const owner=a.type==="seller"?{sellerId:a.sellerId,userId:a.userId}:await centralEnrollmentOwner(db,t),who=identity(a);
      const verifyOwner=async(r:Row)=>{
        if(central){
          const changed="La solicitud activa conserva otro asesor, cuenta o sede. Revisa su vinculación antes de solicitar nuevamente el enrolamiento.";
          if(r.sellerId!==owner.sellerId||r.sedeId!==t.sedeId||r.aliadoId!==t.aliadoId)throw new AttentionError(changed,409);
          if(r.userId!==owner.userId){
            const [linked]=await db.$queryRawUnsafe<{id:number}[]>(`SELECT u.id FROM "Usuario" u JOIN "Rol" role ON role.id=u."rolId"
              JOIN "Sede" s ON s.id=u."sedeId" JOIN "Aliado" a ON a.id=s."aliadoId" WHERE u.id=$1 AND a.id=$2
              AND u.activo AND s.activa AND a.activo AND upper(trim(role.nombre))<>'ANALISTA_APROBACION'
              AND NOT(upper(trim(role.nombre))='ADMIN' AND upper(trim(a.codigo))='FINSERPAY') FOR SHARE OF u,role,s,a`,r.userId,t.aliadoId);
            if(!linked)throw new AttentionError(changed,409);
          }
        }
        return r;
      };
      const request=await intent(db,a,input.requestId,{action:"WORK_CREATE",kind,target:input.target,text});if(request.replay)return detail(db,a,await verifyOwner(await row(db,a,request.replay)));
      await db.$queryRawUnsafe(`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))`,`attention:work:${kind}:${input.target}`);
      const [existing]=await db.$queryRawUnsafe<{id:string}[]>(`SELECT id FROM "AttentionWorkRequest" WHERE kind=$1 AND "targetSource"=$2 AND "targetId"=$3 AND state<>'completed'`,kind,ref.source,ref.id);
      if(existing){const r=await verifyOwner(await row(db,a,existing.id));await audit(db,a,r,request.id,"WORK_REUSED");return detail(db,a,r);}
      const id=randomUUID(),conversationId=randomUUID();
      await db.$queryRawUnsafe(`INSERT INTO "AttentionConversation"(id,channel,name,"sedeId",mode,"lastContactAt") VALUES($1::uuid,'internal',$2,$3,'human',now()) RETURNING id`,conversationId,t.name||"Solicitud comercial",t.sedeId);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionWorkRequest"(id,"conversationId",kind,"targetSource","targetId","sellerId","userId","sedeId","aliadoId") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,id,conversationId,kind,ref.source,ref.id,owner.sellerId,owner.userId,t.sedeId,t.aliadoId);
      await db.$queryRawUnsafe(`INSERT INTO "AttentionMessage"(id,"conversationId","externalId",direction,text,"sentAt",author) VALUES($1::uuid,$2::uuid,$3,'inbound',$4,now(),$5) RETURNING id`,randomUUID(),conversationId,`work:${request.id}`,`${attentionWorkKinds[kind]}${text?`\n${text}`:""}`,who.name);
      const r=await row(db,a,id);await audit(db,a,r,request.id,"WORK_CREATED",{state:"pending"});
      await notifyAttentionWork(db,a,r,`created:${request.id}`,"created");return detail(db,a,r);
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
        if(input.state==="completed")throw new AttentionError("Completa la gestión de bienvenida o el checklist de enrolamiento para finalizar esta solicitud.",409);
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
      await audit(db,a,r,req.id,event,meta);
      if(action==="message")await notifyAttentionWork(db,a,r,`message:${req.id}`,staff?"reply":"followup");
      if(action==="assign" && r.assigneeKey!==input.assigneeKey)await notifyAttentionWork(db,a,r,`assigned:${req.id}`,"assigned");
      return detail(db,a,await row(db,a,id));
    }),
  };
}
export async function attentionWorkStore(){const {default:prisma}=await import("./prisma");return createAttentionWorkStore(prisma as unknown as AttentionDatabase);}
