import { NextResponse } from "next/server";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { approvalErrorResponse, readApprovalRequest } from "@/lib/credit-approval-http";
import { RequestDataCorrectionError } from "@/lib/approval-request-correction-core";
import { parseCorrectionDraftId } from "@/lib/approval-request-correction";
import { parseRequestEvidenceCorrection } from "@/lib/approval-request-evidence-correction-core";
import { correctAnalystRequestEvidence, getAnalystRequestEvidence } from "@/lib/approval-request-evidence-correction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff", Vary: "Cookie" };
async function getActor() {
  const analyst = await getNominalApprovalAnalystSessionUser();
  if (!analyst || (await getApprovalSharedRequestActor()) !== undefined)
    throw new RequestDataCorrectionError("UNAUTHORIZED", "Inicia sesión con tu cuenta de analista.", 401);
  return { id: analyst.id, nombre: analyst.nombre };
}
function errorResponse(error: unknown) {
  if (error instanceof RequestDataCorrectionError)
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers: privateHeaders });
  return approvalErrorResponse(error);
}
export async function GET(_request: Request, context: Context) {
  try {
    await getActor();
    const id = parseCorrectionDraftId((await context.params).id);
    return NextResponse.json({ ok: true, item: await getAnalystRequestEvidence(id) }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = await getActor();
    const id = parseCorrectionDraftId((await context.params).id);
    const input = parseRequestEvidenceCorrection(await readApprovalRequest(request, { maxBytes: 2_600_000 }));
    return NextResponse.json({ ok: true, item: await correctAnalystRequestEvidence(id, input, actor) }, { headers: privateHeaders });
  } catch (error) { return errorResponse(error); }
}
