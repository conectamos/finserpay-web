import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { readBlacklistBulkJson } from "@/lib/document-blacklist-bulk-request";
import { commitBlacklistBulk, parseBlacklistBulkCommit } from "@/lib/document-blacklist-bulk-store";
import { blacklistUnavailable } from "@/lib/document-blacklist-core";
import { documentBlacklistErrorResponse } from "@/lib/document-blacklist-response";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return NextResponse.json({ ok: false, error: "Acceso no autorizado.", code: "FORBIDDEN" }, { status: access.status, headers });
    const input = parseBlacklistBulkCommit(await readBlacklistBulkJson(request));
    const result = await prisma.$transaction((tx) => commitBlacklistBulk(tx, input, access.user), { maxWait: 10_000, timeout: 45_000 });
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    return documentBlacklistErrorResponse(error) ?? documentBlacklistErrorResponse(blacklistUnavailable())!;
  }
}
