"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Send } from "lucide-react";
import { Button, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { requestApprovalSignature, refreshApprovalSignature, type ApprovalDetail } from "./approval-client";

type Props = {
  detail: ApprovalDetail;
  disabled?: boolean;
  onUpdated: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};
const statusLabels: Record<string, string> = {
  PREPARING: "Preparando reenvío", DISPATCHING: "Enviando a firma",
  AWAITING_SIGNATURE: "Pendiente de nueva firma", COMPLETED: "Nueva firma recibida",
  FAILED_SAFE: "Reenvío no realizado", UNCERTAIN: "Envío pendiente de verificación",
};

export default function ApprovalSignatureReissue({ detail, disabled = false, onUpdated, onBusyChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const requestId = useRef<string | null>(null);
  const operation = detail.reissue.operation;
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  function close() {
    if (submitting.current) return;
    setEditing(false); setConfirming(false); setReason(""); requestId.current = null;
    onBusyChange(false);
  }
  function open() {
    if (disabled || !detail.capabilities.canReissueSignature || submitting.current) return;
    setError(""); setReason(""); requestId.current = null; setEditing(true); onBusyChange(true);
  }
  async function send() {
    if (disabled || submitting.current || !confirming || !detail.document.processUuid ||
        !detail.capabilities.canReissueSignature || reason.trim().length < 10) return;
    submitting.current = true; setSaving(true); setError("");
    try {
      requestId.current ??= crypto.randomUUID();
      await requestApprovalSignature(detail.id, {
        expectedRevision: detail.review.revision, expectedProcessUuid: detail.document.processUuid,
        reason: reason.trim(), idempotencyKey: requestId.current,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar el reenvío. Actualiza el expediente para verificarlo.");
    } finally {
      setConfirming(false); setEditing(false);
      // The server may have sent the request even when the response was lost.
      // Always reload its durable state; never repeat a provider request here.
      try { await onUpdated(); }
      finally { submitting.current = false; setSaving(false); onBusyChange(false); }
    }
  }
  async function refresh() {
    if (disabled || submitting.current || !operation?.canRefresh) return;
    submitting.current = true; setSaving(true); onBusyChange(true); setError("");
    try { await refreshApprovalSignature(detail.id, operation.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo consultar la nueva firma."); }
    finally {
      try { await onUpdated(); }
      finally { submitting.current = false; setSaving(false); onBusyChange(false); }
    }
  }

  if (!detail.review.required) return null;
  return (
    <section aria-label="Reenviar folio a firma" className="mt-5 border-t border-[var(--fp-border)] pt-5">
      <h3 className="font-semibold">¿El folio quedó mal firmado?</h3>
      <p className="mt-2 text-sm text-[var(--fp-muted)]">Solicita una nueva firma conservando el folio, sus condiciones y el documento anterior. El crédito necesitará un nuevo OK antes de liquidarse.</p>
      {operation ? <div className="mt-4 space-y-2" role="status">
        <StatusPill tone={operation.status === "COMPLETED" ? "positive" : "warning"}>{statusLabels[operation.status] || "Reenvío en revisión"}</StatusPill>
        <p className="text-sm text-[var(--fp-muted)]">{operation.message}</p>
        {operation.reason ? <p className="text-sm">Motivo: {operation.reason}</p> : null}
      </div> : null}
      {error ? <p className="mt-3 text-sm text-[var(--fp-danger)]" role="alert">{error}</p> : null}
      {editing ? <div className="mt-4 space-y-3">
        <label className="block text-sm font-semibold" htmlFor="approval-reissue-reason">Motivo del reenvío</label>
        <textarea id="approval-reissue-reason" rows={3} minLength={10} maxLength={500} value={reason}
          onChange={(event) => setReason(event.target.value)} disabled={disabled || saving || confirming}
          className="w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] p-3 text-sm focus-visible:outline-2 focus-visible:outline-[var(--fp-graphite)]"
          placeholder="Describe qué debe corregirse en la firma" aria-describedby="approval-reissue-help" />
        <p id="approval-reissue-help" className="text-sm text-[var(--fp-muted)]">Entre 10 y 500 caracteres. Quedará registrado con tu usuario.</p>
        <div className="flex flex-wrap gap-3">
          <Button variant="secondary" onClick={close} disabled={saving || confirming}>Cancelar</Button>
          <Button onClick={() => setConfirming(true)} disabled={disabled || saving || confirming || reason.trim().length < 10}>Continuar</Button>
        </div>
      </div> : <div className="mt-4 flex flex-wrap gap-3">
        {detail.capabilities.canReissueSignature ? <Button variant="secondary" onClick={open} disabled={disabled || saving}><Send className="h-4 w-4" aria-hidden="true" />Reenviar folio a firma</Button> : null}
        {operation?.canRefresh ? <Button variant="secondary" onClick={() => void refresh()} disabled={disabled || saving}><RefreshCw className="h-4 w-4" aria-hidden="true" />{saving ? "Consultando..." : "Consultar nueva firma"}</Button> : null}
        {!detail.capabilities.canReissueSignature && detail.capabilities.correctionBlockedReason ? <p className="text-sm text-[var(--fp-muted)]">{detail.capabilities.correctionBlockedReason}</p> : null}
      </div>}
      <ConfirmDialog open={confirming} title="Reenviar folio a firma" confirmLabel="Confirmar reenvío" busy={saving}
        description={`Se enviará nuevamente el folio ${detail.folio} de ${detail.clienteNombre}, cédula ${detail.clienteDocumento}. Motivo: ${reason.trim()}. El crédito quedará pendiente de nueva firma y revisión; su documento anterior se conservará.`}
        onCancel={() => { if (!submitting.current) setConfirming(false); }} onConfirm={() => void send()} />
    </section>
  );
}
