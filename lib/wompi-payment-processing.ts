import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  creditCajaDescription,
  resolveCreditState,
} from "@/lib/credit-factory";
import {
  DIGITAL_COLLECTION_CAJA_CONCEPT,
  ensureDigitalCollectionSede,
} from "@/lib/digital-collection-sede";
import {
  getEqualityDeviceMeta,
  getPayloadSummary,
} from "@/lib/equality-device-meta";
import {
  isEqualityApiError,
  isEqualityConfigured,
  queryEqualityDevices,
  unlockEqualityDevice,
} from "@/lib/equality-zero-touch";
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

function asJsonValue(value: unknown) {
  return value && typeof value === "object"
    ? (value as Prisma.InputJsonValue)
    : undefined;
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

async function syncMoraAfterWompiPayment(creditId: number) {
  await ensureCreditAbonoAuditColumns();

  const credit = await prisma.credito.findUnique({
    where: { id: creditId },
    select: {
      id: true,
      deviceUid: true,
      montoCredito: true,
      valorCuota: true,
      plazoMeses: true,
      frecuenciaPago: true,
      fechaPrimerPago: true,
      fechaProximoPago: true,
      deliverableLabel: true,
      deliverableReady: true,
      equalityState: true,
      equalityService: true,
      equalityPayload: true,
      equalityLastCheckAt: true,
      bloqueoRobo: true,
      bloqueoMora: true,
      pazYSalvoEmitidoAt: true,
      abonos: {
        where: {
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
      },
    },
  });

  if (!credit || !credit.bloqueoMora || credit.bloqueoRobo || !isEqualityConfigured()) {
    return;
  }

  const plan = buildCreditPaymentPlan({
    montoCredito: Number(credit.montoCredito || 0),
    valorCuota: Number(credit.valorCuota || 0),
    plazoMeses: Number(credit.plazoMeses || 1),
    frecuenciaPago: credit.frecuenciaPago,
    fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
    abonos: credit.abonos.map((item) => ({
      valor: Number(item.valor || 0),
      fechaAbono: item.fechaAbono,
    })),
  });

  if (plan.estadoPago === "MORA") {
    return;
  }

  try {
    const remotePayload = await unlockEqualityDevice(credit.deviceUid);
    const remoteQuery = await queryEqualityDevices(credit.deviceUid).catch(() => null);
    const payloadSource = remoteQuery || remotePayload || credit.equalityPayload;
    const deviceMeta = getEqualityDeviceMeta(payloadSource);

    await prisma.credito.update({
      where: { id: credit.id },
      data: {
        estado: resolveCreditState({
          bloqueoRobo: credit.bloqueoRobo,
          bloqueoMora: false,
          deliverable: deviceMeta.deliveryStatus || null,
          pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt,
        }),
        deliverableLabel:
          deviceMeta.deliveryStatus?.label || credit.deliverableLabel,
        deliverableReady:
          typeof deviceMeta.deliveryStatus?.ready === "boolean"
            ? deviceMeta.deliveryStatus.ready
            : credit.deliverableReady,
        equalityState: deviceMeta.deviceState || credit.equalityState,
        equalityService: deviceMeta.serviceDetails || credit.equalityService,
        equalityPayload: asJsonValue(payloadSource),
        equalityLastCheckAt: payloadSource ? new Date() : credit.equalityLastCheckAt,
        bloqueoMora: false,
        bloqueoMoraAt: null,
        observacionAdmin: `Wompi desbloqueo por pago aprobado. ${
          getPayloadSummary(payloadSource).resultMessage || ""
        }`.trim(),
      },
    });
  } catch (error) {
    console.error("ERROR DESBLOQUEANDO MORA DESPUES DE WOMPI:", error);

    if (!isEqualityApiError(error)) {
      throw error;
    }
  }
}

export async function processApprovedWompiPayment(
  transaction: WompiPaymentTransaction | undefined,
  payload: WompiPaymentEventPayload
): Promise<WompiPaymentProcessingResult> {
  await ensureCreditAbonoAuditColumns();

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
          montoCredito: true,
          valorCuota: true,
          plazoMeses: true,
          frecuenciaPago: true,
          fechaPrimerPago: true,
          fechaProximoPago: true,
          usuarioId: true,
          sedeId: true,
        },
      },
    },
  });

  if (!intent) {
    return { applied: false, status: "NOT_FOUND" };
  }

  if (intent.status === "APPROVED" && intent.processedAbonoId) {
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

    return {
      abonoId: existingReferencePayment.id,
      alreadyProcessed: true,
      applied: false,
      intentId: intent.id,
      status: "APPROVED",
    };
  }

  const abono = await prisma.$transaction(async (tx) => {
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: intent.creditoId,
        usuarioId: intent.credito.usuarioId,
        sedeId: digitalSede.id,
        valor: intent.amount,
        metodoPago: paymentMethod,
        observacion: [
          `Pago ${paymentMethod} automatico ${intent.reference}`,
          `Cuotas ${cuotas.join(", ")}`,
          `Recaudo digital ${digitalSede.nombre}`,
          `Sede credito ${intent.credito.sedeId}`,
        ].join(" - "),
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
    const plan = buildCreditPaymentPlan({
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
      data: {
        fechaProximoPago: plan.nextInstallment?.fechaVencimiento
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

    return created;
  });

  if (abono) {
    await syncMoraAfterWompiPayment(intent.creditoId);
  }

  return {
    abonoId: abono.id,
    applied: true,
    intentId: intent.id,
    status: "APPROVED",
  };
}
