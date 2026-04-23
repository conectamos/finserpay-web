import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

function parseSedeId(value: string | null) {
  const sedeId = Number(value);
  return Number.isInteger(sedeId) && sedeId > 0 ? sedeId : null;
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const requestUrl = new URL(req.url);
    const sedeIdFiltro = parseSedeId(requestUrl.searchParams.get("sedeId"));

    const movimientos = await prisma.movimientoCajaSede.findMany({
      where: esAdmin
        ? {
            tipo: "PENDIENTE_APROBACION",
            prestamoId: { not: null },
            ...(sedeIdFiltro
              ? {
                  prestamo: {
                    is: {
                      OR: [
                        { sedeOrigenId: sedeIdFiltro },
                        { sedeDestinoId: sedeIdFiltro },
                      ],
                    },
                  },
                }
              : {}),
          }
        : {
            tipo: "PENDIENTE_APROBACION",
            prestamoId: { not: null },
            prestamo: {
              is: {
                OR: [
                  { sedeOrigenId: user.sedeId },
                  { sedeDestinoId: user.sedeId },
                ],
              },
            },
          },
      select: {
        id: true,
        valor: true,
        createdAt: true,
        prestamo: {
          select: {
            id: true,
            imei: true,
            referencia: true,
            costo: true,
            sedeOrigenId: true,
            sedeDestinoId: true,
            estado: true,
            fechaSolicitudPago: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const sedeIds = Array.from(
      new Set(
        movimientos.flatMap((movimiento) =>
          movimiento.prestamo
            ? [
                movimiento.prestamo.sedeOrigenId,
                movimiento.prestamo.sedeDestinoId,
              ]
            : []
        )
      )
    );

    const sedes =
      sedeIds.length > 0
        ? await prisma.sede.findMany({
            where: {
              id: {
                in: sedeIds,
              },
            },
            select: {
              id: true,
              nombre: true,
            },
          })
        : [];

    const nombresSede = new Map(sedes.map((sede) => [sede.id, sede.nombre]));

    const items = movimientos
      .filter((movimiento) => movimiento.prestamo)
      .map((movimiento) => {
        const prestamo = movimiento.prestamo!;

        return {
          id: movimiento.id,
          prestamoId: prestamo.id,
          imei: prestamo.imei,
          referencia: prestamo.referencia,
          valor: Number(movimiento.valor || prestamo.costo || 0),
          sedeOrigenId: prestamo.sedeOrigenId,
          sedeOrigenNombre:
            nombresSede.get(prestamo.sedeOrigenId) ||
            `SEDE ${prestamo.sedeOrigenId}`,
          sedeDestinoId: prestamo.sedeDestinoId,
          sedeDestinoNombre:
            nombresSede.get(prestamo.sedeDestinoId) ||
            `SEDE ${prestamo.sedeDestinoId}`,
          fechaSolicitudPago:
            prestamo.fechaSolicitudPago?.toISOString() ||
            movimiento.createdAt.toISOString(),
          estado: prestamo.estado,
          puedeAprobar: esAdmin || user.sedeId === prestamo.sedeOrigenId,
        };
      });

    const totalPendiente = items.reduce(
      (acumulado, item) => acumulado + Number(item.valor || 0),
      0
    );

    return NextResponse.json({
      totalPendiente,
      items,
    });
  } catch (error) {
    console.error("ERROR DASHBOARD DEUDA SEDES:", error);
    return NextResponse.json(
      { error: "Error cargando deuda entre sedes" },
      { status: 500 }
    );
  }
}
