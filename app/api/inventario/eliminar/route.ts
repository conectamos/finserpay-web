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

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";

    if (!esAdmin) {
      return NextResponse.json(
        { error: "No autorizado" },
        { status: 403 }
      );
    }

    const { id } = await req.json();

    if (!id || Number(id) <= 0) {
      return NextResponse.json(
        { error: "ID inválido" },
        { status: 400 }
      );
    }

    const item = await prisma.inventarioSede.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        imei: true,
        referencia: true,
        color: true,
        costo: true,
        sedeId: true,
        deboA: true,
        estadoFinanciero: true,
        origen: true,
        distribuidor: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "Equipo no encontrado" },
        { status: 404 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.inventarioSede.delete({
        where: { id: item.id },
      });

      await tx.movimientoInventario.create({
        data: {
          imei: item.imei,
          tipoMovimiento: "ELIMINADO",
          referencia: item.referencia,
          color: item.color ?? null,
          costo: item.costo,
          sedeId: item.sedeId,
          deboA: item.deboA ?? null,
          estadoFinanciero: item.estadoFinanciero,
          origen: item.origen,
          observacion: `Eliminado manualmente por ${user.usuario}. Distribuidor: ${item.distribuidor ?? "-"}`,
        },
      });
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("ERROR ELIMINAR INVENTARIO:", error);
    return NextResponse.json(
      { error: "Error eliminando equipo" },
      { status: 500 }
    );
  }
}
