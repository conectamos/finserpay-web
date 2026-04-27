import { NextResponse } from "next/server";
import { validateWompiEventSignature } from "@/lib/wompi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LEGACY_WEBHOOK_URL =
  "https://kaiowa.app/APIS/API_PASARELA_ABONOS_CREDITO/services/transactions/registrar_response_wompi";

type WompiRouterEvent = {
  data?: {
    transaction?: {
      reference?: string;
    };
  };
  signature?: {
    checksum?: string;
    properties?: string[];
  };
  timestamp?: number | string;
};

function getLegacyWebhookUrl() {
  return (
    process.env.WOMPI_LEGACY_WEBHOOK_URL || DEFAULT_LEGACY_WEBHOOK_URL
  ).trim();
}

async function forwardWebhook(
  url: string,
  bodyText: string,
  checksum: string | null
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (checksum) {
    headers["X-Event-Checksum"] = checksum;
  }

  return fetch(url, {
    body: bodyText,
    headers,
    method: "POST",
  });
}

export async function POST(req: Request) {
  try {
    const bodyText = await req.text();
    const payload = JSON.parse(bodyText) as WompiRouterEvent;

    if (!validateWompiEventSignature(payload)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const reference = String(payload.data?.transaction?.reference || "");
    const checksum =
      req.headers.get("x-event-checksum") ||
      payload.signature?.checksum ||
      null;
    const isFinserpayReference = reference.startsWith("FP-");
    const targetUrl = isFinserpayReference
      ? new URL("/api/wompi/webhook", req.url).toString()
      : getLegacyWebhookUrl();
    const response = await forwardWebhook(targetUrl, bodyText, checksum);

    if (!response.ok) {
      console.error("ERROR REENVIANDO EVENTO WOMPI:", {
        status: response.status,
        target: isFinserpayReference ? "finserpay" : "legacy",
      });

      return NextResponse.json(
        {
          ok: false,
          target: isFinserpayReference ? "finserpay" : "legacy",
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      target: isFinserpayReference ? "finserpay" : "legacy",
    });
  } catch (error) {
    console.error("ERROR ROUTER WEBHOOK WOMPI:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
