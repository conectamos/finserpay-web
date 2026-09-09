"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquareWarning, Plus } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, Select } from "@/app/_components/finser-ui";
import { createApprovalNovelty, type ApprovalDetail } from "./approval-client";

type Props = { detail: ApprovalDetail; disabled?: boolean; onUpdated: () => Promise<void>; onBusyChange: (busy: boolean) => void };
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
function dateLabel(value: string | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? dates.format(date) : ""; }

export default function ApprovalNoveltyPanel({ detail, disabled = false, onUpdated, onBusyChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState("PHOTO");
  const [keys, setKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const submitting = useRef(false);
  const state = detail.novelties;
  const novelty = state?.novelty;
  const canCreate = detail.capabilities.canCreateNovelty;
  const valid = reason.trim().length >= 10 && reason.trim().length <= 1000 && (mode === "GENERAL" || keys.length > 0);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  function open() {
    if (disabled || !canCreate || submitting.current) return;
    setKeys([]); setReason(""); setMode("PHOTO"); setError(""); setNotice(""); requestId.current = null;
    setEditing(true); onBusyChange(true);
  }
  function close() {
    if (submitting.current) return;
    setEditing(false); setConfirming(false); setError(""); requestId.current = null; onBusyChange(false);
  }
  async function save() {
    if (disabled || !canCreate || !valid || !confirming || submitting.current) return;
    submitting.current = true; setSaving(true); setError(""); setNotice("");
    try {
      requestId.current ??= crypto.randomUUID();
      await createApprovalNovelty(detail.id, { keys: mode === "GENERAL" ? [] : keys, reason: reason.trim(),
        revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: requestId.current });
      setNotice("La novedad aparece en PENDIENTES del aliado. El crédito requiere una nueva revisión antes del OK.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar la novedad. Actualiza el expediente.");
    } finally {
      setConfirming(false); setEditing(false);
      try { await onUpdated(); }
      finally { submitting.current = false; setSaving(false); onBusyChange(false); }
    }
  }
  if (!detail.review.required) return null;
  return <Card className="space-y-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><MessageSquareWarning className="h-5 w-5" aria-hidden="true" />Novedades del expediente</h2>
      {!editing && canCreate ? <Button variant="secondary" disabled={disabled || saving} onClick={open}><Plus className="h-4 w-4" aria-hidden="true" />Colocar novedad</Button> : null}
    </div>
    <p className="text-sm text-[var(--fp-muted)]">Indica al administrador del aliado qué debe corregir. Al guardar una foto nueva, el crédito vuelve a revisión del analista.</p>
    {novelty ? <div className="space-y-3">
      {novelty.status === "RESOLVED" ? <Badge tone="positive">Últimas novedades resueltas</Badge> : <div className="flex flex-wrap gap-2">
        {state.pendingCount > 0 ? <Badge tone="warning">{state.pendingCount} pendientes del aliado</Badge> : null}
        {state.answeredCount > 0 ? <Badge tone="positive">{state.answeredCount} correcciones por revisar</Badge> : null}
      </div>}
      {novelty.items.map((item) => <article key={item.id} className="space-y-2 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{item.label}</h3><Badge tone={item.status === "OPEN" ? "warning" : "positive"}>{novelty.status === "RESOLVED" ? "Resuelta" : item.status === "OPEN" ? "Pendiente del aliado" : "Pendiente de revisión del analista"}</Badge></div>
        <p className="whitespace-pre-wrap break-words text-sm">{item.reason}</p>
        <p className="text-xs text-[var(--fp-muted)]">Registrada: {dateLabel(item.openedAt)}</p>
        {item.status === "RESPONDED" ? <div className="border-t border-[var(--fp-border)] pt-2 text-sm"><strong>Respuesta o corrección recibida</strong><p className="mt-1 whitespace-pre-wrap break-words">{item.responseText || "Fotografía actualizada. Revisa la imagen vigente del expediente."}</p><p className="mt-1 text-xs text-[var(--fp-muted)]">{dateLabel(item.respondedAt)}</p></div> : null}
      </article>)}
    </div> : <p className="text-sm text-[var(--fp-muted)]">Este crédito no tiene novedades registradas.</p>}
    {editing ? <div className="space-y-4 border-t border-[var(--fp-border)] pt-4">
      <label className="block space-y-2 text-sm font-semibold"><span>Tipo de novedad</span><Select value={mode} onChange={(event) => setMode(event.target.value)} disabled={disabled || saving || confirming} aria-label="Tipo de novedad"><option value="PHOTO">Corregir fotografías</option><option value="GENERAL">Otra novedad</option></Select></label>
      {mode === "PHOTO" ? <fieldset className="space-y-2" disabled={disabled || saving || confirming}><legend className="mb-2 text-sm font-semibold">Fotografías que debe reemplazar el aliado</legend><div className="grid gap-2 sm:grid-cols-2">{detail.evidence.map((photo) => <label key={photo.key} className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" checked={keys.includes(photo.key)} onChange={(event) => setKeys((current) => event.target.checked ? [...current, photo.key] : current.filter((key) => key !== photo.key))} className="h-5 w-5 accent-[var(--fp-graphite)]" />{photo.label}</label>)}</div></fieldset> : null}
      <label className="block space-y-2 text-sm font-semibold"><span>Qué debe corregir el aliado</span><textarea aria-label="Qué debe corregir el aliado" rows={3} minLength={10} maxLength={1000} value={reason} disabled={disabled || saving || confirming} onChange={(event) => setReason(event.target.value)} placeholder="Describe el problema y la corrección requerida" className="w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--fp-graphite)]" /></label>
      <p className="text-sm text-[var(--fp-muted)]">La novedad quedará visible en PENDIENTES del aliado y bloqueará el OK hasta que sea atendida y revisada.</p>
      <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={saving || confirming} onClick={close}>Cancelar</Button><Button disabled={disabled || saving || confirming || !valid} onClick={() => setConfirming(true)}>Registrar novedad</Button></div>
    </div> : null}
    {error ? <p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
    {notice ? <p className="text-sm text-[var(--fp-muted)]" role="status">{notice}</p> : null}
    <ConfirmDialog open={confirming} title="Registrar novedad del crédito" confirmLabel="Confirmar novedad" busy={saving}
      description={`Folio ${detail.folio}, de ${detail.clienteNombre}. ${mode === "GENERAL" ? "Otra novedad" : detail.evidence.filter((photo) => keys.includes(photo.key)).map((photo) => photo.label).join(", ")}: ${reason.trim()}. El aliado verá lo requerido en PENDIENTES.`}
      onCancel={() => { if (!submitting.current) setConfirming(false); }} onConfirm={() => void save()} />
  </Card>;
}
