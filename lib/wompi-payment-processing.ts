import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  buildEarlyPayoffIntentMeta,
  buildEarlyPayoffObservation,
  calculateCreditEarlyPayoff,
  isEarlyPayoffIntentMeta,
} from "@/lib/credit-early-payoff";
import { creditCajaDescription, resolveCreditState } from "@/lib/credit-factory";
import {
  DIGITAL_COLLECTION_CAJA_CONCEPT,
  ensureDigitalCollectionSede,
} from "@/lib/digital-collection-sede";
import {
  enqueueDeviceUnlockCommand,
  enqueueUnlockForCurrentCredit,
  ensureDeviceUnlockCommandTable,
  processDeviceUnlockCommand,
} from "@/lib/device-unlock-queue";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import prisma from "@/lib/prisma";
import {
  isWompiEarlyPayoffIntent,
  validateWompiEarlyPayoffAmounts,
} from "@/lib/wompi-early-payoff-intent";

export type WompiPaymentTransaction = {
  amount_in_cents?: number | null;
  currency?: string | null;
  id?: string | null;
  payment_method_type?: string | null;
  reference?: string | null;
  status?: string | null;
};

export type WompiPaymentEventPayload = {
  data?: {
    transaction?: WompiPaymentTransaction;
  };
  event?: string;
  signature?: {
    checksum?: string;
    properties?: string[];
  };
  timestamp?: number | string;
};

export type WompiPaymentProcessingResult = {
  abonoId?: number | null;
  alreadyProcessed?: boolean;
  applied: boolean;
  intentId?: number;
  reason?: string;
  repairedEarlyPayoff?: boolean;
  status: string;
};

export type WompiEarlyPayoffRepairResult = {
  abonoId?: number | null;
  action:
    | "ALREADY_FINALIZED"
    | "FINALIZED"
    | "NOT_EARLY_PAYOFF"
    | "NOT_FOUND"
    | "NOT_PROCESSED"
    | "REPAIRED"
    | "REVIEW_REQUIRED";
  creditoId?: number;
  intentId: number;
  reason?: string;
  reference?: string;
  transactionId?: string | null;
  unlockReason?: string;
  unlockStatus?: string;
};

const WOMPI_PAYOFF_REPAIR_MARKER = "REPARACION_LIQUIDACION_WOMPI";
const WOMPI_DUPLICATE_REVIEW_STATUS =
  "APPROVED_DUPLICATE_REVIEW_REQUIRED";

class WompiCreditStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WompiCreditStateConflictError";
  }
}

function hasDuplicateTransactionReview(value: unknown) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).reviewReason ===
        "DUPLICATE_APPROVED_TRANSACTION"
  );
}

function buildDuplicateTransactionReviewPayload(options: {
  duplicatePayload: WompiPaymentEventPayload;
  duplicateTransactionId: string;
  originalTransactionId: string;
}) {
  return {
    duplicatePayload: options.duplicatePayload,
    duplicateTransactionId: options.duplicateTransactionId,
    originalTransactionId: options.originalTransactionId,
    reviewReason: "DUPLICATE_APPROVED_TRANSACTION",
  } as Prisma.InputJsonValue;
}

