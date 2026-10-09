import type { ComponentType } from "react";
import Link from "next/link";
import {
  BarChart3,
  Calculator,
  ChevronDown,
  CircleDollarSign,
  Coins,
  ClipboardList,
  Equal,
  FilePenLine,
  FileSearch,
  FileText,
  Files,
  Handshake,
  LayoutDashboard,
  MapPin,
  Menu,
  PieChart,
  Plug,
  RefreshCcw,
  Settings,
  ShieldBan,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  UserRound,
  Users,
  WalletCards,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { isAdminRole, isApprovalAnalystRole } from "@/lib/roles";
import LogoutButton from "./logout-button";

type IconType = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

type NavItem = {
  href: string;
  icon: IconType;
  label: string;
  children?: NavItem[];
};

type NavGroup = {
  items: NavItem[];
  label: string;
};

type AdminSidebarProps = {
  activeHref: string;
  adminCentral: boolean;
  nombreUsuario: string;
  rolUsuario: string;
};

function isNavItemActive(item: NavItem, activeHref: string): boolean {
  return activeHref === item.href
    || activeHref.startsWith(`${item.href}/`)
    || Boolean(item.children?.some((child) => isNavItemActive(child, activeHref)));
}

function SidebarLink({
  activeHref,
  href,
  icon: Icon,
  label,
}: NavItem & { activeHref: string }) {
  const active = href === activeHref;

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "flex min-h-11 shrink-0 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition",
        active
          ? "relative bg-white/10 text-[#dafa70] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-[#b7e63d]"
          : "text-slate-300 hover:bg-white/8 hover:text-white",
      ].join(" ")}
    >
      <Icon className="h-5 w-5 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 whitespace-normal leading-5">{label}</span>
    </Link>
  );
}

