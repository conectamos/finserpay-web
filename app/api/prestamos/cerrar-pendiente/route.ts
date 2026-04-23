import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

type AccionCierre = "RECHAZADO" | "CANCELADO";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json();
    const id = Number(body.id);
    const accion = String(body.accion || "").toUpperCase() as AccionCierre;

    if (!id || (accion !== "RECHAZADO" && accion !== "CANCELADO")) {
      return NextResponse.json({ error: "Datos invalidos" }, { status: 400 });
    }

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

    if (String(prestamo.estado || "").toUpperCase() !== "PENDIENTE") {
      return NextResponse.json(
        { error: "Solo se pueden cerrar prestamos pendientes" },
        { status: 400 }
      );
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const esOrigen = Number(user.sedeId) === Number(prestamo.sedeOrigenId);
    const esDestino = Number(user.sedeId) === Number(prestamo.sedeDestinoId);

    if (accion === "RECHAZADO" && !esAdmin && !esDestino) {
      return NextResponse.json(
        { error: "Solo la sede destino o el admin pueden rechazar la solicitud" },
        { status: 403 }
      );
    }

    if (accion === "CANCELADO" && !esAdmin && !esOrigen) {
      return NextResponse.json(
        { error: "Solo la sede origen o el admin pueden cancelar la solicitud" },
        { status: 403 }
      );
    }

    const itemOrigen = await prisma.inventarioSede.findFirst({
      where: {
        imei: prestamo.imei,
        sedeId: prestamo.sedeOrigenId,
      },
      select: {
        id: true,
        estadoActual: true,
        estadoAnterior: true,
        estadoFinanciero: true,
        deboA: true,
      },
    });

    await prisma.$transaction(async (tx) => {
      await tx.prestamoSede.update({
        where: { id: prestamo.id },
        data: {
          estado: accion,
        },
      });

      if (itemOrigen && String(itemOrigen.estadoActual || "").toUpperCase() === "PRESTAMO") {
        await tx.inventarioSede.update({
          where: { id: itemOrigen.id },
          data: {
            estadoAnterior: "PRESTAMO",
            estadoActual: itemOrigen.estadoAnterior || "BODEGA",
            fechaMovimiento: new Date(),
            observacion:
              accion === "RECHAZADO"
                ? `Solicitud rechazada por la sede destino ${prestamo.sedeDestinoId}.`
                : `Solicitud cancelada antes de aprobacion hacia la sede ${prestamo.sedeDestinoId}.`,
          },
        });
      }

      await tx.movimientoInventario.create({
        data: {
          imei: prestamo.imei,
          tipoMovimiento:
            accion === "RECHAZADO" ? "PRESTAMO_RECHAZADO" : "PRESTAMO_CANCELADO",
          referencia: prestamo.referencia,
          color: prestamo.color || null,
          costo: Number(prestamo.costo),
          sedeId: prestamo.sedeOrigenId,
          deboA: itemOrigen?.deboA ?? null,
          estadoFinanciero: itemOrigen?.estadoFinanciero ?? null,
          origen: "PRESTAMO",
          observacion:
            accion === "RECHAZADO"
              ? `La sede ${prestamo.sedeDestinoId} rechazo la solicitud pendiente.`
              : `La sede ${prestamo.sedeOrigenId} cancelo la solicitud pendiente antes de aprobacion.`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje:
        accion === "RECHAZADO"
          ? "Solicitud rechazada correctamente"
          : "Solicitud cancelada correctamente",
    });
  } catch (error) {
    console.error("ERROR CERRAR PRESTAMO PENDIENTE:", error);
    return NextResponse.json(
      { error: "Error cerrando la solicitud pendiente" },
      { status: 500 }
    );
  }
}
