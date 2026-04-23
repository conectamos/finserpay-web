import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

export async function GET() {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";

    const inventario = await prisma.inventarioSede.findMany({
      where: esAdmin ? {} : { sedeId: user.sedeId },
     select: {
  id: true,
  imei: true,
  referencia: true,
  color: true,
  costo: true,
  sedeId: true,
  distribuidor: true,
  deboA: true,
  estadoFinanciero: true,
  estadoActual: true,
  origen: true,
  sede: {
    select: {
      nombre: true,
    },
  },
},
      orderBy: {
        id: "desc",
      },
    });

    return NextResponse.json(inventario);
  } catch (error) {
    console.error("ERROR LISTADO INVENTARIO:", error);
    return NextResponse.json(
      { error: "Error cargando inventario" },
      { status: 500 }
    );
  }
}