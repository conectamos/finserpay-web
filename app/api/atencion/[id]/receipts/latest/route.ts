import { getAttentionAccess } from "@/lib/atencion-core";
import { attentionHttpError, attentionId, attentionUuid } from "@/lib/atencion-http";
import { attentionFinancialRuntime } from "@/lib/atencion-financial-runtime";
import { buildClientPaymentReceiptPdf } from "@/lib/client-payment-receipt-pdf";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await getAttentionAccess(), id = attentionUuid((await context.params).id);
    const params = new URL(request.url).searchParams;
    const raw = params.get("creditId");
    const creditId = params.getAll("creditId").length === 1 && raw && /^[1-9]\d*$/.test(raw) ? attentionId(Number(raw)) : attentionId(null);
    const { financial } = await attentionFinancialRuntime(), receipt = await financial.receipt(actor, id, creditId);
    const bytes = await buildClientPaymentReceiptPdf(receipt.pdf);
    // Revalidate after rendering before returning private financial bytes.
    await financial.receipt(actor, id, creditId, receipt.paymentId, receipt.version);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${receipt.fileName}"`,
      "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" } });
  } catch (error) { return attentionHttpError(error); }
}
