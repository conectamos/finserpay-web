import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  ensureAliadoConectamos,
  normalizeAllyCode,
  normalizeAllyName,
} from "@/lib/aliados";

function esAdmin(rolNombre: string) {
  return String(rolNombre || "").trim().toUpperCase() === "ADMIN";
}

function parseId(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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
        { error: "Solo FINSER PAY puede gestionar aliados" },
        { status: 403 }
      ),
    };
  }

  return { ok: true as const, user };
}

async function loadAliadosPayload() {
  await ensureAliadoConectamos(prisma);

  const aliados = await prisma.aliado.findMany({
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
      createdAt: true,
      updatedAt: true,
      sedes: {
        where: {
          activa: true,
        },
        select: {
          id: true,
          nombre: true,
          codigo: true,
          activa: true,
        },
        orderBy: {
          nombre: "asc",
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
  });

  const aliadosConMetricas = await Promise.all(
    aliados.map(async (aliado) => {
      const sedeIds = aliado.sedes.map((sede) => sede.id);
      const [creditos, recaudos] = await Promise.all([
        sedeIds.length
          ? prisma.credito.count({
              where: {
                sedeId: {
                  in: sedeIds,
                },
              },
            })
          : Promise.resolve(0),
        sedeIds.length
          ? prisma.creditoAbono.count({
              where: {
                sedeId: {
                  in: sedeIds,
                },
                estado: {
                  not: "ANULADO",
                },
              },
            })
          : Promise.resolve(0),
      ]);

      return {
        id: aliado.id,
        nombre: aliado.nombre,
        codigo: aliado.codigo,
        activo: aliado.activo,
        sedes: aliado.sedes,
        totalSedes: aliado.sedes.length,
        totalCreditos: creditos,
        totalRecaudos: recaudos,
        createdAt: aliado.createdAt.toISOString(),
        updatedAt: aliado.updatedAt.toISOString(),
      };
    })
  );

  return {
    aliados: aliadosConMetricas,
  };
}

export async function GET() {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    return NextResponse.json({
      ok: true,
      ...(await loadAliadosPayload()),
    });
  } catch (error) {
    console.error("ERROR GET ADMIN ALIADOS:", error);
    return NextResponse.json(
      { error: "Error cargando aliados" },
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
    const nombre = normalizeAllyName(body.nombre);
    const codigo = normalizeAllyCode(body.codigo || nombre);

    if (!nombre) {
      return NextResponse.json(
        { error: "El nombre del aliado es obligatorio" },
        { status: 400 }
      );
    }

    await prisma.aliado.create({
      data: {
        nombre,
        codigo,
        activo: true,
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Aliado creado correctamente",
      ...(await loadAliadosPayload()),
    });
  } catch (error) {
    console.error("ERROR POST ADMIN ALIADOS:", error);
    return NextResponse.json(
      { error: "Error creando aliado" },
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
    const aliadoId = parseId(body.aliadoId);

    if (!aliadoId) {
      return NextResponse.json({ error: "Aliado invalido" }, { status: 400 });
    }

    const data: {
      nombre?: string;
      codigo?: string | null;
      activo?: boolean;
    } = {};

    if ("nombre" in body) {
      const nombre = normalizeAllyName(body.nombre);

      if (!nombre) {
        return NextResponse.json(
          { error: "El nombre del aliado es obligatorio" },
          { status: 400 }
        );
      }

      data.nombre = nombre;
    }

    if ("codigo" in body) {
      data.codigo = normalizeAllyCode(body.codigo);
    }

    if ("activo" in body) {
      data.activo = Boolean(body.activo);
    }

    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.aliado.update({
          where: {
            id: aliadoId,
          },
          data,
        });
      }

    });

    return NextResponse.json({
      ok: true,
      mensaje: "Aliado actualizado correctamente",
      ...(await loadAliadosPayload()),
    });
  } catch (error) {
    console.error("ERROR PATCH ADMIN ALIADOS:", error);
    return NextResponse.json(
      { error: "Error actualizando aliado" },
      { status: 500 }
    );
  }
}
