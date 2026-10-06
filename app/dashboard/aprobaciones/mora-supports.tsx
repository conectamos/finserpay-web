"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Download, FileText, Paperclip, Upload } from "lucide-react";
import { Badge, Button, EmptyState, Input, LoadingState } from "@/app/_components/finser-ui";

export type MoraSupportItem = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  reason: string;
  actorName: string;
  createdAt: string;
  href: string;
};

type Props = {
  creditoId: number;
  subjectKind: "GESTION" | "EXCEPCION";
  subjectId: string;
  defaultOpen?: boolean;
  canUpload?: boolean;
};

const maxBytes = 10 * 1024 * 1024;
const allowedExtensions = /\.(pdf|png|jpe?g)$/i;
const dates = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

function displayDate(value: string) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dates.format(parsed) : "Fecha no disponible";
}

function displaySize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Tamaño no disponible";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "No fue posible completar la solicitud.");
  }
  return payload as T;
}

export default function MoraSupports({ creditoId, subjectKind, subjectId, defaultOpen = false, canUpload = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [items, setItems] = useState<MoraSupportItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [reason, setReason] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const loadSupports = useCallback(async () => {
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    const params = new URLSearchParams({ creditoId: String(creditoId), subjectKind, subjectId });
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/aprobaciones/soportes-mora?${params.toString()}`, {
        cache: "no-store",
        signal: nextController.signal,
      });
      const result = await readPayload<{ ok: true; items: MoraSupportItem[] }>(response);
      if (nextController.signal.aborted) return;
      setItems(result.items);
      setLoaded(true);
    } catch (loadError) {
      if (!nextController.signal.aborted) setError(loadError instanceof Error ? loadError.message : "No fue posible cargar los soportes.");
    } finally {
      if (!nextController.signal.aborted) setLoading(false);
    }
  }, [creditoId, subjectId, subjectKind]);

  useEffect(() => {
    if (defaultOpen) void loadSupports();
    return () => controller.current?.abort();
  }, [defaultOpen, loadSupports]);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] || null;
    idempotencyKey.current = null;
    setError("");
    setNotice("");
    if (selected && (!allowedExtensions.test(selected.name) || selected.size > maxBytes)) {
      setFile(null);
      event.target.value = "";
      setError("Adjunta un PDF, JPG o PNG válido de hasta 10 MB.");
      return;
    }
    setFile(selected);
  }

  function updateReason(value: string) {
    idempotencyKey.current = null;
    setReason(value);
    setError("");
    setNotice("");
  }

  async function uploadSupport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!file || !allowedExtensions.test(file.name) || file.size > maxBytes || normalizedReason.length < 5 || normalizedReason.length > 1000) {
      setError("Adjunta un PDF, JPG o PNG de hasta 10 MB e indica un motivo de 5 a 1000 caracteres.");
      return;
    }
    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    setUploading(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/aprobaciones/soportes-mora", {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "x-credit-id": String(creditoId),
          "x-subject-kind": subjectKind,
          "x-subject-id": subjectId,
          "x-support-file-name": encodeURIComponent(file.name),
          "x-support-reason": encodeURIComponent(normalizedReason),
          "idempotency-key": key,
        },
        body: file,
      });
      const result = await readPayload<{ ok: true; item: MoraSupportItem }>(response);
      setItems((current) => [...current.filter((item) => item.id !== result.item.id), result.item]);
      setLoaded(true);
      setFile(null);
      setReason("");
      idempotencyKey.current = null;
      if (input.current) input.current.value = "";
      setNotice("Soporte guardado y asociado a este registro.");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "No fue posible cargar el soporte.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <details
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded && !loaded && !loading) void loadSupports();
      }}
      className="rounded-[var(--fp-radius-sm)] border border-[var(--fp-border)] bg-[var(--fp-surface)]"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-bold focus-visible:outline-2 focus-visible:outline-[var(--fp-lime-strong)]">
        <Paperclip className="h-4 w-4" aria-hidden="true" />
        Soportes
        {loaded ? <Badge className="ml-auto">{items.length}</Badge> : null}
      </summary>
      <div className="space-y-4 border-t border-[var(--fp-border)] p-3">
        {loading ? <LoadingState label="Cargando soportes..." /> : null}
        {loaded && !items.length && !loading ? <EmptyState title="Sin soportes" description="Adjunta evidencia en PDF, JPG o PNG para este registro." /> : null}
        {items.length ? <ul className="space-y-2">{items.map((item) => <li key={item.id} className="rounded-[var(--fp-radius-sm)] bg-[var(--fp-bg)] p-3 text-sm"><div className="flex items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--fp-muted)]" aria-hidden="true" /><div className="min-w-0 flex-1"><a href={item.href} download={item.fileName} className="break-all font-bold underline decoration-[var(--fp-lime-strong)] decoration-2 underline-offset-4">{item.fileName}</a><p className="mt-1 text-xs text-[var(--fp-muted)]">{displaySize(item.sizeBytes)} · {item.actorName} · {displayDate(item.createdAt)}</p><p className="mt-2 whitespace-pre-wrap break-words">{item.reason}</p></div><a href={item.href} download={item.fileName} className="fp-ui-button is-ghost shrink-0" aria-label={`Descargar ${item.fileName}`}><Download className="h-4 w-4" aria-hidden="true" /></a></div></li>)}</ul> : null}
        {canUpload ? <form onSubmit={uploadSupport} className="space-y-3" aria-label="Adjuntar soporte">
          <label className="block space-y-1.5"><span className="text-sm font-bold">Archivo</span><Input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={uploading} onChange={selectFile} /></label>
          <label className="block space-y-1.5"><span className="text-sm font-bold">Motivo del soporte</span><textarea required minLength={5} maxLength={1000} rows={3} value={reason} disabled={uploading} onChange={(event) => updateReason(event.target.value)} placeholder="Explica qué demuestra este soporte" className="fp-ui-input min-h-24 w-full resize-y" /></label>
          {error ? <p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p> : null}
          {notice ? <p role="status" className="text-sm font-semibold">{notice}</p> : null}
          <Button type="submit" variant="secondary" disabled={uploading || !file || reason.trim().length < 5}><Upload className="h-4 w-4" aria-hidden="true" />{uploading ? "Cargando..." : "Adjuntar soporte"}</Button>
        </form> : null}
      </div>
    </details>
  );
}
