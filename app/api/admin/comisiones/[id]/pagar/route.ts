import { assertCommissionSameOrigin, commissionAccess, commissionHttpError, CommissionHttpError, commissionJson, commissionRequestId } from "@/lib/commissions-http";
import { confirmCommissionPayment } from "@/lib/commissions-storage";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertCommissionSameOrigin(request);
    const { userId } = await commissionAccess("central");
    const id = commissionRequestId((await context.params).id);
    if (Number(request.headers.get("content-length") || 0) > 6 * 1024 * 1024) {
      throw new CommissionHttpError("El comprobante debe pesar máximo 5 MB.", 413);
    }
    if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
      throw new CommissionHttpError("Debes adjuntar el comprobante antes de confirmar el pago.", 400);
    }
    const data = await request.formData();
    const receipt = data.get("receipt");
    if (!(receipt instanceof File) || !receipt.size) {
      throw new CommissionHttpError("Debes adjuntar el comprobante antes de confirmar el pago.", 400);
    }
    if (receipt.size > 5 * 1024 * 1024) {
      throw new CommissionHttpError("El comprobante debe pesar máximo 5 MB.", 413);
    }
    return commissionJson({ request: await confirmCommissionPayment(id, userId, {
      fileName: receipt.name,
      mimeType: receipt.type,
      base64: Buffer.from(await receipt.arrayBuffer()).toString("base64"),
    }) });
  } catch (error) { return commissionHttpError(error); }
}
