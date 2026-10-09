"use client";

import Link from "next/link";
import ReportDetailView, { type ReportDetails } from "./report-details";
import { ReportHelp } from "./report-details";
import styles from "./query-report.module.css";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ArrowLeft,
  BarChart3,
  Building2,
  CalendarDays,
  ShoppingCart,
  FileSpreadsheet,
  FileText,
  FileSearch,
  Filter,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Tabs,
} from "@/app/_components/finser-ui";

type FilterMode = "day" | "month" | "range";

type ReportRequest = {
  mode: FilterMode;
  allyId: number | null;
  day?: string;
  month?: string;
  from?: string;
  to?: string;
};

type ReportRow = {
  approved: number;
  rejected: number;
  notEvaluated: number;
  allyId: number | null;
  allyName: string;
  allyCode: string | null;
  active: boolean | null;
  originalQueries: number;
  reusedAssessments: number;
  sales: number;
  salesVsOriginalQueriesPercent: number | null;
};

type ReportResponse = ReportDetails & {
  ok: true;
  filters: {
    mode: FilterMode;
    allyId?: number | null;
    day?: string | null;
    month?: string | null;
    from?: string | null;
    to?: string | null;
  };
  period: {
    timezone: "America/Bogota";
    start: string;
    endExclusive: string;
    label: string;
  };
  provider: {
    environment: string;
    enabled: boolean;
    configured: boolean;
    isProduction: boolean;
  };
  retentionDays: number;
  summary: {
    originalQueries: number;
    reusedAssessments: number;
    sales: number;
    salesVsOriginalQueriesPercent: number | null;
  };
  rows: ReportRow[];
};

type ErrorResponse = {
  ok?: false;
  error?: string;
};

type AllyOption = {
  id: number;
  name: string;
  code: string | null;
};

const PERIOD_TABS: Array<{ label: string; value: FilterMode }> = [
  { label: "Día", value: "day" },
  { label: "Mes", value: "month" },
  { label: "Rango", value: "range" },
];

const numberFormatter = new Intl.NumberFormat("es-CO");
const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

function formatCount(value: number) {
  return numberFormatter.format(Number(value || 0));
}

function formatPercent(value: number | null, originalQueries: number) {
  if (originalQueries <= 0 || value === null || !Number.isFinite(value)) {
    return "—";
  }

  return `${percentFormatter.format(value)} %`;
}

function requestForFilters({
  allyId,
  day,
  from,
  mode,
  month,
  to,
}: {
  allyId: string;
  day: string;
  from: string;
  mode: FilterMode;
  month: string;
  to: string;
}): ReportRequest | null {
  const parsedAllyId = allyId ? Number(allyId) : null;

  if (parsedAllyId !== null && (!Number.isInteger(parsedAllyId) || parsedAllyId <= 0)) {
    return null;
  }

  if (mode === "day") {
    return day ? { allyId: parsedAllyId, day, mode } : null;
  }

  if (mode === "month") {
    return month ? { allyId: parsedAllyId, mode, month } : null;
  }

  if (!from || !to || from > to) {
    return null;
  }

  return { allyId: parsedAllyId, from, mode, to };
}

function mergeAllyOptions(current: AllyOption[], rows: ReportRow[]) {
  const options = new Map(current.map((option) => [option.id, option]));

  for (const row of rows) {
    if (row.allyId === null || !Number.isInteger(row.allyId) || row.allyId <= 0) {
      continue;
    }

    options.set(row.allyId, {
      code: row.allyCode,
      id: row.allyId,
      name: row.allyName,
    });
  }

  return Array.from(options.values()).sort((left, right) =>
    left.name.localeCompare(right.name, "es-CO")
  );
}

function activityLabel(row: ReportRow) {
  if (row.active === true) return "Activo";
  if (row.active === false) return "Histórico";
  return "Sin vínculo";
}

