import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { resolveCreditPaymentSummary, sanitizeSearch } from "@/lib/credit-factory";

type PaymentAggregate = {
  abonosCount: number;
  totalAbonado: number;
  ultimoAbonoAt: Date | null;
};

function parsePositiveInt(value: string | null) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseDate(value: string | null, endOfDay = false) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }

  return parsed;
}

async function buildPaymentSummaryMap(creditIds: number[]) {
  const map = new Map<number, PaymentAggregate>();

  if (!creditIds.length) {
    return map;
  }

  const grouped = await prisma.creditoAbono.groupBy({
    by: ["creditoId"],
    where: {
      creditoId: {
        in: creditIds,
      },
    },
    _count: {
      _all: true,
    },
    _sum: {
      valor: true,
    },
    _max: {
      fechaAbono: true,
    },
  });

  for (const item of grouped) {
    map.set(item.creditoId, {
      abonosCount: item._count._all,
      totalAbonado: Number(item._sum.valor || 0),
      ultimoAbonoAt: item._max.fechaAbono || null,
    });
  }

  return map;
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede ver el reporte de creditos" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const search = sanitizeSearch(searchParams.get("search"));
    const sedeId = parsePositiveInt(searchParams.get("sedeId"));
    const from = parseDate(searchParams.get("from"));
    const to = parseDate(searchParams.get("to"), true);

    const where: Prisma.CreditoWhereInput = {
      ...(sedeId ? { sedeId } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { clienteNombre: { contains: search, mode: "insensitive" } },
              { clienteDocumento: { contains: search, mode: "insensitive" } },
              { clienteTelefono: { contains: search, mode: "insensitive" } },
              { folio: { contains: search, mode: "insensitive" } },
              { imei: { contains: search, mode: "insensitive" } },
              { deviceUid: { contains: search, mode: "insensitive" } },
              { equipoMarca: { contains: search, mode: "insensitive" } },
              { equipoModelo: { contains: search, mode: "insensitive" } },
              { sede: { nombre: { contains: search, mode: "insensitive" } } },
              { usuario: { nombre: { contains: search, mode: "insensitive" } } },
              { vendedor: { nombre: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const items = await prisma.credito.findMany({
      where,
      include: {
        usuario: {
          select: {
            id: true,
            nombre: true,
            usuario: true,
          },
        },
        vendedor: {
          select: {
            id: true,
            nombre: true,
            documento: true,
          },
        },
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 500,
    });

    const paymentMap = await buildPaymentSummaryMap(items.map((item) => item.id));

    const rows = items.map((item) => {
      const payment = paymentMap.get(item.id) || {
        abonosCount: 0,
        totalAbonado: 0,
        ultimoAbonoAt: null,
      };
      const summary = resolveCreditPaymentSummary({
        montoCredito: item.montoCredito,
        cuotaInicial: item.cuotaInicial,
        totalAbonado: payment.totalAbonado,
        abonosCount: payment.abonosCount,
      });

      return {
        id: item.id,
        folio: item.folio,
        clienteNombre: item.clienteNombre,
        clienteDocumento: item.clienteDocumento,
        clienteTelefono: item.clienteTelefono,
        imei: item.imei,
        equipoMarca: item.equipoMarca,
        equipoModelo: item.equipoModelo,
        montoCredito: Number(item.montoCredito || 0),
        cuotaInicial: Number(item.cuotaInicial || 0),
        valorCuota: Number(item.valorCuota || 0),
        plazoMeses: item.plazoMeses,
        estado: item.estado,
        deliverableReady: item.deliverableReady,
        deliverableLabel: item.deliverableLabel,
        totalAbonado: summary.totalAbonado,
        saldoPendiente: summary.saldoPendiente,
        totalRecaudado: summary.totalRecaudado,
        abonosCount: summary.abonosCount,
        fechaCredito: item.fechaCredito.toISOString(),
        fechaPrimerPago: item.fechaPrimerPago?.toISOString() || null,
        fechaProximoPago: item.fechaProximoPago?.toISOString() || null,
        usuario: item.vendedor
          ? {
              id: item.vendedor.id,
              nombre: item.vendedor.nombre,
              usuario: item.vendedor.documento || item.usuario.usuario,
            }
          : item.usuario,
        sede: item.sede,
      };
    });

    const summary = rows.reduce(
      (acc, item) => {
        acc.totalCreditos += 1;
        acc.totalMontoCredito += item.montoCredito;
        acc.totalAbonado += item.totalAbonado;
        acc.totalRecaudado += item.totalRecaudado;
        acc.totalPendiente += item.saldoPendiente;

        if (item.saldoPendiente <= 0) {
          acc.creditosPagados += 1;
        }

        if (item.deliverableReady) {
          acc.entregables += 1;
        }

        return acc;
      },
      {
        totalCreditos: 0,
        totalMontoCredito: 0,
        totalAbonado: 0,
        totalRecaudado: 0,
        totalPendiente: 0,
        creditosPagados: 0,
        entregables: 0,
      }
    );

    return NextResponse.json({
      ok: true,
      filters: {
        search,
        sedeId,
        from: from?.toISOString() || null,
        to: to?.toISOString() || null,
      },
      summary,
      items: rows,
    });
  } catch (error) {
    console.error("ERROR REPORTE CREDITOS:", error);
    return NextResponse.json(
      { error: "No se pudo cargar el reporte de creditos" },
      { status: 500 }
    );
  }
}
