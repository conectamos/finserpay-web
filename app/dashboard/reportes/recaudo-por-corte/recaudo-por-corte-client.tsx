"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, CalendarDays, Clock3, Download, Mail, MessageCircle, RefreshCw, X } from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge, Button, Card, DataTable, EmptyState, Input, LoadingState,
  PageHeader, ProgressBar, Select,
} from "@/app/_components/finser-ui";
import type { CutFilters, CutReport, CutRow, CutStatus } from "@/lib/cut-collection-types";
import CutInstallmentDetail from "./cut-installment-detail";
import CutRiskComparison from "./cut-risk-comparison";
import riskStyles from "./cut-early-risk.module.css";
import styles from "./recaudo-por-corte.module.css";

const API = "/api/reportes/recaudo-por-corte";
const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const STATUS_LABELS = { todos: "Todos", pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };
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

type PreparedReportPdf = { blob: Blob; filename: string };

function saveReportPdf(pdf: PreparedReportPdf) {
  const url = URL.createObjectURL(pdf.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = pdf.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CutReportActions({ report, riskCuts, disabled }: { report: CutReport; riskCuts: string[]; disabled: boolean }) {
  const [busy, setBusy] = useState<"pdf" | "whatsapp" | "email" | null>(null);
  const busyRef = useRef(false);
  const pdfRef = useRef<PreparedReportPdf | null>(null);
  const emailRequestKey = useRef<string | null>(null);
  const whatsappRequestKey = useRef<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "info" | "success" | "error"; message: string } | null>(null);
  const ally = report.options.aliados.find(item => item.id === report.filters.aliadoId)?.nombre;
  const site = report.options.sedes.find(item => item.id === report.filters.sedeId)?.nombre ?? "Todas las autorizadas";
  const params = paramsFor(report.filters);
  params.set("riskCuts", riskCuts.join(","));
  const query = params.toString();

  async function preparePdf() {
    if (pdfRef.current) return pdfRef.current;
    const response = await fetch(`${API}?${query}&format=pdf`, { cache: "no-store" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || payload?.message || "No fue posible generar el informe PDF.");
    }
    const blob = await response.blob();
    if (!blob.size || !blob.type.toLowerCase().startsWith("application/pdf")) {
      throw new Error("El servidor no devolvió un informe PDF válido. Vuelve a intentarlo.");
    }
    const chronologicalCuts = [...riskCuts].sort();
    const filename = `FINSERPAY_Riesgo_${chronologicalCuts[0]}${chronologicalCuts.length > 1 ? `_a_${chronologicalCuts.at(-1)}` : ""}.pdf`;
    pdfRef.current = { blob, filename };
    return pdfRef.current;
  }

  async function downloadPdf() {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy("pdf");
    setFeedback(null);
    try {
      saveReportPdf(await preparePdf());
      setFeedback({ kind: "success", message: "Informe PDF descargado con los filtros consultados." });
    } catch (cause) {
      setFeedback({ kind: "error", message: cause instanceof Error ? cause.message : "No fue posible descargar el informe PDF." });
    } finally { busyRef.current = false; setBusy(null); }
  }

  async function sendWhatsApp() {
    if (disabled || !report.filters.aliadoId || !ally || busyRef.current) return;
    busyRef.current = true;
    setBusy("whatsapp");
    setFeedback(null);
    try {
      whatsappRequestKey.current ??= crypto.randomUUID();
      const response = await fetch(`${API}?${query}&action=whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": whatsappRequestKey.current },
        cache: "no-store",
      }).catch(() => { throw new Error("No fue posible confirmar el envío por WhatsApp. Verifica si llegó antes de repetirlo."); });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true || typeof payload.recipient !== "string") {
        if (response.status === 502 && payload?.retryWithNewKey === true) whatsappRequestKey.current = null;
        throw new Error(payload?.error || payload?.message || "No fue posible confirmar el envío por WhatsApp. Verifica si llegó antes de repetirlo.");
      }
      whatsappRequestKey.current = null;
      setFeedback({ kind: "success", message: `Envío por WhatsApp aceptado para ${payload.recipient}, número registrado de ${ally}.` });
    } catch (cause) {
      setFeedback({ kind: "error", message: cause instanceof Error ? cause.message : "No fue posible confirmar el envío por WhatsApp. Verifica si llegó antes de repetirlo." });
    } finally { busyRef.current = false; setBusy(null); }
  }

  async function sendEmail() {
    if (disabled || !confirmEmail || !report.filters.aliadoId || !ally || busyRef.current) return;
    busyRef.current = true;
    setBusy("email");
    setFeedback(null);
    try {
      // Keep the same key for a retry if the previous response was inconclusive.
      emailRequestKey.current ??= crypto.randomUUID();
      const response = await fetch(`${API}?${query}&action=email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": emailRequestKey.current },
        cache: "no-store",
      }).catch(() => { throw new Error("No fue posible confirmar el envío. Verifica si llegó antes de repetirlo."); });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true || typeof payload.recipient !== "string") {
        throw new Error(payload?.error || payload?.message || "No fue posible confirmar el envío. Verifica si llegó antes de repetirlo.");
      }
      emailRequestKey.current = null;
      setFeedback({ kind: "success", message: `Informe enviado a ${payload.recipient}, dirección registrada de ${ally}.` });
    } catch (cause) {
      setFeedback({ kind: "error", message: cause instanceof Error ? cause.message : "No fue posible confirmar el envío. Verifica si llegó antes de repetirlo." });
    } finally {
      busyRef.current = false;
      setBusy(null);
      setConfirmEmail(false);
    }
  }

  return <div className={riskStyles.actionsPanel}>
    <div className={riskStyles.actions} aria-label="Acciones del informe" aria-busy={busy !== null}>
      <Button variant="secondary" disabled={disabled || busy !== null} onClick={downloadPdf}><Download aria-hidden="true" />{busy === "pdf" ? "Preparando PDF…" : "Descargar informe PDF"}</Button>
      {report.filters.aliadoId && ally ? <Button variant="secondary" disabled={disabled || busy !== null} onClick={sendWhatsApp}><MessageCircle aria-hidden="true" />{busy === "whatsapp" ? "Enviando por WhatsApp…" : "Enviar por WhatsApp"}</Button> : null}
      {report.filters.aliadoId && ally ? <Button variant="secondary" disabled={disabled || busy !== null} onClick={() => { setFeedback(null); setConfirmEmail(true); }}><Mail aria-hidden="true" />{busy === "email" ? "Enviando informe…" : "Enviar por correo"}</Button> : null}
    </div>
    {feedback && <p className={`${riskStyles.feedback} ${feedback.kind === "error" ? riskStyles.feedbackError : feedback.kind === "success" ? riskStyles.feedbackSuccess : ""}`} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</p>}
    <ConfirmDialog
      open={confirmEmail}
      title="Enviar informe por correo"
      description={`Se enviará el informe PDF de riesgo temprano a la dirección registrada de ${ally ?? "este aliado"}. Cortes de riesgo: ${riskCuts.map(dateLabel).join(", ")}. Sede: ${site}. ¿Confirmas el envío?`}
      confirmLabel="Confirmar envío"
      busy={busy === "email"}
      onCancel={() => { if (!busyRef.current) setConfirmEmail(false); }}
      onConfirm={sendEmail}
    />
  </div>;
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

