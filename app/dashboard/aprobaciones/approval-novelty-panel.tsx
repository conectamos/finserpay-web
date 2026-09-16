"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, MessageSquareWarning, Plus } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, Select } from "@/app/_components/finser-ui";
import { createApprovalNovelty, verifyApprovalNovelty, type ApprovalDetail, type ApprovalNoveltyItem,
  type VerifyApprovalNoveltyInput } from "./approval-client";

type Props = { detail: ApprovalDetail; disabled?: boolean; compact?: boolean; readOnly?: boolean; onUpdated: () => Promise<void>; onBusyChange: (busy: boolean) => void };
const dates = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
function dateLabel(value: string | null) { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? dates.format(date) : ""; }

export default function ApprovalNoveltyPanel({ detail, disabled = false, compact = false, readOnly = false, onUpdated, onBusyChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState("PHOTO");
  const [keys, setKeys] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verificationItemId, setVerificationItemId] = useState<string | null>(null);
  const [verificationNote, setVerificationNote] = useState("");
  const [verificationConfirming, setVerificationConfirming] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestId = useRef<string | null>(null);
  const verificationRequestId = useRef<string | null>(null);
  const verificationReturnFocusId = useRef<string | null>(null);
  const submitting = useRef(false);
  const pendingRequest = useRef<Parameters<typeof createApprovalNovelty>[1] | null>(null);
  const pendingVerification = useRef<VerifyApprovalNoveltyInput | null>(null);
  const lockedDraft = compact && pendingRequest.current !== null;
  const verificationLocked = pendingVerification.current !== null;
  const state = detail.novelties;
  const novelty = state?.novelty;
  const verificationItem = novelty?.items.find((item) => item.id === verificationItemId) || null;
  const canCreate = !readOnly && detail.capabilities.canCreateNovelty;
  const canVerify = !readOnly && detail.capabilities.canCreateNovelty;
  const valid = reason.trim().length >= 10 && reason.trim().length <= 1000 && (mode === "GENERAL" || keys.length > 0);
  const verificationValid = verificationNote.trim().length >= 5 && verificationNote.trim().length <= 1000;
  const respondedCount = novelty?.items.filter((item) => item.status === "RESPONDED").length || 0;
  const verifiedCount = novelty?.items.filter((item) => item.status === "VERIFIED").length || 0;
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    if (verificationItemId !== null || !verificationReturnFocusId.current) return;
    const triggerId = verificationReturnFocusId.current; verificationReturnFocusId.current = null;
    if (typeof document !== "undefined" && typeof document.getElementById === "function") {
      const target = document.getElementById("approval-verify-" + triggerId)
        ?? document.getElementById("approval-novelty-" + triggerId);
      target?.focus();
    }
  }, [verificationItemId]);
  useEffect(() => {
    if (!verificationItemId) return;
    const current = novelty?.items.find((item) => item.id === verificationItemId);
    if (current?.status === "OPEN") return;
    setVerificationItemId(null); setVerificationNote(""); setVerificationConfirming(false); setError("");
    verificationRequestId.current = null; pendingVerification.current = null;
    setNotice("La novedad ya no está pendiente del aliado. Revisa el expediente actualizado antes de continuar.");
    onBusyChange(false);
  }, [novelty?.items, onBusyChange, verificationItemId]);

  function open() {
    if (disabled || !canCreate || submitting.current || verificationItemId) return;
    setKeys([]); setReason(""); setMode("PHOTO"); setError(""); setNotice(""); requestId.current = null; pendingRequest.current = null;
    setEditing(true); onBusyChange(true);
  }
  function close() {
    if (submitting.current) return;
    setEditing(false); setConfirming(false); setError(""); requestId.current = null; pendingRequest.current = null; onBusyChange(false);
  }
  function openVerification(item: ApprovalNoveltyItem) {
    if (disabled || !canVerify || item.status !== "OPEN" || submitting.current || editing) return;
    verificationReturnFocusId.current = item.id;
    setVerificationItemId(item.id); setVerificationNote(""); setVerificationConfirming(false); setError(""); setNotice("");
    verificationRequestId.current = null; pendingVerification.current = null; onBusyChange(true);
  }
  function closeVerification() {
    if (submitting.current) return;
    setVerificationItemId(null); setVerificationNote(""); setVerificationConfirming(false); setError("");
    verificationRequestId.current = null; pendingVerification.current = null; onBusyChange(false);
  }
  async function save() {
    if (disabled || !canCreate || !valid || !confirming || submitting.current) return;
    submitting.current = true; setSaving(true); setError(""); setNotice("");
    let saved = false;
    try {
      requestId.current ??= crypto.randomUUID();
      const input = { keys: mode === "GENERAL" ? [] : keys, reason: reason.trim(),
        revision: detail.review.revision, reviewHash: detail.review.reviewHash, idempotencyKey: requestId.current };
      if (compact) pendingRequest.current ??= input;
      await createApprovalNovelty(detail.id, compact ? pendingRequest.current! : input);
      saved = true; pendingRequest.current = null;
      setNotice("La novedad aparece en PENDIENTES del aliado. El crédito requiere una nueva revisión antes del OK.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar la novedad. Actualiza el expediente.");
    } finally {
      setConfirming(false);
      if (saved || !compact) setEditing(false);
      try { await onUpdated(); }
      finally { submitting.current = false; setSaving(false); onBusyChange(compact && !saved); }
    }
  }
  async function saveVerification() {
    if (disabled || !canVerify || !verificationItem || verificationItem.status !== "OPEN" || !verificationValid || !verificationConfirming || submitting.current) return;
    submitting.current = true; setVerifying(true); setError(""); setNotice("");
    let verified = false;
    try {
      verificationRequestId.current ??= crypto.randomUUID();
      pendingVerification.current ??= {
        noveltyId: novelty!.id, itemId: verificationItem.id, expectedVersion: verificationItem.version,
        revision: detail.review.revision, reviewHash: detail.review.reviewHash,
        note: verificationNote.trim(), idempotencyKey: verificationRequestId.current,
      };
      const result = await verifyApprovalNovelty(detail.id, pendingVerification.current);
      verified = true; pendingVerification.current = null;
      setVerificationItemId(null); setVerificationNote("");
      setNotice(result.unchanged
        ? "La novedad ya estaba marcada como solucionada. Revisa el expediente actualizado."
        : "La novedad quedó solucionada por el analista. Si no quedan otros requisitos, ya puedes continuar con el OK para liquidación.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar que la novedad quedó solucionada. Actualiza el expediente.");
    } finally {
      setVerificationConfirming(false);
      try { await onUpdated(); }
      finally { submitting.current = false; setVerifying(false); onBusyChange(!verified); }
    }
  }
  if (!detail.review.required) return null;
  return <Card role="region" aria-label="Novedades del expediente" className="min-w-0 space-y-4 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><MessageSquareWarning className="h-5 w-5 shrink-0" aria-hidden="true" />{compact ? "Novedades" : "Novedades del expediente"}</h2>
      {!editing && !verificationItemId && canCreate ? <Button variant="secondary" disabled={disabled || saving || verifying} onClick={open}><Plus className="h-4 w-4" aria-hidden="true" />Colocar novedad</Button> : null}
    </div>
    {!compact && !readOnly ? <p className="text-sm text-[var(--fp-muted)]">Indica al administrador del aliado qué debe corregir. Si ya verificaste que una novedad quedó resuelta, puedes marcarla como solucionada sin borrar su historial.</p> : null}
    {novelty ? <div className="space-y-3">
      {novelty.status === "RESOLVED" ? <Badge tone="positive">Últimas novedades resueltas</Badge> : <div className="flex flex-wrap gap-2">
        {state.pendingCount > 0 ? <Badge tone="warning">{state.pendingCount} pendientes del aliado</Badge> : null}
        {respondedCount > 0 ? <Badge tone="positive">{respondedCount} {respondedCount === 1 ? "respuesta por revisar" : "respuestas por revisar"}</Badge> : null}
        {verifiedCount > 0 ? <Badge tone="positive">{verifiedCount} {verifiedCount === 1 ? "solucionada por el analista" : "solucionadas por el analista"}</Badge> : null}
      </div>}
      {novelty.items.map((item) => <article key={item.id} id={"approval-novelty-" + item.id} tabIndex={-1} className="space-y-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fp-graphite)]">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{item.label}</h3><Badge tone={item.status === "OPEN" ? "warning" : "positive"}>{item.status === "VERIFIED" ? "Solucionada por el analista" : novelty.status === "RESOLVED" ? "Resuelta" : item.status === "OPEN" ? "Pendiente del aliado" : "Respuesta del aliado por revisar"}</Badge></div>
        <p className="whitespace-pre-wrap break-words text-sm">{item.reason}</p>
        <p className="text-xs text-[var(--fp-muted)]">Registrada: {dateLabel(item.openedAt)}</p>
        {item.status === "RESPONDED" ? <div className="border-t border-[var(--fp-border)] pt-3 text-sm"><strong>Respuesta o corrección recibida del aliado</strong><p className="mt-1 whitespace-pre-wrap break-words">{item.responseText || "Fotografía actualizada. Revisa la imagen vigente del expediente."}</p>{item.respondedAt ? <p className="mt-1 text-xs text-[var(--fp-muted)]">Recibida: {dateLabel(item.respondedAt)}</p> : null}</div> : null}
        {item.status === "VERIFIED" ? <div className="border-t border-[var(--fp-border)] pt-3 text-sm"><strong>Confirmación del analista</strong><p className="mt-1 whitespace-pre-wrap break-words">{item.responseText || "El analista confirmó que la novedad quedó solucionada."}</p>{item.respondedAt ? <p className="mt-1 text-xs text-[var(--fp-muted)]">Verificada: {dateLabel(item.respondedAt)}</p> : null}</div> : null}
        {item.status === "OPEN" && canVerify && !editing && !verificationItemId ? <Button id={"approval-verify-" + item.id} variant="secondary" disabled={disabled || saving || verifying} onClick={() => openVerification(item)}><CheckCircle2 className="h-4 w-4" aria-hidden="true" />Marcar como solucionada</Button> : null}
        {verificationItemId === item.id ? <div className="space-y-3 border-t border-[var(--fp-border)] pt-3">
          {verificationLocked ? <p role="status" className="text-sm text-[var(--fp-muted)]">El borrador se conservó. Reintenta exactamente la misma confirmación o cancela para volver al expediente actualizado.</p> : null}
          <label className="block space-y-2 text-sm font-semibold"><span>Confirmación del analista</span><textarea aria-label="Confirmación del analista" rows={3} autoFocus minLength={5} maxLength={1000} value={verificationNote} disabled={disabled || verifying || verificationConfirming || verificationLocked} onChange={(event) => { setVerificationNote(event.target.value); verificationRequestId.current = null; setError(""); }} placeholder="Ej.: Validé la información y ya quedó OK." className="w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--fp-graphite)]" /></label>
          <p className="text-sm text-[var(--fp-muted)]">Escribe entre 5 y 1000 caracteres. La novedad original se conservará y esta confirmación quedará registrada en el historial.</p>
          <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={verifying || verificationConfirming} onClick={closeVerification}>Cancelar</Button><Button disabled={disabled || verifying || verificationConfirming || !verificationValid} onClick={() => setVerificationConfirming(true)}>{verificationLocked ? "Reintentar confirmación" : "Confirmar solución"}</Button></div>
        </div> : null}
      </article>)}
    </div> : <p className="text-sm text-[var(--fp-muted)]">Este crédito no tiene novedades registradas.</p>}
    {editing ? <div className="space-y-4 border-t border-[var(--fp-border)] pt-4">
      {lockedDraft ? <p role="status" className="text-sm text-[var(--fp-muted)]">El borrador se conservó. Reintenta la misma confirmación o cancela para volver al expediente actualizado.</p> : null}
      <label className="block space-y-2 text-sm font-semibold"><span>Tipo de novedad</span><Select value={mode} onChange={(event) => setMode(event.target.value)} disabled={disabled || saving || confirming || lockedDraft} aria-label="Tipo de novedad"><option value="PHOTO">Corregir fotografías</option><option value="GENERAL">Otra novedad</option></Select></label>
      {mode === "PHOTO" ? <fieldset className="space-y-2" disabled={disabled || saving || confirming || lockedDraft}><legend className="mb-2 text-sm font-semibold">Fotografías que debe reemplazar el aliado</legend><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">{detail.evidence.map((photo) => <label key={photo.key} className="flex min-h-10 items-center gap-3 text-sm"><input type="checkbox" checked={keys.includes(photo.key)} onChange={(event) => setKeys((current) => event.target.checked ? [...current, photo.key] : current.filter((key) => key !== photo.key))} className="h-5 w-5 shrink-0 accent-[var(--fp-graphite)]" />{photo.label}</label>)}</div></fieldset> : null}
      <label className="block space-y-2 text-sm font-semibold"><span>Qué debe corregir el aliado</span><textarea aria-label="Qué debe corregir el aliado" rows={3} minLength={10} maxLength={1000} value={reason} disabled={disabled || saving || confirming || lockedDraft} onChange={(event) => setReason(event.target.value)} placeholder="Describe el problema y la corrección requerida" className="w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--fp-graphite)]" /></label>
      <p className="text-sm text-[var(--fp-muted)]">La novedad quedará visible en PENDIENTES del aliado y bloqueará el OK hasta que sea atendida y revisada.</p>
      <div className="flex flex-wrap gap-3"><Button variant="secondary" disabled={saving || confirming} onClick={close}>Cancelar</Button><Button disabled={disabled || saving || confirming || !valid} onClick={() => setConfirming(true)}>{lockedDraft ? "Reintentar confirmación" : compact ? "Guardar y enviar al aliado" : "Registrar novedad"}</Button></div>
    </div> : null}
    {error ? <p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
    {notice ? <p className="text-sm text-[var(--fp-muted)]" role="status">{notice}</p> : null}
    <ConfirmDialog open={confirming} title="Registrar novedad del crédito" confirmLabel={compact ? "Confirmar envío al aliado" : "Confirmar novedad"} busy={saving}
      description={`Folio ${detail.folio}, de ${detail.clienteNombre}. ${mode === "GENERAL" ? "Otra novedad" : detail.evidence.filter((photo) => keys.includes(photo.key)).map((photo) => photo.label).join(", ")}: ${reason.trim()}. El aliado verá lo requerido en PENDIENTES.`}
      onCancel={() => { if (!submitting.current) setConfirming(false); }} onConfirm={() => void save()} />
    <ConfirmDialog open={verificationConfirming} title="Confirmar novedad solucionada" confirmLabel="Sí, marcar solucionada" busy={verifying}
      description={verificationItem ? `Confirma que verificaste ${verificationItem.label.toLocaleLowerCase("es")} del folio ${detail.folio}, de ${detail.clienteNombre}, y que ya quedó OK. Nota: ${verificationNote.trim()}. Ya no requerirá corrección del aliado y quedará visible como solucionada; las demás seguirán bloqueando el OK para liquidación.` : ""}
      onCancel={() => { if (!submitting.current) setVerificationConfirming(false); }} onConfirm={() => void saveVerification()} />
  </Card>;
}
