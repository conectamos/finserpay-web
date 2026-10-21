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

function getConectamosWebhookUrl() {
  try {
    const url = new URL((process.env.WOMPI_CONECTAMOS_WEBHOOK_URL || "").trim());
    if (
      url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/api/payments/wompi/events"
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function forwardWebhook(
  url: string,
  bodyText: string,
  checksum: string | null,
  options: Pick<RequestInit, "redirect" | "signal"> = {}
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
    ...options,
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
    const isConectamosReference = /^wp_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(reference);
    const target = isFinserpayReference ? "finserpay" : isConectamosReference ? "conectamos" : "legacy";
    const targetUrl = isConectamosReference
      ? getConectamosWebhookUrl()
      : isFinserpayReference
      ? new URL("/api/wompi/webhook", req.url).toString()
      : getLegacyWebhookUrl();
    // Never send a store order to the legacy credit collector when its route is unavailable.
    if (!targetUrl) return NextResponse.json({ ok: false, target }, { status: 503 });
    const response = await forwardWebhook(targetUrl, bodyText, checksum,
      isConectamosReference ? { redirect: "manual", signal: AbortSignal.timeout(15000) } : {}
    );

    if (!response.ok) {
      console.error("ERROR REENVIANDO EVENTO WOMPI:", {
        status: response.status,
        target,
      });

      return NextResponse.json(
        {
          ok: false,
          target,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      target,
    });
  } catch (error) {
    console.error("ERROR ROUTER WEBHOOK WOMPI:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
