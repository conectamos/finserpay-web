import Image from "next/image";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Calculator,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  FileText,
  LayoutDashboard,
  Menu,
  PackageCheck,
  Plus,
  ReceiptText,
  Search,
  ShieldCheck,
  Smartphone,
  UserRoundSearch,
  Users,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "./logout-button";

const CLIENT_APP_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.finserpay.clientes";
const CLIENT_APP_QR_PATH = "/downloads/finserpay-clientes-qr.svg";

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
  description: string;
  primary?: boolean;
};

function money(value: number) {
  return `$ ${Math.round(value).toLocaleString("es-CO")}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "America/Bogota",
  }).format(new Date(value));
}

function Navigation({ items }: { items: NavItem[] }) {
  return (
    <nav className="space-y-1">
      <Link
        href="/dashboard"
        aria-current="page"
        className="flex min-h-11 items-center gap-3 rounded-lg bg-[#0b6f6a] px-3 py-2.5 text-sm font-bold text-white"
      >
        <LayoutDashboard className="h-5 w-5 shrink-0" strokeWidth={1.8} />
        Inicio
      </Link>
      {items.map(({ href, icon: Icon, label }) => (
        <Link
          key={`${href}-${label}`}
          href={href}
          className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/8 hover:text-white"
        >
          <Icon className="h-5 w-5 shrink-0" strokeWidth={1.8} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function CommercialSidebar({
  avatarSrc,
  isSupervisor,
  nombre,
}: {
  avatarSrc: string | null;
  isSupervisor: boolean;
  nombre: string;
}) {
  const navItems: NavItem[] = isSupervisor
    ? [
        { href: "/dashboard/creditos", icon: Plus, label: "Nueva venta" },
        { href: "/dashboard/clientes", icon: Users, label: "Clientes" },
        { href: "/dashboard/abonos", icon: CircleDollarSign, label: "Recaudos" },
        { href: "/dashboard/creditos?mode=simulator", icon: Calculator, label: "Simulador" },
        { href: "/dashboard/reportes/creditos", icon: BarChart3, label: "Creditos por fecha" },
        { href: "/dashboard/reportes/abonos", icon: ReceiptText, label: "Abonos por fecha" },
        { href: "/dashboard/pin", icon: ShieldCheck, label: "Cambiar PIN" },
      ]
    : [
        { href: "/dashboard/creditos", icon: Plus, label: "Nueva venta" },
        { href: "/dashboard/creditos?mode=delivery", icon: PackageCheck, label: "Validar entrega" },
        { href: "/dashboard/creditos?mode=simulator", icon: Calculator, label: "Simulador" },
        { href: "/dashboard/pin", icon: ShieldCheck, label: "Cambiar PIN" },
      ];

  return (
    <aside className="bg-[#071827] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-4 lg:block lg:border-0 lg:px-5 lg:py-6">
        <FinserBrand compact dark showTagline={false} />
        <LogoutButton className="!rounded-lg !border-white/15 !px-3 lg:hidden" />
      </div>

      <details className="group border-b border-white/10 lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 text-sm font-bold [&::-webkit-details-marker]:hidden">
          <Menu className="h-5 w-5" strokeWidth={1.8} />
          Modulos comerciales
          <ChevronDown className="ml-auto h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <div className="max-h-[70vh] overflow-y-auto px-3 pb-4 pt-2">
          <Navigation items={navItems} />
        </div>
      </details>

      <div className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-4 lg:block">
        <p className="mb-2 px-3 text-[10px] font-bold uppercase text-slate-500">
          Panel comercial
        </p>
        <Navigation items={navItems} />
      </div>

      <div className="mt-auto hidden border-t border-white/15 px-5 py-5 lg:block">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border border-white/15 bg-white/10">
            {avatarSrc ? (
              <Image src={avatarSrc} alt={nombre} width={40} height={40} className="h-full w-full object-cover" />
            ) : (
              <Smartphone className="h-5 w-5" strokeWidth={1.8} />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-white">{nombre}</p>
            <p className="mt-0.5 text-xs font-semibold uppercase text-[#43c7bd]">
              {isSupervisor ? "Supervisor" : "Vendedor"}
            </p>
          </div>
        </div>
        <LogoutButton className="mt-4 w-full !rounded-lg !border-white/15 !bg-transparent" />
      </div>
    </aside>
  );
}

function MetricCard({
  detail,
  icon: Icon,
  label,
  tone = "teal",
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  tone?: "teal" | "amber" | "slate";
  value: string;
}) {
  const toneClasses = {
    amber: "bg-amber-50 text-amber-700",
    slate: "bg-slate-100 text-slate-700",
    teal: "bg-[#e7f5f3] text-[#087a73]",
  };

  return (
    <article className="rounded-lg border border-[#d9e1e7] bg-white p-4 shadow-[0_5px_18px_rgba(16,24,40,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-bold text-[#667085]">{label}</p>
          <p className="mt-2 text-2xl font-black text-[#101828]">{value}</p>
        </div>
        <span className={["grid h-10 w-10 place-items-center rounded-lg", toneClasses[tone]].join(" ")}>
          <Icon className="h-5 w-5" strokeWidth={1.8} />
        </span>
      </div>
      <p className="mt-2 text-xs text-[#98a2b3]">{detail}</p>
    </article>
  );
}

function ActionCard({
  description,
  href,
  icon: Icon,
  label,
  primary = false,
}: ActionItem) {
  return (
    <Link
      href={href}
      className={[
        "group flex min-h-28 items-start gap-4 rounded-lg border p-4 transition hover:-translate-y-0.5",
        primary
          ? "border-[#087a73] bg-[#087a73] text-white hover:bg-[#06645f]"
          : "border-[#d9e1e7] bg-white text-[#101828] hover:border-[#98a2b3] hover:shadow-[0_8px_22px_rgba(16,24,40,0.06)]",
      ].join(" ")}
    >
      <span
        className={[
          "grid h-10 w-10 shrink-0 place-items-center rounded-lg",
          primary ? "bg-white/15 text-white" : "bg-[#e7f5f3] text-[#087a73]",
        ].join(" ")}
      >
        <Icon className="h-5 w-5" strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-black">{label}</span>
        <span className={[
          "mt-1 block text-xs leading-5",
          primary ? "text-white/75" : "text-[#667085]",
        ].join(" ")}>
          {description}
        </span>
      </span>
    </Link>
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
  const actions: ActionItem[] = isSupervisor
    ? [
        {
          href: "/dashboard/creditos",
          icon: Plus,
          label: "Nueva venta",
          description: "Crear cliente e iniciar credito.",
          primary: true,
        },
        {
          href: "/dashboard/clientes",
          icon: UserRoundSearch,
          label: "Buscar cliente",
          description: "Abrir expediente y documentos.",
        },
        {
          href: "/dashboard/abonos",
          icon: CircleDollarSign,
          label: "Recibir abono",
          description: "Registrar una cuota del cliente.",
        },
        {
          href: "/dashboard/creditos?mode=simulator",
          icon: Calculator,
          label: "Simular credito",
          description: "Calcular inicial, plazo y cuota.",
        },
      ]
    : [
        {
          href: "/dashboard/creditos",
          icon: Plus,
          label: "Nueva venta",
          description: "Crear cliente e iniciar credito.",
          primary: true,
        },
        {
          href: "/dashboard/creditos?mode=delivery",
          icon: PackageCheck,
          label: "Validar entrega",
          description: "Confirmar si el equipo se puede entregar.",
        },
        {
          href: "/dashboard/creditos?mode=simulator",
          icon: Calculator,
          label: "Simular credito",
          description: "Calcular inicial, plazo y cuota.",
        },
      ];

  return (
    <div className="min-h-screen bg-[#f4f7f8] text-[#101828] lg:grid lg:grid-cols-[260px_minmax(0,1fr)]">
      <CommercialSidebar
        avatarSrc={avatarSrc}
        isSupervisor={isSupervisor}
        nombre={nombre}
      />

      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-7 xl:px-8">
        <header className="flex flex-col gap-4 border-b border-[#d9e1e7] pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#087a73]">Panel comercial</p>
            <h1 className="mt-1 text-3xl font-black">Buen dia, {firstName}</h1>
            <p className="mt-1 text-sm text-[#667085]">
              {sedeNombre} | {isSupervisor ? "Supervision de sede" : "Gestion de ventas"}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className="text-sm font-bold text-[#344054]">{nombre}</p>
              <p className="text-xs text-[#667085]">{isSupervisor ? "Supervisor" : "Vendedor"}</p>
            </div>
            <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-lg border border-[#d0d5dd] bg-white">
              {avatarSrc ? (
                <Image src={avatarSrc} alt={nombre} width={48} height={48} className="h-full w-full object-cover" />
              ) : (
                <Smartphone className="h-5 w-5 text-[#087a73]" strokeWidth={1.8} />
              )}
            </span>
          </div>
        </header>

        {debeCambiarPin ? (
          <section className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-black text-amber-900">Actualiza tu PIN inicial</p>
              <p className="mt-1 text-xs text-amber-700">Protege el acceso antes de continuar con la operacion.</p>
            </div>
            <Link href="/dashboard/pin" className="inline-flex h-10 items-center justify-center rounded-lg bg-amber-800 px-4 text-sm font-bold text-white">
              Cambiar PIN
            </Link>
          </section>
        ) : null}

        <section className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            detail={isSupervisor ? "Toda la sede" : "Tus operaciones"}
            icon={FileText}
            label="Creditos hoy"
            value={String(stats.creditosHoy)}
          />
          <MetricCard
            detail="Acumulado del mes"
            icon={BarChart3}
            label="Creditos del mes"
            tone="slate"
            value={String(stats.creditosMes)}
          />
          <MetricCard
            detail="Requieren validacion"
            icon={PackageCheck}
            label="Pendientes de entrega"
            tone="amber"
            value={String(stats.pendientesEntrega)}
          />
          <MetricCard
            detail={isSupervisor ? `${stats.creditosActivos} creditos activos` : "Recaudo asociado al perfil"}
            icon={CircleDollarSign}
            label="Recaudo hoy"
            value={money(stats.abonosHoy)}
          />
        </section>

        {isSupervisor ? (
          <section id="busqueda-rapida" className="mt-5 rounded-lg border border-[#b9ded9] bg-[#eaf7f5] p-4 sm:p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-xs font-bold uppercase text-[#087a73]">Busqueda rapida</p>
                <h2 className="mt-1 text-xl font-black">Abrir expediente de cliente</h2>
              </div>
              <form action="/dashboard/clientes" className="flex w-full flex-col gap-2 sm:flex-row lg:max-w-2xl">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-[#98a2b3]" strokeWidth={1.8} />
                  <input
                    type="text"
                    name="search"
                    aria-label="Buscar cliente"
                    placeholder="Cedula, telefono, folio o IMEI"
                    className="h-11 w-full rounded-lg border border-[#b7c8cd] bg-white pl-11 pr-4 text-sm outline-none transition focus:border-[#087a73] focus:ring-4 focus:ring-[#087a73]/10"
                  />
                </div>
                <button type="submit" className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-[#087a73] px-5 text-sm font-bold text-white hover:bg-[#06645f]">
                  <Search className="h-4 w-4" strokeWidth={2} />
                  Buscar
                </button>
              </form>
            </div>
          </section>
        ) : null}

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_330px]">
          <div className="min-w-0 space-y-7">
            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-black">Acciones rapidas</h2>
                <span className="text-xs font-semibold text-[#667085]">
                  {isSupervisor ? "Operacion de sede" : "Flujo de venta"}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {actions.map((action) => (
                  <ActionCard key={action.label} {...action} />
                ))}
              </div>
            </section>

            <section className="overflow-hidden rounded-lg border border-[#d9e1e7] bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-[#e4e7ec] px-4 py-4 sm:px-5">
                <div>
                  <p className="text-xs font-bold uppercase text-[#087a73]">Actividad reciente</p>
                  <h2 className="mt-1 text-lg font-black">Ultimos creditos</h2>
                </div>
                {isSupervisor ? (
                  <Link href="/dashboard/reportes/creditos" className="text-sm font-bold text-[#087a73] hover:underline">
                    Ver reporte
                  </Link>
                ) : null}
              </div>

              {recentCredits.length ? (
                <div className="overflow-x-auto">
                  <div className="min-w-[720px]">
                    <div className="grid grid-cols-[1.25fr_1fr_0.8fr_0.75fr] gap-4 bg-[#101820] px-5 py-3 text-[11px] font-bold uppercase text-white">
                      <span>Cliente</span>
                      <span>Equipo</span>
                      <span>Estado</span>
                      <span>Fecha</span>
                    </div>
                    <div className="divide-y divide-[#e4e7ec]">
                      {recentCredits.map((credit) => (
                        <div key={credit.id} className="grid grid-cols-[1.25fr_1fr_0.8fr_0.75fr] gap-4 px-5 py-3.5 text-sm">
                          <span className="min-w-0">
                            <span className="block truncate font-bold text-[#101828]">{credit.clienteNombre}</span>
                            <span className="mt-0.5 block truncate text-xs text-[#667085]">{credit.folio}</span>
                          </span>
                          <span className="truncate text-[#475467]">{credit.equipo}</span>
                          <span className="font-semibold text-[#344054]">{credit.listoEntrega ? "Entregable" : credit.estado}</span>
                          <span className="text-xs text-[#667085]">{formatDate(credit.fecha)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex min-h-36 flex-col items-center justify-center px-5 py-8 text-center">
                  <Clock3 className="h-6 w-6 text-[#98a2b3]" strokeWidth={1.7} />
                  <p className="mt-2 text-sm font-bold text-[#475467]">Sin creditos recientes</p>
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-5">
            <section className="rounded-lg border border-[#d9e1e7] bg-white p-5">
              <p className="text-xs font-bold uppercase text-[#087a73]">App de clientes</p>
              <h2 className="mt-1 text-lg font-black">Instalacion y actualizacion</h2>
              <div className="mt-4 flex items-center gap-4">
                <Image
                  src={CLIENT_APP_QR_PATH}
                  alt="QR de FINSER PAY Clientes"
                  width={112}
                  height={112}
                  className="h-28 w-28 rounded-lg border border-[#d9e1e7] bg-white p-1"
                />
                <p className="text-xs leading-5 text-[#667085]">
                  Escanear desde el telefono del cliente al finalizar la venta.
                </p>
              </div>
              <a
                href={CLIENT_APP_PLAY_STORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-[#087a73] text-sm font-bold text-[#087a73] hover:bg-[#eaf7f5]"
              >
                <Smartphone className="h-4 w-4" strokeWidth={1.8} />
                Abrir Google Play
              </a>
            </section>

            <section className="rounded-lg border border-[#d9e1e7] bg-[#101820] p-5 text-white">
              <p className="text-xs font-bold uppercase text-[#55d2c7]">Perfil activo</p>
              <p className="mt-2 text-xl font-black">{isSupervisor ? "Supervisor" : "Vendedor"}</p>
              <p className="mt-2 text-sm text-slate-300">{sedeNombre}</p>
              <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-4 text-xs text-slate-300">
                <ShieldCheck className="h-4 w-4 text-[#55d2c7]" strokeWidth={1.8} />
                Sesion comercial activa
              </div>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
