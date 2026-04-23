import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

const ESTADOS_VALIDOS = ["BODEGA", "PENDIENTE", "GARANTIA"];

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const body = await req.json();
    const id = Number(body.id);
    const estadoActual = String(body.estadoActual || "").trim().toUpperCase();

    if (!id) {
      return NextResponse.json(
        { error: "ID inválido" },
        { status: 400 }
      );
    }

    if (!ESTADOS_VALIDOS.includes(estadoActual)) {
      return NextResponse.json(
        { error: "Estado no permitido" },
        { status: 400 }
      );
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
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 403 }
      );
    }

    const estadoAnterior = String(item.estadoActual || "").toUpperCase();

    // Solo permitir:
    // BODEGA -> GARANTIA / PENDIENTE
    // GARANTIA / PENDIENTE -> BODEGA
    const permitido =
      (estadoAnterior === "BODEGA" &&
        (estadoActual === "GARANTIA" || estadoActual === "PENDIENTE")) ||
      ((estadoAnterior === "GARANTIA" || estadoAnterior === "PENDIENTE") &&
        estadoActual === "BODEGA");

    if (!permitido) {
      return NextResponse.json(
        { error: `No se permite cambiar de ${estadoAnterior} a ${estadoActual}` },
        { status: 400 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventarioSede.update({
        where: { id: item.id },
        data: {
          estadoAnterior: item.estadoActual || null,
          estadoActual,
          fechaMovimiento: new Date(),
          observacion: `Cambio manual de estado: ${estadoAnterior} → ${estadoActual}`,
        },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: item.imei,
          tipoMovimiento: "CAMBIO_ESTADO_INVENTARIO",
          referencia: item.referencia,
          color: item.color || null,
          costo: item.costo,
          sedeId: item.sedeId,
          estadoFinanciero: item.estadoFinanciero || null,
          origen: item.origen || "INVENTARIO",
          observacion: `Cambio manual de estado: ${estadoAnterior} → ${estadoActual}`,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Estado actualizado correctamente",
    });
  } catch (error) {
    console.error("ERROR CAMBIAR ESTADO INVENTARIO:", error);
    return NextResponse.json(
      { error: "Error interno cambiando estado" },
      { status: 500 }
    );
  }
}