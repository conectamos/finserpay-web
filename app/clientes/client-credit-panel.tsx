"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  FileText,
  Headphones,
  Landmark,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import FinserSupportLink from "@/app/_components/finser-support-link";
import styles from "./client-credit-panel.module.css";

export type ClientCreditPanelName = "payments" | "pending" | "history";

type PanelInstallment = {
  numero: number;
  fechaVencimiento: string;
  valorProgramado: number;
  saldoPendiente: number;
  estado: "PAGO" | "PENDIENTE";
  estaEnMora?: boolean;
};

type PanelPayment = {
  id: number;
  valor: number;
  metodoPago: string;
  fechaAbono: string;
};

type PanelCredit = {
  id: number;
  folio: string;
  clienteDocumento: string | null;
  estadoPago: "PAGADO" | "AL_DIA" | "MORA";
  saldoPendiente: number;
  totalPagado: number;
  cuotas: PanelInstallment[];
  abonos: PanelPayment[];
  liquidacionAnticipada?: {
    capitalPendiente: number;
    condonacion: number;
    disponible: boolean;
    motivo?: string | null;
  };
};

type ClientCreditPanelProps = {
  credit: PanelCredit;
  notice: { text: string; tone: "red" | "emerald" } | null;
  onBack: () => void;
  onOpenPanel: (panel: ClientCreditPanelName) => void;
  onPayoff: () => void;
  onPaySelected: () => void;
  onRefreshPayment: () => void;
  onSelectPaymentLimit: (installmentNumber: number) => void;
  panel: ClientCreditPanelName;
  pendingPayment: {
    reference: string;
    checkedAt?: string | null;
  } | null;
  paying: boolean;
  refreshingPayment: boolean;
  selectedPaymentLimit: number;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const shortMonthFormatter = new Intl.DateTimeFormat("es-CO", {
  month: "short",
});

const fullDateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "long",
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function localDate(value: string) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (dateOnly) {
    return new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      12
    );
  }

  return new Date(value);
}

function dayLabel(value: string) {
  const date = localDate(value);
  return Number.isNaN(date.getTime()) ? "--" : String(date.getDate()).padStart(2, "0");
}

function monthLabel(value: string) {
  const date = localDate(value);
  return Number.isNaN(date.getTime())
    ? "---"
    : shortMonthFormatter.format(date).replace(".", "").toUpperCase();
}

function dateLabel(value: string) {
  const date = localDate(value);
  return Number.isNaN(date.getTime()) ? "-" : fullDateFormatter.format(date);
}

function statusLabel(status: PanelCredit["estadoPago"]) {
  if (status === "PAGADO") return "Crédito pagado";
  if (status === "MORA") return "Crédito en mora";
  return "Crédito al día";
}

function methodLabel(value: string) {
  const normalized = String(value || "Pago").trim().toUpperCase();
  return normalized === "WOMPI" ? "NEQUI · WOMPI" : normalized;
}

function receiptHref(
  credit: PanelCredit,
  payment: PanelPayment,
  download = false
) {
  const documento = String(credit.clienteDocumento || "").replace(/\D/g, "");
  const params = new URLSearchParams({ documento });
  if (download) params.set("download", "1");
  return `/api/clientes/creditos/${credit.id}/abonos/${payment.id}/recibo?${params.toString()}`;
}

function DateTile({ value }: { value: string }) {
  return (
    <span className={styles.dateTile} aria-hidden="true">
      <strong>{dayLabel(value)}</strong>
      <span>{monthLabel(value)}</span>
    </span>
  );
}

