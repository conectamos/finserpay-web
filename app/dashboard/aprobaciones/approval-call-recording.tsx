"use client";

import { useEffect, useRef, useState } from "react";
import { Phone, Upload } from "lucide-react";
import { Badge, Button, Card } from "@/app/_components/finser-ui";
import { uploadApprovalCallRecording, type ApprovalDetail } from "./approval-client";

const MAX_BYTES = 10 * 1024 * 1024;
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
type PendingRecording = { file: File; revision: number; reviewHash: string; idempotencyKey: string };

export default function ApprovalCallRecording({ detail, disabled, readOnly = false, compact = false, onUpdated, onBusyChange }: {
  detail: ApprovalDetail; disabled: boolean; readOnly?: boolean; compact?: boolean;
  onUpdated: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<PendingRecording | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [playbackRetry, setPlaybackRetry] = useState(0);
  const [playbackError, setPlaybackError] = useState(false);
  const submitting = useRef(false);
  const input = useRef<HTMLInputElement | null>(null);
  const state = detail.callRecording;
  const recording = state?.recording;
  const phone = detail.clienteTelefono?.replace(/[^+0-9]/g, "") || "";
  const phoneHref = /^\+?\d{7,15}$/.test(phone) ? "tel:" + phone : null;
  const canUpload = !readOnly && state?.canUpload === true;

  useEffect(() => { setPlaybackError(false); }, [recording?.id]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  function clearSelection() {
    setPending(null);
    if (input.current) input.current.value = "";
    onBusyChange(false);
  }

  function select(file?: File) {
    if (disabled || saving || submitting.current) return;
    setError("");
    if (!file) { clearSelection(); return; }
    if (!file.size || file.size > MAX_BYTES || !/\.(mp3|m4a|wav)$/i.test(file.name)) {
      setError("Selecciona una grabación MP3, M4A o WAV de hasta 10 MB.");
      clearSelection(); return;
    }
    setPending({ file, revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: crypto.randomUUID() });
    onBusyChange(true);
  }

  async function save() {
    if (!pending || !canUpload || disabled || submitting.current) return;
    if (detail.review.revision !== pending.revision || detail.review.reviewHash !== pending.reviewHash) {
      setError("El expediente cambió. Actualízalo y selecciona la grabación para la revisión vigente.");
      clearSelection(); return;
    }
    submitting.current = true; setSaving(true); setError("");
    let saved = false;
    try {
      await uploadApprovalCallRecording(detail.id, pending);
      saved = true;
      setPending(null);
      if (input.current) input.current.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo guardar la grabación.");
    } finally {
      // An interrupted response may already have saved the file. Reload before approval or retry.
      try { await onUpdated(); } catch { setError("No se pudo actualizar el expediente. Comprueba su estado antes de continuar."); }
      submitting.current = false; setSaving(false);
      if (saved) onBusyChange(false);
    }
  }

  return (
    <Card role="region" aria-label="Llamada al cliente" className="min-w-0 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Phone className="h-5 w-5" aria-hidden="true" />Llamada al cliente</h2>
        {!readOnly ? <Badge tone={error ? "danger" : compact && pending ? "warning" : recording ? "positive" : "warning"}>{compact ? saving ? "Cargando" : error ? "Error" : pending ? "Por guardar" : recording ? "Guardada" : "Pendiente" : recording ? "Grabación cargada" : "Obligatoria"}</Badge> : null}
      </div>
      {!readOnly ? <>
        <p className="mt-3 text-sm text-[var(--fp-muted)]">Llama al cliente y guarda la grabación antes de dar el OK para liquidación.</p>
        <div className="mt-3 text-sm">Teléfono: {phoneHref ? <a href={phoneHref} className="inline-flex min-h-10 items-center break-all font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-graphite)]">{detail.clienteTelefono}</a> : <span>{detail.clienteTelefono || "No disponible"}</span>}</div>
      </> : null}
      {recording ? <div className="mt-4 space-y-2">
        <p className="break-words text-sm font-medium">{recording.fileName}</p>
        <audio key={recording.id + ":" + playbackRetry} aria-label="Grabación de la llamada" controls preload="none" src={recording.href} onError={() => setPlaybackError(true)} className="w-full min-w-0" />
        {playbackError ? <div className="space-y-2"><p role="alert" className="text-sm text-[var(--fp-danger)]">No se pudo reproducir la grabación.</p><Button variant="secondary" onClick={() => { setPlaybackError(false); setPlaybackRetry((value) => value + 1); }}>Reintentar reproducción</Button></div> : null}
        <p className="text-sm text-[var(--fp-muted)]">Cargada por {recording.actorName} · {dates.format(new Date(recording.createdAt))}</p>
      </div> : <p className="mt-3 text-sm text-[var(--fp-muted)]">{!state?.available ? "No se pudo consultar la grabación. Actualiza el expediente." : readOnly ? "Esta aprobación anterior no tiene grabación registrada." : "Falta la grabación de esta revisión."}</p>}
      {!readOnly && !canUpload ? <p className="mt-3 text-sm text-[var(--fp-muted)]">{state?.blockedReason || "La carga de grabación no está disponible para este expediente."}</p> : null}
      {canUpload ? <div className="mt-4 space-y-3">
        <label className="block text-sm font-medium" htmlFor={"call-recording-" + detail.id}>{recording ? "Cargar otra grabación" : "Subir grabación"}</label>
        <input ref={input} id={"call-recording-" + detail.id} type="file" accept=".mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/wav" disabled={disabled || saving} onChange={(event) => select(event.target.files?.[0])} className="block min-h-10 w-full min-w-0 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-2 text-sm file:mr-2 file:rounded-[var(--fp-radius-sm)] file:border-0 file:bg-[var(--fp-bg)] file:p-2 file:text-[var(--fp-graphite)] disabled:opacity-50" />
        <p className="text-sm text-[var(--fp-muted)]">MP3, M4A o WAV · Máximo 10 MB.{!compact ? " Guardar la grabación mantiene el crédito pendiente de aprobación." : ""}</p>

      </div> : null}
      {pending ? <div className="mt-3 flex flex-wrap gap-2">{canUpload ? <Button variant="secondary" disabled={disabled || saving} onClick={() => void save()}><Upload className="h-4 w-4" aria-hidden="true" />{saving ? "Guardando..." : "Guardar grabación"}</Button> : null}<Button variant="ghost" disabled={saving} onClick={clearSelection}>Cancelar</Button></div> : null}
      {error ? <p role="alert" className="mt-3 text-sm text-[var(--fp-danger)]">{error}</p> : null}
    </Card>
  );
}
