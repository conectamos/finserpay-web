"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ChartNoAxesColumnIncreasing, TriangleAlert, X } from "lucide-react";
import { Badge, Button } from "@/app/_components/finser-ui";
import styles from "./datacredito-daily-quota-modal.module.css";

type DataCreditoDailyQuotaModalProps = {
  open: boolean;
  onClose: () => void;
  percentUsed: number;
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
        <div className={styles.illustration} aria-hidden="true">
          <div className={styles.artwork}>
            <Image
              src={illustrationSrc}
              alt=""
              fill
              sizes="(max-width: 760px) 310px, 440px"
              className={styles.mascot}
            />
            <div className={styles.indicator}>
              <span>{percentUsed}<small> %</small></span>
              <TriangleAlert className={styles.indicatorAlert} aria-hidden="true" />
            </div>
            <span className={styles.phoneBrand}>FINSER PAY<span /></span>
          </div>
        </div>
        <div className={styles.content}>
          <Badge tone="warning" className={styles.badge}>
            <TriangleAlert size={23} aria-hidden="true" />
            LÍMITE ALCANZADO
          </Badge>
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className={styles.title}>
            Consultas disponibles nuevamente mañana
          </h2>
          <p id={descriptionId} className={styles.message}>
            Estimado aliado, hoy alcanzó el {percentUsed} % de consultas permitidas.
          </p>
          <p className={styles.orientation}>
            Puede seguir trabajando con las solicitudes que ya fueron aprobadas y convertirlas en ventas.
          </p>
          <div className={styles.simulatorNote}>
            <span className={styles.simulatorIcon}>
              <ChartNoAxesColumnIncreasing size={29} aria-hidden="true" />
            </span>
            <p>Para cotizaciones, utilice el <strong>simulador.</strong></p>
          </div>
          <div className={styles.actions}>
            <Link
              href={approvedHref}
              className={`fp-ui-button is-primary ${styles.primaryAction}`}
              aria-disabled={false}
              onClick={onClose}
            >
              <span>Retomar solicitudes aprobadas</span>
              <ArrowRight size={25} aria-hidden="true" />
            </Link>
            <Link
              href={simulatorHref}
              className={`fp-ui-button is-secondary ${styles.secondaryAction}`}
              aria-disabled={false}
              onClick={onClose}
            >
              Ir al simulador
            </Link>
          </div>
        </div>
      </div>
    </dialog>,
    document.body
  );
}