function CutBalance({ report }: { report: CutReport }) {
  const { summary, filters, options } = report;
  const [year, month, day] = report.cutDate.split("-");
  const ally = options.aliados.find(item => item.id === filters.aliadoId)?.nombre ?? "Todos los aliados autorizados";
  const site = options.sedes.find(item => item.id === filters.sedeId)?.nombre;
  const scale = Math.max(summary.expected, summary.received);
  const comparison = [
    { label: "Recaudo esperado", amount: summary.expected, style: styles.expectedTrack },
    { label: "Recaudo recibido", amount: summary.received, style: styles.receivedTrack },
  ];

  return <section aria-label="Indicadores del corte con los filtros aplicados">
    <Card className={styles.balance}>
      <header className={styles.balanceHeader}>
        <div>
          <p className={styles.kicker}><CalendarDays size={16} aria-hidden="true" /> Corte consultado</p>
          <h2><time dateTime={report.cutDate}>{day} de {MONTHS[Number(month) - 1].toLowerCase()} de {year}</time></h2>
        </div>
        <div className={styles.scope} aria-label="Filtros aplicados">
          <Badge tone="positive">{ally}</Badge>
          {site && <Badge>{site}</Badge>}
          {filters.status !== "todos" && <Badge>{STATUS_LABELS[filters.status]}</Badge>}
        </div>
      </header>
      <div className={styles.balanceBody}>
        <div className={styles.comparison}>
          <div className={styles.balanceTitle}><h3>Recibido frente a esperado</h3><span>COP</span></div>
          <div className={styles.amounts}>
            {comparison.map(item => <div key={item.label}>
              <div className={styles.amountLine}><span>{item.label}</span><strong>{money(item.amount)}</strong></div>
              <div aria-hidden="true"><ProgressBar className={item.style} value={scale > 0 ? 100 * item.amount / scale : 0} /></div>
            </div>)}
          </div>
          <p className={styles.note}>Pagos aplicados a las cuotas del corte, incluidos los anticipos.</p>
        </div>
        <aside className={styles.balanceStats} aria-label="Resultado del recaudo">
          <div className={styles.completion}><span>Cumplimiento</span><strong>{percentage(summary.completion)}</strong></div>
          {summary.completion === null && <p className={styles.note}>Sin valor esperado para este corte.</p>}
          <dl className={styles.outstanding}><dt>Pendiente por recaudar</dt><dd>{money(summary.pending)}</dd></dl>
          <div className={styles.counts}>
            <div><strong>{summary.creditsCount.toLocaleString("es-CO")}</strong><span>Créditos del corte</span></div>
            <div><strong>{summary.pendingClients.toLocaleString("es-CO")}</strong><span>Clientes pendientes</span></div>
          </div>
        </aside>
      </div>
    </Card>
  </section>;
}

