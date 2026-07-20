import type { ComponentType } from "react";
import Link from "next/link";
import {
  BarChart3,
  ChevronDown,
  CircleDollarSign,
  Equal,
  FileText,
  Files,
  Handshake,
  LayoutDashboard,
  MapPin,
  Menu,
  PieChart,
  Plug,
  Settings,
  Smartphone,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "./logout-button";

type IconType = ComponentType<{
  className?: string;
  strokeWidth?: number;
}>;

type NavItem = {
  href: string;
  icon: IconType;
  label: string;
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
      <span className="whitespace-nowrap">{label}</span>
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
            {group.items.map((item) => (
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
  const navGroups: NavGroup[] = [
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
        { href: "/dashboard/creditos", icon: FileText, label: "Creditos" },
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
        { href: "/dashboard/clientes", icon: Users, label: "Clientes" },
        ...(adminCentral
          ? [
              { href: "/dashboard/cartera", icon: PieChart, label: "Cartera" },
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
        ...(adminCentral
          ? [{ href: "/dashboard/aliados", icon: Handshake, label: "Aliados" }]
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
              { href: "/dashboard/integraciones", icon: Plug, label: "Integraciones" },
              { href: "/dashboard/equality", icon: Equal, label: "Equality Zero Touch" },
            ],
          },
        ]
      : []),
  ];

  return (
    <aside className="bg-[#071827] text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-4 lg:block lg:border-0 lg:px-5 lg:py-6">
        <FinserBrand compact dark showTagline={false} />
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
