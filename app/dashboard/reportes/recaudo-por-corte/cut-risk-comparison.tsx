"use client";

import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, GripVertical, Plus, X } from "lucide-react";
import { Badge, Button, Card, DataTable, EmptyState, Input, LoadingState, Select } from "@/app/_components/finser-ui";
import { getCutFpdLevel } from "@/lib/cut-risk-presentation";
import type { CutReport, CutRiskComparisonItem } from "@/lib/cut-collection-types";
import styles from "./cut-early-risk.module.css";

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const INDICATORS = ["FPD 3", "FPD 7", "FPD 15", "40/60"];
const LEVEL_LABELS = { EXCELENTE: "Excelente", BUENO: "Bueno", REGULAR: "Regular", MALO: "Malo" };
const numberFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 1 });
const dateFormatter = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Bogota" });
const timeFormatter = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Bogota" });

function dateLabel(value: string) { return dateFormatter.format(new Date(`${value}T12:00:00Z`)); }
function indicatorLabel(value: string) { return value.replace(/^DPF(?=\s|$)/, "FPD"); }

type Props = {
  report: CutReport;
  filtersQuery: string;
  riskCuts: string[];
  explicitSelection: boolean;
  manualOrder: boolean;
  onChange: (cuts: string[]) => void;
  onReorder: (cuts: string[]) => void;
  onReset: () => void;
  renderActions: (disabled: boolean) => ReactNode;
};

type CutDrag = { kind: "pointer"; cut: string; pointerId: number } | { kind: "native"; cut: string };

