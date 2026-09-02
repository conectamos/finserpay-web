import Image from "next/image";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bell,
  Calculator,
  ChevronDown,
  CircleDollarSign,
  ClipboardList,
  DollarSign,
  FileText,
  LayoutDashboard,
  Menu,
  Package,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "./logout-button";
import SellerClientAppDialog from "./seller-client-app-dialog";

type RecentCredit = {
  clienteNombre: string;
  equipo: string;
  estado: string;
  fecha: string;
  folio: string;
  id: number;
  listoEntrega: boolean;
};

type SellerDashboardStats = {
  abonosHoy: number;
  creditosActivos: number;
  creditosHoy: number;
  creditosMes: number;
  pendientesEntrega: number;
};

type SellerCommercialDashboardProps = {
  avatarSrc: string | null;
  debeCambiarPin: boolean;
  isSupervisor: boolean;
  nombre: string;
  recentCredits: RecentCredit[];
  sedeNombre: string;
  stats: SellerDashboardStats;
};

type NavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

type ActionItem = NavItem & {
  primary?: boolean;
};

const CORE_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard/creditos", icon: Plus, label: "Nueva venta" },
  { href: "/dashboard/solicitudes", icon: ClipboardList, label: "Solicitudes" },
  { href: "/dashboard/creditos?mode=simulator", icon: Calculator, label: "Simulador" },
  { href: "/dashboard/pin", icon: ShieldCheck, label: "Cambiar PIN" },
];

const SUPERVISOR_NAV_ITEMS: NavItem[] = [
  { href: "/dashboard/clientes", icon: Users, label: "Clientes" },
  { href: "/dashboard/abonos", icon: CircleDollarSign, label: "Recaudos" },
  { href: "/dashboard/reportes/creditos", icon: BarChart3, label: "Cr\u00e9ditos por fecha" },
  { href: "/dashboard/reportes/abonos", icon: ReceiptText, label: "Abonos por fecha" },
];

const QUICK_ACTIONS: ActionItem[] = [
  {
    href: "/dashboard/creditos",
    icon: Plus,
    label: "Nueva venta",
    primary: true,
  },
  {
    href: "/dashboard/solicitudes",
    icon: ClipboardList,
    label: "Retomar solicitud",
  },
  {
    href: "/dashboard/creditos?mode=simulator",
    icon: Calculator,
    label: "Simular cr\u00e9dito",
  },
];