export default function DataCreditoVentasClient({ initialDay }: { initialDay: string }) {
  const initialMonth = initialDay.slice(0, 7);
  const initialRangeStart = `${initialMonth}-01`;
  const [mode, setMode] = useState<FilterMode>("day");
  const [day, setDay] = useState(initialDay);
  const [month, setMonth] = useState(initialMonth);
  const [from, setFrom] = useState(initialRangeStart);
  const [to, setTo] = useState(initialDay);
  const [allyId, setAllyId] = useState("");
  const [allyOptions, setAllyOptions] = useState<AllyOption[]>([]);
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [lastRequest, setLastRequest] = useState<ReportRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"xlsx" | "pdf" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function exportReport(format: "xlsx" | "pdf") {
    if (!report || exporting || loading) return;
    setExporting(format); setExportError(null);
    try {
      const response = await fetch("/api/reportes/datacredito-ventas/export", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...report.filters, format }),
      });
      if (!response.ok) { const body = await response.json().catch(()=>null); throw new Error(body?.error || "No se pudo exportar el informe."); }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || `FINSER_PAY_DataCredito.${format}`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 1000);
    } catch (cause) { setExportError(cause instanceof Error ? cause.message : "No se pudo exportar el informe."); }
    finally { setExporting(null); }
  }

  const loadReport = useCallback(async (request: ReportRequest, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setExportError(null);
    setLastRequest(request);

    try {
      const response = await fetch("/api/reportes/datacredito-ventas", {
        body: JSON.stringify(request),
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
        },
        method: "POST",
        signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | ReportResponse
        | ErrorResponse
        | null;

      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && "error" in payload ? payload.error : null;
        throw new Error(message || "No fue posible consultar el reporte.");
      }

      setReport(payload);
      setAllyOptions((current) => mergeAllyOptions(current, payload.rows));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") {
        return;
      }

      setError(cause instanceof Error ? cause.message : "No fue posible consultar el reporte.");
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadReport({ allyId: null, day: initialDay, mode: "day" }, controller.signal);

    return () => controller.abort();
  }, [initialDay, loadReport]);

  const reportedAllyName = useMemo(() => {
    const reportedAllyId = report?.filters.allyId;

    if (!reportedAllyId) return "Todos los aliados";

    return (
      report.rows.find((row) => row.allyId === reportedAllyId)?.allyName ||
      allyOptions.find((option) => option.id === reportedAllyId)?.name ||
      "Aliado seleccionado"
    );
  }, [allyOptions, report]);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = requestForFilters({ allyId, day, from, mode, month, to });

    if (!request) {
      setLastRequest(null);
      setError(
        mode === "range" && from && to && from > to
          ? "La fecha inicial no puede ser posterior a la fecha final."
          : "Completa correctamente los filtros del periodo."
      );
      return;
    }

    void loadReport(request);
  }

  function handlePeriodTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []
    );
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const nextTab = PERIOD_TABS[nextIndex];
    setMode(nextTab.value);
    tabs[nextIndex]?.focus();
  }

  function resetFilters() {
    setMode("day");
    setDay(initialDay);
    setMonth(initialMonth);
    setFrom(initialRangeStart);
    setTo(initialDay);
    setAllyId("");
    void loadReport({ allyId: null, day: initialDay, mode: "day" });
  }

  const ready = Boolean(report) && !loading && !error;
  return <main className={styles.page}>
    <PageHeader className={styles.heading} title="Consultas y ventas" description="DataCrédito" actions={<>
      <Link href="/dashboard/reportes" className="fp-ui-button is-secondary"><ArrowLeft aria-hidden="true" />Centro de reportes</Link>
      <Button variant="secondary" disabled={!ready || Boolean(exporting)} onClick={()=>void exportReport("xlsx")}><FileSpreadsheet className={styles.excelIcon} aria-hidden="true" />{exporting === "xlsx" ? "Generando Excel…" : "Exportar Excel"}</Button>
      <Button variant="secondary" disabled={!ready || Boolean(exporting)} onClick={()=>void exportReport("pdf")}><FileText className={styles.pdfIcon} aria-hidden="true" />{exporting === "pdf" ? "Generando PDF…" : "Exportar PDF"}</Button>
    </>} />
    {exportError && <p role="alert" className={styles.error}>{exportError}</p>}
    <Card className={styles.filters}>
      <form onSubmit={submitFilters} className={styles.filterForm} aria-label="Filtros del reporte">
        <Tabs className={styles.periodTabs} aria-label="Agrupación del periodo">{PERIOD_TABS.map(tab=><button key={tab.value} id={`period-tab-${tab.value}`} type="button" role="tab" aria-selected={mode===tab.value} aria-controls="period-filter-panel" tabIndex={mode===tab.value?0:-1} disabled={loading} onClick={()=>setMode(tab.value)} onKeyDown={handlePeriodTabKeyDown}>{tab.label}</button>)}</Tabs>
        <div id="period-filter-panel" role="tabpanel" aria-labelledby={`period-tab-${mode}`} className={styles.dates}>
          {mode === "day" && <label className={styles.dateControl}><span className="sr-only">Día</span><CalendarDays aria-hidden="true"/><Input id="report-day" type="date" value={day} disabled={loading} required onChange={e=>setDay(e.target.value)} /></label>}
          {mode === "month" && <label className={styles.dateControl}><span className="sr-only">Mes</span><CalendarDays aria-hidden="true"/><Input id="report-month" type="month" value={month} disabled={loading} required onChange={e=>setMonth(e.target.value)} /></label>}
          {mode === "range" && <div className={styles.range}><label><span>Desde</span><Input id="report-from" type="date" value={from} disabled={loading} required onChange={e=>setFrom(e.target.value)} /></label><label><span>Hasta (incluido)</span><Input id="report-to" type="date" value={to} min={from} disabled={loading} required onChange={e=>setTo(e.target.value)} /></label></div>}
        </div>
        <label className={styles.ally}><span>Aliado</span><span className={styles.selectControl}><Building2 aria-hidden="true"/><Select id="report-ally" value={allyId} disabled={loading} onChange={e=>setAllyId(e.target.value)}><option value="">Todos los aliados</option>{allyOptions.map(a=><option key={a.id} value={a.id}>{a.name}{a.code?` · ${a.code}`:""}</option>)}</Select></span></label>
        <Button type="submit" disabled={loading} className={styles.consult}><Filter aria-hidden="true"/>{loading?"Consultando…":"Consultar"}</Button>
        <Button variant="secondary" disabled={loading} onClick={resetFilters}><RotateCcw aria-hidden="true"/>Restablecer</Button>
      </form>
    </Card>
    {loading ? <Card className={styles.state}><LoadingState label="Calculando consultas y ventas…"/></Card> : error ? <div role="alert" className={styles.state}><EmptyState title="No pudimos cargar el reporte" description={error} action={lastRequest?<Button variant="secondary" onClick={()=>void loadReport(lastRequest)}><RefreshCw aria-hidden="true"/>Reintentar</Button>:null}/></div> : report ? <section aria-label="Resultado por aliado">
      <p className="sr-only" role="status">Reporte cargado para {report.period.label}: {formatCount(report.rows.length)} aliados, {formatCount(report.summary.originalQueries)} consultas nuevas y {formatCount(report.summary.sales)} ventas finalizadas.</p>
      {new Date(report.period.start).getTime()<Date.now()-report.retentionDays*86400000 && <p role="status" className={styles.warning}>Historial parcial: el período supera la retención de {report.retentionDays} días.</p>}
      {!report.provider.isProduction && <p className={styles.warning}>Ambiente de pruebas: {report.provider.environment}</p>}
      <div className={styles.metrics}>
        {[
          {label:"Consultas nuevas",value:formatCount(report.summary.originalQueries),Icon:FileSearch,help:"Consultas originales al proveedor. Excluye respuestas reutilizadas, pendientes y fallos previos a la consulta."},
          {label:"Reutilizadas sin cobro",value:formatCount(report.summary.reusedAssessments),Icon:RefreshCw,help:"Respuestas vigentes reutilizadas. No cuentan como consultas nuevas."},
          {label:"Ventas finalizadas",value:formatCount(report.summary.sales),Icon:ShoppingCart,help:"Créditos DataCrédito no anulados creados en el período consultado."},
          {label:"Ventas / consultas",value:formatPercent(report.summary.salesVsOriginalQueriesPercent,report.summary.originalQueries),Icon:BarChart3,help:"Ventas / consultas nuevas. Compara eventos del período, no una cohorte; puede superar el 100 %."},
        ].map(({label,value,Icon,help})=><div key={label} className={styles.metric}><span className={styles.metricIcon}><Icon aria-hidden="true"/></span><div><strong>{value}</strong><span>{label} <ReportHelp text={help}/></span></div></div>)}
      </div>
      <ReportDetailView report={report} periodLabel={report.period.label} allyName={reportedAllyName}/>
      <Card className={styles.panel}>
        <div className={styles.panelHeading}><h2>Detalle operativo</h2><span>{report.rows.length} {report.rows.length===1?"aliado":"aliados"}<ReportHelp text={`Zona horaria: America/Bogota. Historial disponible: ${report.retentionDays} días. Ambiente: ${report.provider.environment}.`}/></span></div>
        {report.rows.length ? <DataTable className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Consultas DataCrédito y ventas finalizadas por aliado</caption><thead><tr>{["Aliado","Consultas nuevas","Aprobadas","Rechazadas","No evaluadas","Reutilizadas","Ventas finalizadas","Ventas / consultas"].map((label,i)=><th scope="col" key={label} className={i?styles.numeric:undefined}>{label}</th>)}</tr></thead><tbody>{report.rows.map(row=><tr key={row.allyId??"none"}><th scope="row">{row.allyName}<small>{row.allyCode} · {activityLabel(row)}</small></th>{[row.originalQueries,row.approved,row.rejected,row.notEvaluated,row.reusedAssessments,row.sales].map((n,i)=><td key={i} className={styles.numeric}>{formatCount(n)}</td>)}<td className={styles.numeric}>{formatPercent(row.salesVsOriginalQueriesPercent,row.originalQueries)}</td></tr>)}</tbody></table></DataTable>:<EmptyState title="Sin resultados" description="No hay aliados para los filtros consultados."/>}
      </Card>
    </section>:null}
  </main>;
}
