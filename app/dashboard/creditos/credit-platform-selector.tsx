import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
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

function PlatformCard({
  accent,
  badge,
  description,
  href,
  imageAlt,
  imageSrc,
  platform,
  secondary,
}: {
  accent: "android" | "iphone";
  badge: string;
  description: string;
  href: string;
  imageAlt: string;
  imageSrc: string;
  platform: string;
  secondary: string;
}) {
  const android = accent === "android";

  return (
    <Link
      href={href}
      className={[
        "group overflow-hidden rounded-lg border bg-[#0d1215] transition duration-200 hover:-translate-y-0.5",
        android
          ? "border-[#285c3a] hover:border-[#45c867] hover:shadow-[0_18px_55px_rgba(42,180,84,0.12)]"
          : "border-white/15 hover:border-white/35 hover:shadow-[0_18px_55px_rgba(255,255,255,0.07)]",
      ].join(" ")}
    >
      <div className="aspect-[16/9] overflow-hidden border-b border-white/10 bg-black">
        <Image
          src={imageSrc}
          alt={imageAlt}
          width={1536}
          height={1024}
          priority
          unoptimized
          sizes="(max-width: 1024px) 100vw, 50vw"
          className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.015]"
        />
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p
              className={[
                "text-[11px] font-bold uppercase",
                android ? "text-[#58d878]" : "text-slate-400",
              ].join(" ")}
            >
              {badge}
            </p>
            <h2 className="mt-1 text-2xl font-black text-white">{platform}</h2>
          </div>
          <span
            className={[
              "grid h-10 w-10 place-items-center rounded-lg border",
              android
                ? "border-[#45c867]/30 bg-[#45c867]/10 text-[#58d878]"
                : "border-white/15 bg-white/5 text-white",
            ].join(" ")}
          >
            <Smartphone className="h-5 w-5" strokeWidth={1.8} />
          </span>
        </div>

        <div className="mt-5 grid gap-3 border-t border-white/10 pt-4 text-sm text-slate-300 sm:grid-cols-2">
          <span className="flex items-start gap-2">
            <ShieldCheck
              className={[
                "mt-0.5 h-4 w-4 shrink-0",
                android ? "text-[#58d878]" : "text-slate-300",
              ].join(" ")}
              strokeWidth={1.9}
            />
            {description}
          </span>
          <span className="flex items-start gap-2">
            <BadgeCheck
              className={[
                "mt-0.5 h-4 w-4 shrink-0",
                android ? "text-[#58d878]" : "text-slate-300",
              ].join(" ")}
              strokeWidth={1.9}
            />
            {secondary}
          </span>
        </div>

        <span
          className={[
            "mt-5 flex min-h-12 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-bold transition",
            android
              ? "border-[#38b957] bg-[#30a94d] text-white group-hover:bg-[#38b957]"
              : "border-white/60 bg-transparent text-white group-hover:border-white group-hover:bg-white group-hover:text-[#0b1013]",
          ].join(" ")}
        >
          Iniciar venta {platform}
          <ArrowRight className="h-4 w-4" strokeWidth={2} />
        </span>
      </div>
    </Link>
  );
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
    <main className="min-w-0 bg-[#090d10] px-4 py-5 text-white sm:px-6 lg:px-8 lg:py-7">
      {!admin ? (
        <header className="mx-auto mb-7 flex max-w-[1240px] items-center justify-between gap-4 border-b border-white/10 pb-5">
          <FinserBrand compact dark showTagline={false} />
          <Link
            href="/dashboard"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-bold text-slate-200 transition hover:border-white/30 hover:bg-white/5"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            Dashboard
          </Link>
        </header>
      ) : null}

      <div className="mx-auto max-w-[1240px]">
        <div className="flex flex-col gap-5 border-b border-white/10 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase text-[#58d878]">Nueva venta</p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              Selecciona el tipo de equipo
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              {sedeNombre} | El flujo se ajusta a la plataforma seleccionada.
            </p>
          </div>

          {admin ? (
            <Link
              href="/dashboard"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/15 px-4 text-sm font-bold text-slate-200 transition hover:border-white/30 hover:bg-white/5"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={2} />
              Volver
            </Link>
          ) : null}
        </div>

        <section className="mt-6 grid gap-5 lg:grid-cols-2">
          <PlatformCard
            accent="android"
            badge="Fabrica actual"
            description="Trustonic / Zero Touch"
            href={androidHref}
            imageAlt="Telefono Android para nueva venta"
            imageSrc="/assets/creditos/android-choice.png"
            platform="Android"
            secondary="Enrolamiento automatico"
          />
          <PlatformCard
            accent="iphone"
            badge="Nueva fabrica"
            description="Validacion manual"
            href={iphoneHref}
            imageAlt="iPhone para nueva venta"
            imageSrc="/assets/creditos/iphone-choice.png"
            platform="iPhone"
            secondary="Enrolamiento guiado"
          />
        </section>

        <section className="mt-6 grid border-y border-white/10 py-5 sm:grid-cols-3">
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
