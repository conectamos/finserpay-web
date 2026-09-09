import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { revokeSharedApprovalSession } from "@/lib/approval-shared-access";
import { APPROVAL_SHARED_COOKIE_NAME, verifyApprovalSharedSessionToken, getSessionCookieOptions } from "@/lib/session";
import { readApprovalRequest, approvalPrivateHeaders, approvalErrorResponse } from "@/lib/credit-approval-http";
export async function POST(request:Request) {
  try {
    await readApprovalRequest(request);
    const session=verifyApprovalSharedSessionToken((await cookies()).get(APPROVAL_SHARED_COOKIE_NAME)?.value);
    if(session) await revokeSharedApprovalSession(prisma,session.grantId,session.sessionId);
    const response=NextResponse.json({ok:true},{headers:approvalPrivateHeaders});
    response.cookies.set(APPROVAL_SHARED_COOKIE_NAME,"",{...getSessionCookieOptions(),maxAge:0,expires:new Date(0)});
    return response;
  } catch(error){return approvalErrorResponse(error);}
}
