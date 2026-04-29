import { NextResponse } from "next/server";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { resolveCreditPaymentSummary, sanitizeText } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AnnulPaymentBody = {
  motivo?: string | null;
};

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function serializeDate(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string; abonoId: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede anular recaudos" },
        { status: 403 }
      );
    }

    await ensureCreditAbonoAuditColumns();

    const params = await context.params;
    const creditId = parseId(params.id);
    const abonoId = parseId(params.abonoId);

    if (!creditId || !abonoId) {
      return NextResponse.json({ error: "Recaudo invalido" }, { status: 400 });
    }

    const body = (await req.json().catch(() => ({}))) as AnnulPaymentBody;
    const motivo = sanitizeText(body.motivo) || "Anulacion administrativa";

    const result = await prisma.$transaction(async (tx) => {
      const abono = await tx.creditoAbono.findFirst({
        where: {
          id: abonoId,
          creditoId: creditId,
        },
        include: {
          credito: {
            select: {
              id: true,
              folio: true,
              clienteNombre: true,
              montoCredito: true,
              cuotaInicial: true,
              valorCuota: true,
              plazoMeses: true,
              frecuenciaPago: true,
              fechaPrimerPago: true,
              fechaProximoPago: true,
              sedeId: true,
            },
          },
        },
      });

      if (!abono) {
        return {
          status: 404 as const,
          body: { error: "Recaudo no encontrado" },
        };
      }

      if (abono.estado === "ANULADO") {
        return {
          status: 400 as const,
          body: { error: "Este recaudo ya fue anulado" },
        };
      }

      const anuladoAt = new Date();
      const auditLine = `[${anuladoAt.toISOString()}] ANULACION: ${motivo}`;
      const observacion = [abono.observacion, auditLine].filter(Boolean).join("\n");

      const updated = await tx.creditoAbono.update({
        where: { id: abono.id },
        data: {
          estado: "ANULADO",
          anuladoAt,
          anuladoPorUsuarioId: user.id,
          anulacionMotivo: motivo,
          observacion,
        },
      });

      const activeAbonos = await tx.creditoAbono.findMany({
        where: {
          creditoId: abono.creditoId,
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
        montoCredito: Number(abono.credito.montoCredito || 0),
        valorCuota: Number(abono.credito.valorCuota || 0),
        plazoMeses: Number(abono.credito.plazoMeses || 1),
        frecuenciaPago: abono.credito.frecuenciaPago,
        fechaPrimerPago: abono.credito.fechaPrimerPago || abono.credito.fechaProximoPago,
        abonos: activeAbonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
      });

      await tx.credito.update({
        where: { id: abono.creditoId },
        data: {
          fechaProximoPago: plan.nextInstallment?.fechaVencimiento
            ? new Date(`${plan.nextInstallment.fechaVencimiento}T12:00:00.000Z`)
            : abono.credito.fechaProximoPago,
        },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "EGRESO",
          concepto: "ANULACION ABONO CREDITO",
          valor: Number(abono.valor || 0),
          descripcion: [
            `Anulacion de recaudo ${abono.id}`,
            `Folio: ${abono.credito.folio}`,
            `Cliente: ${abono.credito.clienteNombre}`,
            `Motivo: ${motivo}`,
          ].join(" | "),
          sedeId: abono.sedeId,
        },
      });

      const totalAbonado = activeAbonos.reduce(
        (sum, item) => sum + Number(item.valor || 0),
        0
      );
      const summary = resolveCreditPaymentSummary({
        montoCredito: Number(abono.credito.montoCredito || 0),
        cuotaInicial: Number(abono.credito.cuotaInicial || 0),
        totalAbonado,
        abonosCount: activeAbonos.length,
      });

      return {
        status: 200 as const,
        body: {
          ok: true,
          message: "Recaudo anulado correctamente",
          item: {
            id: updated.id,
            creditoId: updated.creditoId,
            valor: Number(updated.valor || 0),
            metodoPago: updated.metodoPago,
            observacion: updated.observacion,
            estado: updated.estado,
            anuladoAt: serializeDate(updated.anuladoAt),
            anulacionMotivo: updated.anulacionMotivo,
            anuladoPorUsuarioId: updated.anuladoPorUsuarioId,
            fechaAbono: updated.fechaAbono.toISOString(),
          },
          summary,
        },
      };
    });

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    console.error("ERROR ANULANDO RECAUDO:", error);
    return NextResponse.json(
      { error: "No se pudo anular el recaudo" },
      { status: 500 }
    );
  }
}
