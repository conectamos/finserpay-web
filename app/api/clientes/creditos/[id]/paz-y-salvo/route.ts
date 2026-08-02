import { NextResponse } from "next/server";
import {
  resolveCreditPaymentSummary,
  resolveCreditState,
  sanitizeSearch,
} from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { buildCreditPazYSalvoPdf } from "@/lib/credit-paz-y-salvo-pdf";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseCreditId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  let failureStage = "REQUEST";

  try {
    const params = await context.params;
    const creditId = parseCreditId(params.id);
    const documento = sanitizeSearch(
      new URL(req.url).searchParams.get("documento")
    ).replace(/\D/g, "");

    if (!creditId || !/^\d{5,20}$/.test(documento)) {
      return NextResponse.json(
        { error: "Credito o documento invalido" },
        { status: 400 }
      );
    }

    failureStage = "AUDIT_COLUMNS";
    await ensureCreditAbonoAuditColumns();

    const resolved = await prisma.$transaction(async (tx) => {
      failureStage = "LOCK_CREDIT";
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "Credito"
        WHERE "id" = ${creditId}
          AND "clienteDocumento" = ${documento}
          AND "estado" <> 'ANULADO'
        FOR UPDATE
      `;

      if (!locked.length) {
        return { kind: "NOT_FOUND" as const };
      }

      failureStage = "LOAD_CREDIT";
      const credito = await tx.credito.findFirst({
        where: {
          id: creditId,
          clienteDocumento: documento,
          estado: {
            not: "ANULADO",
          },
        },
        select: {
          clienteDocumento: true,
          clienteNombre: true,
          cuotaInicial: true,
          deliverableLabel: true,
          folio: true,
          id: true,
          montoCredito: true,
          pazYSalvoEmitidoAt: true,
          referenciaEquipo: true,
          sede: {
            select: {
              nombre: true,
            },
          },
        },
      });

      if (!credito) {
        return { kind: "NOT_FOUND" as const };
      }

      failureStage = "SUM_PAYMENTS";
      const aggregate = await tx.creditoAbono.aggregate({
        where: {
          creditoId: credito.id,
          estado: {
            not: "ANULADO",
          },
        },
        _count: { _all: true },
        _sum: { valor: true },
      });
      const paymentSummary = resolveCreditPaymentSummary({
        montoCredito: credito.montoCredito,
        cuotaInicial: credito.cuotaInicial,
        totalAbonado: Number(aggregate._sum.valor || 0),
        abonosCount: aggregate._count._all,
      });

      if (Math.round(paymentSummary.saldoPendiente * 100) > 0) {
        return { kind: "BALANCE_PENDING" as const };
      }

      const candidateIssuedAt = credito.pazYSalvoEmitidoAt || new Date();

      failureStage = "MARK_ISSUED";
      await tx.credito.updateMany({
        where: {
          id: credito.id,
          clienteDocumento: documento,
          pazYSalvoEmitidoAt: null,
          estado: { not: "ANULADO" },
        },
        data: {
          estado: resolveCreditState({
            pazYSalvoEmitidoAt: candidateIssuedAt,
          }),
          pazYSalvoEmitidoAt: candidateIssuedAt,
        },
      });

      failureStage = "CONFIRM_ISSUED";
      const issued = await tx.credito.findFirst({
        where: {
          id: credito.id,
          clienteDocumento: documento,
          estado: { not: "ANULADO" },
        },
        select: { pazYSalvoEmitidoAt: true },
      });

      if (!issued?.pazYSalvoEmitidoAt) {
        return { kind: "ISSUE_FAILED" as const };
      }

      return {
        kind: "READY" as const,
        credito,
        issuedAt: issued.pazYSalvoEmitidoAt,
      };
    });

    if (resolved.kind === "NOT_FOUND") {
      return NextResponse.json(
        { error: "Credito no encontrado para ese documento" },
        { status: 404 }
      );
    }

    if (resolved.kind === "BALANCE_PENDING") {
      return NextResponse.json(
        { error: "El credito todavia tiene saldo pendiente" },
        { status: 409 }
      );
    }

    if (resolved.kind === "ISSUE_FAILED") {
      return NextResponse.json(
        { error: "No se pudo confirmar la emision del paz y salvo" },
        { status: 409 }
      );
    }

    const { credito, issuedAt } = resolved;

    failureStage = "RENDER_PDF";
    const buffer = await buildCreditPazYSalvoPdf({
      clienteDocumento: credito.clienteDocumento,
      clienteNombre: credito.clienteNombre,
      deliverableLabel: credito.deliverableLabel,
      deviceUid: null,
      equipo: credito.referenciaEquipo,
      estado: "PAZ_Y_SALVO",
      folio: credito.folio,
      imei: null,
      issuedAt,
      issuer: "FINSER PAY",
      referenciaPago: null,
      sedeNombre: credito.sede.nombre,
    });

    const safeFolio =
      credito.folio.replace(/[^A-Za-z0-9_-]/g, "-") || String(credito.id);

    failureStage = "RETURN_PDF";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="paz-y-salvo-${safeFolio}.pdf"`,
        "Content-Type": "application/pdf",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    const errorCode = `PYS_${failureStage}`;
    console.error("ERROR DESCARGANDO PAZ Y SALVO CLIENTE:", {
      error,
      stage: failureStage,
    });
    return NextResponse.json(
      {
        code: errorCode,
        error: "No se pudo descargar el paz y salvo",
      },
      {
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Finser-Error-Code": errorCode,
        },
        status: 500,
      }
    );
  }
}
