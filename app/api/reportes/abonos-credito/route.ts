import { NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { resolveCreditPaymentSummary, sanitizeSearch } from "@/lib/credit-factory";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import {
  DIGITAL_COLLECTION_SEDE_CODE,
  DIGITAL_COLLECTION_SEDE_NAME,
} from "@/lib/digital-collection-sede";

function parsePositiveInt(value: string | null) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

const BOGOTA_UTC_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DIGITAL_COLLECTION_COLLECTOR_NAME = "DIGITAL";

function parseDate(value: string | null, endOfDay = false) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    return null;
  }

  const ymd = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    const utcStartOfBogotaDay = Date.UTC(year, month - 1, day) + BOGOTA_UTC_OFFSET_MS;

    return new Date(endOfDay ? utcStartOfBogotaDay + DAY_MS - 1 : utcStartOfBogotaDay);
  }

  const parsed = new Date(normalized);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (endOfDay) {
    parsed.setUTCHours(23, 59, 59, 999);
  } else {
    parsed.setUTCHours(0, 0, 0, 0);
  }

  return parsed;
}

function normalizeText(value: string | null | undefined) {
  return String(value || "").trim().toUpperCase();
}

function isDigitalCollectionSede(
  sede: { codigo?: string | null; nombre?: string | null } | null | undefined
) {
  const codigo = normalizeText(sede?.codigo).replace(/[\s-]+/g, "_");
  const nombre = normalizeText(sede?.nombre);

  return (
    codigo === DIGITAL_COLLECTION_SEDE_CODE ||
    nombre === DIGITAL_COLLECTION_SEDE_NAME ||
    (nombre.includes("RECAUDO") && nombre.includes("DIGITAL"))
  );
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
    const aliadoScopeId = Number(user.aliadoAccesoId || 0);
    const aliadoReportScopeId =
      Number.isInteger(aliadoScopeId) && aliadoScopeId > 0 ? aliadoScopeId : -1;
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede ver el reporte de abonos" },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(req.url);
    const search = sanitizeSearch(searchParams.get("search"));
    const searchDigits = search.replace(/\D/g, "");
    const sedeId = admin ? parsePositiveInt(searchParams.get("sedeId")) : user.sedeId;
    const requestedAliadoId = admin ? parsePositiveInt(searchParams.get("aliadoId")) : null;
    const selectedAliadoId =
      admin && adminCentral
        ? requestedAliadoId
        : admin
          ? aliadoReportScopeId
          : null;
    const from = parseDate(searchParams.get("from"));
    const to = parseDate(searchParams.get("to"), true);
    const creditSearchConditions: Prisma.CreditoWhereInput[] = search
      ? [
          { clienteNombre: { contains: search, mode: "insensitive" } },
          { clienteDocumento: { contains: search, mode: "insensitive" } },
          { clienteTelefono: { contains: search, mode: "insensitive" } },
          { folio: { contains: search, mode: "insensitive" } },
          { imei: { contains: search, mode: "insensitive" } },
          { deviceUid: { contains: search, mode: "insensitive" } },
          { sede: { nombre: { contains: search, mode: "insensitive" } } },
          { sede: { aliado: { is: { nombre: { contains: search, mode: "insensitive" } } } } },
          { sede: { aliado: { is: { codigo: { contains: search, mode: "insensitive" } } } } },
          { usuario: { nombre: { contains: search, mode: "insensitive" } } },
          { vendedor: { nombre: { contains: search, mode: "insensitive" } } },
        ]
      : [];
    const abonoSearchConditions: Prisma.CreditoAbonoWhereInput[] = search
      ? [
          { credito: { clienteNombre: { contains: search, mode: "insensitive" } } },
          { credito: { clienteDocumento: { contains: search, mode: "insensitive" } } },
          { credito: { clienteTelefono: { contains: search, mode: "insensitive" } } },
          { credito: { folio: { contains: search, mode: "insensitive" } } },
          { credito: { imei: { contains: search, mode: "insensitive" } } },
          { credito: { deviceUid: { contains: search, mode: "insensitive" } } },
          { sede: { nombre: { contains: search, mode: "insensitive" } } },
          { sede: { aliado: { is: { nombre: { contains: search, mode: "insensitive" } } } } },
          { sede: { aliado: { is: { codigo: { contains: search, mode: "insensitive" } } } } },
          { usuario: { nombre: { contains: search, mode: "insensitive" } } },
          { usuario: { usuario: { contains: search, mode: "insensitive" } } },
          { vendedor: { nombre: { contains: search, mode: "insensitive" } } },
          { vendedor: { documento: { contains: search, mode: "insensitive" } } },
          { metodoPago: { contains: search, mode: "insensitive" } },
          { observacion: { contains: search, mode: "insensitive" } },
        ]
      : [];

    if (searchDigits && searchDigits !== search) {
      creditSearchConditions.push(
        { clienteDocumento: { contains: searchDigits, mode: "insensitive" } },
        { clienteTelefono: { contains: searchDigits, mode: "insensitive" } },
        { imei: { contains: searchDigits, mode: "insensitive" } },
        { deviceUid: { contains: searchDigits, mode: "insensitive" } }
      );
      abonoSearchConditions.push(
        { credito: { clienteDocumento: { contains: searchDigits, mode: "insensitive" } } },
        { credito: { clienteTelefono: { contains: searchDigits, mode: "insensitive" } } },
        { credito: { imei: { contains: searchDigits, mode: "insensitive" } } },
        { credito: { deviceUid: { contains: searchDigits, mode: "insensitive" } } },
        { vendedor: { documento: { contains: searchDigits, mode: "insensitive" } } },
        { usuario: { usuario: { contains: searchDigits, mode: "insensitive" } } }
      );
    }

    const creditWhere: Prisma.CreditoWhereInput = {
      ...(admin && selectedAliadoId
        ? {
            sede: {
              aliadoId: selectedAliadoId,
            },
          }
        : {}),
      ...(sedeId ? { sedeId } : {}),
      ...(search
        ? {
            OR: creditSearchConditions,
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

    const activeCredits = credits.filter((item) => item.estado !== "ANULADO");
    const activeCreditIds = activeCredits.map((item) => item.id);

    const abonosWhere: Prisma.CreditoAbonoWhereInput = {
      ...(admin && selectedAliadoId
        ? {
            sede: {
              aliadoId: selectedAliadoId,
            },
          }
        : {}),
      ...(sedeId
        ? {
            sedeId,
          }
        : {}),
      ...(from || to
        ? {
            fechaAbono: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: abonoSearchConditions,
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
            codigo: true,
            id: true,
            nombre: true,
            aliadoId: true,
            aliado: {
              select: {
                id: true,
                nombre: true,
                codigo: true,
              },
            },
          },
        },
        credito: {
          select: {
            id: true,
            folio: true,
            clienteNombre: true,
            clienteDocumento: true,
            estado: true,
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
                codigo: true,
                id: true,
                nombre: true,
                aliadoId: true,
                aliado: {
                  select: {
                    id: true,
                    nombre: true,
                    codigo: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        fechaAbono: "desc",
      },
      take: 500,
    });

    const abonosRows = abonos.map((item) => {
      const digitalCollection = isDigitalCollectionSede(item.sede);

      return {
        id: item.id,
        valor: Number(item.valor || 0),
        metodoPago: item.metodoPago,
        observacion: item.observacion,
        estado: item.estado || "ACTIVO",
        anuladoAt: item.anuladoAt?.toISOString() || null,
        anulacionMotivo: item.anulacionMotivo || null,
        fechaAbono: item.fechaAbono.toISOString(),
        credito: item.credito,
        usuario: item.usuario,
        vendedor: digitalCollection
          ? {
              id: item.usuario.id,
              nombre: DIGITAL_COLLECTION_COLLECTOR_NAME,
              usuario: DIGITAL_COLLECTION_SEDE_CODE,
            }
          : item.vendedor
            ? {
                id: item.vendedor.id,
                nombre: item.vendedor.nombre,
                usuario: item.vendedor.documento || item.usuario.usuario,
              }
            : item.usuario,
        sede: item.sede,
      };
    });

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
        aliadoId: selectedAliadoId,
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
