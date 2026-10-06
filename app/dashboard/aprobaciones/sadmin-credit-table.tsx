"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Download, RefreshCw, Save, Search } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, PageHeader, Select, Tabs } from "@/app/_components/finser-ui";
import type {
  SadminCreationStatus, SadminCreditRow, SadminPage, SadminRegistration,
  SadminStatusFilter, SadminSummary,
} from "@/lib/credit-sadmin-types";
import { confirmedSadminNumber, creditDisplayNumber } from "@/lib/credit-display-number";
import styles from "./sadmin-credit-table.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const percentage = new Intl.NumberFormat("es-CO", { style: "percent", maximumFractionDigits: 4 });
const calendar = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", dateStyle: "short" });
const timestamp = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" });
const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const text = (value: string | null | undefined) => value?.trim() || "—";
const amount = (value: number) => Number.isFinite(value) ? money.format(value) : "—";
const rate = (value: number | null) => value !== null && Number.isFinite(value) ? percentage.format(value) : "No disponible";
function date(value: string | null, includeTime = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? (includeTime ? timestamp : calendar).format(parsed) : "—";
}
function frequency(value: string) {
  return ({ QUINCENAL: "Quincenal", MENSUAL: "Mensual", SEMANAL: "Semanal" } as Record<string, string>)[value] || text(value);
}
function responseError(payload: { error?: unknown; message?: unknown }, fallback: string) {
  return typeof payload.error === "string" ? payload.error : typeof payload.message === "string" ? payload.message : fallback;
}
class SadminRequestError extends Error {}

function exportFileName(contentDisposition: string | null, status: SadminStatusFilter) {
  const fallback = `creacion-sadmin-${status}-${new Date().toISOString().slice(0, 10)}.xlsx`;
  if (!contentDisposition) return fallback;

  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = contentDisposition.match(/filename="([^"]+)"/i)?.[1]
    ?? contentDisposition.match(/filename=([^;]+)/i)?.[1];
  let candidate = encoded ?? plain;
  if (!candidate) return fallback;

  try { candidate = decodeURIComponent(candidate.trim()); } catch { candidate = candidate.trim(); }
  const safe = candidate
    .split(/[\\/]/)
    .pop()
    ?.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
  return safe?.toLowerCase().endsWith(".xlsx") ? safe : fallback;
}

