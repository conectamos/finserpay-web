import { NextRequest } from "next/server";
import {
  analystEnrollmentErrorResponse,
  enrollmentResponse,
  limitAnalystEnrollment,
  requireAnalystEnrollmentSession,
} from "@/lib/analyst-enrollment-access";
import {
  buildIphoneEnrollmentChecklist,
  isIphoneEnrollmentCaseTokenForSession,
  readLimitedIphoneEnrollmentJson,
  verifyIphoneEnrollmentCaseToken,
} from "@/lib/iphone-enrollment";
import { approveIphoneEnrollmentCase } from "@/lib/iphone-enrollment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const { actor, grant, signedSession } = await requireAnalystEnrollmentSession(request);
    const body = await readLimitedIphoneEnrollmentJson<{ caseToken?: unknown; enrollmentApproved?: unknown }>(request);
    const limited = await limitAnalystEnrollment(actor, "APPROVE", 15);
    if (limited) return limited;
    const caseToken = verifyIphoneEnrollmentCaseToken(body.caseToken);
    const checklist = buildIphoneEnrollmentChecklist(body.enrollmentApproved);
    if (!caseToken || !checklist || !isIphoneEnrollmentCaseTokenForSession(caseToken, signedSession)) {
      return enrollmentResponse({ ok: false, error: "La consulta venció o falta confirmar el enrolamiento." }, 400);
    }
    const result = await approveIphoneEnrollmentCase({ caseToken, grant, checklist, nominalActor: actor });
    return enrollmentResponse({ ok: true, alreadyApproved: result.alreadyApproved, review: {
      id: result.review.id, decision: result.review.decision,
      analystName: result.review.analystName, analystExternalId: result.review.analystExternalId,
      approvedAt: result.review.approvedAt,
    } });
  } catch (error) { return analystEnrollmentErrorResponse(error); }
}
