import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

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
        sedeDestinoId: true,
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
        { error: "No autorizado para pagar este prestamo" },
        { status: 403 }
      );
    }

    return NextResponse.json(
      {
        error:
          "El pago directo desde prestamos ya no aplica. Si la deuda es entre sedes, usa Solicitar pago. Si la deuda es con proveedor, pagala desde inventario.",
      },
      { status: 400 }
    );
  } catch (error) {
    console.error("ERROR PAGAR PRESTAMO:", error);
    return NextResponse.json(
      { error: "Error interno al procesar el pago del prestamo" },
      { status: 500 }
    );
  }
}
