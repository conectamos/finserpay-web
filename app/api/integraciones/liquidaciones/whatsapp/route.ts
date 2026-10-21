import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { settlementDeliveryStore } from "@/lib/ally-settlement-delivery-service";
import { settlementWebhookEvents, verifySettlementWebhook } from "@/lib/ally-settlement-delivery-webhook";
import { DeliveryBodyTooLargeError, readDeliveryBody } from "@/lib/ally-settlement-delivery-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const expected = Buffer.from(process.env.WHATSAPP_SETTLEMENT_VERIFY_TOKEN || "");
  const received = Buffer.from(params.get("hub.verify_token") || "");
  if (params.get("hub.mode") !== "subscribe" || expected.length < 32 || expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(params.get("hub.challenge") || "", { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  let raw: string;
  try { raw = await readDeliveryBody(request, 256_000); }
  catch (error) { return new Response("Invalid body", { status: error instanceof DeliveryBodyTooLargeError ? 413 : 400 }); }
  if (!verifySettlementWebhook(raw, request.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const events = settlementWebhookEvents(JSON.parse(raw), process.env.WHATSAPP_PHONE_NUMBER_ID || "");
    for (const event of events) await settlementDeliveryStore.reconcileWhatsApp(event);
    return NextResponse.json({ ok: true });
  } catch { return NextResponse.json({ ok: false }, { status: 500 }); }
}
