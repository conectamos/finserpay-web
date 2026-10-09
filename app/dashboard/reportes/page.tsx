import type {Prisma} from "@/app/generated/prisma/client";
import FinserNavigation from "@/app/dashboard/_components/finser-navigation";
import {isFinserPayCentralAlly} from "@/lib/aliados";
import {buildCreditPaymentPlan} from "@/lib/credit-payment-plan";
import {requireAdminOrSupervisorDashboardAccess} from "@/lib/dashboard-access";
import prisma from "@/lib/prisma";
import ReportCenter from "./report-center";
import styles from "./report-center.module.css";

type SearchParams = Promise<{
  period?: string | string[];
  q?: string | string[];
  sedeId?: string | string[];
}>;

type PeriodKey = "month" | "previous-month" | "quarter" | "year" | "all";
type ReportPermission = "all" | "admin" | "central";
type ReportKind =
  | "credits"
  | "payments"
  | "portfolio"
  | "stores"
  | "sellers"
  | "datacredito-sales";

type ReportDefinition = {
  category: string;
  description: string;
  formats: string[];
  href: string;
  kind: ReportKind;
  permission: ReportPermission;
  title: string;
};

const REPORTS: ReportDefinition[] = [
  {
    category: "Operacion",
    description: "Ventas y financiación autorizada.",
    formats: ["Excel"],
    href: "/dashboard/reportes/creditos",
    kind: "credits",
    permission: "all",
    title: "Créditos",
  },
  {
    category: "Recaudos",
    description: "Pagos registrados y resumen diario.",
    formats: ["Excel"],
    href: "/dashboard/reportes/abonos",
    kind: "payments",
    permission: "all",
    title: "Recaudos",
  },
  {
    category: "Riesgo",
    description: "Saldos y edades de mora.",
    formats: ["Excel"],
    href: "/dashboard/cartera",
    kind: "portfolio",
    permission: "admin",
    title: "Cartera",
  },
  {
    category: "Riesgo",
    description:
      "Aprobaciones, rechazos, ventas y rankings por aliado, sede y vendedor.",
    formats: ["Excel", "PDF", "Vista web"],
    href: "/dashboard/reportes/datacredito-ventas",
    kind: "datacredito-sales",
    permission: "central",
    title: "DataCrédito vs. ventas",
  },
  {
    category: "Sedes",
    description: "Sedes y comercios autorizados.",
    formats: ["Vista web"],
    href: "/dashboard/sedes",
    kind: "stores",
    permission: "admin",
    title: "Puntos de venta",
  },
  {
    category: "Equipo",
    description: "Asesores y sedes asignadas.",
    formats: ["Vista web"],
    href: "/dashboard/usuarios",
    kind: "sellers",
    permission: "admin",
    title: "Vendedores",
  },
];

const PERIOD_OPTIONS: Array<{ label: string; value: PeriodKey }> = [
  { label: "Este mes", value: "month" },
  { label: "Mes anterior", value: "previous-month" },
  { label: "Este trimestre", value: "quarter" },
  { label: "Este año", value: "year" },
  { label: "Todo el historial", value: "all" },
];

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 20,
  style: "currency",
});


const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 1,
});

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePositiveInt(value: unknown) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isAnnulled(value: string | null | undefined) {
  return String(value || "").toUpperCase().includes("ANUL");
}

function bogotaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
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

function bogotaDay(year: number, month: number, day: number, endOfDay = false) {
  const start = Date.UTC(year, month - 1, day) + 5 * 60 * 60 * 1000;
  return new Date(endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start);
}

function periodRange(period: PeriodKey, now: Date) {
  if (period === "all") {
    return { from: null, to: null };
  }

  const { day, month, year } = bogotaDateParts(now);
  const to = bogotaDay(year, month, day, true);

  if (period === "month") {
    return { from: bogotaDay(year, month, 1), to };
  }

  if (period === "previous-month") {
    const currentMonth = bogotaDay(year, month, 1);
    const previousDay = new Date(currentMonth.getTime() - 1);
    const previousParts = bogotaDateParts(previousDay);
    return {
      from: bogotaDay(previousParts.year, previousParts.month, 1),
      to: previousDay,
    };
  }

  if (period === "quarter") {
    const quarterMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return { from: bogotaDay(year, quarterMonth, 1), to };
  }

  return { from: bogotaDay(year, 1, 1), to };
}


function ymd(value: Date | null) {
  if (!value) return "";
  const { day, month, year } = bogotaDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}


function money(value: number) {
  return moneyFormatter.format(Number(value || 0));
}


