import prisma from "@/lib/prisma";
import { getCurrentBogotaMonthRange } from "@/lib/ventas-utils";
import { extraerFinancierasDetalle } from "@/lib/ventas-financieras";

const CONCEPTO_GASTO_CARTERA = "GASTO CARTERA";

export type CommercialRankingItem = {
  nombre: string;
  total: number;
  monto: number;
};

function n(value: unknown) {
  if (!value) return 0;

  if (typeof value === "object" && value !== null && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  return Number(value || 0);
}

function normalizeLabel(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeKey(value: string) {
  return normalizeLabel(value).toUpperCase();
}

function pushRanking(
  map: Map<string, CommercialRankingItem>,
  rawName: string,
  amount = 0
) {
  const nombre = normalizeLabel(rawName);

  if (!nombre) {
    return;
  }

  const key = normalizeKey(nombre);
  const current = map.get(key);

  if (current) {
    current.total += 1;
    current.monto += amount;
    return;
  }

  map.set(key, {
    nombre,
    total: 1,
    monto: amount,
  });
}

function topRanking(map: Map<string, CommercialRankingItem>, limit = 5) {
  return Array.from(map.values())
    .sort((a, b) => {
      if (b.total !== a.total) {
        return b.total - a.total;
      }

      if (b.monto !== a.monto) {
        return b.monto - a.monto;
      }

      return a.nombre.localeCompare(b.nombre, "es");
    })
    .slice(0, limit);
}

export async function getMonthlyCommercialSummary(options?: {
  sedeId?: number | null;
}) {
  const periodo = getCurrentBogotaMonthRange();
  const scope = options?.sedeId ? { sedeId: options.sedeId } : {};

  const [ventas, ventasDetalle, ingresosCaja, egresosCaja] = await Promise.all([
    prisma.venta.aggregate({
      where: {
        fecha: {
          gte: periodo.start,
          lt: periodo.end,
        },
        ...scope,
      },
      _sum: {
        utilidad: true,
        cajaOficina: true,
        ingreso: true,
      },
      _count: {
        id: true,
      },
    }),
    prisma.venta.findMany({
      where: {
        fecha: {
          gte: periodo.start,
          lt: periodo.end,
        },
        ...scope,
      },
      select: {
        jalador: true,
        cerrador: true,
        financierasDetalle: true,
        alcanos: true,
        payjoy: true,
        sistecredito: true,
        addi: true,
        sumaspay: true,
        celya: true,
        bogota: true,
        alocredit: true,
        esmio: true,
        kaiowa: true,
        finser: true,
        gora: true,
      },
    }),
    prisma.cajaMovimiento.aggregate({
      where: {
        createdAt: {
          gte: periodo.start,
          lt: periodo.end,
        },
        tipo: "INGRESO",
        NOT: {
          concepto: CONCEPTO_GASTO_CARTERA,
        },
        ...scope,
      },
      _sum: {
        valor: true,
      },
    }),
    prisma.cajaMovimiento.aggregate({
      where: {
        createdAt: {
          gte: periodo.start,
          lt: periodo.end,
        },
        tipo: "EGRESO",
        NOT: {
          concepto: CONCEPTO_GASTO_CARTERA,
        },
        ...scope,
      },
      _sum: {
        valor: true,
      },
    }),
  ]);

  const cajaVentas = n(ventas._sum.cajaOficina);
  const cajaOperativa = n(ingresosCaja._sum.valor) - n(egresosCaja._sum.valor);
  const jaladores = new Map<string, CommercialRankingItem>();
  const cerradores = new Map<string, CommercialRankingItem>();
  const financieras = new Map<string, CommercialRankingItem>();

  for (const venta of ventasDetalle) {
    if (venta.jalador) {
      pushRanking(jaladores, venta.jalador);
    }

    if (venta.cerrador) {
      pushRanking(cerradores, venta.cerrador);
    }

    const financierasVenta = extraerFinancierasDetalle(
      venta as Record<string, unknown>
    );

    for (const financiera of financierasVenta) {
      pushRanking(financieras, financiera.nombre, n(financiera.valorBruto));
    }
  }

  return {
    periodo,
    utilidad: n(ventas._sum.utilidad),
    caja: cajaVentas + cajaOperativa,
    ingresos: n(ventas._sum.ingreso),
    ventas: Number(ventas._count.id || 0),
    cajaVentas,
    cajaOperativa,
    topJaladores: topRanking(jaladores),
    topCerradores: topRanking(cerradores),
    topFinancieras: topRanking(financieras),
  };
}
