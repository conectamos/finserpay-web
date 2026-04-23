import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 403 }
      );
    }

    const body = await req.json();
    const id = Number(body.id);

    if (!id) {
      return NextResponse.json(
        { error: "ID inválido" },
        { status: 400 }
      );
    }

    const item = await prisma.inventarioPrincipal.findUnique({
      where: { id },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Equipo no encontrado" },
        { status: 404 }
      );
    }

    await prisma.inventarioPrincipal.delete({
      where: { id },
    });

    await prisma.movimientoInventario.create({
      data: {
        imei: item.imei,
        tipoMovimiento: "ELIMINACION_PRINCIPAL",
        referencia: item.referencia,
        color: item.color || null,
        costo: item.costo,
        sedeId: null,
        origen: "PRINCIPAL",
        observacion: "Equipo eliminado de bodega principal por administrador",
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Equipo eliminado correctamente de bodega principal",
    });
  } catch (error) {
    console.error("ERROR ELIMINAR INVENTARIO PRINCIPAL:", error);
    return NextResponse.json(
      { error: "Error eliminando equipo" },
      { status: 500 }
    );
  }
}