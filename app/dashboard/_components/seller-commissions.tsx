"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BarChart3, BellRing, CalendarDays, CheckCircle2, ChevronDown, Coins, Download, Info, LockKeyhole, Smartphone, Wallet, X } from "lucide-react";
import { Button, Card, Input, LoadingState, ProgressBar, Select, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { COMMISSION_STARTS_AT, COMMISSION_TIME_ZONE, type CommissionPeriod, type SellerCommissionDashboard } from "@/lib/commissions";
import styles from "./seller-commissions.module.css";

// Midnight in Colombia: the browser's time zone does not control program access.

function money(value: number) {
  return `$ ${Math.round(value).toLocaleString("es-CO")}`;
}
function periodLabel(period: string) {
  const text = new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: COMMISSION_TIME_ZONE }).format(new Date(`${period}-15T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: COMMISSION_TIME_ZONE }).format(new Date(value));
}

function ComingSoon() {
  return (
    <Card className={styles.comingSoon}>
      <div className={styles.launchCopy}>
        <span className={styles.launchBadge}>PRÓXIMAMENTE</span>
        <h2 id="seller-commissions-title">Tus ventas también suman</h2>
        <p>Comisiones por créditos válidos desde el 1 de octubre de 2026.</p>
        <span className={styles.launchDate}><CalendarDays size={22} aria-hidden="true" />Inicia el 1 de octubre</span>
      </div>
      <div className={styles.mascot} aria-hidden="true">
        <Image src="/assets/clientes/mascot-welcome.webp" alt="" width={200} height={300} sizes="(max-width: 600px) 120px, 200px" />
      </div>
    </Card>
  );
}

function CommissionProgress({ count }: { count: number }) {
  // Fixed milestone spacing keeps the labels readable even after thousands of sales.
  // The open tail keeps growing; thirty is a milestone, never a ceiling.
  const progress = count <= 15 ? (count / 15) * 31
    : count <= 21 ? 31 + ((count - 15) / 6) * 22
      : count <= 30 ? 53 + ((count - 21) / 9) * 24
        : 77 + (18 * (count - 30)) / (count - 25);
  return (
    <div className={styles.progressArea}>
      <p className={styles.creditCount}><strong>{count}</strong><span>créditos válidos</span></p>
      <div className={styles.milestoneBar}>
        <ProgressBar value={progress} label={`${count} créditos válidos. Metas: 15, 21 y 30. Continúa sin límite de créditos.`} className={styles.progress} />
        {[{ count: 15, rate: 20000, position: 31 }, { count: 21, rate: 25000, position: 53 }, { count: 30, rate: 30000, position: 77 }].map((goal) => (
          <div key={goal.count} className={`${styles.milestone} ${count >= goal.count ? styles.reached : ""}`} style={{ left: `${goal.position}%` }}>
            <span className={styles.milestoneDot} aria-hidden="true" />
            <span className={styles.milestoneLabel}>{goal.count}<span> · {money(goal.rate)}</span></span>
          </div>
        ))}
        {count > 0 ? <span className={styles.currentMarker} style={{ left: `${progress}%` }} aria-hidden="true" /> : null}
        <ArrowRight className={styles.continuation} size={23} aria-hidden="true" />
      </div>
      <p className={styles.progressNote}><Info size={18} aria-hidden="true" /><span>{count < 15 ? <>Con <strong>15 créditos válidos</strong> se activa la comisión de todo el mes.</> : count < 30 ? <>La tarifa alcanzada se aplica a <strong>todos tus créditos válidos del mes</strong>.</> : <>Desde el crédito <strong>31</strong>, cada crédito válido suma <strong>$ 30.000</strong>.</>}</span></p>
    </div>
  );
}

function BalanceSummary({ period }: { period: CommissionPeriod }) {
  return (
    <dl className={styles.balanceSummary}>
      <div><dt><i className={styles.paidDot} />Pagado</dt><dd>{money(period.paid)}</dd></div>
      <div><dt><i />En trámite</dt><dd>{money(period.reserved)}</dd></div>
      <div><dt><i />Saldo disponible</dt><dd>{money(period.available)}</dd></div>
    </dl>
  );
}

function PausedPayouts() {
  return (
    <div className={styles.pausedPanel} role="status" aria-live="polite">
      <Image className={styles.pausedMascot} src="/assets/clientes/mascot-overdue.webp" alt="" width={132} height={198} sizes="(max-width: 600px) 92px, 132px" />
      <div className={styles.pausedCopy}>
        <h3>Comisiones temporalmente en pausa</h3>
        <p>Por ahora no puedes solicitar cobros. Te avisaremos cuando vuelvan a estar disponibles.</p>
        <p id="commission-pause-note" className={styles.pausedNote}><Info size={18} aria-hidden="true" /><span>Tus créditos válidos siguen contabilizándose.</span></p>
        <Button disabled aria-describedby="commission-pause-note"><LockKeyhole size={17} aria-hidden="true" />Cobrar</Button>
      </div>
    </div>
  );
}

function PayoutDrawer({ period, onClose, onSubmitted, onRefresh }: {
  period: CommissionPeriod;
  onClose: () => void;
  onSubmitted: (amount: number) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const attemptRef = useRef<{ key: string; payload: string } | null>(null);
  const sendingRef = useRef(false);
  const [mode, setMode] = useState<"all" | "partial">("all");
  const [partial, setPartial] = useState("");
  const [nequi, setNequi] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const amount = mode === "all" ? period.available : Number(partial.replace(/\D/g, ""));
  const phone = nequi.replace(/\D/g, "");
  const validAmount = Number.isSafeInteger(amount) && amount > 0 && amount <= period.available;
  const validPhone = /^3\d{9}$/.test(phone);
  const remaining = Math.max(0, period.available - amount);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function requestConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validAmount || !validPhone || busy) return;
    setError("");
    setConfirming(true);
  }

  async function submitRequest() {
    if (sendingRef.current || !validAmount || !validPhone) return;
    sendingRef.current = true;
    setBusy(true);
    setError("");
    const payload = JSON.stringify({ period: period.period, amount, nequi: phone });
    if (attemptRef.current?.payload !== payload) {
      attemptRef.current = { key: crypto.randomUUID(), payload };
    }
    try {
      const response = await fetch("/api/comisiones/solicitudes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: period.period, amount, nequi: phone, idempotencyKey: attemptRef.current.key }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status < 500) attemptRef.current = null;
        throw new Error(result?.error || "No fue posible enviar la solicitud. Intenta de nuevo.");
      }
      await onSubmitted(amount);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible enviar la solicitud.");
      setConfirming(false);
      await onRefresh();
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className={styles.drawer} aria-labelledby="commission-payout-title" onCancel={(event) => {
      event.preventDefault();
      if (busy) return;
      if (confirming) setConfirming(false);
      else onClose();
    }}>
      <header className={styles.drawerHeader}>
        <div><h2 id="commission-payout-title">Solicitar cobro</h2><p>Envía una solicitud de cobro de tu saldo disponible.</p></div>
        <Button variant="ghost" className={styles.closeButton} aria-label="Cerrar panel de cobro" onClick={onClose} disabled={busy}><X size={21} aria-hidden="true" /></Button>
      </header>
      <p className={styles.drawerPeriod}><CalendarDays size={16} aria-hidden="true" />{periodLabel(period.period)}</p>
      <div className={styles.drawerBalance}>
        <div className={styles.availableAmount}><Wallet size={23} aria-hidden="true" /><div><span>Saldo disponible</span><strong>{money(period.available)}</strong></div></div>
        <dl className={styles.drawerSummary}>
          <div><dt>Comisión generada</dt><dd>{money(period.generated)}</dd></div>
          <div><dt>Pagado</dt><dd>{money(period.paid)}</dd></div>
          <div><dt>En trámite</dt><dd>{money(period.reserved)}</dd></div>
        </dl>
      </div>
      <form onSubmit={requestConfirmation} className={styles.payoutForm}>
        <fieldset disabled={busy}>
          <legend>Selecciona el monto</legend>
          <div className={styles.amountOptions}>
            <label className={mode === "all" ? styles.selectedOption : ""}><input type="radio" name="commission-amount-mode" checked={mode === "all"} onChange={() => setMode("all")} /><span><strong>Todo el saldo</strong><small>{money(period.available)}</small></span></label>
            <label className={mode === "partial" ? styles.selectedOption : ""}><input type="radio" name="commission-amount-mode" checked={mode === "partial"} onChange={() => setMode("partial")} /><span><strong>Monto parcial</strong><small>Ingresa un valor</small></span></label>
          </div>
        </fieldset>
        <div className={styles.formField}>
          <label htmlFor="commission-amount">Monto a cobrar</label>
          <div className={styles.prefixedInput}><span aria-hidden="true">$</span><Input id="commission-amount" inputMode="numeric" autoComplete="off" value={mode === "all" ? Math.round(period.available).toLocaleString("es-CO") : partial ? Number(partial).toLocaleString("es-CO") : ""} disabled={busy || mode === "all"} onChange={(event) => setPartial(event.target.value.replace(/\D/g, "").slice(0, 12))} aria-describedby="commission-amount-help" aria-invalid={mode === "partial" && Boolean(partial) && !validAmount} placeholder="0" required /></div>
          <small id="commission-amount-help">Máximo disponible: {money(period.available)}.{mode === "partial" && Boolean(partial) && !validAmount ? " Ingresa un valor mayor a cero que no supere tu saldo." : ""}</small>
        </div>
        <div className={styles.formField}>
          <label htmlFor="commission-nequi">Número de Nequi</label>
          <div className={styles.prefixedInput}><Smartphone size={19} aria-hidden="true" /><Input id="commission-nequi" type="tel" inputMode="tel" autoComplete="tel-national" placeholder="312 408 5562" value={nequi} onChange={(event) => setNequi(event.target.value.replace(/[^\d ]/g, "").slice(0, 14))} disabled={busy} required aria-describedby="commission-nequi-help" /></div>
          <small id="commission-nequi-help">Número colombiano de 10 dígitos, iniciado en 3.</small>
        </div>
        <p className={styles.remaining}><Info size={19} aria-hidden="true" /><span>Después de solicitar: <strong>{money(remaining)}</strong> disponibles.</span></p>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <Button type="submit" className={styles.submitButton} disabled={!validAmount || !validPhone || busy}>{busy ? "Enviando solicitud…" : "Enviar solicitud"}</Button>
        <p className={styles.reservationNote}>El monto solicitado queda reservado mientras FINSER PAY revisa y realiza tu pago.</p>
      </form>
      <ConfirmDialog open={confirming} title="Confirmar solicitud de cobro" description={`Solicitarás ${money(amount)} de ${periodLabel(period.period)} al Nequi ${phone}. El monto quedará reservado y tendrás ${money(remaining)} disponibles.`} confirmLabel="Confirmar solicitud" busy={busy} onCancel={() => { if (!busy) setConfirming(false); }} onConfirm={() => void submitRequest()} />
    </dialog>
  );
}

export default function SellerCommissions({ initialServerNow }: { initialServerNow: string }) {
  const [data, setData] = useState<SellerCommissionDashboard | null>(null);
  const [error, setError] = useState("");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [drawerPeriod, setDrawerPeriod] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const fetchSequence = useRef(0);
  const initiallyUpcoming = Date.parse(initialServerNow) < Date.parse(COMMISSION_STARTS_AT);

  const refresh = useCallback(async () => {
    const sequence = ++fetchSequence.current;
    try {
      const response = await fetch("/api/comisiones", { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "No pudimos consultar tus comisiones.");
      if (sequence !== fetchSequence.current) return;
      setData(result);
      if (result.payoutsPaused) {
        setDrawerPeriod(null);
        setNotice("");
      }
      setError("");
    } catch (cause) {
      if (sequence !== fetchSequence.current) return;
      setError(cause instanceof Error ? cause.message : "No pudimos consultar tus comisiones.");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    const onFocus = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      fetchSequence.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (data?.active) return;
    const delay = Date.parse(data?.startsAt ?? COMMISSION_STARTS_AT) - Date.parse(data?.serverNow ?? initialServerNow);
    if (delay < 0) return;
    const timer = window.setTimeout(() => void refresh(), Math.min(delay + 100, 2_147_000_000));
    return () => window.clearTimeout(timer);
  }, [data, initialServerNow, refresh]);

  const upcoming = data ? !data.active : initiallyUpcoming;
  if (upcoming) return <section className={styles.section} aria-labelledby="seller-commissions-title"><ComingSoon /></section>;
  if (!data) return <section className={styles.section} aria-label="Mis comisiones"><Card className={styles.card}>{error ? <div className={styles.errorState} role="alert"><Coins aria-hidden="true" /><h2>Mis comisiones</h2><p>{error}</p><Button variant="secondary" onClick={() => void refresh()}>Volver a intentar</Button></div> : <LoadingState label="Consultando tus comisiones…" />}</Card></section>;

  const period = data.periods.find((entry) => entry.period === selectedPeriod) ?? data.periods.find((entry) => entry.period === data.currentPeriod) ?? data.periods[0];
  const currentDrawerPeriod = data.periods.find((entry) => entry.period === drawerPeriod);
  const requests = data.requests.filter((request) => request.period === period?.period);
  const lastPayment = data.requests.filter((request) => request.status === "PAID" && request.receiptUrl).sort((a, b) => (b.paidAt ?? "").localeCompare(a.paidAt ?? ""))[0];
  const priorPeriods = data.periods.filter((entry) => entry.period !== data.currentPeriod && entry.available > 0);

  if (!period) return <section className={styles.section} aria-label="Mis comisiones"><Card className={styles.card}><p>Aún no hay un período de comisiones disponible.</p><Button variant="secondary" onClick={() => void refresh()}>Actualizar</Button></Card></section>;

  return (
    <section className={styles.section} aria-labelledby="seller-commissions-title">
      <Card className={styles.card}>
        <header className={styles.cardHeader}>
          <div className={styles.title}><Coins size={29} aria-hidden="true" /><div><h2 id="seller-commissions-title">Mis comisiones</h2><p>Avanza en tus créditos para activar tu bolsa de comisiones.</p></div></div>
          <label className={styles.periodSelect}><CalendarDays size={18} aria-hidden="true" /><span className={styles.srOnly}>Período de comisiones</span><Select value={period.period} onChange={(event) => setSelectedPeriod(event.target.value)}>{data.periods.map((entry) => <option key={entry.period} value={entry.period}>{periodLabel(entry.period)}{entry.period !== data.currentPeriod && !data.payoutsPaused ? ` · ${money(entry.available)} disponibles` : ""}</option>)}</Select></label>
        </header>
        <div className={styles.commissionGrid}>
          <CommissionProgress count={period.validCreditCount} />
          <div className={styles.financials}>
            {data.payoutsPaused ? <PausedPayouts /> : <>
            <div className={styles.earnings}>
              <div><Wallet size={22} aria-hidden="true" /><dl><dt>Tarifa actual</dt><dd>{money(period.rate)}</dd><dt className={styles.detail}>por crédito</dt></dl></div>
              <div><BarChart3 size={22} aria-hidden="true" /><dl><dt>Comisión del mes</dt><dd>{money(period.generated)}</dd><dt className={styles.detail}>Total generado</dt></dl></div>
            </div>
            <div className={styles.balanceRow}><BalanceSummary period={period} /><div className={styles.payoutAction}><Button onClick={() => setDrawerPeriod(period.period)} disabled={period.available <= 0 || Boolean(error)}>Cobrar</Button><small>{period.available > 0 ? "Disponible para cobrar." : period.reserved > 0 ? "Tu solicitud está en trámite." : "Aún no tienes saldo disponible."}</small></div></div>
            </>}
          </div>
        </div>
        {period.adjustment > 0 && !data.payoutsPaused ? <p className={styles.adjustment} role="status"><Info size={18} aria-hidden="true" />Este período tiene un ajuste de {money(period.adjustment)} por créditos anulados. El saldo disponible se mantiene en cero hasta compensarlo.</p> : null}
        {priorPeriods.length > 0 && !data.payoutsPaused ? <p className={styles.priorNote}><CalendarDays size={16} aria-hidden="true" />Conservas saldo de {priorPeriods.map((entry) => periodLabel(entry.period)).join(", ")}. Selecciona el mes para consultarlo y cobrarlo.</p> : null}
        {error ? <div className={styles.refreshError} role="alert"><span>{error} Actualiza el saldo para continuar.</span><Button variant="secondary" onClick={() => void refresh()}>Actualizar</Button></div> : null}
        {notice ? <p className={styles.successNotice} role="status"><CheckCircle2 size={18} aria-hidden="true" />{notice}</p> : null}
        {lastPayment ? <p className={styles.paymentNotice} role="status"><BellRing size={18} aria-hidden="true" /><span>FINSER PAY confirmó tu pago de <strong>{money(lastPayment.amount)}</strong> de {periodLabel(lastPayment.period)}.</span><a href={lastPayment.receiptUrl!} download><Download size={16} aria-hidden="true" />Comprobante</a></p> : null}
        {requests.length > 0 ? <details className={styles.history}><summary><span>Solicitudes y comprobantes <small>({requests.length})</small></span><ChevronDown size={18} aria-hidden="true" /></summary><div className={styles.requestList}>{requests.map((request) => <article key={request.id} className={styles.request}><div><strong>{money(request.amount)}</strong><small>{dateLabel(request.createdAt)} · Nequi {request.nequi}</small>{request.rejectionReason && !data.payoutsPaused ? <p>Motivo: {request.rejectionReason}</p> : null}</div><div className={styles.requestState}><StatusPill tone={request.status === "PAID" ? "positive" : request.status === "REJECTED" ? "danger" : "neutral"}>{request.status === "PAID" ? "Pagado" : request.status === "REJECTED" ? "Rechazado" : "En trámite"}</StatusPill>{request.status === "PAID" && request.receiptUrl ? <a href={request.receiptUrl} download><Download size={16} aria-hidden="true" />Descargar comprobante</a> : null}</div></article>)}</div></details> : null}
      </Card>
      {currentDrawerPeriod && !data.payoutsPaused ? <PayoutDrawer period={currentDrawerPeriod} onClose={() => setDrawerPeriod(null)} onRefresh={refresh} onSubmitted={async (amount) => { setNotice(`Solicitud por ${money(amount)} enviada. El monto quedó reservado para tu pago.`); await refresh(); }} /> : null}
    </section>
  );
}
