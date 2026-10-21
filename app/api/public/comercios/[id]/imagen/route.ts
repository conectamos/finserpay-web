import prisma from "@/lib/prisma";
import { loadPublicMerchantImage } from "@/lib/public-merchants";

export const dynamic = "force-dynamic";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const data = await loadPublicMerchantImage(prisma, (await params).id);
    if (!data) return new Response(null, { status: 404 });
    return new Response(Buffer.from(data.split(",")[1], "base64"), { headers: { "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 503 }); }
}
