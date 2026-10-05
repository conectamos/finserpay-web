"use client";

import { useEffect, useRef, useState } from "react";
import { FileCheck2, RefreshCw, Upload } from "lucide-react";
import { Button, Card, StatusPill } from "@/app/_components/finser-ui";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { normalizeEvidenceFile } from "@/lib/credit-approval-evidence-file";

type Item = {
  id: string; replacementId: string; version: number;
  status: "PENDING_UPLOAD" | "PENDING_REVIEW" | "VERIFIED" | "REJECTED";
  creditId: number; creditNumber: string; clientName: string; newImeiMasked: string;
  requestedAt: string; uploadedAt: string | null;
};

async function readResult<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true)
    throw new Error(body?.error || "No se pudo consultar la remisión. Actualiza e intenta de nuevo.");
  return body as T;
}

export default function PendingRemissions() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Item | null>(null);
  const [photo, setPhoto] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const submitting = useRef(false);

  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/pendientes/remisiones", { cache: "no-store" });
      const data = await readResult<{ ok: true; items: Item[] }>(response);
      if (!Array.isArray(data.items)) throw new Error("La respuesta de remisiones no es válida.");
      setItems(data.items);
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo consultar las remisiones.");
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function prepare(file: File, item: Item) {
    setSelected(item); setPhoto(""); setError(""); setNotice(""); setPreparing(true);
    try { setPhoto(await normalizeEvidenceFile(file)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "No se pudo preparar la fotografía."); }
    finally { setPreparing(false); }
  }

  async function upload() {
    if (!selected || !photo || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/pendientes/remisiones", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replacementId: selected.replacementId, imageDataUrl: photo }),
      });
      await readResult(response);
      setNotice("Remisión firmada recibida. El analista revisará la foto antes de aplicar el nuevo IMEI.");
      setSelected(null); setPhoto("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "No se pudo confirmar la carga. Comprueba el estado antes de intentar de nuevo.");
      setSelected(null); setPhoto("");
    } finally {
      setConfirm(false); submitting.current = false; setBusy(false); await refresh();
    }
  }

  if (!loading && !items.length && !error) return null;
  return <Card className="min-w-0 space-y-4 p-4 sm:p-6" aria-label="Remisiones solicitadas por cambio de equipo">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-bold text-[var(--fp-graphite)]">Remisiones por garantía</h2>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">Sube la foto de la nueva remisión firmada que solicitó FINSER PAY para el equipo de reemplazo.</p></div>
      <Button variant="secondary" disabled={loading || busy} onClick={() => void refresh()}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar
      </Button>
    </div>
    {loading ? <p className="text-sm text-[var(--fp-muted)]">Consultando remisiones...</p> : null}
    {error ? <p role="alert" className="text-sm text-[var(--fp-danger)]">{error}</p> : null}
    {notice ? <p role="status" className="text-sm text-[var(--fp-graphite)]">{notice}</p> : null}
    <div className="divide-y divide-[var(--fp-border)]">
      {items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
        <div className="min-w-0">
          <p className="font-semibold text-[var(--fp-graphite)]">Crédito {item.creditNumber} · {item.clientName}</p>
          <p className="mt-1 text-sm text-[var(--fp-muted)]">Nuevo IMEI {item.newImeiMasked}</p>
        </div>
        {item.status === "PENDING_UPLOAD" ? <label className="fp-ui-button is-secondary relative min-h-11 cursor-pointer">
          <Upload className="h-4 w-4" aria-hidden="true" />{preparing && selected?.id === item.id ? "Preparando..." : "Subir remisión firmada"}
          <input type="file" accept="image/jpeg,image/png" capture="environment" className="sr-only"
            aria-label={`Subir remisión firmada del crédito ${item.creditNumber}`}
            disabled={busy || preparing}
            onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (file) void prepare(file, item); }} />
        </label> : <StatusPill tone={item.status === "VERIFIED" ? "positive" : "warning"}>
          {item.status === "VERIFIED" ? "Verificada" : "En revisión del analista"}
        </StatusPill>}
      </div>)}
    </div>
    {selected && photo ? <div className="space-y-3 border-t border-[var(--fp-border)] pt-4">
      <p className="font-semibold">Nueva foto firmada · crédito {selected.creditNumber}</p>
      {/* La vista previa local no se guarda hasta confirmar. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo} alt="Vista previa de la remisión firmada" className="max-h-72 max-w-full rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] object-contain" />
      <div className="flex flex-wrap gap-2"><Button onClick={() => setConfirm(true)} disabled={busy}>
        <FileCheck2 className="h-4 w-4" aria-hidden="true" />Enviar al analista
      </Button><Button variant="secondary" onClick={() => { setSelected(null); setPhoto(""); }} disabled={busy}>Cancelar</Button></div>
    </div> : null}
    <ConfirmDialog open={confirm} title="Enviar nueva remisión firmada"
      description={`Confirma que la foto corresponde al crédito ${selected?.creditNumber || ""} y contiene la firma del cliente. El analista debe verificarla antes de aplicar el nuevo IMEI.`}
      confirmLabel="Enviar foto" busy={busy}
      onCancel={() => { if (!submitting.current) setConfirm(false); }} onConfirm={() => void upload()} />
  </Card>;
}
