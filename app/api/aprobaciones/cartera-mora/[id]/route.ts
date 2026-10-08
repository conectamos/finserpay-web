import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { getMoraManagement, createMoraManagement, parseMoraManagement } from "@/lib/analyst-mora-management";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
type Context = { params: Promise<{id:string}> };
export async function GET(_request:Request,context:Context) {
  try { const actor=await getMoraActor(); const {id}=await context.params; return NextResponse.json({ok:true,...await getMoraManagement(Number(id)), currentResponsible: {id:actor.id,nombre:actor.nombre}},{headers:approvalPrivateHeaders}); }
  catch(error){return approvalErrorResponse(error);}
}
export async function POST(request:Request,context:Context) {
  try { const actor=await getMoraActor(); const {id}=await context.params; const input=parseMoraManagement(await readApprovalRequest(request,{maxBytes:10000})); return NextResponse.json({ok:true,...await createMoraManagement(Number(id),input,actor)},{headers:approvalPrivateHeaders}); }
  catch(error){return approvalErrorResponse(error);}
}
