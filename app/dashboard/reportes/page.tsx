import Link from "next/link";
import type { Prisma } from "@/app/generated/prisma/client";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  CircleDollarSign,
  CreditCard,
  FileSpreadsheet,
  Filter,
  Monitor,
  PieChart,
  RotateCcw,
  Search,
  Store,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import {
  AppShell,
  Card,
  EmptyState,
  Input,
  MetricCard,
  PageHeader,
  Select,
} from "@/app/_components/finser-ui";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";
import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { requireAdminOrSupervisorDashboardAccess } from "@/lib/dashboard-access";
import prisma from "@/lib/prisma";

type SearchParams = Promise<{
  period?: string | string[];
  q?: string | string[];
  sedeId?: string | string[];
}>;

type PeriodKey = "month" | "previous-month" | "quarter" | "year" | "all";
type ReportPermission = "all" | "admin" | "central";
type ReportKind = "credits" | "payments" | "portfolio" | "stores" | "sellers";

type ReportDefinition = {
  category: string;
  description: string;
  formats: string[];
  href: string;
  icon: LucideIcon;
  kind: ReportKind;
  permission: ReportPermission;
  title: string;
};

const REPORTS: ReportDefinition[] = [
  {
    category: "Operacion",
    description: "Consulta creditos, saldos, estados y fechas de apertura.",
    formats: ["Excel"],
    href: "/dashboard/reportes/creditos",
    icon: CreditCard,
    kind: "credits",
    permission: "all",
    title: "Creditos",
  },
  {
    category: "Recaudos",
    description: "Revisa pagos registrados, recaudo por periodo y saldos pendientes.",
    formats: ["Excel"],
    href: "/dashboard/reportes/abonos",
    icon: CircleDollarSign,
    kind: "payments",
    permission: "all",
    title: "Abonos",
  },
  {
    category: "Riesgo",
    description: "Analiza cartera activa, edades de mora y nivel de riesgo.",
    formats: ["Excel"],
    href: "/dashboard/cartera",
    icon: PieChart,
    kind: "portfolio",
    permission: "central",
    title: "Cartera",
  },
  {
    category: "Sedes",
    description: "Consulta y administra los puntos de venta autorizados.",
    formats: ["Vista web"],
    href: "/dashboard/sedes",
    icon: Store,
    kind: "stores",
    permission: "admin",
    title: "Puntos de venta",
  },
  {
    category: "Equipo",
    description: "Consulta usuarios vendedores y su sede asignada.",
    formats: ["Vista web"],
    href: "/dashboard/usuarios",
    icon: UserRound,
    kind: "sellers",
    permission: "admin",
    title: "Vendedores",
  },
];

const PERIOD_OPTIONS: Array<{ label: string; value: PeriodKey }> = [
  { label: "Este mes", value: "month" },
  { label: "Mes anterior", value: "previous-month" },
  { label: "Este trimestre", value: "quarter" },
  { label: "Este ano", value: "year" },
  { label: "Todo el historial", value: "all" },
];

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  maximumFractionDigits: 0,
  style: "currency",
});

const compactMoneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  maximumFractionDigits: 1,
  notation: "compact",
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

function previousPeriodRange(range: { from: Date | null; to: Date | null }) {
  if (!range.from || !range.to) {
    return null;
  }

  const duration = range.to.getTime() - range.from.getTime() + 1;
  const to = new Date(range.from.getTime() - 1);
  return { from: new Date(to.getTime() - duration + 1), to };
}

