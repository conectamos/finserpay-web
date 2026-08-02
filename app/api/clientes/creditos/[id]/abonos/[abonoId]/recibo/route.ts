import { NextResponse } from "next/server";
import { buildClientPaymentReceiptPdf } from "@/lib/client-payment-receipt-pdf";
import prisma from "@/lib/prisma";
import { isWompiEarlyPayoffIntent } from "@/lib/wompi-early-payoff-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_SECURITY_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
} as const;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const RATE_LIMIT_BUCKET_CAP = 5_000;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  headers: Record<string, string>;
};

const receiptRateLimitBuckets = new Map<string, RateLimitBucket>();
let lastRateLimitSweepAt = 0;

function parsePositiveInteger(value: string) {
  if (!/^[1-9]\d*$/.test(value)) {
    return null;
  }

  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseDocument(value: string | null) {
  const document = String(value || "").trim();
  return /^\d{5,20}$/.test(document) ? document : null;
}

function cleanFilePart(value: string) {
  return String(value || "recibo")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "recibo";
}

function requestClientKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const clientAddress =
    forwardedFor ||
    request.headers.get("x-real-ip")?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    "unknown";

  return clientAddress.slice(0, 128);
}

function sweepRateLimitBuckets(now: number) {
  if (
    now - lastRateLimitSweepAt < RATE_LIMIT_WINDOW_MS &&
    receiptRateLimitBuckets.size < RATE_LIMIT_BUCKET_CAP
  ) {
    return;
  }

  lastRateLimitSweepAt = now;

  for (const [key, bucket] of receiptRateLimitBuckets) {
    if (bucket.resetAt <= now) {
      receiptRateLimitBuckets.delete(key);
    }
  }

  while (receiptRateLimitBuckets.size >= RATE_LIMIT_BUCKET_CAP) {
    const oldestKey = receiptRateLimitBuckets.keys().next().value as string | undefined;
    if (!oldestKey) break;
    receiptRateLimitBuckets.delete(oldestKey);
  }
}

function consumeReceiptRateLimit(request: Request): RateLimitResult {
  const now = Date.now();
  const key = requestClientKey(request);
  sweepRateLimitBuckets(now);

  const current = receiptRateLimitBuckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
      : current;
  const allowed = bucket.count < RATE_LIMIT_MAX_REQUESTS;

  if (allowed) {
    bucket.count += 1;
  }

  receiptRateLimitBuckets.set(key, bucket);

  const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count);
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
    "RateLimit-Remaining": String(remaining),
    "RateLimit-Reset": String(resetSeconds),
    "X-RateLimit-Limit": String(RATE_LIMIT_MAX_REQUESTS),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(bucket.resetAt / 1000)),
  };

  if (!allowed) {
    headers["Retry-After"] = String(resetSeconds);
  }

  return { allowed, headers };
}

function receiptNotFound(rateLimitHeaders: Record<string, string>) {
  return NextResponse.json(
    { error: "Recibo no disponible" },
    {
      status: 404,
      headers: { ...RESPONSE_SECURITY_HEADERS, ...rateLimitHeaders },
    }
  );
}

function isEarlyPayoffObservation(value: string | null) {
  return /LIQUIDACI(?:O|Ó)N\s+ANTICIPADA/i.test(String(value || ""));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; abonoId: string }> }
) {
  const rateLimit = consumeReceiptRateLimit(request);

  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Demasiadas solicitudes. Intenta nuevamente en unos segundos." },
      {
        status: 429,
        headers: { ...RESPONSE_SECURITY_HEADERS, ...rateLimit.headers },
      }
    );
  }

  try {
    const params = await context.params;
    const creditId = parsePositiveInteger(params.id);
    const paymentId = parsePositiveInteger(params.abonoId);
    const requestUrl = new URL(request.url);
    const document = parseDocument(requestUrl.searchParams.get("documento"));

    if (!creditId || !paymentId || !document) {
      return receiptNotFound(rateLimit.headers);
    }

    const resolved = await prisma.$transaction(
      async (tx) => {
        const payment = await tx.creditoAbono.findFirst({
          where: {
            id: paymentId,
            creditoId: creditId,
            estado: {
              not: "ANULADO",
            },
            credito: {
              id: creditId,
              clienteDocumento: document,
              estado: {
                not: "ANULADO",
              },
            },
          },
          select: {
            id: true,
            creditoId: true,
            valor: true,
            metodoPago: true,
            observacion: true,
            fechaAbono: true,
            credito: {
              select: {
                folio: true,
                clienteNombre: true,
                clienteDocumento: true,
                pazYSalvoEmitidoAt: true,
              },
            },
          },
        });

        if (!payment || payment.credito.clienteDocumento !== document) {
          return null;
        }

        const activePayments = await tx.creditoAbono.findMany({
          where: {
            creditoId: creditId,
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            id: true,
            valor: true,
            fechaAbono: true,
          },
          orderBy: [{ fechaAbono: "asc" }, { id: "asc" }],
        });
        const paymentIntent = await tx.wompiPaymentIntent.findFirst({
          where: {
            creditoId: creditId,
            processedAbonoId: paymentId,
          },
          select: {
            cuotaNumeros: true,
            reference: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        return { activePayments, payment, paymentIntent };
      },
      { isolationLevel: "RepeatableRead" }
    );

    if (!resolved) {
      return receiptNotFound(rateLimit.headers);
    }

    const { activePayments, payment, paymentIntent } = resolved;
    const paymentIndex = activePayments.findIndex((item) => item.id === payment.id);

    if (paymentIndex < 0) {
      return receiptNotFound(rateLimit.headers);
    }

    const paymentsThroughReceipt = activePayments.slice(0, paymentIndex + 1);
    const totalPaidThroughPayment = paymentsThroughReceipt.reduce(
      (sum, item) => sum + Number(item.valor || 0),
      0
    );
    const closesCredit = Boolean(
      activePayments.at(-1)?.id === payment.id && payment.credito.pazYSalvoEmitidoAt
    );
    const isEarlyPayoff = Boolean(
      isEarlyPayoffObservation(payment.observacion) ||
        isWompiEarlyPayoffIntent(
          paymentIntent?.cuotaNumeros,
          paymentIntent?.reference
        )
    );
    const receiptNumber = `RP-${payment.credito.folio}-${payment.id}`;
    const pdf = await buildClientPaymentReceiptPdf({
      receiptNumber,
      paymentDate: payment.fechaAbono,
      paymentMethod: payment.metodoPago,
      paymentAmount: Number(payment.valor || 0),
      clientName: payment.credito.clienteNombre,
      clientDocument: document,
      creditFolio: payment.credito.folio,
      totalPaidThroughPayment,
      paymentSequence: paymentIndex + 1,
      paymentType: isEarlyPayoff ? "EARLY_PAYOFF" : "PAYMENT",
      creditClosed: closesCredit,
      settledAt: closesCredit ? payment.credito.pazYSalvoEmitidoAt : null,
    });
    const disposition = requestUrl.searchParams.get("download") === "1"
      ? "attachment"
      : "inline";
    const filename = `recibo-pago-${cleanFilePart(payment.credito.folio)}-${payment.id}.pdf`;

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...RESPONSE_SECURITY_HEADERS,
        ...rateLimit.headers,
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error("ERROR GENERANDO RECIBO DE CLIENTE:", error);
    return NextResponse.json(
      { error: "No se pudo generar el recibo" },
      {
        status: 500,
        headers: { ...RESPONSE_SECURITY_HEADERS, ...rateLimit.headers },
      }
    );
  }
}
