"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, EmptyState, LoadingState, Select } from "@/app/_components/finser-ui";
import type { CutAnalysisPriority, CutAutomaticAnalysis, CutRiskMetric } from "@/lib/cut-collection-types";
import { getCutFpdLevel } from "@/lib/cut-risk-presentation";
import styles from "./cut-automatic-analysis.module.css";

const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 2, minimumFractionDigits: 0 });
const number = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Bogota" });
const REFERENCE = 90;
type LoadState = { query: string; status: "ready"; data: CutAutomaticAnalysis } | { query: string; status: "error"; error: string };
type PriorityView = "allies" | "sites";
type PriorityOrder = "balance" | "risk";

function dateLabel(value: string) { return date.format(new Date(`${value}T12:00:00Z`)); }
function percent(value: number | null | undefined) { return value == null ? "Pendiente" : `${number.format(value)} %`; }
function fpd3(metrics: CutRiskMetric[]) { return metrics.find(metric => /^(?:DPF|FPD) 3$/.test(metric.label)); }
function fpdAt(metrics: CutRiskMetric[], day: number) { return metrics.find(metric => metric.label === `DPF ${day}` || metric.label === `FPD ${day}`); }
function rate(metric: CutRiskMetric | undefined) { return metric && metric.eligible > 0 ? metric.cases / metric.eligible * 100 : null; }
function partial(metric: CutRiskMetric | undefined) { return Boolean(metric && metric.eligible > 0 && (metric.pending > 0 || metric.unavailable > 0)); }
function ageLabel(days: number) {
  if (days < 0) return `En ${number.format(Math.abs(days))} ${days === -1 ? "día" : "días"}`;
  return days === 0 ? "Día del corte" : `${number.format(days)} ${days === 1 ? "día" : "días"} transcurridos`;
}
function RiskLevel({ value }: { value: number | null }) {
  if (value == null) return <Badge>Pendiente</Badge>;
  const level = getCutFpdLevel(value);
  return <Badge tone={level === "MALO" ? "danger" : level === "REGULAR" ? "warning" : "positive"}>{level.charAt(0) + level.slice(1).toLowerCase()}</Badge>;
}
function sortedPriorities(rows: CutAnalysisPriority[], order: PriorityOrder) {
  return rows.filter(item => order === "balance" ? item.collectiblePending > 0 : item.fpd3Rate != null && item.fpd3.eligible > 0 && item.fpd3.cases > 0).sort((left, right) => {
    if (order === "risk") {
      if (left.fpd3Rate == null && right.fpd3Rate != null) return 1;
      if (left.fpd3Rate != null && right.fpd3Rate == null) return -1;
      const riskDifference = (right.fpd3Rate ?? 0) - (left.fpd3Rate ?? 0);
      if (riskDifference) return riskDifference;
    }
    return right.collectiblePending - left.collectiblePending || left.name.localeCompare(right.name, "es");
  }).slice(0, 5);
}

