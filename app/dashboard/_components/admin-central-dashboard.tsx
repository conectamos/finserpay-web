import type { ComponentType } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  Banknote,
  BarChart3,
  Bell,
  CalendarClock,
  Calculator,
  ChevronRight,
  CircleCheck,
  CreditCard,
  Equal,
  Files,
  Flag,
  MapPin,
  Plus,
  RadioTower,
  Search,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  WalletCards,
} from "lucide-react";
import type { AdminDashboardOverview } from "../_lib/admin-dashboard-data";
import AdminSidebar from "./admin-sidebar";
import DashboardMonthSelector from "./dashboard-month-selector";

type IconType = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

type AdminCentralDashboardProps = {
  adminCentral: boolean;
  aliadoNombre: string;
  data: AdminDashboardOverview;
  nombreUsuario: string;
  rolUsuario: string;
  sedeLabel: string;
};

type MetricCardProps = {
  detail: string;
  icon: IconType;
  label: string;
  tone: "teal" | "green" | "red";
  value: string;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  maximumFractionDigits: 0,
  style: "currency",
});

const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function percent(value: number) {
  return `${percentFormatter.format(Number.isFinite(value) ? value : 0)}%`;
}

function compactMoney(value: number) {
  const amount = Math.abs(Number(value || 0));

  if (amount >= 1_000_000_000) {
    return `$ ${percentFormatter.format(amount / 1_000_000_000)} mil M`;
  }

  if (amount >= 1_000_000) {
    return `$ ${percentFormatter.format(amount / 1_000_000)} M`;
  }

  if (amount >= 1_000) {
    return `$ ${percentFormatter.format(amount / 1_000)} mil`;
  }

  return money(amount);
}

