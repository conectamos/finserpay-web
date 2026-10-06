import { NextResponse } from "next/server";
import { readMassCreditComponents } from "@/lib/mass-credit-financial-components";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { calculateCreditEarlyPayoff } from "@/lib/credit-early-payoff";
import { sanitizeSearch } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getActiveMoraBlockExemptionByDocument } from "@/lib/mora-block-exemptions";
import { getActiveMoraExceptionsByCreditIds } from "@/lib/mora-exception-requests";
import prisma from "@/lib/prisma";
import { getCreditDisplayNumbers, withCreditDisplayNumber } from "@/lib/credit-display-number-server";

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
        clienteTelefono: true,
        referenciaEquipo: true,
        equipoMarca: true,
        equipoModelo: true,
        imei: true,
        deviceUid: true,
        contratoSnapshot: true,
        saldoBaseFinanciado: true,
        planCapitalVigente: true,
        montoCredito: true,
        valorInteres: true,
        valorFianza: true,
        valorCuota: true,
        plazoMeses: true,
        frecuenciaPago: true,
        fechaCredito: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        pazYSalvoEmitidoAt: true,
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

    const displayNumbers = await getCreditDisplayNumbers(credits.map((credit) => credit.id));
    const items = credits.map((credit) => {
      const settled = Boolean(credit.pazYSalvoEmitidoAt);
      const plan = buildCreditPaymentPlan({
        planCapitalVigente: credit.planCapitalVigente,
        montoCredito: Number(credit.montoCredito || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        fechaProximoPago: credit.fechaProximoPago,
        abonos: credit.abonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
        settled,
      });
      const earlyPayoff = calculateCreditEarlyPayoff({
        contratoSnapshot: credit.contratoSnapshot,
        settled: Boolean(credit.pazYSalvoEmitidoAt),
        planCapitalVigente: credit.planCapitalVigente,
        saldoBaseFinanciado: Number(credit.saldoBaseFinanciado || 0),
        montoCredito: Number(credit.montoCredito || 0),
        valorInteres: Number(credit.valorInteres || 0),
        valorFianza: Number(credit.valorFianza || 0),
        valorCuota: Number(credit.valorCuota || 0),
        plazoMeses: Number(credit.plazoMeses || 1),
        frecuenciaPago: credit.frecuenciaPago,
        fechaPrimerPago: credit.fechaPrimerPago || credit.fechaProximoPago,
        fechaProximoPago: credit.fechaProximoPago,
        abonos: credit.abonos.map((item) => ({
          valor: Number(item.valor || 0),
          fechaAbono: item.fechaAbono,
        })),
      });

      const massComponents = readMassCreditComponents(credit.contratoSnapshot, credit);

      return {
        ...(massComponents ? { valorSeguro: massComponents.seguro, seguroCuotaPorcentaje: massComponents.seguroCuotaPorcentaje } : {}),
        id: credit.id,
        folio: credit.folio,
        clienteNombre: credit.clienteNombre,
        clienteDocumento: credit.clienteDocumento,
        clienteTelefono: credit.clienteTelefono,
        referenciaEquipo:
          credit.referenciaEquipo ||
          [credit.equipoMarca, credit.equipoModelo].filter(Boolean).join(" "),
        imei: credit.imei,
        deviceUid: credit.deviceUid,
        fechaCredito: credit.fechaCredito.toISOString(),
        montoCredito: Number(credit.montoCredito || 0),
        valorCuota: Number(credit.valorCuota || 0),
        sedeNombre: credit.sede.nombre,
        estadoPago: plan.estadoPago,
        saldoPendiente: plan.saldoPendiente,
        pazYSalvoEmitidoAt: credit.pazYSalvoEmitidoAt?.toISOString() || null,
        liquidacionAnticipada: {
          disponible: earlyPayoff.eligible,
          motivo: earlyPayoff.reason,
          capitalPendiente: earlyPayoff.capitalPendiente,
          condonacion: earlyPayoff.interesFianzaCondonado,
          saldoObligacion: settled ? 0 : earlyPayoff.saldoObligacion,
        },
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

    const hasMora = items.some((credit) => credit.estadoPago === "MORA");
    const [activeMoraExemption, activeCreditExceptions] = hasMora
      ? await Promise.all([
          getActiveMoraBlockExemptionByDocument(documento),
          getActiveMoraExceptionsByCreditIds(items.map(credit => credit.id)),
        ])
      : [null, new Map()];

    return NextResponse.json({
      ok: true,
      items: items.map((credit) =>
        withCreditDisplayNumber(
          {
            ...credit,
            prorrogaMora: credit.estadoPago === "MORA"
              ? activeCreditExceptions.has(credit.id)
                ? { hasta: activeCreditExceptions.get(credit.id)!.fechaFin.toISOString() }
                : activeMoraExemption
                  ? { hasta: activeMoraExemption.fechaFin?.toISOString() ?? null }
                  : null
              : null,
          },
          displayNumbers
        )
      ),
    });
  } catch (error) {
    console.error("ERROR CONSULTA CLIENTE CREDITOS:", error);
    return NextResponse.json(
      { error: "No se pudo consultar el estado del credito" },
      { status: 500 }
    );
  }
}
