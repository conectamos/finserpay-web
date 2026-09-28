import { NextResponse } from "next/server";
import { getDashboardAccess } from "@/lib/dashboard-access";
import { isFinserPayCentralAlly } from "@/lib/aliados";

export class CommissionHttpError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export const commissionPrivateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  Vary: "Cookie",
};

export function commissionJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: commissionPrivateHeaders });
}

export function commissionHttpError(error: unknown) {
  // The pause reason is private even if a lower layer accidentally attaches detail.
  if (error instanceof Error && "code" in error && error.code === "COMMISSION_PAUSED") {
    return commissionJson({ error: "Comisiones temporalmente en pausa", code: "COMMISSION_PAUSED" }, 409);
  }
  if (error instanceof CommissionHttpError) {
    return commissionJson({ error: error.message }, error.status);
  }
  // Domain errors carry a public status/code; unknown database errors stay private.
  if (error instanceof Error && "code" in error && "status" in error &&
      typeof error.status === "number" && error.status >= 400 && error.status < 500) {
    return commissionJson({ error: error.message, code: error.code }, error.status);
  }
  console.error("[comisiones]", error instanceof Error ? error.name : "UnknownError");
  return commissionJson({ error: "No fue posible procesar las comisiones. Intenta nuevamente." }, 500);
}

export async function commissionAccess(mode: "seller" | "central" | "receipt") {
  const access = await getDashboardAccess();
  if (!access) throw new CommissionHttpError("Inicia sesión para continuar.", 401);
  const central = access.admin && isFinserPayCentralAlly(access.session.aliadoAccesoCodigo);
  const seller = access.vendedor && access.seller ? access.seller : null;
  if ((mode === "central" && !central) || (mode === "seller" && !seller) ||
      (mode === "receipt" && !central && !seller)) {
    throw new CommissionHttpError("No tienes permiso para acceder a estas comisiones.", 403);
  }
  return { central, seller, userId: access.session.id };
}

export function assertCommissionSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") throw new CommissionHttpError("Origen de solicitud no permitido.", 403);
  if (origin) {
    let originHost: string;
    try { originHost = new URL(origin).host; }
    catch { throw new CommissionHttpError("Origen de solicitud no permitido.", 403); }
    const requestHost = request.headers.get("host") || new URL(request.url).host;
    if (originHost !== requestHost) throw new CommissionHttpError("Origen de solicitud no permitido.", 403);
  }
}

export async function readCommissionJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new CommissionHttpError("Envía los datos en formato JSON.", 415);
  }
  const raw = await request.text();
  if (raw.length > 8192) throw new CommissionHttpError("La solicitud es demasiado grande.", 413);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new CommissionHttpError("Los datos enviados no son válidos.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommissionHttpError("Los datos enviados no son válidos.", 400);
  }
  return value as Record<string, unknown>;
}

export function commissionRequestId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new CommissionHttpError("Solicitud no válida.", 400);
  return id;
}
