import type { Prisma } from "@/app/generated/prisma/client";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import prisma from "@/lib/prisma";

type RiskBucket = "alDia" | "temprana" | "critica";

export type AdminDashboardDailyPoint = {
  day: number;
  colocacion: number;
  recaudo: number;
};

export type AdminDashboardSedePoint = {
  name: string;
  value: number;
};

export type AdminDashboardOverview = {
  activeCredits: number;
  activePortfolio: number;
  alertsCount: number;
  criticalCredits: number;
  daily: AdminDashboardDailyPoint[];
  dueToday: number;
  earlyClients: number;
  healthyBalance: number;
  healthyPercent: number;
  criticalBalance: number;
  criticalPercent: number;
  delinquencyPercent: number;
  earlyBalance: number;
  earlyPercent: number;
  monthLabel: string;
  monthlyCollection: number;
  monthlyPaymentCount: number;
  sedes: AdminDashboardSedePoint[];
};

type AdminDashboardDataOptions = {
  aliadoId?: number | null;
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
}: AdminDashboardDataOptions = {}): Promise<AdminDashboardOverview> {
  const today = new Date();
  const current = colombiaDateParts(today);
  const monthStart = new Date(Date.UTC(current.year, current.month - 1, 1, 5));
  const nextMonthStart = new Date(Date.UTC(current.year, current.month, 1, 5));
  const daysInMonth = new Date(current.year, current.month, 0).getDate();
  const todayIso = [
    current.year,
    String(current.month).padStart(2, "0"),
    String(current.day).padStart(2, "0"),
  ].join("-");
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
        fechaCredito: true,
        fechaPrimerPago: true,
        frecuenciaPago: true,
        id: true,
        montoCredito: true,
        plazoMeses: true,
        sede: {
          select: {
            nombre: true,
          },
        },
        valorCuota: true,
      },
    }),
    prisma.creditoAbono.findMany({
      where: paymentWhere,
      select: {
        fechaAbono: true,
        sede: {
          select: {
            nombre: true,
          },
        },
        valor: true,
      },
    }),
  ]);

  const portfolio = credits.map((credit) => {
    const plan = buildCreditPaymentPlan({
      abonos: credit.abonos,
      fechaPrimerPago: credit.fechaPrimerPago,
      frecuenciaPago: credit.frecuenciaPago,
      montoCredito: credit.montoCredito,
      plazoMeses: credit.plazoMeses,
      today,
      valorCuota: credit.valorCuota,
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
      bucket: riskBucket(lateDays),
      clientKey: credit.clienteDocumento || credit.clienteNombre || String(credit.id),
      dueToday: plan.installments.filter(
        (installment) =>
          installment.fechaVencimiento === todayIso && installment.saldoPendiente > 0
      ).length,
      fechaCredito: credit.fechaCredito,
      saldoPendiente: plan.saldoPendiente,
    };
  });
  const activePortfolio = portfolio.filter((credit) => credit.saldoPendiente > 0);
  const totalPortfolio = activePortfolio.reduce(
    (sum, credit) => sum + credit.saldoPendiente,
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
    colocacion: 0,
    recaudo: 0,
  }));

  for (const payment of monthPayments) {
    const day = colombiaDay(payment.fechaAbono);
    const point = daily[day - 1];

    if (point) {
      point.recaudo += Number(payment.valor || 0);
    }
  }

  for (const credit of credits) {
    if (credit.fechaCredito >= monthStart && credit.fechaCredito < nextMonthStart) {
      const day = colombiaDay(credit.fechaCredito);
      const point = daily[day - 1];

      if (point) {
        point.colocacion += Number(credit.montoCredito || 0);
      }
    }
  }

  const collectionBySede = new Map<string, number>();
  for (const payment of monthPayments) {
    const name = payment.sede.nombre || "Sin sede";
    collectionBySede.set(
      name,
      (collectionBySede.get(name) || 0) + Number(payment.valor || 0)
    );
  }

  const sedes = [...collectionBySede.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const monthlyCollection = monthPayments.reduce(
    (sum, payment) => sum + Number(payment.valor || 0),
    0
  );
  const earlyPercent = ratio(earlyBalance, totalPortfolio);
  const criticalPercent = ratio(criticalBalance, totalPortfolio);
  const criticalCredits = criticalPortfolio.length;

  return {
    activeCredits: activePortfolio.length,
    activePortfolio: totalPortfolio,
    alertsCount: dueToday + earlyClientKeys.size + criticalCredits,
    criticalBalance,
    criticalCredits,
    criticalPercent,
    daily,
    delinquencyPercent: earlyPercent + criticalPercent,
    dueToday,
    earlyBalance,
    earlyClients: earlyClientKeys.size,
    earlyPercent,
    healthyBalance,
    healthyPercent: ratio(healthyBalance, totalPortfolio),
    monthLabel: new Intl.DateTimeFormat("es-CO", {
      month: "long",
      timeZone: "America/Bogota",
      year: "numeric",
    }).format(today),
    monthlyCollection,
    monthlyPaymentCount: monthPayments.length,
    sedes,
  };
}
