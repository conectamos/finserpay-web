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

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";
    const requestUrl = new URL(req.url);
    const sedeIdFiltro = parseSedeId(requestUrl.searchParams.get("sedeId"));

    const prestamos = await prisma.prestamoSede.findMany({
      where: esAdmin
        ? {
            estado: {
              in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
            },
            ...(sedeIdFiltro
              ? {
                  OR: [
                    { sedeOrigenId: sedeIdFiltro },
                    { sedeDestinoId: sedeIdFiltro },
                  ],
                }
              : {}),
          }
        : {
            OR: [
              {
                sedeOrigenId: user.sedeId,
                estado: {
                  in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
                },
              },
              {
                sedeDestinoId: user.sedeId,
                estado: {
                  in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
                },
              },
            ],
          },
      orderBy: { id: "desc" },
    });

    const sedeIds = Array.from(
      new Set(
        prestamos.flatMap((prestamo) => [
          prestamo.sedeOrigenId,
          prestamo.sedeDestinoId,
        ])
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

    return NextResponse.json(
      prestamos.map((prestamo) => ({
        ...prestamo,
        sedeOrigenNombre:
          nombresSede.get(prestamo.sedeOrigenId) ||
          `SEDE ${prestamo.sedeOrigenId}`,
        sedeDestinoNombre:
          nombresSede.get(prestamo.sedeDestinoId) ||
          `SEDE ${prestamo.sedeDestinoId}`,
      }))
    );
  } catch (error) {
    console.error("ERROR ALERTAS PRESTAMOS:", error);
    return NextResponse.json(
      { error: "Error cargando alertas" },
      { status: 500 }
    );
  }
}
