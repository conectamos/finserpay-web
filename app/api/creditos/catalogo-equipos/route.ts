import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  createEquipmentCatalogItem,
  deleteEquipmentCatalogItem,
  findEquipmentCatalogItem,
  getEquipmentCatalog,
  normalizeEquipmentCatalogText,
  updateEquipmentCatalogItem,
} from "@/lib/equipment-catalog";
import { isAdminRole } from "@/lib/roles";

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

async function requireAdmin() {
  const session = await requireUser();

  if (!session.ok) {
    return session;
  }

  if (!isAdminRole(session.user.rolNombre)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo el administrador puede gestionar el catalogo de equipos" },
        { status: 403 }
      ),
    };
  }

  return session;
}

function parsePrice(value: unknown) {
  const price = Number(String(value ?? "").replace(/\D/g, ""));
  return Number.isFinite(price) ? Math.max(0, price) : 0;
}

async function catalogResponse(includeInactive = false) {
  const items = await getEquipmentCatalog({ includeInactive });

  return NextResponse.json({ ok: true, items });
}

export async function GET(req: Request) {
  try {
    const session = await requireUser();

    if (!session.ok) {
      return session.response;
    }

    const { searchParams } = new URL(req.url);
    const includeInactive =
      searchParams.get("includeInactive") === "true" &&
      isAdminRole(session.user.rolNombre);

    return catalogResponse(includeInactive);
  } catch (error) {
    console.error("ERROR GET CATALOGO EQUIPOS:", error);
    return NextResponse.json(
      { error: "Error cargando catalogo de equipos" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const marca = normalizeEquipmentCatalogText(body.marca);
    const modelo = normalizeEquipmentCatalogText(body.modelo);
    const precioBaseVenta = parsePrice(body.precioBaseVenta);

    if (!marca) {
      return NextResponse.json({ error: "La marca es obligatoria" }, { status: 400 });
    }

    if (!modelo) {
      return NextResponse.json({ error: "El modelo es obligatorio" }, { status: 400 });
    }

    if (precioBaseVenta <= 0) {
      return NextResponse.json(
        { error: "El precio base debe ser mayor a cero" },
        { status: 400 }
      );
    }

    const existing = await findEquipmentCatalogItem({ marca, modelo });

    if (existing) {
      return NextResponse.json(
        { error: "Ese modelo ya existe en el catalogo" },
        { status: 400 }
      );
    }

    await createEquipmentCatalogItem({ marca, modelo, precioBaseVenta });

    return catalogResponse(true);
  } catch (error) {
    console.error("ERROR POST CATALOGO EQUIPOS:", error);
    return NextResponse.json(
      { error: "Error guardando modelo de equipo" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const id = Number(body.id || 0);
    const marca = normalizeEquipmentCatalogText(body.marca);
    const modelo = normalizeEquipmentCatalogText(body.modelo);
    const precioBaseVenta = parsePrice(body.precioBaseVenta);
    const activo =
      typeof body.activo === "boolean" ? body.activo : undefined;

    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Modelo invalido" }, { status: 400 });
    }

    if (!marca || !modelo || precioBaseVenta <= 0) {
      return NextResponse.json(
        { error: "Marca, modelo y precio base son obligatorios" },
        { status: 400 }
      );
    }

    const updated = await updateEquipmentCatalogItem({
      id,
      marca,
      modelo,
      precioBaseVenta,
      activo,
    });

    if (!updated) {
      return NextResponse.json(
        { error: "Modelo no encontrado" },
        { status: 404 }
      );
    }

    return catalogResponse(true);
  } catch (error) {
    console.error("ERROR PATCH CATALOGO EQUIPOS:", error);
    return NextResponse.json(
      { error: "Error actualizando modelo de equipo" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const { searchParams } = new URL(req.url);
    const id = Number(searchParams.get("id") || 0);

    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "Modelo invalido" }, { status: 400 });
    }

    await deleteEquipmentCatalogItem(id);

    return catalogResponse(true);
  } catch (error) {
    console.error("ERROR DELETE CATALOGO EQUIPOS:", error);
    return NextResponse.json(
      { error: "Error eliminando modelo de equipo" },
      { status: 500 }
    );
  }
}
