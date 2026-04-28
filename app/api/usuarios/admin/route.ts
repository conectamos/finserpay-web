import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { resolveSellerProfileType } from "@/lib/seller-auth";
import {
  normalizarAvatarPerfil,
  normalizarTipoPerfilVendedor,
} from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import { ensureUserProfileVisualColumns } from "@/lib/user-profile-schema";

function isAdminRole(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function normalizeText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeUsername(value: unknown) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
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

function parseSedeId(value: unknown) {
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
        { error: "Solo el administrador puede gestionar usuarios" },
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
  await Promise.all([
    ensureVendorProfileVisualColumns(),
    ensureUserProfileVisualColumns(),
  ]);

  const [sedes, vendedores, administradores] = await Promise.all([
    prisma.sede.findMany({
      where: {
        activa: true,
      },
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
      where: {
        activo: true,
      },
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
    prisma.usuario.findMany({
      where: {
        rol: {
          nombre: "ADMIN",
        },
      },
      select: {
        id: true,
        nombre: true,
        usuario: true,
        avatarKey: true,
        activo: true,
        createdAt: true,
        updatedAt: true,
        sede: {
          select: {
            id: true,
            nombre: true,
          },
        },
        rol: {
          select: {
            nombre: true,
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
    administradores: administradores.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      usuario: item.usuario,
      avatarKey: normalizarAvatarPerfil(item.avatarKey, "ADMINISTRADOR"),
      activo: item.activo,
      rolNombre: item.rol.nombre,
      sede: item.sede,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    })),
    vendedores: vendedores.map((item) => ({
      id: item.id,
      nombre: item.nombre,
      tipoPerfil: normalizarTipoPerfilVendedor(
        item.tipoPerfil || resolveSellerProfileType(item.nombre)
      ),
      avatarKey: normalizarAvatarPerfil(
        item.avatarKey,
        normalizarTipoPerfilVendedor(
          item.tipoPerfil || resolveSellerProfileType(item.nombre)
        )
      ),
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

async function ensureSedeExists(sedeId: number) {
  const sede = await prisma.sede.findFirst({
    where: {
      id: sedeId,
      activa: true,
    },
    select: {
      id: true,
    },
  });

  return Boolean(sede);
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
      { error: "No se pudo cargar la gestion de usuarios" },
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

    await ensureVendorProfileVisualColumns();

    const body = (await req.json()) as Record<string, unknown>;
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;
    const tipoPerfilRaw = String(body.tipoPerfil || "").trim().toUpperCase();
    const tipoPerfil = normalizarTipoPerfilVendedor(body.tipoPerfil);
    const avatarKey = normalizarAvatarPerfil(body.avatarKey, tipoPerfil);

    if (tipoPerfilRaw === "ADMINISTRADOR") {
      await ensureUserProfileVisualColumns();

      const usuario = normalizeUsername(body.usuario);
      const clave = String(body.clave || body.pin || "").trim();
      const avatarAdministrador = normalizarAvatarPerfil(
        body.avatarKey,
        "ADMINISTRADOR"
      );
      const sedeId =
        parseSedeId(body.sedeId) ||
        (sedeIds.length === 1 ? sedeIds[0] : null);

      if (!nombre) {
        return NextResponse.json(
          { error: "El nombre del administrador es obligatorio" },
          { status: 400 }
        );
      }

      if (!usuario) {
        return NextResponse.json(
          { error: "El usuario de acceso es obligatorio" },
          { status: 400 }
        );
      }

      if (clave.length < 4) {
        return NextResponse.json(
          { error: "La clave inicial debe tener al menos 4 caracteres" },
          { status: 400 }
        );
      }

      if (!sedeId || !(await ensureSedeExists(sedeId))) {
        return NextResponse.json(
          { error: "Debes seleccionar una sede base activa" },
          { status: 400 }
        );
      }

      const existingUser = await prisma.usuario.findUnique({
        where: { usuario },
        select: { id: true },
      });

      if (existingUser) {
        return NextResponse.json(
          { error: "Ya existe un administrador con ese usuario" },
          { status: 400 }
        );
      }

      const adminRole = await prisma.rol.upsert({
        where: { nombre: "ADMIN" },
        update: {},
        create: {
          nombre: "ADMIN",
          descripcion: "Administrador",
        },
        select: {
          id: true,
        },
      });

      await prisma.usuario.create({
        data: {
          nombre,
          usuario,
          claveHash: hashPassword(clave),
          avatarKey: avatarAdministrador,
          activo,
          rolId: adminRole.id,
          sedeId,
        },
      });

      return NextResponse.json({
        ok: true,
        mensaje: "Administrador creado correctamente",
        ...(await loadAdminSellersPayload()),
      });
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del usuario es obligatorio" },
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
        { error: "Debes asignar al menos una sede al usuario" },
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
          { error: "Ya existe un usuario con ese documento" },
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
        tipoPerfil,
        avatarKey,
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
      mensaje: "Usuario creado correctamente",
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR CREANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo crear el usuario" },
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

    await ensureVendorProfileVisualColumns();

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = parseSellerId(body.vendedorId);
    const nombre = normalizeText(body.nombre);
    const documento = normalizeDocument(body.documento);
    const telefono = normalizePhone(body.telefono);
    const email = normalizeEmail(body.email);
    const pin = normalizePin(body.pin);
    const sedeIds = parseSedeIds(body.sedeIds);
    const activo = body.activo !== false;
    const tipoPerfil = normalizarTipoPerfilVendedor(body.tipoPerfil);
    const avatarKey = normalizarAvatarPerfil(body.avatarKey, tipoPerfil);

    if (!vendedorId) {
      return NextResponse.json(
        { error: "Usuario invalido" },
        { status: 400 }
      );
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del usuario es obligatorio" },
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
        { error: "Debes asignar al menos una sede al usuario" },
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
        { error: "Usuario no encontrado" },
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
          { error: "Ya existe otro usuario con ese documento" },
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
          tipoPerfil,
          avatarKey,
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
        ? "Usuario actualizado y PIN reiniciado correctamente"
        : "Usuario actualizado correctamente",
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR ACTUALIZANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo actualizar el usuario" },
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

    const body = (await req.json()) as Record<string, unknown>;
    const vendedorId = parseSellerId(body.vendedorId);

    if (!vendedorId) {
      return NextResponse.json(
        { error: "Usuario invalido" },
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
        { error: "Usuario no encontrado" },
        { status: 404 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.vendedor.update({
        where: { id: vendedorId },
        data: {
          activo: false,
          debeCambiarPin: true,
        },
      });

      await tx.sedeVendedor.updateMany({
        where: { vendedorId },
        data: { activo: false },
      });
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Usuario eliminado correctamente",
      ...(await loadAdminSellersPayload()),
    });
  } catch (error) {
    console.error("ERROR ELIMINANDO VENDEDOR:", error);
    return NextResponse.json(
      { error: "No se pudo eliminar el usuario" },
      { status: 500 }
    );
  }
}