export default function RecaudoPorCorteClient({ initialFilters }: { initialFilters: CutFilters }) {
  const [draft, setDraft] = useState(initialFilters);
  const [selection, setSelection] = useState(initialFilters);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; report: CutReport | null; error: string | null }>({ key: "", report: null, error: null });
  const [exporting, setExporting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<CutRow | null>(null);
  const [selectedRiskCuts, setSelectedRiskCuts] = useState<string[] | null>(null);
  const [manualRiskOrder, setManualRiskOrder] = useState(false);
  const query = paramsFor(selection).toString();
  const draftChanged = paramsFor(draft).toString() !== query;
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
  const riskCuts = selectedRiskCuts ?? (visibleReport ? [visibleReport.cutDate] : []);

  return <div className={styles.content}>
    <nav className={styles.breadcrumb} aria-label="Ruta actual"><Link href="/dashboard"><ArrowLeft aria-hidden="true" />Inicio</Link><span aria-hidden="true">/</span><span>Cartera</span><span aria-hidden="true">/</span><strong aria-current="page">Recaudo por corte</strong></nav>
    <PageHeader
      className={styles.heading}
      eyebrow="CARTERA"
      title="Recaudo por corte"
      description="Compara las cuotas que vencían en una fecha con los pagos aplicados a ellas."
      actions={visibleReport && <div className={styles.updated}>
        <div><span>Actualizado · Colombia</span><time dateTime={visibleReport.asOf}>{dateTime(visibleReport.asOf)}</time></div>
        <Button variant="secondary" aria-label="Actualizar recaudo" onClick={() => setReload(value => value + 1)}>
          <RefreshCw aria-hidden="true" />Actualizar
        </Button>
      </div>}
    />

    <Card className={styles.filters}>
      <form onSubmit={applyFilters}>
        <div className={styles.filterBar}>
          <fieldset className={styles.dayField}><legend>Día de corte</legend>
            <div className={styles.days}>{([2, 17] as const).map(day =>
              <label key={day}><input type="radio" name="cut-day" value={day} checked={draft.day === day} onChange={() => setDraft({ ...draft, day })} />
                <span>{String(day).padStart(2, "0")}</span></label>)}</div>
          </fieldset>
          <label className={styles.field}>Mes<Select value={draft.month} onChange={(event) => setDraft({ ...draft, month: Number(event.target.value) })}>{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</Select></label>
          <label className={styles.field}>Año<Input type="number" min="2000" max="2200" required value={draft.year || ""} onChange={(event) => setDraft({ ...draft, year: Number(event.target.value) })} /></label>
          <label className={`${styles.field} ${styles.allyField}`}>Aliado<Select value={draft.aliadoId || ""} disabled={loading && !report} onChange={(event) => setDraft({ ...draft, aliadoId: Number(event.target.value) || null, sedeId: null })}><option value="">Todos los autorizados</option>{report?.options.aliados.map((ally) => <option key={ally.id} value={ally.id}>{ally.nombre}</option>)}</Select></label>
          <label className={styles.field}>Sede<Select value={draft.sedeId || ""} disabled={loading && !report} onChange={(event) => setDraft({ ...draft, sedeId: Number(event.target.value) || null })}><option value="">Todas las autorizadas</option>{visibleSedes.map((sede) => <option key={sede.id} value={sede.id}>{sede.nombre}</option>)}</Select></label>
          <label className={styles.field}>Estado<Select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CutStatus })}><option value="todos">Todos</option><option value="pendiente">Pendiente</option><option value="parcial">Parcial</option><option value="pagado">Pagado</option></Select></label>
          <div className={styles.filterActions}><Button type="submit" disabled={loading}>Consultar corte</Button></div>
        </div>
        {draftChanged && <p className={styles.draftNote} role="status"><Clock3 size={15} aria-hidden="true" />Hay cambios en los filtros. Pulsa «Consultar corte» para aplicarlos.</p>}
      </form>
    </Card>

    {(error || actionError) && <div className={styles.error} role="alert"><p>{error || actionError}</p>{error && <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>Reintentar consulta</Button>}</div>}
    {loading && <LoadingState label="Consultando cronogramas y pagos…" />}

    {visibleReport && summary && <>
      <CutBalance report={visibleReport} />

      {visibleReport.earlyRisk && <CutRiskComparison
        report={visibleReport}
        filtersQuery={query}
        riskCuts={riskCuts}
        explicitSelection={selectedRiskCuts !== null}
        manualOrder={manualRiskOrder}
        onChange={setSelectedRiskCuts}
        onReorder={cuts => { setSelectedRiskCuts(cuts); setManualRiskOrder(true); }}
        onReset={() => { setSelectedRiskCuts(null); setManualRiskOrder(false); }}
        renderActions={disabled => <CutReportActions key={`${fetchKey}:${riskCuts.join(",")}`} report={visibleReport} riskCuts={riskCuts} disabled={disabled} />}
      />}

      <section className={styles.breakdown} aria-labelledby="cut-breakdown-title">
        <h2 id="cut-breakdown-title">Distribución de pagos</h2>
        <Card className={styles.breakdownBody}>
          <div><Badge tone="positive">Incluido en recibido</Badge><h3>Anticipos del corte</h3><strong>{money(summary.priorPayments)}</strong><p>Abonos a estas cuotas antes del día del corte.</p></div>
          <div><Badge>Fuera del corte</Badge><h3>Recuperación de cuotas anteriores</h3><strong>{money(summary.previousRecovery)}</strong><p>Pagos desde el corte a cuotas que ya habían vencido.</p></div>
          <div><Badge>Fuera del corte</Badge><h3>Anticipos de cuotas futuras</h3><strong>{money(summary.futureAdvances)}</strong><p>Pagos desde el corte a cuotas con vencimiento posterior.</p></div>
        </Card>
      </section>

      {(summary.unclassifiedReceived || 0) > 0 && <p className={styles.notice}>{money(summary.unclassifiedReceived || 0)} del recibido está conciliado por cuota, pero no permite separar su fecha individual; no se clasifica como anticipo.</p>}
      {visibleReport.warnings.length > 0 && <details className={styles.notice}><summary>Observaciones del corte ({visibleReport.warnings.length})</summary>{visibleReport.warnings.map(warning => <p key={warning}>{warning}</p>)}</details>}
      <CutInstallmentDetail key={query} report={visibleReport} onExport={exportExcel} exporting={exporting} onViewPayments={setSelectedRow} />
    </>}
    <PaymentDetail row={selectedRow} onClose={() => setSelectedRow(null)} />
  </div>;
}
