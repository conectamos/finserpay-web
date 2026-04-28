import Link from "next/link";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { obtenerAvatarPerfilSrc } from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import LogoutButton from "./_components/logout-button";
import FinserBrand from "../_components/finser-brand";
import SellerProfileAccess from "./_components/seller-profile-access";

type NavItem = {
  href: string;
  label: string;
};

type ActionTone = "primary" | "secondary";

type ModuleAction = {
  href: string;
  label: string;
  tone?: ActionTone;
};

type ModuleCard = {
  accent: string;
  badge: string;
  eyebrow: string;
  title: string;
  description: string;
  actions: ModuleAction[];
};

type SessionItem = {
  label: string;
  value: string;
  detail: string;
  dot: string;
};

type SellerIconKind =
  | "home"
  | "clients"
  | "payments"
  | "new-sale"
  | "calculator"
  | "search"
  | "credit";

type SellerMenuItem = {
  href: string;
  label: string;
  icon: SellerIconKind;
  active?: boolean;
};

type SellerAction = {
  href: string;
  title: string;
  description: string;
  icon: SellerIconKind;
};

type AdminStat = {
  label: string;
  value: string;
  detail: string;
};

type AdminShortcut = {
  href: string;
  title: string;
  description: string;
  eyebrow: string;
  tone: "teal" | "slate" | "amber" | "sky";
};

function DashboardLogoBadge({
  compact = false,
  dark = false,
}: {
  compact?: boolean;
  dark?: boolean;
}) {
  return <FinserBrand compact={compact} dark={dark} showTagline={!compact} />;
}

function SessionDetail({ label, value, detail, dot }: SessionItem) {
  return (
    <div className="rounded-2xl border border-white/50 bg-white/60 px-4 py-4 backdrop-blur">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
            {label}
          </p>
          <p className="mt-2 text-lg font-black leading-tight text-slate-950">
            {value}
          </p>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">{detail}</p>
        </div>

        <span className={["mt-1 h-2.5 w-2.5 rounded-full", dot].join(" ")} />
      </div>
    </div>
  );
}

function ActionLink({ href, label, tone = "secondary" }: ModuleAction) {
  const tones: Record<ActionTone, string> = {
    primary:
      "border border-[#111318] bg-[#111318] text-white hover:bg-[#1b1f27] hover:border-[#1b1f27]",
    secondary:
      "border border-[#d7cfbf] bg-[#fcfaf5] text-slate-700 hover:bg-white hover:border-[#c6b99f]",
  };

  return (
    <Link
      href={href}
      className={[
        "inline-flex items-center rounded-xl px-4 py-2.5 text-sm font-semibold transition",
        tones[tone],
      ].join(" ")}
    >
      {label}
    </Link>
  );
}

function ModulePanel({
  accent,
  badge,
  eyebrow,
  title,
  description,
  actions,
}: ModuleCard) {
  return (
    <section className="group relative overflow-hidden rounded-[30px] border border-[#e8e0d1] bg-[linear-gradient(180deg,#ffffff_0%,#fbf9f4_100%)] p-6 shadow-[0_18px_50px_rgba(15,23,42,0.07)] transition duration-300 hover:-translate-y-0.5 hover:shadow-[0_24px_60px_rgba(15,23,42,0.10)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(199,154,87,0.10),transparent_32%)]" />

      <div className="relative flex items-start justify-between gap-4">
        <div>
          <div
            className={[
              "inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]",
              badge,
            ].join(" ")}
          >
            {eyebrow}
          </div>

          <h2 className="mt-4 text-2xl font-black tracking-tight text-slate-950">
            {title}
          </h2>

          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
            {description}
          </p>
        </div>

        <span
          className={["mt-1 h-12 w-1.5 rounded-full shadow-sm", accent].join(" ")}
        />
      </div>

      <div className="relative mt-6 flex flex-wrap gap-2.5">
        {actions.map((action) => (
          <ActionLink
            key={`${title}-${action.href}`}
            href={action.href}
            label={action.label}
            tone={action.tone}
          />
        ))}
      </div>
    </section>
  );
}

