import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { canManageApprovalAnalysts } from "@/lib/roles";
import { approvalCreditId, CreditApprovalError } from "@/lib/credit-approval";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { approvalAccessOrigin, getApprovalAccessLink, changeApprovalAccessLink, parseApprovalLinkMutation } from "@/lib/approval-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const headers = { ...approvalPrivateHeaders, "Referrer-Policy": "no-referrer", Vary: "Cookie" };

async function actor() {
  const user = await getSessionUser();
  if (!user) throw new CreditApprovalError("UNAUTHENTICATED", "Inicia sesión para gestionar los enlaces.", 401);
  if (!canManageApprovalAnalysts(user)) throw new CreditApprovalError("FORBIDDEN", "Solo el administrador central puede gestionar los enlaces de analistas.", 403);
  return user;
}

export async function GET(request: Request, context: Context) {
  try {
    await actor();
    const id = approvalCreditId((await context.params).id);
    const payload = await prisma.$transaction((db) => getApprovalAccessLink(db, id, approvalAccessOrigin(request)), { isolationLevel: "RepeatableRead" });
    return NextResponse.json(payload, { headers });
  } catch (error) { return approvalErrorResponse(error); }
}

async function change(request: Request, context: Context, revoke: boolean) {
  try {
    const user = await actor();
    const id = approvalCreditId((await context.params).id);
    const expected = parseApprovalLinkMutation(await readApprovalRequest(request), revoke);
    const payload = await prisma.$transaction((db) => changeApprovalAccessLink(db, id, user.id, expected, approvalAccessOrigin(request), revoke));
    return NextResponse.json(payload, { headers });
  } catch (error) { return approvalErrorResponse(error); }
}
export async function POST(request: Request, context: Context) { return change(request, context, false); }
export async function DELETE(request: Request, context: Context) { return change(request, context, true); }
