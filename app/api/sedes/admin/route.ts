import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

function esAdmin(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function normalizarNombreSede(valor: unknown) {
  return String(valor || "").replace(/\s+/g, " ").trim();
}

function normalizarCodigoSede(valor: unknown) {
  const codigo = String(valor || "").replace(/\s+/g, " ").trim().toUpperCase();
  return codigo || null;
}

function normalizarUsuarioAcceso(valor: unknown) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function nombreUsuarioSede(nombreSede: string) {
  return `Usuario ${nombreSede}`;
}

function mismoId(a?: number | null, b?: number | null) {
  return Number(a || 0) === Number(b || 0);
}

async function requireAdmin() {
  const user = await getSessionUser();

  if (!user) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "No autenticado" }, { status: 401 }),
    };
  }

  if (!esAdmin(user.rolNombre)) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Solo el administrador puede gestionar sedes" },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

async function obtenerRolUsuarioId() {
  const rol = await prisma.rol.findUnique({
    where: { nombre: "USUARIO" },
    select: { id: true },
  });

  return rol?.id ?? null;
}

async function obtenerSedesAdmin() {
  const sedes = await prisma.sede.findMany({
    where: {
      activa: true,
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activa: true,
      usuarios: {
        select: {
          id: true,
          nombre: true,
          usuario: true,
          activo: true,
          rol: {
            select: {
              nombre: true,
            },
          },
        },
        orderBy: {
          id: "asc",
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return sedes.map((sede) => {
    const acceso = sede.usuarios.find(
      (usuario) => String(usuario.rol?.nombre || "").toUpperCase() === "USUARIO"
    );

    return {
      id: sede.id,
      nombre: sede.nombre,
      codigo: sede.codigo,
      activa: sede.activa,
      acceso: acceso
        ? {
            id: acceso.id,
            nombre: acceso.nombre,
            usuario: acceso.usuario,
            activo: acceso.activo,
          }
        : null,
    };
  });
}

export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const body = (await req.json()) as Record<string, unknown>;
    const sedeId = Number(body.sedeId || 0);

    if (!Number.isInteger(sedeId) || sedeId <= 0) {
      return NextResponse.json({ error: "Sede invalida" }, { status: 400 });
    }

    if (sedeId === session.user.sedeId) {
      return NextResponse.json(
        { error: "No puedes eliminar la sede de tu sesion actual" },
        { status: 400 }
      );
    }

    const sede = await prisma.sede.findUnique({
      where: { id: sedeId },
      select: { id: true },
    });

    if (!sede) {
      return NextResponse.json(
        { error: "Sede no encontrada" },
        { status: 404 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.sede.update({
        where: { id: sedeId },
        data: { activa: false },
      });

      await tx.usuario.updateMany({
        where: {
          sedeId,
          rol: {
            nombre: "USUARIO",
          },
        },
        data: {
          activo: false,
        },
      });

      await tx.sedeVendedor.updateMany({
        where: { sedeId },
        data: { activo: false },
      });
    });

    const sedes = await obtenerSedesAdmin();

    return NextResponse.json({
      ok: true,
      mensaje: "Sede eliminada correctamente",
      sedes,
    });
  } catch (error) {
    console.error("ERROR DELETE ADMIN SEDES:", error);
    return NextResponse.json(
      { error: "Error eliminando sede" },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const sedes = await obtenerSedesAdmin();

    return NextResponse.json({ ok: true, sedes });
  } catch (error) {
    console.error("ERROR GET ADMIN SEDES:", error);
    return NextResponse.json(
      { error: "Error cargando sedes" },
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
    const nombre = normalizarNombreSede(body.nombre);
    const codigo = normalizarCodigoSede(body.codigo);
    const usuarioAcceso = normalizarUsuarioAcceso(body.usuario);
    const clave = String(body.clave || "").trim();

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre de la sede es obligatorio" },
        { status: 400 }
      );
    }

    if (!usuarioAcceso) {
      return NextResponse.json(
        { error: "El usuario de acceso es obligatorio" },
        { status: 400 }
      );
    }

    if (!clave) {
      return NextResponse.json(
        { error: "La clave es obligatoria" },
        { status: 400 }
      );
    }

    const rolUsuarioId = await obtenerRolUsuarioId();

    if (!rolUsuarioId) {
      return NextResponse.json(
        { error: "No existe el rol USUARIO en el sistema" },
        { status: 500 }
      );
    }

    const [sedePorNombre, sedePorCodigo, usuarioExistente] = await Promise.all([
      prisma.sede.findUnique({
        where: { nombre },
        select: {
          id: true,
          nombre: true,
          codigo: true,
          activa: true,
        },
      }),
      codigo
        ? prisma.sede.findUnique({
            where: { codigo },
            select: {
              id: true,
              nombre: true,
              codigo: true,
              activa: true,
            },
          })
        : Promise.resolve(null),
      prisma.usuario.findUnique({
        where: { usuario: usuarioAcceso },
        select: {
          id: true,
          activo: true,
          sedeId: true,
          sede: {
            select: {
              id: true,
              nombre: true,
              codigo: true,
              activa: true,
            },
          },
        },
      }),
    ]);

    if (sedePorNombre?.activa) {
      return NextResponse.json(
        { error: "Ya existe una sede con ese nombre" },
        { status: 400 }
      );
    }

    if (sedePorCodigo?.activa) {
      return NextResponse.json(
        { error: "Ese codigo de sede ya existe" },
        { status: 400 }
      );
    }

    if (
      sedePorNombre &&
      sedePorCodigo &&
      !mismoId(sedePorNombre.id, sedePorCodigo.id)
    ) {
      return NextResponse.json(
        {
          error:
            "Ese nombre y ese codigo pertenecen a sedes eliminadas diferentes",
        },
        { status: 400 }
      );
    }

    const sedeParaReactivar =
      sedePorNombre && !sedePorNombre.activa
        ? sedePorNombre
        : sedePorCodigo && !sedePorCodigo.activa
          ? sedePorCodigo
          : usuarioExistente &&
              !usuarioExistente.activo &&
              !usuarioExistente.sede.activa
            ? usuarioExistente.sede
            : null;

    if (usuarioExistente) {
      const usuarioPerteneceALaSedeReactivada =
        sedeParaReactivar && mismoId(usuarioExistente.sedeId, sedeParaReactivar.id);

      if (!usuarioPerteneceALaSedeReactivada) {
        return NextResponse.json(
          { error: "Ese usuario de acceso ya existe" },
          { status: 400 }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      if (sedeParaReactivar) {
        await tx.sede.update({
          where: { id: sedeParaReactivar.id },
          data: {
            nombre,
            codigo,
            activa: true,
          },
        });

        const accesoAnterior = await tx.usuario.findFirst({
          where: {
            sedeId: sedeParaReactivar.id,
            rolId: rolUsuarioId,
          },
          select: { id: true },
          orderBy: { id: "asc" },
        });

        if (accesoAnterior) {
          await tx.usuario.update({
            where: { id: accesoAnterior.id },
            data: {
              nombre: nombreUsuarioSede(nombre),
              usuario: usuarioAcceso,
              claveHash: hashPassword(clave),
              activo: true,
            },
          });
        } else {
          await tx.usuario.create({
            data: {
              nombre: nombreUsuarioSede(nombre),
              usuario: usuarioAcceso,
              claveHash: hashPassword(clave),
              activo: true,
              rolId: rolUsuarioId,
              sedeId: sedeParaReactivar.id,
            },
          });
        }

        return;
      }

      const sede = await tx.sede.create({
        data: {
          nombre,
          codigo,
          activa: true,
        },
        select: {
          id: true,
        },
      });

      await tx.usuario.create({
        data: {
          nombre: nombreUsuarioSede(nombre),
          usuario: usuarioAcceso,
          claveHash: hashPassword(clave),
          activo: true,
          rolId: rolUsuarioId,
          sedeId: sede.id,
        },
      });
    });

    const sedes = await obtenerSedesAdmin();

    return NextResponse.json({
      ok: true,
      mensaje: sedeParaReactivar
        ? "Sede reactivada correctamente"
        : "Sede creada correctamente",
      sedes,
    });
  } catch (error) {
    console.error("ERROR POST ADMIN SEDES:", error);
    return NextResponse.json(
      { error: "Error creando sede" },
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
    const sedeId = Number(body.sedeId || 0);
    const nombre = normalizarNombreSede(body.nombre);
    const codigo = normalizarCodigoSede(body.codigo);
    const usuarioAcceso = normalizarUsuarioAcceso(body.usuario);
    const clave = String(body.clave || "").trim();

    if (!Number.isInteger(sedeId) || sedeId <= 0) {
      return NextResponse.json({ error: "Sede invalida" }, { status: 400 });
    }

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre de la sede es obligatorio" },
        { status: 400 }
      );
    }

    const sedeActual = await prisma.sede.findUnique({
      where: { id: sedeId },
      select: {
        id: true,
        nombre: true,
        codigo: true,
        usuarios: {
          select: {
            id: true,
            usuario: true,
            rol: {
              select: {
                nombre: true,
              },
            },
          },
          orderBy: {
            id: "asc",
          },
        },
      },
    });

    if (!sedeActual) {
      return NextResponse.json(
        { error: "Sede no encontrada" },
        { status: 404 }
      );
    }

    const accesoExistente = sedeActual.usuarios.find(
      (usuario) => String(usuario.rol?.nombre || "").toUpperCase() === "USUARIO"
    );

    if (!accesoExistente && !usuarioAcceso) {
      return NextResponse.json(
        { error: "Debes definir el usuario de acceso para esta sede" },
        { status: 400 }
      );
    }

    if (!accesoExistente && !clave) {
      return NextResponse.json(
        { error: "Debes definir la clave inicial para esta sede" },
        { status: 400 }
      );
    }

    const otraSedeMismoNombre = await prisma.sede.findFirst({
      where: {
        nombre,
        id: { not: sedeId },
      },
      select: { id: true },
    });

    if (otraSedeMismoNombre) {
      return NextResponse.json(
        { error: "Ya existe otra sede con ese nombre" },
        { status: 400 }
      );
    }

    if (codigo) {
      const otraSedeMismoCodigo = await prisma.sede.findFirst({
        where: {
          codigo,
          id: { not: sedeId },
        },
        select: { id: true },
      });

      if (otraSedeMismoCodigo) {
        return NextResponse.json(
          { error: "Ya existe otra sede con ese codigo" },
          { status: 400 }
        );
      }
    }

    if (usuarioAcceso) {
      const otroUsuario = await prisma.usuario.findFirst({
        where: {
          usuario: usuarioAcceso,
          ...(accesoExistente ? { id: { not: accesoExistente.id } } : {}),
        },
        select: { id: true },
      });

      if (otroUsuario) {
        return NextResponse.json(
          { error: "Ese usuario de acceso ya existe" },
          { status: 400 }
        );
      }
    }

    const rolUsuarioId = !accesoExistente ? await obtenerRolUsuarioId() : null;

    if (!accesoExistente && !rolUsuarioId) {
      return NextResponse.json(
        { error: "No existe el rol USUARIO en el sistema" },
        { status: 500 }
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.sede.update({
        where: { id: sedeId },
        data: {
          nombre,
          codigo,
        },
      });

      if (accesoExistente) {
        await tx.usuario.update({
          where: { id: accesoExistente.id },
          data: {
            nombre: nombreUsuarioSede(nombre),
            ...(usuarioAcceso ? { usuario: usuarioAcceso } : {}),
            ...(clave ? { claveHash: hashPassword(clave) } : {}),
          },
        });
      } else {
        await tx.usuario.create({
          data: {
            nombre: nombreUsuarioSede(nombre),
            usuario: usuarioAcceso,
            claveHash: hashPassword(clave),
            activo: true,
            rolId: Number(rolUsuarioId),
            sedeId,
          },
        });
      }
    });

    const sedes = await obtenerSedesAdmin();

    return NextResponse.json({
      ok: true,
      mensaje: accesoExistente
        ? "Sede actualizada correctamente"
        : "Acceso de sede creado correctamente",
      sedes,
    });
  } catch (error) {
    console.error("ERROR PATCH ADMIN SEDES:", error);
    return NextResponse.json(
      { error: "Error actualizando sede" },
      { status: 500 }
    );
  }
}
