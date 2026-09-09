import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { exchangeSharedApprovalLink } from "@/lib/approval-shared-access";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { APPROVAL_SHARED_COOKIE_NAME, APPROVAL_SHARED_SESSION_MAX_AGE_SECONDS, createApprovalSharedSessionToken, verifyApprovalSharedToken, getSessionCookieOptions } from "@/lib/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const buckets = new Map<string,{start:number,count:number}>();
function consume(grantId:string) {
  const now=Date.now();
  for(const [key,bucket] of buckets) if(now-bucket.start>=900_000) buckets.delete(key);
  if(!buckets.has(grantId)&&buckets.size>=1024) buckets.delete(buckets.keys().next().value!);
  const bucket=buckets.get(grantId)||{start:now,count:0}; bucket.count++;buckets.set(grantId,bucket);
  return bucket.count<=600;
}
export async function POST(request:Request) {
  try {
    if(!request.headers.get("origin")||!/^application\/json(?:;|$)/i.test(request.headers.get("content-type")||"")) throw new CreditApprovalError("INVALID_ORIGIN","Abre el enlace desde FINSER PAY.",403);
    const body=await readApprovalRequest(request);
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).join(",")!=="token") throw new CreditApprovalError("INVALID_ACCESS_LINK","El enlace no es válido o fue revocado.",401);
    const token=(body as {token:unknown}).token,parsed=verifyApprovalSharedToken(token);
    if(!parsed) throw new CreditApprovalError("INVALID_ACCESS_LINK","El enlace no es válido o fue revocado.",401);
    if(!consume(parsed.grantId)) return NextResponse.json({ok:false,error:"Demasiados accesos. Intenta más tarde."},{status:429,headers:{...approvalPrivateHeaders,"Retry-After":"900"}});
    const session=await prisma.$transaction(db=>exchangeSharedApprovalLink(db,token));
    const response=NextResponse.json({ok:true,destination:"/revision-creditos"},{headers:{...approvalPrivateHeaders,"Referrer-Policy":"no-referrer",Vary:"Cookie"}});
    response.cookies.set(APPROVAL_SHARED_COOKIE_NAME,createApprovalSharedSessionToken(session.grantId,session.sessionId,session.expiresAt),{...getSessionCookieOptions(),maxAge:APPROVAL_SHARED_SESSION_MAX_AGE_SECONDS});
    return response;
  } catch(error){return approvalErrorResponse(error);}
}
