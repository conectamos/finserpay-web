import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { listMoraSupports,parseMoraSupportSubject,saveMoraSupport } from "@/lib/analyst-mora-support";
import { approvalErrorResponse,approvalPrivateHeaders } from "@/lib/credit-approval-http";
export async function GET(request:Request){try{await getMoraActor();return NextResponse.json({ok:true,items:await listMoraSupports(parseMoraSupportSubject(new URL(request.url).searchParams))},{headers:approvalPrivateHeaders});}catch(error){return approvalErrorResponse(error);}}
export async function POST(request:Request){try{const actor=await getMoraActor();return NextResponse.json({ok:true,item:await saveMoraSupport(request,actor)},{status:201,headers:approvalPrivateHeaders});}catch(error){return approvalErrorResponse(error);}}
