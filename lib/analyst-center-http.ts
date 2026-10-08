import "server-only";
import { NextResponse } from "next/server";
import { getNominalApprovalAnalystSessionUser } from "@/lib/auth";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { CreditApprovalError } from "@/lib/credit-approval-errors";
import { OperationalCaseReadError } from "@/lib/approval-operations-read";

export const analystCenterPrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

export async function requireAnalystCenterActor() {
  // Even an expired shared context must not inherit another browser session.
  if ((await getApprovalSharedRequestActor()) !== undefined) {
    throw new CreditApprovalError("SHARED_ACCESS", "Cierra el acceso compartido y usa tu cuenta personal.", 403);
  }
  const user = await getNominalApprovalAnalystSessionUser();
  if (!user) {
    throw new CreditApprovalError("UNAUTHORIZED", "Inicia sesión con tu cuenta personal de analista.", 401);
  }
  return { id: user.id, nombre: user.nombre };
}

export function analystCenterQuery(request: Request, accepted: readonly string[]) {
  const params = new URL(request.url).searchParams;
  const allowed = new Set(accepted);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      throw new CreditApprovalError("INVALID_REQUEST", "La consulta contiene parámetros no válidos.", 400);
    }
  }
  return params;
}

export function analystCenterErrorResponse(error: unknown) {
  if (error instanceof CreditApprovalError || error instanceof OperationalCaseReadError) {
    return NextResponse.json({ ok: false, code: error.code, error: error.message },
      { status: error.status, headers: analystCenterPrivateHeaders });
  }
  return NextResponse.json({ ok: false, code: "CENTER_UNAVAILABLE",
    error: "No fue posible consultar el Centro del analista. Intenta de nuevo." },
    { status: 503, headers: analystCenterPrivateHeaders });
}