function SellerIcon({
  kind,
  className = "",
}: {
  kind: SellerIconKind;
  className?: string;
}) {
  const shared = ["h-7 w-7", className].join(" ");

  switch (kind) {
    case "home":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <path
            d="M4 11.5L12 5l8 6.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M7 10.5V19h10v-8.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "clients":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="2" />
          <path
            d="M4 18c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M17 9c1.7.3 3 1.7 3 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M17 14.5c1.8.2 3 1.4 3 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "payments":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <circle cx="10" cy="9" r="4" stroke="currentColor" strokeWidth="2" />
          <path d="M10 6.8v4.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path
            d="M8 8.5h3.1a1.4 1.4 0 010 2.8H8.9a1.4 1.4 0 000 2.8H12"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 20v-3.5h3.2l1.8-1.5H14l5-2.5c.8-.4 1.8-.1 2.2.7.4.8.1 1.8-.7 2.2L14 19H9.5L7.5 20H4z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "new-sale":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" />
          <path
            d="M5 20c0-3.2 3.1-5.5 7-5.5s7 2.3 7 5.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path d="M19 5v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M16 8h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "calculator":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <rect x="6" y="3" width="12" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
          <path d="M8.5 7.5h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="9" cy="12" r="1" fill="currentColor" />
          <circle cx="12" cy="12" r="1" fill="currentColor" />
          <circle cx="15" cy="12" r="1" fill="currentColor" />
          <circle cx="9" cy="15.5" r="1" fill="currentColor" />
          <circle cx="12" cy="15.5" r="1" fill="currentColor" />
          <circle cx="15" cy="15.5" r="1" fill="currentColor" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-4.2-4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "credit":
      return (
        <svg viewBox="0 0 24 24" className={shared} aria-hidden="true" fill="none">
          <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
          <path d="M12 8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path
            d="M9.5 9.5H13a2 2 0 010 4h-2a2 2 0 000 4H15"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function SellerSidebarLink({ href, label, icon, active = false }: SellerMenuItem) {
  return (
    <Link
      href={href}
      className={[
        "group relative mx-3 flex items-center gap-4 rounded-2xl px-4 py-3.5 text-base font-semibold transition",
        active
          ? "bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.06)_100%)] text-white shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
          : "text-white/74 hover:bg-white/8 hover:text-white",
      ].join(" ")}
    >
      <span
        className={[
          "absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-[#d8dee7] transition",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        ].join(" ")}
      />
      <SellerIcon kind={icon} className="h-6 w-6 shrink-0" />
      <span>{label}</span>
    </Link>
  );
}

function SellerActionCard({ href, title, description, icon }: SellerAction) {
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-[24px] border border-emerald-950/10 bg-white px-6 py-6 text-slate-950 shadow-[0_18px_36px_rgba(23,32,29,0.09)] transition duration-200 hover:-translate-y-1 hover:border-emerald-400 hover:shadow-[0_24px_42px_rgba(18,184,134,0.14)]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#b7e45c,#ff6b4a)]" />

      <div className="relative flex h-20 w-20 items-center justify-center rounded-[22px] border border-emerald-900/10 bg-[linear-gradient(135deg,#17201d_0%,#12b886_100%)] text-white shadow-[0_14px_26px_rgba(18,184,134,0.20)]">
        <SellerIcon kind={icon} className="h-11 w-11" />
      </div>

      <h2 className="relative mt-6 text-[1.9rem] font-black leading-tight tracking-tight">
        {title}
      </h2>

      <p className="relative mt-3 text-sm leading-6 text-slate-600">
        {description}
      </p>

      <div className="relative mt-6 inline-flex items-center gap-2 text-sm font-semibold text-zinc-950">
        Abrir modulo
        <span aria-hidden="true">-&gt;</span>
      </div>
    </Link>
  );
}

function AdminStatCard({ label, value, detail }: AdminStat) {
  return (
    <div className="relative overflow-hidden rounded-[24px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eceef2_54%,#dfe3e8_100%)] px-5 py-5 shadow-[0_16px_34px_rgba(15,23,42,0.08)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.72),transparent_38%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_35%)]" />
      <p className="relative text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </p>
      <p className="relative mt-4 text-3xl font-black tracking-tight text-zinc-950">{value}</p>
      <p className="relative mt-2 text-sm text-zinc-600">{detail}</p>
    </div>
  );
}

function AdminShortcutCard({
  href,
  title,
  description,
  eyebrow,
  tone,
}: AdminShortcut) {
  const toneMap: Record<AdminShortcut["tone"], string> = {
    teal: "border-zinc-800 bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] text-zinc-100",
    slate: "border-zinc-300 bg-[linear-gradient(180deg,#f3f4f6_0%,#e4e7ec_100%)] text-zinc-700",
    amber: "border-stone-300 bg-[linear-gradient(180deg,#f5f5f4_0%,#e7e5e4_100%)] text-stone-700",
    sky: "border-neutral-300 bg-[linear-gradient(180deg,#fafafa_0%,#e7e7e7_100%)] text-neutral-700",
  };

  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-[28px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef0f4_58%,#e1e4e9_100%)] p-5 shadow-[0_14px_32px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_22px_44px_rgba(15,23,42,0.12)]"
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.8),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_34%)]" />
      <div
        className={[
          "relative inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
          toneMap[tone],
        ].join(" ")}
      >
        {eyebrow}
      </div>
      <h3 className="relative mt-4 text-2xl font-black tracking-tight text-zinc-950">{title}</h3>
      <p className="relative mt-3 text-sm leading-6 text-zinc-600">{description}</p>
      <div className="relative mt-5 inline-flex items-center gap-2 text-sm font-semibold text-zinc-950">
        Abrir modulo
        <span aria-hidden="true">-&gt;</span>
      </div>
    </Link>
  );
}