function AnalysisContent({ data }: { data: CutAutomaticAnalysis }) {
  const [view, setView] = useState<PriorityView>("allies");
  const [order, setOrder] = useState<PriorityOrder>("balance");
  const current = data.cuts.find(cut => cut.cutDate === data.cutDate);
  const summary = current?.summary;
  const completion = summary?.expected ? summary.completion : null;
  const referenceGap = summary && summary.expected > 0 ? Math.max(0, summary.expected * REFERENCE / 100 - summary.received) : null;
  const metric = fpd3(current?.earlyRisk ?? []);
  const currentRisk = rate(metric);
  const comparison = [...data.cuts].filter(cut => cut.cutDate < data.cutDate && rate(fpd3(cut.earlyRisk)) != null).sort((left, right) => right.cutDate.localeCompare(left.cutDate))[0];
  const comparisonMetric = comparison ? fpd3(comparison.earlyRisk) : undefined;
  const comparisonRisk = rate(comparisonMetric);
  const difference = currentRisk != null && comparisonRisk != null ? currentRisk - comparisonRisk : null;
  const priorities = sortedPriorities(data.priorities[view], order);
  const isFuture = Boolean(current && current.ageDays < 0);
  const status = !summary ? "Conciliación pendiente" : summary.expected === 0 ? "Sin valor programado" : isFuture ? "Corte por vencer" : referenceGap === 0 ? "Referencia alcanzada" : "Por debajo de la referencia";

  if (!current) return <EmptyState title="Sin análisis disponible" description="No hay información del corte seleccionado con estos filtros." />;

  return <>
    <div className={styles.overview}>
      <div className={styles.reading}>
        <h3>Estado del corte</h3>
        <div className={styles.readingValue}><strong>{!summary ? "Pendiente" : completion == null ? "No aplica" : percent(completion)}</strong><Badge tone={isFuture ? "neutral" : referenceGap === 0 && summary && summary.expected > 0 ? "positive" : completion != null ? "warning" : "neutral"}>{status}</Badge></div>
        <p>{summary ? `${money.format(summary.received)} recibidos de ${money.format(summary.expected)} programados.` : "El recaudo requiere conciliar la información disponible."}</p>
      </div>
      <div className={styles.reading}>
        <h3>Brecha al {REFERENCE} %</h3>
        <div className={styles.readingValue}><strong>{referenceGap == null ? "No aplica" : money.format(referenceGap)}</strong></div>
        <p>Importe adicional para alcanzar la referencia operativa del {REFERENCE} %.</p>
      </div>
      <div className={styles.reading}>
        <h3>Riesgo FPD 3</h3>
        <div className={styles.readingValue}><strong>{percent(currentRisk)}</strong>{currentRisk != null ? <RiskLevel value={currentRisk} /> : null}</div>
        <p>{partial(metric) ? "Evaluación al día 3 · Base parcial por maduración o datos." : currentRisk == null ? "La evaluación al día 3 aún no está disponible." : "Evaluación al día 3 del vencimiento."}</p>
      </div>
    </div>

    <div className={styles.sections}>
      <section className={styles.comparison} aria-labelledby="automatic-cut-comparison-title">
        <h3 id="automatic-cut-comparison-title">Comparativo de cortes</h3>
        <p className={styles.note}>Recaudo acumulado, incluidos anticipos. Sin historial completo a la misma edad, las diferencias no indican una mejora o caída entre cortes.</p>
        <div className={styles.tableScroll} role="region" aria-label="Comparativo acumulado y riesgo a los días 3, 7 y 15" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Corte y edad</th><th scope="col">Cumplimiento<br /><span>Acumulado</span></th>{[3, 7, 15].map(day => <th key={day} scope="col">FPD {day}<br /><span>Al día {day}</span></th>)}</tr></thead>
            <tbody>{[...data.cuts].sort((left, right) => left.cutDate.localeCompare(right.cutDate)).map(cut => {
              return <tr key={cut.cutDate} data-selected={cut.cutDate === data.cutDate || undefined}>
                <th scope="row"><time dateTime={cut.cutDate}>{dateLabel(cut.cutDate)}</time><span>{ageLabel(cut.ageDays)}</span>{cut.cutDate === data.cutDate ? <small>Seleccionado</small> : null}</th>
                <td><strong>{cut.summary == null ? "Pendiente" : cut.summary.completion == null ? "No aplica" : percent(cut.summary.completion)}</strong>{cut.summary == null || cut.unavailableCredits > 0 ? <span>Conciliación pendiente</span> : null}</td>
                {[3, 7, 15].map(day => {
                  const cutMetric = fpdAt(cut.earlyRisk, day);
                  return <td key={day}><strong>{percent(rate(cutMetric))}</strong>{partial(cutMetric) ? <span>Base parcial</span> : null}</td>;
                })}
              </tr>;
            })}</tbody>
          </table>
        </div>
        <p className={styles.comparisonInsight}>{difference == null || !comparison ? "La variación de FPD 3 estará disponible cuando ambos cortes tengan una base evaluable." : <>
          FPD 3 {Math.abs(difference) < 0.05 ? "sin variación" : `${number.format(Math.abs(difference))} puntos porcentuales ${difference > 0 ? "por encima" : "por debajo"}`} del {dateLabel(comparison.cutDate)}: se compara el día 3 en ambos cortes.
          {partial(metric) || partial(comparisonMetric) ? " Lectura en la base disponible; comparación parcial por maduración o datos." : ""}
        </>}</p>
      </section>

      <section className={styles.priorities} aria-labelledby="automatic-cut-priorities-title">
        <div className={styles.priorityHeading}><h3 id="automatic-cut-priorities-title">Dónde priorizar</h3><span>Top 5</span></div>
        <div className={styles.controls}>
          <div className={styles.viewSwitch} role="group" aria-label="Agrupar prioridades">
            <Button variant={view === "allies" ? "primary" : "secondary"} aria-pressed={view === "allies"} onClick={() => setView("allies")}>Aliados</Button>
            <Button variant={view === "sites" ? "primary" : "secondary"} aria-pressed={view === "sites"} onClick={() => setView("sites")}>Sedes</Button>
          </div>
          <label>Ordenar por<Select value={order} onChange={event => setOrder(event.target.value as PriorityOrder)}><option value="balance">Saldo pendiente</option><option value="risk">FPD 3</option></Select></label>
        </div>
        <p className={styles.note}>{order === "balance" ? "Mayor saldo pendiente primero; excluye créditos con paz y salvo y grupos sin saldo cobrable." : "Mayor FPD 3 primero; sólo grupos evaluables con casos de riesgo. El saldo excluye créditos con paz y salvo."}</p>
        {priorities.length ? <ol className={styles.priorityList}>{priorities.map((item, index) => <li key={`${item.aliadoId ?? ""}:${item.id ?? "none"}`}>
          <div className={styles.priorityName}><span aria-hidden="true">{index + 1}</span><div><strong>{item.name}</strong>{view === "sites" && item.aliado ? <small>{item.aliado}</small> : null}</div></div>
          <dl><div><dt>Saldo pendiente</dt><dd>{money.format(item.collectiblePending)}</dd></div><div><dt>FPD 3</dt><dd>{percent(item.fpd3Rate)}{item.fpd3Rate != null ? <RiskLevel value={item.fpd3Rate} /> : null}</dd>{partial(item.fpd3) ? <span className={styles.partial}>Base parcial</span> : null}</div></dl>
        </li>)}</ol> : <EmptyState title={order === "balance" ? "Sin saldo cobrable para priorizar" : "Sin casos evaluables de FPD 3"} description={order === "balance" ? "Los grupos consultados no tienen saldo pendiente fuera de los créditos con paz y salvo." : "No hay grupos con riesgo FPD 3 identificado en la base disponible."} />}
      </section>
    </div>
    {data.warnings.length ? <div className={styles.warnings} role="note" aria-label="Alcance del análisis"><strong>Alcance de los datos</strong><ul>{[...new Set(data.warnings)].map(warning => <li key={warning}>{warning}</li>)}</ul></div> : null}
  </>;
}

