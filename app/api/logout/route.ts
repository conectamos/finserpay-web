import { NextResponse } from "next/server";
import { clearFinancialAccessCookie } from "@/lib/financial-access";
import {
  SELLER_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  getSessionCookieOptions,
} from "@/lib/session";

export async function POST() {
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
  response.cookies.delete("userId");
  clearFinancialAccessCookie(response);

  return response;
}
