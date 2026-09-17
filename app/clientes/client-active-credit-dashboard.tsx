"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { Button, ProgressBar } from "@/app/_components/finser-ui";
import { paymentReminder } from "./credit-dashboard-presentation";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleCheck,
  CreditCard,
  Smartphone,
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
  meta?: string;
  name: string;
};

export type ClientActiveCreditDashboardProps = {
  activeCreditId: number;
  clientFirstName: string;
  creditOptions?: ActiveCreditDashboardCreditOption[];
  device: ActiveCreditDashboardDevice;
  lastPayment?: ActiveCreditDashboardPayment | null;
  nextInstallment: ActiveCreditDashboardInstallment | null;
  notice?: { text: string; tone: "red" | "emerald" } | null;
  onOpenDevice?: () => void;
  onOpenHistory: () => void;
  onOpenNotifications: () => void;
  onPayInstallment: () => void;
  onOpenPlan: () => void;
  onOpenProfile?: () => void;
  onPayoff: () => void;
  onSelectCredit: (creditId: number) => void;
  paidInstallments: number;
  paying?: boolean;
  payoff?: { amount: number; available: boolean; reason?: string | null } | null;
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


export default function ClientActiveCreditDashboard({
  activeCreditId, clientFirstName, creditOptions = [], device, lastPayment,
  nextInstallment, notice, onOpenDevice, onOpenHistory, onOpenNotifications,
  onPayInstallment, onOpenPlan, onOpenProfile, onPayoff, onSelectCredit,
  paidInstallments, paying = false, payoff, profileActionLabel, profileInitials,
  statusLabel, statusTone = "current", totalInstallments,
}: ClientActiveCreditDashboardProps) {
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const overdue = statusTone === "overdue";
  const safeTotal = Math.max(0, Math.floor(totalInstallments));
  const safePaid = Math.min(safeTotal, Math.max(0, Math.floor(paidInstallments)));
  const pending = safeTotal - safePaid;
  const installmentLabel = overdue ? "Cuota vencida" : "Próxima cuota";

  return (
    <div className={styles.screen} data-credit-status={statusTone}>
      <header className={styles.header}>
        <span className={styles.brand} aria-label="FINSER PAY">FINSER <strong>PAY</strong></span>
        <div className={styles.headerActions}>
          <button type="button" className={styles.iconButton} onClick={onOpenNotifications} aria-label="Abrir notificaciones">
            <Bell aria-hidden="true" />
          </button>
          <button type="button" className={styles.avatar} onClick={onOpenProfile} disabled={!onOpenProfile}
            aria-label={profileActionLabel || `Abrir perfil de ${clientFirstName || "cliente"}`}>
            {profileInitials}
          </button>
        </div>
      </header>
      <main>
        <h1 className={styles.greeting}>Hola, {clientFirstName}</h1>
        <p className={`${styles.status} ${overdue ? styles.statusOverdue : ""}`} role="status">
          <span aria-hidden="true" />{overdue ? "Pago pendiente" : statusLabel}
        </p>
        {creditOptions.length > 1 ? (
          <label className={styles.creditSelector}>
            <span>Crédito consultado</span>
            <select value={activeCreditId} onChange={(event) => onSelectCredit(Number(event.target.value))}>
              {creditOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        ) : null}
        {notice ? (
          <p className={`${styles.notice} ${notice.tone === "red" ? styles.noticeError : ""}`}
            role={notice.tone === "red" ? "alert" : "status"}>{notice.text}</p>
        ) : null}

        <section className={styles.hero} aria-labelledby="active-credit-summary">
          <div className={`${styles.mascotScene} ${overdue ? styles.mascotSad : ""}`}>
            <div className={styles.mascotFloat}>
              <Image className={styles.mascotImage}
                src={`/assets/clientes/mascot-${overdue ? "overdue" : "current"}.webp`}
                alt={overdue ? "Mascota FINSER PAY triste, con una lágrima" : "Mascota FINSER PAY tranquila y sonriente"}
                width={1024} height={1536} sizes="(max-width: 359px) 120px, (max-width: 600px) 180px, 240px" loading="eager" />
              <span className={styles.eyelidLeft} aria-hidden="true" />
              <span className={styles.eyelidRight} aria-hidden="true" />
            </div>
          </div>
          <div className={styles.summary}>
            <p className={styles.amountEyebrow} id="active-credit-summary">{installmentLabel}</p>
            <p className={styles.heroAmount}>{nextInstallment ? money(nextInstallment.amount) : "Sin saldo"}</p>
            {nextInstallment ? <p className={styles.dueDate}>
              {overdue ? "Venció el " : ""}{fullDateLabel(nextInstallment.dueDate)}
            </p> : null}
            <p className={styles.installmentCount}><strong>{safePaid}</strong> / {safeTotal} cuotas</p>
          </div>
          <div className={styles.actions}>
            <Button className={styles.payButton} onClick={onPayInstallment} disabled={!nextInstallment || paying}>
              <CreditCard aria-hidden="true" /><span>{paying ? "Abriendo…" : "Pagar cuota"}</span>
            </Button>
            {!overdue ? (
              <>
                <Button variant="secondary" className={styles.payoffButton} onClick={onPayoff}
                  disabled={!payoff || paying} aria-describedby={payoff && !payoff.available ? "payoff-availability" : undefined}>
                  <span>Liquidar crédito</span>
                  <small>{payoff ? money(payoff.amount) : "Valor no disponible"}</small>
                </Button>
                {payoff && !payoff.available ? <p className={styles.availability} id="payoff-availability">
                  {payoff.reason || "Consulta la disponibilidad de liquidación."}
                </p> : null}
              </>
            ) : null}
            <p className={styles.reminder}><CalendarDays aria-hidden="true" />
              <span>{paymentReminder(nextInstallment?.dueDate || null, overdue, today)}</span>
            </p>
          </div>
        </section>

        <section className={styles.progressSection} aria-labelledby="credit-progress-title">
          <h2 id="credit-progress-title">Estado del crédito</h2>
          <ProgressBar className={styles.progress} value={safeTotal ? safePaid / safeTotal * 100 : 0}
            label={`${safePaid} de ${safeTotal} cuotas pagadas`} />
          <div className={styles.progressLabels}>
            <span>{safePaid} {safePaid === 1 ? "pagada" : "pagadas"}</span>
            <span>{pending} {pending === 1 ? "pendiente" : "pendientes"}</span>
          </div>
        </section>

        <section className={styles.activity} aria-labelledby="activity-title">
          <span className={styles.activityHandle} aria-hidden="true" />
          <h2 id="activity-title">Tu actividad</h2>
          <button type="button" className={styles.activityRow} onClick={onOpenDevice || onOpenPlan} aria-label={`Ver detalles de ${device.name}`}>
            <span className={styles.deviceIcon} aria-hidden="true"><Smartphone /></span>
            <span className={styles.activityCopy}><strong>{device.name}</strong><small>Equipo financiado</small></span>
            <ChevronRight aria-hidden="true" />
          </button>
          {lastPayment ? (
            <button type="button" className={styles.activityRow} onClick={onOpenHistory}>
              <span className={`${styles.activityIcon} ${styles.paidIcon}`} aria-hidden="true"><Check /></span>
              <span className={styles.activityCopy}><strong>{compactDateLabel(lastPayment.date)}</strong><small>{lastPayment.label || "Pago recibido"}</small></span>
              <strong className={styles.activityAmount}>{money(lastPayment.amount)}</strong><ChevronRight aria-hidden="true" />
            </button>
          ) : <p className={styles.emptyActivity}><CircleCheck aria-hidden="true" />Aún no registras pagos en este crédito.</p>}
          {nextInstallment ? (
            <button type="button" className={styles.activityRow} onClick={onOpenPlan}>
              <span className={styles.activityIcon} aria-hidden="true"><CalendarDays /></span>
              <span className={styles.activityCopy}><strong>{compactDateLabel(nextInstallment.dueDate)}</strong><small>{installmentLabel}</small></span>
              <strong className={styles.activityAmount}>{money(nextInstallment.amount)}</strong><ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </section>
      </main>
    </div>
  );
}
