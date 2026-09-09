import { cookies } from "next/headers";
import prisma from "@/lib/prisma";
import { revokeSharedApprovalSession } from "@/lib/approval-shared-access";
import { NextResponse } from "next/server";
import { clearFinancialAccessCookie } from "@/lib/financial-access";
import {
  SELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  APPROVAL_ACCESS_COOKIE_NAME,
  APPROVAL_SHARED_COOKIE_NAME,
  verifyApprovalSharedSessionToken,
  getSessionCookieOptions,
} from "@/lib/session";

export async function POST() {
  try {
    const token = (await cookies()).get(APPROVAL_SHARED_COOKIE_NAME)?.value;
    const sharedSession = verifyApprovalSharedSessionToken(token);
    if (sharedSession) {
      await revokeSharedApprovalSession(prisma, sharedSession.grantId, sharedSession.sessionId);
    }
  } catch {
    // Preserve local logout even when server-side revocation is temporarily unavailable.
  }

  const response = NextResponse.json({ ok: true });

  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
  response.cookies.set(SELLER_SESSION_COOKIE_NAME, "", {
    ...getSessionCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
  response.cookies.set(APPROVAL_ACCESS_COOKIE_NAME, "", { ...getSessionCookieOptions(), expires: new Date(0), maxAge: 0 });
  response.cookies.set(APPROVAL_SHARED_COOKIE_NAME, "", { ...getSessionCookieOptions(), expires: new Date(0), maxAge: 0 });
  response.cookies.delete("userId");
  clearFinancialAccessCookie(response);

  return response;
}
