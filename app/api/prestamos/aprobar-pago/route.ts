import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { esDeudaEntreSedes } from "@/lib/prestamos";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const body = await req.json();
    const prestamoId = Number(body.prestamoId ?? body.id);

    if (!prestamoId) {
      return NextResponse.json(
        { error: "ID de prestamo invalido" },
        { status: 400 }
      );
    }

    const prestamo = await prisma.prestamoSede.findUnique({
      where: { id: prestamoId },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeOrigenId: true,
        sedeDestinoId: true,
        estado: true,
        montoPago: true,
      },
    });

    if (!prestamo) {
      return NextResponse.json(
        { error: "Prestamo no encontrado" },
        { status: 404 }
      );
    }

    if (!esAdmin && user.sedeId !== prestamo.sedeOrigenId) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    if (prestamo.estado !== "PAGO_PENDIENTE_APROBACION") {
      return NextResponse.json(
        { error: "Este prestamo no esta pendiente de aprobacion" },
        { status: 400 }
      );
    }

    const montoEsperado = Number(prestamo.costo || 0);
    const montoSolicitado = Number(prestamo.montoPago || 0);

    if (!montoSolicitado || montoSolicitado <= 0) {
      return NextResponse.json(
        { error: "El prestamo no tiene un monto de pago valido" },
        { status: 400 }
      );
    }

    if (montoSolicitado !== montoEsperado) {
      return NextResponse.json(
        {
          error: `El monto de pago debe ser exacto. Valor esperado: ${montoEsperado}`,
        },
        { status: 400 }
      );
    }

    const equipoDestino = await prisma.inventarioSede.findFirst({
      where: {
        imei: prestamo.imei,
        sedeId: prestamo.sedeDestinoId,
      },
      select: {
        id: true,
        estadoFinanciero: true,
        deboA: true,
      },
    });

    const equipoOrigen = await prisma.inventarioSede.findFirst({
      where: {
        imei: prestamo.imei,
        sedeId: prestamo.sedeOrigenId,
        estadoActual: "PRESTAMO",
      },
      select: {
        id: true,
      },
    });

    if (!equipoDestino || !equipoOrigen) {
      return NextResponse.json(
        { error: "No se encontraron los registros del prestamo" },
        { status: 404 }
      );
    }

    if (!esDeudaEntreSedes(equipoDestino.deboA)) {
      return NextResponse.json(
        {
          error:
            "Este equipo no tiene una deuda entre sedes pendiente de aprobacion.",
        },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.prestamoSede.update({
        where: { id: prestamo.id },
        data: {
          estado: "PAGADO",
          fechaAprobacionPago: new Date(),
        },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "INGRESO",
          concepto: "PAGO PRESTAMO ENTRE SEDES",
          valor: montoSolicitado,
          descripcion: `Ingreso por aprobacion de pago prestamo IMEI ${prestamo.imei} desde sede ${prestamo.sedeDestinoId}`,
          sedeId: prestamo.sedeOrigenId,
        },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "EGRESO",
          concepto: "PAGO PRESTAMO ENTRE SEDES",
          valor: montoSolicitado,
          descripcion: `Egreso por pago aprobado de prestamo IMEI ${prestamo.imei} hacia sede ${prestamo.sedeOrigenId}`,
          sedeId: prestamo.sedeDestinoId,
        },
      });

      const movimientoPendiente = await tx.movimientoCajaSede.findFirst({
        where: {
          prestamoId: prestamo.id,
        },
        select: {
          id: true,
        },
      });

      if (movimientoPendiente) {
        await tx.movimientoCajaSede.update({
          where: { id: movimientoPendiente.id },
          data: {
            tipo: "INGRESO",
            concepto: "PAGO PRESTAMO ENTRE SEDES",
            valor: montoSolicitado,
            sedeId: prestamo.sedeOrigenId,
          },
        });
      } else {
        await tx.movimientoCajaSede.create({
          data: {
            sedeId: prestamo.sedeOrigenId,
            tipo: "INGRESO",
            concepto: "PAGO PRESTAMO ENTRE SEDES",
            valor: montoSolicitado,
            prestamoId: prestamo.id,
          },
        });
      }

      await tx.movimientoCajaSede.create({
        data: {
          sedeId: prestamo.sedeDestinoId,
          tipo: "EGRESO",
          concepto: "PAGO PRESTAMO ENTRE SEDES",
          valor: montoSolicitado,
          prestamoId: prestamo.id,
        },
      });

      await tx.inventarioSede.update({
        where: { id: equipoDestino.id },
        data: {
          estadoFinanciero: "PAGO",
          deboA: null,
          fechaMovimiento: new Date(),
          observacion: `Pago aprobado a SEDE ${prestamo.sedeOrigenId}`,
        },
      });

      await tx.inventarioSede.delete({
        where: { id: equipoOrigen.id },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento: "PAGO_PRESTAMO_APROBADO",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: prestamo.costo,
          sedeId: prestamo.sedeDestinoId,
          deboA: null,
          estadoFinanciero: "PAGO",
          origen: "PRESTAMO_SEDE",
          observacion: `Pago total aprobado del prestamo. Sede origen: ${prestamo.sedeOrigenId}. Sede destino: ${prestamo.sedeDestinoId}.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Pago aprobado correctamente",
    });
  } catch (error) {
    console.error("ERROR APROBAR PAGO PRESTAMO:", error);
    return NextResponse.json(
      { error: "Error interno al aprobar pago" },
      { status: 500 }
    );
  }
}
