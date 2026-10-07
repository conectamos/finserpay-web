import type { Prisma } from "@/app/generated/prisma/client";
import { resolveCapitalOriginal } from "@/lib/credit-capital";
import { resolveCreditPaymentSummary } from "@/lib/credit-factory";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { resolveDashboardMonth } from "@/lib/dashboard-month";
import { summarizeDashboardDelinquency, resolveDashboardDelinquencySellerIdentity, type AdminDashboardDelinquencyDetail } from "@/lib/dashboard-delinquency";
import { resolveCreditAssignedAdministrator } from "@/lib/credit-assigned-seller";
import type { DashboardDelinquencyCreditView } from "@/lib/dashboard-delinquency-view";
import prisma from "@/lib/prisma";

import { resolveAllyPaymentPlatform } from "@/lib/ally-payments-core";
import { summarizeProductPortfolioHealth, type PortfolioRiskBucket } from "@/lib/product-portfolio-health";

export type { AdminDashboardDelinquencyDetail, AdminDashboardDelinquencyGroup } from "@/lib/dashboard-delinquency";

export const adminDashboardCreditSelect = {
  contratoSnapshot: true,
  contratoAceptadoAt: true,
  pagareAceptadoAt: true,
  equipoMarca: true,
  clienteDocumento: true,
  clienteNombre: true,
  cuotaInicial: true,
  estado: true,
  fechaCredito: true,
  fechaPrimerPago: true,
  fechaProximoPago: true,
  folio: true,
  frecuenciaPago: true,
  id: true,
  planCapitalVigente: true,
  montoCredito: true,
  pazYSalvoEmitidoAt: true,
  plazoMeses: true,
  saldoBaseFinanciado: true,
  sedeId: true,
  vendedorId: true,
  sede: {
    select: {
      id: true,
      aliado: { select: { id: true, nombre: true } },
      nombre: true,
    },
  },
  vendedor: { select: { id: true, nombre: true, documento: true } },
  usuario: { select: { id: true, nombre: true, usuario: true } },
  valorCuota: true,
  valorEquipoTotal: true,
  valorFianza: true,
  valorInteres: true,
} as const satisfies Prisma.CreditoSelect;

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
  delinquencyDetail: AdminDashboardDelinquencyDetail;
  delinquencyCredits?: DashboardDelinquencyCreditView[];
  productHealth: ReturnType<typeof summarizeProductPortfolioHealth>;
  unclassifiedPortfolioBalance: number;
  activeCredits: number;
  activePlacedCapital: number;
  investedCapital: number;
  closedCredits: number;
  totalCredits: number;
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
  accumulatedCollection: number;
  monthlyCollection: number;
  monthlyCreditCount: number;
  monthlyPaymentCount: number;
  monthlyPlacedCapital: number;
};

type AdminDashboardDataOptions = {
  aliadoId?: number | null;
  month?: string | null;
  includeDelinquencyCredits?: boolean;
};

function daysLate(dueDateIso: string, today: Date) {
  const [year, month, day] = dueDateIso.split("-").map(Number);
  const current = colombiaDateParts(today);
  const due = Date.UTC(year, month - 1, day);
  const base = Date.UTC(current.year, current.month - 1, current.day);

  return Math.max(0, Math.floor((base - due) / 86_400_000));
}

