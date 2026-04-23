import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";

const CONCEPTOS_PROTEGIDOS = new Set([
  "GASTO CARTERA",
  "PAGO DEUDA INVENTARIO",
  "PAGO PRESTAMO ENTRE SEDES",
  "ABONO TRANSFERENCIA",
  "ABONO FINANCIERA",
]);
const CONCEPTO_GASTO_CARTERA = "GASTO CARTERA";

function parseSedeId(value: string | null) {
  const sedeId = Number(value);
  return Number.isInteger(sedeId) && sedeId > 0 ? sedeId : null;
}

function parseMovimientoId(value: string | null) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizarConcepto(value: unknown) {
  return String(value ?? "").trim();
}

function esMovimientoEditable(concepto: string | null | undefined) {
  return !CONCEPTOS_PROTEGIDOS.has(String(concepto || "").trim().toUpperCase());
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = user.rolNombre.toUpperCase() === "ADMIN";
    const requestUrl = new URL(req.url);
    const sedeIdFiltro = parseSedeId(requestUrl.searchParams.get("sedeId"));

    const movimientos = await prisma.cajaMovimiento.findMany({
      where: esAdmin
        ? sedeIdFiltro
          ? { sedeId: sedeIdFiltro, NOT: { concepto: CONCEPTO_GASTO_CARTERA } }
          : { NOT: { concepto: CONCEPTO_GASTO_CARTERA } }
        : { sedeId: user.sedeId, NOT: { concepto: CONCEPTO_GASTO_CARTERA } },
      orderBy: { id: "desc" },
      include: {
        sede: {
          select: {
            nombre: true,
          },
        },
      },
    });

    return NextResponse.json(
      movimientos.map((movimiento) => ({
        ...movimiento,
        editable: esMovimientoEditable(movimiento.concepto),
      }))
    );
  } catch (error) {
    console.error("ERROR GET CAJA:", error);
    return NextResponse.json(
      { error: "Error cargando caja" },
      { status: 500 }
    );
  }
}

export async function PUT(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (String(user.rolNombre || "").toUpperCase() !== "ADMIN") {
      return NextResponse.json(
        { error: "Solo el administrador puede editar movimientos" },
        { status: 403 }
      );
    }

    const requestUrl = new URL(req.url);
    const queryId = parseMovimientoId(requestUrl.searchParams.get("id"));
    const body = (await req.json()) as Record<string, unknown>;
    const id = queryId ?? parseMovimientoId(String(body.id ?? ""));
    const tipo = String(body.tipo ?? "").trim().toUpperCase();
    const concepto = normalizarConcepto(body.concepto);
    const valor = Number(body.valor ?? 0);
    const descripcion = String(body.descripcion ?? "").trim();
    const sedeId = parseSedeId(String(body.sedeId ?? ""));

    if (!id) {
      return NextResponse.json({ error: "ID invalido" }, { status: 400 });
    }

    if (!["INGRESO", "EGRESO"].includes(tipo)) {
      return NextResponse.json(
        { error: "Tipo invalido. Debe ser INGRESO o EGRESO" },
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

    if (!sedeId) {
      return NextResponse.json({ error: "Sede invalida" }, { status: 400 });
    }

    const movimientoExistente = await prisma.cajaMovimiento.findUnique({
      where: { id },
      select: {
        id: true,
        concepto: true,
      },
    });

    if (!movimientoExistente) {
      return NextResponse.json(
        { error: "Movimiento no encontrado" },
        { status: 404 }
      );
    }

    if (!esMovimientoEditable(movimientoExistente.concepto)) {
      return NextResponse.json(
        {
          error:
            "Este movimiento es automatico del sistema y no puede editarse desde Ingresos / Gastos",
        },
        { status: 403 }
      );
    }

    const movimiento = await prisma.cajaMovimiento.update({
      where: { id },
      data: {
        tipo,
        concepto,
        valor,
        descripcion: descripcion || null,
        sedeId,
      },
      include: {
        sede: {
          select: {
            nombre: true,
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Movimiento actualizado correctamente",
      movimiento: {
        ...movimiento,
        editable: true,
      },
    });
  } catch (error) {
    console.error("ERROR PUT CAJA:", error);
    return NextResponse.json(
      { error: "Error actualizando movimiento de caja" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (String(user.rolNombre || "").toUpperCase() !== "ADMIN") {
      return NextResponse.json(
        { error: "Solo el administrador puede eliminar movimientos" },
        { status: 403 }
      );
    }

    const requestUrl = new URL(req.url);
    const id = parseMovimientoId(requestUrl.searchParams.get("id"));

    if (!id) {
      return NextResponse.json({ error: "ID invalido" }, { status: 400 });
    }

    const movimientoExistente = await prisma.cajaMovimiento.findUnique({
      where: { id },
      select: {
        id: true,
        concepto: true,
      },
    });

    if (!movimientoExistente) {
      return NextResponse.json(
        { error: "Movimiento no encontrado" },
        { status: 404 }
      );
    }

    if (!esMovimientoEditable(movimientoExistente.concepto)) {
      return NextResponse.json(
        {
          error:
            "Este movimiento es automatico del sistema y no puede eliminarse desde Ingresos / Gastos",
        },
        { status: 403 }
      );
    }

    await prisma.cajaMovimiento.delete({
      where: { id },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Movimiento eliminado correctamente",
    });
  } catch (error) {
    console.error("ERROR DELETE CAJA:", error);
    return NextResponse.json(
      { error: "Error eliminando movimiento de caja" },
      { status: 500 }
    );
  }
}
