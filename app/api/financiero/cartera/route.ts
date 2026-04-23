import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { requireFinancialAccess } from "@/lib/financial-access";
import prisma from "@/lib/prisma";

const CONCEPTO_GASTO_CARTERA = "GASTO CARTERA";
const VENTANA_BUSQUEDA_MS = 1000 * 60 * 10;

type GastoBase = {
  createdAt: Date;
  id: number;
  observacion: string | null;
  sedeId: number;
  valor: number;
};

type MovimientoLookupTx = Pick<typeof prisma, "cajaMovimiento">;

function normalizarNumero(valor: unknown) {
  return Number(valor || 0);
}

async function buscarMovimientoCajaRelacionado(
  tx: MovimientoLookupTx,
  gasto: GastoBase
) {
  const marcador = `${CONCEPTO_GASTO_CARTERA} #${gasto.id}`;

  const movimientoMarcado = await tx.cajaMovimiento.findFirst({
    where: {
      concepto: CONCEPTO_GASTO_CARTERA,
      descripcion: {
        startsWith: marcador,
      },
    },
    select: {
      id: true,
      descripcion: true,
      createdAt: true,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (movimientoMarcado) {
    return movimientoMarcado;
  }

  const ventanaInicio = new Date(gasto.createdAt.getTime() - VENTANA_BUSQUEDA_MS);
  const ventanaFin = new Date(gasto.createdAt.getTime() + VENTANA_BUSQUEDA_MS);

  const descripcionEsperada = String(gasto.observacion || "").trim();

  const ordenarPorAfinidad = (
    a: { createdAt: Date; descripcion: string | null },
    b: { createdAt: Date; descripcion: string | null }
  ) => {
    const diffTiempoA = Math.abs(a.createdAt.getTime() - gasto.createdAt.getTime());
    const diffTiempoB = Math.abs(b.createdAt.getTime() - gasto.createdAt.getTime());

    const descripcionA = String(a.descripcion || "").trim();
    const descripcionB = String(b.descripcion || "").trim();

    const scoreA = diffTiempoA + (descripcionA === descripcionEsperada ? -1000000 : 0);
    const scoreB = diffTiempoB + (descripcionB === descripcionEsperada ? -1000000 : 0);

    return scoreA - scoreB;
  };

  const candidatos = await tx.cajaMovimiento.findMany({
    where: {
      tipo: "EGRESO",
      concepto: CONCEPTO_GASTO_CARTERA,
      sedeId: gasto.sedeId,
      valor: gasto.valor,
      createdAt: {
        gte: ventanaInicio,
        lte: ventanaFin,
      },
    },
    select: {
      id: true,
      descripcion: true,
      createdAt: true,
    },
    orderBy: {
      id: "desc",
    },
    take: 25,
  });

  if (candidatos.length > 0) {
    return candidatos.sort(ordenarPorAfinidad)[0];
  }

  const candidatosAmplios = await tx.cajaMovimiento.findMany({
    where: {
      tipo: "EGRESO",
      concepto: CONCEPTO_GASTO_CARTERA,
      sedeId: gasto.sedeId,
      valor: gasto.valor,
    },
    select: {
      id: true,
      descripcion: true,
      createdAt: true,
    },
    orderBy: {
      id: "desc",
    },
    take: 50,
  });

  if (candidatosAmplios.length === 0) {
    return null;
  }

  return candidatosAmplios.sort(ordenarPorAfinidad)[0];
}

export async function GET(req: Request) {
  try {
    const access = await requireFinancialAccess();

    if (!access.ok) {
      return access.response;
    }

    const { user, esAdmin } = access;

    const url = new URL(req.url);
    const sedeIdParam = url.searchParams.get("sedeId");

    let where: { sedeId?: number } = {};

    if (esAdmin) {
      if (sedeIdParam && Number(sedeIdParam) > 0) {
        where = { sedeId: Number(sedeIdParam) };
      }
    } else {
      where = { sedeId: user.sedeId };
    }

    const gastos = await prisma.gastoCartera.findMany({
      where,
      select: {
        id: true,
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

    const totalGastosCartera = gastos.reduce(
      (acc, item) => acc + normalizarNumero(item.valor),
      0
    );

    return NextResponse.json({
      ok: true,
      total: totalGastosCartera,
      items: gastos,
    });
  } catch (error) {
    console.error("ERROR LISTANDO GASTOS DE CARTERA:", error);
    return NextResponse.json(
      { error: "Error cargando gastos de cartera" },
      { status: 500 }
    );
  }
}

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
    const body = (await req.json()) as Record<string, unknown>;

    const valor = normalizarNumero(body.valor);
    const observacion = String(body.observacion || "").trim();
    const sedeIdBody = normalizarNumero(body.sedeId);

    let sedeId = user.sedeId;

    if (esAdmin && sedeIdBody > 0) {
      sedeId = sedeIdBody;
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede invalida" },
        { status: 400 }
      );
    }

    if (!valor || valor <= 0) {
      return NextResponse.json(
        { error: "El valor debe ser mayor a 0" },
        { status: 400 }
      );
    }

    const sedeExiste = await prisma.sede.findUnique({
      where: { id: sedeId },
      select: { id: true },
    });

    if (!sedeExiste) {
      return NextResponse.json(
        { error: "La sede no existe" },
        { status: 404 }
      );
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const gasto = await tx.gastoCartera.create({
        data: {
          valor,
          observacion: observacion || null,
          sedeId,
        },
        select: {
          id: true,
          valor: true,
          observacion: true,
          sedeId: true,
          createdAt: true,
        },
      });

      return gasto;
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Gasto de cartera registrado correctamente",
      item: resultado,
    });
  } catch (error) {
    console.error("ERROR REGISTRANDO GASTO DE CARTERA:", error);
    return NextResponse.json(
      { error: "Error registrando gasto de cartera" },
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
        { error: "Solo el administrador puede editar cartera" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const id = normalizarNumero(body.id);
    const valor = normalizarNumero(body.valor);
    const observacion = String(body.observacion || "").trim();
    const sedeId = normalizarNumero(body.sedeId);

    if (!id || id <= 0) {
      return NextResponse.json(
        { error: "ID invalido" },
        { status: 400 }
      );
    }

    if (!sedeId || sedeId <= 0) {
      return NextResponse.json(
        { error: "Sede invalida" },
        { status: 400 }
      );
    }

    if (!valor || valor <= 0) {
      return NextResponse.json(
        { error: "El valor debe ser mayor a 0" },
        { status: 400 }
      );
    }

    const sedeExiste = await prisma.sede.findUnique({
      where: { id: sedeId },
      select: { id: true },
    });

    if (!sedeExiste) {
      return NextResponse.json(
        { error: "La sede no existe" },
        { status: 404 }
      );
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const gastoExistente = await tx.gastoCartera.findUnique({
        where: { id },
        select: {
          id: true,
          valor: true,
          observacion: true,
          sedeId: true,
          createdAt: true,
        },
      });

      if (!gastoExistente) {
        return null;
      }

      const movimientoRelacionado = await buscarMovimientoCajaRelacionado(
        tx,
        gastoExistente
      );

      const gastoActualizado = await tx.gastoCartera.update({
        where: { id },
        data: {
          valor,
          observacion: observacion || null,
          sedeId,
        },
        select: {
          id: true,
          valor: true,
          observacion: true,
          sedeId: true,
          updatedAt: true,
        },
      });

      if (movimientoRelacionado) {
        await tx.cajaMovimiento.delete({
          where: { id: movimientoRelacionado.id },
        });
      }

      return gastoActualizado;
    });

    if (!resultado) {
      return NextResponse.json(
        { error: "Gasto de cartera no encontrado" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      mensaje: "Gasto de cartera actualizado correctamente",
      item: resultado,
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO GASTO DE CARTERA:", error);
    return NextResponse.json(
      { error: "Error actualizando gasto de cartera" },
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
        { error: "Solo el administrador puede eliminar cartera" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const id = normalizarNumero(body.id);

    if (!id || id <= 0) {
      return NextResponse.json(
        { error: "ID invalido" },
        { status: 400 }
      );
    }

    const eliminado = await prisma.$transaction(async (tx) => {
      const gastoExistente = await tx.gastoCartera.findUnique({
        where: { id },
        select: {
          id: true,
          valor: true,
          observacion: true,
          sedeId: true,
          createdAt: true,
        },
      });

      if (!gastoExistente) {
        return false;
      }

      const movimientoRelacionado = await buscarMovimientoCajaRelacionado(
        tx,
        gastoExistente
      );

      await tx.gastoCartera.delete({
        where: { id },
      });

      if (movimientoRelacionado) {
        await tx.cajaMovimiento.delete({
          where: { id: movimientoRelacionado.id },
        });
      }

      return true;
    });

    if (!eliminado) {
      return NextResponse.json(
        { error: "Gasto de cartera no encontrado" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      ok: true,
      mensaje: "Gasto de cartera eliminado correctamente",
    });
  } catch (error) {
    console.error("ERROR ELIMINANDO GASTO DE CARTERA:", error);
    return NextResponse.json(
      { error: "Error eliminando gasto de cartera" },
      { status: 500 }
    );
  }
}
