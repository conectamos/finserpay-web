import { NextResponse } from "next/server";
import { getCreditApprovalSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { getOperationalCase, OperationalCaseReadError } from "@/lib/approval-operations-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

type Context = { params: Promise<{ kind: string; id: string }> };

export async function GET(_request: Request, context: Context) {
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
    const { kind, id } = await context.params;
    const item = await getOperationalCase(kind, id);
    return NextResponse.json({ ok: true, item }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof OperationalCaseReadError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message },
        { status: error.status, headers: privateHeaders });
    }
    return NextResponse.json({ ok: false, error: "No fue posible consultar el expediente. Intenta de nuevo." },
      { status: 503, headers: privateHeaders });
  }
}
