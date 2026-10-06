import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }
    if (!isAdminRole(user.rolNombre)) {
      return NextResponse.json({ error: "Acceso no autorizado" }, { status: 403 });
    }

    const { imei } = await req.json();

    if (!imei) {
      return NextResponse.json({ error: "IMEI requerido" }, { status: 400 });
    }

    const item = await prisma.inventarioSede.findFirst({
      where: {
        imei: String(imei).trim(),
      },
      select: {
        referencia: true,
        color: true,
        costo: true,
      },
    });

    if (!item) {
      return NextResponse.json(
        { error: "No se encontró el IMEI en inventario" },
        { status: 404 }
      );
    }

    return NextResponse.json(item);
  } catch {
    return NextResponse.json(
      { error: "Error consultando IMEI" },
      { status: 500 }
    );
  }
}