function SidebarNavigation({
  activeHref,
  groups,
}: {
  activeHref: string;
  groups: NavGroup[];
}) {
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label}>
          <p className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
            {group.label}
          </p>
          <div className="space-y-1">
            {group.items.map((item) => item.children ? (
              <details key={item.href} open={isNavItemActive(item, activeHref)} className="group/cartera">
                <summary className={`flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold [&::-webkit-details-marker]:hidden ${isNavItemActive(item, activeHref) ? "bg-white/10 text-[var(--fp-lime)]" : "text-slate-300 hover:bg-white/8 hover:text-white"}`}>
                  <item.icon className="h-5 w-5 shrink-0" strokeWidth={1.8} />
                  {item.label}
                  <ChevronDown className="ml-auto h-4 w-4 transition group-open/cartera:rotate-180" />
                </summary>
                <div className="mt-1 space-y-1 pl-5">
                  {item.children.map((child) => <SidebarLink key={child.href} activeHref={activeHref} {...child} />)}
                </div>
              </details>
            ) : (
              <SidebarLink key={item.href} activeHref={activeHref} {...item} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default function AdminSidebar({
  activeHref,
  adminCentral,
  nombreUsuario,
  rolUsuario,
}: AdminSidebarProps) {
  const analystNavigation = isApprovalAnalystRole(rolUsuario);
  const portfolioNavigation = activeHref === "/dashboard/cartera"
    || activeHref.startsWith("/dashboard/cartera/")
    || activeHref === "/dashboard/riesgo-referencia";
  const navGroups: NavGroup[] = analystNavigation ? [
    {
      label: "Aprobaciones",
      items: [
        { href: "/dashboard/aprobaciones", icon: LayoutDashboard, label: "Aprobaciones" },
        { href: "/dashboard/aprobaciones/solicitudes", icon: ClipboardList, label: "Solicitudes" },
        { href: "/dashboard/aprobaciones/cambio-imei", icon: Smartphone, label: "Cambio de IMEI" },
        { href: "/dashboard/aprobaciones/enrolamiento", icon: ShieldCheck, label: "Enrolamiento iPhone" },
        { href: "/dashboard/aprobaciones/firma-seguro", icon: FilePenLine, label: "Gestionar firma" },
        { href: "/dashboard/aprobaciones/liberar-consulta", icon: RefreshCcw, label: "Liberar consulta" },
        { href: "/dashboard/aprobaciones/sadmin", icon: Files, label: "Creación Sadmin" },
        { href: "/dashboard/aprobaciones/excepciones-mora", icon: TriangleAlert, label: "Excepciones de mora" },
        { href: "/dashboard/aprobaciones/cartera-mora", icon: PieChart, label: "Cartera en mora" },
      ],
    },
  ] : [
    {
      label: "Principal",
      items: [
        {
          href: "/dashboard",
          icon: LayoutDashboard,
          label: adminCentral ? "Panel central" : "Panel aliado",
        },
      ],
    },
    {
      label: "Operacion",
      items: [
        ...(adminCentral ? [{ href: "/dashboard/aprobaciones", icon: ShieldCheck, label: "Aprobaciones" }] : []),
        ...(!adminCentral && isAdminRole(rolUsuario) ? [{ href: "/dashboard/pendientes", icon: ClipboardList, label: "PENDIENTES" }] : []),
        { href: "/dashboard/solicitudes", icon: ClipboardList, label: "Solicitudes" },
        { href: "/dashboard/creditos", icon: FileText, label: "Creditos" },
        ...(isAdminRole(rolUsuario)
          ? [{ href: "/dashboard/creditos?mode=simulator", icon: Calculator, label: "Simulador" }]
          : []),
        ...(adminCentral
          ? [
              {
                href: "/dashboard/creditos-masivos",
                icon: Files,
                label: "Creditos masivos",
              },
            ]
          : []),
        { href: "/dashboard/abonos", icon: CircleDollarSign, label: "Recaudos" },
        {
          href: "/dashboard/pagos-aliados",
          icon: WalletCards,
          label: "PAGOS ALIADO",
        },
        { href: "/dashboard/clientes", icon: Users, label: "Clientes" },
        ...(isAdminRole(rolUsuario)
          ? [{ href: "/dashboard/cartera", icon: PieChart, label: "Cartera", children: [
              { href: "/dashboard/cartera", icon: PieChart, label: "Resumen" },
              { href: "/dashboard/cartera/detalle-mora", icon: BarChart3, label: "Detalle de mora" },
              { href: "/dashboard/riesgo-referencia", icon: BarChart3, label: "Riesgo por referencia" },
            ] }]
          : []),
        ...(adminCentral
          ? [
              {
                href: "/dashboard/excepciones-mora",
                icon: TriangleAlert,
                label: "Excepciones por mora",
              },
            ]
          : []),
        { href: "/dashboard/reportes", icon: BarChart3, label: "Reportes" },
      ],
    },
    {
      label: "Administracion",
      items: [
        ...(adminCentral && isAdminRole(rolUsuario)
          ? [{ href: "/dashboard/comisiones", icon: Coins, label: "Comisiones" }]
          : []),
        ...(adminCentral
          ? [
              { href: "/dashboard/aliados", icon: Handshake, label: "Aliados" },
              { href: "/dashboard/lista-negra", icon: ShieldBan, label: "LISTA NEGRA" },
            ]
          : []),
        { href: "/dashboard/sedes", icon: MapPin, label: "Sedes" },
        { href: "/dashboard/usuarios", icon: UserRound, label: "Usuarios" },
        ...(adminCentral
          ? [
              {
                href: "/dashboard/catalogo-equipos",
                icon: Smartphone,
                label: "Catalogo de equipos",
              },
              {
                href: "/dashboard/parametros-credito",
                icon: Settings,
                label: "Parametros de credito",
              },
            ]
          : []),
      ],
    },
    ...(adminCentral
      ? [
          {
            label: "Integraciones",
            items: [
              {
                href: "/dashboard/integraciones",
                icon: Plug,
                label: "Integraciones",
              },
              {
                href: "/dashboard/integraciones/enrolamiento-iphone",
                icon: ShieldCheck,
                label: "Enrolamiento iPhone",
              },
              {
                href: "/dashboard/datacredito",
                icon: FileSearch,
                label: "Historial DataCrédito",
              },
              {
                href: "/dashboard/datacredito/liberaciones",
                icon: RefreshCcw,
                label: "Liberar consultas",
              },
              {
                href: "/dashboard/equality",
                icon: Equal,
                label: "Equality Zero Touch",
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <aside className={`${analystNavigation || portfolioNavigation ? "bg-[var(--fp-graphite)]" : "bg-[#071827]"} text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col`}>
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-4 lg:block lg:border-0 lg:px-5 lg:py-6">
        <FinserBrand compact dark accentPay={analystNavigation || portfolioNavigation} wordmarkOnly={analystNavigation || portfolioNavigation} showTagline={false} />
        <LogoutButton className="!rounded-lg !border-white/15 !px-3 lg:hidden" />
      </div>

      <details className="group border-b border-white/10 lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 text-sm font-bold text-white [&::-webkit-details-marker]:hidden">
          <Menu className="h-5 w-5" strokeWidth={1.8} />
          Todos los modulos
          <ChevronDown className="ml-auto h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <nav className="max-h-[70vh] overflow-y-auto px-3 pb-4 pt-2 [scrollbar-color:#334155_transparent] [scrollbar-width:thin]">
          <SidebarNavigation activeHref={activeHref} groups={navGroups} />
        </nav>
      </details>

      <nav className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-4 [scrollbar-color:#334155_transparent] [scrollbar-width:thin] lg:block">
        <SidebarNavigation activeHref={activeHref} groups={navGroups} />
      </nav>

      <div className="mt-auto hidden border-t border-white/15 px-5 py-5 lg:block">
        <p className="text-xs font-bold uppercase text-[#b7e63d]">{rolUsuario}</p>
        <p className="mt-2 truncate text-sm font-semibold text-white">{nombreUsuario}</p>
        <LogoutButton className="mt-4 w-full !rounded-lg !border-white/15 !bg-transparent" />
      </div>
    </aside>
  );
}
