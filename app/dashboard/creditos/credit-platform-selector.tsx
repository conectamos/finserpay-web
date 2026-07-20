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
        "group relative isolate overflow-hidden rounded-lg border bg-[#0c1013] transition duration-200 hover:-translate-y-0.5",
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
          sizes="(max-width: 1024px) 100vw, 760px"
          className="object-cover object-center transition duration-300 group-hover:scale-[1.01]"
        />
      </div>

      <div
        className={[
          "pointer-events-none absolute inset-0 hidden lg:block",
          android
            ? "bg-[linear-gradient(90deg,rgba(5,12,9,0.98)_0%,rgba(5,12,9,0.88)_39%,rgba(5,12,9,0.12)_68%,rgba(5,12,9,0)_100%)]"
            : "bg-[linear-gradient(90deg,rgba(8,10,12,0.98)_0%,rgba(8,10,12,0.88)_39%,rgba(8,10,12,0.10)_68%,rgba(8,10,12,0)_100%)]",
        ].join(" ")}
      />

      <div className="relative flex flex-col bg-[#0c1013] p-5 lg:min-h-[560px] lg:w-[54%] lg:bg-transparent lg:p-9 lg:pb-32 xl:min-h-[590px] xl:p-10 2xl:min-h-[620px] 2xl:p-12">
        <span
          className={[
            "grid h-16 w-16 place-items-center rounded-full border bg-black/25 xl:h-[72px] xl:w-[72px]",
            android
              ? "border-[#58d878]/35 text-[#58d878]"
              : "border-white/20 text-white",
          ].join(" ")}
        >
          <Smartphone className="h-7 w-7 xl:h-8 xl:w-8" strokeWidth={1.6} />
        </span>

        <h2 className="mt-7 text-4xl font-black text-white">{platform}</h2>
        <span
          className={[
            "mt-4 w-fit rounded-md border px-3 py-1.5 text-xs font-bold uppercase",
            android
              ? "border-[#58d878]/30 text-[#58d878]"
              : "border-white/20 text-slate-200",
          ].join(" ")}
        >
          {badge}
        </span>

        <div className="mt-7 max-w-[310px] space-y-5 border-t border-white/15 pt-6 text-base leading-6 text-slate-300">
          <span className="flex items-start gap-3">
            <ShieldCheck
              className={[
                "mt-0.5 h-6 w-6 shrink-0",
                android ? "text-[#58d878]" : "text-slate-300",
              ].join(" ")}
              strokeWidth={1.8}
            />
            {description}
          </span>
          <span className="flex items-start gap-3">
            <BadgeCheck
              className={[
                "mt-0.5 h-6 w-6 shrink-0",
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
          "mx-5 mb-5 flex min-h-14 items-center justify-center gap-3 rounded-lg border px-5 text-base font-bold transition lg:absolute lg:bottom-9 lg:left-9 lg:right-9 lg:m-0 xl:bottom-10 xl:left-10 xl:right-10 2xl:bottom-12 2xl:left-12 2xl:right-12",
          android
            ? "border-[#42bb5d] bg-[#35ad51] text-white group-hover:bg-[#40bd5d]"
            : "border-white/65 bg-black/20 text-white group-hover:border-white group-hover:bg-white group-hover:text-[#0b1013]",
        ].join(" ")}
      >
        Iniciar venta {platform}
        <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" strokeWidth={2} />
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
}: CreditPlatformSelectorProps) {
  const content = (
    <main className="min-w-0 bg-[#090d10] text-white">
      <header className="border-b border-white/10 bg-[#0a0e11]">
        <div className="mx-auto flex min-h-[72px] max-w-[1680px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10 xl:px-12">
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

      <div className="mx-auto max-w-[1680px] px-4 py-8 sm:px-6 lg:px-10 lg:py-10 xl:px-12 xl:py-12">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#58d878]">Nueva venta</p>
            <h1 className="mt-3 text-3xl font-black text-white sm:text-4xl xl:text-[42px]">
              Selecciona el tipo de equipo
            </h1>
            <p className="mt-3 text-base text-slate-400">
              Elige la plataforma para iniciar el flujo correcto de credito, firma y validacion.
            </p>
          </div>

          <Link
            href="/dashboard"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-lg border border-white/15 px-5 text-sm font-bold text-slate-200 transition hover:border-white/30 hover:bg-white/5"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Volver
          </Link>
        </div>

        <section className="mt-9 grid gap-6 lg:grid-cols-2">
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

        <section className="mt-7 grid rounded-lg border border-white/10 bg-white/[0.025] px-2 py-2 sm:grid-cols-3">
          <div className="flex min-h-20 items-center gap-4 px-5 py-3 sm:border-r sm:border-white/10 xl:px-7">
            <UserCheck className="h-7 w-7 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-base font-bold text-white">Validacion de identidad</p>
              <p className="mt-1 text-sm text-slate-500">Proceso seguro y verificable</p>
            </div>
          </div>
          <div className="flex min-h-20 items-center gap-4 border-y border-white/10 px-5 py-3 sm:border-y-0 sm:border-r xl:px-7">
            <FileSignature className="h-7 w-7 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-base font-bold text-white">Firma digital</p>
              <p className="mt-1 text-sm text-slate-500">Documentos con validez legal</p>
            </div>
          </div>
          <div className="flex min-h-20 items-center gap-4 px-5 py-3 xl:px-7">
            <ShieldCheck className="h-7 w-7 shrink-0 text-[#58d878]" strokeWidth={1.7} />
            <div>
              <p className="text-base font-bold text-white">Entrega controlada</p>
              <p className="mt-1 text-sm text-slate-500">Validacion antes del desembolso</p>
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
    <div className="min-h-screen bg-[#090d10] lg:grid lg:grid-cols-[270px_minmax(0,1fr)]">
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
