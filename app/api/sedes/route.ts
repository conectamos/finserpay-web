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

    const sedes = await prisma.sede.findMany({
      select: {
        id: true,
        nombre: true,
      },
      orderBy: {
        id: "asc",
      },
    });

    return NextResponse.json(sedes);
  } catch (error) {
    console.error("ERROR LISTANDO SEDES:", error);
    return NextResponse.json(
      { error: "Error cargando sedes" },
      { status: 500 }
    );
  }
}