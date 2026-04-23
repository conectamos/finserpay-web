import { NextResponse } from "next/server";
import { requireFinancialAccess } from "@/lib/financial-access";
import prisma from "@/lib/prisma";

const ABONO_CAJA_MARKER = "ABONO_FINANCIERO_ID:";

function normalizarPayload(body: Record<string, unknown>) {
  return {
    entidad: String(body.entidad ?? "").trim(),
    observacion: String(body.observacion ?? "").trim(),
    sedeId: Number(body.sedeId ?? 0),
    tipo: String(body.tipo ?? "").trim().toUpperCase(),
    valor: Number(body.valor ?? 0),
  };
}

function conceptoAbonoCaja(tipo: string) {
  return tipo === "FINANCIERA" ? "ABONO FINANCIERA" : "ABONO TRANSFERENCIA";
}

function descripcionAbonoCaja(abono: {
  id: number;
  tipo: string;
  entidad?: string | null;
  observacion?: string | null;
}) {
  const partes = [`${ABONO_CAJA_MARKER}${abono.id}`];

  if (abono.tipo === "FINANCIERA" && abono.entidad) {
    partes.push(`Entidad: ${abono.entidad}`);
  }

  if (abono.observacion) {
    partes.push(`Obs: ${abono.observacion}`);
  }

  return partes.join(" | ");
}

