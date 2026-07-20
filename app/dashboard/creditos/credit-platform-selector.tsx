import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  ChevronRight,
  CircleHelp,
  FileSignature,
  ShieldCheck,
  Smartphone,
  UserCheck,
} from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import AdminSidebar from "@/app/dashboard/_components/admin-sidebar";

type CreditPlatformSelectorProps = {
  admin: boolean;
  adminCentral: boolean;
  androidHref: string;
  iphoneHref: string;
  nombreUsuario: string;
  rolUsuario: string;
  sedeNombre: string;
};

type PlatformCardProps = {
  accent: "android" | "iphone";
  badge: string;
  description: string;
  href: string;
  imageAlt: string;
  imageSrc: string;
  platform: string;
  secondary: string;
};

function PlatformCard({
  accent,
  badge,
  description,
  href,
  imageAlt,
  imageSrc,
  platform,
  secondary,
}: PlatformCardProps) {
  const android = accent === "android";

  return (
    <Link
      href={href}
      className={[
        "group relative overflow-hidden rounded-lg border bg-[#0c1013] transition duration-200 hover:-translate-y-0.5",
        android
          ? "border-[#31553a] hover:border-[#54c86e] hover:shadow-[0_18px_60px_rgba(47,180,80,0.12)]"
          : "border-white/15 hover:border-white/35 hover:shadow-[0_18px_60px_rgba(255,255,255,0.06)]",
      ].join(" ")}
    >
      <div className="relative aspect-[16/9] overflow-hidden border-b border-white/10 bg-black lg:absolute lg:inset-0 lg:aspect-auto lg:border-0">
        <Image
          src={imageSrc}
          alt={imageAlt}
          fill
          priority
          unoptimized
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="object-cover object-center transition duration-300 group-hover:scale-[1.01]"
        />
      </div>

      <div className="relative flex flex-col bg-[#0c1013] p-5 lg:min-h-[490px] lg:w-[56%] lg:bg-transparent lg:p-8 lg:pb-28">
        <span
          className={[
            "grid h-14 w-14 place-items-center rounded-full border bg-black/25",
            android
              ? "border-[#58d878]/35 text-[#58d878]"
              : "border-white/20 text-white",
          ].join(" ")}
        >
          <Smartphone className="h-6 w-6" strokeWidth={1.7} />
        </span>

        <h2 className="mt-5 text-3xl font-black text-white">{platform}</h2>
        <span
          className={[
            "mt-3 w-fit rounded-md border px-3 py-1.5 text-[11px] font-bold uppercase",
            android
              ? "border-[#58d878]/30 text-[#58d878]"
              : "border-white/20 text-slate-200",
          ].join(" ")}
        >
          {badge}
        </span>

        <div className="mt-5 max-w-[260px] space-y-4 border-t border-white/15 pt-5 text-sm text-slate-300">
          <span className="flex items-start gap-3">
            <ShieldCheck
              className={[
                "mt-0.5 h-5 w-5 shrink-0",
                android ? "text-[#58d878]" : "text-slate-300",
              ].join(" ")}
              strokeWidth={1.8}
            />
            {description}
          </span>
          <span className="flex items-start gap-3">
            <BadgeCheck
              className={[
                "mt-0.5 h-5 w-5 shrink-0",
                android ? "text-[#58d878]" : "text-slate-300",
              ].join(" ")}
              strokeWidth={1.8}
            />
            {secondary}
          </span>
        </div>

      </div>

      <span
        className={[
          "mx-5 mb-5 flex min-h-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-bold transition lg:absolute lg:bottom-8 lg:left-8 lg:right-8 lg:m-0",
          android
            ? "border-[#42bb5d] bg-[#35ad51] text-white group-hover:bg-[#40bd5d]"
            : "border-white/65 bg-black/20 text-white group-hover:border-white group-hover:bg-white group-hover:text-[#0b1013]",
        ].join(" ")}
      >
        Iniciar venta {platform}
        <ArrowRight className="h-4 w-4" strokeWidth={2} />
      </span>
    </Link>
  );
}

