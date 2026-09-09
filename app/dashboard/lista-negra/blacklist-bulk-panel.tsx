"use client";

import { useRef, useState, type FormEvent } from "react";
import { ClipboardList } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, DataTable, LoadingState, StatusPill } from "@/app/_components/finser-ui";
import { BULK_MAX_ENTRIES, BULK_MAX_TEXT_LENGTH, countBlacklistBulkEntries, type BulkPreview, type BulkRow, type BulkSummary, type BulkResult } from "@/lib/document-blacklist-bulk-core";

type BulkConfirmation = { texto: string; motivo: string; fingerprint: string; mutationId: string; summary: BulkSummary };
type ApiError = { ok?: boolean; error?: string; code?: string };

const PREVIEW_PAGE_SIZE = 25;
const statusLabels: Record<BulkRow["status"], string> = {
  NUEVA: "Nuevo bloqueo",
  REACTIVAR: "Reactivar bloqueo",
  YA_BLOQUEADA: "Ya bloqueada",
  DUPLICADA: "Repetida en el texto",
  INVALIDA: "Cédula inválida",
};
const dateFormatter = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });

function statusTone(status: BulkRow["status"]): "danger" | "warning" | "neutral" {
  if (status === "INVALIDA") return "danger";
  if (status === "REACTIVAR") return "warning";
  return "neutral";
}