function parseCuotaNumeros(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function resolveAutomaticWompiPaymentMethod(value: unknown) {
  const method = String(value || "").trim().toUpperCase();

  return method === "NEQUI" ? "NEQUI" : "WOMPI";
}

function resolveStaleProcessingCutoff() {
  return new Date(Date.now() - 5 * 60 * 1000);
}

function appendObservation(current: string | null, next: string) {
  return [current, next].filter(Boolean).join("\n");
}

function buildRepairedPayoffPaymentObservation(options: {
  current: string | null;
  payoffObservation?: string | null;
  reference: string;
}) {
  const current = String(options.current || "").trim();

  if (/liquidacion anticipada/i.test(current)) {
    return current;
  }

  const withoutInstallments = current
    .replace(/\s+-\s+Cuotas?\s+\d+(?:\s*,\s*\d+)*(?=\s+-|$)/i, "")
    .trim();
  const base =
    withoutInstallments || `Pago Wompi automatico ${options.reference}`;
  const payoffObservation =
    String(options.payoffObservation || "").trim() ||
    `Liquidacion anticipada Wompi ${options.reference}`;

  return [base, payoffObservation].join(" - ");
}

function wasWompiPayoffFinalized(
  observation: string | null,
  intentId: number,
  reference: string
) {
  const normalized = String(observation || "");

  return (
    normalized.includes(`Liquidacion anticipada Wompi ${reference}.`) ||
    normalized.includes(`${WOMPI_PAYOFF_REPAIR_MARKER}:${intentId}`)
  );
}

async function ensureAndTryApprovedPaymentUnlock(options: {
  abonoId: number;
  creditoId: number;
  intentId: number;
  reference: string;
}) {
  const command = await enqueueUnlockForCurrentCredit({
    commandKey: `WOMPI:${options.intentId}:${options.abonoId}`,
    creditoId: options.creditoId,
    source: "WOMPI",
    sourceReference: options.reference,
  });

  if (!command || command.status === "CONFIRMED") {
    return {
      status: command?.status || "NOT_ENQUEUED",
    };
  }

  try {
    const result = await processDeviceUnlockCommand(command.id);

    if (result.status === "RETRY") {
      console.warn(
        `[wompi-unlock] Desbloqueo pendiente de confirmacion para credito ${options.creditoId}:`,
        result.reason
      );
    }

    return {
      reason: result.reason,
      status: result.status,
    };
  } catch (error) {
    console.error(
      `[wompi-unlock] La orden ${command.id} quedo en cola para reintento:`,
      error
    );

    return {
      reason: error instanceof Error ? error.message : "Error desconocido",
      status: "RETRY",
    };
  }
}

export async function repairProcessedWompiEarlyPayoffIntent(
  intentId: number
): Promise<WompiEarlyPayoffRepairResult> {
  await ensureCreditAbonoAuditColumns();
  await ensureDeviceUnlockCommandTable();

  const result: WompiEarlyPayoffRepairResult = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "WompiPaymentIntent"
      WHERE "id" = ${intentId}
      FOR UPDATE
    `;

    if (!locked.length) {
      return {
        action: "NOT_FOUND" as const,
        intentId,
      };
    }

    const intent = await tx.wompiPaymentIntent.findUnique({
      where: { id: intentId },
    });

    if (!intent) {
      return {
        action: "NOT_FOUND" as const,
        intentId,
      };
    }

    const baseResult = {
      abonoId: intent.processedAbonoId,
      creditoId: intent.creditoId,
      intentId: intent.id,
      reference: intent.reference,
      transactionId: intent.transactionId,
    };

    if (!isWompiEarlyPayoffIntent(intent.cuotaNumeros, intent.reference)) {
      return {
        ...baseResult,
        action: "NOT_EARLY_PAYOFF" as const,
      };
    }

    if (
      !intent.processedAbonoId ||
      ![
        "APPROVED",
        "APPROVED_DUPLICATE_REVIEW_REQUIRED",
      ].includes(intent.status)
    ) {
      return {
        ...baseResult,
        action: "NOT_PROCESSED" as const,
      };
    }

    const lockedCreditRow = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "Credito"
      WHERE "id" = ${intent.creditoId}
      FOR UPDATE
    `;
    const lockedCredit = lockedCreditRow.length
      ? await tx.credito.findUnique({
          where: { id: intent.creditoId },
          select: {
            fechaPrimerPago: true,
            fechaProximoPago: true,
            frecuenciaPago: true,
            montoCredito: true,
            observacionAdmin: true,
            pazYSalvoEmitidoAt: true,
            plazoMeses: true,
            saldoBaseFinanciado: true,
            valorCuota: true,
            valorFianza: true,
            valorInteres: true,
          },
        })
      : null;

    if (!lockedCredit) {
      return {
        ...baseResult,
        action: "REVIEW_REQUIRED" as const,
        reason: "CREDIT_NOT_FOUND",
      };
    }

    const activeAbonos = await tx.creditoAbono.findMany({
      where: {
        creditoId: intent.creditoId,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        fechaAbono: true,
        id: true,
        observacion: true,
        valor: true,
      },
      orderBy: {
        fechaAbono: "asc",
      },
    });
    const processedAbono = activeAbonos.find(
      (item) => item.id === intent.processedAbonoId
    );

    if (!processedAbono) {
      return {
        ...baseResult,
        action: "REVIEW_REQUIRED" as const,
        reason: "PROCESSED_ABONO_NOT_ACTIVE",
      };
    }

    const totalPaid = activeAbonos.reduce(
      (sum, item) => sum + Number(item.valor || 0),
      0
    );
    const hasFinalizationMarker = wasWompiPayoffFinalized(
      lockedCredit.observacionAdmin,
      intent.id,
      intent.reference
    );
    const currentBalanceInCents = Math.max(
      0,
      Math.round((Number(lockedCredit.montoCredito || 0) - totalPaid) * 100)
    );

    if (currentBalanceInCents <= 0) {
      const issuedAt = lockedCredit.pazYSalvoEmitidoAt || new Date();
      const alreadyFinalized = Boolean(
        hasFinalizationMarker && lockedCredit.pazYSalvoEmitidoAt
      );

      await tx.credito.update({
        where: { id: intent.creditoId },
        data: {
          bloqueoMora: false,
          bloqueoMoraAt: null,
          estado: resolveCreditState({ pazYSalvoEmitidoAt: issuedAt }),
          fechaProximoPago: null,
          observacionAdmin: hasFinalizationMarker
            ? lockedCredit.observacionAdmin
            : appendObservation(
                lockedCredit.observacionAdmin,
                `Liquidacion anticipada Wompi ${intent.reference}. ${WOMPI_PAYOFF_REPAIR_MARKER}:${intent.id}.`
              ),
          pazYSalvoEmitidoAt: issuedAt,
        },
      });

      const payoffMeta = isEarlyPayoffIntentMeta(intent.cuotaNumeros)
        ? intent.cuotaNumeros
        : null;
      const repairedObservation = buildRepairedPayoffPaymentObservation({
        current: processedAbono.observacion,
        payoffObservation: payoffMeta
          ? [
              "Liquidacion anticipada",
              `Capital pagado hoy ${payoffMeta.capitalPendiente}`,
              `Saldo anterior ${payoffMeta.saldoObligacion}`,
              `Condonado intereses/fianza ${payoffMeta.condonacion}`,
            ].join(" - ")
          : null,
        reference: intent.reference,
      });

      if (repairedObservation !== processedAbono.observacion) {
        await tx.creditoAbono.update({
          where: { id: processedAbono.id },
          data: { observacion: repairedObservation },
        });
      }

      return {
        ...baseResult,
        action: alreadyFinalized
          ? ("ALREADY_FINALIZED" as const)
          : ("FINALIZED" as const),
      };
    }

    const previousAbonos = activeAbonos.filter(
      (item) => item.id !== processedAbono.id
    );
    const earlyPayoff = calculateCreditEarlyPayoff({
      saldoBaseFinanciado: Number(lockedCredit.saldoBaseFinanciado || 0),
      montoCredito: Number(lockedCredit.montoCredito || 0),
      valorInteres: Number(lockedCredit.valorInteres || 0),
      valorFianza: Number(lockedCredit.valorFianza || 0),
      valorCuota: Number(lockedCredit.valorCuota || 0),
      plazoMeses: Number(lockedCredit.plazoMeses || 1),
      frecuenciaPago: lockedCredit.frecuenciaPago,
      fechaPrimerPago:
        lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
      today: processedAbono.fechaAbono,
      abonos: previousAbonos.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });

    if (!earlyPayoff.eligible) {
      return {
        ...baseResult,
        action: "REVIEW_REQUIRED" as const,
        reason: earlyPayoff.reason || "EARLY_PAYOFF_NOT_ELIGIBLE",
      };
    }

    const amountValidation = validateWompiEarlyPayoffAmounts({
      intentAmountInCents: intent.amountInCents,
      paymentAmount: Number(processedAbono.valor || 0),
      payoffAmount: earlyPayoff.capitalPendiente,
    });

    if (!amountValidation.valid) {
      return {
        ...baseResult,
        action: "REVIEW_REQUIRED" as const,
        reason: amountValidation.reason || "AMOUNT_MISMATCH",
      };
    }

    const issuedAt = lockedCredit.pazYSalvoEmitidoAt || new Date();
    await tx.credito.update({
      where: { id: intent.creditoId },
      data: {
        bloqueoMora: false,
        bloqueoMoraAt: null,
        estado: resolveCreditState({ pazYSalvoEmitidoAt: issuedAt }),
        fechaProximoPago: null,
        montoCredito: earlyPayoff.montoCreditoLiquidado,
        observacionAdmin: appendObservation(
          lockedCredit.observacionAdmin,
          `Liquidacion anticipada Wompi ${intent.reference}. Condonado intereses/fianza ${earlyPayoff.interesFianzaCondonado}. ${WOMPI_PAYOFF_REPAIR_MARKER}:${intent.id}.`
        ),
        pazYSalvoEmitidoAt: issuedAt,
        valorFianza: earlyPayoff.valorFianzaReconocida,
        valorInteres: earlyPayoff.valorInteresReconocido,
      },
    });
    const repairedObservation = buildRepairedPayoffPaymentObservation({
      current: processedAbono.observacion,
      payoffObservation: buildEarlyPayoffObservation(earlyPayoff),
      reference: intent.reference,
    });

    if (repairedObservation !== processedAbono.observacion) {
      await tx.creditoAbono.update({
        where: { id: processedAbono.id },
        data: { observacion: repairedObservation },
      });
    }
    await tx.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        cuotaNumeros: buildEarlyPayoffIntentMeta(
          earlyPayoff
        ) as Prisma.InputJsonValue,
      },
    });

    return {
      ...baseResult,
      action: "REPAIRED" as const,
    };
  });

  let unlockResult: Awaited<
    ReturnType<typeof ensureAndTryApprovedPaymentUnlock>
  > | null = null;

  if (
    result.abonoId &&
    result.creditoId &&
    ["ALREADY_FINALIZED", "FINALIZED", "REPAIRED"].includes(result.action)
  ) {
    unlockResult = await ensureAndTryApprovedPaymentUnlock({
      abonoId: result.abonoId,
      creditoId: result.creditoId,
      intentId,
      reference: result.reference || "",
    });
  }

  return unlockResult
    ? {
        ...result,
        unlockReason: unlockResult.reason,
        unlockStatus: unlockResult.status,
      }
    : result;
}