function getInitials(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join("") || "FP";
}

export default function CreditPlatformSelector({
  admin,
  adminCentral,
  androidHref,
  iphoneHref,
  nombreUsuario,
  rolUsuario,
  sedeNombre,
}: CreditPlatformSelectorProps) {
  const content = (
    <main className="min-w-0 bg-[#090d10] text-white">
      <header className="border-b border-white/10 bg-[#0a0e11]">
        <div className="mx-auto flex min-h-16 max-w-[1280px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-5">
            {!admin ? <FinserBrand compact dark showTagline={false} /> : null}
            <div className="flex items-center gap-2 text-sm">
              <span className="hidden text-slate-400 sm:inline">Ventas</span>
              <ChevronRight className="hidden h-4 w-4 text-slate-600 sm:block" strokeWidth={1.8} />
              <span className="font-semibold text-[#58d878]">Nueva venta</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-white/15 text-slate-300">
              <CircleHelp className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <div className="hidden h-8 w-px bg-white/10 sm:block" />
            <span className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-xs font-bold text-white">
              {getInitials(nombreUsuario)}
            </span>
            <div className="hidden sm:block">
              <p className="max-w-40 truncate text-sm font-bold text-white">{nombreUsuario}</p>
              <p className="text-xs text-slate-500">{rolUsuario}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1280px] px-4 py-7 sm:px-6 lg:px-8 lg:py-9">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#58d878]">Nueva venta</p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Selecciona el tipo de equipo
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {sedeNombre} | El flujo se ajusta a la plataforma seleccionada.
            </p>
          </div>

          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-bold text-slate-200 transition hover:border-white/30 hover:bg-white/5"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Volver
          </Link>
        </div>

        <section className="mt-7 grid gap-5 lg:grid-cols-2">
          <PlatformCard
            accent="android"
            badge="Fabrica actual"
            description="Trustonic / Zero Touch"
            href={androidHref}
            imageAlt="Telefono Android con enrolamiento seguro"
            imageSrc="/assets/creditos/platform-android.png"
            platform="Android"
            secondary="Enrolamiento automatico del dispositivo"
          />
          <PlatformCard
            accent="iphone"
            badge="Nueva fabrica"
            description="Verificacion manual de enrolamiento"
            href={iphoneHref}
            imageAlt="iPhone con validacion segura"
            imageSrc="/assets/creditos/platform-iphone.png"
            platform="iPhone"
            secondary="Validacion guiada antes de continuar"
          />
        </section>

        <section className="mt-6 grid border-y border-white/10 py-3 sm:grid-cols-3">
          <div className="flex items-center gap-3 px-4 py-3 sm:border-r sm:border-white/10">
            <UserCheck className="h-6 w-6 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-sm font-bold text-white">Validacion de identidad</p>
              <p className="mt-0.5 text-xs text-slate-500">Proceso seguro y verificable</p>
            </div>
          </div>
          <div className="flex items-center gap-3 border-y border-white/10 px-4 py-3 sm:border-y-0 sm:border-r">
            <FileSignature className="h-6 w-6 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-sm font-bold text-white">Firma digital</p>
              <p className="mt-0.5 text-xs text-slate-500">Documentos con validez legal</p>
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3">
            <ShieldCheck className="h-6 w-6 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-sm font-bold text-white">Entrega controlada</p>
              <p className="mt-0.5 text-xs text-slate-500">Validacion antes del desembolso</p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );

  if (!admin) {
    return <div className="min-h-screen bg-[#090d10]">{content}</div>;
  }

  return (
    <div className="min-h-screen bg-[#090d10] lg:grid lg:grid-cols-[250px_minmax(0,1fr)]">
      <AdminSidebar
        activeHref="/dashboard/creditos"
        adminCentral={adminCentral}
        nombreUsuario={nombreUsuario}
        rolUsuario={rolUsuario}
      />
      {content}
    </div>
  );
}