export default function BlacklistBulkPanel({
  disabled = false,
  onBusyChange,
  onCompleted,
}: {
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onCompleted: () => void;
}) {
  const [texto, setTexto] = useState("");
  const [motivo, setMotivo] = useState("");
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [confirmation, setConfirmation] = useState<BulkConfirmation | null>(null);
  const previewVersion = useRef(0);
  const submitting = useRef(false);
  const lastMutation = useRef<{ signature: string; mutationId: string } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const busy = disabled || saving || Boolean(confirmation);
  const entries = countBlacklistBulkEntries(texto);
  const limitError = texto.length > BULK_MAX_TEXT_LENGTH
    ? "El texto supera los 50.000 caracteres. Divide la lista en grupos más pequeños."
    : entries > BULK_MAX_ENTRIES ? "Hay más de 500 entradas. Divide la lista antes de previsualizar." : "";
  const validInput = entries > 0 && !limitError && motivo.trim().length >= 5 && motivo.trim().length <= 500;

  function invalidatePreview() {
    previewVersion.current += 1;
    setPreview(null);
    setLoading(false);
    setError("");
    setResult(null);
    setPreviewPage(1);
  }

  async function requestPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || loading || !validInput) return;
    const request = ++previewVersion.current;
    setLoading(true);
    setError("");
    setPreview(null);
    setResult(null);
    setPreviewPage(1);
    try {
      const response = await fetch("/api/lista-negra/masivo/previsualizar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto, motivo: motivo.trim() }),
        cache: "no-store",
      });
      const data = (await response.json()) as BulkPreview & ApiError;
      if (!response.ok || !data.ok || !Array.isArray(data.rows) || !data.summary || !data.fingerprint) {
        throw new Error(data.error || "No se pudo previsualizar la lista. Intenta nuevamente.");
      }
      if (request !== previewVersion.current) return;
      setPreview(data);
    } catch (caught) {
      if (request !== previewVersion.current) return;
      setError(caught instanceof Error ? caught.message : "No se pudo previsualizar la lista.");
    } finally {
      if (request === previewVersion.current) setLoading(false);
    }
  }

  function requestConfirmation() {
    if (busy || !preview?.canConfirm || !validInput) return;
    const body = { texto, motivo: preview.motivo, fingerprint: preview.fingerprint };
    const signature = JSON.stringify(body);
    if (lastMutation.current?.signature !== signature) {
      lastMutation.current = { signature, mutationId: crypto.randomUUID() };
    }
    setError("");
    setConfirmation({ ...body, mutationId: lastMutation.current.mutationId, summary: preview.summary });
    onBusyChange(true);
  }

  function cancelConfirmation() {
    if (submitting.current) return;
    setConfirmation(null);
    onBusyChange(false);
  }

  async function importDocuments() {
    if (!confirmation || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/lista-negra/masivo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          texto: confirmation.texto,
          motivo: confirmation.motivo,
          fingerprint: confirmation.fingerprint,
          mutationId: confirmation.mutationId,
          confirmed: true,
        }),
      });
      const data = (await response.json()) as BulkResult & ApiError;
      if (!response.ok || !data.ok) {
        if (data.code === "BULK_PREVIEW_CHANGED") {
          setPreview(null);
          lastMutation.current = null;
          throw new Error("La lista negra cambió desde la previsualización. No se aplicó esta carga; previsualiza nuevamente y revisa los nuevos estados.");
        }
        throw new Error(data.error || "No se pudo confirmar el resultado. Reintenta la misma importación; el servidor evita duplicados.");
      }
      if (!data.importId || !data.summary) {
        throw new Error("No se pudo confirmar el resultado. Reintenta la misma importación; el servidor evita duplicados.");
      }
      setResult(data);
      setPreview(null);
      setTexto("");
      setMotivo("");
      setError("");
      lastMutation.current = null;
      onCompleted();
    } catch (caught) {
      setError(caught instanceof TypeError || caught instanceof SyntaxError
        ? "No se pudo confirmar el resultado por un problema de conexión. Reintenta la misma importación; el servidor evita duplicados."
        : caught instanceof Error ? caught.message : "No se pudo importar la lista. Reintenta la misma operación.");
    } finally {
      submitting.current = false;
      setSaving(false);
      setConfirmation(null);
      onBusyChange(false);
    }
  }

  const lastPage = Math.max(1, Math.ceil((preview?.rows.length || 0) / PREVIEW_PAGE_SIZE));
  const visibleRows = preview?.rows.slice((previewPage - 1) * PREVIEW_PAGE_SIZE, previewPage * PREVIEW_PAGE_SIZE) || [];
  const omitted = preview ? preview.summary.yaBloqueadas + preview.summary.duplicadas : 0;

  return (
    <>
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-lg font-bold"><ClipboardList className="h-5 w-5" aria-hidden="true" />Pegar lista de cédulas</h2>
        <p className="mt-1 text-sm text-[var(--fp-muted)]">Registra hasta 500 entradas con un motivo común. Primero revisa la previsualización; no se guardará ningún bloqueo hasta confirmar.</p>
      </div>

      {result ? (
        <div className="mb-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-lime-soft)] px-4 py-3 text-sm" role="status">
          <p className="font-semibold">Carga masiva {result.idempotent ? "verificada" : "completada"}</p>
          {result.idempotent ? <p className="mt-1">Se recuperó el resultado de una carga ya registrada; no se volvió a aplicar. Consulta el listado actualizado para verificar los estados vigentes.</p> : <p className="mt-1">Los bloqueos se aplicaron a todos los aliados.</p>}
          <p className="mt-1">Resultado registrado: {result.summary.nuevas} bloqueos nuevos, {result.summary.reactivar} reactivados y {result.summary.yaBloqueadas + result.summary.duplicadas} entradas omitidas ({result.summary.yaBloqueadas} ya bloqueadas y {result.summary.duplicadas} repetidas).</p>
          <p className="mt-1 text-[var(--fp-muted)]">Registrado por {result.actorName || "administración central"}{result.createdAt && !Number.isNaN(new Date(result.createdAt).getTime()) ? ` · ${dateFormatter.format(new Date(result.createdAt))} (Colombia)` : ""}. El motivo y el historial quedaron guardados.</p>
        </div>
      ) : null}

      <form onSubmit={(event) => void requestPreview(event)} className="grid gap-4 lg:grid-cols-[minmax(260px,1.2fr)_minmax(260px,1fr)]">
        <label>
          <span className="mb-2 block text-sm font-semibold">Cédulas para bloquear</span>
          <textarea
            ref={textRef}
            className="fp-ui-input min-h-48 resize-y font-mono tabular-nums"
            value={texto}
            onChange={(event) => { setTexto(event.target.value); invalidatePreview(); }}
            placeholder={"Una cédula por línea\nTambién puedes separarlas con comas, punto y coma o tabulaciones."}
            rows={8}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="blacklist-bulk-format blacklist-bulk-limits"
            aria-invalid={Boolean(limitError)}
            required
            disabled={busy}
          />
          <span id="blacklist-bulk-format" className="mt-2 block text-sm text-[var(--fp-muted)]">Usa una cédula por línea, comas, punto y coma o tabulaciones. Los puntos, guiones y espacios dentro de una cédula se eliminan; no se usan para separar cédulas.</span>
          <span id="blacklist-bulk-limits" className={`mt-2 block text-sm ${limitError ? "text-[var(--fp-danger)]" : "text-[var(--fp-muted)]"}`}>{entries} / 500 entradas · {texto.length.toLocaleString("es-CO")} / 50.000 caracteres{limitError ? `. ${limitError}` : ""}</span>
        </label>
        <div className="flex flex-col gap-4">
          <label>
            <span className="mb-2 block text-sm font-semibold">Motivo común del bloqueo</span>
            <textarea className="fp-ui-input min-h-28 resize-y" value={motivo} onChange={(event) => { setMotivo(event.target.value); invalidatePreview(); }} placeholder="Describe el motivo que se registrará para todas las cédulas nuevas o reactivadas" minLength={5} maxLength={500} rows={4} required disabled={busy} aria-describedby="blacklist-bulk-reason-help" />
            <span id="blacklist-bulk-reason-help" className="mt-2 block text-sm text-[var(--fp-muted)]">Entre 5 y 500 caracteres. Las cédulas ya bloqueadas se omiten sin modificar su motivo ni su historial.</span>
          </label>
          <p className="text-sm text-[var(--fp-muted)]">Si una cédula tiene un bloqueo inactivo, la previsualización indicará que se reactivará. Las cédulas inválidas deben corregirse antes de importar la lista completa.</p>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || loading || !validInput}>{loading ? "Previsualizando..." : "Previsualizar lista"}</Button></div>
        </div>
      </form>

      {error ? <div role="alert" className="mt-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm text-[var(--fp-danger)]">{error}</div> : null}
      {loading ? <div className="mt-5"><LoadingState label="Validando cédulas y verificando bloqueos existentes..." /></div> : null}

      {preview ? (
        <section className="mt-6 border-t border-[var(--fp-border)] pt-5" aria-labelledby="blacklist-bulk-preview-title">
          <div className="flex flex-wrap items-center justify-between gap-3"><h3 id="blacklist-bulk-preview-title" className="text-lg font-bold">Previsualización de la carga</h3><Badge>{preview.summary.total} entradas</Badge></div>
          <div className="mt-3 flex flex-wrap gap-2" aria-label="Resumen de la previsualización"><Badge>{preview.summary.nuevas} nuevas</Badge><Badge tone={preview.summary.reactivar ? "warning" : "neutral"}>{preview.summary.reactivar} para reactivar</Badge><Badge>{preview.summary.yaBloqueadas} ya bloqueadas</Badge><Badge>{preview.summary.duplicadas} repetidas</Badge><Badge tone={preview.summary.invalidas ? "danger" : "neutral"}>{preview.summary.invalidas} inválidas</Badge></div>
          <p className="mt-3 text-sm text-[var(--fp-muted)]">Se aplicarán {preview.summary.nuevas + preview.summary.reactivar} bloqueos y se omitirán {omitted} entradas. Motivo: <span className="whitespace-pre-wrap break-words">{preview.motivo}</span></p>
          {preview.summary.invalidas > 0 ? <p className="mt-3 text-sm text-[var(--fp-danger)]" role="alert">No se puede guardar: corrige las entradas inválidas en el texto y vuelve a previsualizar. No se guardó ninguna cédula.</p> : !preview.canConfirm ? <p className="mt-3 text-sm text-[var(--fp-muted)]">No hay bloqueos nuevos ni inactivos para reactivar. Todas las cédulas válidas ya están bloqueadas.</p> : null}
          <DataTable className="mt-4">
            <table className="w-full min-w-[760px] text-sm [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_td]:px-4 [&_td]:py-3 [&_td]:align-top">
              <caption className="sr-only">Cédulas pegadas y acción prevista antes de confirmar</caption>
              <thead className="bg-[var(--fp-graphite)] text-white"><tr><th scope="col">Entrada</th><th scope="col">Texto pegado</th><th scope="col">Cédula normalizada</th><th scope="col">Estado</th><th scope="col">Detalle</th></tr></thead>
              <tbody className="divide-y divide-[var(--fp-border)]">{visibleRows.map((row) => <tr key={row.position}><td className="tabular-nums">{row.position}</td><td className="max-w-[220px] break-all whitespace-pre-wrap">{row.input}</td><td className="font-semibold tabular-nums">{row.documento || "—"}</td><td><StatusPill tone={statusTone(row.status)}>{statusLabels[row.status]}</StatusPill></td><td className="max-w-[340px] break-words">{row.message}</td></tr>)}</tbody>
            </table>
          </DataTable>
          {lastPage > 1 ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--fp-muted)]"><p>Página {previewPage} de {lastPage}</p><div className="flex gap-2"><Button variant="secondary" disabled={busy || previewPage <= 1} onClick={() => setPreviewPage((page) => page - 1)}>Anterior</Button><Button variant="secondary" disabled={busy || previewPage >= lastPage} onClick={() => setPreviewPage((page) => page + 1)}>Siguiente</Button></div></div> : null}
          <div className="mt-5 flex flex-wrap items-center gap-3"><Button variant="danger" onClick={requestConfirmation} disabled={busy || !preview.canConfirm}>Revisar importación de {preview.summary.nuevas + preview.summary.reactivar} cédulas</Button><p className="text-sm text-[var(--fp-muted)]">El servidor volverá a validar la lista antes de guardar.</p></div>
        </section>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirmation)}
        title="Confirmar bloqueo masivo global"
        description={confirmation ? `Se registrarán ${confirmation.summary.nuevas} bloqueos nuevos y se reactivarán ${confirmation.summary.reactivar} bloqueos inactivos. Se omitirán ${confirmation.summary.yaBloqueadas} cédulas ya bloqueadas y ${confirmation.summary.duplicadas} entradas repetidas, sin cambiar sus motivos. Las cédulas bloqueadas no podrán registrar ventas ni generar consultas de crédito en ningún aliado. Motivo común: ${confirmation.motivo}` : ""}
        confirmLabel="Confirmar carga masiva"
        busy={saving}
        danger
        onCancel={cancelConfirmation}
        onConfirm={() => void importDocuments()}
      />
    </>
  );
}
