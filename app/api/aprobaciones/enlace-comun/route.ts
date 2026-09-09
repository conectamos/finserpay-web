import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { canManageApprovalAnalysts } from "@/lib/roles";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { approvalAccessOrigin } from "@/lib/approval-access";
import { getSharedApprovalLink, changeSharedApprovalLink, parseSharedGrantMutation } from "@/lib/approval-shared-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { ...approvalPrivateHeaders, "Referrer-Policy": "no-referrer", Vary: "Cookie" };
async function requireManager() {
  const user = await getSessionUser();
  if (!user) throw new CreditApprovalError("UNAUTHENTICATED", "Inicia sesión para gestionar el enlace.", 401);
  if (!canManageApprovalAnalysts(user)) throw new CreditApprovalError("FORBIDDEN", "Solo el administrador central puede gestionar el enlace compartido.", 403);
  return user;
}
export async function GET(request: Request) {
  try { await requireManager(); return NextResponse.json(await getSharedApprovalLink(prisma, approvalAccessOrigin(request)), {headers}); }
  catch(error) { return approvalErrorResponse(error); }
}
async function change(request: Request, revoke: boolean) {
  try {
    const user = await requireManager();
    const expected = parseSharedGrantMutation(await readApprovalRequest(request), revoke);
    const result = await prisma.$transaction(db=>changeSharedApprovalLink(db,user.id,expected,approvalAccessOrigin(request),revoke));
    return NextResponse.json(result,{headers});
  } catch(error) { return approvalErrorResponse(error); }
}
export async function POST(request: Request) { return change(request,false); }
export async function DELETE(request: Request) { return change(request,true); }