export async function repairRecentProcessedWompiEarlyPayoffs(limit = 200) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);
  const intents = await prisma.wompiPaymentIntent.findMany({
    where: {
      createdAt: {
        gte: cutoff,
      },
      processedAbonoId: {
        not: null,
      },
      status: {
        in: ["APPROVED", "APPROVED_DUPLICATE_REVIEW_REQUIRED"],
      },
    },
    select: {
      cuotaNumeros: true,
      id: true,
      reference: true,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: safeLimit,
  });
  const candidates = intents.filter((intent) =>
    isWompiEarlyPayoffIntent(intent.cuotaNumeros, intent.reference)
  );
  const results: WompiEarlyPayoffRepairResult[] = [];

  for (const intent of candidates) {
    results.push(await repairProcessedWompiEarlyPayoffIntent(intent.id));
  }

  return {
    checked: candidates.length,
    alreadyFinalized: results.filter(
      (item) => item.action === "ALREADY_FINALIZED"
    ).length,
    finalized: results.filter((item) => item.action === "FINALIZED").length,
    repaired: results.filter((item) => item.action === "REPAIRED").length,
    reviewRequired: results.filter((item) => item.action === "REVIEW_REQUIRED")
      .length,
    results,
  };
}

export async function processApprovedWompiPayment(
  transaction: WompiPaymentTransaction | undefined,
  payload: WompiPaymentEventPayload
): Promise<WompiPaymentProcessingResult> {
  await ensureCreditAbonoAuditColumns();
  await ensureDeviceUnlockCommandTable();

  if (!transaction?.reference) {
    return { applied: false, status: "NO_REFERENCE" };
  }

  const intent = await prisma.wompiPaymentIntent.findUnique({
    where: { reference: transaction.reference },
    include: {
      credito: {
        select: {
          id: true,
          folio: true,
          clienteNombre: true,
          saldoBaseFinanciado: true,
          montoCredito: true,
          valorInteres: true,
          valorFianza: true,
          valorCuota: true,
          plazoMeses: true,
          frecuenciaPago: true,
          fechaPrimerPago: true,
          fechaProximoPago: true,
          observacionAdmin: true,
          pazYSalvoEmitidoAt: true,
          usuarioId: true,
          vendedorId: true,
          sedeId: true,
          deviceUid: true,
        },
      },
    },
  });

  if (!intent) {
    return { applied: false, status: "NOT_FOUND" };
  }

  const receivedTransactionId = String(transaction.id || "").trim();
  const storedTransactionId = String(intent.transactionId || "").trim();

  if (
    receivedTransactionId &&
    storedTransactionId &&
    receivedTransactionId !== storedTransactionId
  ) {
    await prisma.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        ...(intent.processedAbonoId
          ? { status: WOMPI_DUPLICATE_REVIEW_STATUS }
          : {}),
        payload: buildDuplicateTransactionReviewPayload({
          duplicatePayload: payload,
          duplicateTransactionId: receivedTransactionId,
          originalTransactionId: storedTransactionId,
        }),
      },
    });

    return {
      abonoId: intent.processedAbonoId,
      alreadyProcessed: Boolean(intent.processedAbonoId),
      applied: false,
      intentId: intent.id,
      reason: "DUPLICATE_APPROVED_TRANSACTION_REQUIRES_REVIEW",
      status: WOMPI_DUPLICATE_REVIEW_STATUS,
    };
  }

  if (intent.processedAbonoId) {
    const repair = isWompiEarlyPayoffIntent(
      intent.cuotaNumeros,
      intent.reference
    )
      ? await repairProcessedWompiEarlyPayoffIntent(intent.id)
      : null;

    await ensureAndTryApprovedPaymentUnlock({
      abonoId: intent.processedAbonoId,
      creditoId: intent.creditoId,
      intentId: intent.id,
      reference: intent.reference,
    });

    return {
      abonoId: intent.processedAbonoId,
      alreadyProcessed: true,
      applied: false,
      intentId: intent.id,
      repairedEarlyPayoff: ["FINALIZED", "REPAIRED"].includes(
        repair?.action || ""
      ),
      status:
        intent.status === WOMPI_DUPLICATE_REVIEW_STATUS
          ? WOMPI_DUPLICATE_REVIEW_STATUS
          : "APPROVED",
    };
  }

  if (
    Number(transaction.amount_in_cents || 0) !== intent.amountInCents ||
    String(transaction.currency || "COP").toUpperCase() !== intent.currency
  ) {
    await prisma.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "AMOUNT_MISMATCH",
        transactionId: transaction.id || intent.transactionId,
        paymentMethodType:
          transaction.payment_method_type || intent.paymentMethodType,
        payload: payload as Prisma.InputJsonValue,
      },
    });

    return {
      applied: false,
      intentId: intent.id,
      reason: "AMOUNT_MISMATCH",
      status: "AMOUNT_MISMATCH",
    };
  }

  const claim = await prisma.wompiPaymentIntent.updateMany({
    where: {
      id: intent.id,
      processedAbonoId: null,
      OR: [
        {
          status: {
            not: "PROCESSING_APPROVED",
          },
        },
        {
          updatedAt: {
            lt: resolveStaleProcessingCutoff(),
          },
        },
      ],
    },
    data: {
      status: "PROCESSING_APPROVED",
      transactionId: transaction.id || intent.transactionId,
      paymentMethodType:
        transaction.payment_method_type || intent.paymentMethodType,
    },
  });

  if (!claim.count) {
    const current = await prisma.wompiPaymentIntent.findUnique({
      where: { id: intent.id },
      select: {
        payload: true,
        processedAbonoId: true,
        status: true,
        transactionId: true,
      },
    });
    const currentTransactionId = String(current?.transactionId || "").trim();
    const duplicateTransaction = Boolean(
      receivedTransactionId &&
        currentTransactionId &&
        receivedTransactionId !== currentTransactionId
    );

    if (current && duplicateTransaction) {
      await prisma.wompiPaymentIntent.update({
        where: { id: intent.id },
        data: {
          ...(current.processedAbonoId
            ? { status: WOMPI_DUPLICATE_REVIEW_STATUS }
            : {}),
          payload: buildDuplicateTransactionReviewPayload({
            duplicatePayload: payload,
            duplicateTransactionId: receivedTransactionId,
            originalTransactionId: currentTransactionId,
          }),
        },
      });

      return {
        abonoId: current.processedAbonoId,
        alreadyProcessed: Boolean(current.processedAbonoId),
        applied: false,
        intentId: intent.id,
        reason: "DUPLICATE_APPROVED_TRANSACTION_REQUIRES_REVIEW",
        status: WOMPI_DUPLICATE_REVIEW_STATUS,
      };
    }

    return {
      abonoId: current?.processedAbonoId || null,
      alreadyProcessed: Boolean(current?.processedAbonoId),
      applied: false,
      intentId: intent.id,
      reason: current?.processedAbonoId
        ? undefined
        : "PAYMENT_ALREADY_BEING_PROCESSED",
      status: current?.status || "PROCESSING_APPROVED",
    };
  }

  const cuotas = parseCuotaNumeros(intent.cuotaNumeros);
  const earlyPayoffIntent = isWompiEarlyPayoffIntent(
    intent.cuotaNumeros,
    intent.reference
  );
  const digitalSede = await ensureDigitalCollectionSede();
  const paymentMethod = resolveAutomaticWompiPaymentMethod(
    transaction.payment_method_type || intent.paymentMethodType
  );
  const existingReferencePayment = await prisma.creditoAbono.findFirst({
    where: {
      creditoId: intent.creditoId,
      estado: {
        not: "ANULADO",
      },
      observacion: {
        contains: intent.reference,
      },
    },
    select: {
      id: true,
    },
  });

  if (existingReferencePayment) {
    const duplicateReviewPending = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "WompiPaymentIntent"
        WHERE "id" = ${intent.id}
        FOR UPDATE
      `;
      const current = await tx.wompiPaymentIntent.findUnique({
        where: { id: intent.id },
        select: {
          payload: true,
          status: true,
          transactionId: true,
        },
      });
      const duplicateReview = Boolean(
        current?.status === WOMPI_DUPLICATE_REVIEW_STATUS ||
          hasDuplicateTransactionReview(current?.payload)
      );

      await tx.wompiPaymentIntent.update({
        where: { id: intent.id },
        data: {
          status: duplicateReview
            ? WOMPI_DUPLICATE_REVIEW_STATUS
            : "APPROVED",
          transactionId:
            current?.transactionId || transaction.id || intent.transactionId,
          paymentMethodType:
            transaction.payment_method_type || intent.paymentMethodType,
          processedAbonoId: existingReferencePayment.id,
          payload: duplicateReview
            ? (current?.payload as Prisma.InputJsonValue)
            : (payload as Prisma.InputJsonValue),
          processedAt: new Date(),
        },
      });

      return duplicateReview;
    });

    await ensureAndTryApprovedPaymentUnlock({
      abonoId: existingReferencePayment.id,
      creditoId: intent.creditoId,
      intentId: intent.id,
      reference: intent.reference,
    });

    return {
      abonoId: existingReferencePayment.id,
      alreadyProcessed: true,
      applied: false,
      intentId: intent.id,
      status: duplicateReviewPending
        ? WOMPI_DUPLICATE_REVIEW_STATUS
        : "APPROVED",
    };
  }

  const transactionPromise = prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "Credito"
      WHERE "id" = ${intent.creditoId}
      FOR UPDATE
    `;

    if (!locked.length) {
      throw new WompiCreditStateConflictError(
        "El credito asociado al pago ya no existe."
      );
    }

    const lockedCredit = await tx.credito.findUnique({
      where: { id: intent.creditoId },
      select: {
        clienteNombre: true,
        deviceUid: true,
        estado: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        folio: true,
        frecuenciaPago: true,
        id: true,
        montoCredito: true,
        observacionAdmin: true,
        pazYSalvoEmitidoAt: true,
        plazoMeses: true,
        saldoBaseFinanciado: true,
        sedeId: true,
        usuarioId: true,
        valorCuota: true,
        valorFianza: true,
        valorInteres: true,
      },
    });

    if (
      !lockedCredit ||
      String(lockedCredit.estado || "").toUpperCase() === "ANULADO" ||
      lockedCredit.pazYSalvoEmitidoAt
    ) {
      throw new WompiCreditStateConflictError(
        "El credito ya fue finalizado o no admite mas recaudos."
      );
    }

    const previousAbonos = await tx.creditoAbono.findMany({
      where: {
        creditoId: intent.creditoId,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        valor: true,
        fechaAbono: true,
      },
      orderBy: {
        fechaAbono: "asc",
      },
    });
    const currentPlan = buildCreditPaymentPlan({
      montoCredito: Number(lockedCredit.montoCredito || 0),
      valorCuota: Number(lockedCredit.valorCuota || 0),
      plazoMeses: Number(lockedCredit.plazoMeses || 1),
      frecuenciaPago: lockedCredit.frecuenciaPago,
      fechaPrimerPago:
        lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
      abonos: previousAbonos.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });

    if (Math.round(currentPlan.saldoPendiente * 100) <= 0) {
      throw new WompiCreditStateConflictError(
        "El credito ya no tiene saldo pendiente."
      );
    }

    const earlyPayoff = earlyPayoffIntent
      ? calculateCreditEarlyPayoff({
          saldoBaseFinanciado: Number(lockedCredit.saldoBaseFinanciado || 0),
          montoCredito: Number(lockedCredit.montoCredito || 0),
          valorInteres: Number(lockedCredit.valorInteres || 0),
          valorFianza: Number(lockedCredit.valorFianza || 0),
          valorCuota: Number(lockedCredit.valorCuota || 0),
          plazoMeses: Number(lockedCredit.plazoMeses || 1),
          frecuenciaPago: lockedCredit.frecuenciaPago,
          fechaPrimerPago:
            lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
          abonos: previousAbonos.map((item) => ({
            valor: Number(item.valor || 0),
            fechaAbono: item.fechaAbono,
          })),
        })
      : null;

    if (earlyPayoff && !earlyPayoff.eligible) {
      throw new WompiCreditStateConflictError(
        earlyPayoff.reason || "La liquidacion anticipada ya no aplica."
      );
    }

    if (
      earlyPayoff &&
      Math.round(earlyPayoff.capitalPendiente * 100) !== intent.amountInCents
    ) {
      throw new WompiCreditStateConflictError(
        "El valor de liquidacion cambio. Genera un nuevo pago."
      );
    }

    if (!earlyPayoff) {
      const payableNumbers = currentPlan.installments
        .filter((item) => item.saldoPendiente > 0)
        .map((item) => item.numero);
      const maxSelected = cuotas.length ? Math.max(...cuotas) : 0;
      const expectedNumbers = payableNumbers.filter(
        (item) => item <= maxSelected
      );
      const exactSelection =
        cuotas.length > 0 &&
        expectedNumbers.length === cuotas.length &&
        expectedNumbers.every((item, index) => item === cuotas[index]);
      const selectedAmountInCents = Math.round(
        currentPlan.installments
          .filter((item) => cuotas.includes(item.numero))
          .reduce(
            (sum, item) => sum + Math.max(0, Number(item.saldoPendiente || 0)),
            0
          ) * 100
      );

      if (
        !exactSelection ||
        selectedAmountInCents <= 0 ||
        selectedAmountInCents !== intent.amountInCents
      ) {
        throw new WompiCreditStateConflictError(
          "Las cuotas o el saldo cambiaron despues de generar el pago."
        );
      }
    }

    const paymentObservation = earlyPayoff
      ? [
          `Pago ${paymentMethod} automatico ${intent.reference}`,
          buildEarlyPayoffObservation(earlyPayoff),
          `Recaudo digital ${digitalSede.nombre}`,
          `Sede credito ${lockedCredit.sedeId}`,
        ].join(" - ")
      : [
          `Pago ${paymentMethod} automatico ${intent.reference}`,
          `Cuotas ${cuotas.join(", ")}`,
          `Recaudo digital ${digitalSede.nombre}`,
          `Sede credito ${lockedCredit.sedeId}`,
        ].join(" - ");
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: intent.creditoId,
        usuarioId: lockedCredit.usuarioId,
        vendedorId: null,
        sedeId: digitalSede.id,
        valor: intent.amountInCents / 100,
        metodoPago: paymentMethod,
        observacion: paymentObservation,
      },
    });

    const abonos = await tx.creditoAbono.findMany({
      where: {
        creditoId: intent.creditoId,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        valor: true,
        fechaAbono: true,
      },
      orderBy: {
        fechaAbono: "asc",
      },
    });
    const plan = earlyPayoff
      ? null
      : buildCreditPaymentPlan({
          montoCredito: Number(lockedCredit.montoCredito || 0),
          valorCuota: Number(lockedCredit.valorCuota || 0),
          plazoMeses: Number(lockedCredit.plazoMeses || 1),
          frecuenciaPago: lockedCredit.frecuenciaPago,
          fechaPrimerPago:
            lockedCredit.fechaPrimerPago || lockedCredit.fechaProximoPago,
          abonos: abonos.map((item) => ({
            valor: Number(item.valor || 0),
            fechaAbono: item.fechaAbono,
          })),
        });
    const paymentCompletesCredit = Boolean(
      earlyPayoff || (plan && plan.saldoPendiente <= 0)
    );
    const payoffIssuedAt = paymentCompletesCredit
      ? lockedCredit.pazYSalvoEmitidoAt || new Date()
      : null;

    await tx.credito.update({
      where: { id: intent.creditoId },
      data: earlyPayoff
        ? {
            bloqueoMora: false,
            bloqueoMoraAt: null,
            estado: resolveCreditState({
              pazYSalvoEmitidoAt: payoffIssuedAt,
            }),
            fechaProximoPago: null,
            montoCredito: earlyPayoff.montoCreditoLiquidado,
            observacionAdmin: [
              lockedCredit.observacionAdmin,
              `Liquidacion anticipada Wompi ${intent.reference}. Condonado intereses/fianza ${earlyPayoff.interesFianzaCondonado}.`,
            ]
              .filter(Boolean)
              .join("\n"),
            pazYSalvoEmitidoAt: payoffIssuedAt,
            valorFianza: earlyPayoff.valorFianzaReconocida,
            valorInteres: earlyPayoff.valorInteresReconocido,
          }
        : paymentCompletesCredit
          ? {
              bloqueoMora: false,
              bloqueoMoraAt: null,
              estado: resolveCreditState({
                pazYSalvoEmitidoAt: payoffIssuedAt,
              }),
              fechaProximoPago: null,
              observacionAdmin: appendObservation(
                lockedCredit.observacionAdmin,
                `Pago total Wompi ${intent.reference}. Paz y salvo emitido.`
              ),
              pazYSalvoEmitidoAt: payoffIssuedAt,
            }
          : {
              fechaProximoPago: plan?.nextInstallment?.fechaVencimiento
                ? new Date(
                    `${plan.nextInstallment.fechaVencimiento}T12:00:00.000Z`
                  )
                : lockedCredit.fechaProximoPago,
            },
    });

    await tx.cajaMovimiento.create({
      data: {
        tipo: "INGRESO",
        concepto: DIGITAL_COLLECTION_CAJA_CONCEPT,
        valor: intent.amountInCents / 100,
        descripcion: creditCajaDescription({
          id: created.id,
          creditoFolio: lockedCredit.folio,
          clienteNombre: lockedCredit.clienteNombre,
          metodoPago: paymentMethod,
          observacion: `Referencia Wompi ${intent.reference} | Sede credito ${lockedCredit.sedeId}`,
        }),
        sedeId: digitalSede.id,
      },
    });

    await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id"
      FROM "WompiPaymentIntent"
      WHERE "id" = ${intent.id}
      FOR UPDATE
    `;
    const currentIntentState = await tx.wompiPaymentIntent.findUnique({
      where: { id: intent.id },
      select: {
        payload: true,
        status: true,
        transactionId: true,
      },
    });
    const duplicateReviewPending = Boolean(
      currentIntentState?.status === WOMPI_DUPLICATE_REVIEW_STATUS ||
        hasDuplicateTransactionReview(currentIntentState?.payload)
    );

    await tx.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: duplicateReviewPending
          ? WOMPI_DUPLICATE_REVIEW_STATUS
          : "APPROVED",
        transactionId:
          currentIntentState?.transactionId || transaction.id || null,
        paymentMethodType: transaction.payment_method_type || null,
        processedAbonoId: created.id,
        payload: duplicateReviewPending
          ? (currentIntentState?.payload as Prisma.InputJsonValue)
          : (payload as Prisma.InputJsonValue),
        processedAt: new Date(),
      },
    });

    const shouldUnlock = Boolean(earlyPayoff) || plan?.estadoPago !== "MORA";
    const unlockCommand = shouldUnlock
      ? await enqueueDeviceUnlockCommand({
          client: tx,
          commandKey: `WOMPI:${intent.id}:${created.id}`,
          creditoId: intent.creditoId,
          deviceUid: lockedCredit.deviceUid,
          source: "WOMPI",
          sourceReference: intent.reference,
        })
      : null;

    return {
      abono: created,
      unlockCommandId: unlockCommand?.id || null,
    };
  });

  let transactionResult: Awaited<typeof transactionPromise>;

  try {
    transactionResult = await transactionPromise;
  } catch (error) {
    if (!(error instanceof WompiCreditStateConflictError)) {
      throw error;
    }

    const conflictStatus = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "WompiPaymentIntent"
        WHERE "id" = ${intent.id}
        FOR UPDATE
      `;
      const current = await tx.wompiPaymentIntent.findUnique({
        where: { id: intent.id },
        select: {
          payload: true,
          status: true,
          transactionId: true,
        },
      });
      const duplicateReview = Boolean(
        current?.status === WOMPI_DUPLICATE_REVIEW_STATUS ||
          hasDuplicateTransactionReview(current?.payload)
      );
      const status = duplicateReview
        ? WOMPI_DUPLICATE_REVIEW_STATUS
        : "APPROVED_REVIEW_REQUIRED";

      await tx.wompiPaymentIntent.update({
        where: { id: intent.id },
        data: {
          status,
          transactionId:
            current?.transactionId || transaction.id || intent.transactionId,
          paymentMethodType:
            transaction.payment_method_type || intent.paymentMethodType,
          payload: duplicateReview
            ? (current?.payload as Prisma.InputJsonValue)
            : (payload as Prisma.InputJsonValue),
        },
      });

      return status;
    });

    return {
      applied: false,
      intentId: intent.id,
      reason: error.message,
      status: conflictStatus,
    };
  }

  if (transactionResult.unlockCommandId) {
    try {
      const result = await processDeviceUnlockCommand(
        transactionResult.unlockCommandId
      );

      if (result.status === "RETRY") {
        console.warn(
          `[wompi-unlock] Pago ${intent.reference} aplicado; desbloqueo pendiente de confirmacion:`,
          result.reason
        );
      }
    } catch (error) {
      console.error(
        `[wompi-unlock] Pago ${intent.reference} aplicado; la orden ${transactionResult.unlockCommandId} sigue persistida:`,
        error
      );
    }
  }

  return {
    abonoId: transactionResult.abono.id,
    applied: true,
    intentId: intent.id,
    status: "APPROVED",
  };
}
