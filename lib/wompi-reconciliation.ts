import type { Prisma } from "@/app/generated/prisma/client";
import prisma from "@/lib/prisma";
import { sanitizeText } from "@/lib/credit-factory";
import {
  fetchWompiTransaction,
  fetchWompiTransactionsByReference,
} from "@/lib/wompi";
import {
  processApprovedWompiPayment,
  repairProcessedWompiEarlyPayoffIntent,
  repairRecentProcessedWompiEarlyPayoffs,
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

function selectTransactionByReference(
  transactions: WompiPaymentTransaction[],
  reference: string
) {
  const exactMatches = transactions.filter(
    (transaction) => sanitizeText(transaction.reference) === reference
  );

  return (
    exactMatches.find(
      (transaction) => normalizeStatus(transaction.status) === "APPROVED"
    ) ||
    exactMatches.find((transaction) => sanitizeText(transaction.id)) ||
    null
  );
}

export async function reconcileWompiIntent(
  intent: WompiIntentSnapshot,
  options: { auditProcessedReference?: boolean } = {}
): Promise<WompiReconciliationResult> {
  if (intent.processedAbonoId) {
    const repair = await repairProcessedWompiEarlyPayoffIntent(intent.id);

    if (!options.auditProcessedReference) {
      return {
        abonoId: intent.processedAbonoId,
        alreadyProcessed: true,
        applied: false,
        intentId: intent.id,
        reference: intent.reference,
        repairedEarlyPayoff: ["FINALIZED", "REPAIRED"].includes(
          repair.action
        ),
        status: intent.status,
        transactionId: intent.transactionId,
      };
    }

    const transactions = await fetchWompiTransactionsByReference(
      intent.reference
    );
    const approvedTransactions = transactions.filter(
      (transaction) =>
        sanitizeText(transaction.reference) === intent.reference &&
        normalizeStatus(transaction.status) === "APPROVED" &&
        sanitizeText(transaction.id)
    );
    const storedTransactionId = sanitizeText(intent.transactionId);
    const duplicateTransactions = storedTransactionId
      ? approvedTransactions.filter(
          (transaction) =>
            sanitizeText(transaction.id) !== storedTransactionId
        )
      : approvedTransactions.slice(1);
    let duplicateResult: WompiPaymentProcessingResult | null = null;

    if (!storedTransactionId && approvedTransactions.length >= 1) {
      await prisma.wompiPaymentIntent.updateMany({
        where: {
          id: intent.id,
          transactionId: null,
        },
        data: {
          transactionId: sanitizeText(approvedTransactions[0].id) || null,
        },
      });
    }

    for (const duplicate of duplicateTransactions) {
      duplicateResult = await processApprovedWompiPayment(
        duplicate,
        buildStatusPayload(duplicate)
      );
    }

    return {
      abonoId: intent.processedAbonoId,
      alreadyProcessed: true,
      applied: false,
      intentId: intent.id,
      reference: intent.reference,
      repairedEarlyPayoff: ["FINALIZED", "REPAIRED"].includes(repair.action),
      reason: duplicateResult?.reason,
      status: duplicateResult?.status || intent.status,
      transactionId: intent.transactionId,
    };
  }

  const transaction = intent.transactionId
    ? ((await fetchWompiTransaction(intent.transactionId)) as WompiPaymentTransaction)
    : selectTransactionByReference(
        await fetchWompiTransactionsByReference(intent.reference),
        intent.reference
      );

  if (!transaction) {
    return {
      applied: false,
      intentId: intent.id,
      reason: "NO_WOMPI_TRANSACTION",
      reference: intent.reference,
      status: intent.status,
      transactionId: null,
    };
  }

  const transactionReference = sanitizeText(transaction.reference);

  if (transactionReference !== intent.reference) {
    return {
      applied: false,
      intentId: intent.id,
      reason: "REFERENCE_MISMATCH",
      reference: intent.reference,
      status: "REFERENCE_MISMATCH",
      transactionId: intent.transactionId || sanitizeText(transaction.id) || null,
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
    transactionId: intent.transactionId || sanitizeText(transaction.id) || null,
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
  const payoffRepairs = await repairRecentProcessedWompiEarlyPayoffs(200);
  const checkoutFallbackCutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 14);
  const processedAuditCutoff = new Date(
    Date.now() - 1000 * 60 * 60 * 24 * 90
  );
  const [pendingIntents, processedIntents] = await Promise.all([
    prisma.wompiPaymentIntent.findMany({
      where: {
        processedAbonoId: null,
        OR: [
          {
            transactionId: {
              not: null,
            },
          },
          {
            createdAt: {
              gte: checkoutFallbackCutoff,
            },
            transactionId: null,
          },
        ],
        status: {
          notIn: ["AMOUNT_MISMATCH", "DECLINED", "ERROR", "VOIDED"],
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
        createdAt: "desc",
      },
      take: safeLimit,
    }),
    prisma.wompiPaymentIntent.findMany({
      where: {
        createdAt: { gte: processedAuditCutoff },
        processedAbonoId: { not: null },
        status: {
          in: ["APPROVED", "APPROVED_DUPLICATE_REVIEW_REQUIRED"],
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
        createdAt: "desc",
      },
      take: safeLimit,
    }),
  ]);
  const intents = [...pendingIntents, ...processedIntents];

  const results: WompiReconciliationResult[] = [];
  const errors: Array<{ error: string; reference: string }> = [];

  for (const intent of intents) {
    try {
      results.push(
        await reconcileWompiIntent(intent, {
          auditProcessedReference: Boolean(intent.processedAbonoId),
        })
      );
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
    payoffRepairs,
    results,
  };
}
