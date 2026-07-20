"use client";

import { useEffect } from "react";
import { Button } from "@/app/_components/finser-ui";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel, open]);

  if (!open) return null;

  return (
    <div className="fp-ui-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="fp-ui-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fp-confirm-title"
        aria-describedby="fp-confirm-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="fp-confirm-title">{title}</h2>
        <p id="fp-confirm-description">{description}</p>
        <div>
          <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>
            Volver
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Procesando..." : confirmLabel}
          </Button>
        </div>
      </section>
    </div>
  );
}
