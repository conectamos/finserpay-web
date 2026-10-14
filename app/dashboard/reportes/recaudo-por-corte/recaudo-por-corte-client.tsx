"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Download, Eye, RefreshCw, Save, X } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge, Button, Card, DataTable, EmptyState, Input, LoadingState,
  MetricCard, PageHeader, ProgressBar, Select, StatusPill,
} from "@/app/_components/finser-ui";
import type { CutFilters, CutHistory, CutReport, CutRow, CutStatus } from "@/lib/cut-collection-types";
import styles from "./recaudo-por-corte.module.css";

const API = "/api/reportes/recaudo-por-corte";
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const STATUS_LABELS = { pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };
const moneyFormatter = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const numberFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Bogota" });
const dateTimeFormatter = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Bogota" });

function money(value: number) { return moneyFormatter.format(value); }
function percentage(value: number | null) { return value === null ? "No aplica" : `${numberFormatter.format(value)} %`; }
function dateLabel(value: string) { return dateFormatter.format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value)); }
function dateTime(value: string | null) { return value ? dateTimeFormatter.format(new Date(value)) : "Sin pagos"; }
function paramsFor(filters: CutFilters, projectionId: string | null) {
  const params = new URLSearchParams({ day: String(filters.day), month: String(filters.month), year: String(filters.year), status: filters.status });
  if (filters.aliadoId) params.set("aliadoId", String(filters.aliadoId));
  if (filters.sedeId) params.set("sedeId", String(filters.sedeId));
  if (projectionId) params.set("projectionId", projectionId);
  return params;
}

async function readReport(response: Response): Promise<CutReport> {
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || payload?.message || "No fue posible consultar el recaudo por corte.");
  }
  return payload as CutReport;
}

