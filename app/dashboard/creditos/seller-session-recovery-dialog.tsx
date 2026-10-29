"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Button, Input } from "@/app/_components/finser-ui";

export type SellerSessionRecoveryContext = {
  sellerId: number;
  sellerName: string;
  siteId: number;
  siteName: string;
  userId: number;
  draftId: number;
};

type RecoveryResponse = {
  ok?: boolean;
  error?: string;
  code?: string;
  requiresSedeSelection?: boolean;
  mustChangePin?: boolean;
  seller?: { id?: number };
  operationalSede?: { id?: number };
  recovery?: { draftId?: number; userId?: number; sellerId?: number; sedeId?: number };
};

export default function SellerSessionRecoveryDialog({ open, context, onRecovered, onCancel, formInAnotherTab = false }: {
  open: boolean;
  context: SellerSessionRecoveryContext;
  onRecovered: () => void;
  onCancel: () => void;
  formInAnotherTab?: boolean;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const flightRef = useRef(false);
  const requestEpoch = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsPanel, setNeedsPanel] = useState<"/dashboard" | "/dashboard/pin" | null>(null);
  const formLocation = formInAnotherTab ? "la pestaña original" : "esta pantalla";
  const contextKey = `${context.userId}:${context.sellerId}:${context.siteId}:${context.draftId}`;
  const invalidateRequest = useCallback(() => {
    requestEpoch.current++;
    requestRef.current?.abort();
    requestRef.current = null;
    flightRef.current = false;
  }, []);

  useEffect(() => {
    invalidateRequest();
    setBusy(false);
    setPin("");
    setError("");
    setNeedsPanel(null);
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && open) {
      if (!dialog.open) dialog.showModal();
      inputRef.current?.focus();
    } else if (dialog?.open) {
      dialog.close();
    }
    return () => {
      invalidateRequest();
      if (dialog?.open) dialog.close();
      if (open && previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, contextKey, invalidateRequest]);

  const cancel = () => {
    if (flightRef.current) return;
    setPin("");
    setError("");
    onCancel();
  };

  const recover = async () => {
    if (!open || flightRef.current) return;
    if (!/^\d{4,6}$/.test(pin)) {
      setPin("");
      setError("Ingresa el PIN de tu perfil, de 4 a 6 dígitos.");
      inputRef.current?.focus();
      return;
    }
    const expected = { ...context };
    const requestBody = JSON.stringify({
      vendedorId: expected.sellerId, pin, sedeId: expected.siteId,
      recoveryDraftId: expected.draftId, expectedUserId: expected.userId,
    });
    // The PIN only exists in this request. Never persist it with the draft.
    setPin("");
    flightRef.current = true;
    setBusy(true);
    setError("");
    setNeedsPanel(null);
    const epoch = ++requestEpoch.current;
    const controller = new AbortController();
    requestRef.current = controller;
    let timedOut = false;
    const deadline = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    try {
      const response = await fetch("/api/vendedores/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", credentials: "same-origin", signal: controller.signal, body: requestBody,
      });
      const data = await response.json().catch(() => null) as RecoveryResponse | null;
      if (epoch !== requestEpoch.current || controller.signal.aborted) return;
      if (!response.ok || data?.ok !== true) {
        const baseSessionLost = (response.status === 401 && data?.code !== "INVALID_SELLER_PIN")
          || data?.code === "AUTH_REQUIRED" || data?.code === "SESSION_USER_CHANGED";
        setNeedsPanel(baseSessionLost ? "/dashboard" : null);
        setError(baseSessionLost
          ? `Vuelve a ingresar con el usuario de acceso original en otra pestaña. Después regresa aquí e introduce tu PIN; los datos siguen en ${formLocation}.`
          : typeof data?.error === "string" ? data.error : "No fue posible confirmar tu perfil. Revisa el PIN e intenta de nuevo.");
        return;
      }
      if (data.requiresSedeSelection || data.seller?.id !== expected.sellerId || data.operationalSede?.id !== expected.siteId
        || data.recovery?.draftId !== expected.draftId || data.recovery?.userId !== expected.userId
        || data.recovery?.sellerId !== expected.sellerId || data.recovery?.sedeId !== expected.siteId) {
        setError("No se confirmó el perfil y la sede de esta solicitud. Vuelve a intentarlo.");
        return;
      }
      if (data.mustChangePin) {
        setNeedsPanel("/dashboard/pin");
        setError(`Actualiza el PIN desde tu perfil en otra pestaña y vuelve aquí para confirmarlo. Los datos de esta solicitud siguen en ${formLocation}.`);
        return;
      }
      onRecovered();
    } catch {
      if (epoch !== requestEpoch.current || (controller.signal.aborted && !timedOut)) return;
      setError(timedOut
        ? `La confirmación tardó demasiado. Revisa tu conexión e intenta de nuevo; los datos siguen en ${formLocation}.`
        : "No fue posible confirmar tu perfil. Revisa tu conexión e intenta de nuevo.");
    } finally {
      window.clearTimeout(deadline);
      if (epoch === requestEpoch.current) {
        flightRef.current = false;
        requestRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    }
  };

  return <dialog ref={dialogRef} className="fp-ui-dialog m-auto max-h-[calc(100dvh-32px)] overflow-y-auto backdrop:bg-[rgb(7_24_39_/_0.66)]"
    style={{ width: "min(440px, calc(100vw - 32px))" }}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
    onCancel={event => { event.preventDefault(); cancel(); }}>
    <header>
      <LockKeyhole className="mb-3 h-6 w-6 text-[var(--fp-graphite)]" aria-hidden="true" />
      <h2 id={`${id}-title`}>Confirma tu perfil para continuar</h2>
      <p id={`${id}-description`}>Tus datos siguen en {formLocation}. Ingresa tu PIN para recuperar la sesión y continuar con la misma solicitud.</p>
      <p><strong className="text-[var(--fp-graphite)]">{context.sellerName}</strong><br />{context.siteName} · Solicitud {context.draftId}</p>
    </header>
    <form className="mt-5" onSubmit={event => { event.preventDefault(); void recover(); }} noValidate>
      <label htmlFor={`${id}-pin`} className="mb-2 block text-sm font-semibold text-[var(--fp-graphite)]">PIN del perfil</label>
      <Input ref={inputRef} id={`${id}-pin`} type="password" name="seller-recovery-pin" inputMode="numeric"
        autoComplete="off" autoCorrect="off" spellCheck={false} minLength={4} maxLength={6} pattern="[0-9]{4,6}"
        value={pin} onChange={event => { setPin(event.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
        disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
      {error ? <p id={`${id}-error`} role="alert">{error}</p> : null}
      {needsPanel ? <p><a className="font-semibold underline underline-offset-4" href={needsPanel} target="_blank" rel="noopener noreferrer">{needsPanel === "/dashboard/pin" ? "Actualizar PIN en otra pestaña" : "Abrir panel en otra pestaña"}</a></p> : null}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={cancel} disabled={busy}>Volver al formulario</Button>
        <Button type="submit" disabled={busy} aria-busy={busy}>{busy ? "Confirmando..." : "Confirmar y continuar"}</Button>
      </div>
    </form>
  </dialog>;
}
