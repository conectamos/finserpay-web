"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw, Search, ShieldBan, ShieldCheck, X } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, PageHeader, Select, StatusPill } from "@/app/_components/finser-ui";

type BlacklistItem = {
  id: string;
  documento: string;
  motivo: string;
  activa: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  updatedByName: string | null;
};
type FilterState = "ACTIVA" | "INACTIVA" | "TODAS";
type ListResult = { ok: boolean; items?: BlacklistItem[]; total?: number; pageSize?: number; error?: string };
type MutationBody =
  | { documento: string; motivo: string }
  | { id: string; activa: boolean; motivo: string; version: number };
type Confirmation = { method: "POST" | "PATCH"; body: MutationBody; documento: string; activa: boolean; mutationId: string };

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short",
});

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

function normalizeDocument(value: string) {
  return value.replace(/[.\s-]/g, "").replace(/^0+/, "");
}

export default function BlacklistConsole() {
  const [items, setItems] = useState<BlacklistItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [queryInput, setQueryInput] = useState("");
  const [filterInput, setFilterInput] = useState<FilterState>("ACTIVA");
  const [filters, setFilters] = useState({ q: "", estado: "ACTIVA" as FilterState, page: 1 });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [documento, setDocumento] = useState("");
  const [motivo, setMotivo] = useState("");
  const [editing, setEditing] = useState<BlacklistItem | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const requestVersion = useRef(0);
  const submitting = useRef(false);
  const lastMutation = useRef<{ signature: string; mutationId: string } | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const busy = saving || Boolean(confirmation);
  const targetActive = editing ? !editing.activa : true;

  const loadRecords = useCallback(async () => {
    const request = ++requestVersion.current;
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({ q: filters.q, estado: filters.estado, page: String(filters.page) });
      const response = await fetch(`/api/lista-negra?${query}`, { cache: "no-store" });
      const result = (await response.json()) as ListResult;
      if (!response.ok || !result.ok || !Array.isArray(result.items)) {
        throw new Error(result.error || "No se pudo cargar la lista negra.");
      }
      if (request !== requestVersion.current) return;
      setItems(result.items);
      setTotal(result.total || 0);
      setPageSize(result.pageSize || 25);
    } catch (error) {
      if (request !== requestVersion.current) return;
      setLoadError(error instanceof Error ? error.message : "No se pudo cargar la lista negra.");
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    void loadRecords();
    return () => { requestVersion.current += 1; };
  }, [loadRecords]);

  function clearEditor() {
    if (busy) return;
    setEditing(null);
    setDocumento("");
    setMotivo("");
    setNotice(null);
  }

  function selectItem(item: BlacklistItem) {
    setEditing(item);
    setDocumento(item.documento);
    setMotivo("");
    setNotice(null);
    requestAnimationFrame(() => {
      reasonRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      reasonRef.current?.focus({ preventScroll: true });
    });
  }

  function requestConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const normalized = normalizeDocument(documento);
    const reason = motivo.trim();
    if (!/^\d{3,13}$/.test(normalized)) {
      setNotice({ error: true, text: "Ingresa una cédula válida de 3 a 13 dígitos." });
      return;
    }
    if (reason.length < 5 || reason.length > 500) {
      setNotice({ error: true, text: "Describe el motivo con entre 5 y 500 caracteres." });
      reasonRef.current?.focus();
      return;
    }
    const method = editing ? "PATCH" : "POST";
    const body: MutationBody = editing
      ? { id: editing.id, activa: targetActive, motivo: reason, version: editing.version }
      : { documento: normalized, motivo: reason };
    const signature = JSON.stringify({ method, body });
    if (lastMutation.current?.signature !== signature) {
      lastMutation.current = { signature, mutationId: crypto.randomUUID() };
    }
    setNotice(null);
    setConfirmation({ method, body, documento: normalized, activa: targetActive, mutationId: lastMutation.current.mutationId });
  }

  async function saveChange() {
    if (!confirmation || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/lista-negra", {
        method: confirmation.method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...confirmation.body, mutationId: confirmation.mutationId }),
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.error || "No se pudo guardar el cambio. Actualiza la lista e intenta de nuevo.");
      }
      setNotice({
        error: false,
        text: confirmation.activa
          ? `Cédula ${confirmation.documento} bloqueada para ventas y consultas de crédito en todos los aliados.`
          : `Se desactivó el bloqueo de la cédula ${confirmation.documento}. El historial del registro se conserva.`,
      });
      lastMutation.current = null;
      setEditing(null);
      setDocumento("");
      setMotivo("");
      setConfirmation(null);
      setFilters({ q: confirmation.documento, estado: "TODAS", page: 1 });
      setQueryInput(confirmation.documento);
      setFilterInput("TODAS");
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : "No se pudo guardar el cambio." });
      setConfirmation(null);
      void loadRecords();
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters({ q: normalizeDocument(queryInput.trim()), estado: filterInput, page: 1 });
  }

  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow="Administración central"
        title="LISTA NEGRA"
        description="Bloquea cédulas para impedir ventas y consultas de crédito en todos los aliados."
        actions={
          <Button variant="secondary" onClick={() => void loadRecords()} disabled={busy || loading}>
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden="true" />
            Actualizar
          </Button>
        }
      />

      {notice ? (
        <div
          className={`mt-5 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] px-4 py-3 text-sm ${notice.error ? "bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]" : "bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]"}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.text}
        </div>
      ) : null}

      <Card className="mt-5 p-4 sm:p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold">
              {targetActive ? <ShieldBan className="h-5 w-5" aria-hidden="true" /> : <ShieldCheck className="h-5 w-5" aria-hidden="true" />}
              {editing ? targetActive ? "Reactivar bloqueo" : "Desactivar bloqueo" : "Registrar bloqueo"}
            </h2>
            <p className="mt-1 text-sm text-[var(--fp-muted)]">
              {editing
                ? targetActive ? "La cédula volverá a quedar bloqueada para todos los aliados." : "La cédula podrá continuar los procesos habituales de venta y evaluación."
                : "El bloqueo aplica a toda la red. Solo la administración central puede gestionar esta lista."}
            </p>
          </div>
          {editing ? <Button variant="ghost" onClick={clearEditor} disabled={busy} aria-label="Cancelar cambio de estado"><X className="h-4 w-4" aria-hidden="true" /></Button> : null}
        </div>

        <form onSubmit={requestConfirmation} className="grid gap-4 lg:grid-cols-[minmax(180px,.6fr)_minmax(260px,1.5fr)_auto] lg:items-end">
          <label>
            <span className="mb-2 block text-sm font-semibold">Cédula</span>
            <Input value={documento} onChange={(event) => setDocumento(event.target.value)} inputMode="numeric" autoComplete="off" maxLength={25} placeholder="Número de cédula" required disabled={busy || Boolean(editing)} />
          </label>
          <label>
            <span className="mb-2 block text-sm font-semibold">{editing ? "Motivo del cambio" : "Motivo del bloqueo"}</span>
            <textarea ref={reasonRef} className="fp-ui-input min-h-20 resize-y" value={motivo} onChange={(event) => setMotivo(event.target.value)} placeholder="Describe el motivo de esta decisión" minLength={5} maxLength={500} rows={2} required disabled={busy} />
          </label>
          <Button type="submit" variant={targetActive ? "danger" : "primary"} disabled={busy || !documento.trim() || motivo.trim().length < 5}>
            {targetActive ? "Revisar bloqueo" : "Revisar desbloqueo"}
          </Button>
        </form>
        <p className="mt-3 text-sm text-[var(--fp-muted)]">El motivo, la fecha y el usuario de cada cambio quedan registrados. Las fechas se muestran en hora de Colombia.</p>
      </Card>

      <section className="mt-6" aria-labelledby="blacklist-records-title">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 id="blacklist-records-title" className="text-lg font-bold">Cédulas registradas</h2>
          {!loading && !loadError ? <Badge>{total} {total === 1 ? "registro" : "registros"}</Badge> : null}
        </div>
        <Card className="p-4 sm:p-5">
          <form onSubmit={applySearch} className="grid gap-3 sm:grid-cols-[minmax(180px,1fr)_minmax(160px,.6fr)_auto] sm:items-end">
            <label>
              <span className="mb-2 block text-sm font-semibold">Buscar cédula</span>
              <Input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} inputMode="numeric" autoComplete="off" maxLength={25} placeholder="Todas las cédulas" disabled={busy} />
            </label>
            <label>
              <span className="mb-2 block text-sm font-semibold">Estado</span>
              <Select value={filterInput} onChange={(event) => setFilterInput(event.target.value as FilterState)} disabled={busy}>
                <option value="ACTIVA">Bloqueos activos</option>
                <option value="INACTIVA">Bloqueos inactivos</option>
                <option value="TODAS">Todos los registros</option>
              </Select>
            </label>
            <Button type="submit" variant="secondary" disabled={busy || loading}><Search className="h-4 w-4" aria-hidden="true" />Buscar</Button>
          </form>
        </Card>

        {loading ? <Card className="mt-4 p-8"><LoadingState label="Cargando cédulas registradas..." /></Card> : loadError ? (
          <Card className="mt-4 p-5"><div role="alert" className="text-sm text-[var(--fp-danger)]">{loadError}</div><Button variant="secondary" className="mt-4" onClick={() => void loadRecords()} disabled={busy}>Reintentar</Button></Card>
        ) : items.length === 0 ? (
          <Card className="mt-4"><EmptyState title="Sin registros para esta búsqueda" description="Prueba otra cédula o selecciona todos los estados. Una cédula con bloqueo activo no podrá venderse ni generar consultas de crédito." /></Card>
        ) : (
          <DataTable className="mt-4 bg-[var(--fp-surface)]">
            <table className="w-full min-w-[1050px] text-sm [&_th]:px-4 [&_th]:py-3 [&_th]:text-left [&_td]:px-4 [&_td]:py-4 [&_td]:align-top">
              <caption className="sr-only">Cédulas de la lista negra. Las acciones afectan a todos los aliados.</caption>
              <thead className="bg-[var(--fp-graphite)] text-white"><tr><th scope="col">Cédula / estado</th><th scope="col">Motivo vigente</th><th scope="col">Registro inicial</th><th scope="col">Último cambio</th><th scope="col">Acción</th></tr></thead>
              <tbody className="divide-y divide-[var(--fp-border)]">
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><span className="block font-semibold tabular-nums">{item.documento}</span><StatusPill tone={item.activa ? "danger" : "neutral"} className="mt-2">{item.activa ? "Bloqueo activo" : "Bloqueo inactivo"}</StatusPill></td>
                    <td className="min-w-[230px] max-w-[420px]"><p className="whitespace-pre-wrap break-words">{item.motivo}</p></td>
                    <td><span className="block whitespace-nowrap">{formatDate(item.createdAt)}</span><span className="mt-1 block text-sm text-[var(--fp-muted)]">{item.createdByName || "—"}</span></td>
                    <td><span className="block whitespace-nowrap">{formatDate(item.updatedAt)}</span><span className="mt-1 block text-sm text-[var(--fp-muted)]">{item.updatedByName || "—"}</span></td>
                    <td><Button variant="secondary" onClick={() => selectItem(item)} disabled={busy} aria-label={`${item.activa ? "Desactivar" : "Reactivar"} bloqueo de cédula ${item.documento}`}>{item.activa ? "Desactivar" : "Reactivar"}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DataTable>
        )}
        {!loading && !loadError && total > pageSize ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--fp-muted)]">
            <p>Página {filters.page} de {lastPage}</p>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={busy || filters.page <= 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Anterior</Button>
              <Button variant="secondary" disabled={busy || filters.page >= lastPage} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Siguiente</Button>
            </div>
          </div>
        ) : null}
      </section>

      <ConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.activa ? "Confirmar bloqueo global" : "Confirmar desactivación del bloqueo"}
        description={confirmation ? `${confirmation.activa ? `La cédula ${confirmation.documento} no podrá registrar ventas ni generar consultas de crédito en ningún aliado.` : `Se desactivará el bloqueo de la cédula ${confirmation.documento} para todos los aliados.`} Motivo: ${confirmation.body.motivo}` : ""}
        confirmLabel={confirmation?.activa ? "Confirmar bloqueo" : "Confirmar desactivación"}
        busy={saving}
        danger={Boolean(confirmation?.activa)}
        onCancel={() => { if (!submitting.current) setConfirmation(null); }}
        onConfirm={() => void saveChange()}
      />
    </main>
  );
}
