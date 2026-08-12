"use client";

import Image, { type ImageProps } from "next/image";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  CreditCard,
  Download,
  FileSignature,
} from "lucide-react";
import {
  COLOMBIA_TIME_ZONE,
  parseColombiaDate,
} from "@/lib/colombia-date";
import styles from "./client-active-credit-dashboard.module.css";

export type ActiveCreditDashboardStatusTone = "current" | "overdue";

export type ActiveCreditDashboardCreditOption = {
  id: number;
  label: string;
};

export type ActiveCreditDashboardInstallment = {
  amount: number;
  dueDate: string;
  number: number;
  stateLabel?: string;
};

export type ActiveCreditDashboardPayment = {
  amount: number;
  date: string;
  label?: string;
  stateLabel?: string;
};

export type ActiveCreditDashboardDevice = {
  imageAlt: string;
  imageSrc: ImageProps["src"];
  meta?: string;
  name: string;
};

export type ClientActiveCreditDashboardProps = {
  activeCreditId: number;
  clientFirstName: string;
  creditOptions?: ActiveCreditDashboardCreditOption[];
  device: ActiveCreditDashboardDevice;
  folioAvailable?: boolean;
  folioDownloading?: boolean;
  lastPayment?: ActiveCreditDashboardPayment | null;
  nextInstallment: ActiveCreditDashboardInstallment | null;
  notice?: { text: string; tone: "red" | "emerald" } | null;
  onDownloadFolio?: () => void;
  onOpenDevice?: () => void;
  onOpenHistory: () => void;
  onOpenNotifications: () => void;
  onOpenPaymentMethods: () => void;
  onOpenPlan: () => void;
  onOpenProfile?: () => void;
  onPayoff: () => void;
  onSelectCredit: (creditId: number) => void;
  paidInstallments: number;
  paying?: boolean;
  payoff?: { amount: number; available: boolean } | null;
  profileActionLabel?: string;
  profileInitials: string;
  statusLabel: string;
  statusTone?: ActiveCreditDashboardStatusTone;
  totalInstallments: number;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const fullDateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "long",
  timeZone: COLOMBIA_TIME_ZONE,
});

const dayFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  timeZone: COLOMBIA_TIME_ZONE,
});

const shortMonthFormatter = new Intl.DateTimeFormat("es-CO", {
  month: "short",
  timeZone: COLOMBIA_TIME_ZONE,
});

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function fullDateLabel(value: string) {
  const date = parseColombiaDate(value);
  return Number.isNaN(date.getTime()) ? "Fecha por confirmar" : fullDateFormatter.format(date);
}

function compactDateLabel(value: string) {
  const date = parseColombiaDate(value);
  if (Number.isNaN(date.getTime())) return "POR CONFIRMAR";

  const day = dayFormatter.format(date);
  const month = shortMonthFormatter.format(date).replace(".", "").toUpperCase();
  return `${day} ${month}`;
}

function PhoneOutline() {
  return (
    <span className={styles.phoneIllustration} aria-hidden="true">
      <span className={styles.phoneBack} />
      <span className={styles.phoneBody}>
        <span className={styles.phoneCamera} />
        <span className={styles.phoneSpeaker} />
        <span className={styles.phoneSideButton} />
      </span>
    </span>
  );
}

