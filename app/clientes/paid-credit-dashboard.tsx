"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import FinserBrand from "@/app/_components/finser-brand";
import FinserSupportLink from "@/app/_components/finser-support-link";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  CreditCard,
  Download,
  Gift,
  Headphones,
  Home,
  Medal,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { FINSER_PAY_SUPPORT_DISPLAY } from "@/lib/support";

export type PaidCreditPanel = "payments" | "pending" | "history" | null;

export type PaidCreditDashboardCredit = {
  id: number;
  folio: string;
  referenciaEquipo: string | null;
  imei?: string | null;
  deviceUid?: string | null;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  saldoPendiente: number;
  pazYSalvoEmitidoAt?: string | null;
  totalPagado: number;
  cuotas: Array<{
    numero: number;
    estado: "PAGO" | "PENDIENTE";
    saldoPendiente: number;
  }>;
  abonos: Array<{
    id: number;
    valor: number;
    metodoPago: string;
    fechaAbono: string;
  }>;
};

type PaidCreditDashboardProps = {
  activePanel: PaidCreditPanel;
  credit: PaidCreditDashboardCredit;
  credits: PaidCreditDashboardCredit[];
  firstName: string;
  newCreditSupportMessage: string;
  notice?: { text: string; tone: "emerald" | "red" } | null;
  onForgetDocument: () => void;
  onHome: () => void;
  onOpenPanel: (panel: Exclude<PaidCreditPanel, null>) => void;
  onSelectCredit: (creditId: number) => void;
  pazYSalvoHref: string;
  profileInitials: string;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const confetti: Array<CSSProperties> = [
  { left: "4%", top: "18%", transform: "rotate(28deg)" },
  { left: "12%", top: "68%", transform: "rotate(72deg)" },
  { left: "22%", top: "8%", transform: "rotate(-18deg)" },
  { left: "28%", top: "82%", transform: "rotate(18deg)" },
  { right: "26%", top: "10%", transform: "rotate(58deg)" },
  { right: "11%", top: "30%", transform: "rotate(-34deg)" },
  { right: "5%", top: "67%", transform: "rotate(16deg)" },
  { right: "23%", top: "86%", transform: "rotate(-62deg)" },
];

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function shortDate(value: string | null | undefined) {
  if (!value) return "Finalizado";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Finalizado";

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) return "Hoy";

  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "short",
  })
    .format(date)
    .replace(".", "");
}

function creditTitle(credit: PaidCreditDashboardCredit) {
  return credit.referenciaEquipo || `Crédito ${credit.folio}`;
}

function creditDeviceImage(credit: PaidCreditDashboardCredit) {
  const reference = String(credit.referenciaEquipo || "").toUpperCase();
  return /IPHONE|APPLE|IOS/.test(reference)
    ? "/assets/creditos/iphone-choice-light.png"
    : "/assets/creditos/android-choice-light.png";
}

function creditStateLabel(credit: PaidCreditDashboardCredit) {
  if (credit.estadoPago === "PAGADO") return "Finalizado";
  if (credit.estadoPago === "MORA") return "En mora";
  return "Al día";
}

