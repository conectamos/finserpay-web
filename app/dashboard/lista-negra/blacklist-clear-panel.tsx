"use client";

import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Button, Card } from "@/app/_components/finser-ui";
import type { BlacklistClearInput, BlacklistClearPreview, BlacklistClearResult } from "@/lib/document-blacklist-clear";

type Props = { disabled: boolean; onBusyChange: (busy: boolean) => void; onCompleted: () => void };

export default function BlacklistClearPanel({ disabled, onBusyChange, onCompleted }: Props) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<BlacklistClearPreview | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState<BlacklistClearInput | null>(null);
  const inFlight = useRef(false);

  async function review() {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setOpen(true);
    onBusyChange(true);
    setError("");
    setSuccess("");
    setPreview(null);
    try {
      const response = await fetch("/api/lista-negra/limpiar", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "No se pudo revisar la lista negra.");
      setPreview(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo revisar la lista negra.");
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  function close() {
    if (inFlight.current) return;
    setOpen(false);
    setConfirming(false);
    setPreview(null);
    setReason("");
    setError("");
    setPending(null);
    onBusyChange(false);
  }

  function confirm() {
    if (disabled || inFlight.current || !preview?.total || reason.trim().length < 5 || reason.trim().length > 500) return;
    if (!pending) setPending({ motivo: reason.trim(), mutationId: crypto.randomUUID(), fingerprint: preview.fingerprint, confirmed: true });
    setConfirming(true);
  }

  async function clear() {
    if (!pending || inFlight.current || disabled) return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/lista-negra/limpiar", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending),
      });
      const result = await response.json() as Partial<BlacklistClearResult> & { ok?: boolean; error?: string; code?: string };
      if (!response.ok || !result.ok) {
        if (response.status === 409) { setPreview(null); setPending(null); }
        throw new Error(result.error || "No se pudo confirmar la limpieza. Reintenta para comprobar el resultado.");
      }
      setSuccess(`Se eliminaron ${result.removed} cédulas de la lista negra y se levantaron ${result.unblocked} bloqueos. El historial de auditoría se conserva.`);
      setOpen(false);
      setPreview(null);
      setReason("");
      setPending(null);
      onBusyChange(false);
      onCompleted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar la limpieza. Reintenta para comprobar el resultado.");
    } finally {
      inFlight.current = false;
      setWorking(false);
      setConfirming(false);
    }
  }

  return <section className="mt-5" aria-label="Limpiar lista negra">
    {!open ? <Button variant="danger" disabled={disabled} onClick={() => void review()}><Trash2 className="h-4 w-4" aria-hidden="true" />Eliminar todas las cédulas</Button> : null}
    {success ? <p role="status" className="mt-3 text-sm text-[var(--fp-graphite)]">{success}</p> : null}
    {open ? <Card className="p-4 sm:p-5">
      <h2 className="text-lg font-bold">Eliminar todas las cédulas de la lista negra</h2>
      <p className="mt-2 text-sm text-[var(--fp-muted)]">Incluye toda la lista, sin importar la búsqueda, el estado o la página actual. Se conserva la auditoría y siguen vigentes las demás reglas de aprobación.</p>
      {working && !confirming ? <p role="status" className="mt-3 text-sm">Revisando la lista...</p> : null}
      {preview ? <p className="mt-3 text-sm font-semibold">{preview.total} cédulas registradas: {preview.active} con bloqueo activo y {preview.inactive} inactivas.</p> : null}
      {preview?.total ? <label className="mt-4 block">
        <span className="mb-2 block text-sm font-semibold">Motivo de la limpieza</span>
        <textarea className="fp-ui-input min-h-20" value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} rows={2} disabled={working || confirming || Boolean(pending)} placeholder="Describe el motivo de esta decisión" />
      </label> : preview && !preview.total ? <p role="status" className="mt-3 text-sm">La lista negra está vacía.</p> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-[var(--fp-danger)]">{error}</p> : null}
      {pending && error ? <p className="mt-2 text-sm text-[var(--fp-muted)]">Reintenta la misma operación para confirmar el resultado sin volver a eliminar registros nuevos.</p> : null}
      <div className="mt-4 flex flex-wrap gap-2">
        {preview?.total ? <Button variant="danger" disabled={disabled || working || confirming || reason.trim().length < 5} onClick={confirm}>{pending ? "Reintentar limpieza" : "Revisar eliminación"}</Button> : !preview ? <Button variant="secondary" onClick={() => void review()} disabled={disabled || working}>Revisar total actualizado</Button> : null}
        <Button variant="secondary" disabled={working || confirming} onClick={close}>Cancelar</Button>
      </div>
    </Card> : null}
    <ConfirmDialog open={confirming} title="Confirmar eliminación de toda la lista negra"
      description={`Se eliminarán las ${preview?.total ?? 0} cédulas registradas y se levantarán ${preview?.active ?? 0} bloqueos en todos los aliados. La lista quedará vacía. Se conservará el historial de auditoría. Motivo: ${pending?.motivo ?? reason}`}
      confirmLabel="Eliminar todas las cédulas" danger busy={working}
      onCancel={() => { if (!inFlight.current) { setConfirming(false); if (!error) setPending(null); } }} onConfirm={() => void clear()} />
  </section>;
}
