import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { resolveCreditPaymentSummary, sanitizeSearch } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";

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

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede ver el reporte de abonos" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const search = sanitizeSearch(searchParams.get("search"));
    const sedeId = admin ? parsePositiveInt(searchParams.get("sedeId")) : user.sedeId;
    const from = parseDate(searchParams.get("from"));
    const to = parseDate(searchParams.get("to"), true);

    const creditWhere: Prisma.CreditoWhereInput = {
      ...(sedeId ? { sedeId } : {}),
      ...(search
        ? {
            OR: [
              { clienteNombre: { contains: search, mode: "insensitive" } },
              { clienteDocumento: { contains: search, mode: "insensitive" } },
              { clienteTelefono: { contains: search, mode: "insensitive" } },
              { folio: { contains: search, mode: "insensitive" } },
              { imei: { contains: search, mode: "insensitive" } },
              { deviceUid: { contains: search, mode: "insensitive" } },
              { sede: { nombre: { contains: search, mode: "insensitive" } } },
              { usuario: { nombre: { contains: search, mode: "insensitive" } } },
              { vendedor: { nombre: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    };

    const credits = await prisma.credito.findMany({
      where: creditWhere,
      select: {
        id: true,
        folio: true,
        clienteNombre: true,
        clienteDocumento: true,
        montoCredito: true,
        cuotaInicial: true,
        estado: true,
        sedeId: true,
      },
    });

    const creditIds = credits.map((item) => item.id);
    const activeCredits = credits.filter((item) => item.estado !== "ANULADO");
    const activeCreditIds = activeCredits.map((item) => item.id);
    const creditMap = new Map(credits.map((item) => [item.id, item]));

    const abonosWhere: Prisma.CreditoAbonoWhereInput = {
      ...(creditIds.length
        ? {
            creditoId: {
              in: creditIds,
            },
          }
        : {
            creditoId: -1,
          }),
      ...(from || to
        ? {
            fechaAbono: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const abonos = await prisma.creditoAbono.findMany({
      where: abonosWhere,
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
        credito: {
          select: {
            id: true,
            folio: true,
            clienteNombre: true,
            clienteDocumento: true,
            estado: true,
          },
        },
      },
      orderBy: {
        fechaAbono: "desc",
      },
      take: 500,
    });

    const abonosRows = abonos.map((item) => ({
      id: item.id,
      valor: Number(item.valor || 0),
      metodoPago: item.metodoPago,
      observacion: item.observacion,
      estado: item.estado || "ACTIVO",
      anuladoAt: item.anuladoAt?.toISOString() || null,
      anulacionMotivo: item.anulacionMotivo || null,
      fechaAbono: item.fechaAbono.toISOString(),
      credito: item.credito,
      usuario: item.vendedor
        ? {
            id: item.vendedor.id,
            nombre: item.vendedor.nombre,
            usuario: item.vendedor.documento || item.usuario.usuario,
          }
        : item.usuario,
      sede: item.sede,
    }));

    const activeAbonosRows = abonosRows.filter(
      (item) => item.estado !== "ANULADO" && item.credito.estado !== "ANULADO"
    );
    const dailyMap = new Map<string, { fecha: string; total: number; cantidad: number }>();

    for (const item of activeAbonosRows) {
      const dayKey = item.fechaAbono.slice(0, 10);
      const current = dailyMap.get(dayKey) || {
        fecha: dayKey,
        total: 0,
        cantidad: 0,
      };

      current.total += item.valor;
      current.cantidad += 1;
      dailyMap.set(dayKey, current);
    }

    const paymentGrouped = activeCreditIds.length
      ? await prisma.creditoAbono.groupBy({
          by: ["creditoId"],
          where: {
            creditoId: {
              in: activeCreditIds,
            },
            estado: {
              not: "ANULADO",
            },
          },
          _sum: {
            valor: true,
          },
          _count: {
            _all: true,
          },
        })
      : [];

    const paymentGroupMap = new Map(
      paymentGrouped.map((item) => [
        item.creditoId,
        {
          totalAbonado: Number(item._sum.valor || 0),
          abonosCount: item._count._all,
        },
      ])
    );

    const pendingSummary = activeCredits.reduce(
      (acc, credit) => {
        const paymentGroup = paymentGroupMap.get(credit.id) || {
          totalAbonado: 0,
          abonosCount: 0,
        };

        const payment = resolveCreditPaymentSummary({
          montoCredito: Number(credit.montoCredito || 0),
          cuotaInicial: Number(credit.cuotaInicial || 0),
          totalAbonado: paymentGroup.totalAbonado,
          abonosCount: paymentGroup.abonosCount,
        });

        acc.totalPendiente += payment.saldoPendiente;
        acc.totalRecaudado += payment.totalRecaudado;
        acc.totalCreditos += 1;

        if (payment.saldoPendiente <= 0) {
          acc.creditosAlDia += 1;
        }

        return acc;
      },
      {
        totalPendiente: 0,
        totalRecaudado: 0,
        totalCreditos: 0,
        creditosAlDia: 0,
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
      summary: {
        totalAbonos: activeAbonosRows.length,
        totalRecaudadoPeriodo: activeAbonosRows.reduce((acc, item) => acc + item.valor, 0),
        totalPendientePorCobrar: pendingSummary.totalPendiente,
        totalRecaudadoGeneral: pendingSummary.totalRecaudado,
        totalCreditos: pendingSummary.totalCreditos,
        creditosAlDia: pendingSummary.creditosAlDia,
      },
      byDay: Array.from(dailyMap.values()).sort((a, b) =>
        b.fecha.localeCompare(a.fecha)
      ),
      items: abonosRows,
    });
  } catch (error) {
    console.error("ERROR REPORTE ABONOS DE CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo cargar el reporte de abonos" },
      { status: 500 }
    );
  }
}
