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
      return NextResponse.json(
        { error: "ID de prestamo invalido" },
        { status: 400 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    const prestamo = await prisma.prestamoSede.findUnique({
      where: { id },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeOrigenId: true,
        sedeDestinoId: true,
        estado: true,
      },
    });

    if (!prestamo) {
      return NextResponse.json(
        { error: "Prestamo no encontrado" },
        { status: 404 }
      );
    }

    if (!esAdmin && user.sedeId !== prestamo.sedeDestinoId) {
      return NextResponse.json(
        { error: "Solo la sede destino puede solicitar el pago" },
        { status: 403 }
      );
    }

    if (prestamo.estado !== "APROBADO") {
      return NextResponse.json(
        { error: `No se puede solicitar pago. Estado actual: ${prestamo.estado}` },
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

    if (!equipoDestino) {
      return NextResponse.json(
        { error: "El equipo no existe en la sede destino" },
        { status: 404 }
      );
    }

    if (!esEstadoDeuda(equipoDestino.estadoFinanciero)) {
      return NextResponse.json(
        {
          error: `El equipo no esta en DEUDA. Estado financiero actual: ${equipoDestino.estadoFinanciero}`,
        },
        { status: 400 }
      );
    }

    if (!esDeudaEntreSedes(equipoDestino.deboA)) {
      return NextResponse.json(
        {
          error:
            "Este equipo no debe pagarse entre sedes. El pago al proveedor se hace desde inventario.",
        },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.prestamoSede.update({
        where: { id: prestamo.id },
        data: {
          estado: "PAGO_PENDIENTE_APROBACION",
          montoPago: prestamo.costo,
          fechaSolicitudPago: new Date(),
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
            sedeId: prestamo.sedeOrigenId,
            tipo: "PENDIENTE_APROBACION",
            concepto: "PAGO PRESTAMO ENTRE SEDES",
            valor: prestamo.costo,
          },
        });
      } else {
        await tx.movimientoCajaSede.create({
          data: {
            sedeId: prestamo.sedeOrigenId,
            tipo: "PENDIENTE_APROBACION",
            concepto: "PAGO PRESTAMO ENTRE SEDES",
            valor: prestamo.costo,
            prestamoId: prestamo.id,
          },
        });
      }

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento: "PRESTAMO_SOLICITA_PAGO",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: prestamo.costo,
          sedeId: prestamo.sedeDestinoId,
          deboA: equipoDestino.deboA,
          estadoFinanciero: "DEUDA",
          origen: "PRESTAMO",
          observacion: `SEDE ${prestamo.sedeDestinoId} solicita pagar a SEDE ${prestamo.sedeOrigenId}. Prestamo #${prestamo.id}.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Solicitud de pago enviada correctamente",
      valorSolicitado: prestamo.costo,
    });
  } catch (error) {
    console.error("ERROR SOLICITAR PAGO PRESTAMO:", error);
    return NextResponse.json(
      { error: "Error interno al solicitar pago" },
      { status: 500 }
    );
  }
}
