import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  buildEarlyPayoffObservation,
  calculateCreditEarlyPayoff,
  isEarlyPayoffIntentMeta,
} from "@/lib/credit-early-payoff";
import {
  creditCajaDescription,
} from "@/lib/credit-factory";
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
  status: string;
};

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
    return;
  }

  try {
    const result = await processDeviceUnlockCommand(command.id);

    if (result.status === "RETRY") {
      console.warn(
        `[wompi-unlock] Desbloqueo pendiente de confirmacion para credito ${options.creditoId}:`,
        result.reason
      );
    }
  } catch (error) {
    console.error(
      `[wompi-unlock] La orden ${command.id} quedo en cola para reintento:`,
      error
    );
  }
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

  if (intent.status === "APPROVED" && intent.processedAbonoId) {
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
      status: "APPROVED",
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
      payload: payload as Prisma.InputJsonValue,
    },
  });

  if (!claim.count) {
    const current = await prisma.wompiPaymentIntent.findUnique({
      where: { id: intent.id },
      select: {
        processedAbonoId: true,
        status: true,
      },
    });

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
  const earlyPayoffIntent = isEarlyPayoffIntentMeta(intent.cuotaNumeros);
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
    await prisma.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "APPROVED",
        transactionId: transaction.id || intent.transactionId,
        paymentMethodType:
          transaction.payment_method_type || intent.paymentMethodType,
        processedAbonoId: existingReferencePayment.id,
        payload: payload as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
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
      status: "APPROVED",
    };
  }

  const transactionResult = await prisma.$transaction(async (tx) => {
    const previousAbonos = earlyPayoffIntent
      ? await tx.creditoAbono.findMany({
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
        })
      : [];
    const earlyPayoff = earlyPayoffIntent
      ? calculateCreditEarlyPayoff({
          saldoBaseFinanciado: Number(intent.credito.saldoBaseFinanciado || 0),
          montoCredito: Number(intent.credito.montoCredito || 0),
          valorInteres: Number(intent.credito.valorInteres || 0),
          valorFianza: Number(intent.credito.valorFianza || 0),
          valorCuota: Number(intent.credito.valorCuota || 0),
          plazoMeses: Number(intent.credito.plazoMeses || 1),
          frecuenciaPago: intent.credito.frecuenciaPago,
          fechaPrimerPago:
            intent.credito.fechaPrimerPago || intent.credito.fechaProximoPago,
          abonos: previousAbonos.map((item) => ({
            valor: Number(item.valor || 0),
            fechaAbono: item.fechaAbono,
          })),
        })
      : null;

    if (earlyPayoff && !earlyPayoff.eligible) {
      throw new Error(earlyPayoff.reason || "La liquidacion anticipada ya no aplica.");
    }

    if (
      earlyPayoff &&
      Math.round(earlyPayoff.capitalPendiente * 100) !== intent.amountInCents
    ) {
      throw new Error("El valor de liquidacion cambio. Genera un nuevo pago.");
    }

    const paymentObservation = earlyPayoff
      ? [
          `Pago ${paymentMethod} automatico ${intent.reference}`,
          buildEarlyPayoffObservation(earlyPayoff),
          `Recaudo digital ${digitalSede.nombre}`,
          `Sede credito ${intent.credito.sedeId}`,
        ].join(" - ")
      : [
          `Pago ${paymentMethod} automatico ${intent.reference}`,
          `Cuotas ${cuotas.join(", ")}`,
          `Recaudo digital ${digitalSede.nombre}`,
          `Sede credito ${intent.credito.sedeId}`,
        ].join(" - ");
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: intent.creditoId,
        usuarioId: intent.credito.usuarioId,
        vendedorId: null,
        sedeId: digitalSede.id,
        valor: intent.amount,
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
          montoCredito: Number(intent.credito.montoCredito || 0),
          valorCuota: Number(intent.credito.valorCuota || 0),
          plazoMeses: Number(intent.credito.plazoMeses || 1),
          frecuenciaPago: intent.credito.frecuenciaPago,
          fechaPrimerPago:
            intent.credito.fechaPrimerPago || intent.credito.fechaProximoPago,
          abonos: abonos.map((item) => ({
            valor: Number(item.valor || 0),
            fechaAbono: item.fechaAbono,
          })),
        });

    await tx.credito.update({
      where: { id: intent.creditoId },
      data: earlyPayoff
        ? {
            fechaProximoPago: null,
            montoCredito: earlyPayoff.montoCreditoLiquidado,
            observacionAdmin: [
              intent.credito.observacionAdmin,
              `Liquidacion anticipada Wompi ${intent.reference}. Condonado intereses/fianza ${earlyPayoff.interesFianzaCondonado}.`,
            ]
              .filter(Boolean)
              .join("\n"),
            valorFianza: earlyPayoff.valorFianzaReconocida,
            valorInteres: earlyPayoff.valorInteresReconocido,
          }
        : {
            fechaProximoPago: plan?.nextInstallment?.fechaVencimiento
              ? new Date(`${plan.nextInstallment.fechaVencimiento}T12:00:00.000Z`)
              : intent.credito.fechaProximoPago,
          },
    });

    await tx.cajaMovimiento.create({
      data: {
        tipo: "INGRESO",
        concepto: DIGITAL_COLLECTION_CAJA_CONCEPT,
        valor: intent.amount,
        descripcion: creditCajaDescription({
          id: created.id,
          creditoFolio: intent.credito.folio,
          clienteNombre: intent.credito.clienteNombre,
          metodoPago: paymentMethod,
          observacion: `Referencia Wompi ${intent.reference} | Sede credito ${intent.credito.sedeId}`,
        }),
        sedeId: digitalSede.id,
      },
    });

    await tx.wompiPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status: "APPROVED",
        transactionId: transaction.id || null,
        paymentMethodType: transaction.payment_method_type || null,
        processedAbonoId: created.id,
        payload: payload as Prisma.InputJsonValue,
        processedAt: new Date(),
      },
    });

    const shouldUnlock = Boolean(earlyPayoff) || plan?.estadoPago !== "MORA";
    const unlockCommand = shouldUnlock
      ? await enqueueDeviceUnlockCommand({
          client: tx,
          commandKey: `WOMPI:${intent.id}:${created.id}`,
          creditoId: intent.creditoId,
          deviceUid: intent.credito.deviceUid,
          source: "WOMPI",
          sourceReference: intent.reference,
        })
      : null;

    return {
      abono: created,
      unlockCommandId: unlockCommand?.id || null,
    };
  });

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
