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

    const body = await req.json();

    const tipo = String(body.tipo ?? "").trim().toUpperCase();
    const concepto = String(body.concepto ?? "").trim();
    const valor = Number(body.valor ?? 0);
    const descripcion = String(body.descripcion ?? "").trim();

    const esAdmin = user.rolNombre?.toUpperCase() === "ADMIN";
    const sedeId = esAdmin
      ? Number(body.sedeId ?? user.sedeId)
      : Number(user.sedeId);

    if (!["INGRESO", "EGRESO"].includes(tipo)) {
      return NextResponse.json(
        { error: "Tipo inválido. Debe ser INGRESO o EGRESO" },
        { status: 400 }
      );
    }

    if (!concepto) {
      return NextResponse.json(
        { error: "El concepto es obligatorio" },
        { status: 400 }
      );
    }

    if (!valor || valor <= 0) {
      return NextResponse.json(
        { error: "El valor debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede inválida" },
        { status: 400 }
      );
    }

    const movimiento = await prisma.cajaMovimiento.create({
      data: {
        tipo,
        concepto,
        valor,
        descripcion: descripcion || null,
        sedeId,
      },
      select: {
        id: true,
        tipo: true,
        concepto: true,
        valor: true,
        descripcion: true,
        sedeId: true,
        createdAt: true,
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: `${tipo} registrado correctamente`,
      movimiento,
    });
  } catch (error) {
    console.error("ERROR REGISTRAR CAJA:", error);
    return NextResponse.json(
      { error: "Error interno al registrar movimiento de caja" },
      { status: 500 }
    );
  }
}