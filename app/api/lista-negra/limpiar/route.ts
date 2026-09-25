import { NextResponse } from "next/server";
import { isSameApprovalOrigin } from "@/lib/credit-approval-http";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { readBlacklistBulkJson } from "@/lib/document-blacklist-bulk-request";
import { clearBlacklist, parseBlacklistClear, previewBlacklistClear } from "@/lib/document-blacklist-clear";
import { blacklistUnavailable, DocumentBlacklistError } from "@/lib/document-blacklist-core";
import { documentBlacklistErrorResponse } from "@/lib/document-blacklist-response";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const failure = (error: unknown) => documentBlacklistErrorResponse(error) ?? documentBlacklistErrorResponse(blacklistUnavailable())!;
const denied = (status: number) => NextResponse.json({ ok: false, error: "Acceso no autorizado.", code: "FORBIDDEN" }, { status, headers });

export async function GET() {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return denied(access.status);
    return NextResponse.json({ ok: true, ...await previewBlacklistClear(prisma, access.user) }, { headers });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return denied(access.status);
    if (!isSameApprovalOrigin(request)) {
      throw new DocumentBlacklistError("INVALID_ORIGIN", "La solicitud debe realizarse desde FINSER PAY.", 403);
    }
    const input = parseBlacklistClear(await readBlacklistBulkJson(request));
    const result = await prisma.$transaction(tx => clearBlacklist(tx, input, access.user), { maxWait: 10_000, timeout: 45_000 });
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) { return failure(error); }
}
