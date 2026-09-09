import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { exchangeApprovalAccess } from "@/lib/approval-access";
import { CreditApprovalError } from "@/lib/credit-approval";
import { approvalErrorResponse, approvalPrivateHeaders, readApprovalRequest } from "@/lib/credit-approval-http";
import { APPROVAL_ACCESS_SESSION_MAX_AGE_SECONDS, createApprovalAccessSessionToken, getSessionCookieOptions, APPROVAL_ACCESS_COOKIE_NAME, verifyApprovalAccessToken } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const buckets = new Map<string, { start: number; count: number }>();

function consumeAccess(grantId: string) {
  const now = Date.now();
  for (const [key, value] of buckets) if (now - value.start >= 15 * 60_000) buckets.delete(key);
  if (!buckets.has(grantId) && buckets.size >= 1024) buckets.delete(buckets.keys().next().value!);
  const bucket = buckets.get(grantId) || { start: now, count: 0 };
  bucket.count++;
  buckets.set(grantId, bucket);
  return bucket.count <= 120;
}

export async function POST(request: Request) {
  try {
    // Unlike an already-authenticated API, a link login requires browser Origin.
    if (!request.headers.get("origin") || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
      throw new CreditApprovalError("INVALID_ORIGIN", "Abre el enlace de acceso desde FINSER PAY.", 403);
    }
    const body = await readApprovalRequest(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "token") {
      throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado.", 401);
    }
    const token = (body as { token: unknown }).token;
    const parsed = verifyApprovalAccessToken(token);
    if (!parsed) throw new CreditApprovalError("INVALID_ACCESS_LINK", "El enlace no es válido o fue revocado.", 401);
    // Invented tokens fail HMAC verification before database reads or rate buckets.
    if (!consumeAccess(parsed.grantId)) {
      return NextResponse.json({ ok: false, error: "Demasiados accesos. Intenta más tarde." }, { status: 429, headers: { ...approvalPrivateHeaders, "Retry-After": "900" } });
    }
    const access = await prisma.$transaction((db) => exchangeApprovalAccess(db, token), { isolationLevel: "RepeatableRead" });
    const response = NextResponse.json({ ok: true, destination: "/dashboard/aprobaciones" }, {
      headers: { ...approvalPrivateHeaders, "Referrer-Policy": "no-referrer", Vary: "Cookie" },
    });
    response.cookies.set(APPROVAL_ACCESS_COOKIE_NAME, createApprovalAccessSessionToken(access.userId, access.credentialVersion, access.grantId), {
      ...getSessionCookieOptions(), maxAge: APPROVAL_ACCESS_SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) { return approvalErrorResponse(error); }
}
