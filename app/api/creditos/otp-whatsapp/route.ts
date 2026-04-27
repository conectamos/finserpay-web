import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { sendWhatsAppOtp, WhatsAppApiError } from "@/lib/whatsapp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const sessionUser = await getSessionUser();

    if (!sessionUser) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const sellerSession = await getSellerSessionUser(sessionUser);

    if (!sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const result = await sendWhatsAppOtp(body.telefono);

    return NextResponse.json({
      ok: true,
      code: result.code,
      messageId: result.messageId,
      mode: result.mode,
      recipient: result.recipient,
    });
  } catch (error) {
    if (error instanceof WhatsAppApiError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code || null,
          details: error.details || null,
        },
        { status: error.status }
      );
    }

    console.error("ERROR ENVIANDO OTP WHATSAPP:", error);
    return NextResponse.json(
      { error: "No se pudo enviar el OTP por WhatsApp" },
      { status: 500 }
    );
  }
}