export default function ClientActiveCreditDashboard({
  activeCreditId,
  clientFirstName,
  creditOptions = [],
  device,
  folioAvailable = false,
  folioDownloading = false,
  lastPayment,
  nextInstallment,
  notice,
  onDownloadFolio,
  onOpenDevice,
  onOpenHistory,
  onOpenNotifications,
  onOpenPaymentMethods,
  onOpenPlan,
  onOpenProfile,
  onPayoff,
  onSelectCredit,
  paidInstallments,
  paying = false,
  payoff,
  profileActionLabel,
  profileInitials,
  statusLabel,
  statusTone = "current",
  totalInstallments,
}: ClientActiveCreditDashboardProps) {
  const safeTotal = Math.max(0, Math.floor(totalInstallments));
  const safePaid = Math.min(safeTotal, Math.max(0, Math.floor(paidInstallments)));
  const displayOptions = creditOptions.length
    ? creditOptions
    : [{ id: activeCreditId, label: "Crédito actual" }];
  const canPayInstallment = Boolean(nextInstallment) && !paying;
  const canPayoff = Boolean(payoff?.available) && !paying;
  const profileLabel =
    profileActionLabel || `Abrir perfil de ${clientFirstName || "cliente"}`;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <span className={styles.brand} aria-label="FINSER PAY">
          FINSER <strong>PAY</strong>
        </span>

        <span className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onOpenNotifications}
            aria-label="Abrir notificaciones"
          >
            <Bell aria-hidden="true" />
            <span className={styles.notificationDot} aria-hidden="true" />
          </button>

          <button
            type="button"
            className={styles.avatar}
            onClick={onOpenProfile}
            disabled={!onOpenProfile}
            aria-label={profileLabel}
          >
            {profileInitials}
          </button>
        </span>
      </header>

      <main>
        <h1 className={styles.greeting}>Hola, {clientFirstName}</h1>

        {displayOptions.length > 1 ? (
          <label className={styles.creditSelector}>
            <span>Crédito consultado</span>
            <select
              value={activeCreditId}
              onChange={(event) => onSelectCredit(Number(event.target.value))}
              aria-label="Seleccionar crédito"
            >
              {displayOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {notice ? (
          <p
            className={`${styles.notice} ${
              notice.tone === "red" ? styles.noticeError : styles.noticeSuccess
            }`}
            role={notice.tone === "red" ? "alert" : "status"}
          >
            {notice.text}
          </p>
        ) : null}

        <section className={styles.creditCard} aria-labelledby="active-credit-summary">
          <div className={styles.cardTopline}>
            <p
              className={`${styles.status} ${
                statusTone === "overdue" ? styles.statusOverdue : ""
              }`}
            >
              <span aria-hidden="true" />
              {statusLabel}
            </p>
            <p className={styles.installmentCount}>
              {safePaid} / {safeTotal} cuotas
            </p>
          </div>

          <PhoneOutline />

          <div className={styles.cardContent}>
            <p className={styles.amountEyebrow} id="active-credit-summary">
              Próxima cuota
            </p>
            <p className={styles.heroAmount}>
              {nextInstallment ? money(nextInstallment.amount) : "Sin saldo"}
            </p>

            {nextInstallment ? (
              <p className={styles.dueDate}>
                <CalendarDays aria-hidden="true" />
                Vence el {fullDateLabel(nextInstallment.dueDate)}
              </p>
            ) : null}
          </div>

          <div className={styles.cardActions}>
            <button
              type="button"
              className={styles.payButton}
              onClick={onOpenPaymentMethods}
              disabled={!canPayInstallment}
            >
              <CreditCard aria-hidden="true" />
              <span>{paying ? "Abriendo..." : "Pagar cuota"}</span>
              {nextInstallment ? <strong>{money(nextInstallment.amount)}</strong> : null}
            </button>

            {payoff?.available ? (
              <button
                type="button"
                className={styles.payoffButton}
                onClick={onPayoff}
                disabled={!canPayoff}
              >
                <span>Liquidar crédito hoy</span>
                <strong>{money(payoff.amount)}</strong>
                <ChevronRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </section>

        <section className={styles.progressSection} aria-labelledby="credit-progress-title">
          <div className={styles.sectionHeadingRow}>
            <h2 id="credit-progress-title">Avance del crédito</h2>
            <p>
              Cuota {safePaid} de {safeTotal}
            </p>
          </div>
          <div
            className={styles.progressDots}
            role="progressbar"
            aria-label={`${safePaid} de ${safeTotal} cuotas pagadas`}
            aria-valuemin={0}
            aria-valuemax={safeTotal}
            aria-valuenow={safePaid}
          >
            {Array.from({ length: safeTotal }, (_, index) => (
              <span
                key={index}
                className={index < safePaid ? styles.progressDotPaid : styles.progressDot}
                aria-hidden="true"
              />
            ))}
          </div>
        </section>

        <button
          type="button"
          className={styles.deviceCard}
          onClick={onOpenDevice || onOpenPlan}
          aria-label={`Ver detalles de ${device.name}`}
        >
          <span className={styles.deviceImage}>
            <Image
              src={device.imageSrc}
              alt={device.imageAlt}
              fill
              sizes="(max-width: 430px) 96px, 96px"
            />
          </span>
          <span className={styles.deviceCopy}>
            <span>Mi equipo</span>
            <strong>{device.name}</strong>
            {device.meta ? <small>{device.meta}</small> : null}
          </span>
          <ChevronRight className={styles.deviceChevron} aria-hidden="true" />
        </button>

        <section className={styles.movements} aria-labelledby="movements-title">
          <h2 id="movements-title">Movimientos</h2>

          <div className={styles.movementList}>
            {nextInstallment ? (
              <button type="button" className={styles.movement} onClick={onOpenPlan}>
                <span className={styles.movementIcon} aria-hidden="true">
                  <CalendarDays />
                </span>
                <span className={styles.movementCopy}>
                  <strong>
                    {compactDateLabel(nextInstallment.dueDate)} · Próxima cuota
                  </strong>
                  <small>{nextInstallment.stateLabel || "Programada"}</small>
                </span>
                <strong className={styles.movementAmount}>
                  {money(nextInstallment.amount)}
                </strong>
              </button>
            ) : null}

            {lastPayment ? (
              <button type="button" className={styles.movement} onClick={onOpenHistory}>
                <span className={styles.movementIcon} aria-hidden="true">
                  <CircleCheck />
                </span>
                <span className={styles.movementCopy}>
                  <strong>
                    {compactDateLabel(lastPayment.date)} · {lastPayment.label || "Pago recibido"}
                  </strong>
                  <small>{lastPayment.stateLabel || "Confirmado"}</small>
                </span>
                <strong className={styles.movementAmount}>{money(lastPayment.amount)}</strong>
              </button>
            ) : (
              <p className={styles.emptyMovement}>
                <Check aria-hidden="true" /> Aún no registras pagos en este crédito.
              </p>
            )}
            {folioAvailable && onDownloadFolio ? (
              <button
                type="button"
                className={styles.movement}
                onClick={onDownloadFolio}
                disabled={folioDownloading}
              >
                <span className={styles.movementIcon} aria-hidden="true">
                  <FileSignature />
                </span>
                <span className={styles.movementCopy}>
                  <strong>Folio firmado</strong>
                  <small>Contrato, pagare y autorizaciones</small>
                </span>
                <Download
                  className={styles.movementDownload}
                  aria-hidden="true"
                />
              </button>
            ) : null}

          </div>
        </section>
      </main>
    </div>
  );
}
