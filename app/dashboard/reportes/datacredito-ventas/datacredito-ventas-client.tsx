"use client";

import Link from "next/link";
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
  CircleDollarSign,
  FileSearch,
  Filter,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  MetricCard,
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
  allyId: number | null;
  allyName: string;
  allyCode: string | null;
  active: boolean | null;
  originalQueries: number;
  reusedAssessments: number;
  sales: number;
  salesVsOriginalQueriesPercent: number | null;
};

type ReportResponse = {
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

  const loadReport = useCallback(async (request: ReportRequest, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
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

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow="Riesgo y desempeño"
        title="Consultas DataCrédito vs. ventas"
        description="Compara la actividad de DataCrédito con las ventas finalizadas de cada aliado."
        actions={
          <Link href="/dashboard/reportes" className="fp-ui-button is-secondary">
            <ArrowLeft aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
            Centro de reportes
          </Link>
        }
      />

      <Card className="mt-4 !rounded-lg !p-4 sm:!p-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-base font-black text-[#151a21]">Filtros del reporte</h2>
            <p className="mt-1 text-sm text-[#667085]">
              Las fechas se interpretan en la zona horaria de Bogotá.
            </p>
          </div>
          {report ? (
            <Badge className="mt-2 self-start sm:mt-0" tone="neutral">
              {report.period.label}
            </Badge>
          ) : null}
        </div>

        <Tabs className="mt-4" aria-label="Agrupación del periodo">
          {PERIOD_TABS.map((tab) => (
            <button
              key={tab.value}
              id={`period-tab-${tab.value}`}
              type="button"
              role="tab"
              aria-selected={mode === tab.value}
              aria-controls="period-filter-panel"
              tabIndex={mode === tab.value ? 0 : -1}
              disabled={loading}
              onClick={() => setMode(tab.value)}
              onKeyDown={handlePeriodTabKeyDown}
            >
              {tab.label}
            </button>
          ))}
        </Tabs>

        <form
          id="period-filter-panel"
          role="tabpanel"
          aria-labelledby={`period-tab-${mode}`}
          className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,1fr)_auto_auto] lg:items-end"
          onSubmit={submitFilters}
        >
          <div>
            {mode === "day" ? (
              <label htmlFor="report-day" className="block text-xs font-bold text-[#475467]">
                Día
                <span className="relative mt-2 block">
                  <CalendarDays aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
                  <Input
                    id="report-day"
                    type="date"
                    className="!pl-10"
                    value={day}
                    disabled={loading}
                    onChange={(event) => setDay(event.target.value)}
                    required
                  />
                </span>
              </label>
            ) : null}

            {mode === "month" ? (
              <label htmlFor="report-month" className="block text-xs font-bold text-[#475467]">
                Mes
                <span className="relative mt-2 block">
                  <CalendarDays aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
                  <Input
                    id="report-month"
                    type="month"
                    className="!pl-10"
                    value={month}
                    disabled={loading}
                    onChange={(event) => setMonth(event.target.value)}
                    required
                  />
                </span>
              </label>
            ) : null}

            {mode === "range" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label htmlFor="report-from" className="block text-xs font-bold text-[#475467]">
                  Desde
                  <Input
                    id="report-from"
                    type="date"
                    className="mt-2"
                    value={from}
                    disabled={loading}
                    onChange={(event) => setFrom(event.target.value)}
                    required
                  />
                </label>
                <label htmlFor="report-to" className="block text-xs font-bold text-[#475467]">
                  Hasta (incluido)
                  <Input
                    id="report-to"
                    type="date"
                    className="mt-2"
                    value={to}
                    disabled={loading}
                    onChange={(event) => setTo(event.target.value)}
                    required
                  />
                </label>
              </div>
            ) : null}
          </div>

          <label htmlFor="report-ally" className="block text-xs font-bold text-[#475467]">
            Aliado
            <span className="relative mt-2 block">
              <Building2 aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-[#667085]" strokeWidth={1.8} />
              <Select
                id="report-ally"
                className="!pl-10"
                value={allyId}
                disabled={loading}
                onChange={(event) => setAllyId(event.target.value)}
              >
                <option value="">Todos los aliados</option>
                {allyOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}{option.code ? ` · ${option.code}` : ""}
                  </option>
                ))}
              </Select>
            </span>
          </label>

          <Button type="submit" disabled={loading} className="w-full whitespace-nowrap lg:w-auto">
            <Filter aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
            {loading ? "Consultando" : "Consultar"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            className="w-full whitespace-nowrap lg:w-auto"
            onClick={resetFilters}
          >
            <RotateCcw aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
            Restablecer
          </Button>
        </form>
      </Card>

      {loading ? (
        <Card className="mt-4 !rounded-lg !p-5">
          <LoadingState label="Calculando consultas y ventas por aliado..." />
        </Card>
      ) : error ? (
        <div className="mt-4" role="alert">
          <EmptyState
            className="bg-white"
            title="No pudimos cargar el reporte"
            description={error}
            action={
              lastRequest ? (
                <Button variant="secondary" className="mt-2" onClick={() => void loadReport(lastRequest)}>
                  <RefreshCw aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                  Reintentar
                </Button>
              ) : null
            }
          />
        </div>
      ) : report ? (
        <section className="mt-5" aria-labelledby="report-results-title">
          <p className="sr-only" role="status">
            Reporte cargado para {report.period.label}: {formatCount(report.rows.length)} aliados,
            {" "}{formatCount(report.summary.originalQueries)} consultas nuevas y
            {" "}{formatCount(report.summary.sales)} ventas finalizadas.
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 id="report-results-title" className="text-lg font-black text-[#151a21]">
                Resultado por aliado
              </h2>
              <p className="mt-1 text-sm text-[#667085]">
                {report.period.label} · {reportedAllyName}
              </p>
            </div>
            <Badge tone={report.provider.isProduction ? "positive" : "warning"}>
              Ambiente {report.provider.environment}
            </Badge>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              className="!rounded-lg !p-5"
              label={
                <span className="flex items-center gap-2">
                  <FileSearch aria-hidden="true" className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                  Consultas nuevas
                </span>
              }
              value={<span className="!text-3xl tabular-nums">{formatCount(report.summary.originalQueries)}</span>}
              detail="Consultas originales registradas"
            />
            <MetricCard
              className="!rounded-lg !p-5"
              label={
                <span className="flex items-center gap-2">
                  <RefreshCw aria-hidden="true" className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                  Reutilizadas sin cobro
                </span>
              }
              value={<span className="!text-3xl tabular-nums">{formatCount(report.summary.reusedAssessments)}</span>}
              detail="Respuestas vigentes reutilizadas"
            />
            <MetricCard
              className="!rounded-lg !p-5"
              label={
                <span className="flex items-center gap-2">
                  <CircleDollarSign aria-hidden="true" className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                  Ventas finalizadas
                </span>
              }
              value={<span className="!text-3xl tabular-nums">{formatCount(report.summary.sales)}</span>}
              detail="Créditos DataCrédito no anulados"
            />
            <MetricCard
              className="!rounded-lg !p-5"
              label={
                <span className="flex items-center gap-2">
                  <BarChart3 aria-hidden="true" className="h-4 w-4 text-[#5c7a13]" strokeWidth={1.8} />
                  Ventas / consultas
                </span>
              }
              value={
                <span className="!text-3xl tabular-nums">
                  {formatPercent(
                    report.summary.salesVsOriginalQueriesPercent,
                    report.summary.originalQueries
                  )}
                </span>
              }
              detail="Ventas finalizadas / consultas nuevas"
            />
          </div>

          {report.rows.length ? (
            <Card className="mt-4 overflow-hidden !rounded-lg !p-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e4e7ec] px-4 py-4 sm:px-5">
                <div>
                  <h3 className="font-black text-[#151a21]">Detalle operativo</h3>
                  <p className="mt-1 text-xs text-[#667085]">
                    {report.rows.length} {report.rows.length === 1 ? "resultado" : "resultados"}
                  </p>
                </div>
                <span className="text-xs font-semibold text-[#667085]">Zona horaria: {report.period.timezone}</span>
              </div>

              <div className="divide-y divide-[#e4e7ec] lg:hidden">
                {report.rows.map((row) => (
                  <article key={`${row.allyId ?? "none"}-${row.allyName}`} className="px-4 py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="truncate font-black text-[#151a21]">{row.allyName}</h4>
                        <p className="mt-1 text-xs text-[#667085]">{row.allyCode || "Sin código"}</p>
                      </div>
                      <Badge tone={row.active === true ? "positive" : "neutral"}>{activityLabel(row)}</Badge>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-md bg-[#f7f8f8] px-3 py-3">
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#667085]">Consultas nuevas</dt>
                        <dd className="mt-1 text-lg font-black tabular-nums text-[#151a21]">{formatCount(row.originalQueries)}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#667085]">Reutilizadas</dt>
                        <dd className="mt-1 text-lg font-black tabular-nums text-[#151a21]">{formatCount(row.reusedAssessments)}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#667085]">Ventas</dt>
                        <dd className="mt-1 text-lg font-black tabular-nums text-[#151a21]">{formatCount(row.sales)}</dd>
                      </div>
                      <div>
                        <dt className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#667085]">Ventas / consultas</dt>
                        <dd className="mt-1 text-lg font-black tabular-nums text-[#151a21]">
                          {formatPercent(row.salesVsOriginalQueriesPercent, row.originalQueries)}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>

              <DataTable className="hidden !rounded-none !border-0 lg:block">
                <table className="w-full min-w-[820px] text-sm">
                  <caption className="sr-only">
                    Consultas DataCrédito y ventas finalizadas por aliado
                  </caption>
                  <thead className="bg-[#151a21] text-white">
                    <tr>
                      <th scope="col" className="px-5 py-3.5 text-left text-[11px] font-bold uppercase tracking-[0.08em]">Aliado</th>
                      <th scope="col" className="px-4 py-3.5 text-right text-[11px] font-bold uppercase tracking-[0.08em]">Consultas nuevas</th>
                      <th scope="col" className="px-4 py-3.5 text-right text-[11px] font-bold uppercase tracking-[0.08em]">Reutilizadas sin cobro</th>
                      <th scope="col" className="px-4 py-3.5 text-right text-[11px] font-bold uppercase tracking-[0.08em]">Ventas finalizadas</th>
                      <th scope="col" className="px-5 py-3.5 text-right text-[11px] font-bold uppercase tracking-[0.08em]">Ventas / consultas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e4e7ec]">
                    {report.rows.map((row) => (
                      <tr key={`${row.allyId ?? "none"}-${row.allyName}`} className="bg-white transition-colors even:bg-[#fbfcfa] hover:bg-[#f6f9ef]">
                        <th scope="row" className="px-5 py-4 text-left font-normal">
                          <div className="flex items-center gap-3">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-[#eef1f4] text-[#344054]">
                              <Building2 aria-hidden="true" className="h-4 w-4" strokeWidth={1.8} />
                            </span>
                            <span className="min-w-0">
                              <strong className="block truncate text-[#151a21]">{row.allyName}</strong>
                              <span className="mt-1 flex items-center gap-2 text-xs text-[#667085]">
                                {row.allyCode || "Sin código"}
                                <span aria-hidden="true">·</span>
                                {activityLabel(row)}
                              </span>
                            </span>
                          </div>
                        </th>
                        <td className="px-4 py-4 text-right font-bold tabular-nums text-[#344054]">{formatCount(row.originalQueries)}</td>
                        <td className="px-4 py-4 text-right font-bold tabular-nums text-[#344054]">{formatCount(row.reusedAssessments)}</td>
                        <td className="px-4 py-4 text-right font-black tabular-nums text-[#151a21]">{formatCount(row.sales)}</td>
                        <td className="px-5 py-4 text-right font-black tabular-nums text-[#151a21]">
                          {formatPercent(row.salesVsOriginalQueriesPercent, row.originalQueries)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            </Card>
          ) : (
            <EmptyState
              className="mt-4 bg-white"
              title="No hay información para este periodo"
              description="Prueba otro día, mes, rango o aliado para consultar actividad."
            />
          )}

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="flex items-start gap-3 rounded-lg border border-[#d6e4fb] bg-[#f5f8ff] px-4 py-3 text-xs leading-5 text-[#475467]">
              <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#4169a1]" strokeWidth={1.8} />
              <p>
                Esta relación compara eventos del periodo; no es una conversión de cohorte. Una venta puede usar una consulta realizada hasta 15 días antes, por lo que el porcentaje puede superar 100 %.
              </p>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-[#e4e7ec] bg-white px-4 py-3 text-xs leading-5 text-[#475467]">
              <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[#5c7a13]" strokeWidth={1.8} />
              <p>
                Historial disponible según la retención vigente de {formatCount(report.retentionDays)} días. Ambiente del proveedor: <strong>{report.provider.environment}</strong>. {report.provider.configured ? "Configuración disponible" : "Sin configuración completa"} y {report.provider.enabled ? "servicio habilitado" : "servicio deshabilitado"}.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <EmptyState
          className="mt-4 bg-white"
          title="Consulta un periodo"
          description="Selecciona los filtros para ver consultas y ventas por aliado."
        />
      )}
    </main>
  );
}
