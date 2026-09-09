import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { parseBlacklistBulkInput } from "@/lib/document-blacklist-bulk-core";
import { readBlacklistBulkJson } from "@/lib/document-blacklist-bulk-request";
import { previewBlacklistBulk } from "@/lib/document-blacklist-bulk-store";
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
    const input = parseBlacklistBulkInput(await readBlacklistBulkJson(request));
    const preview = await previewBlacklistBulk(prisma, input, access.user);
    return NextResponse.json({ ok: true, ...preview }, { headers });
  } catch (error) {
    return documentBlacklistErrorResponse(error) ?? documentBlacklistErrorResponse(blacklistUnavailable())!;
  }
}