function money(value: number) {
  return `$ ${Math.round(value).toLocaleString("es-CO")}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "America/Bogota",
  }).format(new Date(value));
}

function creditStatus(credit: RecentCredit) {
  const label = credit.listoEntrega ? "Entregable" : credit.estado.replaceAll("_", " ");
  const normalized = label.toUpperCase();

  if (/ANUL|RECHAZ|ERROR/.test(normalized)) {
    return { label, className: "border-red-200 bg-red-50 text-red-700" };
  }

  if (/PEND|PROCES|REVISION|BORRADOR/.test(normalized)) {
    return { label, className: "border-amber-200 bg-amber-50 text-amber-800" };
  }

  if (/ENTREG|APROB|GENERAD|PAGAD|ACTIV/.test(normalized)) {
    return {
      label,
      className:
        "border-[color-mix(in_srgb,var(--fp-lime-strong)_35%,white)] bg-[var(--fp-lime-soft)] text-[var(--fp-lime-strong)]",
    };
  }

  return {
    label,
    className: "border-[var(--fp-border)] bg-[var(--fp-bg)] text-[var(--fp-muted)]",
  };
}

function Navigation({ activeHref, items }: { activeHref: string; items: NavItem[] }) {
  return (
    <nav className="space-y-1" aria-label="Navegacion comercial">
      {items.map(({ href, icon: Icon, label }) => {
        const active = href === activeHref;
        return (
          <Link
            key={`${href}-${label}`}
            href={href}
            aria-current={active ? "page" : undefined}
            className={[
              "relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]",
              active
                ? "bg-white/10 text-white before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--fp-lime)]"
                : "text-white/70 hover:bg-white/[0.06] hover:text-white",
            ].join(" ")}
          >
            <Icon className="h-[19px] w-[19px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function CommercialSidebar({
  activeHref = "/dashboard",
  avatarSrc,
  isSupervisor,
  nombre,
}: {
  activeHref?: string;
  avatarSrc: string | null;
  isSupervisor: boolean;
  nombre: string;
}) {
  const primaryItems: NavItem[] = [
    { href: "/dashboard", icon: LayoutDashboard, label: "Inicio" },
    ...CORE_NAV_ITEMS,
  ];

  return (
    <aside className="bg-[#0d1112] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
      <div className="flex min-h-20 items-center justify-between border-b border-white/10 px-4 lg:border-0 lg:px-5">
        <FinserBrand mini dark accentPay plainMark showTagline={false} />
        <LogoutButton
          showIcon
          className="!min-h-11 !rounded-md !border-white/15 !bg-transparent !px-3 lg:hidden"
        />
      </div>

      <details className="group border-b border-white/10 lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <Menu className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden="true" />
          Menu comercial
          <ChevronDown className="ml-auto h-[18px] w-[18px] transition group-open:rotate-180" strokeWidth={1.8} />
        </summary>
        <div className="max-h-[70vh] overflow-y-auto px-3 pb-4 pt-2">
          <Navigation activeHref={activeHref} items={primaryItems} />
          {isSupervisor ? (
            <div className="mt-4 border-t border-white/10 pt-4">
              <p className="mb-2 px-3 text-[10px] font-semibold uppercase text-white/45">Supervisi&oacute;n</p>
              <Navigation activeHref={activeHref} items={SUPERVISOR_NAV_ITEMS} />
            </div>
          ) : null}
        </div>
      </details>

      <div className="hidden min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 pt-8 lg:block">
        <p className="mb-3 px-3 text-[10px] font-semibold uppercase text-white/45">Principal</p>
        <Navigation activeHref={activeHref} items={primaryItems} />

        {isSupervisor ? (
          <div className="mt-5 border-t border-white/10 pt-4">
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase text-white/45">
              Supervisi&oacute;n
            </p>
            <Navigation activeHref={activeHref} items={SUPERVISOR_NAV_ITEMS} />
          </div>
        ) : null}
      </div>

      <div className="mt-auto hidden border-t border-white/15 px-4 py-5 lg:block">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-white/15 bg-white/[0.06]">
            {avatarSrc ? (
              <Image src={avatarSrc} alt={nombre} width={44} height={44} className="h-full w-full object-cover" />
            ) : (
              <UserRound className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{nombre}</p>
            <p className="mt-0.5 text-[11px] font-medium uppercase text-[var(--fp-lime)]">
              {isSupervisor ? "Supervisor" : "Vendedor"}
            </p>
          </div>
        </div>
        <LogoutButton
          showIcon
          className="mt-4 min-h-11 w-full !rounded-md !border-white/15 !bg-transparent"
        />
      </div>
    </aside>
  );
}

function MetricStrip({
  isSupervisor,
  stats,
}: {
  isSupervisor: boolean;
  stats: SellerDashboardStats;
}) {
  const metrics = [
    {
      detail: isSupervisor ? "Toda la sede" : "Tus operaciones",
      icon: FileText,
      label: "Cr\u00e9ditos hoy",
      value: String(stats.creditosHoy),
    },
    {
      detail: "Acumulado del mes",
      icon: BarChart3,
      label: "Cr\u00e9ditos del mes",
      value: String(stats.creditosMes),
    },
    {
      detail: "Requieren validaci\u00f3n",
      icon: Package,
      label: "Pendientes de entrega",
      value: String(stats.pendientesEntrega),
    },
    {
      detail: "Asociado al perfil",
      icon: DollarSign,
      label: "Recaudo hoy",
      value: money(stats.abonosHoy),
    },
  ];

  const responsiveBorders = [
    "border-t-0",
    "border-l border-t-0",
    "border-t xl:border-l xl:border-t-0",
    "border-l border-t xl:border-t-0",
  ];

  return (
    <section
      className="mt-6 grid grid-cols-2 overflow-hidden border-y border-[var(--fp-border)] bg-white xl:grid-cols-4"
      aria-label="Indicadores comerciales"
    >
      {metrics.map(({ detail, icon: Icon, label, value }, index) => (
        <article
          key={label}
          className={`border-t border-[var(--fp-border)] px-5 py-5 ${responsiveBorders[index]}`}
        >
          <div className="flex items-center gap-3 text-sm text-[var(--fp-muted)]">
            <Icon className="h-[19px] w-[19px] text-[var(--fp-graphite)]" strokeWidth={1.8} aria-hidden="true" />
            <span>{label}</span>
          </div>
          <p className="mt-3 text-2xl font-semibold text-[var(--fp-graphite)]">{value}</p>
          <p className="mt-1 text-xs text-[var(--fp-muted)]">{detail}</p>
        </article>
      ))}
    </section>
  );
}

function QuickActions() {
  return (
    <section className="mt-7" aria-labelledby="quick-actions-title">
      <h2 id="quick-actions-title" className="text-lg font-semibold">
        Acciones r&aacute;pidas
      </h2>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {QUICK_ACTIONS.map(({ href, icon: Icon, label, primary }) => (
          <Link
            key={label}
            href={href}
            className={[
              "inline-flex min-h-11 items-center justify-center gap-2 rounded-md border px-5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)] focus-visible:ring-offset-2 sm:min-w-52",
              primary
                ? "border-[var(--fp-graphite)] bg-[var(--fp-graphite)] text-white hover:bg-black"
                : "border-[var(--fp-border)] bg-white text-[var(--fp-graphite)] hover:border-[var(--fp-muted)]",
            ].join(" ")}
          >
            <Icon
              className={primary ? "h-[19px] w-[19px] text-[var(--fp-lime)]" : "h-[19px] w-[19px]"}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            {label}
          </Link>
        ))}
      </div>
    </section>
  );
}

function RecentCreditsTable({
  isSupervisor,
  recentCredits,
}: {
  isSupervisor: boolean;
  recentCredits: RecentCredit[];
}) {
  const allCreditsHref = isSupervisor ? "/dashboard/reportes/creditos" : "/dashboard/solicitudes";

  return (
    <section className="mt-7 border border-[var(--fp-border)] bg-white" aria-labelledby="recent-credits-title">
      <div className="flex items-end justify-between gap-4 border-b border-[var(--fp-border)] px-5 py-5 sm:px-7">
        <div>
          <p className="text-xs font-semibold uppercase text-[var(--fp-lime-strong)]">Actividad reciente</p>
          <h2 id="recent-credits-title" className="mt-1 text-xl font-semibold">
            &Uacute;ltimos cr&eacute;ditos
          </h2>
        </div>
        <Link
          href={allCreditsHref}
          className="min-h-11 py-3 text-sm font-semibold underline decoration-[var(--fp-lime-strong)] underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime-strong)]"
        >
          Ver todas
        </Link>
      </div>

      {recentCredits.length ? (
        <>
          <div className="divide-y divide-[var(--fp-border)] sm:hidden">
            {recentCredits.map((credit) => {
              const status = creditStatus(credit);
              return (
                <article key={credit.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--fp-graphite)]">
                        {credit.clienteNombre}
                      </p>
                      <p className="mt-1 truncate text-xs text-[var(--fp-muted)]">{credit.folio}</p>
                    </div>
                    <span
                      className={`inline-flex shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3 text-xs">
                    <p className="min-w-0 truncate text-[var(--fp-graphite)]">{credit.equipo}</p>
                    <time className="shrink-0 whitespace-nowrap text-[var(--fp-muted)]">
                      {formatDate(credit.fecha)}
                    </time>
                  </div>
                </article>
              );
            })}
          </div>

          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--fp-border)] text-xs font-medium uppercase text-[var(--fp-muted)]">
                <th scope="col" className="px-5 py-3 sm:px-7">Cliente</th>
                <th scope="col" className="px-5 py-3">Equipo</th>
                <th scope="col" className="px-5 py-3">Estado</th>
                <th scope="col" className="px-5 py-3 sm:pr-7">Fecha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--fp-border)]">
              {recentCredits.map((credit) => {
                const status = creditStatus(credit);
                return (
                  <tr key={credit.id} className="transition hover:bg-[var(--fp-bg)]">
                    <td className="px-5 py-4 sm:px-7">
                      <span className="block max-w-[300px] truncate text-sm font-semibold text-[var(--fp-graphite)]">
                        {credit.clienteNombre}
                      </span>
                      <span className="mt-1 block max-w-[300px] truncate text-xs text-[var(--fp-muted)]">
                        {credit.folio}
                      </span>
                    </td>
                    <td className="max-w-[260px] truncate px-5 py-4 text-sm text-[var(--fp-graphite)]">
                      {credit.equipo}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`inline-flex rounded-md border px-2 py-1 text-[11px] font-semibold uppercase ${status.className}`}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-[var(--fp-muted)] sm:pr-7">
                      {formatDate(credit.fecha)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="flex min-h-44 flex-col items-center justify-center px-5 py-10 text-center">
          <ClipboardList className="h-6 w-6 text-[var(--fp-muted)]" strokeWidth={1.8} aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-[var(--fp-graphite)]">Sin cr&eacute;ditos recientes</p>
          <p className="mt-1 text-xs text-[var(--fp-muted)]">Las ventas recientes apareceran en este espacio.</p>
        </div>
      )}
    </section>
  );
}

