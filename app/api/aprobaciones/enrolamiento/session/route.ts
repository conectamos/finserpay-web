import { NextRequest } from "next/server";
import {
  ANALYST_ENROLLMENT_COOKIE_PATH,
  analystEnrollmentCookieName,
  analystEnrollmentErrorResponse,
  enrollmentResponse,
  limitAnalystEnrollment,
  readAnalystEnrollmentGrant,
  requireAnalystEnrollmentActor,
} from "@/lib/analyst-enrollment-access";
import { readLimitedIphoneEnrollmentJson } from "@/lib/iphone-enrollment";
import {
  createIphoneEnrollmentAccessGrant,
  exchangeIphoneEnrollmentAccessGrant,
} from "@/lib/iphone-enrollment-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = await requireAnalystEnrollmentActor(request);
    await readLimitedIphoneEnrollmentJson(request);
    const existing = await readAnalystEnrollmentGrant(request, actor);
    if (existing) {
      return enrollmentResponse({ ok: true, authorized: true, analyst: existing.analyst, expiresAt: existing.expiresAt.toISOString() });
    }
    const limited = await limitAnalystEnrollment(actor, "ACCESS", 12);
    if (limited) return limited;
    // Private nominal grant: its secret never leaves the server. Approval still
    // rechecks the active account and ownership inside its transaction.
    const issued = await createIphoneEnrollmentAccessGrant({
      analystName: actor.nombre,
      analystExternalId: `FINSER-USER:${actor.id}`,
      expiresInMinutes: 480,
      issuedByUserId: actor.id,
      issuedByName: actor.nombre,
    });
    const exchanged = await exchangeIphoneEnrollmentAccessGrant(issued.token);
    const response = enrollmentResponse({
      ok: true, authorized: true,
      analyst: exchanged.grant.analyst,
      expiresAt: exchanged.session.expiresAt.toISOString(),
    });
    response.cookies.set({
      name: analystEnrollmentCookieName(), value: exchanged.session.value,
      expires: exchanged.session.expiresAt, httpOnly: true,
      secure: process.env.NODE_ENV === "production", sameSite: "strict",
      path: ANALYST_ENROLLMENT_COOKIE_PATH,
    });
    return response;
  } catch (error) { return analystEnrollmentErrorResponse(error); }
}
