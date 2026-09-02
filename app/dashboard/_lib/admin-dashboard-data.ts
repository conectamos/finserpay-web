import type { Prisma } from "@/app/generated/prisma/client";
import { resolveCapitalOriginal } from "@/lib/credit-capital";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { resolveDashboardMonth } from "@/lib/dashboard-month";
import prisma from "@/lib/prisma";

type RiskBucket = "alDia" | "temprana" | "critica";

export type AdminDashboardDailyPoint = {
  day: number;
  creditCount: number;
  placedCapital: number;
  recaudo: number;
};

export type AdminDashboardCreditPerformancePoint = {
  name: string;
  units: number;
  value: number;
};

export type AdminDashboardOverview = {
  activeCredits: number;
  activePlacedCapital: number;
  alertsCount: number;
  creditPerformance: AdminDashboardCreditPerformancePoint[];
  criticalCredits: number;
  daily: AdminDashboardDailyPoint[];
  dueToday: number;
  earlyClients: number;
  healthyBalance: number;
  healthyPercent: number;
  criticalBalance: number;
  criticalPercent: number;
  currentMonthKey: string;
  delinquencyPercent: number;
  earlyBalance: number;
  earlyPercent: number;
  monthLabel: string;
  monthKey: string;
  monthlyCollection: number;
  monthlyCreditCount: number;
  monthlyPaymentCount: number;
  monthlyPlacedCapital: number;
};

type AdminDashboardDataOptions = {
  aliadoId?: number | null;
  month?: string | null;
};

function dateFromIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1, 12, 0, 0, 0);

  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function daysLate(dueDateIso: string, today: Date) {
  const due = dateFromIso(dueDateIso);
  const base = new Date(today);
  base.setHours(12, 0, 0, 0);

  return Math.max(0, Math.floor((base.getTime() - due.getTime()) / 86_400_000));
}

function riskBucket(days: number): RiskBucket {
  if (days <= 0) {
    return "alDia";
  }

  if (days <= 15) {
    return "temprana";
  }

  return "critica";
}

function ratio(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0;
}

function colombiaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Bogota",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    day: Number(values.day),
    month: Number(values.month),
    year: Number(values.year),
  };
}

function colombiaDay(date: Date) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      timeZone: "America/Bogota",
    }).format(date)
  );
}