function AdminManagementCard() {
  const actionClass =
    "inline-flex min-h-11 items-center justify-center rounded-2xl px-4 py-3 text-center text-sm font-black transition";

  return (
    <section className="group relative overflow-hidden rounded-[28px] border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#eef0f4_58%,#e1e4e9_100%)] p-5 shadow-[0_14px_32px_rgba(15,23,42,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_22px_44px_rgba(15,23,42,0.12)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.8),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(24,24,27,0.06),transparent_34%)]" />

      <div className="relative inline-flex rounded-full border border-zinc-800 bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-100">
        Admin
      </div>

      <h3 className="relative mt-4 text-2xl font-black uppercase tracking-tight text-zinc-950">
        GESTIÓN
      </h3>
      <p className="relative mt-3 text-sm leading-6 text-zinc-600">
        Administra puntos de venta, accesos y perfiles comerciales desde una sola tarjeta.
      </p>

      <div className="relative mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href="/dashboard/sedes"
          className={[
            actionClass,
            "border border-zinc-950 bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] text-white hover:opacity-95",
          ].join(" ")}
        >
          Gestionar sedes
        </Link>
        <Link
          href="/dashboard/usuarios"
          className={[
            actionClass,
            "border border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50",
          ].join(" ")}
        >
          Gestionar usuarios
        </Link>
      </div>
    </section>
  );
}

function AdminAnnulmentsCard() {
  const actionClass =
    "inline-flex min-h-11 items-center justify-center rounded-2xl px-4 py-3 text-center text-sm font-black transition";

  return (
    <section className="group relative overflow-hidden rounded-[28px] border border-rose-200 bg-[linear-gradient(180deg,#fff7f7_0%,#f3f4f6_58%,#e5e7eb_100%)] p-5 shadow-[0_14px_32px_rgba(15,23,42,0.08)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#ef4444,#f59e0b,#111827)]" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(239,68,68,0.12),transparent_34%),radial-gradient(circle_at_bottom_right,rgba(17,24,39,0.08),transparent_34%)]" />

      <div className="relative inline-flex rounded-full border border-rose-200 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-rose-700">
        Control
      </div>

      <h3 className="relative mt-4 text-2xl font-black uppercase tracking-tight text-zinc-950">
        Anulaciones
      </h3>
      <p className="relative mt-3 text-sm leading-6 text-zinc-600">
        Accesos rapidos para reversar creditos o recaudos desde sus tablas de auditoria.
      </p>

      <div className="relative mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href="/dashboard/reportes/creditos"
          className={[
            actionClass,
            "border border-zinc-950 bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] text-white hover:opacity-95",
          ].join(" ")}
        >
          Anular credito
        </Link>
        <Link
          href="/dashboard/reportes/abonos"
          className={[
            actionClass,
            "border border-rose-200 bg-white text-rose-700 hover:bg-rose-50",
          ].join(" ")}
        >
          Anular recaudo
        </Link>
      </div>
    </section>
  );
}

