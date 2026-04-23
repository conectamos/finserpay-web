import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { esDeudaEntreSedes, esEstadoDeuda } from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json();
    const id = Number(body.id);

    if (!id) {
      return NextResponse.json({ error: "ID invalido" }, { status: 400 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    const item = await prisma.inventarioSede.findUnique({
      where: { id },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeId: true,
        estadoActual: true,
        estadoFinanciero: true,
        deboA: true,
        origen: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Equipo no encontrado" },
        { status: 404 }
      );
    }

    if (!esAdmin && item.sedeId !== user.sedeId) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    if (!esEstadoDeuda(item.estadoFinanciero)) {
      return NextResponse.json(
        { error: "Este equipo no tiene deuda activa" },
        { status: 400 }
      );
    }

    const estadoActual = String(item.estadoActual || "").toUpperCase();

    if (estadoActual !== "BODEGA" && estadoActual !== "VENDIDO") {
      return NextResponse.json(
        {
          error:
            "Solo se puede pagar deuda del equipo que esta en BODEGA o VENDIDO en la sede actual.",
        },
        { status: 400 }
      );
    }

    if (esDeudaEntreSedes(item.deboA)) {
      return NextResponse.json(
        {
          error:
            "La deuda entre sedes debe solicitarse y aprobarse desde el modulo de prestamos.",
        },
        { status: 400 }
      );
    }

    const prestamosActivos = await prisma.prestamoSede.findMany({
      where: {
        imei: item.imei,
        estado: {
          in: ["APROBADO", "PAGO_PENDIENTE_APROBACION"],
        },
      },
      select: {
        id: true,
        sedeOrigenId: true,
        sedeDestinoId: true,
      },
    });

    const prestamosConPlaceholder = prestamosActivos.filter(
      (prestamo) => prestamo.sedeOrigenId !== item.sedeId
    );

    await prisma.$transaction(async (tx) => {
      await tx.cajaMovimiento.create({
        data: {
          tipo: "EGRESO",
          concepto: "PAGO DEUDA INVENTARIO",
          valor: item.costo,
          descripcion: `Pago de deuda del equipo IMEI ${item.imei}${item.deboA ? ` a ${item.deboA}` : ""}`,
          sedeId: item.sedeId,
        },
      });

      await tx.inventarioSede.update({
        where: { id: item.id },
        data: {
          estadoFinanciero: "PAGO",
          deboA: null,
          estadoAnterior: item.estadoActual || null,
          estadoActual: "BODEGA",
          fechaMovimiento: new Date(),
          observacion: "Deuda pagada al proveedor. Equipo queda en PAGO.",
        },
      });

      if (prestamosActivos.length > 0) {
        await tx.prestamoSede.updateMany({
          where: {
            id: {
              in: prestamosActivos.map((prestamo) => prestamo.id),
            },
          },
          data: {
            estado: "PAGADO",
            fechaAprobacionPago: new Date(),
          },
        });

        for (const prestamo of prestamosConPlaceholder) {
          await tx.inventarioSede.deleteMany({
            where: {
              imei: item.imei,
              sedeId: prestamo.sedeOrigenId,
              estadoActual: "PRESTAMO",
            },
          });

          await tx.movimientoCajaSede.updateMany({
            where: {
              prestamoId: prestamo.id,
              tipo: "PENDIENTE_APROBACION",
            },
            data: {
              tipo: "ANULADO",
            },
          });
        }

        await tx.inventarioPrincipal.updateMany({
          where: {
            imei: item.imei,
            estado: "PRESTAMO",
          },
          data: {
            estado: "PAGO",
            estadoCobro: "PAGADO",
          },
        });
      }

      await tx.movimientoInventario.create({
        data: {
          imei: item.imei,
          tipoMovimiento: "PAGO_DEUDA_INVENTARIO",
          referencia: item.referencia,
          color: item.color || null,
          costo: item.costo,
          sedeId: item.sedeId,
          deboA: null,
          estadoFinanciero: "PAGO",
          origen: item.origen || "INVENTARIO",
          observacion:
            prestamosActivos.length > 0
              ? "Se pago la deuda del proveedor y se cerraron los prestamos activos del equipo."
              : "Se pago la deuda del equipo.",
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Deuda pagada correctamente",
    });
  } catch (error) {
    console.error("ERROR PAGAR DEUDA INVENTARIO:", error);
    return NextResponse.json(
      { error: "Error interno pagando deuda" },
      { status: 500 }
    );
  }
}
