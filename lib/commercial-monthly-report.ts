import prisma from "@/lib/prisma";
import { getBogotaMonthRangeFromInput, getCurrentBogotaMonthRange } from "@/lib/ventas-utils";
import { extraerFinancierasDetalle } from "@/lib/ventas-financieras";

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

export type MonthlyJaladorReportItem = {
  nombre: string;
  ventas: number;
  comision: number;
};

export type MonthlyCerradorReportItem = {
  nombre: string;
  ventas: number;
};

export type MonthlyFinancieraReportItem = {
  nombre: string;
  unidades: number;
  valor: number;
};

export async function getCommercialMonthlyReport(options?: {
  month?: string | null;
  sedeId?: number | null;
}) {
  const periodo =
    (options?.month ? getBogotaMonthRangeFromInput(options.month) : null) ??
    getCurrentBogotaMonthRange();

  const scope = options?.sedeId ? { sedeId: options.sedeId } : {};

  const ventas = await prisma.venta.findMany({
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
      comision: true,
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
  });

  const jaladores = new Map<string, MonthlyJaladorReportItem>();
  const cerradores = new Map<string, MonthlyCerradorReportItem>();
  const financieras = new Map<string, MonthlyFinancieraReportItem>();

  for (const venta of ventas) {
    const jaladorNombre = normalizeLabel(String(venta.jalador || ""));
    if (jaladorNombre) {
      const key = normalizeKey(jaladorNombre);
      const actual = jaladores.get(key);

      if (actual) {
        actual.ventas += 1;
        actual.comision += n(venta.comision);
      } else {
        jaladores.set(key, {
          nombre: jaladorNombre,
          ventas: 1,
          comision: n(venta.comision),
        });
      }
    }

    const cerradorNombre = normalizeLabel(String(venta.cerrador || ""));
    if (cerradorNombre) {
      const key = normalizeKey(cerradorNombre);
      const actual = cerradores.get(key);

      if (actual) {
        actual.ventas += 1;
      } else {
        cerradores.set(key, {
          nombre: cerradorNombre,
          ventas: 1,
        });
      }
    }

    const financierasVenta = extraerFinancierasDetalle(
      venta as Record<string, unknown>
    );

    for (const financiera of financierasVenta) {
      const key = normalizeKey(financiera.nombre);
      const actual = financieras.get(key);

      if (actual) {
        actual.unidades += 1;
        actual.valor += n(financiera.valorBruto);
      } else {
        financieras.set(key, {
          nombre: normalizeLabel(financiera.nombre),
          unidades: 1,
          valor: n(financiera.valorBruto),
        });
      }
    }
  }

  const jaladoresOrdenados = Array.from(jaladores.values()).sort((a, b) => {
    if (b.ventas !== a.ventas) {
      return b.ventas - a.ventas;
    }

    if (b.comision !== a.comision) {
      return b.comision - a.comision;
    }

    return a.nombre.localeCompare(b.nombre, "es");
  });

  const cerradoresOrdenados = Array.from(cerradores.values()).sort((a, b) => {
    if (b.ventas !== a.ventas) {
      return b.ventas - a.ventas;
    }

    return a.nombre.localeCompare(b.nombre, "es");
  });

  const financierasOrdenadas = Array.from(financieras.values()).sort((a, b) => {
    if (b.unidades !== a.unidades) {
      return b.unidades - a.unidades;
    }

    if (b.valor !== a.valor) {
      return b.valor - a.valor;
    }

    return a.nombre.localeCompare(b.nombre, "es");
  });

  return {
    periodo,
    ventasTotal: ventas.length,
    comisionTotal: jaladoresOrdenados.reduce((acc, item) => acc + item.comision, 0),
    financierasUnidades: financierasOrdenadas.reduce(
      (acc, item) => acc + item.unidades,
      0
    ),
    financierasValor: financierasOrdenadas.reduce((acc, item) => acc + item.valor, 0),
    jaladores: jaladoresOrdenados,
    cerradores: cerradoresOrdenados,
    financieras: financierasOrdenadas,
  };
}
