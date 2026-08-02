"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import FinserBrand from "@/app/_components/finser-brand";
import FinserSupportLink from "@/app/_components/finser-support-link";
import {
  BadgeCheck,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleUserRound,
  Clock3,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Gem,
  Headphones,
  Home,
  MessageCircle,
  ShieldCheck,
  Smartphone,
  Trophy,
  WalletCards,
} from "lucide-react";
import { FINSER_PAY_SUPPORT_DISPLAY } from "@/lib/support";

export type PaidCreditPanel = "payments" | "pending" | "history" | null;

export type PaidCreditDashboardCredit = {
  id: number;
  folio: string;
  clienteDocumento: string | null;
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
  { left: "2%", top: "19%", transform: "rotate(26deg)" },
  { left: "12%", top: "53%", transform: "rotate(70deg)" },
  { left: "27%", top: "4%", transform: "rotate(-18deg)" },
  { left: "30%", top: "82%", transform: "rotate(18deg)" },
  { right: "25%", top: "5%", transform: "rotate(58deg)" },
  { right: "6%", top: "24%", transform: "rotate(-34deg)" },
  { right: "1%", top: "65%", transform: "rotate(16deg)" },
  { right: "20%", top: "86%", transform: "rotate(-62deg)" },
];

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function paymentReceiptHref(
  creditId: number,
  paymentId: number,
  clientDocument: string | null,
  download = false
) {
  const search = new URLSearchParams({
    documento: clientDocument || "",
  });

  if (download) search.set("download", "1");

  return `/api/clientes/creditos/${creditId}/abonos/${paymentId}/recibo?${search.toString()}`;
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
  const paidInstallments = credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  ).length;
  const openInstallments = credit.cuotas.filter(
    (item) => item.estado !== "PAGO" && item.saldoPendiente > 0
  ).length;
  const paymentPanelActive =
    activePanel === "payments" || activePanel === "pending";

  return (
    <main
      id="cliente-dashboard"
      className="min-h-[100svh] overflow-x-hidden bg-[var(--fp-bg)] text-[#111317]"
    >
      <div className="relative mx-auto min-h-[100svh] w-full max-w-[430px] bg-white shadow-[0_0_60px_rgba(13,17,18,0.2)]">
        <section
          aria-labelledby="paid-credit-title"
          className="relative h-[342px] overflow-hidden bg-[#050708] px-5 pt-[calc(18px+env(safe-area-inset-top))] text-white"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_79%_48%,rgba(151,230,36,0.18),transparent_29%),radial-gradient(circle_at_48%_100%,rgba(255,255,255,0.04),transparent_42%)]"
          />

          <header className="relative z-20 flex items-center justify-between gap-3">
            <div className="shrink-0">
              <FinserBrand mini dark accentPay showTagline={false} />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Ver historial"
                onClick={() => onOpenPanel("history")}
                className="relative grid h-11 w-11 place-items-center rounded-full text-white transition hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
              >
                <Bell className="h-6 w-6" strokeWidth={1.9} aria-hidden="true" />
                <span className="absolute right-2 top-1.5 h-3 w-3 rounded-full border-2 border-[#050708] bg-[var(--fp-lime)]" />
              </button>
              <button
                type="button"
                aria-label={`Cambiar cliente: ${firstName}`}
                onClick={onForgetDocument}
                className="grid h-12 w-12 place-items-center rounded-full border border-[color-mix(in_srgb,var(--fp-lime)_45%,transparent)] bg-white/6 text-[16px] font-semibold text-white transition hover:bg-white/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fp-lime)]"
              >
                {profileInitials}
              </button>
            </div>
          </header>

          <div className="absolute inset-x-5 bottom-[43px] z-10 grid grid-cols-[minmax(0,1fr)_126px] items-end gap-1 min-[380px]:grid-cols-[minmax(0,1fr)_144px] min-[380px]:gap-2 min-[420px]:grid-cols-[minmax(0,1fr)_164px]">
            <div className="min-w-0 pb-1">
              <p className="text-[17px] font-black uppercase leading-tight tracking-[-0.035em] min-[380px]:text-[20px] min-[420px]:text-[22px]">
                ¡Felicitaciones!
              </p>
              <h1
                id="paid-credit-title"
                className="mt-2 text-[22px] font-semibold leading-[1.03] tracking-[-0.035em] min-[380px]:text-[24px] min-[420px]:text-[25px]"
              >
                Tu crédito ha sido
                <span className="mt-1 block text-[35px] font-black leading-none tracking-[-0.055em] text-[var(--fp-lime)] min-[380px]:text-[41px] min-[420px]:text-[49px]">
                  PAGADO
                </span>
              </h1>
              <p className="mt-3 max-w-[220px] text-[12.5px] font-medium leading-[1.45] text-white/76 min-[380px]:text-[14px]">
                Gracias por tu compromiso y por cumplir cada una de tus cuotas.
                <span className="text-[var(--fp-lime)]"> ¡Lo lograste!</span>
              </p>
            </div>

            <div className="relative h-[184px]" aria-hidden="true">
              {confetti.map((style, index) => (
                <span
                  key={index}
                  className={[
                    "absolute z-10 h-2 w-3 rounded-sm",
                    index % 3 === 0
                      ? "bg-white/90"
                      : index % 3 === 1
                        ? "bg-[var(--fp-lime)]"
                        : "bg-white/42",
                  ].join(" ")}
                  style={style}
                />
              ))}
              <span className="absolute bottom-0 left-1/2 h-8 w-[132px] -translate-x-1/2 rounded-[50%] bg-[linear-gradient(180deg,#24282b,#07090a)] shadow-[0_14px_20px_rgba(0,0,0,0.7)] min-[380px]:w-[144px] min-[420px]:w-[164px]" />
              <span className="absolute bottom-3 left-1/2 h-6 w-[112px] -translate-x-1/2 rounded-[50%] border-t border-white/18 bg-[#0d1012] min-[380px]:w-[130px] min-[420px]:w-[148px]" />
              <span className="absolute bottom-5 left-1/2 grid h-[116px] w-[116px] -translate-x-1/2 place-items-center rounded-full border-[7px] border-white bg-[radial-gradient(circle_at_50%_42%,#759d2a_0%,#31480f_48%,#132106_78%)] shadow-[0_0_18px_rgba(183,230,61,0.72),0_0_50px_rgba(133,214,27,0.44)] min-[380px]:h-[132px] min-[380px]:w-[132px] min-[420px]:h-[146px] min-[420px]:w-[146px] min-[420px]:border-[8px]">
                <Check className="h-14 w-14 text-white min-[380px]:h-16 min-[380px]:w-16 min-[420px]:h-[72px] min-[420px]:w-[72px]" strokeWidth={2.7} />
              </span>
            </div>
          </div>
        </section>

        <div className="relative z-20 -mt-[26px] rounded-t-[30px] bg-white px-4 pb-[calc(112px+env(safe-area-inset-bottom))] pt-6 min-[390px]:px-5">
          {notice ? (
            <div
              role={notice.tone === "red" ? "alert" : "status"}
              className={[
                "mb-4 rounded-[var(--fp-radius-md)] border px-4 py-3 text-sm font-bold",
                notice.tone === "emerald"
                  ? "border-[#b8d88f] bg-[#f2f9df] text-[#315e0f]"
                  : "border-red-200 bg-red-50 text-red-800",
              ].join(" ")}
            >
              {notice.text}
            </div>
          ) : null}

          <section
            aria-labelledby="preferred-customer-title"
            className="grid min-h-[104px] grid-cols-[56px_minmax(0,1fr)_46px] items-center gap-3 rounded-[22px] bg-[linear-gradient(105deg,#f2f8e9_0%,#f7faf3_60%,#eff5e7_100%)] px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] min-[390px]:grid-cols-[62px_minmax(0,1fr)_52px]"
          >
            <span className="grid h-14 w-14 place-items-center rounded-full bg-[var(--fp-lime)] text-[#122006] shadow-[0_0_24px_rgba(183,230,61,0.48)]">
              <BadgeCheck className="h-9 w-9" strokeWidth={1.9} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="preferred-customer-title" className="text-[16px] font-black leading-tight text-[#15181b] min-[390px]:text-[17px]">
                Ahora eres un
                <span className="mt-1 block text-[16px] leading-tight tracking-[-0.025em] text-[#3f7e0d] min-[390px]:whitespace-nowrap">
                  CLIENTE PREFERENCIAL
                </span>
              </h2>
              <p className="mt-2 text-[12px] font-medium leading-4 text-[#4d545c] min-[390px]:text-[13px]">
                Accede a mejores beneficios en tu próximo crédito.
              </p>
            </div>
            <Gem className="h-11 w-11 text-[#4c930f] min-[390px]:h-12 min-[390px]:w-12" strokeWidth={1.45} aria-hidden="true" />
          </section>

          <section className="mt-4 grid grid-cols-2 gap-3" aria-label="Acciones del crédito finalizado">
            <a
              href={pazYSalvoHref}
              download
              aria-label="Descargar paz y salvo del crédito"
              className="grid min-h-[104px] grid-cols-[42px_minmax(0,1fr)] items-center gap-2 rounded-[20px] bg-[var(--fp-lime)] px-3 py-4 text-[#0a0d0f] shadow-[0_14px_30px_rgba(153,205,39,0.18)] transition hover:brightness-105 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#284f0c] focus-visible:ring-offset-2"
            >
              <Download className="h-8 w-8 justify-self-center" strokeWidth={2.1} aria-hidden="true" />
              <span className="text-[15px] font-black leading-[1.25] min-[390px]:text-[16px]">
                Descargar
                <span className="block">Paz y Salvo</span>
              </span>
            </a>

            <FinserSupportLink
              supportMessage={newCreditSupportMessage}
              supportAriaLabel="Solicitar un nuevo crédito por WhatsApp"
              className="grid min-h-[104px] grid-cols-[38px_minmax(0,1fr)_18px] items-center gap-2 rounded-[20px] border border-[#cdd2d7] bg-white px-3 py-4 text-[#111317] transition hover:border-[#94af70] hover:bg-[#fbfdf8] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14] focus-visible:ring-offset-2"
            >
              <Smartphone className="h-8 w-8 justify-self-center" strokeWidth={1.9} aria-hidden="true" />
              <span className="text-[15px] font-black leading-[1.25] min-[390px]:text-[16px]">
                Solicitar nuevo
                <span className="block">crédito</span>
              </span>
              <ChevronRight className="h-5 w-5" strokeWidth={2.4} aria-hidden="true" />
            </FinserSupportLink>
          </section>

          {credits.length > 1 ? (
            <section className="mt-5" aria-label="Seleccionar crédito">
              <p className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-[#53606c]">
                Tus créditos
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {credits.map((item, index) => {
                  const selected = item.id === credit.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelectCredit(item.id)}
                      className={[
                        "min-h-[62px] min-w-[180px] rounded-[var(--fp-radius-md)] border px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]",
                        selected
                          ? "border-[#76a739] bg-[#f1f8e7]"
                          : "border-[#dde1e5] bg-white",
                      ].join(" ")}
                    >
                      <span className="block text-[10px] font-black uppercase tracking-[0.1em] text-[#4a8219]">
                        Crédito {index + 1} · {creditStateLabel(item)}
                      </span>
                      <span className="mt-1 block truncate text-sm font-black text-[#171a1d]">
                        {creditTitle(item)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}

          <section className="mt-6" aria-labelledby="credit-summary-title">
            <h2 id="credit-summary-title" className="text-[21px] font-black tracking-[-0.025em] text-[#111317]">
              Resumen de tu crédito
            </h2>
            <dl className="mt-3 grid grid-cols-2 overflow-hidden rounded-[22px] border border-[#e0e3e6] bg-white shadow-[0_10px_30px_rgba(18,24,30,0.035)] min-[380px]:grid-cols-4">
              <div className="grid min-h-[112px] content-center justify-items-center border-b border-r border-[#e1e4e7] px-2 py-4 text-center min-[380px]:border-b-0">
                <Check className="h-8 w-8 rounded-full border-2 border-[#4f9b13] p-1 text-[#4f9b13]" strokeWidth={2.8} aria-hidden="true" />
                <dd className="mt-2 text-[19px] font-black text-[#111317]">100%</dd>
                <dt className="mt-1 text-[11px] font-medium leading-4 text-[#59616a]">
                  Crédito pagado
                  <span className="block">en su totalidad</span>
                </dt>
              </div>
              <div className="grid min-h-[112px] content-center justify-items-center border-b border-[#e1e4e7] px-2 py-4 text-center min-[380px]:border-b-0 min-[380px]:border-r">
                <CalendarDays className="h-8 w-8 text-[#4f9b13]" strokeWidth={1.8} aria-hidden="true" />
                <dd className="mt-2 text-[19px] font-black text-[#111317]">{paidInstallments}</dd>
                <dt className="mt-1 text-[11px] font-medium leading-4 text-[#59616a]">
                  Cuotas pagadas
                  <span className="block">de <strong className="text-[#3d790e]">{credit.cuotas.length}</strong></span>
                </dt>
              </div>
              <div className="grid min-h-[112px] content-center justify-items-center border-r border-[#e1e4e7] px-2 py-4 text-center">
                <WalletCards className="h-8 w-8 text-[#4f9b13]" strokeWidth={1.8} aria-hidden="true" />
                <dd className="mt-2 whitespace-nowrap text-[14px] font-black tracking-[-0.03em] text-[#111317] min-[400px]:text-[15px]">
                  {money(credit.totalPagado)}
                </dd>
                <dt className="mt-1 text-[11px] font-medium leading-4 text-[#59616a]">
                  Total <strong className="text-[#3d790e]">cancelado</strong>
                </dt>
              </div>
              <div className="grid min-h-[112px] content-center justify-items-center px-2 py-4 text-center">
                <ShieldCheck className="h-8 w-8 text-[#4f9b13]" strokeWidth={1.8} aria-hidden="true" />
                <dd className="mt-2 text-[19px] font-black text-[#111317]">{openInstallments}</dd>
                <dt className="mt-1 text-[11px] font-medium leading-4 text-[#59616a]">
                  Pagos en mora
                  <strong className="block text-[#3d790e]">¡Excelente!</strong>
                </dt>
              </div>
            </dl>
          </section>

          <section
            aria-label="Ciclo de crédito completado"
            className="relative mt-5 min-h-[126px] overflow-hidden rounded-[22px] bg-[linear-gradient(105deg,#f8faf8_0%,#f4f6f4_68%,#f9fbf8_100%)] px-4 py-5 shadow-[0_12px_34px_rgba(18,24,30,0.04)]"
          >
            <div className="relative z-10 grid grid-cols-[58px_minmax(0,1fr)_62px] items-center gap-3 min-[390px]:grid-cols-[64px_minmax(0,1fr)_78px]">
              <span className="grid h-14 w-14 place-items-center rounded-full bg-[#dff2b5] text-[#17200f] min-[390px]:h-16 min-[390px]:w-16">
                <Trophy className="h-8 w-8 min-[390px]:h-9 min-[390px]:w-9" strokeWidth={1.8} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="text-[16px] font-black leading-tight text-[#15181b] min-[390px]:text-[17px]">
                  Cerraste este ciclo con éxito
                </h2>
                <p className="mt-2 text-[12px] font-medium leading-[1.45] text-[#4f565e] min-[390px]:text-[13px]">
                  Sigue así y continúa construyendo tu historial para lograr más.
                </p>
              </div>
              <div className="relative self-stretch" aria-hidden="true">
                <span className="absolute bottom-0 left-1/2 h-14 w-20 -translate-x-1/2 rounded-t-full bg-[var(--fp-lime)]/65" />
                <Image
                  src={creditDeviceImage(credit)}
                  alt=""
                  width={78}
                  height={106}
                  loading="eager"
                  className="absolute bottom-[-14px] left-1/2 h-[105px] w-[72px] -translate-x-1/2 object-contain drop-shadow-[0_8px_12px_rgba(0,0,0,0.18)]"
                />
                <span className="absolute right-0 top-0 text-lg text-[var(--fp-lime)]">✦</span>
                <span className="absolute left-0 top-5 text-sm text-[#67a620]">✦</span>
              </div>
            </div>
          </section>

          {activePanel ? (
            <section
              id="explora-panel"
              className="mt-5 rounded-[22px] border border-[#dfe3e7] bg-[#f8faf8] p-4 shadow-[0_12px_34px_rgba(18,24,30,0.05)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.13em] text-[#4c8419]">
                    Crédito finalizado
                  </p>
                  <h2 className="mt-1 text-[19px] font-black text-[#15181b]">
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
                  className="min-h-10 rounded-[var(--fp-radius-md)] border border-[#d4d9de] bg-white px-3 text-xs font-black text-[#46505a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]"
                >
                  Cerrar
                </button>
              </div>

              {activePanel === "history" ? (
                <div className="mt-4 grid gap-2">
                  {credit.abonos.length ? (
                    credit.abonos.map((payment) => {
                      const receiptHref = paymentReceiptHref(
                        credit.id,
                        payment.id,
                        credit.clienteDocumento
                      );
                      const receiptDownloadHref = paymentReceiptHref(
                        credit.id,
                        payment.id,
                        credit.clienteDocumento,
                        true
                      );
                      const receiptDescription = `${payment.metodoPago}, ${shortDate(payment.fechaAbono)}, ${money(payment.valor)}`;

                      return (
                        <article
                          key={payment.id}
                          className="overflow-hidden rounded-[var(--fp-radius-md)] border border-[#e1e5e8] bg-white"
                        >
                          <div className="grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-3">
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-black text-[#171a1d]">
                                {payment.metodoPago}
                              </span>
                              <span className="mt-1 block text-xs font-medium text-[#69727b]">
                                {shortDate(payment.fechaAbono)} · Pago confirmado
                              </span>
                            </span>
                            <span className="text-sm font-black text-[#171a1d]">
                              {money(payment.valor)}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 border-t border-[#e7eaed]">
                            <a
                              href={receiptHref}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Ver recibo del pago: ${receiptDescription}`}
                              className="inline-flex min-h-12 items-center justify-center gap-2 border-r border-[#e7eaed] px-2 text-xs font-black text-[#315f0f] transition hover:bg-[#f6faef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4b8b14]"
                            >
                              <FileText className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                              Ver recibo
                              <ExternalLink className="h-3.5 w-3.5" strokeWidth={2.1} aria-hidden="true" />
                            </a>
                            <a
                              href={receiptDownloadHref}
                              download
                              aria-label={`Descargar recibo del pago: ${receiptDescription}`}
                              className="inline-flex min-h-12 items-center justify-center gap-2 px-2 text-xs font-black text-[#171a1d] transition hover:bg-[#f6faef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#4b8b14]"
                            >
                              <Download className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
                              Descargar
                            </a>
                          </div>
                        </article>
                      );
                    })
                  ) : (
                    <p className="rounded-[var(--fp-radius-md)] bg-white px-3 py-4 text-sm font-medium text-[#66717b]">
                      No hay pagos registrados.
                    </p>
                  )}
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-[var(--fp-radius-md)] bg-white px-2 py-3">
                    <p className="text-[11px] font-bold text-[#707982]">Cuotas</p>
                    <p className="mt-1 text-base font-black text-[#171a1d]">
                      {paidInstallments}/{credit.cuotas.length}
                    </p>
                  </div>
                  <div className="rounded-[var(--fp-radius-md)] bg-white px-2 py-3">
                    <p className="text-[11px] font-bold text-[#707982]">Saldo</p>
                    <p className="mt-1 text-base font-black text-[#171a1d]">{money(0)}</p>
                  </div>
                  <div className="rounded-[var(--fp-radius-md)] bg-white px-2 py-3">
                    <p className="text-[11px] font-bold text-[#707982]">Estado</p>
                    <p className="mt-1 text-base font-black text-[#3d790e]">Pagado</p>
                  </div>
                </div>
              )}
            </section>
          ) : null}

          <FinserSupportLink
            className="mt-5 grid min-h-[90px] grid-cols-[48px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-[22px] border border-[#dfe3e7] bg-white px-4 py-4 text-[#111317] shadow-[0_10px_28px_rgba(18,24,30,0.035)] transition hover:border-[#a8bf87] hover:bg-[#fbfdf8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14] min-[410px]:grid-cols-[48px_minmax(0,1fr)_auto]"
          >
            <span className="grid h-12 w-12 place-items-center rounded-full bg-[#f3f5f4] text-[#111317]">
              <Headphones className="h-7 w-7" strokeWidth={1.9} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-[15px] font-black">¿Necesitas ayuda?</span>
              <span className="mt-1 block text-[13px] font-medium text-[#6b737b]">Estamos aquí para ti</span>
            </span>
            <span className="col-start-2 inline-flex min-h-11 items-center gap-2 whitespace-nowrap rounded-full border border-[#e0e4e7] px-3 text-[14px] font-black min-[410px]:col-start-auto">
              <MessageCircle className="h-7 w-7 fill-[#25D366]/15 text-[#25B85B]" aria-hidden="true" />
              {FINSER_PAY_SUPPORT_DISPLAY}
              <ChevronRight className="h-5 w-5" strokeWidth={2.3} aria-hidden="true" />
            </span>
          </FinserSupportLink>
        </div>
      </div>

      <nav
        className="fixed bottom-0 left-1/2 z-40 w-full max-w-[430px] -translate-x-1/2 border-t border-[#e5e8eb] bg-white/96 px-3 pb-[calc(7px+env(safe-area-inset-bottom))] pt-2 shadow-[0_-12px_34px_rgba(18,24,30,0.08)] backdrop-blur-xl"
        aria-label="Navegación principal"
      >
        <div className="grid min-h-[74px] grid-cols-4 items-center">
          <button
            type="button"
            onClick={onHome}
            aria-current={activePanel === null ? "page" : undefined}
            className={[
              "grid min-h-[60px] place-items-center gap-1 rounded-2xl text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]",
              activePanel === null ? "text-[#4d9513]" : "text-[#171a1d]",
            ].join(" ")}
          >
            <Home className={activePanel === null ? "h-7 w-7 fill-current" : "h-7 w-7"} strokeWidth={2} aria-hidden="true" />
            Inicio
          </button>
          <button
            type="button"
            onClick={() => onOpenPanel("payments")}
            aria-current={paymentPanelActive ? "page" : undefined}
            className={[
              "grid min-h-[60px] place-items-center gap-1 rounded-2xl text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]",
              paymentPanelActive ? "text-[#4d9513]" : "text-[#171a1d]",
            ].join(" ")}
          >
            <CreditCard className="h-7 w-7" strokeWidth={2} aria-hidden="true" />
            Pagos
          </button>
          <button
            type="button"
            onClick={() => onOpenPanel("history")}
            aria-current={activePanel === "history" ? "page" : undefined}
            className={[
              "grid min-h-[60px] place-items-center gap-1 rounded-2xl text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]",
              activePanel === "history" ? "text-[#4d9513]" : "text-[#171a1d]",
            ].join(" ")}
          >
            <Clock3 className="h-7 w-7" strokeWidth={2} aria-hidden="true" />
            Historial
          </button>
          <button
            type="button"
            onClick={onForgetDocument}
            className="grid min-h-[60px] place-items-center gap-1 rounded-2xl text-[11px] font-medium text-[#171a1d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4b8b14]"
          >
            <CircleUserRound className="h-7 w-7" strokeWidth={2} aria-hidden="true" />
            Perfil
          </button>
        </div>
        <span
          aria-hidden="true"
          className={[
            "absolute bottom-[calc(4px+env(safe-area-inset-bottom))] h-1 w-10 rounded-full bg-[var(--fp-lime)] transition-transform",
            activePanel === null
              ? "left-[calc(12.5%-20px)]"
              : paymentPanelActive
                ? "left-[calc(37.5%-20px)]"
                : activePanel === "history"
                  ? "left-[calc(62.5%-20px)]"
                  : "hidden",
          ].join(" ")}
        />
      </nav>
    </main>
  );
}
