"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "./finser-ui";
import styles from "./finser-side-panel.module.css";

export default function FinserSidePanel({ open, title, closeLabel = "Cerrar panel", busy = false, onClose, children }: {
  open: boolean; title: string; closeLabel?: string; busy?: boolean; onClose: () => void; children: ReactNode;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open || !panel.current) return;
    const element = panel.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  return <dialog ref={panel} className={styles.panel} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => {
      if (busy || event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className={styles.header}><h2 id={titleId}>{title}</h2><Button variant="ghost" aria-label={closeLabel} disabled={busy} onClick={onClose}><X aria-hidden="true" /></Button></header>
    <div className={styles.content}>{children}</div>
  </dialog>;
}