export default function CutAutomaticAnalysisPanel({ filtersQuery }: { filtersQuery: string }) {
  const [state, setState] = useState<LoadState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = state?.query === filtersQuery ? state : null;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams(filtersQuery);
    params.set("format", "analysis");
    async function load() {
      try {
        const response = await fetch(`/api/reportes/recaudo-por-corte?${params}`, { signal: controller.signal, cache: "no-store" });
        const data = await response.json();
        if (!response.ok || data?.ok !== true || !Array.isArray(data.cuts) || !Array.isArray(data.priorities?.allies) || !Array.isArray(data.priorities?.sites)) {
          throw new Error(typeof data?.error === "string" ? data.error : "No se pudo consultar el análisis automático.");
        }
        if (!controller.signal.aborted) setState({ query: filtersQuery, status: "ready", data });
      } catch (error) {
        if (!controller.signal.aborted) setState({ query: filtersQuery, status: "error", error: error instanceof Error ? error.message : "No se pudo consultar el análisis automático." });
      }
    }
    void load();
    return () => controller.abort();
  }, [filtersQuery, attempt]);

  return <Card className={styles.panel} role="region" aria-labelledby="automatic-cut-analysis-title" aria-busy={!current}>
    <header className={styles.header}><div><h2 id="automatic-cut-analysis-title">Análisis automático</h2><p>Todos los estados de cuota, con el aliado y la sede aplicados.</p></div>{current?.status === "ready" ? <Badge>Recaudo acumulado</Badge> : null}</header>
    {!current ? <LoadingState label="Analizando el corte y sus prioridades…" /> : current.status === "error" ? <div className={styles.error} role="alert"><p>{current.error}</p><Button variant="secondary" onClick={() => { setState(null); setAttempt(value => value + 1); }}>Reintentar análisis</Button></div> : <AnalysisContent key={filtersQuery} data={current.data} />}
  </Card>;
}
