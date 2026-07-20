import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Calculator,
  ChevronDown,
  CircleDollarSign,
  FileText,
  Files,
  LayoutDashboard,
  Menu,
  PieChart,
  Plus,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  Users,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import LogoutButton from "@/app/dashboard/_components/logout-button";

type NavItem = {
  href: string;
  icon: LucideIcon;
  label: string;
};

type RecaudoSidebarProps = {
  adminCentral: boolean;
  canAdmin: boolean;
  nombre: string;
  rol: string;
};

function SidebarNavigation({ items }: { items: NavItem[] }) {
  return (
    <nav className="space-y-1">
      {items.map(({ href, icon: Icon, label }) => {
        const active = href === "/dashboard/abonos";

        return (
          <Link
            key={`${href}-${label}`}
            href={href}
            aria-current={active ? "page" : undefined}
            className={[
              "flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition",
              active
                ? "bg-[#dafa70] text-[#1f2a12] shadow-[0_8px_22px_rgba(183,230,61,0.14)]"
                : "text-slate-300 hover:bg-white/8 hover:text-white",
            ].join(" ")}
          >
            <Icon className="h-5 w-5 shrink-0" strokeWidth={1.8} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default function RecaudoSidebar({
  adminCentral,
  canAdmin,
  nombre,
  rol,
}: RecaudoSidebarProps) {
  const items: NavItem[] = canAdmin
    ? [
        { href: "/dashboard", icon: LayoutDashboard, label: "Panel central" },
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
      ]
    : [
        { href: "/dashboard", icon: LayoutDashboard, label: "Inicio" },
        { href: "/dashboard/creditos", icon: Plus, label: "Nueva venta" },
        { href: "/dashboard/clientes", icon: Users, label: "Clientes" },
        { href: "/dashboard/abonos", icon: CircleDollarSign, label: "Recaudos" },
        {
          href: "/dashboard/creditos?mode=simulator",
          icon: Calculator,
          label: "Simulador",
        },
        {
          href: "/dashboard/reportes/creditos",
          icon: BarChart3,
          label: "Creditos por fecha",
        },
        {
          href: "/dashboard/reportes/abonos",
          icon: FileText,
          label: "Abonos por fecha",
        },
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
          Modulos de recaudo
          <ChevronDown className="ml-auto h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <div className="max-h-[70vh] overflow-y-auto px-3 pb-4 pt-2">
          <SidebarNavigation items={items} />
        </div>
      </details>

      <div className="hidden min-h-0 flex-1 overflow-y-auto px-3 pb-4 lg:block">
        <p className="mb-2 px-3 text-[10px] font-bold uppercase text-slate-500">
          Operacion
        </p>
        <SidebarNavigation items={items} />
      </div>

      <div className="mt-auto hidden border-t border-white/15 px-5 py-5 lg:block">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/15 bg-white/10">
            <UserRound className="h-5 w-5" strokeWidth={1.8} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold text-white">{nombre}</p>
            <p className="mt-0.5 text-xs font-semibold uppercase text-[#b7e63d]">
              {rol}
            </p>
          </div>
        </div>
        <LogoutButton className="mt-4 w-full !rounded-lg !border-white/15 !bg-transparent" />
      </div>
    </aside>
  );
}
