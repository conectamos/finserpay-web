"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Download, Eye, RefreshCw, X } from "lucide-react";
import {
  Badge, Button, Card, DataTable, EmptyState, Input, LoadingState,
  MetricCard, PageHeader, ProgressBar, Select, StatusPill,
} from "@/app/_components/finser-ui";
import type { CutFilters, CutReport, CutRow, CutStatus } from "@/lib/cut-collection-types";
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
function paramsFor(filters: CutFilters) {
  const params = new URLSearchParams({ day: String(filters.day), month: String(filters.month), year: String(filters.year), status: filters.status });
  if (filters.aliadoId) params.set("aliadoId", String(filters.aliadoId));
  if (filters.sedeId) params.set("sedeId", String(filters.sedeId));
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
        <span>Esperado<strong>{money(row.expected)}</strong></span>
        <span>Recibido total<strong>{money(row.received)}</strong></span>
        <span>Anticipos incluidos en recibido<strong>{money(row.priorPayments)}</strong></span>
        <span>Pendiente<strong>{money(row.pending)}</strong></span>
      </div>
      {(row.reconciledReceived || 0) > 0 && <p className={styles.reconciledPayment}>Efectivo conciliado por cuota (incluido en recibido): <strong>{money(row.reconciledReceived || 0)}</strong></p>}
      {row.payments.length ? <DataTable className={styles.table}><table>
        <caption>El valor aplicado corresponde a esta cuota; el total del pago puede incluir otras cuotas.</caption>
        <thead><tr><th>Pago</th><th>Fecha del pago</th><th>Registrado</th><th>Medio</th><th>Origen</th><th>Estado</th><th className={styles.number}>Valor del pago</th><th className={styles.number}>Aplicado a esta cuota</th></tr></thead>
        <tbody>{row.payments.map((payment) => <tr key={payment.id}>
          <td>#{payment.id}</td><td>{dateTime(payment.paidAt)}</td><td>{dateTime(payment.createdAt)}</td><td>{payment.method || "Sin medio"}</td>
          <td>{payment.previous ? "Antes del corte" : "Desde el corte"}</td>
          <td><Badge tone={payment.state.toUpperCase().includes("ANUL") ? "danger" : "neutral"}>{payment.state}</Badge></td>
          <td className={styles.number}>{money(payment.amount)}</td><td className={styles.number}>{money(payment.appliedNow)}</td>
        </tr>)}</tbody>
      </table></DataTable> : <EmptyState title={(row.reconciledReceived || 0) > 0 ? "Sin recibos con asignación individual" : row.sourcePayments?.length ? "Sin atribución individual de los abonos fuente" : "Esta cuota aún no tiene pagos"} description={(row.reconciledReceived || 0) > 0 ? "El efectivo conciliado por cuota está incluido en el recibido y se muestra por separado." : row.sourcePayments?.length ? "La conciliación registra el importe abonado a la cuota. Los abonos fuente del crédito se detallan a continuación." : "Los pagos aplicados a esta cuota aparecerán aquí, incluso cuando se reciban después del vencimiento."} />}
      {!!row.sourcePayments?.length && <section className={styles.sourcePayments} aria-labelledby="cut-source-payments-title">
        <h3 id="cut-source-payments-title">Abonos fuente de la conciliación</h3>
        <p>Estos abonos respaldan la conciliación de capital del crédito. Sus valores son los totales de cada abono y no equivalen al importe aplicado a esta cuota.</p>
        <DataTable className={styles.table}><table>
          <thead><tr><th>Abono</th><th>Fecha del pago</th><th>Registrado</th><th>Medio</th><th>Estado</th><th className={styles.number}>Valor del abono</th></tr></thead>
          <tbody>{row.sourcePayments.map((payment) => <tr key={payment.id}><td>#{payment.id}</td><td>{dateTime(payment.paidAt)}</td><td>{dateTime(payment.createdAt)}</td><td>{payment.method || "Sin medio"}</td><td>{payment.state}</td><td className={styles.number}>{money(payment.amount)}</td></tr>)}</tbody>
        </table></DataTable>
      </section>}
      <p className={styles.note}>El recibido incluye todos los pagos vigentes aplicados a esta cuota, antes, durante o después del vencimiento. Los anticipos son parte de ese total y no se suman de nuevo. Horas de Colombia.</p>
      {(row.unclassifiedReceived || 0) > 0 && <p className={styles.notice}>{money(row.unclassifiedReceived || 0)} del recibido está conciliado por cuota, pero no permite separar su fecha individual; no se clasifica como anticipo.</p>}
      {row.warning && <p className={styles.notice}>{row.warning}</p>}
    </>}
  </dialog>;
}

export default function RecaudoPorCorteClient({ initialFilters }: { initialFilters: CutFilters }) {
  const [draft, setDraft] = useState(initialFilters);
  const [selection, setSelection] = useState(initialFilters);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; report: CutReport | null; error: string | null }>({ key: "", report: null, error: null });
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<CutRow | null>(null);
  const query = paramsFor(selection).toString();
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

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSelection(draft);
    setReload((value) => value + 1);
    setSelectedRow(null);
    setActionError(null);
    window.history.replaceState(null, "", `${window.location.pathname}?${paramsFor(draft)}`);
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

  const summary = visibleReport?.summary;

  return <div className={styles.content}>
    <nav className={styles.breadcrumb} aria-label="Ruta actual"><Link href="/dashboard"><ArrowLeft aria-hidden="true" />Inicio</Link><span aria-hidden="true">/</span><span>Cartera</span><span aria-hidden="true">/</span><strong aria-current="page">Recaudo por corte</strong></nav>
    <PageHeader
      className={styles.heading}
      eyebrow="CARTERA"
      title="Recaudo por corte"
      description="Consulta los créditos que debían pagar en una fecha de corte y compara lo esperado con lo recibido."
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
          <p>Solo cuotas con vencimiento en la fecha seleccionada. Fechas y horas de Colombia.</p>
          <div className={styles.actions}><Button type="submit" disabled={loading}>Consultar corte</Button><Button variant="ghost" aria-label="Actualizar recaudo" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw aria-hidden="true" />Actualizar</Button></div>
        </div>
      </form>
    </Card>

    {(error || actionError) && <div className={styles.error} role="alert"><p>{error || actionError}</p>{error && <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar consulta</Button>}</div>}
    {loading && <LoadingState label="Consultando cronogramas y pagos…" />}

    {visibleReport && summary && <>
      <Card className={styles.cutSummary}>
        <div>
          <h2>Corte del {dateLabel(visibleReport.cutDate)}</h2>
          <p>Consulta actualizada al {dateTime(visibleReport.asOf)} (Colombia).</p>
        </div>
      </Card>

      {visibleReport.warnings.length > 0 && <div className={styles.notice} role="status">{visibleReport.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}

      <section className={styles.metrics} aria-label="Indicadores del corte con los filtros aplicados">
        <MetricCard className={styles.metric} label="Créditos del corte" value={summary.creditsCount.toLocaleString("es-CO")} detail="Créditos únicos con cuotas en esta fecha" />
        <MetricCard className={styles.metric} label="Recaudo esperado" value={money(summary.expected)} detail="Valor total de las cuotas del corte" />
        <MetricCard className={styles.metric} label="Recaudo recibido" value={money(summary.received)} detail="Todo lo aplicado, incluidos anticipos" />
        <MetricCard className={styles.metric} label="Pendiente por recaudar" value={money(summary.pending)} detail="Esperado menos recibido" />
        <MetricCard className={styles.metric} label="Cumplimiento" value={percentage(summary.completion)} detail={summary.completion === null ? "El esperado es cero" : "Recibido / esperado"}>{summary.completion !== null && <ProgressBar value={summary.completion} label="Cumplimiento del recaudo esperado" />}</MetricCard>
        <MetricCard className={styles.metric} label="Clientes pendientes" value={summary.pendingClients.toLocaleString("es-CO")} detail="Clientes únicos con saldo en el corte" />
      </section>

      <Card className={styles.separate}>
        <div><span>Anticipos incluidos en recibido</span><strong>{money(summary.priorPayments)}</strong><p>Pagos identificados antes de las 00:00 del día del corte en Colombia y aplicados a estas cuotas. Ya forman parte del recibido; no se suman de nuevo.</p></div>
        <div><span>Recuperación de cuotas anteriores</span><strong>{money(summary.previousRecovery)}</strong><p>Pagos desde el inicio del corte aplicados a vencimientos anteriores de estos créditos. No se incluyen en el recibido del corte.</p></div>
        <div><span>Anticipos de cuotas futuras</span><strong>{money(summary.futureAdvances)}</strong><p>Pagos desde el inicio del corte aplicados a vencimientos futuros de estos créditos. No se incluyen en el recibido del corte.</p></div>
      </Card>
      {(summary.unclassifiedReceived || 0) > 0 && <p className={styles.notice}>{money(summary.unclassifiedReceived || 0)} del recibido está conciliado por cuota, pero no permite separar su fecha individual; no se clasifica como anticipo.</p>}

      <section className={styles.section} aria-labelledby="cut-detail-title">
        <header className={styles.sectionHeading}>
          <div><h2 id="cut-detail-title">Detalle de cuotas</h2><p>{visibleReport.rows.length.toLocaleString("es-CO")} cuotas · Las tarjetas y el total de la tabla usan los mismos filtros.</p></div>
          <Button variant="secondary" onClick={exportExcel} disabled={exporting || !visibleReport.rows.length}><Download aria-hidden="true" />{exporting ? "Generando Excel…" : "Exportar a Excel"}</Button>
        </header>
        {visibleReport.rows.length ? <DataTable className={styles.table}><table>
          <caption className={styles.visuallyHidden}>Cuotas con vencimiento en el corte del {dateLabel(visibleReport.cutDate)} y sus pagos aplicados</caption>
          <thead><tr><th scope="col">Cliente</th><th scope="col">Cédula</th><th scope="col">Crédito</th><th scope="col">Aliado</th><th scope="col">Sede</th><th scope="col">Vencimiento</th><th scope="col" className={styles.number}>Valor de cuota</th><th scope="col" className={styles.number}>Anticipos incluidos</th><th scope="col" className={styles.number}>Esperado</th><th scope="col" className={styles.number}>Recibido</th><th scope="col" className={styles.number}>Pendiente</th><th scope="col">Último pago</th><th scope="col">Estado</th><th scope="col">Detalle</th></tr></thead>
          <tbody>{visibleReport.rows.map((row) => <tr key={row.key}>
            <td className={styles.identity}><strong>{row.clientName}</strong>{row.warning && <small>{row.warning}</small>}</td><td>{row.document}</td><td>{row.folio}<br /><small>Cuota {row.installment}</small></td><td>{row.aliado}</td><td>{row.sede}</td><td>{dateLabel(row.dueDate)}</td>
            <td className={styles.number}>{money(row.installmentAmount)}</td><td className={styles.number}>{money(row.priorPayments)}</td><td className={styles.number}>{money(row.expected)}</td><td className={styles.number}>{money(row.received)}</td><td className={styles.number}>{money(row.pending)}</td><td>{!row.lastPaymentAt && row.reconciledReceived ? "Sin fecha individual" : dateTime(row.lastPaymentAt)}</td>
            <td><StatusPill tone={row.status === "pagado" ? "positive" : row.status === "parcial" ? "warning" : "neutral"}>{STATUS_LABELS[row.status]}</StatusPill></td><td><Button variant="ghost" aria-label={`Ver pagos de ${row.clientName}, crédito ${row.folio}, cuota ${row.installment}`} onClick={() => setSelectedRow(row)}><Eye aria-hidden="true" />Ver pagos</Button></td>
          </tr>)}</tbody>
          <tfoot><tr><td colSpan={6}>Total de las cuotas filtradas</td><td className={styles.number}>{money(visibleReport.rows.reduce((total, row) => total + row.installmentAmount, 0))}</td><td className={styles.number}>{money(summary.priorPayments)}</td><td className={styles.number}>{money(summary.expected)}</td><td className={styles.number}>{money(summary.received)}</td><td className={styles.number}>{money(summary.pending)}</td><td colSpan={3} /></tr></tfoot>
        </table></DataTable> : <EmptyState title="No hay cuotas con estos filtros" description="Selecciona otro corte, aliado, sede o estado para consultar sus créditos y pagos." />}
        <p className={styles.note}>El recibido incluye anticipos y pagos posteriores aplicados a estas cuotas, con anulaciones y reversos reflejados. Pendiente = esperado − recibido, sin saldos negativos.</p>
      </section>
    </>}
    <PaymentDetail row={selectedRow} onClose={() => setSelectedRow(null)} />
  </div>;
}