function ymd(value: Date | null) {
  if (!value) return "";
  const { day, month, year } = bogotaDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function compactMoney(value: number) {
  return compactMoneyFormatter.format(Number(value || 0));
}

function percent(value: number) {
  return `${percentFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function ratio(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0;
}

function daysLate(dueDateIso: string, today: Date) {
  const due = new Date(`${dueDateIso}T12:00:00`);
  const current = new Date(today);
  current.setHours(12, 0, 0, 0);
  return Math.max(0, Math.floor((current.getTime() - due.getTime()) / 86_400_000));
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

function ReportPreview({
  kind,
  riskDistribution,
}: {
  kind: ReportKind;
  riskDistribution: Array<{ label: string; value: number }>;
}) {
  if (kind === "portfolio") {
    return (
      <div className="space-y-2 bg-[#f8fafb] px-3 py-3" aria-label="Distribucion real de la cartera">
        {riskDistribution.map((item, index) => (
          <div key={item.label} className="grid grid-cols-[72px_minmax(0,1fr)_42px] items-center gap-2 text-[11px] text-[#667085]">
            <span>{item.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-[#e4e7ec]">
              <span
                className={index === 0 ? "block h-full bg-[#7ca613]" : index === 3 ? "block h-full bg-[#d92d20]" : "block h-full bg-[#e9a22b]"}
                style={{ width: `${Math.min(100, item.value)}%` }}
              />
            </span>
            <strong className="text-right text-[#344054]">{percent(item.value)}</strong>
          </div>
        ))}
      </div>
    );
  }

  if (kind === "stores" || kind === "sellers") {
    return (
      <div className="grid grid-cols-3 gap-3 bg-[#f8fafb] px-3 py-4" aria-hidden="true">
        {[62, 84, 48].map((width, index) => (
          <span key={`${kind}-${width}-${index}`} className="space-y-2">
            <span className="block h-7 w-7 rounded-full bg-[#e8ecf0]" />
            <span className="block h-2 rounded-full bg-[#dfe4e9]" style={{ width: `${width}%` }} />
            <span className="block h-2 w-full rounded-full bg-[#eef1f4]" />
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="bg-[#f8fafb] px-3 py-3" aria-hidden="true">
      <div className="grid grid-cols-4 gap-3 border-b border-[#d8dee5] pb-2 text-[10px] font-bold text-[#667085]">
        <span>{kind === "credits" ? "Credito" : "Fecha"}</span>
        <span>Cliente</span>
        <span>{kind === "credits" ? "Saldo" : "Pago"}</span>
        <span>Estado</span>
      </div>
      <div className="mt-2 space-y-2">
        {[78, 62].map((width) => (
          <span key={width} className="grid grid-cols-4 gap-3">
            {[width, 70, 55, 64].map((cell, index) => (
              <span key={`${width}-${cell}-${index}`} className="h-2 rounded-full bg-[#dfe4e9]" style={{ width: `${cell}%` }} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
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
  const previousRange = previousPeriodRange(range);
  const creditWhere: Prisma.CreditoWhereInput = {
    sedeId: { in: scopeSedeIds },
  };
  const paymentScope: Prisma.CreditoAbonoWhereInput = {
    estado: { not: "ANULADO" },
    sedeId: { in: scopeSedeIds },
    credito: { estado: { not: "ANULADO" } },
  };

  const [credits, currentPayments, previousPayments] = await Promise.all([
    prisma.credito.findMany({
      where: creditWhere,
      select: {
        abonos: {
          where: { estado: { not: "ANULADO" } },
          select: { fechaAbono: true, valor: true },
          orderBy: { fechaAbono: "asc" },
        },
        estado: true,
        fechaPrimerPago: true,
        frecuenciaPago: true,
        id: true,
        montoCredito: true,
        plazoMeses: true,
        valorCuota: true,
      },
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
    previousRange
      ? prisma.creditoAbono.aggregate({
          where: {
            ...paymentScope,
            fechaAbono: { gte: previousRange.from, lte: previousRange.to },
          },
          _sum: { valor: true },
        })
      : Promise.resolve({ _sum: { valor: null } }),
  ]);

  const riskBalances = { current: 0, early: 0, medium: 0, advanced: 0 };
  let activeCredits = 0;
  let portfolioBalance = 0;
  let overdueBalance = 0;
  const today = new Date();

  for (const credit of credits) {
    if (isAnnulled(credit.estado)) continue;

    const plan = buildCreditPaymentPlan({
      abonos: credit.abonos,
      fechaPrimerPago: credit.fechaPrimerPago,
      frecuenciaPago: credit.frecuenciaPago,
      montoCredito: credit.montoCredito,
      plazoMeses: credit.plazoMeses,
      today,
      valorCuota: credit.valorCuota,
    });

    if (plan.saldoPendiente <= 0) continue;

    activeCredits += 1;
    portfolioBalance += plan.saldoPendiente;
    const overdue = plan.installments.filter(
      (installment) => installment.estaEnMora && installment.saldoPendiente > 0
    );
    overdueBalance += overdue.reduce((sum, installment) => sum + installment.saldoPendiente, 0);
    const maxDays = overdue.reduce(
      (max, installment) => Math.max(max, daysLate(installment.fechaVencimiento, today)),
      0
    );

    if (maxDays <= 0) riskBalances.current += plan.saldoPendiente;
    else if (maxDays <= 15) riskBalances.early += plan.saldoPendiente;
    else if (maxDays <= 30) riskBalances.medium += plan.saldoPendiente;
    else riskBalances.advanced += plan.saldoPendiente;
  }

  const collected = Number(currentPayments._sum.valor || 0);
  const previouslyCollected = Number(previousPayments._sum.valor || 0);
  const collectionTrend = previouslyCollected > 0
    ? ((collected - previouslyCollected) / previouslyCollected) * 100
    : null;
  const moraPercent = ratio(overdueBalance, portfolioBalance);
  const riskDistribution = [
    { label: "Al dia", value: ratio(riskBalances.current, portfolioBalance) },
    { label: "1-15 dias", value: ratio(riskBalances.early, portfolioBalance) },
    { label: "16-30 dias", value: ratio(riskBalances.medium, portfolioBalance) },
    { label: "30+ dias", value: ratio(riskBalances.advanced, portfolioBalance) },
  ];
  const availableReports = REPORTS.filter((report) => canOpenReport(report, admin, adminCentral));
  const normalizedQuery = query.toLocaleLowerCase("es-CO");
  const visibleReports = normalizedQuery
    ? availableReports.filter((report) =>
        [report.title, report.description, report.category]
          .join(" ")
          .toLocaleLowerCase("es-CO")
          .includes(normalizedQuery)
      )
    : availableReports;
  const reportParams = new URLSearchParams();

  if (range.from) reportParams.set("from", ymd(range.from));
  if (range.to) reportParams.set("to", ymd(range.to));
  if (selectedSede) reportParams.set("sedeId", String(selectedSede.id));

  return (
    <AppShell
      sidebar={
        <AdminSidebar
          activeHref="/dashboard/reportes"
          adminCentral={adminCentral}
          nombreUsuario={session.nombre}
          rolUsuario={session.rolNombre}
        />
      }
    >
      <AdminWorkspaceTopbar
        parent="Administracion"
        current="Reportes"
        userName={session.nombre}
        userRole={session.rolNombre}
      />

      <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
        <PageHeader
          eyebrow="Analisis y control"
          title="Centro de reportes"
          description="Consulta, filtra y exporta la informacion de toda la operacion."
          actions={
            <Link href="/dashboard" className="fp-ui-button is-secondary">
              <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              Volver al panel
            </Link>
          }
        />

        <Card className="mt-4 !rounded-lg !p-3">
          <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_minmax(240px,1.3fr)_auto_auto]" action="/dashboard/reportes">
            <label className="relative">
              <span className="sr-only">Periodo</span>
              <CalendarDays className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
              <Select name="period" defaultValue={period} className="!pl-10">
                {PERIOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </label>

            <label className="relative">
              <span className="sr-only">Sede</span>
              <Building2 className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
              <Select name="sedeId" defaultValue={selectedSede ? String(selectedSede.id) : ""} className="!pl-10">
                {admin ? <option value="">Todas las sedes autorizadas</option> : null}
                {sedes.map((sede) => (
                  <option key={sede.id} value={sede.id}>{sede.nombre}</option>
                ))}
              </Select>
            </label>

            <label className="relative" title="El credito actual no almacena una plataforma consultable para reportes.">
              <span className="sr-only">Plataforma</span>
              <Monitor className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#98a2b3]" strokeWidth={1.8} />
              <Select disabled className="!pl-10" aria-describedby="platform-filter-note">
                <option>Todas las plataformas</option>
              </Select>
            </label>

            <label className="relative">
              <span className="sr-only">Buscar reporte</span>
              <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
              <Input name="q" defaultValue={query} placeholder="Buscar reporte..." className="!pl-10" />
            </label>

            <button type="submit" className="fp-ui-button is-primary whitespace-nowrap">
              <Filter className="h-4 w-4" strokeWidth={1.8} />
              Aplicar
            </button>
            <Link href="/dashboard/reportes" className="fp-ui-button is-secondary whitespace-nowrap">
              <RotateCcw className="h-4 w-4" strokeWidth={1.8} />
              Limpiar
            </Link>
          </form>
          <p id="platform-filter-note" className="mt-2 px-1 text-xs text-[#667085]">
            Plataforma quedara disponible cuando el dato forme parte del modelo consultable de creditos.
          </p>
        </Card>

        <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            className="!rounded-lg !p-5"
            label={<span className="flex items-center gap-2" title="Creditos no anulados con saldo pendiente dentro de las sedes autorizadas."><CreditCard className="h-4 w-4 text-[#5c7a13]" /> Creditos activos</span>}
            value={<span className="!text-3xl">{activeCredits}</span>}
            detail={selectedSede?.nombre || `${scopeSedeIds.length} sedes autorizadas`}
          />
          <MetricCard
            className="!rounded-lg !p-5"
            label={<span className="flex items-center gap-2" title="Suma de abonos activos registrados dentro del periodo y alcance seleccionados."><CircleDollarSign className="h-4 w-4 text-[#5c7a13]" /> Recaudado en el periodo</span>}
            value={<span className="!text-3xl" title={money(collected)}>{compactMoney(collected)}</span>}
            detail={collectionTrend === null ? "Sin base comparable" : `${collectionTrend >= 0 ? "+" : ""}${percent(collectionTrend)} vs. periodo anterior`}
          />
          <MetricCard
            className="!rounded-lg !p-5"
            label={<span className="flex items-center gap-2" title="Saldo pendiente actual de los creditos no anulados dentro del alcance seleccionado."><PieChart className="h-4 w-4 text-[#5c7a13]" /> Saldo de cartera</span>}
            value={<span className="!text-3xl" title={money(portfolioBalance)}>{compactMoney(portfolioBalance)}</span>}
            detail="Saldo actual por cobrar"
          />
          <MetricCard
            className="!rounded-lg !border-amber-200 !bg-[#fffaf0] !p-5"
            label={<span className="flex items-center gap-2" title="Porcentaje del saldo pendiente correspondiente a cuotas vencidas."><TriangleAlert className="h-4 w-4 text-[#b86b10]" /> Mora actual</span>}
            value={<span className="!text-3xl text-[#b86b10]">{percent(moraPercent)}</span>}
            detail={`${money(overdueBalance)} en cuotas vencidas`}
          />
        </section>

        <div className="mt-6 flex items-center gap-3">
          <h2 className="text-lg font-black text-[#151a21]">Reportes disponibles</h2>
          <span className="rounded-full bg-[#eef1f4] px-2.5 py-1 text-xs font-bold text-[#667085]">{visibleReports.length} reportes</span>
        </div>

        {visibleReports.length ? (
          <section className="mt-3 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleReports.map((report) => {
              const Icon = report.icon;
              return (
                <Card key={report.href} className="group flex min-h-[238px] flex-col overflow-hidden !rounded-lg !shadow-[0_5px_18px_rgba(16,24,40,0.05)] transition hover:-translate-y-0.5 hover:!shadow-[0_12px_26px_rgba(16,24,40,0.09)]">
                  <div className="flex items-start gap-4 px-5 pt-5">
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-[#eef1f4] text-[#344054]">
                      <Icon className="h-6 w-6" strokeWidth={1.7} />
                    </span>
                    <div className="min-w-0">
                      <h3 className="text-lg font-black text-[#151a21]">{report.title}</h3>
                      <p className="mt-1 min-h-10 text-sm leading-5 text-[#667085]">{report.description}</p>
                    </div>
                  </div>
                  <div className="mt-4 px-5">
                    <div className="flex items-center justify-between gap-3 text-[11px] font-black uppercase">
                      <span className="text-[#5c7a13]">{report.category}</span>
                      <span className="text-[#667085]">{report.formats.join(" · ")}</span>
                    </div>
                    <div className="mt-3 overflow-hidden rounded-md">
                      <ReportPreview kind={report.kind} riskDistribution={riskDistribution} />
                    </div>
                  </div>
                  <Link
                    href={buildReportHref(report, reportParams)}
                    className="mt-auto inline-flex min-h-11 items-center gap-2 border-t border-[#e4e7ec] px-5 text-sm font-black text-[#315f18] transition group-hover:bg-[#fbfdf5]"
                  >
                    Abrir reporte
                    <ArrowRight className="h-4 w-4" strokeWidth={2} />
                  </Link>
                </Card>
              );
            })}

            <Card className="flex min-h-[238px] flex-col !rounded-lg !p-5">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-[#f2f9df] text-[#4f6f0c]">
                  <FileSpreadsheet className="h-5 w-5" strokeWidth={1.8} />
                </span>
                <div>
                  <h3 className="text-lg font-black text-[#151a21]">Formatos disponibles</h3>
                  <p className="mt-0.5 text-xs text-[#667085]">No existe historial de exportaciones.</p>
                </div>
              </div>
              <div className="mt-5 divide-y divide-[#e4e7ec] border-y border-[#e4e7ec]">
                {["Creditos", "Abonos", "Cartera"].filter((title) => availableReports.some((report) => report.title === title)).map((title) => (
                  <div key={title} className="flex min-h-11 items-center justify-between gap-3 text-sm">
                    <span className="font-bold text-[#344054]">{title}</span>
                    <span className="font-semibold text-[#667085]">Excel</span>
                  </div>
                ))}
              </div>
              <p className="mt-auto pt-4 text-xs leading-5 text-[#667085]">
                Las exportaciones se generan desde cada reporte con los filtros aplicados.
              </p>
            </Card>
          </section>
        ) : (
          <EmptyState
            className="mt-3 bg-white"
            title="No encontramos reportes"
            description="Cambia el texto de busqueda o limpia los filtros para volver a ver los modulos disponibles."
            action={<Link href="/dashboard/reportes" className="fp-ui-button is-secondary mt-2">Limpiar filtros</Link>}
          />
        )}

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-[#d6e4fb] bg-[#f5f8ff] px-4 py-3 text-xs leading-5 text-[#475467]">
          <BarChart3 className="mt-0.5 h-4 w-4 shrink-0 text-[#4169a1]" strokeWidth={1.8} />
          Los indicadores usan la informacion disponible al abrir esta pantalla. El periodo se aplica al recaudo; saldo y mora muestran la cartera actual del alcance seleccionado.
        </div>
      </main>
    </AppShell>
  );
}
