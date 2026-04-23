import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  buscarRegistroPersonalVenta,
  claveNombrePersonalVenta,
  crearRegistroPersonalVenta,
  eliminarRegistroPersonalVentaPorId,
  normalizarNombrePersonalVenta,
  normalizarTipoPersonalVenta,
  obtenerRegistroPersonalVentaPorId,
  obtenerCatalogoPersonalVenta,
} from "@/lib/ventas-personal";

function esAdmin(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function etiquetaTipo(tipo: string) {
  if (tipo === "JALADOR") return "Jalador";
  if (tipo === "CERRADOR") return "Cerrador";
  if (tipo === "FINANCIERA") return "Financiera";
  return "Registro";
}

async function requireUser() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  return { ok: true as const, user };
}

export async function GET() {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    const catalogo = await obtenerCatalogoPersonalVenta();

    return NextResponse.json(catalogo);
  } catch (error) {
    console.error("ERROR GET CATALOGO PERSONAL VENTA:", error);
    return NextResponse.json(
      { error: "Error cargando catalogo comercial" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    if (!esAdmin(session.user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede gestionar este catalogo" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const tipo = normalizarTipoPersonalVenta(body.tipo);
    const nombre = normalizarNombrePersonalVenta(body.nombre);
    const nombreNormalizado = claveNombrePersonalVenta(nombre);
    const aplicaIntermediacion = Boolean(body.aplicaIntermediacion);
    const porcentajeIntermediacion = Number(body.porcentajeIntermediacion || 0);

    if (!tipo) {
      return NextResponse.json({ error: "Tipo invalido" }, { status: 400 });
    }

    if (!nombre) {
      return NextResponse.json({ error: "El nombre es obligatorio" }, { status: 400 });
    }

    if (tipo === "FINANCIERA" && aplicaIntermediacion && porcentajeIntermediacion <= 0) {
      return NextResponse.json(
        { error: "Debes indicar un porcentaje de intermediacion valido" },
        { status: 400 }
      );
    }

    const existente = await buscarRegistroPersonalVenta({
      tipo,
      nombreNormalizado,
    });

    if (existente) {
      return NextResponse.json(
        { error: "Ese registro ya existe en el catalogo" },
        { status: 400 }
      );
    }

    await crearRegistroPersonalVenta({
      tipo,
      nombre,
      nombreNormalizado,
      aplicaIntermediacion,
      porcentajeIntermediacion,
    });

    const catalogo = await obtenerCatalogoPersonalVenta();

    return NextResponse.json({
      ok: true,
      mensaje: `${etiquetaTipo(tipo)} agregada correctamente`,
      catalogo,
    });
  } catch (error) {
    console.error("ERROR POST CATALOGO PERSONAL VENTA:", error);
    return NextResponse.json(
      { error: "Error guardando catalogo comercial" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    if (!esAdmin(session.user.rolNombre)) {
      return NextResponse.json(
        { error: "Solo el administrador puede gestionar este catalogo" },
        { status: 403 }
      );
    }

    const requestUrl = new URL(req.url);
    const id = Number(requestUrl.searchParams.get("id"));

    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Registro invalido" }, { status: 400 });
    }

    const existente = await obtenerRegistroPersonalVentaPorId(id);

    if (!existente) {
      return NextResponse.json(
        { error: "Registro no encontrado" },
        { status: 404 }
      );
    }

    await eliminarRegistroPersonalVentaPorId(id);

    const catalogo = await obtenerCatalogoPersonalVenta();

    return NextResponse.json({
      ok: true,
      mensaje: `${etiquetaTipo(existente.tipo)} eliminada correctamente`,
      catalogo,
    });
  } catch (error) {
    console.error("ERROR DELETE CATALOGO PERSONAL VENTA:", error);
    return NextResponse.json(
      { error: "Error eliminando catalogo comercial" },
      { status: 500 }
    );
  }
}
