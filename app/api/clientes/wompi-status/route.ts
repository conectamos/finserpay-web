import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { sanitizeSearch, sanitizeText } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import { fetchWompiTransaction } from "@/lib/wompi";
import {
  processApprovedWompiPayment,
  type WompiPaymentEventPayload,
  type WompiPaymentTransaction,
} from "@/lib/wompi-payment-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeDocument(value: unknown) {
  return sanitizeSearch(value).replace(/\D/g, "");
}

function normalizeStatus(value: unknown) {
  return sanitizeText(value).toUpperCase();
}

function buildStatusPayload(transaction: WompiPaymentTransaction) {
  return {
    data: { transaction },
    event: "transaction.status_check",
    timestamp: Date.now(),
  } satisfies WompiPaymentEventPayload;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const documento = normalizeDocument(searchParams.get("documento"));
    const reference = sanitizeText(searchParams.get("reference")).slice(0, 120);

    if (!documento || documento.length < 5 || !reference) {
      return NextResponse.json(
        { error: "Referencia o cedula invalida" },
        { status: 400 }
      );
    }

    const intent = await prisma.wompiPaymentIntent.findFirst({
      where: {
        customerDocument: documento,
        reference,
      },
      select: {
        id: true,
        creditoId: true,
        processedAbonoId: true,
        reference: true,
        status: true,
        transactionId: true,
      },
    });

    if (!intent) {
      return NextResponse.json(
        { error: "No encontramos ese pago en FINSER PAY" },
        { status: 404 }
      );
    }

    if (intent.status === "APPROVED" && intent.processedAbonoId) {
      return NextResponse.json({
        applied: true,
        ok: true,
        processedAbonoId: intent.processedAbonoId,
        status: "APPROVED",
      });
    }

    if (!intent.transactionId) {
      return NextResponse.json({
        applied: false,
        message:
          "El pago aun no tiene ID de transaccion. Esperando confirmacion de Wompi.",
        ok: true,
        status: intent.status,
      });
    }

    const transaction = (await fetchWompiTransaction(
      intent.transactionId
    )) as WompiPaymentTransaction;
    const transactionReference = sanitizeText(transaction.reference);

    if (transactionReference !== intent.reference) {
      return NextResponse.json(
        { error: "La transaccion consultada no coincide con la referencia" },
        { status: 409 }
      );
    }

    const transactionStatus = normalizeStatus(transaction.status) || intent.status;

    if (transactionStatus === "APPROVED") {
      const result = await processApprovedWompiPayment(
        transaction,
        buildStatusPayload(transaction)
      );

      return NextResponse.json({
        ...result,
        ok: true,
        status: result.status,
      });
    }

    await prisma.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: transactionStatus || "UPDATED",
        transactionId: transaction.id || intent.transactionId,
        paymentMethodType: transaction.payment_method_type || null,
        payload: buildStatusPayload(transaction) as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({
      applied: false,
      ok: true,
      status: transactionStatus || "UPDATED",
    });
  } catch (error) {
    console.error("ERROR CONSULTANDO ESTADO WOMPI:", error);
    return NextResponse.json(
      { error: "No se pudo consultar el estado del pago en Wompi" },
      { status: 500 }
    );
  }
}
