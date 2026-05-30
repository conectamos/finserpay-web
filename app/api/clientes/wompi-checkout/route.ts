import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import {
  EARLY_PAYOFF_PAYMENT_TYPE,
  buildEarlyPayoffIntentMeta,
  calculateCreditEarlyPayoff,
} from "@/lib/credit-early-payoff";
import { sanitizeSearch, sanitizeText, toNumber } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import prisma from "@/lib/prisma";
import {
  buildWompiCheckoutUrl,
  createWompiNequiTransaction,
  isWompiConfigured,
  isWompiDirectApiConfigured,
} from "@/lib/wompi";
import { processApprovedWompiPayment } from "@/lib/wompi-payment-processing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CheckoutBody = {
  acceptWompiTerms?: boolean;
  creditoId?: number | string;
  cuotaNumeros?: Array<number | string>;
  documento?: string;
  nequiPhone?: string;
  paymentMethod?: string;
  paymentMode?: string;
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

function generateWompiReference(creditId: number, label: string) {
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `FP-${creditId}-${label}-${timestamp}-${suffix}`.slice(0, 120);
}

function normalizePhone(value: unknown) {
  const digits = sanitizeText(value).replace(/\D/g, "");
  return digits.startsWith("57") && digits.length === 12 ? digits.slice(2) : digits;
}

function resolveCustomerEmail(email: unknown, document: string | null | undefined) {
  const configuredEmail = sanitizeText(email);

  if (configuredEmail) {
    return configuredEmail;
  }

  const documentPart = sanitizeText(document).replace(/\D/g, "") || "cliente";
  return `cliente-${documentPart}@finserpay.com`;
}

