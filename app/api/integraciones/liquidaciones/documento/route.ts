import prisma from "@/lib/prisma";
import { readSettlementMediaDocument, verifySettlementMediaUrl } from "@/lib/ally-settlement-delivery-media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function unavailable() {
  return new Response("Documento no disponible.", { status: 404, headers: PRIVATE_HEADERS });
}

export async function GET(request: Request) {
  if (process.env.ALLY_SETTLEMENT_DELIVERY_ENABLED !== "true") return unavailable();
  try {
    // Standalone Next.js may expose its internal bind address behind a proxy.
    // The route fixes the signing origin; Host/Forwarded headers never supply it.
    const requestUrl = new URL(request.url);
    if (requestUrl.pathname !== "/api/integraciones/liquidaciones/documento" ||
        requestUrl.username || requestUrl.password || requestUrl.hash) return unavailable();
    const canonicalUrl = new URL("https://finserpay.com/api/integraciones/liquidaciones/documento");
    canonicalUrl.search = requestUrl.search;
    const attemptId = verifySettlementMediaUrl(canonicalUrl.toString());
    if (!attemptId) return unavailable();
    const document = await readSettlementMediaDocument(prisma, attemptId);
    if (!document) return unavailable();
    return new Response(new Uint8Array(document.pdf), {
      headers: {
        ...PRIVATE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.filename}"`,
        "Content-Length": String(document.pdf.length),
      },
    });
  } catch {
    return unavailable();
  }
}
