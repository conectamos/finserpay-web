import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  esDeudaEntreSedes,
  esEstadoDeuda,
  SEDE_BODEGA_ID,
} from "@/lib/prestamos";

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

    const where = esAdmin
      ? sedeIdFiltro
        ? {
            OR: [{ sedeOrigenId: sedeIdFiltro }, { sedeDestinoId: sedeIdFiltro }],
          }
        : {}
      : {
          OR: [{ sedeOrigenId: user.sedeId }, { sedeDestinoId: user.sedeId }],
        };

    const prestamosCrudos = await prisma.prestamoSede.findMany({
      where,
      orderBy: { id: "desc" },
    });

    const prestamos = prestamosCrudos.filter((prestamo) => {
      if (prestamo.sedeOrigenId !== SEDE_BODEGA_ID) {
        return true;
      }

      const estadoPrestamo = String(prestamo.estado || "").toUpperCase();
      const esActivo =
        estadoPrestamo === "APROBADO" ||
        estadoPrestamo === "PAGO_PENDIENTE_APROBACION";

      if (!esActivo) {
        return true;
      }

      const existePrestamoIntermedioActivo = prestamosCrudos.some((otro) => {
        if (otro.id === prestamo.id) {
          return false;
        }

        const estadoOtro = String(otro.estado || "").toUpperCase();
        const otroActivo =
          estadoOtro === "APROBADO" ||
          estadoOtro === "PAGO_PENDIENTE_APROBACION";

        return (
          otroActivo &&
          otro.imei === prestamo.imei &&
          otro.sedeDestinoId === prestamo.sedeDestinoId &&
          otro.sedeOrigenId !== SEDE_BODEGA_ID
        );
      });

      return !existePrestamoIntermedioActivo;
    });

    const equiposDestino = prestamos
      .filter((prestamo) => prestamo.estado !== "DEVUELTO")
      .map((prestamo) => ({
        imei: prestamo.imei,
        sedeId: prestamo.sedeDestinoId,
      }));

    const inventarioDestino =
      equiposDestino.length > 0
        ? await prisma.inventarioSede.findMany({
            where: {
              OR: equiposDestino,
            },
            select: {
              imei: true,
              sedeId: true,
              deboA: true,
              estadoFinanciero: true,
              estadoActual: true,
            },
          })
        : [];

    const inventarioPorDestino = new Map(
      inventarioDestino.map((item) => [
        `${item.imei}:${item.sedeId}`,
        item,
      ])
    );

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

    const resultado = prestamos.map((prestamo) => {
      const equipoDestino = inventarioPorDestino.get(
        `${prestamo.imei}:${prestamo.sedeDestinoId}`
      );

      const deudaActiva = esEstadoDeuda(equipoDestino?.estadoFinanciero);
      const requiereAprobacionEntreSedes =
        deudaActiva && esDeudaEntreSedes(equipoDestino?.deboA);

      return {
        ...prestamo,
        sedeOrigenNombre:
          nombresSede.get(prestamo.sedeOrigenId) ||
          `SEDE ${prestamo.sedeOrigenId}`,
        sedeDestinoNombre:
          nombresSede.get(prestamo.sedeDestinoId) ||
          `SEDE ${prestamo.sedeDestinoId}`,
        deboAActual: equipoDestino?.deboA ?? null,
        estadoFinancieroActual: equipoDestino?.estadoFinanciero ?? null,
        estadoActualActual: equipoDestino?.estadoActual ?? null,
        requiereAprobacionEntreSedes,
      };
    });

    return NextResponse.json(resultado);
  } catch (error) {
    console.error("ERROR GET PRESTAMOS:", error);
    return NextResponse.json(
      { error: "Error cargando prestamos" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const data = await req.json();

    const imei = String(data.imei ?? "").replace(/\D/g, "").slice(0, 15);
    const referencia = String(data.referencia ?? "").trim();
    const color = String(data.color ?? "").trim();
    const costo = Number(data.costo ?? 0);
    const sedeOrigenId = Number(data.sedeOrigenId);
    const sedeDestinoId = Number(data.sedeDestinoId);

    if (!imei) {
      return NextResponse.json(
        { error: "El IMEI es obligatorio" },
        { status: 400 }
      );
    }

    if (!referencia) {
      return NextResponse.json(
        { error: "La referencia es obligatoria" },
        { status: 400 }
      );
    }

    if (!costo || costo <= 0) {
      return NextResponse.json(
        { error: "El costo debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (!sedeOrigenId || !sedeDestinoId) {
      return NextResponse.json(
        { error: "Debes seleccionar las sedes" },
        { status: 400 }
      );
    }

    if (sedeOrigenId === sedeDestinoId) {
      return NextResponse.json(
        { error: "La sede origen no puede ser igual a la sede destino" },
        { status: 400 }
      );
    }

    const existe = await prisma.prestamoSede.findFirst({
      where: {
        imei,
        sedeOrigenId,
        estado: {
          in: ["PENDIENTE", "APROBADO", "PAGO_PENDIENTE_APROBACION"],
        },
      },
      select: { id: true },
    });

    if (existe) {
      return NextResponse.json(
        { error: "Ese IMEI ya tiene un prestamo activo desde la misma sede" },
        { status: 400 }
      );
    }

    const nuevo = await prisma.prestamoSede.create({
      data: {
        imei,
        referencia,
        color: color || null,
        costo,
        sedeOrigenId,
        sedeDestinoId,
        estado: "PENDIENTE",
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Solicitud de prestamo creada correctamente",
      prestamo: nuevo,
    });
  } catch (error) {
    console.error("ERROR POST PRESTAMOS:", error);
    return NextResponse.json(
      { error: "Error al guardar prestamo" },
      { status: 500 }
    );
  }
}
