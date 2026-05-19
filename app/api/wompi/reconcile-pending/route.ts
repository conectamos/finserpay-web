import { NextResponse } from "next/server";
import { reconcilePendingWompiPayments } from "@/lib/wompi-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getToken() {
  return (
    process.env.WOMPI_RECONCILE_TOKEN ||
    process.env.MORA_SYNC_TOKEN ||
    ""
  ).trim();
}

function getBearerToken(req: Request) {
  const authorization = req.headers.get("authorization") || "";

  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return authorization.slice(7).trim();
}

export async function POST(req: Request) {
  try {
    const token = getToken();

    if (!token) {
      return NextResponse.json(
        { error: "WOMPI_RECONCILE_TOKEN no esta configurado" },
        { status: 503 }
      );
    }

    if (getBearerToken(req) !== token) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { limit?: number };
    const result = await reconcilePendingWompiPayments(body.limit || 25);

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("ERROR CONCILIANDO PAGOS WOMPI:", error);
    return NextResponse.json(
      { error: "No se pudieron conciliar los pagos Wompi" },
      { status: 500 }
    );
  }
}
