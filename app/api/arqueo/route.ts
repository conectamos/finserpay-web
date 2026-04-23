import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  ARQUEO_DENOMINACIONES,
  calcularTotalArqueo,
  clasificarArqueo,
  toSafeInt,
  toSafeMoney,
} from "@/lib/arqueo";
import {
  getBogotaDayRangeFromInput,
  getBogotaMonthRangeFromInput,
  getTodayBogotaDateKey,
} from "@/lib/ventas-utils";

function parseSedeId(value: unknown) {
  const sedeId = Number(value);
  return Number.isInteger(sedeId) && sedeId > 0 ? sedeId : null;
}

async function calcularCajaSistemaMensual(sedeId: number, fechaCorte: string) {
  const rangoMes = getBogotaMonthRangeFromInput(fechaCorte.slice(0, 7));

  if (!rangoMes) {
    return 0;
  }

  const [ventas, ingresosCaja, egresosCaja] = await Promise.all([
    prisma.venta.aggregate({
      where: {
        sedeId,
        fecha: {
          gte: rangoMes.start,
          lt: rangoMes.end,
        },
      },
      _sum: {
        cajaOficina: true,
      },
    }),
    prisma.cajaMovimiento.aggregate({
      where: {
        sedeId,
        tipo: "INGRESO",
        createdAt: {
          gte: rangoMes.start,
          lt: rangoMes.end,
        },
      },
      _sum: {
        valor: true,
      },
    }),
    prisma.cajaMovimiento.aggregate({
      where: {
        sedeId,
        tipo: "EGRESO",
        createdAt: {
          gte: rangoMes.start,
          lt: rangoMes.end,
        },
      },
      _sum: {
        valor: true,
      },
    }),
  ]);

  const cajaVentas = Number(ventas._sum.cajaOficina || 0);
  const netoCaja = Number(ingresosCaja._sum.valor || 0) - Number(egresosCaja._sum.valor || 0);

  return cajaVentas + netoCaja;
}

function serializarRegistro(registro: Awaited<ReturnType<typeof prisma.arqueoDiario.findFirst>>) {
  if (!registro) {
    return null;
  }

  return {
    ...registro,
    fechaCorte: registro.fechaCorte.toISOString(),
    createdAt: registro.createdAt.toISOString(),
    updatedAt: registro.updatedAt.toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const url = new URL(req.url);
    const fecha = String(url.searchParams.get("fecha") || getTodayBogotaDateKey());
    const fechaCorte = getBogotaDayRangeFromInput(fecha);

    if (!fechaCorte) {
      return NextResponse.json({ error: "La fecha del arqueo no es valida" }, { status: 400 });
    }

    const sedeId = esAdmin
      ? parseSedeId(url.searchParams.get("sedeId")) ?? user.sedeId
      : user.sedeId;

    const [registro, historial, cajaSistema] = await Promise.all([
      prisma.arqueoDiario.findUnique({
        where: {
          sedeId_fechaCorte: {
            sedeId,
            fechaCorte: fechaCorte.start,
          },
        },
        include: {
          sede: {
            select: {
              nombre: true,
            },
          },
          usuario: {
            select: {
              nombre: true,
            },
          },
        },
      }),
      prisma.arqueoDiario.findMany({
        where: {
          sedeId,
        },
        include: {
          usuario: {
            select: {
              nombre: true,
            },
          },
        },
        orderBy: {
          fechaCorte: "desc",
        },
        take: 10,
      }),
      calcularCajaSistemaMensual(sedeId, fecha),
    ]);

    return NextResponse.json({
      ok: true,
      fecha,
      sedeId,
      cajaSistema,
      registro: serializarRegistro(registro),
      historial: historial.map((item) => ({
        ...item,
        fechaCorte: item.fechaCorte.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      denominaciones: ARQUEO_DENOMINACIONES,
    });
  } catch (error) {
    console.error("ERROR GET ARQUEO:", error);
    return NextResponse.json({ error: "Error cargando arqueo" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const body = (await req.json()) as Record<string, unknown>;
    const fecha = String(body.fecha || getTodayBogotaDateKey());
    const fechaCorte = getBogotaDayRangeFromInput(fecha);

    if (!fechaCorte) {
      return NextResponse.json({ error: "La fecha del arqueo no es valida" }, { status: 400 });
    }

    const sedeId = esAdmin
      ? parseSedeId(body.sedeId) ?? user.sedeId
      : user.sedeId;

    const payloadBase = Object.fromEntries(
      ARQUEO_DENOMINACIONES.map((item) => [item.key, toSafeInt(body[item.key])])
    ) as Record<string, number>;

    const voucher = toSafeMoney(body.voucher);
    const cheques = toSafeMoney(body.cheques);
    const observacion = String(body.observacion || "").trim();

    const totalContado = calcularTotalArqueo({
      ...(payloadBase as Record<never, never>),
      voucher,
      cheques,
    });

    const cajaSistema = await calcularCajaSistemaMensual(sedeId, fecha);
    const diferencia = totalContado - cajaSistema;
    const estado = clasificarArqueo(diferencia);

    const registro = await prisma.arqueoDiario.upsert({
      where: {
        sedeId_fechaCorte: {
          sedeId,
          fechaCorte: fechaCorte.start,
        },
      },
      update: {
        ...payloadBase,
        voucher,
        cheques,
        totalContado,
        cajaSistema,
        diferencia,
        estado,
        observacion: observacion || null,
        usuarioId: user.id,
      },
      create: {
        sedeId,
        usuarioId: user.id,
        fechaCorte: fechaCorte.start,
        ...payloadBase,
        voucher,
        cheques,
        totalContado,
        cajaSistema,
        diferencia,
        estado,
        observacion: observacion || null,
      },
      include: {
        sede: {
          select: {
            nombre: true,
          },
        },
        usuario: {
          select: {
            nombre: true,
          },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      mensaje: "Arqueo diario registrado correctamente",
      registro: serializarRegistro(registro),
    });
  } catch (error) {
    console.error("ERROR POST ARQUEO:", error);
    return NextResponse.json({ error: "Error registrando arqueo" }, { status: 500 });
  }
}
