import { NextResponse } from "next/server";
import { getCreditDisplayNumbers } from "@/lib/credit-display-number-server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import {
  resolveCreditPaymentSummary,
  resolveCreditState,
} from "@/lib/credit-factory";
import { isAdminRole } from "@/lib/roles";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  buildCreditAccessWhere,
  buildCreditLookupWhere,
  parseCreditRouteLookup,
} from "@/lib/credit-route-lookup";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditPazYSalvoPdf } from "@/lib/credit-paz-y-salvo-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const sellerSession = admin ? null : await getSellerSessionUser(user);
    const supervisor = sellerSession?.tipoPerfil === "SUPERVISOR";

    if (!admin && !supervisor) {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede descargar paz y salvo" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditLookup = parseCreditRouteLookup(params.id);

    if (!creditLookup.id && !creditLookup.folio) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const lookupWhere = buildCreditLookupWhere(creditLookup);
    const accessWhere = buildCreditAccessWhere({
      admin,
      adminCentral,
      aliadoId: user.aliadoAccesoId,
      sedeId: user.sedeId,
      sellerSedeId: sellerSession?.sedeId,
      supervisor,
    });

    const candidate = await prisma.credito.findFirst({
      where: {
        AND: [lookupWhere, accessWhere],
      },
      select: { id: true },
    });

    if (!candidate) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const resolved = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id"
        FROM "Credito"
        WHERE "id" = ${candidate.id}
        FOR UPDATE
      `;

      if (!locked.length) {
        return { kind: "NOT_FOUND" as const };
      }

      const credito = await tx.credito.findFirst({
        where: {
          id: candidate.id,
          AND: [accessWhere],
          estado: { not: "ANULADO" },
        },
        include: {
          usuario: {
            select: {
              nombre: true,
              usuario: true,
            },
          },
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

      const aggregate = await tx.creditoAbono.aggregate({
        where: {
          creditoId: credito.id,
          estado: { not: "ANULADO" },
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

      await tx.credito.updateMany({
        where: {
          id: credito.id,
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

      const issued = await tx.credito.findUnique({
        where: { id: credito.id },
        select: { pazYSalvoEmitidoAt: true },
      });

      if (!issued?.pazYSalvoEmitidoAt) {
        return { kind: "ISSUE_FAILED" as const };
      }

      return {
        credito,
        issuedAt: issued.pazYSalvoEmitidoAt,
        kind: "READY" as const,
      };
    });

    if (resolved.kind === "NOT_FOUND") {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    if (resolved.kind === "BALANCE_PENDING") {
      return NextResponse.json(
        {
          error:
            "Solo se puede emitir paz y salvo cuando el saldo pendiente esta en $0",
        },
        { status: 400 }
      );
    }

    if (resolved.kind === "ISSUE_FAILED") {
      return NextResponse.json(
        { error: "No se pudo confirmar la emision del paz y salvo" },
        { status: 409 }
      );
    }

    const { credito, issuedAt } = resolved;

    const buffer = await buildCreditPazYSalvoPdf({
      clienteDocumento: credito.clienteDocumento,
      clienteNombre: credito.clienteNombre,
      deliverableLabel: credito.deliverableLabel,
      deviceUid: credito.deviceUid,
      equipo: credito.referenciaEquipo,
      estado: "PAZ_Y_SALVO",
      folio: credito.folio,
      numeroCreditoVisible: (await getCreditDisplayNumbers([credito.id])).get(credito.id) || credito.folio,
      imei: credito.imei,
      issuedAt,
      issuer: `${user.nombre} (${user.usuario})`,
      referenciaPago: credito.referenciaPago,
      sedeNombre: credito.sede.nombre,
    });

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="paz-y-salvo-${credito.folio}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO PAZ Y SALVO:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el paz y salvo" },
      { status: 500 }
    );
  }
}
