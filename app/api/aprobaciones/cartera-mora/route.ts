import { NextResponse } from "next/server";
import { getMoraActor } from "@/lib/analyst-mora-access";
import { listMoraPortfolio } from "@/lib/analyst-mora-management";
import { approvalErrorResponse, approvalPrivateHeaders } from "@/lib/credit-approval-http";
export async function GET(request: Request) {
  try { await getMoraActor(); return NextResponse.json({ok:true,...await listMoraPortfolio(new URL(request.url).searchParams)},{headers:approvalPrivateHeaders}); }
  catch(error){return approvalErrorResponse(error);}
}