function PaymentDetail({ row, onClose }: { row: CutRow | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (row && !dialog.current?.open) dialog.current?.showModal();
    if (!row && dialog.current?.open) dialog.current?.close();
  }, [row]);

  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="cut-payments-title" onCancel={onClose} onClose={onClose}>
    {row && <>
      <header>
        <div><h2 id="cut-payments-title">Pagos de la cuota {row.installment}</h2><p>{row.clientName} · Crédito {row.folio} · Vence {dateLabel(row.dueDate)}</p></div>
        <Button variant="ghost" onClick={onClose} aria-label="Cerrar detalle de pagos" autoFocus><X aria-hidden="true" /></Button>
      </header>
      <div className={styles.dialogTotals}>
        <span>Anticipos al guardar<strong>{money(row.priorPayments)}</strong></span>
        <span>Esperado<strong>{money(row.expected)}</strong></span>
        <span>Recibido posterior<strong>{money(row.received)}</strong></span>
        <span>Ajuste de anticipos<strong>{money(row.priorReversals)}</strong></span>
        <span>Pendiente<strong>{money(row.pending)}</strong></span>
      </div>
      {row.payments.length ? <DataTable className={styles.table}><table>
        <caption>Las columnas de aplicación y recaudo corresponden a esta cuota.</caption>
        <thead><tr><th>Pago</th><th>Fecha del pago</th><th>Registrado</th><th>Medio</th><th>Origen</th><th>Estado</th><th className={styles.number}>Valor del pago</th><th className={styles.number}>Aplicado al guardar</th><th className={styles.number}>Aplicado actual</th><th className={styles.number}>Recaudo del corte</th></tr></thead>
        <tbody>{row.payments.map((payment) => <tr key={payment.id}>
          <td>#{payment.id}</td><td>{dateTime(payment.paidAt)}</td><td>{dateTime(payment.createdAt)}</td><td>{payment.method || "Sin medio"}</td>
          <td>{payment.previous ? "Anticipo previo" : "Pago posterior"}</td>
          <td><Badge tone={payment.state.toUpperCase().includes("ANUL") ? "danger" : "neutral"}>{payment.state}</Badge></td>
          <td className={styles.number}>{money(payment.amount)}</td><td className={styles.number}>{money(payment.appliedBefore)}</td><td className={styles.number}>{money(payment.appliedNow)}</td><td className={styles.number}>{money(payment.received)}</td>
        </tr>)}</tbody>
      </table></DataTable> : <EmptyState title={row.sourcePayments?.length ? "Sin atribución individual de los abonos fuente" : "Esta cuota aún no tiene pagos"} description={row.sourcePayments?.length ? "La conciliación registra el importe abonado a la cuota. Los abonos fuente del crédito se detallan a continuación." : "Los pagos aplicados a esta cuota aparecerán aquí, incluso cuando se reciban después del vencimiento."} />}
      {!!row.sourcePayments?.length && <section className={styles.sourcePayments} aria-labelledby="cut-source-payments-title">
        <h3 id="cut-source-payments-title">Abonos fuente de la conciliación</h3>
        <p>Estos abonos respaldan la conciliación de capital del crédito. Sus valores son los totales de cada abono y no equivalen al importe aplicado a esta cuota.</p>
        <DataTable className={styles.table}><table>
          <thead><tr><th>Abono</th><th>Fecha del pago</th><th>Registrado</th><th>Medio</th><th>Estado</th><th className={styles.number}>Valor del abono</th></tr></thead>
          <tbody>{row.sourcePayments.map((payment) => <tr key={payment.id}><td>#{payment.id}</td><td>{dateTime(payment.paidAt)}</td><td>{dateTime(payment.createdAt)}</td><td>{payment.method || "Sin medio"}</td><td>{payment.state}</td><td className={styles.number}>{money(payment.amount)}</td></tr>)}</tbody>
        </table></DataTable>
      </section>}
      <p className={styles.note}>El recaudo usa pagos registrados después de guardar la proyección y su aplicación vigente a esta cuota. Las anulaciones y los ajustes de anticipos se reflejan por separado. Horas de Colombia.</p>
      {row.warning && <p className={styles.notice}>{row.warning}</p>}
    </>}
  </dialog>;
}

export default function RecaudoPorCorteClient({ initialFilters, initialProjectionId }: { initialFilters: CutFilters; initialProjectionId: string | null }) {
  const [draft, setDraft] = useState(initialFilters);
  const [selection, setSelection] = useState({ filters: initialFilters, projectionId: initialProjectionId });
  const [reload, setReload] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [result, setResult] = useState<{ key: string; report: CutReport | null; error: string | null }>({ key: "", report: null, error: null });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<CutRow | null>(null);
  const saveAttempt = useRef<{ signature: string; key: string } | null>(null);
  const queryParams = paramsFor(selection.filters, selection.projectionId);
  queryParams.set("historyPage", String(historyPage));
  const query = queryParams.toString();
  const fetchKey = `${query}#${reload}`;
  const loading = result.key !== fetchKey;
  const report = result.report;
  const error = loading ? null : result.error;
  const visibleReport = !loading && !error ? report : null;
  const visibleSedes = report?.options.sedes.filter((sede) => !draft.aliadoId || sede.aliadoId === draft.aliadoId) || [];

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(readReport)
      .then((data) => { if (!controller.signal.aborted) setResult({ key: fetchKey, report: data, error: null }); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setResult((previous) => ({ key: fetchKey, report: previous.report, error: cause instanceof Error ? cause.message : "No fue posible consultar el recaudo por corte." }));
      });
    return () => controller.abort();
  }, [fetchKey, query]);

  function select(filters: CutFilters, projectionId: string | null) {
    setDraft(filters);
    setSelection({ filters, projectionId });
    setHistoryPage(0);
    setSelectedRow(null);
    setActionError(null);
    setSuccess(null);
    window.history.replaceState(null, "", `${window.location.pathname}?${paramsFor(filters, projectionId)}`);
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sameCut = draft.day === selection.filters.day && draft.month === selection.filters.month && draft.year === selection.filters.year;
    select(draft, sameCut ? selection.projectionId : null);
  }

  function selectProjection(id: string) {
    const item = report?.history.find((entry) => entry.id === id);
    if (!item) { select(selection.filters, null); return; }
    const [year, month, day] = item.cutDate.split("-").map(Number);
    select({ ...selection.filters, day: day as 2 | 17, month, year }, id);
  }

  async function saveProjection() {
    if (saving || !visibleReport || visibleReport.projection) return;
    setSaving(true);
    setActionError(null);
    const signature = JSON.stringify(selection.filters);
    if (saveAttempt.current?.signature !== signature) saveAttempt.current = { signature, key: crypto.randomUUID() };
    try {
      const response = await fetch(API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection.filters, requestKey: saveAttempt.current.key }),
      });
      const saved = await readReport(response);
      if (!saved.projection) throw new Error("La respuesta no confirmó la proyección guardada. Vuelve a intentar.");
      select(saved.filters, saved.projection.id);
      setSuccess(`Proyección guardada el ${dateTime(saved.projection.createdAt)} (Colombia). Las versiones anteriores se conservan.`);
      saveAttempt.current = null;
      setConfirming(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "No fue posible guardar la proyección.");
      setConfirming(false);
    } finally { setSaving(false); }
  }

  async function exportExcel() {
    if (!visibleReport || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const response = await fetch(`${API}?${query}&format=xlsx`, { cache: "no-store" });
      if (!response.ok) { await readReport(response); return; }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `recaudo-por-corte-${visibleReport.cutDate}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "No fue posible exportar el archivo de Excel.");
    } finally { setExporting(false); }
  }

  const history = report?.history || [];
  const summary = visibleReport?.summary;

  return <div className={styles.content}>
    <nav className={styles.breadcrumb} aria-label="Ruta actual"><Link href="/dashboard"><ArrowLeft aria-hidden="true" />Inicio</Link><span aria-hidden="true">/</span><span>Cartera</span><span aria-hidden="true">/</span><strong aria-current="page">Recaudo por corte</strong></nav>
    <PageHeader
      className={styles.heading}
      eyebrow="CARTERA"
      title="Recaudo por corte"
      description="Compara lo esperado de las cuotas de un corte con los pagos aplicados a ellas."
      actions={visibleReport?.projection
        ? <Button onClick={() => select(selection.filters, null)} disabled={saving}><Save aria-hidden="true" />Preparar nueva proyección</Button>
        : <Button onClick={() => setConfirming(true)} disabled={loading || saving || !visibleReport?.rows.length}><Save aria-hidden="true" />Guardar proyección</Button>}
    />

    <Card className={styles.filters}>
      <form onSubmit={applyFilters}>
        <div className={styles.filterFields}>
          <label className={styles.field}>Corte<Select value={draft.day} onChange={(event) => setDraft({ ...draft, day: Number(event.target.value) as 2 | 17 })}><option value="2">02</option><option value="17">17</option></Select></label>
          <label className={styles.field}>Mes<Select value={draft.month} onChange={(event) => setDraft({ ...draft, month: Number(event.target.value) })}>{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</Select></label>
          <label className={styles.field}>Año<Input type="number" min="2000" max="2200" required value={draft.year || ""} onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })} /></label>
          <label className={styles.field}>Aliado<Select value={draft.aliadoId || ""} onChange={(event) => setDraft({ ...draft, aliadoId: Number(event.target.value) || null, sedeId: null })}><option value="">Todos los autorizados</option>{report?.options.aliados.map((ally) => <option key={ally.id} value={ally.id}>{ally.nombre}</option>)}</Select></label>
          <label className={styles.field}>Sede<Select value={draft.sedeId || ""} onChange={(event) => setDraft({ ...draft, sedeId: Number(event.target.value) || null })}><option value="">Todas las autorizadas</option>{visibleSedes.map((sede) => <option key={sede.id} value={sede.id}>{sede.nombre}</option>)}</Select></label>
          <label className={styles.field}>Estado<Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CutStatus })}><option value="todos">Todos</option><option value="pendiente">Pendiente</option><option value="parcial">Parcial</option><option value="pagado">Pagado</option></Select></label>
        </div>
        <div className={styles.filterFooter}>
          <p>Fechas y horas de Colombia. El estado filtra la consulta; al guardar se incluyen todas las cuotas del aliado y la sede seleccionados.</p>
          <div className={styles.actions}><Button variant="secondary" type="submit" disabled={saving}>Aplicar filtros</Button><Button variant="ghost" aria-label="Actualizar recaudo" onClick={() => setReload((value) => value + 1)} disabled={loading || saving}><RefreshCw aria-hidden="true" />Actualizar</Button></div>
        </div>
      </form>
    </Card>

    {(error || actionError) && <div className={styles.error} role="alert"><p>{error || actionError}</p>{error && <div className={styles.actions}><Button variant="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar consulta</Button>{selection.projectionId && <Button variant="secondary" onClick={() => select(selection.filters, null)}>Volver a vista previa</Button>}</div>}</div>}
    {success && <p className={styles.success} role="status">{success}</p>}
    {loading && <LoadingState label="Consultando cronogramas, pagos y proyecciones…" />}

    {visibleReport && summary && <>
      <Card className={styles.projection}>
        <div>
          <div className={styles.projectionHeading}><h2>Corte del {dateLabel(visibleReport.cutDate)}</h2><Badge tone={visibleReport.projection ? "positive" : "warning"}>{visibleReport.projection ? "Proyección guardada" : "Vista previa"}</Badge></div>
          <p>{visibleReport.projection ? `Esperado fijado el ${dateTime(visibleReport.projection.createdAt)}.` : "El esperado muestra el saldo actual. Guarda la proyección para iniciar la medición del recaudo posterior."}<br />Recaudo consultado al {dateTime(visibleReport.asOf)}.</p>
        </div>
        <label className={styles.field}>Proyección consultada<Select value={visibleReport.projection?.id || ""} onChange={(event) => selectProjection(event.target.value)}><option value="">Vista previa · saldo actual</option>{visibleReport.projection && !history.some((item) => item.id === visibleReport.projection?.id) && <option value={visibleReport.projection.id}>{dateLabel(visibleReport.cutDate)} · guardada {dateTime(visibleReport.projection.createdAt)}</option>}{history.map((item) => <option key={item.id} value={item.id}>{dateLabel(item.cutDate)} · guardada {dateTime(item.createdAt)}</option>)}</Select></label>
      </Card>

      {visibleReport.warnings.length > 0 && <div className={styles.notice} role="status">{visibleReport.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}

      <section className={styles.metrics} aria-label="Indicadores del corte con los filtros aplicados">
        <MetricCard className={styles.metric} label="Recaudo esperado" value={money(summary.expected)} detail={visibleReport.projection ? "Saldo fijado al guardar" : "Saldo actual por proyectar"} />
        <MetricCard className={styles.metric} label="Recaudo recibido" value={money(summary.received)} detail="Pagos posteriores aplicados al corte" />
        <MetricCard className={styles.metric} label="Pendiente por recaudar" value={money(summary.pending)} detail="Incluye ajustes de anticipos" />
        <MetricCard className={styles.metric} label="Cumplimiento" value={percentage(summary.completion)} detail={summary.completion === null ? "El esperado es cero" : "Recibido / esperado"}>{summary.completion !== null && <ProgressBar value={summary.completion} label="Cumplimiento del recaudo esperado" />}</MetricCard>
        <MetricCard className={styles.metric} label="Clientes pendientes" value={summary.pendingClients.toLocaleString("es-CO")} detail="Clientes únicos con saldo en el corte" />
      </section>

      <Card className={styles.separate}>
        <div><span>Anticipos previos del corte</span><strong>{money(summary.priorPayments)}</strong><p>Ya aplicados al guardar. Se separan del recaudo posterior contra el esperado.</p></div>
        <div><span>Recuperación de cuotas anteriores</span><strong>{money(summary.previousRecovery)}</strong><p>Pagos posteriores aplicados a vencimientos anteriores, en los créditos incluidos en esta consulta.</p></div>
        <div><span>Anticipos de cuotas futuras</span><strong>{money(summary.futureAdvances)}</strong><p>Pagos posteriores aplicados a vencimientos futuros, en los créditos incluidos en esta consulta.</p></div>
      </Card>
      {summary.priorReversals !== 0 && <p className={styles.notice}>Ajuste neto de anticipos previos: <strong>{money(summary.priorReversals)}</strong>. Los reversos o cambios de aplicación modifican el pendiente; el esperado guardado se conserva.</p>}

      <section className={styles.section} aria-labelledby="cut-detail-title">
        <header className={styles.sectionHeading}>
          <div><h2 id="cut-detail-title">Detalle de cuotas</h2><p>{visibleReport.rows.length.toLocaleString("es-CO")} cuotas · Las tarjetas y el total de la tabla usan los mismos filtros.</p></div>
          <Button variant="secondary" onClick={exportExcel} disabled={exporting || !visibleReport.rows.length}><Download aria-hidden="true" />{exporting ? "Generando Excel…" : "Exportar a Excel"}</Button>
        </header>
        {visibleReport.rows.length ? <DataTable className={styles.table}><table>
          <caption className={styles.visuallyHidden}>Cuotas con vencimiento en el corte del {dateLabel(visibleReport.cutDate)} y sus pagos aplicados</caption>
          <thead><tr><th scope="col">Cliente</th><th scope="col">Cédula</th><th scope="col">Crédito</th><th scope="col">Aliado</th><th scope="col">Sede</th><th scope="col">Vencimiento</th><th scope="col" className={styles.number}>Valor de cuota</th><th scope="col" className={styles.number}>Anticipos previos</th><th scope="col" className={styles.number}>Esperado</th><th scope="col" className={styles.number}>Recibido</th><th scope="col" className={styles.number}>Ajuste anticipos</th><th scope="col" className={styles.number}>Pendiente</th><th scope="col">Último pago</th><th scope="col">Estado</th><th scope="col">Detalle</th></tr></thead>
          <tbody>{visibleReport.rows.map((row) => <tr key={row.key}>
            <td className={styles.identity}><strong>{row.clientName}</strong>{row.warning && <small>{row.warning}</small>}</td><td>{row.document}</td><td>{row.folio}<br /><small>Cuota {row.installment}</small></td><td>{row.aliado}</td><td>{row.sede}</td><td>{dateLabel(row.dueDate)}</td>
            <td className={styles.number}>{money(row.installmentAmount)}</td><td className={styles.number}>{money(row.priorPayments)}</td><td className={styles.number}>{money(row.expected)}</td><td className={styles.number}>{money(row.received)}</td><td className={styles.number}>{money(row.priorReversals)}</td><td className={styles.number}>{money(row.pending)}</td><td>{dateTime(row.lastPaymentAt)}</td>
            <td><StatusPill tone={row.status === "pagado" ? "positive" : row.status === "parcial" ? "warning" : "neutral"}>{STATUS_LABELS[row.status]}</StatusPill></td><td><Button variant="ghost" aria-label={`Ver pagos de ${row.clientName}, crédito ${row.folio}, cuota ${row.installment}`} onClick={() => setSelectedRow(row)}><Eye aria-hidden="true" />Ver pagos</Button></td>
          </tr>)}</tbody>
          <tfoot><tr><td colSpan={6}>Total de las cuotas filtradas</td><td className={styles.number}>{money(visibleReport.rows.reduce((total, row) => total + row.installmentAmount, 0))}</td><td className={styles.number}>{money(summary.priorPayments)}</td><td className={styles.number}>{money(summary.expected)}</td><td className={styles.number}>{money(summary.received)}</td><td className={styles.number}>{money(summary.priorReversals)}</td><td className={styles.number}>{money(summary.pending)}</td><td colSpan={3} /></tr></tfoot>
        </table></DataTable> : <EmptyState title="No hay cuotas con estos filtros" description="Selecciona otro corte, aliado, sede o estado. Las proyecciones guardadas siguen disponibles en el historial." />}
        <p className={styles.note}>El recibido sigue los pagos aplicados a las cuotas de esta proyección, también después de su vencimiento. Pendiente = esperado − recibido + ajuste de anticipos, sin saldos negativos.</p>
      </section>

      <Card className={styles.history}><details open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>Historial y comparación de proyecciones</summary>
        <p>Cada guardado crea una versión independiente. Los importes se muestran con los filtros de aliado, sede y estado de esta consulta.</p>
        {history.length ? <DataTable className={styles.table}><table>
          <thead><tr><th>Corte</th><th>Guardada (Colombia)</th><th className={styles.number}>Cuotas</th><th className={styles.number}>Esperado</th><th className={styles.number}>Recibido actual</th><th className={styles.number}>Pendiente</th><th className={styles.number}>Cumplimiento</th><th>Consulta</th></tr></thead>
          <tbody>{history.map((item: CutHistory) => <tr key={item.id}><td className={item.warning ? styles.identity : undefined}>{dateLabel(item.cutDate)}{item.warning && <small>{item.warning}</small>}</td><td>{dateTime(item.createdAt)}</td><td className={styles.number}>{item.rowCount ?? "—"}</td><td className={styles.number}>{item.expected === null ? "—" : money(item.expected)}</td><td className={styles.number}>{item.received === null ? "—" : money(item.received)}</td><td className={styles.number}>{item.pending === null ? "—" : money(item.pending)}</td><td className={styles.number}>{item.warning ? "—" : percentage(item.completion)}</td><td><Button variant="ghost" onClick={() => selectProjection(item.id)} disabled={item.id === visibleReport.projection?.id}>{item.id === visibleReport.projection?.id ? "En consulta" : "Consultar"}</Button></td></tr>)}</tbody>
        </table></DataTable> : <EmptyState title={historyPage ? "No hay proyecciones en esta página" : "Aún no hay proyecciones guardadas"} description={historyPage ? "Usa la navegación del historial para consultar otras versiones." : "Guarda la primera proyección para conservar su esperado y comparar el recaudo de este corte."} />}
        {(historyPage > 0 || visibleReport.historyHasMore) && <div className={styles.historyPagination}>
          <span>Página {visibleReport.historyPage + 1}</span>
          <div className={styles.actions}><Button variant="secondary" disabled={historyPage === 0} onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}>Anterior</Button><Button variant="secondary" disabled={!visibleReport.historyHasMore} onClick={() => setHistoryPage((page) => page + 1)}>Siguiente</Button></div>
        </div>}
      </details></Card>
    </>}

    <ConfirmDialog open={confirming} title="Guardar proyección del corte" description="Se fijará el saldo pendiente de todas las cuotas del corte para el aliado y la sede seleccionados, con fecha y hora de Colombia. El filtro de estado solo afecta la consulta. Se creará una nueva versión y se conservarán las anteriores. Esta acción no cambia créditos ni pagos." confirmLabel="Guardar proyección" busy={saving} onCancel={() => { if (!saving) setConfirming(false); }} onConfirm={saveProjection} />
    <PaymentDetail row={selectedRow} onClose={() => setSelectedRow(null)} />
  </div>;
}
