import { NextResponse } from "next/server";
import {
  operationalErrorResponse, operationalFormData, operationalPrivateHeaders,
  operationalTarget, rejectUnexpectedFields, requireOperationalActor,
} from "@/lib/approval-operations-http";
import { mutateOperationalImei, parseOperationalEvidence } from "@/lib/approval-operations-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ kind: string; id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    const actor = await requireOperationalActor();
    const { kind, id } = await context.params;
    const target = operationalTarget(kind, id);
    const form = await operationalFormData(request);
    rejectUnexpectedFields(form, ["action", "idempotencyKey", "confirmed", "newImei", "expectedImei",
      "expectedProcessUuid", "expectedEnrollmentReviewId", "replacementId", "reason", "evidence"]);
    const operation = await mutateOperationalImei(target.kind, target.id, {
      action: form.get("action"), idempotencyKey: form.get("idempotencyKey"),
      confirmed: form.get("confirmed"), newImei: form.get("newImei"),
      expectedImei: form.get("expectedImei"), expectedProcessUuid: form.get("expectedProcessUuid"),
      expectedEnrollmentReviewId: form.get("expectedEnrollmentReviewId"),
      replacementId: form.get("replacementId"), reason: form.get("reason"),
      evidence: await parseOperationalEvidence(form.get("evidence")),
    }, actor);
    return NextResponse.json({ ok: true, operation }, { headers: operationalPrivateHeaders });
  } catch (error) {
    return operationalErrorResponse(error);
  }
}
