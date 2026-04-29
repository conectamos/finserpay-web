import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { sanitizeSearch, sanitizeText, toNumber } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import prisma from "@/lib/prisma";
import { buildWompiCheckoutUrl, isWompiConfigured } from "@/lib/wompi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckoutBody = {
  creditoId?: number | string;
  cuotaNumeros?: Array<number | string>;
  documento?: string;
};

function parseInstallmentNumbers(value: CheckoutBody["cuotaNumeros"]) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((item) => Math.trunc(toNumber(item)))
        .filter((item) => item > 0)
    ),
  ].sort((a, b) => a - b);
}

function buildAbsoluteUrl(req: Request, path: string) {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    new URL(req.url).origin;

  return new URL(path, origin).toString();
}

function generateWompiReference(creditId: number, cuotas: number[]) {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `FP-${creditId}-C${cuotas.join("-")}-${timestamp}-${suffix}`.slice(0, 120);
}

export async function POST(req: Request) {
  try {
    if (!isWompiConfigured()) {
      return NextResponse.json(
        { error: "Wompi no esta configurado para recibir pagos en linea" },
        { status: 503 }
      );
    }

    const body = (await req.json()) as CheckoutBody;
    const creditoId = Math.trunc(toNumber(body.creditoId));
    const documento = sanitizeSearch(body.documento).replace(/\D/g, "");
    const cuotaNumeros = parseInstallmentNumbers(body.cuotaNumeros);

    if (!creditoId || !documento || documento.length < 5) {
      return NextResponse.json(
        { error: "Datos de cliente o credito invalidos" },
        { status: 400 }
      );
    }

    if (!cuotaNumeros.length) {
      return NextResponse.json(
        { error: "Selecciona al menos una cuota para pagar" },
        { status: 400 }
      );
    }

    await ensureCreditAbonoAuditColumns();

    const credit = await prisma.credito.findFirst({
      where: {
        id: creditoId,
        clienteDocumento: documento,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        id: true,
        folio: true,
        clienteNombre: true,
        clienteDocumento: true,
        clienteCorreo: true,
        clienteTelefono: true,
        montoCredito: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
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

    if (!credit) {
      return NextResponse.json(
        { error: "Credito no encontrado para esa cedula" },
        { status: 404 }
      );
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
    const payableNumbers = plan.installments
      .filter((item) => item.saldoPendiente > 0)
      .map((item) => item.numero);
    const maxSelected = Math.max(...cuotaNumeros);
    const expectedNumbers = payableNumbers.filter((item) => item <= maxSelected);
    const exactSelection =
      expectedNumbers.length === cuotaNumeros.length &&
      expectedNumbers.every((item, index) => item === cuotaNumeros[index]);

    if (!exactSelection) {
      return NextResponse.json(
        {
          error:
            "Debes pagar las cuotas pendientes en orden. Si eliges una cuota posterior, tambien se pagan las anteriores.",
        },
        { status: 400 }
      );
    }

    const selectedInstallments = plan.installments.filter((item) =>
      cuotaNumeros.includes(item.numero)
    );
    const amount = selectedInstallments.reduce(
      (sum, item) => sum + Math.max(0, Number(item.saldoPendiente || 0)),
      0
    );
    const amountInCents = Math.round(amount * 100);

    if (amountInCents <= 0) {
      return NextResponse.json(
        { error: "Las cuotas seleccionadas no tienen saldo pendiente" },
        { status: 400 }
      );
    }

    const reference = generateWompiReference(credit.id, cuotaNumeros);
    const redirectUrl = buildAbsoluteUrl(
      req,
      `/clientes?credito=${credit.id}&wompiReference=${encodeURIComponent(reference)}`
    );

    await prisma.wompiPaymentIntent.create({
      data: {
        reference,
        creditoId: credit.id,
        cuotaNumeros: cuotaNumeros as Prisma.InputJsonValue,
        amount,
        amountInCents,
        currency: "COP",
        customerEmail: sanitizeText(credit.clienteCorreo) || null,
        customerDocument: credit.clienteDocumento,
      },
    });

    return NextResponse.json({
      ok: true,
      amount,
      amountInCents,
      checkoutUrl: buildWompiCheckoutUrl({
        amountInCents,
        customerDocument: credit.clienteDocumento,
        customerEmail: sanitizeText(credit.clienteCorreo) || undefined,
        customerName: credit.clienteNombre,
        customerPhone: sanitizeText(credit.clienteTelefono) || undefined,
        redirectUrl,
        reference,
      }),
      reference,
    });
  } catch (error) {
    console.error("ERROR CREANDO CHECKOUT WOMPI:", error);
    return NextResponse.json(
      { error: "No se pudo preparar el pago con Wompi" },
      { status: 500 }
    );
  }
}
