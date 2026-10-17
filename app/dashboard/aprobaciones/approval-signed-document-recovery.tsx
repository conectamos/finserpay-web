"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, EmptyState } from "@/app/_components/finser-ui";
import type { ApprovalDetail } from "./approval-client";

type Props = {
  detail: ApprovalDetail;
  disabled?: boolean;
  onUpdated: () => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};

export default function ApprovalSignedDocumentRecovery({ detail, disabled = false, onUpdated, onBusyChange }: Props) {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; warning: boolean } | null>(null);
  const submitting = useRef(false);
  const autoAttempted = useRef(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => {
    request.current?.abort();
    onBusyChange(false);
  }, [detail.id, detail.document.processUuid, onBusyChange]);

  const recoverDocument = useCallback(async () => {
    if (disabled || submitting.current || detail.document.available || !detail.document.processUuid) return;
    const targetId = detail.id;
    const expectedProcessUuid = detail.document.processUuid;
    const controller = new AbortController();
    request.current = controller;
    submitting.current = true;
    setSaving(true);
    setMessage(null);
    onBusyChange(true);
    try {
      const response = await fetch(`/api/aprobaciones/${targetId}/documento`, {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedProcessUuid }), signal: controller.signal,
      });
      const result = await response.json().catch(() => null) as {
        ok?: boolean; error?: string; message?: string; item?: ApprovalDetail;
      } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || result?.ok !== true) throw new Error(result?.error ||
        "No fue posible consultar el documento en FirmaSeguro. El expediente se conserva.");
      if (result.item?.id !== targetId || result.item.document?.processUuid !== expectedProcessUuid ||
          typeof result.item.document?.available !== "boolean") throw new Error(
        "La firma vigente cambió. Actualiza el expediente antes de consultar nuevamente.");
      const text = result.message || (result.item.document.available
        ? "El documento firmado se recuperó de FirmaSeguro."
        : "FirmaSeguro todavía no devolvió el PDF firmado. El expediente se conserva para una nueva consulta.");
      await onUpdated();
      if (!controller.signal.aborted) setMessage({ text, warning: !result.item.document.available });
    } catch (error) {
      if (!controller.signal.aborted) setMessage({ text: error instanceof Error ? error.message :
        "No fue posible consultar el documento en FirmaSeguro. El expediente se conserva.", warning: true });
    } finally {
      submitting.current = false;
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  }, [detail, disabled, onUpdated, onBusyChange]);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled || disabled || detail.document.available || !detail.document.processUuid ||
          autoAttempted.current || submitting.current) return;
      autoAttempted.current = true;
      void recoverDocument();
    });
    return () => { cancelled = true; };
  }, [detail.document.available, detail.document.processUuid, disabled, recoverDocument]);

  if (detail.document.available) return null;
  return <div className="space-y-3">
    <EmptyState title="Documento firmado no disponible" description="El PDF firmado debe estar disponible antes del OK para liquidación." />
    {detail.document.processUuid ? <>
      <p className="text-sm text-[var(--fp-muted)]">Se consulta el mismo documento en FirmaSeguro para recuperar su PDF. Esta acción no crea ni reenvía una firma.</p>
      <Button variant="secondary" onClick={() => void recoverDocument()} disabled={disabled || saving} aria-busy={saving}>
        <RefreshCw size={17} aria-hidden="true" />{saving ? "Consultando documento..." : "Consultar documento en FirmaSeguro"}
      </Button>
    </> : <p className="text-sm text-[var(--fp-muted)]">No hay un proceso de FirmaSeguro identificado para consultar. Solicita revisión técnica de este expediente.</p>}
    {message ? <p className={`break-words text-sm ${message.warning ? "text-[var(--fp-danger)]" : "text-[var(--fp-muted)]"}`}
      role={message.warning ? "alert" : "status"}>{message.text}</p> : null}
  </div>;
}
