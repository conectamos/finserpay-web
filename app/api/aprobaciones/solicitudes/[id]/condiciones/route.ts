import { NextResponse } from "next/server";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { approvalErrorResponse, readApprovalRequest } from "@/lib/credit-approval-http";
import { parseRequestFinancialCorrection, RequestFinancialCorrectionError } from "@/lib/approval-request-financial-correction-core";
import { correctAnalystRequestFinancialConditions, getAnalystRequestFinancialCorrection, parseFinancialCorrectionDraftId } from "@/lib/approval-request-financial-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
async function getActor() {
  const analyst = await getNominalApprovalAnalystSessionUser();
  if (!analyst || (await getApprovalSharedRequestActor()) !== undefined)
    throw new RequestFinancialCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  return { id: analyst.id, nombre: analyst.nombre };
}
function errorResponse(error: unknown) {
  if (error instanceof RequestFinancialCorrectionError)
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers: privateHeaders });
  return approvalErrorResponse(error);
}
export async function GET(_request: Request, context: Context) {
  try {
    await getActor();
    const id = parseFinancialCorrectionDraftId((await context.params).id);
    const item = await getAnalystRequestFinancialCorrection(id);
    return NextResponse.json({ ok: true, item }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await getActor();
    const id = parseFinancialCorrectionDraftId((await context.params).id);
    const input = parseRequestFinancialCorrection(await readApprovalRequest(request, { maxBytes: 16_384 }));
    const item = await correctAnalystRequestFinancialConditions(id, input, actor);
    return NextResponse.json({ ok: true, item }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