export default function PaidCreditDashboard({
  activePanel,
  credit,
  credits,
  firstName,
  newCreditSupportMessage,
  notice,
  onForgetDocument,
  onHome,
  onOpenPanel,
  onSelectCredit,
  pazYSalvoHref,
  profileInitials,
}: PaidCreditDashboardProps) {
  const lastPayment = credit.abonos[0] || null;
  const completionDate = shortDate(
    credit.pazYSalvoEmitidoAt || lastPayment?.fechaAbono
  );
  const paidInstallments = credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  ).length;
  const paymentPanelActive =
    activePanel === "payments" || activePanel === "pending";

  return (
    <main
      id="cliente-dashboard"
      className="min-h-[100svh] overflow-x-hidden bg-[var(--fp-bg)] text-white"
    >
      <div className="relative mx-auto min-h-[100svh] w-full max-w-[430px] overflow-hidden bg-[#080b0d] px-5 pb-[calc(122px+env(safe-area-inset-bottom))] pt-[calc(18px+env(safe-area-inset-top))] shadow-[0_0_60px_rgba(13,17,18,0.22)]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(circle_at_48%_32%,rgba(183,230,61,0.08),transparent_54%)]"
        />

        <header className="relative z-10 flex items-center justify-between gap-3">
          <FinserBrand mini dark accentPay showTagline={false} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Ver historial"
              onClick={() => onOpenPanel("history")}
              className="relative grid h-12 w-12 place-items-center rounded-full text-white transition hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
            >
              <Bell className="h-7 w-7" strokeWidth={1.9} />
              <span className="absolute right-2.5 top-2 h-3 w-3 rounded-full bg-[var(--fp-lime)] shadow-[0_0_14px_rgba(183,230,61,0.8)]" />
            </button>
            <button
              type="button"
              aria-label="Cambiar cliente"
              onClick={onForgetDocument}
              className="grid h-12 w-12 place-items-center rounded-full border border-white/12 bg-white/7 text-[16px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
            >
              {profileInitials}
            </button>
          </div>
        </header>

        {notice ? (
          <div
            role={notice.tone === "red" ? "alert" : "status"}
            className={[
              "relative z-10 mt-4 rounded-[var(--fp-radius-lg)] border px-4 py-3 text-sm font-bold",
              notice.tone === "emerald"
                ? "border-[color-mix(in_srgb,var(--fp-lime)_45%,transparent)] bg-[color-mix(in_srgb,var(--fp-lime)_12%,transparent)] text-[#e5f8aa]"
                : "border-red-400/30 bg-red-400/10 text-red-100",
            ].join(" ")}
          >
            {notice.text}
          </div>
        ) : null}

        <section className="relative z-10 mt-7" aria-labelledby="paid-credit-title">
          <h1 className="text-[28px] font-medium leading-tight tracking-[-0.02em] text-white">
            Hola, {firstName}
          </h1>
          <p className="mt-3 inline-flex min-h-10 items-center gap-3 text-[18px] font-bold text-[var(--fp-lime)]">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--fp-lime)] text-[#0a0d0f] shadow-[0_0_20px_rgba(183,230,61,0.34)]">
              <Check className="h-5 w-5" strokeWidth={3.2} aria-hidden="true" />
            </span>
            Crédito pagado
          </p>

          <div className="mt-5 overflow-hidden rounded-[var(--fp-radius-lg)] border border-white/12 bg-[linear-gradient(145deg,rgba(21,26,33,0.88),rgba(6,9,11,0.94))] p-4 shadow-[0_22px_60px_rgba(0,0,0,0.3)]">
            <div className="grid items-center gap-4 min-[370px]:grid-cols-[160px_minmax(0,1fr)]">
              <div className="relative mx-auto grid h-[168px] w-[168px] place-items-center" aria-hidden="true">
                {confetti.map((style, index) => (
                  <span
                    key={index}
                    className={[
                      "absolute h-2 w-3 rounded-sm",
                      index % 3 === 0
                        ? "bg-white/85"
                        : index % 3 === 1
                          ? "bg-[var(--fp-lime)]"
                          : "bg-white/35",
                    ].join(" ")}
                    style={style}
                  />
                ))}
                <span className="absolute h-[132px] w-[132px] rounded-full border-[10px] border-[var(--fp-lime)] shadow-[0_0_32px_rgba(183,230,61,0.42),inset_0_0_26px_rgba(183,230,61,0.12)]" />
                <span className="grid h-[76px] w-[76px] place-items-center rounded-full bg-[var(--fp-lime)] text-white shadow-[0_0_28px_rgba(183,230,61,0.48)]">
                  <Check className="h-11 w-11" strokeWidth={3.1} />
                </span>
              </div>

              <div className="text-center min-[370px]:text-left">
                <p className="text-[17px] font-black uppercase tracking-[-0.02em] text-white">
                  ¡Felicitaciones!
                </p>
                <h2
                  id="paid-credit-title"
                  className="mt-2 text-[23px] font-medium leading-[1.06] tracking-[-0.02em] text-white"
                >
                  Tu crédito ha sido
                  <span className="mt-1 block text-[38px] font-black leading-none text-[var(--fp-lime)]">
                    PAGADO
                  </span>
                  <span className="mt-1 block text-[23px] font-semibold">
                    en su totalidad
                  </span>
                </h2>
                <span className="mx-auto mt-3 block h-0.5 w-20 bg-[var(--fp-lime)] min-[370px]:mx-0" />
                <p className="mt-4 text-[15px] font-medium leading-5 text-white/72">
                  Gracias por tu compromiso. Sigue así y accede a
                  <span className="text-[var(--fp-lime)]"> más beneficios.</span>
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-3 border-t border-white/10 pt-4">
              <div className="grid min-w-0 justify-items-center gap-2 px-1 text-center min-[390px]:grid-cols-[28px_1fr] min-[390px]:items-center min-[390px]:text-left">
                <ShieldCheck className="h-7 w-7 text-[var(--fp-lime)]" aria-hidden="true" />
                <p className="text-[11px] font-medium leading-4 text-white/82">
                  Cumpliste <span className="block text-[var(--fp-lime)]">tu compromiso</span>
                </p>
              </div>
              <div className="grid min-w-0 justify-items-center gap-2 border-x border-white/10 px-1 text-center min-[390px]:grid-cols-[28px_1fr] min-[390px]:items-center min-[390px]:text-left">
                <Medal className="h-7 w-7 text-[var(--fp-lime)]" aria-hidden="true" />
                <p className="text-[11px] font-medium leading-4 text-white/82">
                  Eres un cliente <span className="block text-[var(--fp-lime)]">confiable</span>
                </p>
              </div>
              <div className="grid min-w-0 justify-items-center gap-2 px-1 text-center min-[390px]:grid-cols-[28px_1fr] min-[390px]:items-center min-[390px]:text-left">
                <Gift className="h-7 w-7 text-[var(--fp-lime)]" aria-hidden="true" />
                <p className="text-[11px] font-medium leading-4 text-white/82">
                  Accede a mejores <span className="block text-[var(--fp-lime)]">beneficios</span>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="relative z-10 mt-4 grid gap-3" aria-label="Acciones del crédito finalizado">
          <a
            href={pazYSalvoHref}
            download
            aria-label="Descargar paz y salvo del crédito"
            className="grid min-h-[68px] grid-cols-[48px_minmax(0,1fr)_24px] items-center gap-3 rounded-full bg-[var(--fp-lime)] px-4 text-[#0a0d0f] shadow-[0_18px_42px_rgba(183,230,61,0.22)] transition hover:brightness-105 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#080b0d]"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[#080b0d] text-white">
              <Download className="h-7 w-7" aria-hidden="true" />
            </span>
            <span className="text-[19px] font-black leading-tight">
              Descargar paz y salvo
            </span>
            <ChevronRight className="h-7 w-7" strokeWidth={2.5} aria-hidden="true" />
          </a>

          <FinserSupportLink
            supportMessage={newCreditSupportMessage}
            supportAriaLabel="Solicitar un nuevo crédito por WhatsApp"
            className="grid min-h-[68px] grid-cols-[48px_minmax(0,1fr)_24px] items-center gap-3 rounded-full border border-white/14 bg-white/5 px-4 text-white transition hover:border-white/24 hover:bg-white/8 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full border border-white/70 bg-[#25D366] text-white shadow-[0_8px_24px_rgba(37,211,102,0.2)]">
              <MessageCircle className="h-7 w-7 fill-white/15" aria-hidden="true" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-[18px] font-black leading-tight">
                Solicitar nuevo crédito
              </span>
              <span className="mt-1 block text-[14px] font-medium text-white/62">
                WhatsApp {FINSER_PAY_SUPPORT_DISPLAY}
              </span>
            </span>
            <ChevronRight className="h-7 w-7" strokeWidth={2.2} aria-hidden="true" />
          </FinserSupportLink>
        </section>

        {credits.length > 1 ? (
          <section className="relative z-10 mt-4" aria-label="Seleccionar crédito">
            <div className="flex gap-3 overflow-x-auto pb-1">
              {credits.map((item, index) => {
                const selected = item.id === credit.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectCredit(item.id)}
                    className={[
                      "min-h-[64px] min-w-[190px] rounded-[var(--fp-radius-lg)] border px-4 py-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]",
                      selected
                        ? "border-[var(--fp-lime)] bg-[color-mix(in_srgb,var(--fp-lime)_9%,transparent)]"
                        : "border-white/12 bg-white/4",
                    ].join(" ")}
                  >
                    <span className="block text-[11px] font-black uppercase tracking-[0.12em] text-[var(--fp-lime)]">
                      Crédito {index + 1} · {creditStateLabel(item)}
                    </span>
                    <span className="mt-1 block truncate text-sm font-black text-white">
                      {creditTitle(item)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        <button
          type="button"
          onClick={() => onOpenPanel("history")}
          aria-label={`Ver historial de ${creditTitle(credit)}`}
          className="relative z-10 mt-4 grid min-h-[88px] w-full grid-cols-[72px_minmax(0,1fr)_28px] items-center gap-3 rounded-[var(--fp-radius-lg)] border border-white/14 bg-white/4 px-3 text-left transition hover:bg-white/7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
        >
          <span className="grid h-[72px] w-[72px] place-items-center overflow-hidden rounded-[var(--fp-radius-md)] bg-white/94">
            <Image
              src={creditDeviceImage(credit)}
              alt=""
              width={68}
              height={68}
              aria-hidden="true"
              className="h-[68px] w-[68px] object-contain"
            />
          </span>
          <span className="min-w-0">
            <span className="block text-[16px] font-medium text-white/55">Tu crédito</span>
            <span className="mt-1 block break-words text-[18px] font-black uppercase leading-tight text-white">
              {creditTitle(credit)}
            </span>
          </span>
          <ChevronRight className="h-7 w-7 text-white/50" aria-hidden="true" />
        </button>

        <section className="relative z-10 mt-6" aria-labelledby="paid-activity-title">
          <div className="flex flex-col items-start gap-1 min-[360px]:flex-row min-[360px]:items-center min-[360px]:justify-between min-[360px]:gap-3">
            <h2 id="paid-activity-title" className="text-[28px] font-black tracking-[-0.02em] text-white">
              Actividad
            </h2>
            <div className="flex w-full items-center justify-between gap-2 text-[13px] font-medium text-white/80 min-[360px]:w-auto min-[360px]:justify-start min-[380px]:gap-3 min-[380px]:text-[14px]">
              <button
                type="button"
                onClick={() => onOpenPanel("pending")}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
              >
                <CalendarDays className="h-5 w-5" aria-hidden="true" />
                Calendario
              </button>
              <span className="h-6 w-px bg-white/12" />
              <FinserSupportLink className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]">
                <Headphones className="h-5 w-5" aria-hidden="true" />
                Soporte
              </FinserSupportLink>
            </div>
          </div>

          <div className="mt-3 grid min-h-[92px] grid-cols-[48px_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--fp-radius-lg)] border border-white/12 bg-white/4 px-4 py-3">
            <span className="grid h-11 w-11 place-items-center rounded-full border-2 border-[var(--fp-lime)] text-[var(--fp-lime)] shadow-[0_0_18px_rgba(183,230,61,0.16)]">
              <Check className="h-6 w-6" strokeWidth={2.8} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-[17px] font-black text-white">Crédito finalizado</span>
              <span className="mt-1 block text-[14px] font-medium leading-5 text-white/62">
                ¡Lo lograste! Tu crédito fue pagado en su totalidad.
              </span>
            </span>
            <span className="self-start pt-2 text-sm font-black text-[var(--fp-lime)]">
              {completionDate}
            </span>
          </div>
        </section>

        {activePanel ? (
          <section
            id="explora-panel"
            className="relative z-10 mt-4 rounded-[var(--fp-radius-lg)] border border-white/12 bg-[#101419] p-4 shadow-[0_18px_44px_rgba(0,0,0,0.24)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--fp-lime)]">
                  Crédito finalizado
                </p>
                <h2 className="mt-1 text-xl font-black text-white">
                  {activePanel === "history"
                    ? "Historial de pagos"
                    : activePanel === "pending"
                      ? "Calendario completado"
                      : "Obligación cerrada"}
                </h2>
              </div>
              <button
                type="button"
                onClick={onHome}
                className="min-h-10 rounded-[var(--fp-radius-md)] border border-white/12 px-3 text-xs font-black text-white/72 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
              >
                Cerrar
              </button>
            </div>

            {activePanel === "history" ? (
              <div className="mt-4 grid gap-2">
                {credit.abonos.length ? (
                  credit.abonos.map((payment) => (
                    <div
                      key={payment.id}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-[var(--fp-radius-md)] bg-white/5 px-3 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-black text-white">
                          {payment.metodoPago}
                        </span>
                        <span className="mt-1 block text-xs font-medium text-white/48">
                          {shortDate(payment.fechaAbono)} · Pago confirmado
                        </span>
                      </span>
                      <span className="text-sm font-black text-white">
                        {money(payment.valor)}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="rounded-[var(--fp-radius-md)] bg-white/5 px-3 py-4 text-sm font-medium text-white/60">
                    No hay pagos registrados.
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-[var(--fp-radius-md)] bg-white/5 px-2 py-3">
                  <p className="text-[11px] font-bold text-white/48">Cuotas</p>
                  <p className="mt-1 text-base font-black text-white">
                    {paidInstallments}/{credit.cuotas.length}
                  </p>
                </div>
                <div className="rounded-[var(--fp-radius-md)] bg-white/5 px-2 py-3">
                  <p className="text-[11px] font-bold text-white/48">Saldo</p>
                  <p className="mt-1 text-base font-black text-white">{money(0)}</p>
                </div>
                <div className="rounded-[var(--fp-radius-md)] bg-white/5 px-2 py-3">
                  <p className="text-[11px] font-bold text-white/48">Estado</p>
                  <p className="mt-1 text-base font-black text-[var(--fp-lime)]">Pagado</p>
                </div>
              </div>
            )}
          </section>
        ) : null}

        <section className="relative z-10 mt-4 overflow-hidden rounded-[var(--fp-radius-lg)] border border-white/10 bg-[radial-gradient(circle_at_85%_50%,rgba(183,230,61,0.24),transparent_34%),linear-gradient(110deg,#101519,#07100a)] px-5 py-5" aria-label="Nuevos beneficios">
          <div className="grid grid-cols-[minmax(0,1fr)_86px] items-center gap-3">
            <div>
              <span className="inline-flex rounded-full bg-[color-mix(in_srgb,var(--fp-lime)_16%,transparent)] px-3 py-1 text-[11px] font-black uppercase tracking-[0.08em] text-[var(--fp-lime)]">
                Nuevos beneficios
              </span>
              <p className="mt-3 text-[19px] font-bold leading-6 text-white">
                Ahora puedes acceder a
                <span className="block text-[24px] font-black leading-7 text-[var(--fp-lime)]">
                  mejores oportunidades
                </span>
              </p>
              <p className="mt-2 text-sm font-medium text-white/70">
                Gracias por ser parte de <span className="font-black text-[var(--fp-lime)]">FINSER PAY</span>
              </p>
            </div>
            <div className="relative grid h-[86px] w-[86px] place-items-center rounded-full bg-[radial-gradient(circle,rgba(183,230,61,0.32),transparent_68%)] text-[var(--fp-lime)]" aria-hidden="true">
              <Gift className="h-16 w-16 drop-shadow-[0_0_18px_rgba(183,230,61,0.34)]" strokeWidth={1.4} />
              <span className="absolute left-1 top-3 h-2 w-2 rotate-12 rounded-sm bg-white/80" />
              <span className="absolute right-0 top-1 h-2 w-3 -rotate-12 rounded-sm bg-[var(--fp-lime)]" />
              <span className="absolute -right-1 bottom-4 h-2 w-2 rotate-45 rounded-sm bg-white/40" />
            </div>
          </div>
        </section>
      </div>

      <nav className="fixed bottom-0 left-1/2 z-30 w-full max-w-[430px] -translate-x-1/2 px-5 pb-[calc(8px+env(safe-area-inset-bottom))]" aria-label="Navegación principal">
        <div className="grid min-h-[82px] grid-cols-4 items-center rounded-[28px] border border-white/12 bg-[#15191c]/96 px-2 py-2 shadow-[0_-14px_34px_rgba(0,0,0,0.34)] backdrop-blur-xl">
          <button
            type="button"
            onClick={onHome}
            aria-current={activePanel === null ? "page" : undefined}
            className={[
              "grid min-h-[62px] place-items-center gap-1 rounded-2xl text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]",
              activePanel === null ? "text-[var(--fp-lime)]" : "text-white/72",
            ].join(" ")}
          >
            <Home className={activePanel === null ? "h-7 w-7 fill-current" : "h-7 w-7"} strokeWidth={2} />
            Inicio
          </button>
          <button
            type="button"
            onClick={() => onOpenPanel("payments")}
            aria-current={paymentPanelActive ? "page" : undefined}
            className={[
              "grid min-h-[62px] place-items-center gap-1 rounded-2xl text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]",
              paymentPanelActive ? "text-[var(--fp-lime)]" : "text-white/72",
            ].join(" ")}
          >
            <CreditCard className="h-7 w-7" strokeWidth={2} />
            Pagos
          </button>
          <button
            type="button"
            onClick={() => onOpenPanel("history")}
            aria-current={activePanel === "history" ? "page" : undefined}
            className={[
              "grid min-h-[62px] place-items-center gap-1 rounded-2xl text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]",
              activePanel === "history" ? "text-[var(--fp-lime)]" : "text-white/72",
            ].join(" ")}
          >
            <Clock3 className="h-7 w-7" strokeWidth={2} />
            Historial
          </button>
          <button
            type="button"
            onClick={onForgetDocument}
            className="grid min-h-[62px] place-items-center gap-1 rounded-2xl text-[12px] font-medium text-white/72 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
          >
            <CircleUserRound className="h-7 w-7" strokeWidth={2} />
            Perfil
          </button>
        </div>
      </nav>
    </main>
  );
}