export async function getAdminDashboardOverview({
  aliadoId = null,
  month = null,
}: AdminDashboardDataOptions = {}): Promise<AdminDashboardOverview> {
  const today = new Date();
  const current = colombiaDateParts(today);
  const selectedMonth = resolveDashboardMonth(month, today);
  const monthStart = selectedMonth.start;
  const nextMonthStart = selectedMonth.end;
  const daysInMonth = selectedMonth.daysInMonth;
  const todayIso = [
    current.year,
    String(current.month).padStart(2, "0"),
    String(current.day).padStart(2, "0"),
  ].join("-");
  const performanceGroup = aliadoId ? "sede" : "aliado";
  const scope = aliadoId
    ? {
        sede: {
          aliadoId,
        },
      }
    : {};
  const creditWhere: Prisma.CreditoWhereInput = {
    ...scope,
    estado: {
      not: "ANULADO",
    },
  };
  const paymentWhere: Prisma.CreditoAbonoWhereInput = {
    ...scope,
    estado: {
      not: "ANULADO",
    },
    fechaAbono: {
      gte: monthStart,
      lt: nextMonthStart,
    },
  };

  const [credits, monthPayments] = await Promise.all([
    prisma.credito.findMany({
      where: creditWhere,
      select: {
        abonos: {
          where: {
            estado: {
              not: "ANULADO",
            },
          },
          select: {
            fechaAbono: true,
            valor: true,
          },
          orderBy: {
            fechaAbono: "asc",
          },
        },
        clienteDocumento: true,
        clienteNombre: true,
        cuotaInicial: true,
        fechaCredito: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        frecuenciaPago: true,
        id: true,
        montoCredito: true,
        pazYSalvoEmitidoAt: true,
        plazoMeses: true,
        saldoBaseFinanciado: true,
        sede: {
          select: {
            aliado: {
              select: {
                nombre: true,
              },
            },
            nombre: true,
          },
        },
        valorCuota: true,
        valorEquipoTotal: true,
        valorFianza: true,
        valorInteres: true,
      },
    }),
    prisma.creditoAbono.findMany({
      where: paymentWhere,
      select: {
        fechaAbono: true,
        valor: true,
      },
    }),
  ]);

  const portfolio = credits.map((credit) => {
    const plan = buildCreditPaymentPlan({
      abonos: credit.abonos,
      fechaPrimerPago: credit.fechaPrimerPago,
      fechaProximoPago: credit.fechaProximoPago,
      frecuenciaPago: credit.frecuenciaPago,
      montoCredito: credit.montoCredito,
      plazoMeses: credit.plazoMeses,
      today,
      valorCuota: credit.valorCuota,
      settled: Boolean(credit.pazYSalvoEmitidoAt),
    });
    const overdueInstallments = plan.installments.filter(
      (installment) => installment.estaEnMora && installment.saldoPendiente > 0
    );
    const lateDays = overdueInstallments.reduce(
      (max, installment) =>
        Math.max(max, daysLate(installment.fechaVencimiento, today)),
      0
    );

    return {
      aliadoNombre: credit.sede.aliado?.nombre || "Sin aliado",
      bucket: riskBucket(lateDays),
      capitalColocado: resolveCapitalOriginal({
        cuotaInicial: credit.cuotaInicial,
        montoCredito: credit.montoCredito,
        saldoBaseFinanciado: credit.saldoBaseFinanciado,
        valorEquipoTotal: credit.valorEquipoTotal,
        valorFianza: credit.valorFianza,
        valorInteres: credit.valorInteres,
      }),
      clientKey: credit.clienteDocumento || credit.clienteNombre || String(credit.id),
      dueToday: plan.installments.filter(
        (installment) =>
          installment.fechaVencimiento === todayIso && installment.saldoPendiente > 0
      ).length,
      fechaCredito: credit.fechaCredito,
      saldoPendiente: plan.saldoPendiente,
      sedeNombre: credit.sede.nombre || "Sin sede",
    };
  });
  const activePortfolio = portfolio.filter((credit) => credit.saldoPendiente > 0);
  const totalPortfolio = activePortfolio.reduce(
    (sum, credit) => sum + credit.saldoPendiente,
    0
  );
  const activePlacedCapital = activePortfolio.reduce(
    (sum, credit) => sum + credit.capitalColocado,
    0
  );
  const healthyBalance = activePortfolio
    .filter((credit) => credit.bucket === "alDia")
    .reduce((sum, credit) => sum + credit.saldoPendiente, 0);
  const earlyBalance = activePortfolio
    .filter((credit) => credit.bucket === "temprana")
    .reduce((sum, credit) => sum + credit.saldoPendiente, 0);
  const criticalPortfolio = activePortfolio.filter((credit) => credit.bucket === "critica");
  const criticalBalance = criticalPortfolio.reduce(
    (sum, credit) => sum + credit.saldoPendiente,
    0
  );
  const earlyClientKeys = new Set(
    activePortfolio
      .filter((credit) => credit.bucket === "temprana")
      .map((credit) => credit.clientKey)
  );
  const dueToday = activePortfolio.reduce((sum, credit) => sum + credit.dueToday, 0);
  const daily = Array.from({ length: daysInMonth }, (_, index) => ({
    day: index + 1,
    creditCount: 0,
    placedCapital: 0,
    recaudo: 0,
  }));
  const performanceByScope = new Map<string, { units: number; value: number }>();

  for (const payment of monthPayments) {
    const day = colombiaDay(payment.fechaAbono);
    const point = daily[day - 1];

    if (point) {
      point.recaudo += Number(payment.valor || 0);
    }
  }

  for (const credit of portfolio) {
    if (credit.fechaCredito >= monthStart && credit.fechaCredito < nextMonthStart) {
      const day = colombiaDay(credit.fechaCredito);
      const point = daily[day - 1];

      if (point) {
        point.creditCount += 1;
        point.placedCapital += credit.capitalColocado;
      }

      const performanceName =
        performanceGroup === "aliado" ? credit.aliadoNombre : credit.sedeNombre;
      const currentPerformance = performanceByScope.get(performanceName) || {
        units: 0,
        value: 0,
      };
      performanceByScope.set(performanceName, {
        units: currentPerformance.units + 1,
        value: currentPerformance.value + credit.capitalColocado,
      });
    }
  }

  const creditPerformance = [...performanceByScope.entries()]
    .map(([name, metrics]) => ({ name, ...metrics }))
    .sort(
      (a, b) =>
        b.value - a.value ||
        b.units - a.units ||
        a.name.localeCompare(b.name, "es")
    );
  const monthlyCollection = monthPayments.reduce(
    (sum, payment) => sum + Number(payment.valor || 0),
    0
  );
  const monthlyCreditCount = daily.reduce(
    (sum, point) => sum + point.creditCount,
    0
  );
  const monthlyPlacedCapital = daily.reduce(
    (sum, point) => sum + point.placedCapital,
    0
  );
  const earlyPercent = ratio(earlyBalance, totalPortfolio);
  const criticalPercent = ratio(criticalBalance, totalPortfolio);
  const criticalCredits = criticalPortfolio.length;

  return {
    activeCredits: activePortfolio.length,
    activePlacedCapital,
    alertsCount: dueToday + earlyClientKeys.size + criticalCredits,
    creditPerformance,
    criticalBalance,
    criticalCredits,
    criticalPercent,
    currentMonthKey: selectedMonth.currentKey,
    daily,
    delinquencyPercent: earlyPercent + criticalPercent,
    dueToday,
    earlyBalance,
    earlyClients: earlyClientKeys.size,
    earlyPercent,
    healthyBalance,
    healthyPercent: ratio(healthyBalance, totalPortfolio),
    monthKey: selectedMonth.key,
    monthLabel: selectedMonth.label,
    monthlyCollection,
    monthlyCreditCount,
    monthlyPaymentCount: monthPayments.length,
    monthlyPlacedCapital,
  };
}
