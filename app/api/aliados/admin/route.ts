import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  ensureAliadoConectamos,
  ensureAliadoFinserPay,
  ensureAliadoSchema,
  isFinserPayCentralAlly,
  normalizeAllyCode,
  normalizeAllyName,
  normalizeRedescuentoPercentage,
} from "@/lib/aliados";
import { ensureDigitalCollectionSede } from "@/lib/digital-collection-sede";

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

function getAliadoScope(user: Awaited<ReturnType<typeof getSessionUser>>) {
  if (isFinserPayCentralAlly(user?.aliadoAccesoCodigo)) {
    return null;
  }

  const aliadoId = Number(user?.aliadoAccesoId || 0);

  return Number.isInteger(aliadoId) && aliadoId > 0 ? aliadoId : null;
}

async function loadAliadosPayload(aliadoScopeId: number | null) {
  await ensureAliadoSchema(prisma);
  await Promise.all([
    ensureAliadoFinserPay(prisma),
    ensureAliadoConectamos(prisma),
    ensureDigitalCollectionSede(),
  ]);

  const aliados = await prisma.aliado.findMany({
    where: {
      ...(aliadoScopeId ? { id: aliadoScopeId } : {}),
    },
    select: {
      id: true,
      nombre: true,
      codigo: true,
      activo: true,
      redescuentoPorcentaje: true,
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
        redescuentoPorcentaje: aliado.redescuentoPorcentaje,
        sedes: aliado.sedes,
        totalSedes: aliado.sedes.length,
        totalCreditos: creditos,
        totalRecaudos: recaudos,
        createdAt: aliado.createdAt.toISOString(),
        updatedAt: aliado.updatedAt.toISOString(),
      };
    })
  );

  const sistemaCentral =
    aliadosConMetricas.find((aliado) => isFinserPayCentralAlly(aliado.codigo)) ||
    null;
  const aliadosComerciales = aliadosConMetricas.filter(
    (aliado) => !isFinserPayCentralAlly(aliado.codigo)
  );

  return {
    scope: {
      central: !aliadoScopeId,
      aliadoId: aliadoScopeId,
    },
    sistemaCentral: aliadoScopeId ? null : sistemaCentral,
    aliados: aliadosComerciales,
  };
}

export async function GET() {
  try {
    const session = await requireAdmin();

    if (!session.ok) {
      return session.response;
    }

    const aliadoScopeId = getAliadoScope(session.user);

    return NextResponse.json({
      ok: true,
      ...(await loadAliadosPayload(aliadoScopeId)),
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

    if (getAliadoScope(session.user)) {
      return NextResponse.json(
        { error: "Solo FINSER PAY central puede crear aliados" },
        { status: 403 }
      );
    }

    const body = (await req.json()) as Record<string, unknown>;
    const nombre = normalizeAllyName(body.nombre);
    const codigo = normalizeAllyCode(body.codigo || nombre);
    const redescuentoPorcentaje = normalizeRedescuentoPercentage(
      body.redescuentoPorcentaje
    );

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
        redescuentoPorcentaje,
        activo: true,
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Aliado creado correctamente",
      ...(await loadAliadosPayload(null)),
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

    const aliadoScopeId = getAliadoScope(session.user);
    const body = (await req.json()) as Record<string, unknown>;
    const aliadoId = parseId(body.aliadoId);

    if (!aliadoId) {
      return NextResponse.json({ error: "Aliado invalido" }, { status: 400 });
    }

    if (aliadoScopeId && aliadoId !== aliadoScopeId) {
      return NextResponse.json(
        { error: "No puedes editar otro aliado" },
        { status: 403 }
      );
    }

    const data: {
      nombre?: string;
      codigo?: string | null;
      activo?: boolean;
      redescuentoPorcentaje?: number;
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

    if ("redescuentoPorcentaje" in body) {
      if (aliadoScopeId) {
        return NextResponse.json(
          { error: "Solo FINSER PAY central puede editar el redescuento" },
          { status: 403 }
        );
      }

      data.redescuentoPorcentaje = normalizeRedescuentoPercentage(
        body.redescuentoPorcentaje
      );
    }

    if (Object.keys(data).length > 0) {
      await prisma.aliado.update({
        where: {
          id: aliadoId,
        },
        data,
      });
    }

    return NextResponse.json({
      ok: true,
      mensaje: "Aliado actualizado correctamente",
      ...(await loadAliadosPayload(aliadoScopeId)),
    });
  } catch (error) {
    console.error("ERROR PATCH ADMIN ALIADOS:", error);
    return NextResponse.json(
      { error: "Error actualizando aliado" },
      { status: 500 }
    );
  }
}