function titleCase(value: string) {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function chartMaximum(value: number) {
  const amount = Math.max(1, Number(value || 0) * 1.08);
  const magnitude = 10 ** Math.floor(Math.log10(amount));
  const normalized = amount / magnitude;
  const ceiling =
    normalized <= 1
      ? 1
      : normalized <= 2
        ? 2
        : normalized <= 2.5
          ? 2.5
          : normalized <= 5
            ? 5
            : normalized <= 7.5
              ? 7.5
              : 10;

  return ceiling * magnitude;
}

function MetricCard({ detail, icon: Icon, label, tone, value }: MetricCardProps) {
  const tones = {
    green: {
      icon: "bg-emerald-50 text-emerald-700",
      value: "text-emerald-700",
    },
    red: {
      icon: "bg-red-50 text-red-600",
      value: "text-red-600",
    },
    teal: {
      icon: "bg-teal-50 text-teal-700",
      value: "text-[#111827]",
    },
  }[tone];

  return (
    <article className="min-w-0 rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-3">
        <span className={["flex h-10 w-10 shrink-0 items-center justify-center rounded-full", tones.icon].join(" ")}>
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </span>
        <p className="min-w-0 text-sm font-medium text-[#344054]">{label}</p>
      </div>
      <p className={["mt-4 whitespace-nowrap text-2xl font-black leading-none 2xl:text-[26px]", tones.value].join(" ")}>
        {value}
      </p>
      <p className="mt-3 text-xs font-medium leading-5 text-[#667085]">{detail}</p>
    </article>
  );
}

function CollectionChart({
  overview,
}: {
  overview: AdminDashboardOverview;
}) {
  const data = overview.daily;
  const width = 780;
  const height = 270;
  const top = 18;
  const bottom = 226;
  const left = 76;
  const right = 766;
  const plotHeight = bottom - top;
  const plotWidth = right - left;
  const maxValue = chartMaximum(
    Math.max(1, ...data.flatMap((point) => [point.placedCapital, point.recaudo]))
  );
  const step = data.length > 1 ? plotWidth / (data.length - 1) : plotWidth;
  const barWidth = Math.max(6, Math.min(13, step * 0.54));
  const linePoints = data
    .map((point, index) => {
      const x = left + index * step;
      const y = bottom - (point.recaudo / maxValue) * plotHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const ticks = data.filter(
    (point) => point.day === 1 || point.day % 5 === 0 || point.day === data.length
  );
  const monthShort = titleCase(overview.monthLabel.slice(0, 3));
  const yAxisTicks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div>
      <div className="grid grid-cols-2 border-y border-[#e4e9ef] sm:grid-cols-4">
        {[
          {
            label: "Ventas del mes",
            value: String(overview.monthlyCreditCount),
          },
          {
            label: "Capital colocado",
            value: money(overview.monthlyPlacedCapital),
          },
          {
            label: "Recaudo del mes",
            value: money(overview.monthlyCollection),
          },
          {
            label: "Abonos registrados",
            value: String(overview.monthlyPaymentCount),
          },
        ].map((metric, index) => (
          <div
            key={metric.label}
            className={[
              "min-w-0 px-3 py-3",
              index % 2 === 1 ? "border-l border-[#e4e9ef]" : "",
              index >= 2 ? "border-t border-[#e4e9ef] sm:border-t-0" : "",
              index >= 1 ? "sm:border-l sm:border-[#e4e9ef]" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <span className="block text-[11px] font-bold uppercase text-[#667085]">
              {metric.label}
            </span>
            <strong className="mt-1 block whitespace-nowrap text-base font-black tabular-nums text-[#101828] 2xl:text-lg">
              {metric.value}
            </strong>
          </div>
        ))}
      </div>

      <div className="mb-2 mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-semibold text-[#475467]">
        <span className="inline-flex items-center gap-2">
          <span className="h-3 w-5 rounded-sm bg-[#0b213f]" />
          Capital colocado
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-0.5 w-6 bg-[#78a016]" />
          Recaudo diario
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="grid h-5 w-5 place-items-center border border-[#cbd5df] bg-white text-[10px] font-black text-[#0b213f]">
            #
          </span>
          Ventas del dia
        </span>
      </div>

      <div className="min-h-[270px] w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-auto min-h-[250px] w-full"
          role="img"
          aria-label={`${overview.monthlyCreditCount} ventas, ${money(
            overview.monthlyPlacedCapital
          )} de capital colocado y ${money(overview.monthlyCollection)} recaudados en ${
            overview.monthLabel
          }`}
        >
          {yAxisTicks.map((ratioValue) => {
            const y = bottom - ratioValue * plotHeight;
            return (
              <g key={ratioValue}>
                <line
                  x1={left}
                  x2={right}
                  y1={y}
                  y2={y}
                  stroke="#e4e9ef"
                  strokeWidth="1"
                />
                <text
                  x={left - 10}
                  y={y + 4}
                  fill="#667085"
                  fontSize="10"
                  fontWeight="600"
                  textAnchor="end"
                >
                  {compactMoney(maxValue * ratioValue)}
                </text>
              </g>
            );
          })}

          {data.map((point, index) => {
            const barHeight = (point.placedCapital / maxValue) * plotHeight;
            const x = left + index * step - barWidth / 2;

            return (
              <g key={`bar-${point.day}`}>
                <rect
                  x={x}
                  y={bottom - barHeight}
                  width={barWidth}
                  height={barHeight}
                  rx="2"
                  fill="#0b213f"
                >
                  <title>
                    {`${point.day} ${monthShort}: ${point.creditCount} ${
                      point.creditCount === 1 ? "venta" : "ventas"
                    }, ${money(point.placedCapital)} de capital colocado`}
                  </title>
                </rect>
                {point.creditCount > 0 ? (
                  <text
                    x={x + barWidth / 2}
                    y={Math.max(11, bottom - barHeight - 6)}
                    fill="#0b213f"
                    fontSize="10"
                    fontWeight="800"
                    textAnchor="middle"
                  >
                    {point.creditCount}
                  </text>
                ) : null}
              </g>
            );
          })}

          <polyline
            points={linePoints}
            fill="none"
            stroke="#78a016"
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {data.map((point, index) => {
            const x = left + index * step;
            const y = bottom - (point.recaudo / maxValue) * plotHeight;

            return (
              <circle
                key={`point-${point.day}`}
                cx={x}
                cy={y}
                r={point.recaudo > 0 ? "4" : "2.5"}
                fill="#78a016"
                stroke="white"
                strokeWidth="1.5"
              >
                <title>{`${point.day} ${monthShort}: ${money(point.recaudo)} recaudados`}</title>
              </circle>
            );
          })}

          {ticks.map((point) => {
            const index = data.indexOf(point);
            const x = left + index * step;

            return (
              <text
                key={`tick-${point.day}`}
                x={x}
                y={252}
                fill="#667085"
                fontSize="10"
                fontWeight="600"
                textAnchor="middle"
              >
                {point.day} {monthShort}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function HealthPanel({ data }: { data: AdminDashboardOverview }) {
  const healthy = Math.max(0, Math.min(100, data.healthyPercent));
  const earlyEnd = Math.max(healthy, Math.min(100, healthy + data.earlyPercent));
  const background = `conic-gradient(#0d9488 0% ${healthy}%, #f2ad1f ${healthy}% ${earlyEnd}%, #ef4444 ${earlyEnd}% 100%)`;

  return (
    <section className="rounded-lg border border-[#d8dee6] bg-white p-5 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
      <h2 className="text-xl font-black text-[#101828]">Salud de cartera</h2>
      <div className="mt-5 grid gap-6 sm:grid-cols-[210px_1fr] sm:items-center">
        <div className="relative mx-auto h-48 w-48 rounded-full" style={{ background }}>
          <div className="absolute inset-10 flex flex-col items-center justify-center rounded-full bg-white text-center shadow-[inset_0_0_0_1px_#e4e9ef]">
            <strong className="text-3xl font-black text-[#101828]">{percent(data.healthyPercent)}</strong>
            <span className="mt-1 text-xs font-semibold text-[#667085]">Al dia</span>
          </div>
        </div>

        <div className="space-y-4">
          {[
            { color: "bg-[#0d9488]", label: "Al dia", value: data.healthyPercent },
            { color: "bg-[#f2ad1f]", label: "Mora temprana", value: data.earlyPercent },
            { color: "bg-[#ef4444]", label: "Mora critica", value: data.criticalPercent },
          ].map((item) => (
            <div key={item.label} className="grid grid-cols-[12px_1fr_auto] items-center gap-3">
              <span className={["h-3 w-3 rounded-full", item.color].join(" ")} />
              <span className="text-sm font-medium text-[#475467]">{item.label}</span>
              <strong className="text-sm font-black text-[#101828]">{percent(item.value)}</strong>
            </div>
          ))}
          <div className="border-t border-[#e4e9ef] pt-4 text-sm font-bold text-[#0f766e]">
            Distribucion del saldo pendiente
          </div>
        </div>
      </div>
    </section>
  );
}

function ActionLink({ href, icon: Icon, label }: { href: string; icon: IconType; label: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-16 items-center gap-3 rounded-lg border border-[#dfe4ea] bg-white px-3 py-3 text-sm font-bold text-[#101828] transition hover:border-[#0d9488] hover:bg-[#f5fbfa]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#087a73] text-white">
        <Icon className="h-5 w-5" strokeWidth={2} />
      </span>
      <span>{label}</span>
    </Link>
  );
}

export default function AdminCentralDashboard({
  adminCentral,
  aliadoNombre,
  data,
  nombreUsuario,
  rolUsuario,
  sedeLabel,
}: AdminCentralDashboardProps) {
  const scopeLabel = adminCentral ? "Todas las sedes" : aliadoNombre;
  const carteraHref = adminCentral ? "/dashboard/cartera" : "/dashboard/abonos";
  const performanceScopeLabel = adminCentral ? "aliado" : "sede";
  const maxPerformanceValue = Math.max(
    1,
    ...data.creditPerformance.map((item) => item.value)
  );
  const metricCards: MetricCardProps[] = [
    {
      detail: `Capital colocado en ${data.activeCredits} creditos activos`,
      icon: WalletCards,
      label: "Cartera activa",
      tone: "teal",
      value: money(data.activePlacedCapital),
    },
    {
      detail: "Creditos vigentes con saldo",
      icon: CreditCard,
      label: "Creditos activos",
      tone: "teal",
      value: String(data.activeCredits),
    },
    {
      detail: `${data.monthlyPaymentCount} recaudos en ${data.monthLabel}`,
      icon: Banknote,
      label: "Recaudo del mes",
      tone: "teal",
      value: money(data.monthlyCollection),
    },
    {
      detail: `${compactMoney(data.healthyBalance)} sin mora`,
      icon: CircleCheck,
      label: "Cartera al dia",
      tone: "green",
      value: percent(data.healthyPercent),
    },
    {
      detail: `${compactMoney(data.earlyBalance + data.criticalBalance)} en seguimiento`,
      icon: TriangleAlert,
      label: "Mora",
      tone: "red",
      value: percent(data.delinquencyPercent),
    },
  ];

  return (
    <div className="min-h-screen bg-[#f4f7f8] text-[#101828] lg:grid lg:grid-cols-[250px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard"
        adminCentral={adminCentral}
        nombreUsuario={nombreUsuario}
        rolUsuario={rolUsuario}
      />

      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-7 xl:px-8">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h1 className="text-3xl font-black text-[#101828]">
              {adminCentral ? "Panel central" : "Panel aliado"}
            </h1>
            <p className="mt-1 text-sm text-[#667085]">Resumen financiero y operativo</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#d0d7e0] bg-white px-3 text-sm font-semibold text-[#344054]">
              <MapPin className="h-5 w-5" strokeWidth={1.8} />
              <span className="max-w-40 truncate">{scopeLabel || sedeLabel}</span>
            </div>
            <DashboardMonthSelector
              key={data.monthKey}
              currentMonth={data.currentMonthKey}
              label={titleCase(data.monthLabel)}
              selectedMonth={data.monthKey}
            />
            <Link
              href={carteraHref}
              aria-label={`${data.alertsCount} alertas de cartera`}
              className="relative flex h-11 w-11 items-center justify-center rounded-lg border border-[#d0d7e0] bg-white text-[#344054] transition hover:border-[#0d9488] hover:text-[#0d766f]"
            >
              <Bell className="h-5 w-5" strokeWidth={1.8} />
              {data.alertsCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#087a73] px-1 text-[10px] font-black text-white">
                  {data.alertsCount > 99 ? "99+" : data.alertsCount}
                </span>
              )}
            </Link>
            <div className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#d0d7e0] bg-white px-2.5 pr-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#087a73] text-white">
                <UserRound className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <span className="max-w-32 truncate text-sm font-semibold text-[#344054]">
                {nombreUsuario}
              </span>
            </div>
          </div>
        </header>

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {metricCards.map((metric) => (
            <MetricCard key={metric.label} {...metric} />
          ))}
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <section className="min-w-0 rounded-lg border border-[#d8dee6] bg-white p-5 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <h2 className="text-xl font-black text-[#101828]">Recaudo y capital colocado</h2>
            <p className="mt-1 text-sm text-[#667085]">
              Capital financiado y recaudo diario de {titleCase(data.monthLabel)}.
            </p>
            <div className="mt-5">
              <CollectionChart overview={data} />
            </div>
          </section>
          <HealthPanel data={data} />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[0.95fr_1.1fr_1fr]">
          <section className="rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <h2 className="text-lg font-black text-[#101828]">Alertas de cartera</h2>
            <div className="mt-3 space-y-2">
              {[
                {
                  color: "bg-red-50 text-red-600",
                  count: data.dueToday,
                  icon: CalendarClock,
                  label: "cuotas vencen hoy",
                },
                {
                  color: "bg-amber-50 text-amber-600",
                  count: data.earlyClients,
                  icon: UserRound,
                  label: "clientes con mora temprana",
                },
                {
                  color: "bg-red-50 text-red-600",
                  count: data.criticalCredits,
                  icon: Flag,
                  label: "creditos requieren prioridad",
                },
              ].map((alert) => {
                const AlertIcon = alert.icon;
                return (
                  <div
                    key={alert.label}
                    className="grid grid-cols-[38px_1fr_auto] items-center gap-3 rounded-lg border border-[#e4e9ef] px-2.5 py-2"
                  >
                    <span className={["flex h-9 w-9 items-center justify-center rounded-full", alert.color].join(" ")}>
                      <AlertIcon className="h-4.5 w-4.5" strokeWidth={2} />
                    </span>
                    <p className="text-sm text-[#344054]">
                      <strong className="font-black text-[#101828]">{alert.count}</strong> {alert.label}
                    </p>
                    <Link
                      href={carteraHref}
                      className="rounded-md border border-[#d8dee6] px-2.5 py-1.5 text-xs font-bold text-[#344054] transition hover:border-[#0d9488] hover:text-[#0d766f]"
                    >
                      Gestionar
                    </Link>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <h2 className="text-lg font-black text-[#101828]">
              Rendimiento por {performanceScopeLabel}
            </h2>
            <p className="mt-1 text-xs text-[#667085]">
              Capital colocado y unidades de credito en {titleCase(data.monthLabel)}
            </p>
            <div className="mt-4 max-h-48 space-y-3 overflow-y-auto pr-1">
              {data.creditPerformance.length ? (
                data.creditPerformance.map((performance) => (
                  <div
                    key={performance.name}
                    className="space-y-1.5"
                    aria-label={`${performance.name}: ${performance.units} ${
                      performance.units === 1 ? "credito" : "creditos"
                    }, ${money(performance.value)} de capital colocado`}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                      <span
                        className="truncate text-xs font-semibold text-[#475467]"
                        title={performance.name}
                      >
                        {performance.name}
                      </span>
                      <span className="text-right">
                        <strong className="block text-xs font-black tabular-nums text-[#101828]">
                          {compactMoney(performance.value)}
                        </strong>
                        <span className="block text-[11px] font-semibold text-[#667085]">
                          {performance.units}{" "}
                          {performance.units === 1 ? "credito" : "creditos"}
                        </span>
                      </span>
                    </div>
                    <span className="block h-2 overflow-hidden rounded-sm bg-[#edf1f4]">
                      <span
                        className="block h-full rounded-sm bg-[#101828]"
                        style={{
                          width:
                            performance.value > 0
                              ? `${Math.max(
                                  3,
                                  (performance.value / maxPerformanceValue) * 100
                                )}%`
                              : "0%",
                        }}
                      />
                    </span>
                  </div>
                ))
              ) : (
                <p className="rounded-lg bg-[#f7f9fb] px-3 py-7 text-center text-sm font-medium text-[#667085]">
                  Aun no hay creditos colocados este mes.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <h2 className="text-lg font-black text-[#101828]">Acciones rapidas</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-2">
              <ActionLink href="/dashboard/creditos" icon={Plus} label="Nuevo credito" />
              {adminCentral ? (
                <ActionLink
                  href="/dashboard/creditos?mode=simulator"
                  icon={Calculator}
                  label="Simular credito"
                />
              ) : null}
              <ActionLink href="/dashboard/abonos" icon={ArrowDownToLine} label="Recibir abono" />
              <ActionLink href="/dashboard/clientes" icon={Search} label="Buscar usuario" />
              {adminCentral ? (
                <>
                  <ActionLink href="/dashboard/creditos-masivos" icon={Files} label="Creditos masivos" />
                  <ActionLink
                    href="/dashboard/excepciones-mora"
                    icon={TriangleAlert}
                    label="Excepciones por mora"
                  />
                </>
              ) : (
                <ActionLink href="/dashboard/reportes" icon={BarChart3} label="Ver reportes" />
              )}
            </div>
          </section>
        </section>

        {adminCentral && (
          <section className="mt-4 rounded-lg border border-[#d8dee6] bg-white p-4 shadow-[0_4px_14px_rgba(15,23,42,0.05)]">
            <div className="grid gap-3 lg:grid-cols-[240px_repeat(3,minmax(0,1fr))] lg:items-center">
              <div>
                <h2 className="text-lg font-black text-[#101828]">Integraciones</h2>
                <p className="mt-1 text-xs text-[#667085]">Acceso a servicios conectados</p>
              </div>
              {[
                { icon: ShieldCheck, label: "Trustonic", status: "Abrir", href: "/dashboard/integraciones" },
                { icon: Equal, label: "Equality", status: "Abrir", href: "/dashboard/equality" },
                { icon: RadioTower, label: "Estado remoto", status: "Consultar", href: "/dashboard/integraciones" },
              ].map((integration) => {
                const IntegrationIcon = integration.icon;
                return (
                  <Link
                    key={integration.label}
                    href={integration.href}
                    className="flex min-h-14 items-center gap-3 rounded-lg border border-[#cce4e1] bg-[#f7fbfa] px-4 transition hover:border-[#0d9488]"
                  >
                    <IntegrationIcon className="h-5 w-5 text-[#0b213f]" strokeWidth={1.8} />
                    <span className="text-sm font-bold text-[#344054]">{integration.label}</span>
                    <span className="ml-auto inline-flex items-center gap-2 text-xs font-bold text-[#16865f]">
                      {integration.status}
                      <ChevronRight className="h-4 w-4" />
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