export default async function DashboardPage() {
  const session = await getSessionUser();

  if (!session) {
    return <div className="p-10">No autenticado</div>;
  }

  const usuario = await prisma.usuario.findUnique({
    where: { id: session.id },
    include: {
      rol: true,
      sede: true,
    },
  });

  const nombreUsuario = usuario?.nombre ?? "Usuario";
  const rolUsuario = usuario?.rol?.nombre ?? "USUARIO";
  const sedeLabel = usuario?.sede?.nombre ?? "GLOBAL";
  const admin = isAdminRole(rolUsuario);
  if (!admin) {
    await ensureVendorProfileVisualColumns();
  }
  const sellerSession = admin ? null : await getSellerSessionUser(session);
  const assignedSellers = admin
    ? []
    : await prisma.sedeVendedor.findMany({
        where: {
          sedeId: session.sedeId,
          activo: true,
          vendedor: {
            activo: true,
          },
        },
        select: {
          vendedor: {
            select: {
              id: true,
              nombre: true,
              documento: true,
              telefono: true,
              email: true,
              tipoPerfil: true,
              avatarKey: true,
              debeCambiarPin: true,
            },
          },
        },
        orderBy: {
          vendedor: {
            nombre: "asc",
          },
        },
      });
  const nombreVisible = sellerSession?.nombre ?? nombreUsuario;
  const nombreCorto = nombreVisible.split(" ")[0] || nombreVisible;
  const sellerAvatarSrc = sellerSession
    ? obtenerAvatarPerfilSrc(sellerSession.avatarKey)
    : null;
  const sellerIsSupervisor = !admin && sellerSession?.tipoPerfil === "SUPERVISOR";
  const sellerSearchHref = sellerIsSupervisor
    ? "/dashboard/clientes"
    : "/dashboard/creditos";
  const saludo = admin
    ? `Bienvenido, ${nombreUsuario}. Este proyecto quedo enfocado en fabrica de creditos e integraciones remotas.`
    : sellerIsSupervisor
      ? `Bienvenido, ${nombreVisible}. Desde aqui supervisas creditos, recaudo y seguimiento de la sede.`
      : `Bienvenido, ${nombreVisible}. Desde aqui generas creditos, inscribes equipos y validas si se pueden entregar.`;
  if (admin) {
    await ensureCreditAbonoAuditColumns();
  }

  const adminStats = admin
    ? await Promise.all([
        prisma.sede.count({
          where: {
            activa: true,
          },
        }),
        prisma.vendedor.count({
          where: {
            activo: true,
          },
        }),
        prisma.credito.count(),
        prisma.creditoAbono.aggregate({
          _sum: {
            valor: true,
          },
          where: {
            estado: {
              not: "ANULADO",
            },
            fechaAbono: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
            },
          },
        }),
      ])
    : null;

  if (!admin && !sellerSession) {
    return (
      <SellerProfileAccess
        sedeNombre={sedeLabel}
        sellers={assignedSellers.map((item) => item.vendedor)}
      />
    );
  }

  const navItems: NavItem[] = [
    { href: "/dashboard", label: "Panel principal" },
    { href: "/dashboard/creditos", label: "Fabrica de creditos" },
    { href: "/dashboard/abonos", label: "Abonos y recaudo" },
    ...(admin
      ? [
          { href: "/dashboard/reportes", label: "Reportes admin" },
          { href: "/dashboard/usuarios", label: "Vendedores" },
          { href: "/dashboard/sedes", label: "Sedes" },
          { href: "/dashboard/catalogo-equipos", label: "Catalogo de equipos" },
          { href: "/dashboard/parametros-credito", label: "Parametros de credito" },
          { href: "/dashboard/integraciones", label: "Centro de integraciones" },
          { href: "/dashboard/equality", label: "Equality Zero Touch" },
        ]
      : []),
  ];

  const sessionItems: SessionItem[] = [
    {
      label: "Usuario",
      value: nombreUsuario,
      detail: "Sesion activa",
      dot: "bg-zinc-950",
    },
    {
      label: "Rol",
      value: rolUsuario,
      detail: "Permisos cargados",
      dot: "bg-zinc-500",
    },
    {
      label: "Cobertura",
      value: sedeLabel,
      detail: "Contexto actual",
      dot: "bg-zinc-400",
    },
    {
      label: "Estado",
      value: "Activo",
      detail: "Portal disponible",
      dot: "bg-zinc-700",
    },
  ];

  const sellerActions: SellerAction[] = [
    {
      href: "/dashboard/creditos?mode=create-client",
      title: "Crear cliente",
      description:
        "Captura datos, firma contrato, selecciona el equipo e inicia el flujo comercial.",
      icon: "credit",
    },
    {
      href: sellerIsSupervisor ? "/dashboard#busqueda-rapida" : "/dashboard/creditos",
      title: sellerIsSupervisor ? "Buscar cliente" : "Validar entrega",
      description: sellerIsSupervisor
        ? "Abre el expediente del cliente, revisa documentos firmados y consulta el caso correcto."
        : "Confirma si el equipo ya quedo listo para entregar despues del enrolamiento.",
      icon: sellerIsSupervisor ? "clients" : "search",
    },
    ...(sellerIsSupervisor
      ? [
          {
            href: "/dashboard/abonos",
            title: "Abonos",
            description:
              "Busca al cliente, revisa cartera y recibe cuotas sin mezclarlo con la creacion.",
            icon: "payments" as const,
          },
          {
            href: "/dashboard/reportes/creditos",
            title: "Creditos por fecha",
            description:
              "Filtra ventas realizadas por rango de fechas y revisa la tabla de la sede.",
            icon: "calculator" as const,
          },
          {
            href: "/dashboard/reportes/abonos",
            title: "Abonos por fecha",
            description:
              "Consulta pagos recibidos por fecha para cuadrar caja y seguimiento de cartera.",
            icon: "payments" as const,
          },
        ]
      : [
          {
            href: "/dashboard/creditos",
            title: "Simulador",
            description:
              "Revisa valor financiado, cuotas e informacion del equipo antes de cerrar la venta.",
            icon: "calculator" as const,
          },
        ]),
  ];

  const sellerMenuItems: SellerMenuItem[] = [
    { href: "/dashboard", label: "Inicio", icon: "home", active: true },
    { href: "/dashboard/creditos?mode=create-client", label: "Crear cliente", icon: "new-sale" },
    ...(sellerIsSupervisor
      ? [
          { href: "/dashboard#busqueda-rapida", label: "Buscar cliente", icon: "clients" as const },
          { href: "/dashboard/abonos", label: "Abonos", icon: "payments" as const },
          { href: "/dashboard/reportes/creditos", label: "Creditos por fecha", icon: "calculator" as const },
          { href: "/dashboard/reportes/abonos", label: "Abonos por fecha", icon: "payments" as const },
        ]
      : [{ href: "/dashboard/creditos", label: "Validar entrega", icon: "search" as const }]),
    {
      href: sellerIsSupervisor ? "/dashboard#busqueda-rapida" : "/dashboard/creditos",
      label: sellerIsSupervisor ? "Expedientes" : "Simulador",
      icon: sellerIsSupervisor ? ("clients" as const) : "calculator",
    },
    { href: "/dashboard/pin", label: "Cambiar PIN", icon: "search" },
  ];

  if (!admin) {
    return (
      <div className="fp-shell min-h-screen text-slate-950">
        <div className="min-h-screen lg:grid lg:grid-cols-[292px_minmax(0,1fr)]">
          <aside className="fp-hero flex flex-col text-white shadow-[18px_0_48px_rgba(23,32,29,0.18)]">
            <div className="px-5 py-5">
              <div className="rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.12)_0%,rgba(255,255,255,0.04)_100%)] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
                <DashboardLogoBadge dark />
                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-100">
                    Sede {sedeLabel}
                  </span>
                  <span className="rounded-full border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.05)_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/76">
                    {sellerSession?.nombre || "Perfil vendedor"}
                  </span>
                </div>
              </div>
            </div>

            <nav className="py-2">
              {sellerMenuItems.map((item) => (
                <SellerSidebarLink key={item.label} {...item} />
              ))}
            </nav>

            <div className="mt-auto px-5 pb-6 pt-4">
              <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08)_0%,rgba(255,255,255,0.03)_100%)] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-200">
                  Flujo activo
                </p>
                <p className="mt-3 text-base font-semibold text-white">
                  {sellerIsSupervisor
                    ? "Supervision, recaudo y seguimiento de creditos."
                    : "Venta, alta y validacion de entrega."}
                </p>
                <p className="mt-2 text-sm leading-6 text-white/64">
                  Perfil actual: {sellerSession?.nombre}. Esta vista queda enfocada en lo esencial para la sede.
                </p>
              </div>

              <LogoutButton className="mt-4 w-full min-w-0 justify-center" />
            </div>
          </aside>

          <div className="flex min-h-screen flex-col">
            <header className="border-b border-emerald-950/10 bg-white/82 px-4 py-5 backdrop-blur sm:px-8">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-700">
                    Panel comercial
                  </p>
                  <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">
                    Buen dia, {nombreCorto}
                  </h1>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    {sellerIsSupervisor
                      ? "Gestiona clientes, creditos y recaudo desde una vista simple y rapida."
                      : "Gestiona clientes, nuevas ventas y validacion de entrega desde una vista simple y rapida."}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#ffffff_0%,#edf0f4_100%)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-700">
                    {sedeLabel}
                  </span>
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-800">
                      {sellerSession?.debeCambiarPin
                        ? "Cambiar PIN"
                        : sellerIsSupervisor
                          ? "Supervisor"
                          : "Vendedor"}
                    </span>
                  <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-emerald-900/10 bg-white shadow-[0_10px_24px_rgba(18,184,134,0.22)]">
                    {sellerAvatarSrc ? (
                      <img
                        src={sellerAvatarSrc}
                        alt={sellerSession?.nombre || "Perfil vendedor"}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <SellerIcon kind="new-sale" className="h-8 w-8" />
                    )}
                  </div>
                </div>
              </div>
            </header>

            <main className="flex-1 px-4 py-8 sm:px-8">
              <div className="mx-auto max-w-5xl">
                {sellerSession?.debeCambiarPin && (
                  <section className="mb-6 rounded-[28px] border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_100%)] px-6 py-5 text-zinc-900 shadow-[0_14px_32px_rgba(15,23,42,0.08)]">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-600">
                      Seguridad
                    </p>
                    <h2 className="mt-3 text-2xl font-black tracking-tight">
                      Cambia tu PIN inicial
                    </h2>
                    <p className="mt-2 text-sm leading-6">
                      Estas usando el PIN inicial del vendedor. Antes de seguir vendiendo, actualizalo para dejar el perfil asegurado.
                    </p>
                    <Link
                      href="/dashboard/pin"
                      className="mt-4 inline-flex rounded-2xl bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] px-4 py-3 text-sm font-semibold text-white transition hover:opacity-95"
                    >
                      Ir a cambiar PIN
                    </Link>
                  </section>
                )}

                <section
                  id="busqueda-rapida"
                  className="fp-surface relative overflow-hidden rounded-[28px] px-6 py-8"
                >
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#b7e45c,#ff6b4a)]" />

                  <div className="relative">
                    <div className="inline-flex rounded-full border fp-kicker px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em]">
                      Busqueda rapida
                    </div>

                    <h2 className="mt-5 text-3xl font-black leading-tight tracking-tight text-slate-950 sm:text-4xl">
                      Encuentra clientes y abre el flujo correcto
                    </h2>

                    <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
                      {sellerIsSupervisor
                        ? `Busca por cedula, telefono, folio, IMEI o deviceUid para pasar directo a recaudo o revisar la cartera desde ${sedeLabel}.`
                        : `Busca por cedula, telefono, folio, IMEI o deviceUid para continuar ventas y validar equipos desde ${sedeLabel}.`}
                    </p>
                  </div>

                  <form
                    action={sellerSearchHref}
                    className="relative mt-8 flex flex-col gap-3 xl:flex-row"
                  >
                    <input
                      type="text"
                      name="search"
                      placeholder="Cedula del cliente, IMEI o folio"
                      className="flex-1 rounded-[18px] border border-zinc-300 bg-white px-5 py-4 text-base text-slate-900 outline-none transition focus:border-zinc-700 focus:ring-2 focus:ring-zinc-200"
                    />

                    <button
                      type="submit"
                      className="inline-flex items-center justify-center gap-2 rounded-[18px] bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] px-6 py-4 text-lg font-bold text-white shadow-[0_12px_24px_rgba(15,23,42,0.18)] transition hover:opacity-95"
                    >
                      Buscar
                      <SellerIcon kind="search" className="h-6 w-6" />
                    </button>
                  </form>

                  <div className="relative mt-5 flex flex-wrap gap-2">
                    <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                      Sede {sedeLabel}
                    </span>
                    <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                      Zero Touch listo
                    </span>
                    <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                      {sellerIsSupervisor ? "Perfil supervisor" : "Perfil vendedor"}
                    </span>
                  </div>
                </section>

                <section className="mx-auto mt-10 grid max-w-5xl gap-6 md:grid-cols-3">
                  {sellerActions.map((action) => (
                    <SellerActionCard key={action.title} {...action} />
                  ))}
                </section>

                <Link
                  href={sellerIsSupervisor ? "/dashboard#busqueda-rapida" : "/dashboard/creditos"}
                  className="group relative mx-auto mt-10 flex max-w-5xl flex-col items-start justify-between gap-4 overflow-hidden rounded-[30px] border border-zinc-700/30 bg-[linear-gradient(135deg,#050506_0%,#18181b_42%,#52525b_100%)] px-7 py-7 text-white shadow-[0_18px_34px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 sm:flex-row sm:items-center"
                >
                  <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.16),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.05),transparent_32%)]" />
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-300">
                      Herramienta comercial
                    </p>
                    <p className="mt-3 text-2xl font-black tracking-tight">
                      {sellerIsSupervisor
                        ? "Abrir clientes y expedientes"
                        : "Simular credito y preparar la venta"}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-white/76">
                      {sellerIsSupervisor
                        ? "Consulta el caso correcto, revisa documentos firmados y abre el seguimiento del cliente."
                        : "Revisa valor financiado, cuotas e informacion del equipo antes de cerrar el negocio."}
                    </p>
                  </div>

                  <div className="relative flex h-20 w-20 items-center justify-center rounded-[24px] border border-white/16 bg-white/10">
                    <SellerIcon
                      kind={sellerIsSupervisor ? "clients" : "calculator"}
                      className="h-12 w-12"
                    />
                  </div>
                </Link>
              </div>
            </main>
          </div>
        </div>
      </div>
    );
  }

  const adminModules: ModuleCard[] = [
    {
      accent: "bg-emerald-500",
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      eyebrow: "Administracion",
      title: "Sedes y vendedores",
      description:
        "Crea puntos de venta, asigna usuarios vendedores, cambia claves y controla accesos por sede desde un solo bloque.",
      actions: [
        {
          href: "/dashboard/sedes",
          label: "Gestionar sedes",
          tone: "primary",
        },
        { href: "/dashboard/usuarios", label: "Gestionar vendedores" },
      ],
    },
    {
      accent: "bg-violet-500",
      badge: "border-violet-200 bg-violet-50 text-violet-700",
      eyebrow: "Reportes",
      title: "Creditos y abonos",
      description:
        "Consulta todos los creditos, los pagos dia a dia y el valor pendiente por cobrar del flujo nuevo de FINSER PAY.",
      actions: [
        {
          href: "/dashboard/reportes/creditos",
          label: "Tabla de creditos",
          tone: "primary",
        },
        { href: "/dashboard/reportes/abonos", label: "Tabla de abonos" },
      ],
    },
    {
      accent: "bg-cyan-500",
      badge: "border-cyan-200 bg-cyan-50 text-cyan-700",
      eyebrow: "Hub principal",
      title: "Centro de integraciones",
      description:
        "Vista consolidada del estado de sesion local y de Equality Zero Touch, sin mezclar inventario, ventas o modulos financieros.",
      actions: [
        {
          href: "/dashboard/integraciones",
          label: "Abrir hub",
          tone: "primary",
        },
        { href: "/dashboard/equality", label: "Equality" },
      ],
    },
    {
      accent: "bg-amber-500",
      badge: "border-amber-200 bg-amber-50 text-amber-700",
      eyebrow: "Proveedor externo",
      title: "Equality Zero Touch",
      description:
        "Consulta deviceUid y dispara acciones remotas como enroll, lock, unlock y release desde un flujo aislado.",
      actions: [
        {
          href: "/dashboard/equality",
          label: "Abrir consola",
          tone: "primary",
        },
        { href: "/dashboard/integraciones", label: "Ver estado general" },
      ],
    },
  ];

  const adminOverview: AdminStat[] = adminStats
    ? [
        {
          label: "Sedes activas",
          value: String(adminStats[0]),
          detail: "Puntos de venta habilitados para operar.",
        },
        {
          label: "Vendedores",
          value: String(adminStats[1]),
          detail: "Perfiles con PIN disponibles en las sedes.",
        },
        {
          label: "Creditos",
          value: String(adminStats[2]),
          detail: "Creditos creados en este portal.",
        },
        {
          label: "Recaudo hoy",
          value: `$ ${Number(adminStats[3]._sum.valor || 0).toLocaleString("es-CO")}`,
          detail: "Abonos recibidos desde las 00:00 de hoy.",
        },
      ]
    : [];

  const adminShortcuts: AdminShortcut[] = [
    {
      href: "/dashboard/reportes/creditos",
      title: "Tabla de creditos",
      description:
        "Consulta creditos, vendedor asociado, estado comercial y seguimiento general de cartera.",
      eyebrow: "Reportes",
      tone: "amber",
    },
    {
      href: "/dashboard/reportes/abonos",
      title: "Tabla de abonos",
      description:
        "Revisa recaudo dia a dia, pagos recibidos y pendiente por cobrar en todas las sedes.",
      eyebrow: "Recaudo",
      tone: "sky",
    },
    {
      href: "/dashboard/creditos",
      title: "Fabrica de creditos",
      description:
        "Abre el flujo comercial completo para ventas, contrato, pagare y enrolamiento de equipos.",
      eyebrow: "Operacion",
      tone: "teal",
    },
    {
      href: "/dashboard/catalogo-equipos",
      title: "Catalogo de equipos",
      description:
        "Administra marcas, modelos y precio base para que el asesor solo seleccione y venda.",
      eyebrow: "Equipos",
      tone: "amber",
    },
    {
      href: "/dashboard/parametros-credito",
      title: "Parametros de credito",
      description:
        "Configura porcentaje de fianza e interes para las nuevas ventas de FINSER PAY.",
      eyebrow: "Calculo",
      tone: "sky",
    },
    {
      href: "/dashboard/integraciones",
      title: "Centro de integraciones",
      description:
        "Monitorea Equality Zero Touch y valida el estado general del hub operativo del proyecto.",
      eyebrow: "Zero Touch",
      tone: "slate",
    },
  ];

  const modules: ModuleCard[] = [
    {
      accent: "bg-emerald-500",
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      eyebrow: "Operacion comercial",
      title: "Fabrica de creditos",
      description:
        "Genera creditos, inscribe equipos, verifica entregabilidad y opera comandos administrativos desde una sola fabrica.",
      actions: [
        {
          href: "/dashboard/creditos",
          label: "Abrir fabrica",
          tone: "primary",
        },
        { href: "/dashboard/abonos", label: "Recibir abonos" },
      ],
    },
    {
      accent: "bg-sky-500",
      badge: "border-sky-200 bg-sky-50 text-sky-700",
      eyebrow: "Cartera",
      title: "Abonos y recaudo",
      description:
        "Busca clientes, revisa saldo pendiente, registra pagos de cuotas y consulta el historial sin mezclarlo con la creacion del credito.",
      actions: [
        {
          href: "/dashboard/abonos",
          label: "Abrir recaudo",
          tone: "primary",
        },
      ],
    },
    ...adminModules,
  ];

  return (
    <div className="fp-shell min-h-screen text-slate-950">
      <main className="mx-auto max-w-7xl px-4 py-8">
        <section className="fp-hero relative overflow-hidden rounded-[30px] border border-emerald-950/10 px-6 py-7 text-white shadow-[0_24px_80px_rgba(23,32,29,0.20)] md:px-8">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#b7e45c,#ff6b4a)]" />
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <div className="relative inline-flex rounded-full border border-white/14 bg-white/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-50">
                Administracion
              </div>

              <div className="relative mt-4">
                <DashboardLogoBadge dark />
              </div>

              <h1 className="relative mt-5 text-4xl font-black tracking-tight md:text-5xl">
                Centro de control
              </h1>

              <p className="relative mt-3 text-sm leading-6 text-zinc-300 md:text-base">
                {saludo}
              </p>
            </div>

            <div className="relative flex flex-col gap-3 sm:flex-row">
              <Link
                href="/dashboard/reportes"
                className="rounded-2xl border border-white/12 bg-[linear-gradient(180deg,rgba(255,255,255,0.14)_0%,rgba(255,255,255,0.06)_100%)] px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-white/14"
              >
                Ver reportes
              </Link>
              <LogoutButton className="min-w-[160px] justify-center" />
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {adminOverview.map((item) => (
            <AdminStatCard key={item.label} {...item} />
          ))}
        </section>

        <section className="fp-surface relative mt-6 overflow-hidden rounded-[28px] p-6">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#18a7b5,#ff6b4a)]" />
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="max-w-2xl">
              <div className="inline-flex rounded-full border fp-kicker px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
                Sesion actual
              </div>
              <h2 className="mt-4 text-3xl font-black tracking-tight text-zinc-950">
                Control central de FINSER PAY
              </h2>
              <p className="mt-3 text-sm leading-6 text-zinc-600">
                Desde aqui gestionas sedes, vendedores, reportes, creditos e integraciones sin depender del panel antiguo.
              </p>
            </div>

            <div className="w-full max-w-[520px]">
              <div className="grid gap-3 sm:grid-cols-2">
                {sessionItems.map((item) => (
                  <SessionDetail key={item.label} {...item} />
                ))}
              </div>
            </div>
          </div>

          <div className="mt-6 flex gap-2 overflow-x-auto pb-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  "whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition",
                  item.href === "/dashboard"
                    ? "border-zinc-950 bg-[linear-gradient(180deg,#27272a_0%,#09090b_100%)] text-white"
                    : "border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceff3_100%)] text-zinc-700 hover:bg-white",
                ].join(" ")}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </section>

        <section className="fp-surface relative mt-6 overflow-hidden rounded-[28px] p-6">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-[linear-gradient(90deg,#12b886,#b7e45c,#ff6b4a)]" />
          <div>
            <div className="inline-flex rounded-full border fp-kicker px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]">
              Modulos principales
            </div>
            <h2 className="mt-4 text-3xl font-black tracking-tight text-zinc-950">
              Operacion, administracion y reportes
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-zinc-600">
              La vista admin ahora queda alineada con el estilo de `Sedes`: clara, ejecutiva y enfocada en accesos, cartera e integraciones.
            </p>
          </div>

          <div className="mt-6 grid gap-5 xl:grid-cols-3">
            <AdminAnnulmentsCard />
            <AdminManagementCard />
            {adminShortcuts.map((shortcut) => (
              <AdminShortcutCard key={shortcut.href} {...shortcut} />
            ))}
          </div>
        </section>

        <section className="relative mt-6 overflow-hidden rounded-[30px] bg-[linear-gradient(180deg,#ffffff_0%,#eef1f5_56%,#e3e7ed_100%)] p-6 shadow-[0_14px_34px_rgba(15,23,42,0.08)] ring-1 ring-zinc-300">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.95),transparent)]" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Link
              href="/dashboard/creditos"
              className="rounded-[24px] border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_54%,#e0e4ea_100%)] px-5 py-5 text-sm font-semibold text-zinc-700 transition hover:bg-white"
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Venta
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-zinc-950">
                Fabrica de creditos
              </p>
              <p className="mt-2 leading-6">
                Abre el flujo comercial completo.
              </p>
            </Link>

            <Link
              href="/dashboard/abonos"
              className="rounded-[24px] border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_54%,#e0e4ea_100%)] px-5 py-5 text-sm font-semibold text-zinc-700 transition hover:bg-white"
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Recaudo
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-zinc-950">
                Abonos y cartera
              </p>
              <p className="mt-2 leading-6">
                Recibe cuotas y revisa el pendiente.
              </p>
            </Link>

            <Link
              href="/dashboard/integraciones"
              className="rounded-[24px] border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_54%,#e0e4ea_100%)] px-5 py-5 text-sm font-semibold text-zinc-700 transition hover:bg-white"
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Integracion
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-zinc-950">
                Zero Touch
              </p>
              <p className="mt-2 leading-6">
                Monitorea el estado general de Equality.
              </p>
            </Link>

            <Link
              href="/dashboard/reportes"
              className="rounded-[24px] border border-zinc-300 bg-[linear-gradient(180deg,#fafafa_0%,#eceef2_54%,#e0e4ea_100%)] px-5 py-5 text-sm font-semibold text-zinc-700 transition hover:bg-white"
            >
              <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">
                Analitica
              </p>
              <p className="mt-3 text-xl font-black tracking-tight text-zinc-950">
                Reportes
              </p>
              <p className="mt-2 leading-6">
                Consolida creditos, abonos y operacion.
              </p>
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
