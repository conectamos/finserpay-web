import "server-only";
import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { assertMoraActor, type MoraActor } from "@/lib/analyst-mora-access";
import { ensureAnalystMoraSchema } from "@/lib/analyst-mora-schema";
import { isSameApprovalOrigin } from "@/lib/credit-approval-http";
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const maxBytes=10*1024*1024;
export type MoraSupportSubject={creditoId:number;subjectKind:"GESTION"|"EXCEPCION";subjectId:string};
function subject(creditoId:unknown,subjectKind:unknown,subjectId:unknown):MoraSupportSubject{
  const id=Number(creditoId);
  if(!Number.isSafeInteger(id)||id<1||!["GESTION","EXCEPCION"].includes(String(subjectKind))||!uuid.test(String(subjectId)))
    throw new CreditApprovalError("INVALID_SUPPORT","Selecciona una gestión o excepción válida.");
  return {creditoId:id,subjectKind:subjectKind as MoraSupportSubject["subjectKind"],subjectId:String(subjectId)};
}
export function parseMoraSupportSubject(params:URLSearchParams){return subject(params.get("creditoId"),params.get("subjectKind"),params.get("subjectId"));}
const metadataSql=`SELECT "id"::text,"creditoId","subjectKind","subjectId"::text,"fileName","mimeType","sizeBytes","reason","actorName","createdAt" FROM "CreditMoraSupport"`;
type SupportRow={id:string;creditoId:number;subjectKind:string;subjectId:string;fileName:string;mimeType:string;sizeBytes:number;reason:string;actorName:string;createdAt:Date;bytes?:Buffer;requestHash?:string};
const dto=(row:SupportRow)=>({...row,bytes:undefined,requestHash:undefined,createdAt:row.createdAt.toISOString(),href:"/api/aprobaciones/soportes-mora/"+row.id});
async function assertSubject(db:Pick<typeof prisma,"$queryRawUnsafe">,input:MoraSupportSubject){
  const table=input.subjectKind==="GESTION"?"CreditMoraManagementEvent":"CreditMoraExceptionRequest";
  const rows=await db.$queryRawUnsafe<Array<{id:string}>>(`SELECT "id"::text FROM "${table}" WHERE "id"=$1::uuid AND "creditoId"=$2`,input.subjectId,input.creditoId);
  if(!rows.length)throw new CreditApprovalError("SUPPORT_SUBJECT_NOT_FOUND","La gestión o excepción no existe.",404);
}
export async function listMoraSupports(input:MoraSupportSubject){
  await ensureAnalystMoraSchema();await assertSubject(prisma,input);
  return (await prisma.$queryRawUnsafe<SupportRow[]>(metadataSql+` WHERE "creditoId"=$1 AND "subjectKind"=$2 AND "subjectId"=$3::uuid ORDER BY "createdAt","id"`,input.creditoId,input.subjectKind,input.subjectId)).map(dto);
}
export function moraSupportFileType(bytes:Buffer,name:string){
  if(/\.pdf$/i.test(name)&&bytes.subarray(0,5).toString()==="%PDF-")return "application/pdf";
  if(/\.png$/i.test(name)&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(/\.jpe?g$/i.test(name)&&bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return "image/jpeg";
  throw new CreditApprovalError("INVALID_SUPPORT","Adjunta un PDF, JPG o PNG válido de hasta 10 MB.");
}
export async function saveMoraSupport(request:Request,actor:MoraActor){
  if(!isSameApprovalOrigin(request))throw new CreditApprovalError("INVALID_ORIGIN","La carga debe realizarse desde FINSER PAY.",403);
  const input=subject(request.headers.get("x-credit-id"),request.headers.get("x-subject-kind"),request.headers.get("x-subject-id"));
  const key=request.headers.get("idempotency-key")||"";
  if(!uuid.test(key))throw new CreditApprovalError("INVALID_SUPPORT","Identificador de carga inválido.");
  let fileName="",reason="";
  try {fileName=decodeURIComponent(request.headers.get("x-support-file-name")||"").replace(/[\\/\r\n\x00-\x1f"]/g,"_").slice(0,160);reason=decodeURIComponent(request.headers.get("x-support-reason")||"").trim();}
  catch{throw new CreditApprovalError("INVALID_SUPPORT","Nombre o motivo de soporte inválido.");}
  if(!fileName||reason.length<5||reason.length>1000)throw new CreditApprovalError("INVALID_SUPPORT","Indica el motivo del soporte (5 a 1000 caracteres).");
  if(Number(request.headers.get("content-length"))>maxBytes)throw new CreditApprovalError("SUPPORT_TOO_LARGE","El soporte supera 10 MB.");
  const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader){try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>maxBytes){await reader.cancel();throw new CreditApprovalError("SUPPORT_TOO_LARGE","El soporte supera 10 MB.");}chunks.push(part.value);}}finally{reader.releaseLock();}}
  if(!size)throw new CreditApprovalError("INVALID_SUPPORT","El archivo está vacío.");
  const bytes=Buffer.concat(chunks);const mime=moraSupportFileType(bytes,fileName);
  const hash=createHash("sha256").update(JSON.stringify({...input,key,fileName,reason,actorId:actor.id})).update(bytes).digest("hex");
  await ensureAnalystMoraSchema();
  return prisma.$transaction(async db=>{
    const verified=await assertMoraActor(db,actor);await assertSubject(db,input);
    await db.$queryRawUnsafe(`SELECT "id" FROM "Credito" WHERE "id"=$1 FOR UPDATE`,input.creditoId);
    const prior=await db.$queryRawUnsafe<SupportRow[]>(`SELECT * FROM "CreditMoraSupport" WHERE "idempotencyKey"=$1::uuid`,key);
    if(prior[0]){if(prior[0].requestHash!==hash)throw new CreditApprovalError("IDEMPOTENCY_CONFLICT","La carga ya corresponde a otro soporte.",409);return dto(prior[0]);}
    const rows=await db.$queryRawUnsafe<SupportRow[]>(`INSERT INTO "CreditMoraSupport" ("id","creditoId","subjectKind","subjectId","fileName","mimeType","sizeBytes","bytes","reason","actorUserId","actorName","idempotencyKey","requestHash")
      VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11,$12::uuid,$13) RETURNING *`,randomUUID(),input.creditoId,input.subjectKind,input.subjectId,fileName,mime,size,bytes,reason,verified.id,verified.nombre,key,hash);
    return dto(rows[0]);
  });
}
export async function downloadMoraSupport(id:string){
  if(!uuid.test(id))throw new CreditApprovalError("SUPPORT_NOT_FOUND","Soporte no encontrado.",404);
  await ensureAnalystMoraSchema();
  const rows=await prisma.$queryRawUnsafe<SupportRow[]>(`SELECT * FROM "CreditMoraSupport" WHERE "id"=$1::uuid`,id);
  if(!rows[0])throw new CreditApprovalError("SUPPORT_NOT_FOUND","Soporte no encontrado.",404);
  return rows[0];
}