export default function SellerCommercialDashboard({
  avatarSrc,
  debeCambiarPin,
  isSupervisor,
  nombre,
  recentCredits,
  sedeNombre,
  stats,
}: SellerCommercialDashboardProps) {
  const firstName = nombre.split(" ")[0] || nombre;

  return (
    <div className="min-h-screen bg-[var(--fp-bg)] text-[var(--fp-graphite)] lg:grid lg:grid-cols-[236px_minmax(0,1fr)]">
      <CommercialSidebar avatarSrc={avatarSrc} isSupervisor={isSupervisor} nombre={nombre} />

      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8 lg:py-8 xl:px-10">
        <header className="flex flex-col gap-5 border-b border-[var(--fp-border)] pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase text-[var(--fp-muted)]">
              PANEL COMERCIAL &middot; {sedeNombre}
            </p>
            <h1 className="mt-1 text-3xl font-semibold sm:text-4xl">Buen d&iacute;a, {firstName}</h1>
            <p className="mt-1 text-sm text-[var(--fp-muted)]">Gesti&oacute;n de ventas</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <SellerClientAppDialog />
            <span
              className="grid h-11 w-11 place-items-center border-l border-[var(--fp-border)] text-[var(--fp-graphite)]"
              role="img"
              aria-label="Notificaciones"
            >
              <Bell className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden="true" />
            </span>
            <div className="flex min-h-11 items-center gap-3 border-l border-[var(--fp-border)] pl-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--fp-border)] bg-white">
                {avatarSrc ? (
                  <Image src={avatarSrc} alt={nombre} width={40} height={40} className="h-full w-full object-cover" />
                ) : (
                  <UserRound className="h-[19px] w-[19px]" strokeWidth={1.8} aria-hidden="true" />
                )}
              </span>
              <div className="hidden min-w-0 md:block">
                <p className="max-w-48 truncate text-sm font-semibold">{nombre}</p>
                <p className="text-xs text-[var(--fp-muted)]">{isSupervisor ? "Supervisor" : "Vendedor"}</p>
              </div>
            </div>
          </div>
        </header>

        {debeCambiarPin ? (
          <section className="mt-5 flex flex-col gap-3 border border-amber-300 bg-amber-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-950">Actualiza tu PIN inicial</p>
              <p className="mt-1 text-xs text-amber-800">Protege el acceso antes de continuar con la operaci&oacute;n.</p>
            </div>
            <Link
              href="/dashboard/pin"
              className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--fp-graphite)] px-4 text-sm font-semibold text-white"
            >
              Cambiar PIN
            </Link>
          </section>
        ) : null}

        <MetricStrip isSupervisor={isSupervisor} stats={stats} />
        <QuickActions />

        {isSupervisor ? (
          <section className="mt-7 flex flex-col gap-3 border-y border-[var(--fp-border)] py-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <p className="text-sm font-semibold">Buscar expediente</p>
              <p className="mt-0.5 text-xs text-[var(--fp-muted)]">Consulta por c&eacute;dula, tel&eacute;fono, folio o IMEI.</p>
            </div>
            <form action="/dashboard/clientes" className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-2xl">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-[var(--fp-muted)]" strokeWidth={1.8} aria-hidden="true" />
                <input
                  type="text"
                  name="search"
                  aria-label="Buscar cliente"
                  placeholder="Cedula, telefono, folio o IMEI"
                  className="h-11 w-full rounded-md border border-[var(--fp-border)] bg-white pl-11 pr-4 text-sm outline-none transition focus:border-[var(--fp-lime-strong)] focus:ring-2 focus:ring-[var(--fp-lime)]/30"
                />
              </div>
              <button
                type="submit"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-[var(--fp-graphite)] px-5 text-sm font-semibold text-white hover:bg-black"
              >
                <Search className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
                Buscar
              </button>
            </form>
          </section>
        ) : null}

        <RecentCreditsTable isSupervisor={isSupervisor} recentCredits={recentCredits} />
      </main>
    </div>
  );
}
