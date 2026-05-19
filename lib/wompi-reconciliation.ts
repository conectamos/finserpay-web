import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { sanitizeText } from "@/lib/credit-factory";
import { fetchWompiTransaction } from "@/lib/wompi";
import {
  processApprovedWompiPayment,
  type WompiPaymentEventPayload,
  type WompiPaymentProcessingResult,
  type WompiPaymentTransaction,
} from "@/lib/wompi-payment-processing";

type WompiIntentSnapshot = {
  id: number;
  processedAbonoId: number | null;
  reference: string;
  status: string;
  transactionId: string | null;
};

export type WompiReconciliationResult = WompiPaymentProcessingResult & {
  reference: string;
  transactionId?: string | null;
};

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

export async function reconcileWompiIntent(
  intent: WompiIntentSnapshot
): Promise<WompiReconciliationResult> {
  if (intent.status === "APPROVED" && intent.processedAbonoId) {
    return {
      abonoId: intent.processedAbonoId,
      alreadyProcessed: true,
      applied: true,
      intentId: intent.id,
      reference: intent.reference,
      status: "APPROVED",
      transactionId: intent.transactionId,
    };
  }

  if (!intent.transactionId) {
    return {
      applied: false,
      intentId: intent.id,
      reason: "NO_TRANSACTION_ID",
      reference: intent.reference,
      status: intent.status,
      transactionId: null,
    };
  }

  const transaction = (await fetchWompiTransaction(
    intent.transactionId
  )) as WompiPaymentTransaction;
  const transactionReference = sanitizeText(transaction.reference);

  if (transactionReference !== intent.reference) {
    return {
      applied: false,
      intentId: intent.id,
      reason: "REFERENCE_MISMATCH",
      reference: intent.reference,
      status: "REFERENCE_MISMATCH",
      transactionId: intent.transactionId,
    };
  }

  const transactionStatus = normalizeStatus(transaction.status) || intent.status;

  if (transactionStatus === "APPROVED") {
    const result = await processApprovedWompiPayment(
      transaction,
      buildStatusPayload(transaction)
    );

    return {
      ...result,
      reference: intent.reference,
      transactionId: intent.transactionId,
    };
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

  return {
    applied: false,
    intentId: intent.id,
    reference: intent.reference,
    status: transactionStatus || "UPDATED",
    transactionId: intent.transactionId,
  };
}

export async function reconcileWompiIntentForClient(options: {
  documento: string;
  reference: string;
}) {
  const intent = await prisma.wompiPaymentIntent.findFirst({
    where: {
      customerDocument: options.documento,
      reference: options.reference,
    },
    select: {
      id: true,
      processedAbonoId: true,
      reference: true,
      status: true,
      transactionId: true,
    },
  });

  if (!intent) {
    return null;
  }

  return reconcileWompiIntent(intent);
}

export async function reconcilePendingWompiPayments(limit = 25) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), 50);
  const intents = await prisma.wompiPaymentIntent.findMany({
    where: {
      processedAbonoId: null,
      transactionId: {
        not: null,
      },
      status: {
        notIn: ["APPROVED", "AMOUNT_MISMATCH", "DECLINED", "ERROR", "VOIDED"],
      },
    },
    select: {
      id: true,
      processedAbonoId: true,
      reference: true,
      status: true,
      transactionId: true,
    },
    orderBy: {
      createdAt: "asc",
    },
    take: safeLimit,
  });

  const results: WompiReconciliationResult[] = [];
  const errors: Array<{ error: string; reference: string }> = [];

  for (const intent of intents) {
    try {
      results.push(await reconcileWompiIntent(intent));
    } catch (error) {
      console.error("ERROR CONCILIANDO PAGO WOMPI:", {
        error,
        reference: intent.reference,
      });
      errors.push({
        error: error instanceof Error ? error.message : "Error desconocido",
        reference: intent.reference,
      });
    }
  }

  return {
    applied: results.filter((item) => item.applied).length,
    checked: intents.length,
    errors,
    results,
  };
}
