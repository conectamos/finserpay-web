"use client";

import { useEffect, useId, useRef } from "react";
import { ArrowRight, LoaderCircle, Smartphone, X } from "lucide-react";
import { Button, Input } from "@/app/_components/finser-ui";
import styles from "./client-nequi-payment-dialog.module.css";

type ClientNequiPaymentDialogProps = {
  amount: number;
  installmentLabel: string;
  product: string;
  imei: string | null;
  document: string;
  phone: string;
  acceptedTerms: boolean;
  submitting: boolean;
  notice: { text: string; tone: "red" | "emerald" } | null;
  onPhoneChange: (value: string) => void;
  onTermsChange: (accepted: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function maskedIdentifier(value: string | null) {
  const identifier = value?.trim();
  return identifier ? `••••${identifier.slice(-4)}` : "No registrado";
}

export default function ClientNequiPaymentDialog({
  amount,
  installmentLabel,
  product,
  imei,
  document: creditDocument,
  phone,
  acceptedTerms,
  submitting,
  notice,
  onPhoneChange,
  onTermsChange,
  onCancel,
  onSubmit,
}: ClientNequiPaymentDialogProps) {
  const id = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const busyRef = useRef(submitting);
  const cancelRef = useRef(onCancel);
  const canSubmit = /^\d{10}$/.test(phone) && acceptedTerms && !submitting;

  useEffect(() => {
    busyRef.current = submitting;
    cancelRef.current = onCancel;
  }, [submitting, onCancel, notice]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusableElements = () => Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
    const focusInside = (last = false) => {
      const focusable = focusableElements();
      (last ? focusable.at(-1) : focusable[0])?.focus();
      if (focusable.length === 0) dialog.focus();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (!dialog.contains(document.activeElement)) {
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
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) focusInside();
    };
    const updateViewport = () => {
      const viewport = window.visualViewport;
      backdropRef.current?.style.setProperty("--nequi-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      backdropRef.current?.style.setProperty("--nequi-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    };

    dialog.focus();
    updateViewport();
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function cancelPayment() {
    if (!busyRef.current) cancelRef.current();
  }

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancelPayment();
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-instructions`}
        aria-busy={submitting}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <p>Nequi por Wompi</p>
            <h2 id={`${id}-title`}>Pagar con Nequi</h2>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="Cerrar pago con Nequi"
            disabled={submitting}
            onClick={cancelPayment}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSubmit || busyRef.current) return;
            busyRef.current = true;
            onSubmit();
          }}
        >
          <div className={styles.body}>
            <div className={styles.total}>
              <p className={styles.totalLabel}>Total a pagar</p>
              <p className={styles.amount}>{moneyFormatter.format(amount)}</p>
              <p className={styles.installmentLabel}>{installmentLabel}</p>
            </div>

            <dl className={styles.details}>
              <div>
                <dt>Producto</dt>
                <dd>{product}</dd>
              </div>
              <div>
                <dt>IMEI</dt>
                <dd>{maskedIdentifier(imei)}</dd>
              </div>
              <div>
                <dt>Documento</dt>
                <dd>{maskedIdentifier(creditDocument)}</dd>
              </div>
            </dl>

            <div className={styles.phoneField}>
              <label htmlFor={`${id}-phone`}>Número Nequi</label>
              <div className={styles.phoneControl}>
                <Smartphone aria-hidden="true" />
                <Input
                  id={`${id}-phone`}
                  className={styles.phoneInput}
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  placeholder="Tu número Nequi"
                  value={phone}
                  disabled={submitting}
                  aria-describedby={`${id}-instructions`}
                  onChange={(event) => onPhoneChange(event.target.value)}
                />
              </div>
              <p id={`${id}-instructions`} className={styles.instructions}>
                Recibirás una solicitud en la app Nequi para aprobar el pago
              </p>
            </div>

            <label className={styles.terms}>
              <input
                type="checkbox"
                checked={acceptedTerms}
                disabled={submitting}
                onChange={(event) => onTermsChange(event.target.checked)}
              />
              <span>
                Acepto los <strong>términos y condiciones</strong> y la{" "}
                <a href="/politica-privacidad" target="_blank" rel="noopener noreferrer">
                  política de privacidad
                </a>.
              </span>
            </label>

            {notice ? (
              <p
                role={notice.tone === "red" ? "alert" : "status"}
                className={`${styles.notice} ${notice.tone === "red" ? styles.noticeError : styles.noticeSuccess}`}
              >
                {notice.text}
              </p>
            ) : null}
          </div>

          <footer className={styles.footer}>
            <Button type="submit" className={styles.submitButton} disabled={!canSubmit}>
              {submitting ? (
                <LoaderCircle className={styles.spinner} aria-hidden="true" />
              ) : null}
              <span>{submitting ? "Enviando solicitud…" : "Enviar solicitud a Nequi"}</span>
              {!submitting ? <ArrowRight aria-hidden="true" /> : null}
            </Button>
            <Button variant="ghost" className={styles.cancelButton} disabled={submitting} onClick={cancelPayment}>
              Cancelar
            </Button>
          </footer>
        </form>
      </section>
    </div>
  );
}