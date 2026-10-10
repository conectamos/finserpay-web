"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, LoaderCircle, Smartphone, X } from "lucide-react";
import styles from "./equipment-signature.module.css";

export default function ImeiConfirmationDialog({ open, expectedImei, busy, onCancel, onConfirm }: {
  open: boolean;
  expectedImei: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (imei: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setValue("");
      setError("");
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const submit = async () => {
    if (busy || submittingRef.current) return;
    if (!/^\d{15}$/.test(value)) {
      setError("El IMEI debe contener exactamente 15 números.");
      inputRef.current?.focus();
      return;
    }
    if (value !== expectedImei) {
      setError("Los IMEI no coinciden. Revisa el número directamente en el equipo e inténtalo nuevamente.");
      inputRef.current?.focus();
      return;
    }
    submittingRef.current = true;
    setError("");
    try {
      await onConfirm(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo guardar la confirmación. Reintenta.");
    } finally {
      submittingRef.current = false;
    }
  };

  return <dialog ref={dialogRef} className={styles.imeiDialog}
    aria-labelledby="imei-confirmation-title" aria-describedby="imei-confirmation-description"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <button type="button" className={styles.dialogClose} onClick={onCancel} disabled={busy} aria-label="Cerrar confirmación de IMEI"><X aria-hidden="true" /></button>
    <span className={styles.dialogIcon}><Smartphone aria-hidden="true" /></span>
    <h2 id="imei-confirmation-title">Confirma el IMEI</h2>
    <p id="imei-confirmation-description">Ingresa nuevamente los 15 dígitos del IMEI. Verifícalos directamente en el equipo.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
      <label htmlFor="confirm-equipment-imei">Confirmar IMEI</label>
      <input ref={inputRef} id="confirm-equipment-imei" name="confirm-equipment-imei" type="text"
        inputMode="numeric" autoComplete="off" autoCorrect="off" spellCheck={false}
        minLength={15} maxLength={15} pattern="[0-9]{15}"
        value={value} onChange={(event) => { setValue(event.target.value.replace(/\D/g, "").slice(0, 15)); setError(""); }}
        disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? "imei-confirmation-error" : undefined} />
      {error ? <p id="imei-confirmation-error" className={styles.dialogError} role="alert">{error}</p> : null}
      <div className={styles.dialogActions}>
        <button type="button" onClick={onCancel} disabled={busy}>Volver a revisar</button>
        <button type="submit" disabled={busy} aria-busy={busy}>{busy ? <><LoaderCircle className={styles.spinner} aria-hidden="true" />Confirmando…</> : <>Confirmar y continuar<ArrowRight aria-hidden="true" /></>}</button>
      </div>
    </form>
  </dialog>;
}