function percent(value: number) {
  return `${percentFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function ratio(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0;
}


function canOpenReport(report: ReportDefinition, admin: boolean, central: boolean) {
  if (report.permission === "central") return central;
  if (report.permission === "admin") return admin;
  return true;
}

function buildReportHref(report: ReportDefinition, query: URLSearchParams) {
  if (report.kind !== "credits" && report.kind !== "payments") {
    return report.href;
  }

  const suffix = query.toString();
  return suffix ? `${report.href}?${suffix}` : report.href;
}

export const metadata = {
  title: "Centro de reportes | FINSER PAY",
  description: "Consulta operativa de creditos, abonos, cartera, sedes y vendedores",
};

export default async function ReportesAdminPage({ searchParams }: { searchParams: SearchParams }) {
  const { admin, session } = await requireAdminOrSupervisorDashboardAccess();
  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const params = await searchParams;
  const requestedPeriod = firstValue(params.period);
  const period = PERIOD_OPTIONS.some((option) => option.value === requestedPeriod)
    ? (requestedPeriod as PeriodKey)
    : "month";
  const query = String(firstValue(params.q) || "").trim().slice(0, 80);
  const requestedSedeId = parsePositiveInt(firstValue(params.sedeId));
  const aliadoScopeId = Number(session.aliadoAccesoId || 0);

  const sedeWhere: Prisma.SedeWhereInput = admin
    ? adminCentral
      ? {}
      : { aliadoId: Number.isInteger(aliadoScopeId) && aliadoScopeId > 0 ? aliadoScopeId : -1 }
    : { id: session.sedeId };
  const sedes = await prisma.sede.findMany({
    where: sedeWhere,
    select: { id: true, nombre: true },
    orderBy: { nombre: "asc" },
  });
  const selectedSede = requestedSedeId
    ? sedes.find((sede) => sede.id === requestedSedeId) || null
    : null;
  const scopeSedeIds = selectedSede ? [selectedSede.id] : sedes.map((sede) => sede.id);
  const range = periodRange(period, new Date());
  const creditWhere: Prisma.CreditoWhereInput = {
    sedeId: { in: scopeSedeIds },
    pazYSalvoEmitidoAt: null,
  };
  const paymentScope: Prisma.CreditoAbonoWhereInput = {
    estado: { not: "ANULADO" },
    sedeId: { in: scopeSedeIds },
    credito: { estado: { not: "ANULADO" } },
  };

  const [credits, paymentTotals, currentPayments] = await Promise.all([
    prisma.credito.findMany({
      where: creditWhere,
      select: {
        estado: true,
        fechaPrimerPago: true,
        fechaProximoPago: true,
        frecuenciaPago: true,
        id: true,
        planCapitalVigente: true,
        montoCredito: true,
        pazYSalvoEmitidoAt: true,
        plazoMeses: true,
        valorCuota: true,
      },
    }),
    prisma.creditoAbono.groupBy({
      by: ["creditoId"],
      where: {
        estado: { not: "ANULADO" },
        credito: {
          ...creditWhere,
          estado: { not: "ANULADO" },
        },
        valor: { gt: 0 },
      },
      _sum: { valor: true },
    }),
    prisma.creditoAbono.aggregate({
      where: {
        ...paymentScope,
        ...(range.from && range.to
          ? { fechaAbono: { gte: range.from, lte: range.to } }
          : {}),
      },
      _sum: { valor: true },
    }),
  ]);

  const paidByCreditId = new Map(
    paymentTotals.map((payment) => [
      payment.creditoId,
      Number(payment._sum.valor || 0),
    ])
  );
  let activeCredits = 0;
  let portfolioBalance = 0;
  let overdueBalance = 0;
  const today = new Date();

  for (const credit of credits) {
    if (isAnnulled(credit.estado)) continue;

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

    if (plan.saldoPendiente <= 0) continue;

    activeCredits += 1;
    portfolioBalance += plan.saldoPendiente;
    const overdue = plan.installments.filter(
      (installment) => installment.estaEnMora && installment.saldoPendiente > 0
    );
    overdueBalance += overdue.reduce((sum, installment) => sum + installment.saldoPendiente, 0);
  }

  const collected = Number(currentPayments._sum.valor || 0);
  const moraPercent = ratio(overdueBalance, portfolioBalance);
  const availableReports = REPORTS.filter((report) => canOpenReport(report, admin, adminCentral));
  const reportParams = new URLSearchParams();

  if (range.from) reportParams.set("from", ymd(range.from));
  if (range.to) reportParams.set("to", ymd(range.to));
  if (selectedSede) reportParams.set("sedeId", String(selectedSede.id));

  return <div className={styles.shell}>
    <FinserNavigation variant="requests" activeSection={admin?"administration":"operation"} admin={admin} adminCentral={adminCentral} isSupervisor={!admin} nombreUsuario={session.nombre} rolUsuario={session.rolNombre}/>
    <main className={styles.main}><ReportCenter period={period} selectedSedeId={selectedSede?String(selectedSede.id):""} sedes={sedes} admin={admin} initialQuery={query} reports={availableReports.map(report=>({...report,href:buildReportHref(report,reportParams)}))} metrics={{activeCredits:activeCredits.toLocaleString("es-CO"),collected:money(collected),portfolioBalance:money(portfolioBalance),mora:percent(moraPercent)}}/></main>
  </div>;
}
