import { assertCommissionSameOrigin, commissionAccess, commissionHttpError, CommissionHttpError, commissionJson, commissionRequestId, readCommissionJson } from "@/lib/commissions-http";
import { rejectCommissionRequest } from "@/lib/commissions-storage";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertCommissionSameOrigin(request);
    const { userId } = await commissionAccess("central");
    const id = commissionRequestId((await context.params).id);
    const body = await readCommissionJson(request);
    if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 1000) {
      throw new CommissionHttpError("Escribe el motivo del rechazo (máximo 1.000 caracteres).", 400);
    }
    return commissionJson({ request: await rejectCommissionRequest(id, userId, body.reason.trim()) });
  } catch (error) { return commissionHttpError(error); }
}
