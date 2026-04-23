import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

function isAdminRole(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeDocument(value: unknown) {
  return String(value || "").replace(/\D/g, "").trim();
}

function normalizePhone(value: unknown) {
  return String(value || "").replace(/[^\d+]/g, "").trim();
}

function normalizePin(value: unknown) {
  return String(value || "").replace(/\D/g, "").trim();
}

function parseSellerId(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function parseSedeIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((item) => Number(item || 0))
        .filter((item) => Number.isInteger(item) && item > 0)
    )
  );
}

function isValidPin(pin: string) {
  return /^\d{4,6}$/.test(pin);
}

async function requireAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  if (!isAdminRole(user.rolNombre)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo el administrador puede gestionar vendedores" },
        { status: 403 }
      ),
    };
  }

  return {
    ok: true as const,
    user,
  };
}

async function loadAdminSellersPayload() {
  const [sedes, vendedores] = await Promise.all([
    prisma.sede.findMany({
      select: {
        id: true,
        nombre: true,
        activa: true,
      },
      orderBy: {
        nombre: "asc",
      },
    }),
    prisma.vendedor.findMany({
      include: {
        asignaciones: {
          where: {
            activo: true,
          },
          select: {
            sede: {
              select: {
                id: true,
                nombre: true,
              },
            },
          },
          orderBy: {
            sede: {
              nombre: "asc",
            },
          },
        },
      },
      orderBy: [
        {
          activo: "desc",
        },
        {
          nombre: "asc",
        },
      ],
    }),
  ]);

  return {
    sedes,
    vendedores: vendedores.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      documento: item.documento,
      telefono: item.telefono,
      email: item.email,
      activo: item.activo,
      debeCambiarPin: item.debeCambiarPin,
      assignedSedeIds: item.asignaciones.map((asignacion) => asignacion.sede.id),
      assignedSedes: item.asignaciones.map((asignacion) => asignacion.sede),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      ultimoIngresoAt: item.ultimoIngresoAt?.toISOString() || null,
    })),
  };
}

async function ensureSedesExist(sedeIds: number[]) {
  const sedes = await prisma.sede.findMany({
    where: {
      id: {
        in: sedeIds,
      },
      activa: true,
    },
    select: {
      id: true,
    },
  });

  return sedes.length === sedeIds.length;
}

export async function GET() {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    return NextResponse.json({
      ok: true,
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR LISTANDO VENDEDORES:", error);
    return NextResponse.json(
      { error: "No se pudo cargar la gestion de vendedores" },
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
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del vendedor es obligatorio" },
        { status: 400 }
      );
    }

    if (!isValidPin(pin)) {
      return NextResponse.json(
        { error: "El PIN inicial debe tener entre 4 y 6 digitos" },
        { status: 400 }
      );
    }

    if (!sedeIds.length) {
      return NextResponse.json(
        { error: "Debes asignar al menos una sede al vendedor" },
        { status: 400 }
      );
    }

    if (!(await ensureSedesExist(sedeIds))) {
      return NextResponse.json(
        { error: "Alguna de las sedes seleccionadas no existe o esta inactiva" },
        { status: 404 }
      );
    }

    if (documento) {
      const existingDocument = await prisma.vendedor.findUnique({
        where: { documento },
        select: { id: true },
      });

      if (existingDocument) {
        return NextResponse.json(
          { error: "Ya existe un vendedor con ese documento" },
          { status: 400 }
        );
      }
    }

    await prisma.vendedor.create({
      data: {
        nombre,
        documento: documento || null,
        telefono: telefono || null,
        email: email || null,
        activo,
        pinHash: hashPassword(pin),
        debeCambiarPin: true,
        asignaciones: {
          createMany: {
            data: sedeIds.map((sedeId) => ({
              sedeId,
              activo: true,
            })),
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Vendedor creado correctamente",
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR CREANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo crear el vendedor" },
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
    const vendedorId = parseSellerId(body.vendedorId);
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;

    if (!vendedorId) {
      return NextResponse.json(
        { error: "Vendedor invalido" },
        { status: 400 }
      );
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del vendedor es obligatorio" },
        { status: 400 }
      );
    }

    if (pin && !isValidPin(pin)) {
      return NextResponse.json(
        { error: "El PIN debe tener entre 4 y 6 digitos" },
        { status: 400 }
      );
    }

    if (!sedeIds.length) {
      return NextResponse.json(
        { error: "Debes asignar al menos una sede al vendedor" },
        { status: 400 }
      );
    }

    const seller = await prisma.vendedor.findUnique({
      where: { id: vendedorId },
      select: {
        id: true,
      },
    });

    if (!seller) {
      return NextResponse.json(
        { error: "Vendedor no encontrado" },
        { status: 404 }
      );
    }

    if (!(await ensureSedesExist(sedeIds))) {
      return NextResponse.json(
        { error: "Alguna de las sedes seleccionadas no existe o esta inactiva" },
        { status: 404 }
      );
    }

    if (documento) {
      const existingDocument = await prisma.vendedor.findFirst({
        where: {
          documento,
          id: {
            not: vendedorId,
          },
        },
        select: { id: true },
      });

      if (existingDocument) {
        return NextResponse.json(
          { error: "Ya existe otro vendedor con ese documento" },
          { status: 400 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendedor.update({
        where: { id: vendedorId },
        data: {
          nombre,
          documento: documento || null,
          telefono: telefono || null,
          email: email || null,
          activo,
          ...(pin
            ? {
                pinHash: hashPassword(pin),
                pinTemporalHash: null,
                debeCambiarPin: true,
              }
            : {}),
        },
      });

      await tx.sedeVendedor.deleteMany({
        where: {
          vendedorId,
        },
      });

      await tx.sedeVendedor.createMany({
        data: sedeIds.map((sedeId) => ({
          sedeId,
          vendedorId,
          activo: true,
        })),
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: pin
        ? "Vendedor actualizado y PIN reiniciado correctamente"
        : "Vendedor actualizado correctamente",
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo actualizar el vendedor" },
      { status: 500 }
    );
  }
}
