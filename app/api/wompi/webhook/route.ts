import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { validateWompiEventSignature } from "@/lib/wompi";
import {
  processApprovedWompiPayment,
  type WompiPaymentEventPayload,
} from "@/lib/wompi-payment-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as WompiPaymentEventPayload;

    if (!validateWompiEventSignature(payload)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const transaction = payload.data?.transaction;

    if (payload.event === "transaction.updated" && transaction?.reference) {
      if (transaction.status === "APPROVED") {
        await processApprovedWompiPayment(transaction, payload);
      } else {
        await prisma.wompiPaymentIntent
          .update({
            where: { reference: transaction.reference },
            data: {
              status: transaction.status || "UPDATED",
              transactionId: transaction.id || null,
              paymentMethodType: transaction.payment_method_type || null,
              payload: payload as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("ERROR WEBHOOK WOMPI:", error);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
