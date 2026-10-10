"use client";

import Image from "next/image";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ArrowRight, Check, Clock3, LoaderCircle, LockKeyhole, QrCode, RefreshCw, X } from "lucide-react";
import FinserBrand from "@/app/_components/finser-brand";
import { Button } from "@/app/_components/finser-ui";
import styles from "./veriff-identity-dialog.module.css";

export type VeriffIdentityDialogStatus = "pending" | "processing" | "approved" | "rejected" | "expired" | "error" | "unavailable";

export type VeriffIdentityDialogProps = {
  open: boolean;
  status: VeriffIdentityDialogStatus;
  statusLabel?: string;
  message?: string | null;
  busy?: boolean;
  dismissible?: boolean;
  qrDataUrl?: string | null;
  qrVisible?: boolean;
  canOpenQr?: boolean;
  canRetry?: boolean;
  retryLabel?: string;
  canContinue?: boolean;
  mascotSrc?: string;
  connectionLabel?: string;
  connectionError?: string | null;
  onOpenQr: () => void;
  onClose: () => void;
  onRetry?: () => void;
  onContinue?: () => void;
  onRetryConnection?: () => void;
  children?: ReactNode;
};

const statusLabels: Record<VeriffIdentityDialogStatus, string> = {
  pending: "Pendiente",
  processing: "En proceso",
  approved: "Aprobada",
  rejected: "Rechazada",
  expired: "Código vencido",
  error: "Error de conexión",
  unavailable: "No disponible",
};

export default function VeriffIdentityDialog({
  open, status, statusLabel, message, busy = false, dismissible = true,
  qrDataUrl, qrVisible = false, canOpenQr = false, canRetry = false,
  retryLabel = "Reintentar validación", canContinue = false,
  mascotSrc = "/assets/creditos/veriff-identity-shield-mascot.png",
  connectionLabel, connectionError, onOpenQr, onClose, onRetry, onContinue,
  onRetryConnection, children,
}: VeriffIdentityDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const qrId = `${id}-qr`;
  const approved = status === "approved";
  const failure = status === "rejected" || status === "error" || status === "unavailable";
  const retryAvailable = !approved && canRetry && Boolean(onRetry);
  const showQr = qrVisible && !approved && !failure && status !== "expired";
  const StatusIcon = approved ? Check : busy || status === "processing" ? LoaderCircle : failure ? AlertCircle : Clock3;

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      (closeRef.current || titleRef.current)?.focus();
    });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        titleRef.current?.focus();
      } else if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", trapFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      dialog.removeEventListener("keydown", trapFocus);
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-modal="true"
      onCancel={(event) => { event.preventDefault(); if (dismissible) onClose(); }}
      onClick={(event) => {
        if (!dismissible || event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      <header className={styles.header}>
        <div className={styles.brand}><FinserBrand wordmarkOnly accentPay showTagline={false} /></div>
        <span className={styles.step}>PASO 3</span>
        {dismissible ? <button ref={closeRef} type="button" className={styles.close} onClick={onClose} aria-label="Cerrar verificación de identidad"><X aria-hidden="true" /></button> : null}
      </header>

      <div className={styles.layout}>
        <div className={styles.illustration} aria-hidden="true">
          <Image src={mascotSrc} width={320} height={360} alt="" unoptimized />
        </div>
        <div className={styles.content}>
          <div className={styles.headingRow}>
            <div className={styles.copy}>
              <h2 ref={titleRef} id={titleId} tabIndex={-1}>{approved ? "Identidad aprobada" : "Valida la identidad"}</h2>
              <p id={descriptionId}>{approved ? "El cliente completó correctamente la validación." : "El cliente escanea el QR desde su celular."}</p>
              <div className={styles.statuses} aria-live="polite" aria-atomic="true">
                <span className={styles.provider}>Veriff</span>
                <span className={`${styles.status} ${approved ? styles.approved : failure ? styles.failure : styles.pending}`}>
                  <StatusIcon className={busy || status === "processing" ? styles.spinner : undefined} aria-hidden="true" />
                  {statusLabel || statusLabels[status]}
                </span>
              </div>
            </div>
            <div className={styles.action}>
              {approved ? (
                <Button className={styles.primary} onClick={onContinue} disabled={!canContinue || !onContinue || busy} aria-busy={busy}>
                  {busy ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <Check aria-hidden="true" />}
                  Continuar a firma<ArrowRight aria-hidden="true" />
                </Button>
              ) : retryAvailable ? (
                <Button className={styles.primary} onClick={onRetry} disabled={busy} aria-busy={busy}>
                  {busy ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                  {busy ? "Preparando validación…" : retryLabel}
                </Button>
              ) : (
                <Button className={styles.primary} onClick={onOpenQr} disabled={!canOpenQr || busy || qrVisible} aria-busy={busy} aria-expanded={showQr} aria-controls={showQr ? qrId : undefined}>
                  {busy ? <LoaderCircle className={styles.spinner} aria-hidden="true" /> : <QrCode aria-hidden="true" />}
                  {busy ? "Generando QR…" : qrVisible ? "Código QR abierto" : "Abrir código QR"}
                </Button>
              )}
            </div>
          </div>

          {message || children || connectionLabel || connectionError ? (
            <div className={styles.details}>
              {message ? <p className={failure ? styles.error : styles.message} role={failure ? "alert" : "status"}>{message}</p> : null}
              {connectionLabel || connectionError ? (
                <div className={`${styles.connection} ${connectionError ? styles.connectionFailed : ""}`} role="status">
                  <span aria-hidden="true" />
                  <p>{connectionError || connectionLabel}</p>
                  {connectionError && onRetryConnection ? <Button variant="ghost" onClick={onRetryConnection} disabled={busy}>Reintentar</Button> : null}
                </div>
              ) : null}
              {children}
            </div>
          ) : null}

          {showQr ? (
            <section id={qrId} className={styles.qr} aria-label="Código QR de Veriff" aria-busy={busy} aria-live="polite">
              {qrDataUrl ? <Image src={qrDataUrl} width={256} height={256} alt="Código QR para validar la identidad del cliente" unoptimized /> : <div className={styles.qrLoading}><LoaderCircle className={styles.spinner} aria-hidden="true" /><span>Preparando código QR…</span></div>}
              <p>Escanea el código con el celular del cliente.</p>
            </section>
          ) : null}

          <ol className={styles.progress} aria-label="Progreso de identidad y firma">
            <li className={approved ? styles.completeStep : styles.currentStep} aria-current={approved ? undefined : "step"}>
              <span aria-hidden="true">{approved ? <Check /> : <i />}</span><strong>Validar identidad</strong>
            </li>
            <li className={approved ? styles.currentStep : styles.lockedStep} aria-current={approved ? "step" : undefined}>
              <span aria-hidden="true">{approved ? <i /> : <LockKeyhole />}</span><strong>Enviar contrato</strong>
            </li>
            <li className={styles.lockedStep}><span aria-hidden="true"><LockKeyhole /></span><strong>Firma confirmada</strong></li>
          </ol>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
