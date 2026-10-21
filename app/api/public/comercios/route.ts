import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { loadPublicMerchants } from "@/lib/public-merchants";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const comercios = await loadPublicMerchants(prisma);
    return NextResponse.json({ comercios }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "No pudimos cargar los comercios aliados." }, {
      status: 503, headers: { "Cache-Control": "no-store" },
    });
  }
}
