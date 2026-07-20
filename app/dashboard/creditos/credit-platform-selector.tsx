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
        "group relative isolate min-h-[800px] overflow-hidden rounded-lg border bg-white transition duration-200 hover:-translate-y-0.5 sm:min-h-[470px]",
        android
          ? "border-[#c9d9aa] border-t-[3px] border-t-[#87b90c] hover:border-[#87b90c] hover:shadow-[0_18px_42px_rgba(47,68,12,0.10)]"
          : "border-[#cfd4d8] border-t-[3px] border-t-[#7f878e] hover:border-[#959da3] hover:shadow-[0_18px_42px_rgba(17,24,39,0.09)]",
      ].join(" ")}
    >
      <div className="absolute bottom-24 left-0 top-[360px] w-full sm:inset-y-14 sm:left-auto sm:right-0 sm:w-[50%]">
        <Image
          src={imageSrc}
          alt={imageAlt}
          fill
          priority
          unoptimized
          sizes="(max-width: 1024px) 100vw, 760px"
          className="object-contain object-center transition duration-300 group-hover:scale-[1.015]"
        />
      </div>

      <div className="relative flex min-h-[800px] w-full flex-col p-7 pb-[500px] sm:min-h-[470px] sm:w-[50%] sm:p-8 sm:pb-24 xl:p-9 xl:pb-24">
        <span
          className={[
            "w-fit rounded-md px-3 py-2 text-[11px] font-extrabold uppercase",
            android
              ? "bg-[#eef5dc] text-[#668b05]"
              : "bg-[#f0f2f3] text-[#6b737a]",
          ].join(" ")}
        >
          {badge}
        </span>

        <h2 className="mt-7 text-4xl font-black text-[#15191d]">{platform}</h2>
        <p className="mt-3 max-w-[260px] text-base leading-6 text-[#68717a]">
          {android
            ? "Enrolamiento automatico con Trustonic y Zero Touch."
            : "Validacion guiada y enrolamiento verificado."}
        </p>

        <div className="mt-7 max-w-[250px] space-y-4 border-t border-[#dfe3e5] pt-6 text-sm leading-5 text-[#3f474e]">
          <span className="flex items-start gap-3">
            <ShieldCheck
              className={[
                "mt-0.5 h-5 w-5 shrink-0",
                android ? "text-[#7fa90c]" : "text-[#747d84]",
              ].join(" ")}
              strokeWidth={1.8}
            />
            {description}
          </span>
          <span className="flex items-start gap-3">
            <BadgeCheck
              className={[
                "mt-0.5 h-5 w-5 shrink-0",
                android ? "text-[#7fa90c]" : "text-[#747d84]",
              ].join(" ")}
              strokeWidth={1.8}
            />
            {secondary}
          </span>
        </div>

      </div>

      <span
        className={[
          "absolute bottom-7 left-7 right-7 flex min-h-14 items-center justify-center gap-3 rounded-md border px-5 text-sm font-extrabold transition sm:bottom-8 sm:left-8 sm:right-8 xl:bottom-9 xl:left-9 xl:right-9",
          android
            ? "border-[#171d22] bg-[#171d22] text-white group-hover:border-[#87b90c]"
            : "border-[#2b3238] bg-white text-[#171d22] group-hover:border-[#87b90c]",
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
    <main className="min-w-0 bg-[#f4f5f3] text-[#15191d]">
      <header className="border-b border-[#dfe2e4] bg-white">
        <div className="mx-auto flex min-h-[72px] max-w-[1680px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10 xl:px-12">
          <div className="flex min-w-0 items-center gap-5">
            {!admin ? <FinserBrand compact showTagline={false} /> : null}
            <div className="flex items-center gap-2 text-sm">
              <span className="hidden text-[#4f5962] sm:inline">Ventas</span>
              <ChevronRight className="hidden h-4 w-4 text-[#a6adb2] sm:block" strokeWidth={1.8} />
              <span className="font-semibold text-[#6f9806]">Nueva venta</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-full border border-[#d6dadd] text-[#5f6870]">
              <CircleHelp className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <div className="hidden h-8 w-px bg-[#e2e5e7] sm:block" />
            <span className="grid h-9 w-9 place-items-center rounded-full bg-[#142331] text-xs font-bold text-white">
              {getInitials(nombreUsuario)}
            </span>
            <div className="hidden sm:block">
              <p className="max-w-40 truncate text-sm font-bold text-[#171b1f]">{nombreUsuario}</p>
              <p className="text-xs text-[#737c84]">{rolUsuario}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1540px] px-4 py-8 sm:px-6 lg:px-10 lg:py-10 xl:px-12 xl:py-11">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-extrabold uppercase text-[#719a08]">Nueva venta</p>
            <h1 className="mt-3 text-3xl font-black text-[#15191d] sm:text-4xl xl:text-[40px]">
              ¿Qué tipo de equipo vas a financiar?
            </h1>
            <p className="mt-3 text-base text-[#66707a]">
              Selecciona una plataforma para iniciar el flujo correspondiente.
            </p>
          </div>

          <Link
            href="/dashboard"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md px-3 text-sm font-bold text-[#59636c] transition hover:bg-[#e9ecec] hover:text-[#171b1f]"
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
            imageSrc="/assets/creditos/android-choice-light.png"
            platform="Android"
            secondary="Enrolamiento automatico del dispositivo"
          />
          <PlatformCard
            accent="iphone"
            badge="Nueva fabrica"
            description="Verificacion manual de enrolamiento"
            href={iphoneHref}
            imageAlt="iPhone con validacion segura"
            imageSrc="/assets/creditos/iphone-choice-light.png"
            platform="iPhone"
            secondary="Validacion guiada antes de continuar"
          />
        </section>

        <section className="mt-7 grid rounded-lg border border-[#d8dcdf] bg-white px-2 py-3 shadow-[0_5px_16px_rgba(17,24,39,0.04)] sm:grid-cols-[1.15fr_1fr_1fr_1fr]">
          <div className="flex min-h-20 items-center px-5 py-3 text-base font-extrabold text-[#20252a] sm:border-r sm:border-[#e1e4e6] xl:px-7">
            Todos los procesos incluyen
          </div>
          <div className="flex min-h-20 items-center gap-4 border-t border-[#e1e4e6] px-5 py-3 sm:border-r sm:border-t-0 xl:px-7">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#eef5dc] text-[#739b0a]"><UserCheck className="h-6 w-6" strokeWidth={1.7} /></span>
            <div>
              <p className="text-sm font-bold text-[#20252a]">Validacion de identidad</p>
              <p className="mt-1 text-xs text-[#747d85]">Proceso seguro y verificable</p>
            </div>
          </div>
          <div className="flex min-h-20 items-center gap-4 border-t border-[#e1e4e6] px-5 py-3 sm:border-r sm:border-t-0 xl:px-7">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#eef5dc] text-[#739b0a]"><FileSignature className="h-6 w-6" strokeWidth={1.7} /></span>
            <div>
              <p className="text-sm font-bold text-[#20252a]">Firma digital</p>
              <p className="mt-1 text-xs text-[#747d85]">Documentos con validez legal</p>
            </div>
          </div>
          <div className="flex min-h-20 items-center gap-4 border-t border-[#e1e4e6] px-5 py-3 sm:border-t-0 xl:px-7">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#eef5dc] text-[#739b0a]"><ShieldCheck className="h-6 w-6" strokeWidth={1.7} /></span>
            <div>
              <p className="text-sm font-bold text-[#20252a]">Entrega controlada</p>
              <p className="mt-1 text-xs text-[#747d85]">Validacion antes del desembolso</p>
            </div>
          </div>
        </section>

        <p className="mt-7 text-center text-xs text-[#98a0a6]">
          El flujo puede variar segun la plataforma seleccionada.
        </p>
      </div>
    </main>
  );

  if (!admin) {
    return <div className="min-h-screen bg-[#f4f5f3]">{content}</div>;
  }

  return (
    <div className="min-h-screen bg-[#f4f5f3] lg:grid lg:grid-cols-[270px_minmax(0,1fr)]">
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
