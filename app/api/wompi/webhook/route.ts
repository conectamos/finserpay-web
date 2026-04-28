import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  creditCajaDescription,
  resolveCreditState,
} from "@/lib/credit-factory";
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
import prisma from "@/lib/prisma";
import { validateWompiEventSignature } from "@/lib/wompi";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WompiEvent = {
  data?: {
    transaction?: {
      amount_in_cents?: number;
      currency?: string;
      id?: string;
      payment_method_type?: string;
      reference?: string;
      status?: string;
    };
  };
  event?: string;
  signature?: {
    checksum?: string;
    properties?: string[];
  };
  timestamp?: number | string;
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
        observacionAdmin: `Wompi desbloqueo por pago aprobado. ${getPayloadSummary(payloadSource).resultMessage || ""}`.trim(),
      },
    });
  } catch (error) {
    console.error("ERROR DESBLOQUEANDO MORA DESPUES DE WOMPI:", error);

    if (!isEqualityApiError(error)) {
      throw error;
    }
  }
}

async function processApprovedPayment(transaction: NonNullable<WompiEvent["data"]>["transaction"], payload: WompiEvent) {
  await ensureCreditAbonoAuditColumns();

  if (!transaction?.reference) {
    return;
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
          fechaPrimerPago: true,
          fechaProximoPago: true,
          usuarioId: true,
          sedeId: true,
        },
      },
    },
  });

  if (!intent) {
    return;
  }

  if (intent.status === "APPROVED" && intent.processedAbonoId) {
    return;
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
    return;
  }

  const cuotas = parseCuotaNumeros(intent.cuotaNumeros);
  const abono = await prisma.$transaction(async (tx) => {
    const created = await tx.creditoAbono.create({
      data: {
        creditoId: intent.creditoId,
        usuarioId: intent.credito.usuarioId,
        sedeId: intent.credito.sedeId,
        valor: intent.amount,
        metodoPago: "WOMPI",
        observacion: `Pago Wompi ${intent.reference} - Cuotas ${cuotas.join(", ")}`,
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
        concepto: "ABONO CREDITO WOMPI",
        valor: intent.amount,
        descripcion: creditCajaDescription({
          id: created.id,
          creditoFolio: intent.credito.folio,
          clienteNombre: intent.credito.clienteNombre,
          metodoPago: "WOMPI",
          observacion: `Referencia Wompi ${intent.reference}`,
        }),
        sedeId: intent.credito.sedeId,
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
}

export async function POST(req: Request) {
  try {
    const payload = (await req.json()) as WompiEvent;

    if (!validateWompiEventSignature(payload)) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }

    const transaction = payload.data?.transaction;

    if (payload.event === "transaction.updated" && transaction?.reference) {
      if (transaction.status === "APPROVED") {
        await processApprovedPayment(transaction, payload);
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