function Facts({ items, numeric = false }: { items: Array<[string, ReactNode]>; numeric?: boolean }) {
  return <dl className={`${styles.facts} ${numeric ? styles.numeric : ""}`}>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

type ChecklistField = "codeudorCreado" | "creditoCreado" | "numeroCreditoConfirmado";
const checklist: Array<[ChecklistField, string]> = [["codeudorCreado", "CODEUDOR CREADO"], ["creditoCreado", "CRÉDITO CREADO"], ["numeroCreditoConfirmado", "NÚMERO DE CRÉDITO"]];
const statusTabs: Array<{ id: SadminStatusFilter; label: string }> = [
  { id: "all", label: "Todos" },
  { id: "pending", label: "Pendientes" },
  { id: "created", label: "Creados" },
];
const creationStatuses: Array<{ id: SadminCreationStatus; label: string }> = [
  { id: "PENDIENTE_CREAR", label: "Pendiente de crear" },
  { id: "CREADO_CORRECTAMENTE", label: "Creado correctamente" },
  { id: "ERROR_CREACION", label: "Error de creación" },
  { id: "REQUIERE_REVISION", label: "Requiere revisión" },
];
const creationStatusLabels = Object.fromEntries(creationStatuses.map(item => [item.id, item.label])) as Record<SadminCreationStatus, string>;
function creationTone(status: SadminCreationStatus): "neutral" | "positive" | "warning" | "danger" {
  if (status === "CREADO_CORRECTAMENTE") return "positive";
  if (status === "ERROR_CREACION") return "danger";
  if (status === "REQUIERE_REVISION") return "warning";
  return "neutral";
}
const statusNeedsReason = (status: SadminCreationStatus) => status === "ERROR_CREACION" || status === "REQUIERE_REVISION";
type OutcomeDraft = { status: SadminCreationStatus; reason: string };

function matchesStatus(status: SadminStatusFilter, registration: SadminRegistration) {
  if (status === "all") return true;
  return status === "created" ? registration.estadoCreacion === "CREADO_CORRECTAMENTE" : registration.estadoCreacion !== "CREADO_CORRECTAMENTE";
}

function emptyCopy(status: SadminStatusFilter, hasQuery: boolean) {
  if (hasQuery) {
    const scope = status === "pending" ? "pendientes" : status === "created" ? "creados" : "disponibles";
    return { title: "Sin resultados", description: `No encontramos créditos ${scope} con esa búsqueda. Prueba con otro cliente, cédula, folio o número SADMIN.` };
  }
  if (status === "pending") return { title: "No hay créditos pendientes", description: "Todos los créditos disponibles ya fueron creados en SADMIN." };
  if (status === "created") return { title: "No hay créditos creados", description: "Los créditos aparecerán aquí cuando se completen las tres verificaciones de SADMIN." };
  return { title: "No hay créditos disponibles", description: "Los créditos aparecerán aquí cuando estén disponibles en cartera." };
}

export default function SadminCreditTable({ onBack }: { onBack: () => void }) {
  const [filters, setFilters] = useState<{ page: number; query: string; status: SadminStatusFilter }>({ page: 1, query: "", status: "all" });
  const [searchText, setSearchText] = useState("");
  const [data, setData] = useState<SadminPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [reload, setReload] = useState(0);
  const [draftNumbers, setDraftNumbers] = useState<Record<number, string>>({});
  const [outcomeDrafts, setOutcomeDrafts] = useState<Record<number, OutcomeDraft>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [summaries, setSummaries] = useState<Record<number, SadminSummary>>({});
  const [summaryErrors, setSummaryErrors] = useState<Record<number, string>>({});
  const [summaryLoadingIds, setSummaryLoadingIds] = useState<Set<number>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const pendingRequests = useRef(new Set<number>());
  const summaryRequests = useRef(new Set<number>());
  const hasDrafts = Object.keys(draftNumbers).length > 0;
  const hasOutcomeDrafts = Object.keys(outcomeDrafts).length > 0;
  const navigationBlocked = savingIds.size > 0 || hasDrafts || hasOutcomeDrafts;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      setData(null);
      try {
        const params = new URLSearchParams({ page: String(filters.page), q: filters.query, status: filters.status });
        const response = await fetch(`/api/aprobaciones/sadmin?${params}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as SadminPage & { ok?: boolean; error?: unknown; message?: unknown };
        if (!response.ok || !payload.ok || !Array.isArray(payload.items)) throw new SadminRequestError(responseError(payload, "No pudimos cargar los créditos. Intenta de nuevo."));
        if (controller.signal.aborted) return;
        setData(payload);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof SadminRequestError ? cause.message : "No pudimos cargar los créditos. Revisa tu conexión e intenta de nuevo.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [filters, reload]);

  useEffect(() => {
    if (!navigationBlocked) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [navigationBlocked]);

  function discardDraft(id: number) {
    setDraftNumbers(current => { const next = { ...current }; delete next[id]; return next; });
  }

  function discardOutcomeDraft(id: number) {
    setOutcomeDrafts(current => { const next = { ...current }; delete next[id]; return next; });
  }

  function editNumber(row: SadminCreditRow, value: string) {
    if (!row.canEditSadmin) return;
    if (value === (row.sadmin.numeroCredito || "")) discardDraft(row.id);
    else setDraftNumbers(current => ({ ...current, [row.id]: value }));
  }

  function editOutcome(row: SadminCreditRow, status: SadminCreationStatus, reason: string) {
    if (!row.canEditSadmin) return;
    const normalizedCurrentReason = row.sadmin.motivoEstado || "";
    if (status === row.sadmin.estadoCreacion && reason === normalizedCurrentReason) discardOutcomeDraft(row.id);
    else setOutcomeDrafts(current => ({ ...current, [row.id]: { status, reason } }));
  }

  async function loadSummary(id: number) {
    if (summaryRequests.current.has(id)) return;
    summaryRequests.current.add(id);
    setSummaryLoadingIds(new Set(summaryRequests.current));
    setSummaryErrors(current => ({ ...current, [id]: "" }));
    try {
      const response = await fetch(`/api/aprobaciones/sadmin/${id}`, { cache: "no-store" });
      const payload = await response.json() as { ok?: boolean; summary?: SadminSummary; error?: unknown; message?: unknown };
      if (!response.ok || !payload.ok || !payload.summary) {
        throw new SadminRequestError(responseError(payload, "No pudimos cargar el historial SADMIN."));
      }
      setSummaries(current => ({ ...current, [id]: payload.summary! }));
    } catch (cause) {
      setSummaryErrors(current => ({
        ...current,
        [id]: cause instanceof SadminRequestError ? cause.message : "No pudimos cargar el historial SADMIN. Revisa tu conexión e intenta de nuevo.",
      }));
    } finally {
      summaryRequests.current.delete(id);
      setSummaryLoadingIds(new Set(summaryRequests.current));
    }
  }

  function hideDataForLoad() {
    setLoading(true);
    setError("");
    setExportError("");
    setData(null);
  }

  function selectStatus(status: SadminStatusFilter) {
    if (navigationBlocked || loading || status === filters.status) return;
    setExpandedId(null);
    hideDataForLoad();
    setFilters(current => ({ ...current, page: 1, status }));
  }

  async function exportExcel() {
    if (loading || exporting || navigationBlocked || error || !data || data.total === 0) return;
    setExporting(true);
    setExportError("");
    try {
      const params = new URLSearchParams({ q: filters.query, status: filters.status });
      const response = await fetch(`/api/aprobaciones/sadmin/export?${params}`, { cache: "no-store" });
      if (!response.ok) {
        let payload: { error?: unknown; message?: unknown } = {};
        try { payload = await response.json() as { error?: unknown; message?: unknown }; } catch {}
        throw new SadminRequestError(responseError(payload, "No pudimos generar el Excel. Intenta de nuevo."));
      }
      const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (mime !== xlsxMime) throw new SadminRequestError("El servidor no devolvió un archivo Excel válido. Intenta de nuevo.");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(response.headers.get("Content-Disposition"), filters.status);
      link.style.display = "none";
      try {
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) {
      setExportError(cause instanceof SadminRequestError ? cause.message : "No pudimos generar el Excel. Revisa tu conexión e intenta de nuevo.");
    } finally {
      setExporting(false);
    }
  }

  async function save(
    row: SadminCreditRow,
    field: ChecklistField | "numeroCredito" | "estadoCreacion",
    value: boolean | string,
    reason: string | null = null,
  ) {
    if (!row.canEditSadmin || loading || error || pendingRequests.current.size > 0) return;
    pendingRequests.current.add(row.id);
    setSavingIds(new Set(pendingRequests.current));
    setRowErrors(current => ({ ...current, [row.id]: "" }));
    try {
      const response = await fetch(`/api/aprobaciones/sadmin/${row.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: row.sadmin.version, field, value, ...(field === "estadoCreacion" ? { reason } : {}) }),
      });
      const payload = await response.json() as { ok?: boolean; sadmin?: SadminRegistration; code?: string; error?: unknown; message?: unknown };
      if (response.status === 409 && (payload.code === "SADMIN_CHANGED" || payload.code === "REVIEW_CHANGED")) {
        setRowErrors(current => ({ ...current, [row.id]: "Otra persona actualizó este crédito. Actualizamos el registro y conservamos el número que estás editando. Revisa la información antes de guardar de nuevo." }));
        setLoading(true);
        setReload(current => current + 1);
        return;
      }
      if (!response.ok || !payload.ok || !payload.sadmin) throw new SadminRequestError(responseError(payload, "No pudimos guardar el cambio. Intenta de nuevo."));
      const saved = payload.sadmin;
      if (field === "numeroCredito") discardDraft(row.id);
      if (field === "estadoCreacion") discardOutcomeDraft(row.id);
      if (!matchesStatus(filters.status, saved)) {
        setExpandedId(null);
        setLoading(true);
        setReload(current => current + 1);
        return;
      }
      setData(current => {
        if (!current) return current;
        const changedStatus = row.sadmin.estado !== saved.estado;
        const counts = !changedStatus ? current.counts : {
          ...current.counts,
          pending: Math.max(0, current.counts.pending + (saved.estado === "PENDIENTE" ? 1 : -1)),
          created: Math.max(0, current.counts.created + (saved.estado === "CREADO_SADMIN" ? 1 : -1)),
        };
        return { ...current, counts, items: current.items.map(item => item.id === row.id ? { ...item, sadmin: saved, numeroCreditoVisible: confirmedSadminNumber(saved) || item.folio } : item) };
      });
      if (summaries[row.id]) void loadSummary(row.id);
    } catch (cause) {
      setRowErrors(current => ({ ...current, [row.id]: cause instanceof SadminRequestError ? cause.message : "No pudimos guardar el cambio. Revisa tu conexión e intenta de nuevo." }));
    } finally {
      pendingRequests.current.delete(row.id);
      setSavingIds(new Set(pendingRequests.current));
    }
  }

  const page = data?.page || filters.page;
  const totalPages = Math.max(1, data?.totalPages || 1);
  const empty = emptyCopy(filters.status, Boolean(filters.query));
  const loadingLabel = filters.status === "pending" ? "Cargando créditos pendientes..." : filters.status === "created" ? "Cargando créditos creados..." : "Cargando créditos de cartera...";
  const totalLabel = filters.status === "pending" ? "créditos pendientes" : filters.status === "created" ? "créditos creados" : "créditos";
  const tabsBlocked = navigationBlocked || loading;

  return <main className={styles.main}>
    <PageHeader eyebrow="Control de creación" title="Creación en SADMIN" description="Todos los créditos de cartera desde el inicio de la operación, incluidos históricos y pagados. Los más recientes aparecen primero." actions={<Button variant="secondary" disabled={navigationBlocked} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Volver a aprobaciones</Button>} />
    <Tabs aria-label="Filtrar créditos por estado SADMIN" className={styles.statusTabs}>
      {statusTabs.map(tab => <button key={tab.id} id={`sadmin-status-${tab.id}`} type="button" role="tab" aria-selected={filters.status === tab.id} aria-controls="sadmin-credit-results" tabIndex={filters.status === tab.id ? 0 : -1} disabled={tabsBlocked} onClick={() => selectStatus(tab.id)} onKeyDown={event => {
        if (tabsBlocked || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = statusTabs.findIndex(item => item.id === filters.status);
        const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? statusTabs.length - 1 : (current + (event.key === "ArrowLeft" ? -1 : 1) + statusTabs.length) % statusTabs.length;
        const next = statusTabs[nextIndex].id;
        selectStatus(next);
        document.getElementById(`sadmin-status-${next}`)?.focus();
      }}>{tab.label}<span className={styles.tabCount}>{data ? data.counts[tab.id].toLocaleString("es-CO") : "—"}</span></button>)}
    </Tabs>
    <section id="sadmin-credit-results" role="tabpanel" aria-labelledby={`sadmin-status-${filters.status}`} aria-busy={loading}>
    <Card className={styles.toolbar}>
      <form onSubmit={event => { event.preventDefault(); if (navigationBlocked || loading) return; setExpandedId(null); hideDataForLoad(); setFilters(current => ({ ...current, page: 1, query: searchText.trim() })); }} className={styles.search}>
        <label className="sr-only" htmlFor="sadmin-search">Buscar por cliente, cédula, folio o número SADMIN</label>
        <Input id="sadmin-search" type="search" autoComplete="off" placeholder="Cliente, cédula, folio o número SADMIN" maxLength={100} value={searchText} disabled={navigationBlocked} onChange={event => setSearchText(event.target.value)} />
        <Button type="submit" variant="secondary" disabled={navigationBlocked || loading}><Search size={16} aria-hidden="true" />Buscar</Button>
        {filters.query ? <Button variant="ghost" disabled={navigationBlocked || loading} onClick={() => { setSearchText(""); setExpandedId(null); hideDataForLoad(); setFilters(current => ({ ...current, page: 1, query: "" })); }}>Limpiar</Button> : null}
      </form>
      <div className={styles.toolbarActions}>
        <Button variant="secondary" aria-busy={exporting} disabled={loading || exporting || navigationBlocked || Boolean(error) || !data || data.total === 0} onClick={() => void exportExcel()}><Download size={16} aria-hidden="true" />{exporting ? "Generando Excel..." : "Exportar Excel"}</Button>
        <Button variant="secondary" disabled={navigationBlocked || loading} onClick={() => { hideDataForLoad(); setReload(current => current + 1); }}><RefreshCw size={16} aria-hidden="true" />Actualizar</Button>
      </div>
    </Card>
    {exportError ? <p className={styles.exportError} role="alert">{exportError}</p> : null}
    <p className={styles.help}>Registra el resultado operativo. <strong>Creado correctamente</strong> requiere las tres verificaciones y el número asignado; error y revisión requieren una razón que queda en el historial.</p>
    {hasDrafts || hasOutcomeDrafts ? <p className={styles.notice} role="status">Tienes cambios sin guardar. Guárdalos o cancélalos antes de cambiar de página o volver a aprobaciones.</p> : null}
    {error ? <Card className={styles.error} role="alert"><p>{error}</p><Button variant="secondary" disabled={loading || savingIds.size > 0} onClick={() => { hideDataForLoad(); setReload(current => current + 1); }}>Reintentar</Button></Card> : null}
    {loading ? <LoadingState label={loadingLabel} /> : null}
    {!loading && !error && data?.items.length === 0 ? <EmptyState title={empty.title} description={empty.description} /> : null}
    {!loading && !error && data?.items.length ? <>
      <div className={styles.summary}><span>{data.total.toLocaleString("es-CO")} {totalLabel} · 20 registros por página</span><span>Más recientes primero</span></div>
      <DataTable className={styles.tableWrap}>
        <table className={styles.table} aria-label="Créditos de cartera para creación en SADMIN" aria-busy={loading}>
          <thead><tr><th scope="col">Crédito</th></tr></thead>
          <tbody>{data.items.map(row => {
            const saving = savingIds.has(row.id);
            const dirty = Object.hasOwn(draftNumbers, row.id);
            const outcomeDirty = Object.hasOwn(outcomeDrafts, row.id);
            const outcome = outcomeDrafts[row.id] ?? { status: row.sadmin.estadoCreacion, reason: row.sadmin.motivoEstado || "" };
            const outcomeNeedsReason = statusNeedsReason(outcome.status);
            const number = draftNumbers[row.id] ?? row.sadmin.numeroCredito ?? "";
            const disabled = !row.canEditSadmin || savingIds.size > 0 || loading || Boolean(error);
            const completed = checklist.filter(([field]) => row.sadmin[field]).length;
            const expanded = expandedId === row.id;
            const visibleNumber = creditDisplayNumber(row);
            const summary = summaries[row.id];
            const summaryLoading = summaryLoadingIds.has(row.id);
            return <Fragment key={row.id}><tr>
              <th scope="row" className={styles.credit}>
                <button id={`sadmin-credit-${row.id}`} type="button" className={styles.creditButton} aria-expanded={expanded} aria-controls={`sadmin-detail-${row.id}`} onClick={() => setExpandedId(expanded ? null : row.id)}>
                  <span className={styles.creditSummary}>
                    <strong>{visibleNumber}</strong>
                    <span className={styles.creditDate}><span>Fecha crédito</span><span>{date(row.fechaCredito)}</span></span>
                    <Badge tone={creationTone(row.sadmin.estadoCreacion)}>{creationStatusLabels[row.sadmin.estadoCreacion]}</Badge>
                  </span>
                  <ChevronDown size={18} aria-hidden="true" className={expanded ? styles.expandedIcon : ""} />
                </button>
              </th>
            </tr>{expanded ? <tr className={styles.detailRow}><td><div id={`sadmin-detail-${row.id}`} role="region" aria-labelledby={`sadmin-credit-${row.id}`} className={styles.expandedContent}>
              <div className={styles.details}>
              <section><h3>Datos del cliente</h3><Facts items={[["Nombre", text(row.clienteNombre)], ["Cédula", text(row.clienteDocumento)], ["Teléfono", text(row.clienteTelefono)], ["Correo", text(row.clienteCorreo)], ["Dirección", text(row.clienteDireccion)], ["Nacimiento", date(row.clienteFechaNacimiento)], ["Género", text(row.clienteGenero)]]} /></section>
              <section><h3>Crédito, equipo y origen</h3><Facts items={[["Número de crédito", visibleNumber], ["Folio original", row.folio], ["Fecha crédito", date(row.fechaCredito)], ["Creado", date(row.createdAt, true)], ["Referencia", text(row.referenciaEquipo)], ["IMEI", text(row.imei)], ["Aliado", text(row.aliadoNombre)], ["Sede", text(row.sedeNombre)], ["Registro local", <a key="local" href={row.registroLocalHref} aria-disabled={navigationBlocked} onClick={event => { if (navigationBlocked) event.preventDefault(); }}>Abrir registro local</a>]]} /></section>
              <section><h3>Valores y plan</h3><Facts numeric items={[["Valor venta", amount(row.valorVenta)], ["Inicial", amount(row.cuotaInicial)], ["Crédito autorizado", amount(row.creditoAutorizado)], ["N.º cuotas", row.numeroCuotas], ["Valor cuota", amount(row.valorCuota)], ["Frecuencia", frequency(row.frecuenciaPago)]]} /></section>
              <section><h3>Tasas</h3><Facts numeric items={[["Interés mensual efectivo", rate(row.interesMensual)], ["Fianza total del crédito", rate(row.fianza)], ["Seguro por cuota", rate(row.seguro)]]} /></section>
              <section><h3>Pagos</h3><Facts numeric items={[["Próximo pago", date(row.fechaProximoPago)], ["Cuotas pagadas", row.cuotasPagadas], ["Cuotas pendientes", row.cuotasPendientes], ["Días vencidos", row.diasVencidos], ["Último pago", text(row.ultimoPago)]]} /></section>
              <section><h3>Saldos</h3><Facts numeric items={[["Obligación", amount(row.saldoObligacion)], ["Capital", amount(row.saldoCapital)], ["Fianza", amount(row.saldoFianza)], ["Intereses", amount(row.saldoIntereses)], ...(row.saldoSeguro ? [["Seguro", amount(row.saldoSeguro)] as [string, string]] : [])]} /></section>
              </div>
              <section className={styles.registration}><h3>Creación SADMIN</h3>
                <div className={styles.progress}><Badge tone={creationTone(row.sadmin.estadoCreacion)}>{creationStatusLabels[row.sadmin.estadoCreacion]}</Badge><Badge tone={row.sadmin.estado === "CREADO_SADMIN" ? "positive" : "warning"}>{completed} de 3 verificaciones</Badge>{saving ? <span role="status">Guardando...</span> : null}</div>
                {!row.canEditSadmin ? <p className={styles.updated}>Consulta del registro histórico. Para completar o modificar su creación en SADMIN, el crédito debe tener aprobación vigente y estar listo para el proceso operativo.</p> : null}
                <fieldset id={`sadmin-checklist-${row.id}`} disabled={disabled} aria-label={`Verificaciones SADMIN de ${visibleNumber}`}>
                  {checklist.slice(0, 2).map(([field, label]) => <label key={field} className={styles.check}><input type="checkbox" checked={row.sadmin[field]} onChange={event => void save(row, field, event.target.checked)} /><span>{label}</span></label>)}
                  <div className={styles.number}>
                    <label htmlFor={`sadmin-number-${row.id}`}>Número asignado en SADMIN</label>
                    <Input id={`sadmin-number-${row.id}`} type="text" autoComplete="off" maxLength={80} value={number} onChange={event => editNumber(row, event.target.value)} placeholder="Escribe el número" aria-describedby={`sadmin-number-help-${row.id}`} />
                    {dirty ? <div className={styles.numberActions}><Button variant="secondary" onClick={() => void save(row, "numeroCredito", number)}><Save size={14} aria-hidden="true" />Guardar número</Button><Button variant="ghost" onClick={() => discardDraft(row.id)}>Cancelar</Button></div> : null}
                    <p id={`sadmin-number-help-${row.id}`}>{dirty ? "Guarda el número y vuelve a marcar su verificación." : row.sadmin.numeroCredito ? "Número guardado." : "Guarda el número para verificarlo."}</p>
                  </div>
                  <label className={styles.check}><input type="checkbox" checked={!dirty && row.sadmin.numeroCreditoConfirmado} disabled={dirty || !row.sadmin.numeroCredito?.trim()} onChange={event => void save(row, "numeroCreditoConfirmado", event.target.checked)} /><span>NÚMERO DE CRÉDITO</span></label>
                </fieldset>
                <div className={styles.number}>
                  <label htmlFor={`sadmin-result-${row.id}`}>Resultado operativo</label>
                  <Select id={`sadmin-result-${row.id}`} value={outcome.status} disabled={disabled || row.sadmin.estado === "CREADO_SADMIN"} onChange={event => {
                    const status = event.target.value as SadminCreationStatus;
                    editOutcome(row, status, statusNeedsReason(status) ? outcome.reason : "");
                  }}>
                    {creationStatuses.map(status => <option key={status.id} value={status.id} disabled={status.id === "CREADO_CORRECTAMENTE"}>{status.label}</option>)}
                  </Select>
                  {outcomeNeedsReason ? <>
                    <label htmlFor={`sadmin-reason-${row.id}`}>Razón</label>
                    <Input id={`sadmin-reason-${row.id}`} type="text" autoComplete="off" maxLength={500} value={outcome.reason} disabled={disabled} onChange={event => editOutcome(row, outcome.status, event.target.value)} placeholder="Describe qué falló o qué debe revisarse" />
                  </> : null}
                  {outcomeDirty ? <div className={styles.numberActions}>
                    <Button variant="secondary" disabled={outcomeNeedsReason && !outcome.reason.trim()} onClick={() => void save(row, "estadoCreacion", outcome.status, outcomeNeedsReason ? outcome.reason.trim() : null)}><Save size={14} aria-hidden="true" />Guardar resultado</Button>
                    <Button variant="ghost" onClick={() => discardOutcomeDraft(row.id)}>Cancelar</Button>
                  </div> : null}
                  {row.sadmin.estado === "CREADO_SADMIN" && row.canEditSadmin ? <p>El resultado correcto se deriva del flujo manual completo. Desmarca una verificación para reabrirlo.</p>
                    : row.sadmin.motivoEstado ? <p>Razón actual: {row.sadmin.motivoEstado}</p> : null}
                </div>
                {rowErrors[row.id] ? <p role="alert" className={styles.rowError}>{rowErrors[row.id]}</p> : null}
                {row.sadmin.completedAt ? <p className={styles.updated}>Completado: {date(row.sadmin.completedAt, true)}</p> : row.sadmin.updatedAt ? <p className={styles.updated}>Actualizado: {date(row.sadmin.updatedAt, true)}</p> : null}
                <div className={styles.number}>
                  <h3>Historial SADMIN</h3>
                  <Button variant="ghost" disabled={summaryLoading} aria-busy={summaryLoading} onClick={() => void loadSummary(row.id)}>{summaryLoading ? "Cargando historial..." : summary ? "Actualizar historial" : "Ver historial"}</Button>
                  {summaryErrors[row.id] ? <p role="alert" className={styles.rowError}>{summaryErrors[row.id]}</p> : null}
                  {summary && summary.historial.length === 0 ? <p className={styles.updated}>Aún no hay cambios registrados.</p> : null}
                  {summary?.historial.length ? <Facts items={summary.historial.map(entry => [
                    `Versión ${entry.version}`,
                    <span key={entry.version}>{creationStatusLabels[entry.resultado]} · {entry.actor} · {date(entry.fechaHora, true)} · Número: {text(entry.numeroCredito)}{entry.motivo ? ` · Razón: ${entry.motivo}` : ""}</span>,
                  ] as [string, ReactNode])} /> : null}
                </div>
              </section>
            </div></td></tr> : null}</Fragment>;
          })}</tbody>
        </table>
      </DataTable>
    </> : null}
    {!loading && !error && data ? <nav aria-label="Páginas de créditos SADMIN" className={styles.pagination}>
      <p aria-live="polite">Página {page} de {totalPages}{data.total ? ` · ${((page - 1) * data.pageSize + 1).toLocaleString("es-CO")}–${Math.min(page * data.pageSize, data.total).toLocaleString("es-CO")} de ${data.total.toLocaleString("es-CO")}` : ""}</p>
      <div><Button variant="secondary" disabled={navigationBlocked || loading || Boolean(error) || page <= 1} onClick={() => { hideDataForLoad(); setFilters(current => ({ ...current, page: page - 1 })); }}><ChevronLeft size={16} aria-hidden="true" />Anterior</Button><Button variant="secondary" disabled={navigationBlocked || loading || Boolean(error) || page >= totalPages} onClick={() => { hideDataForLoad(); setFilters(current => ({ ...current, page: page + 1 })); }}>Siguiente<ChevronRight size={16} aria-hidden="true" /></Button></div>
    </nav> : null}
    </section>
  </main>;
}
