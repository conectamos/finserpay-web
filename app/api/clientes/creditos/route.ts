import { NextResponse } from "next/server";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { sanitizeSearch } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import prisma from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const documento = sanitizeSearch(searchParams.get("documento"));

    if (!documento || documento.length < 5) {
      return NextResponse.json(
        { error: "Ingresa un numero de cedula valido" },
        { status: 400 }
      );
    }

    await ensureCreditAbonoAuditColumns();

    const credits = await prisma.credito.findMany({
      where: {
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
        referenciaEquipo: true,
        equipoMarca: true,
        equipoModelo: true,
        montoCredito: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        fechaCredito: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        sede: {
          select: {
            nombre: true,
          },
        },
        abonos: {
          where: {
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            id: true,
            valor: true,
            fechaAbono: true,
            metodoPago: true,
          },
          orderBy: {
            fechaAbono: "desc",
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
    });

    const items = credits.map((credit) => {
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

      return {
        id: credit.id,
        folio: credit.folio,
        clienteNombre: credit.clienteNombre,
        clienteDocumento: credit.clienteDocumento,
        referenciaEquipo:
          credit.referenciaEquipo ||
          [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" "),
        fechaCredito: credit.fechaCredito.toISOString(),
        montoCredito: Number(credit.montoCredito || 0),
        valorCuota: Number(credit.valorCuota || 0),
        sedeNombre: credit.sede.nombre,
        estadoPago: plan.estadoPago,
        saldoPendiente: plan.saldoPendiente,
        saldoDisponible: plan.totalPaid,
        totalPagado: plan.totalPaid,
        cuotas: plan.installments,
        abonos: credit.abonos.map((item) => ({
          id: item.id,
          valor: Number(item.valor || 0),
          metodoPago: item.metodoPago,
          fechaAbono: item.fechaAbono.toISOString(),
        })),
      };
    });

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    console.error("ERROR CONSULTA CLIENTE CREDITOS:", error);
    return NextResponse.json(
      { error: "No se pudo consultar el estado del credito" },
      { status: 500 }
    );
  }
}
