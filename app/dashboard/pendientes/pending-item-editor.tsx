"use client";

import { useEffect, useRef, useState } from "react";
import { Expand, ImageOff, Upload, X } from "lucide-react";
import { Button, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { normalizeEvidenceFile } from "@/lib/credit-approval-evidence-file";
import { canRespondToPendingIssue, PendingRequestError, respondPendingPhoto, respondPendingText,
  type PendingDetail, type PendingIssue, type PendingPhotoResponse } from "./pending-client";

type Props = {
  detail: PendingDetail; issue: PendingIssue; disabled: boolean;
  onUpdated: (notice?: string) => Promise<void>;
  onBusyChange: (id: string, busy: boolean) => void;
};

function CurrentPhoto({ issue, clientName }: { issue: PendingIssue; clientName: string }) {
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const href = issue.evidence?.href;
  if (!issue.evidence?.available || !href || failed) return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-[var(--fp-radius-md)] bg-[var(--fp-bg)] p-4 text-center text-sm text-[var(--fp-muted)]">
      <ImageOff className="h-6 w-6" aria-hidden="true" />
      <span>{failed ? "No se pudo cargar la fotografía actual." : "Fotografía actual no disponible."}</span>
      {failed ? <Button variant="ghost" onClick={() => { setFailed(false); setRetry((value) => value + 1); }}>Reintentar foto</Button> : null}
    </div>
  );
  return <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`Ampliar ${issue.label}`}
    className="relative block overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] focus-visible:outline-2 focus-visible:outline-offset-2">
    {/* Authenticated images are requested directly with the ally session. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={retry ? `${href}${href.includes("?") ? "&" : "?"}retry=${retry}` : href}
      alt={`${issue.label} actual de ${clientName}`} className="h-60 w-full object-contain" onError={() => setFailed(true)} />
    <span className="absolute bottom-2 right-2 flex h-10 w-10 items-center justify-center rounded-[var(--fp-radius-sm)] bg-[var(--fp-graphite)] text-white"><Expand className="h-4 w-4" aria-hidden="true" /></span>
  </a>;
}

export default function PendingItemEditor({ detail, issue, disabled, onUpdated, onBusyChange }: Props) {
  const general = issue.key === "GENERAL";
  const allowed = canRespondToPendingIssue(detail, issue);
  const [photo, setPhoto] = useState<PendingPhotoResponse | null>(null);
  const [text, setText] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const submitting = useRef(false);
  const textRequestId = useRef<string | null>(null);
  const busy = Boolean(photo) || Boolean(text) || preparing || saving || confirming;
  const blocked = disabled || !allowed || preparing || saving;

  useEffect(() => {
    onBusyChange(issue.id, busy);
    return () => onBusyChange(issue.id, false);
  }, [busy, issue.id, onBusyChange]);
  useEffect(() => () => { generation.current += 1; }, []);

  function cancel() {
    if (submitting.current) return;
    generation.current += 1;
    setPhoto(null); setText(""); setPreparing(false); setConfirming(false); setError("");
    textRequestId.current = null;
  }

  async function choosePhoto(file: File) {
    if (blocked || general) return;
    const current = ++generation.current;
    setPhoto(null); setPreparing(true); setError("");
    try {
      const dataUrl = await normalizeEvidenceFile(file);
      if (generation.current === current) setPhoto({ noveltyId: detail.novelty.id, itemId: issue.id,
        expectedVersion: issue.version, expectedPhotoHash: issue.evidence?.sha256 ?? null,
        dataUrl, idempotencyKey: crypto.randomUUID() });
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : "No se pudo preparar la fotografía.");
    } finally { if (generation.current === current) setPreparing(false); }
  }

  async function save() {
    if (blocked || submitting.current || (general ? text.trim().length < 5 : !photo)) return;
    submitting.current = true; setSaving(true); setError("");
    let refresh = false;
    let notice: string | undefined;
    try {
      if (photo && (photo.noveltyId !== detail.novelty.id || photo.itemId !== issue.id || photo.expectedVersion !== issue.version ||
        photo.expectedPhotoHash !== (issue.evidence?.sha256 ?? null))) {
        throw new PendingRequestError("La novedad cambió. Revisa su estado antes de reemplazar la fotografía.", 409);
      }
      textRequestId.current ||= crypto.randomUUID();
      const result = general
        ? await respondPendingText(detail.id, { noveltyId: detail.novelty.id, itemId: issue.id,
          expectedVersion: issue.version, text: text.trim(), idempotencyKey: textRequestId.current })
        : await respondPendingPhoto(detail.id, photo!);
      notice = result.unchanged
        ? general ? "La respuesta ya estaba registrada. Revisa el estado actualizado de la novedad." : "La solicitud no produjo un cambio nuevo. Revisa el estado actualizado de la novedad; una foto idéntica no subsana el rechazo."
        : `${general ? "Respuesta guardada" : "Fotografía guardada"}. El crédito volvió automáticamente a revisión del analista. Las demás novedades pendientes deben corregirse por separado.`;
      setPhoto(null); setText(""); refresh = true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar el guardado. Actualiza para comprobar el resultado.");
      if (!(failure instanceof PendingRequestError) || failure.status !== 400) {
        setPhoto(null); setText(""); refresh = true;
        notice = failure instanceof PendingRequestError && failure.status === 409
          ? "La novedad cambió. Revisa su estado actualizado antes de intentar otra corrección."
          : "No se pudo confirmar el guardado. Comprueba el estado actualizado antes de continuar.";
      }
    } finally {
      setConfirming(false);
      if (refresh) {
        try { await onUpdated(notice); }
        catch { setError("No fue posible comprobar el estado. Actualiza el crédito antes de continuar."); }
      }
      submitting.current = false; setSaving(false);
    }
  }

  return <article className="min-w-0 space-y-4 border-t border-[var(--fp-border)] py-5 first:border-t-0 first:pt-0" aria-labelledby={`pending-issue-${issue.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 id={`pending-issue-${issue.id}`} className="text-base font-bold">{issue.label}</h3>
      <StatusPill tone={issue.status === "OPEN" ? "warning" : "neutral"}>{issue.status === "OPEN" ? "Por corregir" : "Pendiente revisión analista"}</StatusPill>
    </div>
    <div className="border-l-2 border-[var(--fp-amber)] pl-3 text-sm">
      <p className="font-semibold">Motivo de la novedad</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[var(--fp-muted)]">{issue.reason}</p>
    </div>
    {!general ? <div className="max-w-md"><CurrentPhoto key={`${issue.evidence?.href}:${issue.evidence?.sha256}`} issue={issue} clientName={detail.clienteNombre} /></div> : null}
    {issue.status === "RESPONDED" ? <div className="space-y-2 text-sm text-[var(--fp-muted)]">
      {issue.responseText ? <p className="whitespace-pre-wrap break-words"><strong>Tu respuesta: </strong>{issue.responseText}</p> : null}
      <p>El analista revisará {general ? "tu respuesta" : "la fotografía guardada"}. Esta novedad solo admite otra corrección si vuelve a ser rechazada.</p>
    </div> : allowed ? <div className="space-y-3">
      {general ? <label className="block text-sm font-semibold" htmlFor={`pending-response-${issue.id}`}>Respuesta al analista
        <textarea id={`pending-response-${issue.id}`} value={text} rows={4} maxLength={2000} disabled={blocked}
          placeholder="Explica cómo resolviste la novedad (mínimo 5 caracteres)." className="fp-ui-input mt-2 min-h-28 w-full resize-y"
          onChange={(event) => { setText(event.target.value); textRequestId.current = null; setError(""); }} />
      </label> : <>
        <p className="text-sm text-[var(--fp-muted)]">Sube otra imagen PNG o JPEG únicamente para {issue.label.toLocaleLowerCase("es")}. Al guardarla, el crédito vuelve automáticamente al analista.</p>
        <label className={`fp-ui-button is-secondary relative min-h-10 max-w-full whitespace-normal ${blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
          <Upload className="h-4 w-4 shrink-0" aria-hidden="true" />{preparing ? "Preparando fotografía..." : "Seleccionar PNG o JPEG"}
          <input type="file" accept="image/png,image/jpeg" disabled={blocked} className="sr-only" aria-label={`Reemplazar ${issue.label}`}
            onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void choosePhoto(file); }} />
        </label>
        {photo ? <div className="max-w-md space-y-2">
          <p className="text-sm font-semibold">Nueva fotografía: {issue.label}</p>
          {/* The preview stays in this page until the user confirms saving. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo.dataUrl} alt={`Nueva fotografía para ${issue.label}`} className="max-h-72 max-w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] object-contain" />
        </div> : null}
      </>}
      {(general || photo) ? <div className="flex flex-wrap gap-2">
        <Button disabled={blocked || (general && text.trim().length < 5)} onClick={() => setConfirming(true)}>{general ? "Guardar respuesta" : "Guardar fotografía"}</Button>
        {photo || text ? <Button variant="secondary" disabled={saving} onClick={cancel}><X className="h-4 w-4" aria-hidden="true" />Cancelar cambio</Button> : null}
      </div> : null}
    </div> : <p className="text-sm text-[var(--fp-muted)]">{detail.blockedReason || "Este crédito no admite correcciones en este momento."}</p>}
    {error ? <p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
    <ConfirmDialog open={confirming} title={general ? "Confirmar respuesta" : "Confirmar fotografía corregida"}
      description={`Se guardará ${general ? "tu respuesta a la novedad" : `la nueva ${issue.label.toLocaleLowerCase("es")}`} del crédito ${detail.folio}, de ${detail.clienteNombre}. ${general ? "" : "La fotografía anterior quedará conservada. "}El crédito volverá automáticamente a revisión del analista; las demás novedades seguirán pendientes.`}
      confirmLabel={general ? "Guardar respuesta" : "Guardar fotografía"} busy={saving}
      onCancel={() => { if (!submitting.current) setConfirming(false); }} onConfirm={() => { void save(); }} />
  </article>;
}
