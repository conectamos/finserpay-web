"use client";

import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { Button, Select } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { normalizeEvidenceFile } from "@/lib/credit-approval-evidence-file";
import { submitEvidenceCorrection, type EvidenceCorrectionRequest } from "@/lib/credit-approval-evidence-client";
import { ApprovalRequestError, type ApprovalDetail } from "./approval-client";

type Props = {
  detail: ApprovalDetail; disabled?: boolean; onUpdated: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};
type PendingPhoto = EvidenceCorrectionRequest & { id: number; label: string };

export default function ApprovalEvidenceCorrection({ detail, disabled = false, onUpdated, onBusyChange }: Props) {
  const [key, setKey] = useState(detail.evidence[0]?.key || "");
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const submitting = useRef(false);
  const allowed = detail.capabilities.canCorrectEvidence;
  const blocked = disabled || !allowed || preparing || saving;

  useEffect(() => {
    onBusyChange(Boolean(pending) || preparing || saving);
    return () => onBusyChange(false);
  }, [onBusyChange, pending, preparing, saving]);
  useEffect(() => () => { generation.current += 1; }, []);

  function cancelPhoto() {
    if (submitting.current) return;
    generation.current += 1;
    setPending(null); setPreparing(false); setConfirming(false); setError("");
  }

  async function choosePhoto(file: File) {
    if (blocked) return;
    const evidence = detail.evidence.find((item) => item.key === key);
    if (!evidence) return;
    const current = ++generation.current;
    setPreparing(true); setPending(null); setError(""); setNotice("");
    try {
      const dataUrl = await normalizeEvidenceFile(file);
      if (generation.current === current) setPending({ id: detail.id, key, label: evidence.label, dataUrl,
        revision: detail.review.revision, reviewHash: detail.review.reviewHash });
    } catch (failure) {
      if (generation.current === current) setError(failure instanceof Error ? failure.message : "No se pudo preparar la fotografía.");
    } finally { if (generation.current === current) setPreparing(false); }
  }

  async function savePhoto() {
    if (!pending || submitting.current || !allowed) return;
    submitting.current = true;
    setSaving(true); setError(""); setNotice("");
    let refresh = false;
    try {
      if (pending.id !== detail.id || pending.revision !== detail.review.revision || pending.reviewHash !== detail.review.reviewHash) {
        throw new ApprovalRequestError("El expediente cambió. Revisa la fotografía actual antes de reemplazarla.", 409);
      }
      const { key: photoKey, dataUrl, revision, reviewHash } = pending;
      const result = await submitEvidenceCorrection(pending.id, { key: photoKey, dataUrl, revision, reviewHash });
      setNotice(result.unchanged ? "La fotografía seleccionada ya era la vigente." : "Fotografía actualizada. Revisa el expediente antes de dar un nuevo OK.");
      setPending(null); refresh = true;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar el reemplazo. Actualiza el expediente.");
      // Only a definitive validation error keeps this selection available.
      // A conflict or uncertain write must refresh before another attempt.
      if (!(failure instanceof ApprovalRequestError) || failure.status !== 400) {
        setPending(null); refresh = true;
      }
    } finally {
      setConfirming(false);
      if (refresh) {
        try { await onUpdated(); }
        catch { setError("Actualiza el expediente para comprobar el resultado antes de continuar."); }
      }
      submitting.current = false; setSaving(false);
    }
  }

  return (
    <div className="relative mt-5 min-w-0 space-y-3 border-t border-[var(--fp-border)] pt-4">
      <p className="text-sm font-semibold">Corregir una fotografía</p>
      {!allowed ? <p className="text-sm text-[var(--fp-muted)]">{detail.capabilities.correctionBlockedReason || "Este expediente no admite correcciones."}</p> : <>
        <p className="text-sm text-[var(--fp-muted)]">Selecciona la foto que deseas reemplazar. La versión anterior quedará conservada y el expediente requerirá un nuevo OK.</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">Fotografía
            <Select aria-label="Fotografía que se va a corregir" value={key} disabled={blocked || Boolean(pending)} onChange={(event) => setKey(event.target.value)}>
              {detail.evidence.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </Select>
          </label>
          <label className={`fp-ui-button is-secondary relative min-h-10 ${blocked ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
            <Upload className="h-4 w-4" aria-hidden="true" />{preparing ? "Preparando..." : "Seleccionar PNG o JPEG"}
            <input type="file" accept="image/png,image/jpeg" disabled={blocked} className="sr-only" aria-label="Seleccionar nueva fotografía del expediente" onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (file) void choosePhoto(file);
            }} />
          </label>
        </div>
      </>}
      {pending ? <div className="space-y-3">
        <p className="text-sm text-[var(--fp-muted)]">Vista previa: {pending.label}</p>
        {/* The selected image stays local until the explicit confirmation. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={pending.dataUrl} alt={`Nueva fotografía: ${pending.label}`} className="max-h-72 max-w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] object-contain" />
        <div className="flex flex-wrap gap-2"><Button disabled={blocked} onClick={() => setConfirming(true)}>Guardar fotografía</Button><Button variant="secondary" disabled={saving} onClick={cancelPhoto}><X className="h-4 w-4" aria-hidden="true" />Cancelar reemplazo</Button></div>
      </div> : null}
      {error ? <p className="text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
      {notice ? <p className="text-sm text-[var(--fp-muted)]" role="status">{notice}</p> : null}
      <ConfirmDialog open={confirming} title="Confirmar reemplazo de fotografía" description={`Se reemplazará ${pending?.label || "la fotografía"} del crédito ${detail.folio}, de ${detail.clienteNombre}. La imagen anterior quedará en el historial y será necesario revisar de nuevo el expediente antes del OK.`} confirmLabel="Reemplazar fotografía" busy={saving} onCancel={() => { if (!submitting.current) setConfirming(false); }} onConfirm={() => { void savePhoto(); }} />
    </div>
  );
}