export default function CutRiskComparison({ report, filtersQuery, riskCuts, explicitSelection, manualOrder, onChange, onReorder, onReset, renderActions }: Props) {
  const [draft, setDraft] = useState({ day: report.filters.day, month: report.filters.month, year: report.filters.year });
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  const [draggedCut, setDraggedCut] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; reports: CutRiskComparisonItem[]; error: string | null }>({ key: "", reports: [], error: null });
  const selectorHeading = useRef<HTMLHeadingElement>(null);
  const selectedCutsList = useRef<HTMLUListElement>(null);
  const activeDrag = useRef<CutDrag | null>(null);
  const datesKey = riskCuts.join(",");
  const params = new URLSearchParams(filtersQuery);
  params.set("riskCuts", datesKey);
  params.set("format", "risk");
  const requestQuery = params.toString();
  const requestKey = `${requestQuery}#${retry}`;
  const usePrimaryRisk = riskCuts.length === 1 && riskCuts[0] === report.cutDate && Array.isArray(report.earlyRisk);
  const loading = !usePrimaryRisk && result.key !== requestKey;
  const error = !usePrimaryRisk && !loading ? result.error : null;
  const reports: CutRiskComparisonItem[] = usePrimaryRisk
    ? [{ cutDate: report.cutDate, queriedAt: report.asOf, earlyRisk: report.earlyRisk! }]
    : !loading && !error ? result.reports : [];
  const hasMetrics = reports.some(item => item.earlyRisk.length > 0);
  const queriedAt = reports.map(item => item.queriedAt).sort().at(-1);

  useEffect(() => {
    if (usePrimaryRisk) return;
    const controller = new AbortController();
    const selectedDates = datesKey.split(",");
    fetch(`/api/reportes/recaudo-por-corte?${requestQuery}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(payload?.reports)) {
          throw new Error(payload?.error || payload?.message || "No fue posible comparar el riesgo de los cortes seleccionados.");
        }
        const items = payload.reports as CutRiskComparisonItem[];
        if (items.length !== selectedDates.length || selectedDates.some(cut => items.filter(item => item?.cutDate === cut).length !== 1) ||
          items.some(item => !Number.isFinite(Date.parse(item.queriedAt)) || !Array.isArray(item.earlyRisk) || item.earlyRisk.some(metric => !metric || typeof metric.label !== "string" ||
            [metric.cases, metric.eligible, metric.pending, metric.unavailable].some(value => !Number.isFinite(value) || value < 0)))) {
          throw new Error("La comparación recibida está incompleta. Vuelve a consultar los cortes.");
        }
        return selectedDates.map(cut => items.find(item => item.cutDate === cut)!);
      })
      .then(items => { if (!controller.signal.aborted) setResult({ key: requestKey, reports: items, error: null }); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setResult({ key: requestKey, reports: [], error: cause instanceof Error ? cause.message : "No fue posible comparar el riesgo de los cortes seleccionados." });
      });
    return () => controller.abort();
  }, [datesKey, requestKey, requestQuery, usePrimaryRisk]);

  function addCut() {
    if (!Number.isInteger(draft.year) || draft.year < 2000 || draft.year > 2200) {
      setSelectionError("El año debe estar entre 2000 y 2200.");
      return;
    }
    if (riskCuts.length >= 6) {
      setSelectionError("Puedes comparar hasta 6 cortes. Retira uno para agregar otro.");
      return;
    }
    const cut = `${draft.year}-${String(draft.month).padStart(2, "0")}-${String(draft.day).padStart(2, "0")}`;
    if (riskCuts.includes(cut)) {
      setSelectionError("Ese corte ya está en la comparación.");
      return;
    }
    setSelectionError(null);
    setOrderMessage(null);
    onChange(manualOrder ? [...riskCuts, cut] : [...riskCuts, cut].sort());
  }

  function removeCut(cut: string) {
    if (riskCuts.length <= 1) return;
    setSelectionError(null);
    setOrderMessage(null);
    onChange(riskCuts.filter(item => item !== cut));
    selectorHeading.current?.focus();
  }

  function moveCut(cut: string, destination: number) {
    const origin = riskCuts.indexOf(cut);
    if (origin < 0 || origin === destination || destination < 0 || destination >= riskCuts.length) return;
    const reordered = [...riskCuts];
    reordered.splice(origin, 1);
    reordered.splice(destination, 0, cut);
    setSelectionError(null);
    setOrderMessage(`Corte del ${dateLabel(cut)} movido a la posición ${destination + 1} de ${riskCuts.length}.`);
    onReorder(reordered);
  }

  function cutAtPoint(clientX: number, clientY: number) {
    const chip = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-risk-cut]");
    const cut = chip?.dataset.riskCut;
    return chip && cut && riskCuts.includes(cut) && chip.closest("[data-risk-cut-list]") === selectedCutsList.current ? cut : null;
  }

  function startPointerDrag(event: PointerEvent<HTMLButtonElement>, cut: string) {
    if (riskCuts.length < 2 || event.button !== 0 || event.isPrimary === false || activeDrag.current) return;
    event.preventDefault();
    event.stopPropagation();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { return; }
    activeDrag.current = { kind: "pointer", cut, pointerId: event.pointerId };
    setDraggedCut(cut);
    setDropTarget(null);
  }

  function movePointerDrag(event: PointerEvent<HTMLButtonElement>) {
    const drag = activeDrag.current;
    if (drag?.kind !== "pointer" || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const target = cutAtPoint(event.clientX, event.clientY);
    setDropTarget(target !== drag.cut ? target : null);
  }

  function finishPointerDrag(event: PointerEvent<HTMLButtonElement>, cancelled = false) {
    const drag = activeDrag.current;
    if (drag?.kind !== "pointer" || drag.pointerId !== event.pointerId) return;
    const target = cancelled ? null : cutAtPoint(event.clientX, event.clientY);
    activeDrag.current = null;
    setDraggedCut(null);
    setDropTarget(null);
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (target) moveCut(drag.cut, riskCuts.indexOf(target));
  }

  return <section className={styles.section} aria-labelledby="early-risk-title">
    <header className={styles.header}>
      <div className={styles.headerTitle}><h2 id="early-risk-title">Riesgo temprano</h2></div>
      {renderActions(loading || Boolean(error) || reports.length === 0)}
    </header>

    <Card className={styles.selector}>
      <div className={styles.selectorHeading}>
        <h3 ref={selectorHeading} tabIndex={-1}>Cortes a comparar <Badge>{riskCuts.length} de 6</Badge></h3>
        {explicitSelection && <Button variant="ghost" onClick={() => { setSelectionError(null); setOrderMessage(null); onReset(); }}>Usar corte consultado</Button>}
      </div>
      <div className={styles.selectorControls} role="group" aria-label="Agregar un corte a la comparación">
        <label>Día<Select aria-label="Día para comparar" value={draft.day} onChange={event => { setSelectionError(null); setDraft({ ...draft, day: Number(event.target.value) as 2 | 17 }); }}><option value="2">02</option><option value="17">17</option></Select></label>
        <label>Mes<Select aria-label="Mes para comparar" value={draft.month} onChange={event => { setSelectionError(null); setDraft({ ...draft, month: Number(event.target.value) }); }}>{MONTHS.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}</Select></label>
        <label>Año<Input aria-label="Año para comparar" type="number" min="2000" max="2200" value={draft.year || ""} onChange={event => { setSelectionError(null); setDraft({ ...draft, year: Number(event.target.value) }); }} /></label>
        <Button variant="secondary" onClick={addCut} disabled={riskCuts.length >= 6}><Plus aria-hidden="true" />Agregar corte</Button>
      </div>
      <ul ref={selectedCutsList} data-risk-cut-list="" className={styles.selectedCuts} aria-label="Cortes seleccionados para riesgo">
        {riskCuts.map((cut, index) => <li key={cut}
          draggable={riskCuts.length > 1}
          data-risk-cut={cut}
          data-dragging={draggedCut === cut || undefined}
          data-drop-target={dropTarget === cut || undefined}
          onDragStart={event => { if (activeDrag.current?.kind === "pointer") { event.preventDefault(); return; } activeDrag.current = { kind: "native", cut }; event.dataTransfer.setData("text/plain", cut); event.dataTransfer.effectAllowed = "move"; setDraggedCut(cut); }}
          onDragOver={event => { if (activeDrag.current?.kind === "native" && activeDrag.current.cut !== cut) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(cut); } }}
          onDragLeave={() => { if (activeDrag.current?.kind === "native") setDropTarget(null); }}
          onDrop={event => { event.preventDefault(); const drag = activeDrag.current; if (drag?.kind !== "native") return; activeDrag.current = null; setDraggedCut(null); setDropTarget(null); moveCut(drag.cut, index); }}
          onDragEnd={() => { if (activeDrag.current?.kind === "native") { activeDrag.current = null; setDraggedCut(null); setDropTarget(null); } }}
        >
          <span className={styles.chipLabel}>
            <Button variant="ghost" className={styles.grip} draggable={false} disabled={riskCuts.length === 1}
              aria-label={`Arrastrar corte del ${dateLabel(cut)}`} aria-describedby="risk-reorder-help"
              onPointerDown={event => startPointerDrag(event, cut)} onPointerMove={movePointerDrag}
              onPointerUp={event => finishPointerDrag(event)} onPointerCancel={event => finishPointerDrag(event, true)}
              onLostPointerCapture={event => finishPointerDrag(event, true)}
              onKeyDown={event => { if (!activeDrag.current && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); moveCut(cut, index + (event.key === "ArrowLeft" ? -1 : 1)); } }}
            ><GripVertical aria-hidden="true" /></Button>
            <time dateTime={cut}>{dateLabel(cut)}</time>
          </span>
          <span className={styles.chipActions}>
            <Button variant="ghost" disabled={index === 0} aria-label={`Mover corte del ${dateLabel(cut)} antes`} onClick={() => moveCut(cut, index - 1)}><ChevronLeft aria-hidden="true" /></Button>
            <Button variant="ghost" disabled={index === riskCuts.length - 1} aria-label={`Mover corte del ${dateLabel(cut)} después`} onClick={() => moveCut(cut, index + 1)}><ChevronRight aria-hidden="true" /></Button>
            <Button variant="ghost" disabled={riskCuts.length === 1} aria-label={`Quitar corte del ${dateLabel(cut)}`} onClick={() => removeCut(cut)}><X aria-hidden="true" /></Button>
          </span>
        </li>)}
      </ul>
      {selectionError && <p className={styles.selectionError} role="alert">{selectionError}</p>}
      <p id="risk-reorder-help" className={styles.hint}>Arrastra desde el agarre o usa las flechas para cambiar el orden. {riskCuts.length >= 6 ? "Máximo de 6 cortes; retira uno para agregar otro." : manualOrder ? "Los nuevos cortes se agregan al final." : "Los nuevos cortes se ordenan por fecha."}</p>
      {orderMessage && <p className={styles.orderMessage} role="status">{orderMessage}</p>}
    </Card>

    {loading && <LoadingState label="Comparando riesgo de los cortes seleccionados…" />}
    {error && <div className={`${styles.feedback} ${styles.feedbackError}`} role="alert"><p>{error}</p><Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reintentar comparación</Button></div>}
    {!loading && !error && !hasMetrics && <EmptyState title="Sin indicadores disponibles" description="No hay datos de riesgo temprano para los cortes seleccionados." />}
    {hasMetrics && <DataTable><div className={styles.matrix} role="region" tabIndex={0} aria-label="Comparación de riesgo por corte; desplaza la tabla para ver todos los indicadores">
      <table>
        <caption>Créditos en riesgo / evaluados por corte.</caption>
        <thead><tr><th scope="col">Corte</th>{INDICATORS.map(label => <th key={label} scope="col">{label}{label === "40/60" && <span className={styles.columnHint}>6 cuotas en 3 meses</span>}</th>)}</tr></thead>
        <tbody>{reports.map(item => <tr key={item.cutDate}>
          <th scope="row"><time dateTime={item.cutDate}>{dateLabel(item.cutDate)}</time></th>
          {INDICATORS.map(label => {
            const metric = item.earlyRisk.find(value => indicatorLabel(value.label) === label);
            const rate = metric?.eligible ? 100 * metric.cases / metric.eligible : null;
            const level = rate !== null && label.startsWith("FPD") ? getCutFpdLevel(rate) : null;
            return <td key={label}>
              {metric ? <div className={styles.cell}>
                <div className={styles.cellHeading}>
                  <strong className={rate === null ? styles.noPercentage : styles.percentage}>{rate === null ? "Sin base evaluable" : `${numberFormatter.format(rate)} %`}</strong>
                  {level && <Badge tone={level === "MALO" ? "danger" : level === "REGULAR" ? "warning" : "positive"}>{LEVEL_LABELS[level]}</Badge>}
                </div>
                {metric.eligible > 0 && <p className={styles.ratio}><b>{numberFormatter.format(metric.cases)}</b> / <b>{numberFormatter.format(metric.eligible)}</b> evaluados</p>}
                {(metric.pending > 0 || metric.unavailable > 0) && <dl className={styles.maturity}>
                  {metric.pending > 0 && <div><dt>Por madurar</dt><dd>{numberFormatter.format(metric.pending)}</dd></div>}
                  {metric.unavailable > 0 && <div><dt>Sin datos comparables</dt><dd>{numberFormatter.format(metric.unavailable)}</dd></div>}
                </dl>}
              </div> : <span className={styles.hint}>No disponible</span>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div></DataTable>}
    {queriedAt && <p className={styles.hint}>Cada corte se evalúa por separado. Última consulta: <time dateTime={queriedAt}>{timeFormatter.format(new Date(queriedAt))}</time> · Colombia.</p>}
  </section>;
}