export async function GET(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    const { user, esAdmin: usuarioEsAdmin } = access;
    const url = new URL(req.url);
    const sedeIdParam = url.searchParams.get("sedeId");

    let where: { sedeId?: number } = {};

    if (usuarioEsAdmin) {
      if (sedeIdParam && Number(sedeIdParam) > 0) {
        where = { sedeId: Number(sedeIdParam) };
      }
    } else {
      where = { sedeId: user.sedeId };
    }

    const items = await prisma.abonoFinanciero.findMany({
      where,
      select: {
        id: true,
        tipo: true,
        entidad: true,
        valor: true,
        observacion: true,
        sedeId: true,
        createdAt: true,
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

    const total = items.reduce((acc, item) => acc + Number(item.valor || 0), 0);

    return NextResponse.json({
      ok: true,
      total,
      items,
    });
  } catch (error) {
    console.error("ERROR LISTANDO ABONOS:", error);
    return NextResponse.json(
      { error: "Error cargando detalle de abonos" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    const { user, esAdmin: usuarioEsAdmin } = access;
    const body = (await req.json()) as Record<string, unknown>;
    const { entidad, observacion, tipo, valor } = normalizarPayload(body);
    const sedeId = usuarioEsAdmin
      ? Number(body.sedeId ?? user.sedeId)
      : Number(user.sedeId);

    if (!["TRANSFERENCIA", "FINANCIERA"].includes(tipo)) {
      return NextResponse.json(
        { error: "Tipo invalido" },
        { status: 400 }
      );
    }

    if (!valor || valor <= 0) {
      return NextResponse.json(
        { error: "El valor debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (tipo === "FINANCIERA" && !entidad) {
      return NextResponse.json(
        { error: "Debes seleccionar una entidad" },
        { status: 400 }
      );
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede invalida" },
        { status: 400 }
      );
    }

    const abono = await prisma.$transaction(async (tx) => {
      const creado = await tx.abonoFinanciero.create({
        data: {
          tipo,
          entidad: tipo === "FINANCIERA" ? entidad : null,
          valor,
          observacion: observacion || null,
          sedeId,
        },
        select: {
          id: true,
          tipo: true,
          entidad: true,
          valor: true,
          observacion: true,
          sedeId: true,
          createdAt: true,
        },
      });

      await tx.cajaMovimiento.create({
        data: {
          tipo: "INGRESO",
          concepto: conceptoAbonoCaja(tipo),
          valor,
          descripcion: descripcionAbonoCaja(creado),
          sedeId,
        },
      });

      return creado;
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Abono registrado correctamente",
      abono,
    });
  } catch (error) {
    console.error("ERROR REGISTRANDO ABONO:", error);
    return NextResponse.json(
      { error: "Error registrando abono" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    if (!access.esAdmin) {
      return NextResponse.json(
        { error: "Solo el administrador puede editar abonos" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const id = Number(body.id ?? 0);
    const { entidad, observacion, sedeId, tipo, valor } = normalizarPayload(body);

    if (!id || id <= 0) {
      return NextResponse.json(
        { error: "ID invalido" },
        { status: 400 }
      );
    }

    if (!["TRANSFERENCIA", "FINANCIERA"].includes(tipo)) {
      return NextResponse.json(
        { error: "Tipo invalido" },
        { status: 400 }
      );
    }

    if (!valor || valor <= 0) {
      return NextResponse.json(
        { error: "El valor debe ser mayor a 0" },
        { status: 400 }
      );
    }

    if (tipo === "FINANCIERA" && !entidad) {
      return NextResponse.json(
        { error: "Debes seleccionar una entidad" },
        { status: 400 }
      );
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede invalida" },
        { status: 400 }
      );
    }

    const existente = await prisma.abonoFinanciero.findUnique({
      where: { id },
      select: {
        id: true,
      },
    });

    if (!existente) {
      return NextResponse.json(
        { error: "Abono no encontrado" },
        { status: 404 }
      );
    }

    const abono = await prisma.$transaction(async (tx) => {
      const actualizado = await tx.abonoFinanciero.update({
        where: { id },
        data: {
          tipo,
          entidad: tipo === "FINANCIERA" ? entidad : null,
          valor,
          observacion: observacion || null,
          sedeId,
        },
        select: {
          id: true,
          tipo: true,
          entidad: true,
          valor: true,
          observacion: true,
          sedeId: true,
          updatedAt: true,
        },
      });

      const movimientoExistente = await tx.cajaMovimiento.findFirst({
        where: {
          descripcion: {
            startsWith: `${ABONO_CAJA_MARKER}${id}`,
          },
        },
        select: {
          id: true,
        },
      });

      if (movimientoExistente) {
        await tx.cajaMovimiento.update({
          where: { id: movimientoExistente.id },
          data: {
            tipo: "INGRESO",
            concepto: conceptoAbonoCaja(tipo),
            valor,
            descripcion: descripcionAbonoCaja(actualizado),
            sedeId,
          },
        });
      } else {
        await tx.cajaMovimiento.create({
          data: {
            tipo: "INGRESO",
            concepto: conceptoAbonoCaja(tipo),
            valor,
            descripcion: descripcionAbonoCaja(actualizado),
            sedeId,
          },
        });
      }

      return actualizado;
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Abono actualizado correctamente",
      abono,
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO ABONO:", error);
    return NextResponse.json(
      { error: "Error actualizando abono" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    if (!access.esAdmin) {
      return NextResponse.json(
        { error: "Solo el administrador puede eliminar abonos" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const id = Number(body.id ?? 0);

    if (!id || id <= 0) {
      return NextResponse.json(
        { error: "ID invalido" },
        { status: 400 }
      );
    }

    const existente = await prisma.abonoFinanciero.findUnique({
      where: { id },
      select: {
        id: true,
      },
    });

    if (!existente) {
      return NextResponse.json(
        { error: "Abono no encontrado" },
        { status: 404 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.abonoFinanciero.delete({
        where: { id },
      });

      await tx.cajaMovimiento.deleteMany({
        where: {
          descripcion: {
            startsWith: `${ABONO_CAJA_MARKER}${id}`,
          },
        },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Abono eliminado correctamente",
    });
  } catch (error) {
    console.error("ERROR ELIMINANDO ABONO:", error);
    return NextResponse.json(
      { error: "Error eliminando abono" },
      { status: 500 }
    );
  }
}
