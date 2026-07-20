import Link from "next/link";
import Image from "next/image";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { obtenerAvatarPerfilSrc } from "@/lib/profile-avatars";
import { ensureVendorProfileVisualColumns } from "@/lib/vendor-profile-schema";
import LogoutButton from "./_components/logout-button";
import FinserBrand from "../_components/finser-brand";
import SellerProfileAccess from "./_components/seller-profile-access";
import AdminCentralDashboard from "./_components/admin-central-dashboard";
import { getAdminDashboardOverview } from "./_lib/admin-dashboard-data";

const CLIENT_APP_PLAY_STORE_URL =
  "https://play.google.com/store/apps/details?id=com.finserpay.clientes";
const CLIENT_APP_QR_PATH = "/downloads/finserpay-clientes-qr.svg";

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

function DashboardLogoBadge({
  compact = false,
  dark = false,
}: {
  compact?: boolean;
  dark?: boolean;
}) {
  return <FinserBrand compact={compact} dark={dark} showTagline={!compact} />;
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

type DashboardTone =
  | "dark"
  | "orange"
  | "blue"
  | "green"
  | "light"
  | "danger"
  | "portfolio";

type DashboardTileProps = {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: SellerIconKind;
  tone?: DashboardTone;
};

function DashboardTile({
  href,
  eyebrow,
  title,
  description,
  icon,
  tone = "light",
}: DashboardTileProps) {
  const toneMap: Record<DashboardTone, string> = {
    dark: "border-[#24262d] bg-[#15171d] text-white",
    orange: "border-[#d9c691] bg-[#fbf8ef] text-[#22201a]",
    blue: "border-[#d7dce2] bg-[#f3f5f4] text-[#20242a]",
    green: "border-[#cce7df] bg-[#eff8f5] text-[#173c38]",
    light: "border-[#d7dce2] bg-white text-[#20242a]",
    danger: "border-[#ffd0d0] bg-[#fff7f7] text-[#3c3030]",
    portfolio:
      "border-[#123c38] bg-[linear-gradient(135deg,#13231f_0%,#0f766e_54%,#bfa46a_140%)] text-white",
  };
  const iconTone: Record<DashboardTone, string> = {
    dark: "bg-white/10 text-white border-white/12",
    orange: "bg-[#bfa46a] text-white border-[#bfa46a]",
    blue: "bg-[#20242a] text-white border-[#20242a]",
    green: "bg-[#0f766e] text-white border-[#0f766e]",
    light: "bg-[#f4f5f4] text-[#20242a] border-[#d7dce2]",
    danger: "bg-[#111318] text-white border-[#111318]",
    portfolio: "bg-white/14 text-white border-white/18",
  };

  return (
    <Link
      href={href}
      className={[
        "fp-dashboard-tile group relative flex min-h-[148px] flex-col justify-between overflow-hidden rounded-[30px] border p-5 shadow-[0_18px_42px_rgba(48,56,71,0.08)] transition hover:-translate-y-0.5 hover:shadow-[0_24px_50px_rgba(48,56,71,0.12)]",
        toneMap[tone],
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.22em] opacity-70">
            {eyebrow}
          </p>
          <h3 className="mt-3 text-2xl font-black leading-tight tracking-tight">
            {title}
          </h3>
        </div>
        <span
          className={[
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border shadow-[0_12px_24px_rgba(48,56,71,0.12)]",
            iconTone[tone],
          ].join(" ")}
        >
          <SellerIcon kind={icon} className="h-7 w-7" />
        </span>
      </div>
      <p className="mt-4 text-sm leading-6 opacity-[0.72]">{description}</p>
    </Link>
  );
}

function DashboardButton({
  href,
  label,
  tone = "light",
}: {
  href: string;
  label: string;
  tone?: DashboardTone;
}) {
  const toneMap: Record<DashboardTone, string> = {
    dark: "border-[#111318] bg-[#111318] text-white",
    orange: "border-[#0f766e] bg-[#0f766e] text-white",
    blue: "border-[#20242a] bg-[#20242a] text-white",
    green: "border-[#0f766e] bg-[#0f766e] text-white",
    light: "border-[#d7dce2] bg-white text-[#20242a]",
    danger: "border-[#ffd0d0] bg-white text-[#c01b1b]",
    portfolio: "border-[#123c38] bg-[#123c38] text-white",
  };

  return (
    <Link
      href={href}
      className={[
        "inline-flex min-h-11 items-center justify-center rounded-2xl border px-4 py-3 text-center text-sm font-black transition hover:-translate-y-0.5",
        toneMap[tone],
      ].join(" ")}
    >
      {label}
    </Link>
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
  const sedeAccesoLabel = usuario?.sede?.nombre ?? "GLOBAL";
  const admin = isAdminRole(rolUsuario);
  const adminCentral = admin && isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  const adminAliado = admin && !adminCentral;
  const aliadoPanelNombre = session.aliadoAccesoNombre || "Aliado";
  const aliadoScopeId = Number(session.aliadoAccesoId || 0);
  const aliadoStatsScopeId =
    Number.isInteger(aliadoScopeId) && aliadoScopeId > 0 ? aliadoScopeId : -1;
  if (!admin) {
    await ensureVendorProfileVisualColumns();
  }
  const sellerSession = admin ? null : await getSellerSessionUser(session);
  const sedeLabel = sellerSession?.sedeNombre ?? session.sedeNombre ?? sedeAccesoLabel;
  const assignedSellers = admin
    ? []
    : await prisma.sedeVendedor.findMany({
        where: {
          sedeId: session.sedeAccesoId ?? session.sedeId,
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
  if (admin) {
    await ensureCreditAbonoAuditColumns();
  }

  if (!admin && !sellerSession) {
    return (
      <SellerProfileAccess
        sedeNombre={sedeAccesoLabel}
        sellers={assignedSellers.map((item) => item.vendedor)}
      />
    );
  }

  const sellerActions: SellerAction[] = [
    {
      href: "/dashboard/creditos",
      title: "Crear cliente",
      description:
        "Captura datos, firma contrato, selecciona el equipo e inicia el flujo comercial.",
      icon: "credit",
    },
    {
      href: sellerIsSupervisor ? "/dashboard#busqueda-rapida" : "/dashboard/creditos?mode=delivery",
      title: sellerIsSupervisor ? "Buscar cliente" : "Validar entrega",
      description: sellerIsSupervisor
        ? "Abre el expediente del cliente, revisa documentos firmados y consulta el caso correcto."
        : "Consulta por cedula o IMEI si el equipo ya quedo listo para entregar.",
      icon: sellerIsSupervisor ? "clients" : "search",
    },
    ...(sellerIsSupervisor
      ? [
          {
            href: "/dashboard/abonos",
            title: "Abonos y recaudo",
            description:
              "Busca al cliente, revisa cartera y registra pagos de cuotas desde el modulo de recaudo.",
            icon: "payments" as const,
          },
          {
            href: "/dashboard/creditos?mode=simulator",
            title: "Simulador",
            description:
              "Selecciona equipo, inicial y cuotas antes de orientar una venta.",
            icon: "calculator" as const,
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
            href: "/dashboard/creditos?mode=simulator",
            title: "Simulador",
            description:
              "Selecciona equipo, inicial y cuotas antes de iniciar la venta.",
            icon: "calculator" as const,
          },
        ]),
  ];

  const sellerMenuItems: SellerMenuItem[] = sellerIsSupervisor
    ? [
        { href: "/dashboard", label: "Inicio", icon: "home", active: true },
        { href: "/dashboard/creditos", label: "Crear cliente", icon: "new-sale" },
        { href: "/dashboard#busqueda-rapida", label: "Buscar cliente", icon: "clients" as const },
        { href: "/dashboard/abonos", label: "Abonos y recaudo", icon: "payments" as const },
        { href: "/dashboard/creditos?mode=simulator", label: "Simulador", icon: "calculator" as const },
        { href: "/dashboard/reportes/creditos", label: "Creditos por fecha", icon: "calculator" as const },
        { href: "/dashboard/reportes/abonos", label: "Abonos por fecha", icon: "payments" as const },
        { href: "/dashboard#busqueda-rapida", label: "Expedientes", icon: "clients" as const },
        { href: "/dashboard/pin", label: "Cambiar PIN", icon: "search" },
      ]
    : [
        { href: "/dashboard/creditos", label: "Crear cliente", icon: "new-sale" },
        { href: "/dashboard/creditos?mode=delivery", label: "Validar entrega", icon: "search" },
        { href: "/dashboard/creditos?mode=simulator", label: "Simulador", icon: "calculator" },
      ];

  if (!admin) {
    return (
      <div className="fp-dashboard-app min-h-screen text-[#20242a]">
        <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6 lg:py-8">
          <header className="flex flex-col gap-4 rounded-[32px] border border-[#d7dce2] bg-white/92 p-4 shadow-[0_18px_48px_rgba(17,19,24,0.08)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <DashboardLogoBadge compact />
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#6d5a22]">
                  Panel comercial
                </p>
                <p className="mt-1 text-sm font-bold text-[#687080]">
                  {sedeLabel} - {sellerIsSupervisor ? "Supervisor" : "Vendedor"}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-2xl border border-[#d7dce2] bg-white shadow-[0_10px_24px_rgba(17,19,24,0.08)]">
                {sellerAvatarSrc ? (
                  <img
                    src={sellerAvatarSrc ?? undefined}
                    alt={sellerSession?.nombre || "Perfil vendedor"}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <SellerIcon kind="new-sale" className="h-7 w-7" />
                )}
              </div>
              <LogoutButton className="min-w-0 justify-center !border-[#111318] !bg-[#111318] !text-white" />
            </div>
          </header>

          {sellerSession?.debeCambiarPin && (
            <section className="mt-5 rounded-[30px] border border-[#d9c691] bg-[#fbf8ef] p-5 shadow-[0_16px_38px_rgba(17,19,24,0.06)]">
              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#6d5a22]">
                Seguridad
              </p>
              <h2 className="mt-2 text-2xl font-black text-[#20242a]">
                Cambia tu PIN inicial
              </h2>
              <DashboardButton href="/dashboard/pin" label="Actualizar PIN" tone="orange" />
            </section>
          )}

          <section className="mt-5 overflow-hidden rounded-[38px] border border-[#d7dce2] bg-white p-6 shadow-[0_24px_70px_rgba(17,19,24,0.08)] sm:p-8">
            <div className="grid gap-6 lg:grid-cols-[1fr_280px] lg:items-center">
              <div>
                <div className="inline-flex rounded-full border border-[#d9c691] bg-[#fbf8ef] px-3 py-1 text-[10px] font-black uppercase tracking-[0.24em] text-[#6d5a22]">
                  Inicio
                </div>
                <h1 className="mt-5 text-4xl font-black leading-[1.05] tracking-tight text-[#20242a] sm:text-5xl">
                  Hola, {nombreCorto}
                </h1>
                <p className="mt-4 max-w-xl text-sm leading-6 text-[#687080]">
                  {sellerIsSupervisor
                    ? "Busca clientes, recibe cuotas y revisa reportes de tu sede."
                    : "Crea ventas, valida entrega y consulta el simulador sin ruido."}
                </p>
                <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                  <DashboardButton href="/dashboard/creditos" label="Nuevo credito" tone="orange" />
                  <DashboardButton
                    href={sellerIsSupervisor ? "/dashboard/clientes" : "/dashboard/creditos?mode=delivery"}
                    label={sellerIsSupervisor ? "Buscar cliente" : "Validar entrega"}
                    tone="dark"
                  />
                </div>
              </div>

              <div className="rounded-[30px] border border-[#cce7df] bg-[#eff8f5] p-5">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-[#0f766e]">
                  Perfil activo
                </p>
                <p className="mt-3 text-2xl font-black text-[#20242a]">
                  {sellerSession?.nombre}
                </p>
                <p className="mt-2 text-sm font-bold text-[#687080]">
                  {sellerIsSupervisor ? "Supervision" : "Asesor comercial"}
                </p>
              </div>
            </div>
          </section>

          <section className="mt-5 overflow-hidden rounded-[34px] border border-[#d7dce2] bg-white p-5 shadow-[0_18px_48px_rgba(17,19,24,0.07)]">
            <div className="grid gap-5 md:grid-cols-[168px_1fr] md:items-center">
              <div className="rounded-[26px] border border-[#cce7df] bg-[#eff8f5] p-3">
                <Image
                  src={CLIENT_APP_QR_PATH}
                  alt="QR descarga app FINSER PAY Clientes"
                  width={720}
                  height={720}
                  className="aspect-square w-full rounded-[18px] bg-white"
                />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                  App clientes actualizada
                </p>
                <h2 className="mt-2 text-2xl font-black leading-tight text-[#20242a]">
                  Instalar o actualizar al finalizar la venta
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#687080]">
                  Escanea este QR desde el celular del cliente para instalar o actualizar desde Google Play con notificaciones de pago.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <a
                    href={CLIENT_APP_PLAY_STORE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-[#0f766e] bg-[#0f766e] px-4 text-center text-sm font-black text-white transition hover:-translate-y-0.5"
                  >
                    Abrir Google Play
                  </a>
                  <a
                    href={CLIENT_APP_PLAY_STORE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-12 items-center justify-center rounded-2xl border border-[#d7dce2] bg-[#fbfbf7] px-4 text-center text-sm font-black text-[#20242a] transition hover:-translate-y-0.5"
                  >
                    Instalar desde Play Store
                  </a>
                </div>
              </div>
            </div>
          </section>

          {sellerIsSupervisor && (
            <section
              id="busqueda-rapida"
              className="mt-5 rounded-[34px] border border-[#d7dce2] bg-white p-5 shadow-[0_18px_48px_rgba(17,19,24,0.07)]"
            >
              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-[#0f766e]">
                Busqueda rapida
              </p>
              <form action={sellerSearchHref} className="mt-4 flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  name="search"
                  placeholder="Cedula, IMEI o folio"
                  className="min-h-14 flex-1 rounded-2xl border border-[#d7dce2] bg-[#fbfbf7] px-5 text-base text-[#20242a] outline-none transition focus:border-[#0f766e] focus:ring-4 focus:ring-[#0f766e]/15"
                />
                <button
                  type="submit"
                  className="inline-flex min-h-14 items-center justify-center rounded-2xl bg-[#111318] px-6 text-sm font-black text-white transition hover:-translate-y-0.5"
                >
                  Buscar
                </button>
              </form>
            </section>
          )}

          <section className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DashboardTile
              href="/dashboard/creditos"
              eyebrow="Venta"
              title="Nuevo credito"
              description="Crear cliente y abrir venta."
              icon="new-sale"
              tone="orange"
            />
            <DashboardTile
              href={sellerIsSupervisor ? "/dashboard/abonos" : "/dashboard/creditos?mode=delivery"}
              eyebrow={sellerIsSupervisor ? "Recaudo" : "Entrega"}
              title={sellerIsSupervisor ? "Abonos" : "Validar"}
              description={sellerIsSupervisor ? "Recibir cuotas de clientes." : "Confirmar si puede entregar."}
              icon={sellerIsSupervisor ? "payments" : "search"}
              tone="green"
            />
            <DashboardTile
              href={sellerIsSupervisor ? "/dashboard/reportes/creditos" : "/dashboard/creditos?mode=simulator"}
              eyebrow={sellerIsSupervisor ? "Reportes" : "Simulador"}
              title={sellerIsSupervisor ? "Por fecha" : "Cuotas"}
              description={sellerIsSupervisor ? "Ventas y abonos de la sede." : "Calcular antes de vender."}
              icon="calculator"
              tone="blue"
            />
          </section>
        </main>
      </div>
    );

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
                        src={sellerAvatarSrc ?? undefined}
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

                {sellerIsSupervisor && (
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
                        Busca por cedula, telefono, folio, IMEI o deviceUid para pasar directo a recaudo o revisar la cartera desde {sedeLabel}.
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

                    <div className="relative mt-5 flex flex-wrap gap-3">
                      <Link
                        href="/dashboard/abonos"
                        className="inline-flex items-center justify-center rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm font-black text-emerald-800 transition hover:bg-emerald-100"
                      >
                        Abrir abonos y recaudo
                      </Link>
                      <Link
                        href="/dashboard/reportes/abonos"
                        className="inline-flex items-center justify-center rounded-2xl border border-zinc-300 bg-white px-4 py-2.5 text-sm font-black text-zinc-800 transition hover:bg-zinc-50"
                      >
                        Ver abonos por fecha
                      </Link>
                    </div>

                    <div className="relative mt-4 flex flex-wrap gap-2">
                      <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                        Sede {sedeLabel}
                      </span>
                      <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                        Zero Touch listo
                      </span>
                      <span className="rounded-full border border-zinc-300 bg-[linear-gradient(180deg,#f8fafc_0%,#e5e7eb_100%)] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-700">
                        Perfil supervisor
                      </span>
                    </div>
                  </section>
                )}

                <section className="mx-auto mt-10 grid max-w-5xl gap-6 md:grid-cols-3">
                  {sellerActions.map((action) => (
                    <SellerActionCard key={action.title} {...action} />
                  ))}
                </section>

                {sellerIsSupervisor && (
                  <Link
                    href="/dashboard#busqueda-rapida"
                    className="group relative mx-auto mt-10 flex max-w-5xl flex-col items-start justify-between gap-4 overflow-hidden rounded-[30px] border border-zinc-700/30 bg-[linear-gradient(135deg,#050506_0%,#18181b_42%,#52525b_100%)] px-7 py-7 text-white shadow-[0_18px_34px_rgba(15,23,42,0.18)] transition hover:-translate-y-0.5 sm:flex-row sm:items-center"
                  >
                    <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.16),transparent_28%),linear-gradient(180deg,rgba(255,255,255,0.05),transparent_32%)]" />
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-300">
                        Herramienta comercial
                      </p>
                      <p className="mt-3 text-2xl font-black tracking-tight">
                        Abrir clientes y expedientes
                      </p>
                      <p className="mt-2 text-sm leading-6 text-white/76">
                        Consulta el caso correcto, revisa documentos firmados y abre el seguimiento del cliente.
                      </p>
                    </div>

                    <div className="relative flex h-20 w-20 items-center justify-center rounded-[24px] border border-white/16 bg-white/10">
                      <SellerIcon kind="clients" className="h-12 w-12" />
                    </div>
                  </Link>
                )}
              </div>
            </main>
          </div>
        </div>
      </div>
    );
  }

  const dashboardOverview = await getAdminDashboardOverview({
    aliadoId: adminAliado ? aliadoStatsScopeId : null,
  });

  return (
    <AdminCentralDashboard
      adminCentral={adminCentral}
      aliadoNombre={aliadoPanelNombre}
      data={dashboardOverview}
      nombreUsuario={nombreUsuario}
      rolUsuario={rolUsuario}
      sedeLabel={sedeLabel}
    />
  );
}
