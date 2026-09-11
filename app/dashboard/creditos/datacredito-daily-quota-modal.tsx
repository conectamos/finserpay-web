"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Calculator, X } from "lucide-react";
import { Button } from "@/app/_components/finser-ui";
import { formatQuotaRehabilitationDate } from "@/lib/datacredito/quota-rehabilitation-date";
import styles from "./datacredito-daily-quota-modal.module.css";

type DataCreditoDailyQuotaModalProps = {
  open: boolean;
  onClose: () => void;
  percentUsed: number;
  resetsAt: string;
  approvedHref: string;
  simulatorHref: string;
  illustrationSrc: string;
  returnFocusId?: string;
};

const subscribeToBrowserReady = () => () => undefined;
const getBrowserReadySnapshot = () => true;
const getServerReadySnapshot = () => false;
const FOCUSABLE_SELECTOR =
  'a[href]:not([aria-disabled="true"]), button:not(:disabled):not([aria-disabled="true"]), [tabindex="0"]';

export default function DataCreditoDailyQuotaModal({
  open,
  onClose,
  percentUsed,
  resetsAt,
  approvedHref,
  simulatorHref,
  illustrationSrc,
  returnFocusId,
}: DataCreditoDailyQuotaModalProps) {
  const browserReady = useSyncExternalStore(
    subscribeToBrowserReady,
    getBrowserReadySnapshot,
    getServerReadySnapshot
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const rehabilitationDate = formatQuotaRehabilitationDate(resetsAt);

  useEffect(() => {
    if (!open || !browserReady) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // showModal places the dialogue in the top layer and makes the page behind it inert.
    if (!dialog.open) dialog.showModal();
    titleRef.current?.focus({ preventScroll: true });

    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousBodyOverflow;
      const trigger = returnFocusId ? document.getElementById(returnFocusId) : null;
      const restoreTarget = trigger ?? previouslyFocused;
      if (restoreTarget?.isConnected) restoreTarget.focus({ preventScroll: true });
    };
  }, [browserReady, open, returnFocusId]);

  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || !last) {
      event.preventDefault();
      titleRef.current?.focus();
      return;
    }

    const active = document.activeElement;
    const activeIsControl = controls.some((element) => element === active);
    if (event.shiftKey && (!activeIsControl || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (!activeIsControl || active === last)) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open || !browserReady) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={trapFocus}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.layout}>
        <Button
          variant="ghost"
          className={styles.close}
          onClick={onClose}
          aria-label="Cerrar aviso de límite diario"
          aria-disabled={false}
        >
          <X size={28} aria-hidden="true" />
        </Button>
        <header className={styles.header} aria-label="FINSER PAY">
          <svg className={styles.headerWave} viewBox="0 0 640 108" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 0H640V69C479 8 404 32 275 74C164 112 75 111 0 75Z" />
          </svg>
          <span className={styles.brand} aria-hidden="true"><span>FINSER</span> PAY</span>
        </header>
        <div className={styles.illustration} aria-hidden="true">
          <div className={styles.artwork}>
            <Image
              src={illustrationSrc}
              alt=""
              fill
              sizes="(max-width: 480px) 240px, 290px"
              className={styles.mascot}
            />
            <span className={styles.indicator}>{percentUsed}<small> %</small></span>
          </div>
        </div>
        <div className={styles.content}>
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className={styles.title}>
            LÍMITE DIARIO ALCANZADO
          </h2>
          <div id={descriptionId}>
            {rehabilitationDate ? (
              <p className={styles.message}>
                Las consultas estarán habilitadas el{" "}
                <time dateTime={resetsAt}>{rehabilitationDate}.</time>
              </p>
            ) : null}
            <p className={styles.orientation}>
              Retome sus solicitudes aprobadas y conviértalas en ventas.
            </p>
          </div>
          <div className={styles.actions}>
            <Link
              href={approvedHref}
              className={`fp-ui-button is-primary ${styles.primaryAction}`}
              aria-disabled={false}
              onClick={onClose}
            >
              Ver aprobados
            </Link>
            <Link
              href={simulatorHref}
              className={`fp-ui-button is-ghost ${styles.secondaryAction}`}
              aria-disabled={false}
              onClick={onClose}
            >
              <Calculator size={27} aria-hidden="true" />
              <span>Cotizar en el simulador</span>
            </Link>
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  );
}
