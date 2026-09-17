"use client";
import { creditDisplayNumber } from "@/lib/credit-display-number";

import { useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import Image from "next/image";
import { ProgressBar } from "@/app/_components/finser-ui";
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
  ExternalLink,
  FileText,
  Home,
  Smartphone,
} from "lucide-react";
import styles from "./client-active-credit-dashboard.module.css";
import paidStyles from "./paid-credit-dashboard.module.css";
import { fetchClientPdf } from "@/lib/client-document-download";
import {
  COLOMBIA_TIME_ZONE,
  isSameColombiaDate,
  parseColombiaDate,
} from "@/lib/colombia-date";

export type PaidCreditPanel = "payments" | "pending" | "history" | null;

export type PaidCreditDashboardCredit = {
  id: number;
  folio: string;
  numeroCreditoVisible?: string;
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
  const date = parseColombiaDate(value);
  if (Number.isNaN(date.getTime())) return "Finalizado";

  const now = new Date();
  const isToday = isSameColombiaDate(date, now);

  if (isToday) return "Hoy";

  return new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "short",
    timeZone: COLOMBIA_TIME_ZONE,
  })
    .format(date)
    .replace(".", "");
}

function creditTitle(credit: PaidCreditDashboardCredit) {
  return credit.referenciaEquipo || `Crédito ${creditDisplayNumber(credit)}`;
}

function creditStateLabel(credit: PaidCreditDashboardCredit) {
  if (credit.estadoPago === "PAGADO") return "Finalizado";
  if (credit.estadoPago === "MORA") return "En mora";
  return "Al día";
}

function triggerBrowserDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
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
  const pazYSalvoDownloadLock = useRef(false);
  const [pazYSalvoDownloading, setPazYSalvoDownloading] = useState(false);
  const [pazYSalvoFeedback, setPazYSalvoFeedback] = useState<{
    text: string;
    tone: "amber" | "emerald" | "red";
  } | null>(null);
  const paidInstallments = credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  ).length;
  const openInstallments = credit.cuotas.filter(
    (item) => item.estado !== "PAGO" && item.saldoPendiente > 0
  ).length;
  const paymentPanelActive =
    activePanel === "payments" || activePanel === "pending";

  const handlePazYSalvoDownload = async (
    event: ReactMouseEvent<HTMLAnchorElement>
  ) => {
    event.preventDefault();

    if (pazYSalvoDownloadLock.current) {
      return;
    }

    pazYSalvoDownloadLock.current = true;
    const androidBridge = window.FinserPayAndroid;
    const fallbackFilename = `paz-y-salvo-${credit.folio}.pdf`;
    const absoluteUrl = new URL(pazYSalvoHref, window.location.origin).toString();

    if (androidBridge && !androidBridge.downloadDocument) {
      setPazYSalvoFeedback({
        tone: "amber",
        text: "Intentando la descarga. Si no inicia, abre finserpay.com/clientes en Chrome o actualiza FINSER PAY.",
      });
      const legacyAnchor = document.createElement("a");
      legacyAnchor.href = absoluteUrl;
      legacyAnchor.download = fallbackFilename;
      legacyAnchor.style.display = "none";
      document.body.appendChild(legacyAnchor);
      legacyAnchor.click();
      legacyAnchor.remove();
      window.setTimeout(() => {
        pazYSalvoDownloadLock.current = false;
      }, 3_000);
      return;
    }

    if (androidBridge?.downloadDocument) {
      try {
        androidBridge.downloadDocument(absoluteUrl, fallbackFilename);
        setPazYSalvoFeedback({
          tone: "amber",
          text: "Solicitud enviada a Android. Revisa la notificación y la carpeta Descargas.",
        });
      } catch {
        setPazYSalvoFeedback({
          tone: "red",
          text: "No se pudo iniciar la descarga en la aplicación. Intenta de nuevo.",
        });
      } finally {
        window.setTimeout(() => {
          pazYSalvoDownloadLock.current = false;
        }, 3_000);
      }
      return;
    }

    setPazYSalvoDownloading(true);
    setPazYSalvoFeedback(null);

    try {
      const clientDocument = await fetchClientPdf(
        pazYSalvoHref,
        fallbackFilename
      );
      triggerBrowserDownload(clientDocument.blob, clientDocument.filename);
      setPazYSalvoFeedback({
        tone: "emerald",
        text: "Paz y salvo descargado. Revisa la carpeta Descargas.",
      });
    } catch (error) {
      setPazYSalvoFeedback({
        tone: "red",
        text:
          error instanceof Error
            ? error.message
            : "No se pudo descargar el paz y salvo. Intenta de nuevo.",
      });
    } finally {
      setPazYSalvoDownloading(false);
      pazYSalvoDownloadLock.current = false;
    }
  };

  const lastPayment = credit.abonos[0] || null;

  return (
    <div id="cliente-dashboard" className={paidStyles.page}>
      <div className={`${styles.screen} ${paidStyles.screen}`} data-credit-status="paid">
        <header className={styles.header}>
          <span className={styles.brand} aria-label="FINSER PAY">FINSER <strong>PAY</strong></span>
          <div className={styles.headerActions}>
            <button type="button" className={styles.iconButton} onClick={() => onOpenPanel("history")} aria-label="Abrir notificaciones">
              <Bell aria-hidden="true" />
            </button>
            <button type="button" className={styles.avatar} onClick={onForgetDocument} aria-label={`Cambiar cliente: ${firstName}`}>
              {profileInitials}
            </button>
          </div>
        </header>
        <main>
          <h1 className={styles.greeting}>Hola, {firstName}</h1>
          <p className={styles.creditNumber}>Crédito <strong>{creditDisplayNumber(credit)}</strong></p>
          <p className={styles.status} role="status"><span aria-hidden="true" />Crédito finalizado</p>
          {credits.length > 1 ? (
            <label className={styles.creditSelector}>
              <span>Crédito consultado</span>
              <select value={credit.id} onChange={(event) => onSelectCredit(Number(event.target.value))}>
                {credits.map((item) => (
                  <option key={item.id} value={item.id}>Crédito {creditDisplayNumber(item)}{item.referenciaEquipo ? ` · ${item.referenciaEquipo}` : ""} · {creditStateLabel(item)}</option>
                ))}
              </select>
            </label>
          ) : null}
          {notice ? <p className={`${styles.notice} ${notice.tone === "red" ? styles.noticeError : ""}`} role={notice.tone === "red" ? "alert" : "status"}>{notice.text}</p> : null}

          <section className={styles.hero} aria-labelledby="paid-credit-summary">
            <div className={styles.mascotScene}>
              <div className={`${styles.mascotFloat} ${paidStyles.mascotFloat}`}>
                <Image className={styles.mascotImage} src="/assets/clientes/mascot-paid.webp"
                  alt="Mascota FINSER PAY celebrando con los brazos arriba y un pie levantado"
                  width={640} height={960} sizes="(max-width: 359px) 120px, (max-width: 600px) 180px, 240px" loading="eager" />
              </div>
            </div>
            <div className={styles.summary}>
              <p className={styles.amountEyebrow} id="paid-credit-summary">Saldo pendiente</p>
              <p className={`${styles.heroAmount} ${paidStyles.paidAmount}`}>{money(credit.saldoPendiente)}</p>
              <p className={styles.installmentCount}><strong>{paidInstallments}</strong> / {credit.cuotas.length} cuotas</p>
            </div>
            <div className={styles.actions} aria-label="Acciones del crédito finalizado">
              <a href={pazYSalvoHref} download onClick={handlePazYSalvoDownload} aria-busy={pazYSalvoDownloading}
                aria-label="Descargar paz y salvo del crédito" className={`${styles.payButton} ${paidStyles.documentButton}`}>
                <Download aria-hidden="true" /><span>{pazYSalvoDownloading ? "Preparando paz y salvo…" : "Descargar paz y salvo"}</span>
              </a>
              <FinserSupportLink supportMessage={newCreditSupportMessage} supportAriaLabel="Solicitar un nuevo crédito por WhatsApp"
                className={`${styles.payoffButton} ${paidStyles.documentButton}`}>Solicitar nuevo crédito</FinserSupportLink>
              <p className={styles.reminder}><CalendarDays aria-hidden="true" /><span>Cerraste este ciclo con éxito</span></p>
            </div>
          </section>
          {pazYSalvoFeedback ? (
            <p role={pazYSalvoFeedback.tone === "red" ? "alert" : "status"}
              className={`${styles.notice} ${pazYSalvoFeedback.tone === "red" ? styles.noticeError : ""}`}>
              {pazYSalvoFeedback.text}
            </p>
          ) : null}

          <section className={styles.progressSection} aria-labelledby="credit-progress-title">
            <h2 id="credit-progress-title">Estado del crédito</h2>
            <ProgressBar className={styles.progress} value={credit.cuotas.length ? paidInstallments / credit.cuotas.length * 100 : 0}
              label={`${paidInstallments} de ${credit.cuotas.length} cuotas pagadas`} />
            <div className={styles.progressLabels}>
              <span>{paidInstallments} {paidInstallments === 1 ? "pagada" : "pagadas"}</span>
              <span>{openInstallments} {openInstallments === 1 ? "pendiente" : "pendientes"}</span>
            </div>
          </section>

          <section className={styles.activity} aria-labelledby="activity-title">
            <span className={styles.activityHandle} aria-hidden="true" />
            <h2 id="activity-title">Tu actividad</h2>
            <button type="button" className={styles.activityRow} onClick={() => onOpenPanel("pending")} aria-label={`Ver detalles de ${creditTitle(credit)}`}>
              <span className={styles.deviceIcon} aria-hidden="true"><Smartphone /></span>
              <span className={styles.activityCopy}><strong>{creditTitle(credit)}</strong><small>Crédito finalizado</small></span>
              <ChevronRight aria-hidden="true" />
            </button>
            {lastPayment ? (
              <button type="button" className={styles.activityRow} onClick={() => onOpenPanel("history")}>
                <span className={`${styles.activityIcon} ${styles.paidIcon}`} aria-hidden="true"><Check /></span>
                <span className={styles.activityCopy}><strong>{shortDate(lastPayment.fechaAbono)}</strong><small>Pago recibido</small></span>
                <strong className={styles.activityAmount}>{money(lastPayment.valor)}</strong><ChevronRight aria-hidden="true" />
              </button>
            ) : null}
            <a href={pazYSalvoHref} download onClick={handlePazYSalvoDownload} aria-busy={pazYSalvoDownloading} className={styles.activityRow}>
              <span className={styles.activityIcon} aria-hidden="true"><FileText /></span>
              <span className={styles.activityCopy}><strong>Paz y salvo disponible</strong><small>{pazYSalvoDownloading ? "Preparando descarga…" : "Listo para descargar"}</small></span>
              <ChevronRight aria-hidden="true" />
            </a>
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
                    <p className="mt-1 text-base font-black text-[#171a1d]">{money(credit.saldoPendiente)}</p>
                  </div>
                  <div className="rounded-[var(--fp-radius-md)] bg-white px-2 py-3">
                    <p className="text-[11px] font-bold text-[#707982]">Estado</p>
                    <p className="mt-1 text-base font-black text-[#3d790e]">Pagado</p>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </main>
      </div>
      <nav className={paidStyles.navigation} aria-label="Navegación del portal">
        <button type="button" onClick={onHome} aria-current={activePanel === null ? "page" : undefined}>
          <Home aria-hidden="true" /><span>Inicio</span><i aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onOpenPanel("pending")} aria-current={paymentPanelActive ? "page" : undefined}>
          <CreditCard aria-hidden="true" /><span>Crédito</span><i aria-hidden="true" />
        </button>
        <button type="button" onClick={() => onOpenPanel("history")} aria-current={activePanel === "history" ? "page" : undefined}>
          <Clock3 aria-hidden="true" /><span>Historial</span><i aria-hidden="true" />
        </button>
        <button type="button" onClick={onForgetDocument}>
          <CircleUserRound aria-hidden="true" /><span>SALIR</span><i aria-hidden="true" />
        </button>
      </nav>
    </div>
  );
}
