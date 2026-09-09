import { NextResponse } from "next/server";
import { getDataCreditoCentralAdmin } from "@/lib/datacredito/admin-access";
import { blacklistUnavailable } from "@/lib/document-blacklist-core";
import { documentBlacklistErrorResponse } from "@/lib/document-blacklist-response";
import { listBlacklist, mutateBlacklist, parseBlacklistFilters, parseBlacklistMutation } from "@/lib/document-blacklist-store";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function denied(status: 401 | 403) {
  return NextResponse.json({ ok: false, error: "Acceso no autorizado.", code: "FORBIDDEN" }, { status, headers });
}

function failure(error: unknown) {
  return documentBlacklistErrorResponse(error) ?? documentBlacklistErrorResponse(blacklistUnavailable())!;
}

export async function GET(request: Request) {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return denied(access.status);
    const filters = parseBlacklistFilters(new URL(request.url).searchParams);
    const result = await listBlacklist(prisma, filters);
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    return failure(error);
  }
}

async function write(request: Request, method: "POST" | "PATCH") {
  try {
    const access = await getDataCreditoCentralAdmin();
    if (!access.ok) return denied(access.status);
    // Keep malformed requests separate from availability failures and never log identity data.
    let body: unknown;
    try { body = await request.json(); } catch {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "La solicitud no es válida." }, { status: 400, headers });
    }
    const input = parseBlacklistMutation(method, body);
    const result = await prisma.$transaction((tx) => mutateBlacklist(tx, input, access.user), { maxWait: 10_000, timeout: 45_000 });
    return NextResponse.json({ ok: true, ...result }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) { return write(request, "POST"); }
export async function PATCH(request: Request) { return write(request, "PATCH"); }