function riskBucket(days: number): PortfolioRiskBucket {
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
  includeDelinquencyCredits = false,
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
      notIn: ["ANULADO", "ANULADA", "CANCELADO", "CANCELADA"],
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

  const [credits, paymentTotals, monthPayments] = await Promise.all([
    prisma.credito.findMany({
      where: creditWhere,
      select: adminDashboardCreditSelect,
    }),
    prisma.creditoAbono.groupBy({
      by: ["creditoId"],
      where: {
        estado: {
          not: "ANULADO",
        },
        credito: {
          ...creditWhere,
        },
        valor: {
          gt: 0,
        },
      },
      _sum: {
        valor: true,
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

  // Imported administrative assignments are only valid before a signature.
  // Read presence for eligible IDs, keeping large signature images out of the
  // dashboard query and never widening the authenticated ally's credit scope.
  const assignmentCandidateIds = credits
    .filter((credit) => resolveCreditAssignedAdministrator(credit))
    .map((credit) => credit.id);
  const signedAssignments = assignmentCandidateIds.length > 0
    ? await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "Credito"
      WHERE "id" = ANY(${assignmentCandidateIds}::int[])
        AND COALESCE("contratoFirmaDataUrl", '') <> ''
    `
    : [];
  const signedAssignmentIds = new Set(signedAssignments.map((credit) => credit.id));

  const paidByCreditId = new Map(
    paymentTotals.map((payment) => [
      payment.creditoId,
      Number(payment._sum.valor || 0),
    ])
  );
  const portfolio = credits.map((credit) => {
    const paymentSummary = resolveCreditPaymentSummary({
      montoCredito: credit.montoCredito,
      totalAbonado: paidByCreditId.get(credit.id) || 0,
    });
    const common = {
      delinquencySource: {
        ...credit,
        contratoFirmaDataUrl: signedAssignmentIds.has(credit.id) ? "PRESENTE" : null,
      },
      fullyPaid: paymentSummary.montoCredito > 0 && Math.round(paymentSummary.saldoPendiente * 100) === 0,
      platform: resolveAllyPaymentPlatform(credit.contratoSnapshot, credit.equipoMarca),
      aliadoNombre: credit.sede.aliado?.nombre || "Sin aliado",
      capitalColocado: resolveCapitalOriginal({
        cuotaInicial: credit.cuotaInicial,
        montoCredito: credit.montoCredito,
        saldoBaseFinanciado: credit.saldoBaseFinanciado,
        valorEquipoTotal: credit.valorEquipoTotal,
        valorFianza: credit.valorFianza,
        valorInteres: credit.valorInteres,
      }),
      clientKey: credit.clienteDocumento || credit.clienteNombre || String(credit.id),
      fechaCredito: credit.fechaCredito,
      sedeNombre: credit.sede.nombre || "Sin sede",
    };

    if (credit.pazYSalvoEmitidoAt) {
      return {
        ...common,
        bucket: "alDia" as const,
        diasMora: 0,
        dueToday: 0,
        saldoPendiente: 0,
      };
    }

    const plan = buildCreditPaymentPlan({
      planCapitalVigente: credit.planCapitalVigente,
      abonos: [{ valor: paidByCreditId.get(credit.id) || 0 }],
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
      ...common,
      bucket: riskBucket(lateDays),
      diasMora: lateDays,
      dueToday: plan.installments.filter(
        (installment) =>
          installment.fechaVencimiento === todayIso && installment.saldoPendiente > 0
      ).length,
      saldoPendiente: plan.saldoPendiente,
    };
  });
  const investedCapital = portfolio.reduce((sum, credit) => sum + credit.capitalColocado, 0);
  const closedCredits = portfolio.filter((credit) => credit.fullyPaid).length;
  const activePortfolio = portfolio.filter((credit) => credit.saldoPendiente > 0);
  const delinquencyDetail = summarizeDashboardDelinquency(activePortfolio.map((credit) => ({
    ...credit.delinquencySource,
    saldoPendiente: credit.saldoPendiente,
    overdue: credit.bucket !== "alDia",
  })));
  const delinquencyCredits: DashboardDelinquencyCreditView[] | undefined = includeDelinquencyCredits
    ? activePortfolio.filter((credit) => credit.bucket !== "alDia").map((credit) => {
      const source = credit.delinquencySource;
      const seller = resolveDashboardDelinquencySellerIdentity({
        ...source,
        saldoPendiente: credit.saldoPendiente,
        overdue: true,
      });
      return {
        id: source.id,
        folio: source.folio,
        clienteNombre: source.clienteNombre,
        clienteDocumento: source.clienteDocumento,
        sedeKey: `sede:${source.sede.id}`,
        sedeNombre: source.sede.nombre,
        sellerKey: seller.key,
        sellerNombre: seller.name,
        aliadoNombre: source.sede.aliado?.nombre || null,
        diasMora: credit.diasMora,
      };
    }).sort((a, b) => b.diasMora - a.diasMora || a.folio.localeCompare(b.folio, "es") || a.id - b.id)
    : undefined;
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
    delinquencyDetail,
    ...(includeDelinquencyCredits ? { delinquencyCredits } : {}),
    productHealth: summarizeProductPortfolioHealth(activePortfolio),
    unclassifiedPortfolioBalance: activePortfolio.filter((credit) => !credit.platform).reduce((sum, credit) => sum + credit.saldoPendiente, 0),
    activeCredits: activePortfolio.length,
    activePlacedCapital,
    investedCapital,
    closedCredits,
    totalCredits: portfolio.length,
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
    accumulatedCollection: credits.reduce((sum, credit) => sum + (paidByCreditId.get(credit.id) || 0), 0),
    monthlyCollection,
    monthlyCreditCount,
    monthlyPaymentCount: monthPayments.length,
    monthlyPlacedCapital,
  };
}