export default function ClientCreditPanel({
  credit,
  notice,
  onBack,
  onOpenPanel,
  onPayoff,
  onPaySelected,
  onRefreshPayment,
  onSelectPaymentLimit,
  panel,
  pendingPayment,
  paying,
  refreshingPayment,
  selectedPaymentLimit,
}: ClientCreditPanelProps) {
  const shellRef = useRef<HTMLElement>(null);
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const [showAllInstallments, setShowAllInstallments] = useState(false);
  const paidInstallments = credit.cuotas.filter(
    (item) => item.estado === "PAGO" || item.saldoPendiente <= 0
  );
  const payable = credit.cuotas.filter((item) => item.saldoPendiente > 0);
  const overdue = payable.filter((item) => item.estaEnMora);
  const nextInstallment = payable[0] || null;
  const selectedInstallments = payable.filter(
    (item) => item.numero <= selectedPaymentLimit
  );
  const selectedAmount = selectedInstallments.reduce(
    (sum, item) => sum + Math.max(0, item.saldoPendiente),
    0
  );
  const selectedLabel = selectedInstallments.length
    ? selectedInstallments.length === 1
      ? `Cuota ${selectedInstallments[0].numero}`
      : `Cuotas ${selectedInstallments[0].numero} a ${selectedInstallments.at(-1)?.numero}`
    : "Sin cuotas seleccionadas";
  const selectedIndex = Math.max(
    0,
    payable.findIndex((item) => item.numero === selectedPaymentLimit)
  );
  const upcoming = payable.slice(1);
  const visibleUpcoming = showAllInstallments ? upcoming : upcoming.slice(0, 4);
  const lastPayment = credit.abonos[0] || null;
  const payoff = credit.liquidacionAnticipada;
  const payoffAvailable = credit.estadoPago === "AL_DIA" && Boolean(payoff?.disponible);

  useEffect(() => {
    shellRef.current?.scrollTo({ top: 0, behavior: "auto" });
    backButtonRef.current?.focus({ preventScroll: true });
  }, [panel]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <section
      id="explora-panel"
      ref={shellRef}
      className={styles.shell}
      aria-labelledby="client-panel-title"
      aria-label={
        panel === "history"
          ? "Historial de pagos"
          : panel === "pending"
            ? "Plan de pagos"
            : "Medios de pago"
      }
    >
      <header className={styles.header}>
        <button ref={backButtonRef} type="button" onClick={onBack} className={styles.backButton} aria-label="Volver al inicio">
          <ArrowLeft size={28} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <h1 id="client-panel-title">{panel === "history" ? "Historial de pagos" : panel === "pending" ? "Plan de pagos" : "Medios de pago"}</h1>
        <span className={styles.headerMeta}>
          {panel === "history"
            ? `${credit.abonos.length} ${credit.abonos.length === 1 ? "pago" : "pagos"}`
            : panel === "pending"
              ? `${paidInstallments.length} / ${credit.cuotas.length}`
              : selectedInstallments.length
                ? `${selectedInstallments.length} ${selectedInstallments.length === 1 ? "cuota" : "cuotas"}`
                : "0 cuotas"}
        </span>
      </header>

      <div className={styles.content}>
        {notice ? (
          <div className={`${styles.notice} ${notice.tone === "red" ? styles.noticeError : styles.noticeSuccess}`} role={notice.tone === "red" ? "alert" : "status"}>
            {notice.text}
          </div>
        ) : null}

        {pendingPayment ? (
          <section className={styles.pendingPayment} aria-live="polite">
            <span className={styles.pendingPaymentIcon} aria-hidden="true">
              <RefreshCw size={22} strokeWidth={2} />
            </span>
            <div>
              <strong>Pago enviado a validación</strong>
              <p>
                Aprueba la solicitud en Nequi. Wompi actualizará automáticamente
                tus cuotas y el historial cuando confirme el pago.
              </p>
              <small>
                {pendingPayment.checkedAt
                  ? `Última revisión ${new Date(
                      pendingPayment.checkedAt
                    ).toLocaleTimeString("es-CO", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "La verificación automática está activa."}
              </small>
            </div>
            <button
              type="button"
              onClick={onRefreshPayment}
              disabled={refreshingPayment}
            >
              <RefreshCw
                size={17}
                className={refreshingPayment ? styles.refreshingIcon : undefined}
                aria-hidden="true"
              />
              {refreshingPayment ? "Revisando" : "Revisar ahora"}
            </button>
            <span className={styles.pendingReference}>
              Ref. {pendingPayment.reference}
            </span>
          </section>
        ) : null}

        {panel === "history" ? (
          <>
            <section className={styles.darkSummary} aria-label="Resumen de pagos">
              <div
                className={`${styles.statusLine} ${
                  credit.estadoPago === "MORA" ? styles.statusLate : ""
                }`}
              >
                <CircleCheck size={26} strokeWidth={1.8} aria-hidden="true" />
                {statusLabel(credit.estadoPago)}
              </div>
              <p className={styles.summaryEyebrow}>Total pagado</p>
              <p className={styles.summaryAmount}>{money(credit.totalPagado)}</p>
              <div className={styles.summaryDivider} />
              <dl className={styles.twoMetrics}>
                <div>
                  <dt>Último pago</dt>
                  <dd>{lastPayment ? `${dayLabel(lastPayment.fechaAbono)} ${monthLabel(lastPayment.fechaAbono)}` : "Sin pagos"}</dd>
                </div>
                <div>
                  <dt>Saldo actual</dt>
                  <dd>{money(credit.saldoPendiente)}</dd>
                </div>
              </dl>
            </section>

            {lastPayment ? (
              <div className={styles.successMessage}>
                <span><Check size={22} strokeWidth={2.4} aria-hidden="true" /></span>
                <div>
                  <strong>Pago registrado correctamente</strong>
                  <p>{credit.estadoPago === "MORA" ? "Tu saldo fue actualizado." : "Tu crédito se encuentra al día."}</p>
                </div>
              </div>
            ) : null}

            <section aria-labelledby="movements-title">
              <h2 id="movements-title" className={styles.sectionTitle}>Movimientos</h2>
              <div className={styles.movements}>
                {credit.abonos.length ? (
                  credit.abonos.map((payment) => (
                    <article key={payment.id} className={styles.movementCard}>
                      <a
                        className={styles.movementMain}
                        href={receiptHref(credit, payment)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Ver recibo del pago de ${money(payment.valor)}`}
                      >
                        <DateTile value={payment.fechaAbono} />
                        <span className={styles.movementCopy}>
                          <strong>Pago confirmado</strong>
                          <span className={styles.methodBadge}>{methodLabel(payment.metodoPago)}</span>
                          <small>Recibo RP-{credit.folio}-{payment.id}</small>
                        </span>
                        <span className={styles.movementValue}>
                          <strong>{money(payment.valor)}</strong>
                          <ChevronRight size={23} strokeWidth={1.9} aria-hidden="true" />
                        </span>
                      </a>
                      <a className={styles.receiptButton} href={receiptHref(credit, payment, true)}>
                        <FileText size={23} strokeWidth={1.7} aria-hidden="true" />
                        Descargar comprobante
                      </a>
                    </article>
                  ))
                ) : (
                  <div className={styles.emptyCard}>
                    <ReceiptText size={32} strokeWidth={1.6} aria-hidden="true" />
                    <strong>Aún no hay pagos registrados</strong>
                    <p>Cuando realices un pago, podrás consultar y descargar aquí su recibo.</p>
                    <button type="button" onClick={() => onOpenPanel("payments")}>Ver medios de pago</button>
                  </div>
                )}
              </div>
            </section>

            {nextInstallment ? (
              <section className={styles.nextDueCard}>
                <CalendarDays size={27} strokeWidth={1.7} aria-hidden="true" />
                <p>Tu próxima cuota vence el {dateLabel(nextInstallment.fechaVencimiento)}</p>
                <button type="button" onClick={() => onOpenPanel("pending")}>Ver plan de pagos</button>
              </section>
            ) : null}
          </>
        ) : null}

        {panel === "pending" ? (
          <>
            <section className={styles.darkSummary} aria-label="Resumen del plan de pagos">
              <div
                className={`${styles.statusLine} ${
                  credit.estadoPago === "MORA" ? styles.statusLate : ""
                }`}
              >
                <span className={styles.statusDot} aria-hidden="true" />
                {statusLabel(credit.estadoPago)}
              </div>
              <p className={styles.summaryEyebrow}>Saldo pendiente</p>
              <p className={styles.summaryAmount}>{money(credit.saldoPendiente)}</p>
              <div className={styles.summaryDivider} />
              <dl className={styles.threeMetrics}>
                <div><dd>{overdue.length}</dd><dt>vencidas</dt></div>
                <div><dt>Próxima</dt><dd>{nextInstallment ? `${dayLabel(nextInstallment.fechaVencimiento)} ${monthLabel(nextInstallment.fechaVencimiento)}` : "-"}</dd></div>
                <div><dt>Cuota</dt><dd>{nextInstallment?.numero || credit.cuotas.length}</dd></div>
              </dl>
            </section>

            {nextInstallment ? (
              <section className={styles.featuredInstallment}>
                <div>
                  <p>Próxima cuota</p>
                  <h2>Cuota {nextInstallment.numero}</h2>
                  <span>{dateLabel(nextInstallment.fechaVencimiento)} · {nextInstallment.estaEnMora ? "Vencida" : "Pendiente"}</span>
                </div>
                <strong>{money(nextInstallment.saldoPendiente)}</strong>
                <button type="button" onClick={() => onOpenPanel("payments")}>
                  Pagar ahora
                </button>
              </section>
            ) : (
              <div className={styles.emptyCard}>
                <CircleCheck size={34} strokeWidth={1.7} aria-hidden="true" />
                <strong>No tienes cuotas pendientes</strong>
                <p>Tu plan de pagos se encuentra completamente atendido.</p>
              </div>
            )}

            {credit.cuotas.length ? (
              <section className={styles.routeSection} aria-labelledby="payment-route-title">
                <h2 id="payment-route-title" className={styles.sectionTitle}>Tu ruta de pagos</h2>
                <div className={styles.route} role="list" aria-label="Progreso de cuotas">
                  {credit.cuotas.map((item) => {
                    const paid = item.estado === "PAGO" || item.saldoPendiente <= 0;
                    const current = item.numero === nextInstallment?.numero;
                    return (
                      <span
                        key={item.numero}
                        role="listitem"
                        aria-label={`Cuota ${item.numero}: ${paid ? "pagada" : item.estaEnMora ? "vencida" : "pendiente"}`}
                        className={`${styles.routeNode} ${paid ? styles.routePaid : ""} ${current ? styles.routeCurrent : ""} ${item.estaEnMora ? styles.routeOverdue : ""}`}
                      />
                    );
                  })}
                </div>
                <p>{Math.max(0, payable.length - 1)} cuotas después de la próxima</p>
              </section>
            ) : null}

            {upcoming.length ? (
              <section className={styles.upcomingSection} aria-labelledby="upcoming-title">
                <h2 id="upcoming-title" className={styles.sectionTitle}>Próximas cuotas</h2>
                <div className={styles.upcomingList}>
                  {visibleUpcoming.map((item) => {
                    const selected = item.numero <= selectedPaymentLimit;
                    return (
                      <button
                        key={item.numero}
                        type="button"
                        onClick={() => onSelectPaymentLimit(item.numero)}
                        aria-pressed={selected}
                        className={selected ? styles.upcomingSelected : undefined}
                      >
                        <DateTile value={item.fechaVencimiento} />
                        <span><strong>Cuota {item.numero}</strong><small>{selected ? `Incluida en ${selectedLabel.toLowerCase()}` : "Seleccionar hasta esta cuota"}</small></span>
                        <b>{money(item.saldoPendiente)}</b>
                        <ChevronRight size={22} strokeWidth={1.8} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                {upcoming.length > 4 ? (
                  <button type="button" className={styles.expandButton} onClick={() => setShowAllInstallments((value) => !value)}>
                    {showAllInstallments ? "Ver menos cuotas" : `Ver las ${upcoming.length - 4} cuotas restantes`}
                    <ChevronRight size={19} aria-hidden="true" />
                  </button>
                ) : null}
              </section>
            ) : null}
          </>
        ) : null}

        {panel === "payments" ? (
          <>
            <section className={styles.paymentSummary}>
              <div>
                <p>Valor a pagar</p>
                <h2>{money(selectedAmount)}</h2>
                <span>{selectedLabel}</span>
              </div>
              <span
                className={`${styles.paymentState} ${
                  credit.estadoPago === "MORA" ? styles.paymentStateLate : ""
                }`}
              >
                {statusLabel(credit.estadoPago)}
              </span>
            </section>

            {payable.length > 1 ? (
              <section className={styles.selectorCard} aria-label="Ajustar cuotas a pagar">
                <div>
                  <p>Cuotas incluidas</p>
                  <strong>{selectedLabel}</strong>
                  <span>La selección siempre incluye las cuotas anteriores pendientes.</span>
                </div>
                <div className={styles.selectorControls}>
                  <button type="button" aria-label="Pagar menos cuotas" disabled={selectedIndex <= 0} onClick={() => {
                    const previous = payable[selectedIndex - 1];
                    if (previous) onSelectPaymentLimit(previous.numero);
                  }}><Minus size={20} aria-hidden="true" /></button>
                  <b>{selectedInstallments.length}</b>
                  <button type="button" aria-label="Pagar más cuotas" disabled={selectedIndex >= payable.length - 1} onClick={() => {
                    const next = payable[selectedIndex + 1];
                    if (next) onSelectPaymentLimit(next.numero);
                  }}><Plus size={20} aria-hidden="true" /></button>
                </div>
              </section>
            ) : null}

            <section className={styles.methodsSection} aria-labelledby="online-method-title">
              <h2 id="online-method-title" className={styles.sectionTitle}>Pago en línea</h2>
              <article className={styles.nequiCard}>
                <div className={styles.methodHeader}>
                  <span className={styles.nequiMark}><Smartphone size={25} aria-hidden="true" /></span>
                  <div><strong>Nequi</strong><small>Procesado de forma segura por Wompi</small></div>
                  <span className={styles.autoBadge}>Automático</span>
                </div>
                <ul>
                  <li><Check size={16} aria-hidden="true" /> Confirmación automática</li>
                  <li><Check size={16} aria-hidden="true" /> Aplicación exacta a {selectedLabel.toLowerCase()}</li>
                  <li><Check size={16} aria-hidden="true" /> Recibo disponible al confirmarse</li>
                </ul>
                <button type="button" onClick={onPaySelected} disabled={paying || !selectedInstallments.length}>
                  {paying ? "Abriendo Wompi..." : `Pagar ${money(selectedAmount)}`}
                  <ChevronRight size={22} aria-hidden="true" />
                </button>
              </article>
            </section>

            {payoffAvailable && payoff ? (
              <section className={styles.payoffCard}>
                <div className={styles.methodHeader}>
                  <span className={styles.payoffIcon}><ShieldCheck size={24} aria-hidden="true" /></span>
                  <div><strong>Liquidar crédito hoy</strong><small>Cierre anticipado exclusivo por Nequi/Wompi</small></div>
                </div>
                <div className={styles.payoffMetrics}>
                  <div><span>Capital a pagar</span><strong>{money(payoff.capitalPendiente)}</strong></div>
                  <div><span>Ahorro estimado</span><strong>{money(payoff.condonacion)}</strong></div>
                </div>
                <button type="button" onClick={onPayoff} disabled={paying}>
                  {paying ? "Preparando..." : `Liquidar por ${money(payoff.capitalPendiente)}`}
                </button>
              </section>
            ) : null}

            <section className={styles.methodsSection} aria-labelledby="other-methods-title">
              <h2 id="other-methods-title" className={styles.sectionTitle}>Otros medios</h2>
              <article className={styles.infoMethodCard}>
                <span className={styles.efectyMark}>efecty</span>
                <div><strong>Pago en punto Efecty</strong><small>La conciliación puede tardar algunos minutos.</small></div>
                <dl><div><dt>Convenio</dt><dd>113950</dd></div><div><dt>Referencia</dt><dd>{credit.clienteDocumento || "-"}</dd></div></dl>
              </article>
              <article className={styles.infoMethodCard}>
                <span className={styles.bankMark}><Landmark size={25} aria-hidden="true" /></span>
                <div><strong>Transferencia Bancolombia</strong><small>Aplicación asistida; conserva el comprobante.</small></div>
                <dl><div><dt>Cuenta de ahorros</dt><dd>71800000458</dd></div></dl>
                <FinserSupportLink className={styles.supportAction}>
                  <Headphones size={19} aria-hidden="true" /> Reportar transferencia a soporte
                </FinserSupportLink>
              </article>
            </section>

            <div className={styles.securityNote}>
              <ShieldCheck size={22} strokeWidth={1.7} aria-hidden="true" />
              <p><strong>Protege tu pago</strong> FINSER PAY nunca solicita claves ni códigos de verificación por llamada o chat.</p>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
