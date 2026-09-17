"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, RefreshCw, Save, Search } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, PageHeader } from "@/app/_components/finser-ui";
import type { SadminCreditRow, SadminPage, SadminRegistration } from "@/lib/credit-sadmin-types";
import styles from "./sadmin-credit-table.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const percentage = new Intl.NumberFormat("es-CO", { style: "percent", maximumFractionDigits: 4 });
const calendar = new Intl.DateTimeFormat("es-CO", { timeZone: "UTC", dateStyle: "short" });
const timestamp = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" });
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
function Facts({ items, numeric = false }: { items: Array<[string, ReactNode]>; numeric?: boolean }) {
  return <dl className={`${styles.facts} ${numeric ? styles.numeric : ""}`}>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

type ChecklistField = "codeudorCreado" | "creditoCreado" | "numeroCreditoConfirmado";
const checklist: Array<[ChecklistField, string]> = [["codeudorCreado", "CODEUDOR CREADO"], ["creditoCreado", "CRÉDITO CREADO"], ["numeroCreditoConfirmado", "NÚMERO DE CRÉDITO"]];

export default function SadminCreditTable({ onBack }: { onBack: () => void }) {
  const [filters, setFilters] = useState({ page: 1, query: "" });
  const [searchText, setSearchText] = useState("");
  const [data, setData] = useState<SadminPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [draftNumbers, setDraftNumbers] = useState<Record<number, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const pendingRequests = useRef(new Set<number>());
  const hasDrafts = Object.keys(draftNumbers).length > 0;
  const navigationBlocked = savingIds.size > 0 || hasDrafts;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ page: String(filters.page), q: filters.query });
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

  function editNumber(row: SadminCreditRow, value: string) {
    if (value === (row.sadmin.numeroCredito || "")) discardDraft(row.id);
    else setDraftNumbers(current => ({ ...current, [row.id]: value }));
  }

  async function save(row: SadminCreditRow, field: ChecklistField | "numeroCredito", value: boolean | string) {
    if (loading || error || pendingRequests.current.size > 0) return;
    pendingRequests.current.add(row.id);
    setSavingIds(new Set(pendingRequests.current));
    setRowErrors(current => ({ ...current, [row.id]: "" }));
    try {
      const response = await fetch(`/api/aprobaciones/sadmin/${row.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: row.sadmin.version, field, value }),
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
      setData(current => current ? { ...current, items: current.items.map(item => item.id === row.id ? { ...item, sadmin: saved } : item) } : current);
      if (field === "numeroCredito") discardDraft(row.id);
    } catch (cause) {
      setRowErrors(current => ({ ...current, [row.id]: cause instanceof SadminRequestError ? cause.message : "No pudimos guardar el cambio. Revisa tu conexión e intenta de nuevo." }));
    } finally {
      pendingRequests.current.delete(row.id);
      setSavingIds(new Set(pendingRequests.current));
    }
  }

  const page = data?.page || filters.page;
  const totalPages = Math.max(1, data?.totalPages || 1);

  return <main className={styles.main}>
    <PageHeader eyebrow="Control de creación" title="Creación en SADMIN" description="Todos los créditos de cartera desde el inicio de la operación, incluidos históricos y pagados. Los más recientes aparecen primero." actions={<Button variant="secondary" disabled={navigationBlocked} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />Volver a aprobaciones</Button>} />
    <Card className={styles.toolbar}>
      <form onSubmit={event => { event.preventDefault(); if (navigationBlocked || loading) return; setFilters({ page: 1, query: searchText.trim() }); }} className={styles.search}>
        <label className="sr-only" htmlFor="sadmin-search">Buscar por cliente, cédula, folio o número SADMIN</label>
        <Input id="sadmin-search" type="search" autoComplete="off" placeholder="Cliente, cédula, folio o número SADMIN" maxLength={100} value={searchText} disabled={navigationBlocked} onChange={event => setSearchText(event.target.value)} />
        <Button type="submit" variant="secondary" disabled={navigationBlocked || loading}><Search size={16} aria-hidden="true" />Buscar</Button>
        {filters.query ? <Button variant="ghost" disabled={navigationBlocked || loading} onClick={() => { setSearchText(""); setFilters({ page: 1, query: "" }); }}>Limpiar</Button> : null}
      </form>
      <Button variant="secondary" disabled={navigationBlocked || loading} onClick={() => setReload(current => current + 1)}><RefreshCw size={16} aria-hidden="true" />Actualizar</Button>
    </Card>
    <p className={styles.help}>Completa las tres verificaciones y guarda el número asignado para pasar a <strong>CREADO SADMIN</strong>. Cada verificación se guarda al marcarla.</p>
    {hasDrafts ? <p className={styles.notice} role="status">Tienes números sin guardar. Guárdalos o cancela su edición antes de cambiar de página o volver a aprobaciones.</p> : null}
    {error ? <Card className={styles.error} role="alert"><p>{error}</p><Button variant="secondary" disabled={loading || savingIds.size > 0} onClick={() => setReload(current => current + 1)}>Reintentar</Button></Card> : null}
    {loading ? <LoadingState label="Cargando créditos de cartera..." /> : null}
    {!loading && !error && data?.items.length === 0 ? <EmptyState title="No encontramos créditos" description={filters.query ? "Prueba con otro cliente, cédula, folio o número SADMIN." : "Los créditos aparecerán aquí cuando estén disponibles en cartera."} /> : null}
    {data?.items.length ? <>
      <div className={styles.summary}><span>{data.total.toLocaleString("es-CO")} créditos · 20 registros por página</span><span>Más recientes primero</span></div>
      <DataTable className={styles.tableWrap}>
        <table className={styles.table} aria-label="Créditos de cartera para creación en SADMIN" aria-busy={loading}>
          <thead><tr>{["Crédito", "Cliente", "Equipo y origen", "Valores del crédito", "Tasas", "Pagos", "Saldos", "Creación SADMIN"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{data.items.map(row => {
            const saving = savingIds.has(row.id);
            const dirty = Object.hasOwn(draftNumbers, row.id);
            const number = draftNumbers[row.id] ?? row.sadmin.numeroCredito ?? "";
            const disabled = savingIds.size > 0 || loading || Boolean(error);
            const completed = checklist.filter(([field]) => row.sadmin[field]).length;
            return <tr key={row.id}>
              <th scope="row" className={styles.credit}><strong>{row.folio}</strong><Facts items={[["Fecha crédito", date(row.fechaCredito)], ["Creado", date(row.createdAt, true)]]} /><Badge tone={row.sadmin.estado === "CREADO_SADMIN" ? "positive" : "neutral"}>{row.sadmin.estado === "CREADO_SADMIN" ? "CREADO SADMIN" : "PENDIENTE SADMIN"}</Badge></th>
              <td><strong>{text(row.clienteNombre)}</strong><Facts items={[["Cédula", text(row.clienteDocumento)], ["Teléfono", text(row.clienteTelefono)], ["Correo", text(row.clienteCorreo)], ["Dirección", text(row.clienteDireccion)], ["Nacimiento", date(row.clienteFechaNacimiento)], ["Género", text(row.clienteGenero)]]} /></td>
              <td><strong>{text(row.referenciaEquipo)}</strong><Facts items={[["IMEI", text(row.imei)], ["Aliado", text(row.aliadoNombre)], ["Sede", text(row.sedeNombre)]]} /></td>
              <td><Facts numeric items={[["Valor venta", amount(row.valorVenta)], ["Inicial", amount(row.cuotaInicial)], ["Crédito autorizado", amount(row.creditoAutorizado)], ["N.º cuotas", row.numeroCuotas], ["Valor cuota", amount(row.valorCuota)], ["Frecuencia", frequency(row.frecuenciaPago)]]} /></td>
              <td><Facts numeric items={[["Interés mensual efectivo", rate(row.interesMensual)], ["Fianza total del crédito", rate(row.fianza)], ["Seguro por cuota", rate(row.seguro)]]} /></td>
              <td><Facts numeric items={[["Próximo pago", date(row.fechaProximoPago)], ["Cuotas pagadas", row.cuotasPagadas], ["Cuotas pendientes", row.cuotasPendientes], ["Días vencidos", row.diasVencidos], ["Último pago", text(row.ultimoPago)]]} /></td>
              <td><Facts numeric items={[["Obligación", amount(row.saldoObligacion)], ["Capital", amount(row.saldoCapital)], ["Fianza", amount(row.saldoFianza)], ["Intereses", amount(row.saldoIntereses)]]} /></td>
              <td className={styles.registration}>
                <div className={styles.progress}><Badge tone={row.sadmin.estado === "CREADO_SADMIN" ? "positive" : "warning"}>{completed} de 3 verificaciones</Badge>{saving ? <span role="status">Guardando...</span> : null}</div>
                <fieldset disabled={disabled} aria-label={`Verificaciones SADMIN de ${row.folio}`}>
                  {checklist.slice(0, 2).map(([field, label]) => <label key={field} className={styles.check}><input type="checkbox" checked={row.sadmin[field]} onChange={event => void save(row, field, event.target.checked)} /><span>{label}</span></label>)}
                  <div className={styles.number}>
                    <label htmlFor={`sadmin-number-${row.id}`}>Número asignado en SADMIN</label>
                    <Input id={`sadmin-number-${row.id}`} type="text" autoComplete="off" maxLength={80} value={number} onChange={event => editNumber(row, event.target.value)} placeholder="Escribe el número" aria-describedby={`sadmin-number-help-${row.id}`} />
                    {dirty ? <div className={styles.numberActions}><Button variant="secondary" onClick={() => void save(row, "numeroCredito", number)}><Save size={14} aria-hidden="true" />Guardar número</Button><Button variant="ghost" onClick={() => discardDraft(row.id)}>Cancelar</Button></div> : null}
                    <p id={`sadmin-number-help-${row.id}`}>{dirty ? "Guarda el número y vuelve a marcar su verificación." : row.sadmin.numeroCredito ? "Número guardado." : "Guarda el número para verificarlo."}</p>
                  </div>
                  <label className={styles.check}><input type="checkbox" checked={!dirty && row.sadmin.numeroCreditoConfirmado} disabled={dirty || !row.sadmin.numeroCredito?.trim()} onChange={event => void save(row, "numeroCreditoConfirmado", event.target.checked)} /><span>NÚMERO DE CRÉDITO</span></label>
                </fieldset>
                {rowErrors[row.id] ? <p role="alert" className={styles.rowError}>{rowErrors[row.id]}</p> : null}
                {row.sadmin.completedAt ? <p className={styles.updated}>Completado: {date(row.sadmin.completedAt, true)}</p> : row.sadmin.updatedAt ? <p className={styles.updated}>Actualizado: {date(row.sadmin.updatedAt, true)}</p> : null}
              </td>
            </tr>;
          })}</tbody>
        </table>
      </DataTable>
    </> : null}
    {data ? <nav aria-label="Páginas de créditos SADMIN" className={styles.pagination}>
      <p aria-live="polite">Página {page} de {totalPages}{data.total ? ` · ${((page - 1) * data.pageSize + 1).toLocaleString("es-CO")}–${Math.min(page * data.pageSize, data.total).toLocaleString("es-CO")} de ${data.total.toLocaleString("es-CO")}` : ""}</p>
      <div><Button variant="secondary" disabled={navigationBlocked || loading || Boolean(error) || page <= 1} onClick={() => setFilters(current => ({ ...current, page: page - 1 }))}><ChevronLeft size={16} aria-hidden="true" />Anterior</Button><Button variant="secondary" disabled={navigationBlocked || loading || Boolean(error) || page >= totalPages} onClick={() => setFilters(current => ({ ...current, page: page + 1 }))}>Siguiente<ChevronRight size={16} aria-hidden="true" /></Button></div>
    </nav> : null}
  </main>;
}
