import { commissionAccess, commissionHttpError, commissionPrivateHeaders, commissionRequestId } from "@/lib/commissions-http";
import { getCommissionReceipt } from "@/lib/commissions-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { central, seller, userId } = await commissionAccess("receipt");
    const id = commissionRequestId((await context.params).id);
    const receipt = await getCommissionReceipt(id, central ? { adminUserId: userId } : { sellerId: seller!.id });
    const fileName = receipt.fileName.replace(/[\r\n"\\/]/g, "_");
    return new Response(new Uint8Array(receipt.bytes), { headers: {
      ...commissionPrivateHeaders,
      "Content-Type": receipt.mimeType,
      "Content-Length": String(receipt.bytes.length),
      "Content-Disposition": `attachment; filename="comprobante"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    } });
  } catch (error) { return commissionHttpError(error); }
}