export async function POST(req: Request) {
  try {
    if (!isWompiConfigured() && !isWompiDirectApiConfigured()) {
      return NextResponse.json(
        { error: "Wompi no esta configurado para recibir pagos en linea" },
        { status: 503 }
      );
    }

    const body = (await req.json()) as CheckoutBody;
    const creditoId = Math.trunc(toNumber(body.creditoId));
    const documento = sanitizeSearch(body.documento).replace(/\D/g, "");
    const cuotaNumeros = parseInstallmentNumbers(body.cuotaNumeros);
    const paymentMethod = sanitizeText(body.paymentMethod).toUpperCase();
    const paymentMode = sanitizeText(body.paymentMode).toUpperCase();
    const wantsEarlyPayoff =
      paymentMode === "PAYOFF" || paymentMode === EARLY_PAYOFF_PAYMENT_TYPE;
    const wantsNequiDirect = paymentMethod === "NEQUI";
    const nequiPhone = normalizePhone(body.nequiPhone);

    if (!creditoId || !documento || documento.length < 5) {
      return NextResponse.json(
        { error: "Datos de cliente o credito invalidos" },
        { status: 400 }
      );
    }

    if (!wantsEarlyPayoff && !cuotaNumeros.length) {
      return NextResponse.json(
        { error: "Selecciona al menos una cuota para pagar" },
        { status: 400 }
      );
    }

    if (wantsNequiDirect) {
      if (nequiPhone.length !== 10) {
        return NextResponse.json(
          { error: "Ingresa un numero Nequi valido de 10 digitos" },
          { status: 400 }
        );
      }

      if (!body.acceptWompiTerms) {
        return NextResponse.json(
          { error: "Debes aceptar los terminos de Wompi para enviar el pago" },
          { status: 400 }
        );
      }
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
        saldoBaseFinanciado: true,
        montoCredito: true,
        valorInteres: true,
        valorFianza: true,
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
    let amount = 0;
    let intentCuotaNumeros: Prisma.InputJsonValue =
      cuotaNumeros as Prisma.InputJsonValue;
    let referenceLabel = `C${cuotaNumeros.join("-")}`;

    if (wantsEarlyPayoff) {
      const earlyPayoff = calculateCreditEarlyPayoff({
        saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
        montoCredito: Number(credit.montoCredito || 0),
        valorInteres: Number(credit.valorInteres || 0),
        valorFianza: Number(credit.valorFianza || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        abonos: credit.abonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
      });

      if (!earlyPayoff.eligible) {
        return NextResponse.json(
          { error: earlyPayoff.reason || "No se puede liquidar este credito hoy" },
          { status: 400 }
        );
      }

      amount = earlyPayoff.capitalPendiente;
      intentCuotaNumeros = buildEarlyPayoffIntentMeta(
        earlyPayoff
      ) as Prisma.InputJsonValue;
      referenceLabel = "LIQUIDACION";
    } else {
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
      amount = selectedInstallments.reduce(
        (sum, item) => sum + Math.max(0, Number(item.saldoPendiente || 0)),
        0
      );
    }
    const amountInCents = Math.round(amount * 100);

    if (amountInCents <= 0) {
      return NextResponse.json(
        { error: "El pago seleccionado no tiene saldo pendiente" },
        { status: 400 }
      );
    }

    const reference = generateWompiReference(credit.id, referenceLabel);
    const redirectUrl = buildAbsoluteUrl(
      req,
      `/clientes?credito=${credit.id}&wompiReference=${encodeURIComponent(reference)}`
    );
    const storedCustomerEmail = sanitizeText(credit.clienteCorreo) || null;
    const customerEmail = resolveCustomerEmail(
      credit.clienteCorreo,
      credit.clienteDocumento
    );
    const customerPhone = nequiPhone || sanitizeText(credit.clienteTelefono) || undefined;

    const paymentIntent = await prisma.wompiPaymentIntent.create({
      data: {
        reference,
        creditoId: credit.id,
        cuotaNumeros: intentCuotaNumeros,
        amount,
        amountInCents,
        currency: "COP",
        customerEmail: storedCustomerEmail || customerEmail,
        customerDocument: credit.clienteDocumento,
      },
    });

    const buildCheckoutResponse = async (directError?: string) => {
      if (directError) {
        await prisma.wompiPaymentIntent.update({
          where: { id: paymentIntent.id },
          data: {
            status: "CHECKOUT_FALLBACK",
            payload: { directError } as Prisma.InputJsonValue,
          },
        });
      }

      if (!isWompiConfigured()) {
        return NextResponse.json(
          {
            error: directError || "Wompi Checkout no esta configurado",
            reference,
          },
          { status: 502 }
        );
      }

      return NextResponse.json({
        ok: true,
        amount,
        amountInCents,
        checkoutUrl: buildWompiCheckoutUrl({
          amountInCents,
          customerDocument: credit.clienteDocumento,
          customerEmail: storedCustomerEmail || undefined,
          customerName: credit.clienteNombre,
          customerPhone,
          redirectUrl,
          reference,
        }),
        directError,
        paymentMode: directError ? "CHECKOUT_FALLBACK" : "CHECKOUT",
        reference,
      });
    };
    const buildNequiDirectErrorResponse = async (
      directError: string,
      status = 502
    ) => {
      await prisma.wompiPaymentIntent.update({
        where: { id: paymentIntent.id },
        data: {
          status: "NEQUI_DIRECT_FAILED",
          payload: { directError } as Prisma.InputJsonValue,
        },
      });

      return NextResponse.json(
        {
          error: directError,
          paymentMode: "NEQUI_DIRECT_ERROR",
          reference,
        },
        { status }
      );
    };

    if (wantsNequiDirect && isWompiDirectApiConfigured()) {
      try {
        const transaction = await createWompiNequiTransaction({
          amountInCents,
          customerDocument: credit.clienteDocumento,
          customerEmail,
          customerName: credit.clienteNombre,
          nequiPhone,
          reference,
        });
        const transactionId = sanitizeText(transaction.id) || null;
        const status = sanitizeText(transaction.status) || "PENDING";
        const statusMessage = sanitizeText(transaction.status_message) || null;

        await prisma.wompiPaymentIntent.update({
          where: { id: paymentIntent.id },
          data: {
            status,
            transactionId,
            paymentMethodType:
              sanitizeText(transaction.payment_method_type) || "NEQUI",
            payload: transaction as Prisma.InputJsonValue,
          },
        });

        if (status.toUpperCase() === "APPROVED") {
          await processApprovedWompiPayment(
            {
              amount_in_cents: amountInCents,
              currency: "COP",
              id: transactionId,
              payment_method_type:
                sanitizeText(transaction.payment_method_type) || "NEQUI",
              reference,
              status,
            },
            {
              data: {
                transaction: {
                  amount_in_cents: amountInCents,
                  currency: "COP",
                  id: transactionId,
                  payment_method_type:
                    sanitizeText(transaction.payment_method_type) || "NEQUI",
                  reference,
                  status,
                },
              },
              event: "transaction.direct_create",
              timestamp: Date.now(),
            }
          );
        }

        return NextResponse.json({
          ok: true,
          amount,
          amountInCents,
          paymentMode: "NEQUI_DIRECT",
          reference,
          status,
          statusMessage,
          transactionId,
        });
      } catch (error) {
        const directError =
          error instanceof Error
            ? error.message
            : "No se pudo crear la transaccion Nequi";
        console.error("ERROR CREANDO PAGO NEQUI WOMPI:", error);
        return buildNequiDirectErrorResponse(directError);
      }
    }

    if (wantsNequiDirect && !isWompiDirectApiConfigured()) {
      return buildNequiDirectErrorResponse(
        "Nequi directo no esta configurado. Falta WOMPI_PRIVATE_KEY en el servidor.",
        503
      );
    }

    return buildCheckoutResponse();
  } catch (error) {
    console.error("ERROR CREANDO CHECKOUT WOMPI:", error);
    return NextResponse.json(
      { error: "No se pudo preparar el pago con Wompi" },
      { status: 500 }
    );
  }
}
