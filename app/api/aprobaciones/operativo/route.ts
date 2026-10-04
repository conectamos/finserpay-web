import { NextResponse } from "next/server";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { OperationalCaseReadError, searchOperationalCases } from "@/lib/approval-operations-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export async function GET(request: Request) {
  if (await getApprovalSharedRequestActor() !== undefined) {
    return NextResponse.json({ ok: false, error: "Este acceso no permite la gestión operativa." },
      { status: 403, headers: privateHeaders });
  }
  const analyst = await getCreditApprovalSessionUser();
  if (!analyst) {
    return NextResponse.json({ ok: false, error: "No autorizado." },
      { status: 401, headers: privateHeaders });
  }
  try {
    const query = new URL(request.url).searchParams.get("q");
    const items = await searchOperationalCases(query);
    return NextResponse.json({ ok: true, items }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof OperationalCaseReadError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message },
        { status: error.status, headers: privateHeaders });
    }
    return NextResponse.json({ ok: false, error: "No fue posible buscar expedientes. Intenta de nuevo." },
      { status: 503, headers: privateHeaders });
  }
}
