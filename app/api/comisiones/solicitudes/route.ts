import { assertCommissionSameOrigin, commissionAccess, commissionHttpError, CommissionHttpError, commissionJson, readCommissionJson } from "@/lib/commissions-http";
import { createCommissionRequest } from "@/lib/commissions-storage";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertCommissionSameOrigin(request);
    const { seller } = await commissionAccess("seller");
    const body = await readCommissionJson(request);
    if (typeof body.period !== "string" || typeof body.amount !== "number" ||
        !Number.isSafeInteger(body.amount) || body.amount <= 0 ||
        typeof body.nequi !== "string" || typeof body.idempotencyKey !== "string") {
      throw new CommissionHttpError("Revisa el periodo, el monto en pesos y el número de Nequi.", 400);
    }
    const result = await createCommissionRequest(seller!.id, {
      period: body.period,
      amount: body.amount,
      nequi: body.nequi,
      idempotencyKey: body.idempotencyKey,
    });
    return commissionJson({ request: result }, 201);
  } catch (error) { return commissionHttpError(error); }
}
