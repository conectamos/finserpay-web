"use client";

import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, LoadingState, ProgressBar, Select } from "@/app/_components/finser-ui";
import { SOLICITUD_FILTER_STATES, SOLICITUD_STATE_LABELS } from "@/lib/solicitudes";
import type { FilterOption, FormFilters } from "./solicitudes-wall-client";
import {
  changeExportSelection, exportFiltersFromWall, visibleExportOptions,
  type ExportFilters, type ExportOption, type ExportOptions,
} from "./solicitudes-export-state";
import styles from "./solicitudes-export.module.css";

type OptionsResponse = {
  options: ExportOptions;
  scope: "CENTRAL_ADMIN" | "ALLY_ADMIN";
  scopeLabel: string;
};
type ExportJob = {
  id: string;
  status: "PENDING" | "PROCESSING" | "READY" | "FAILED";
  count: number;
  processed: number;
  error?: string;
  filename?: string;
};

const number = (value: number) => new Intl.NumberFormat("es-CO").format(value);
const isRunning = (job: ExportJob | null) => job?.status === "PENDING" || job?.status === "PROCESSING";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "No fue posible completar la solicitud.";

class ExportRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ExportRequestError(payload?.error || "No fue posible completar la solicitud.", response.status);
  if (!payload) throw new Error("El servidor devolvió una respuesta vacía. Intenta nuevamente.");
  return payload as T;
}

function MultipleSelection({ label, allLabel, options, selected, onChange, context }: {
  label: string;
  allLabel: string;
  options: ExportOption[];
  selected: number[];
  onChange: (selected: number[]) => void;
  context?: (id: number) => string | undefined;
}) {
  return <fieldset className={styles.selection}>
    <legend>{label}</legend>
    <details>
      <summary>{selected.length ? `${number(selected.length)} ${selected.length === 1 ? "seleccionado" : "seleccionados"}` : allLabel}</summary>
      <div className={styles.choices}>
        <label className={styles.choice}>
          <input type="checkbox" checked={!selected.length} onChange={() => onChange([])} />
          <span>{allLabel}</span>
        </label>
        {options.map(option => <label className={styles.choice} key={option.id}>
          <input type="checkbox" checked={selected.includes(option.id)} onChange={event =>
            onChange(event.target.checked ? [...selected, option.id] : selected.filter(id => id !== option.id))
          } />
          <span>{option.nombre}{context?.(option.id) && <small>{context(option.id)}</small>}</span>
        </label>)}
        {!options.length && <p>Sin opciones disponibles para este alcance.</p>}
      </div>
    </details>
  </fieldset>;
}

export default function SolicitudesExport({ appliedFilters, plataformas = [] }: {
  appliedFilters: FormFilters;
  plataformas?: FilterOption[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const creationController = useRef<AbortController | null>(null);
  const sourceWallFilters = useRef("");
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ExportFilters>(() => exportFiltersFromWall(appliedFilters));
  const [configuration, setConfiguration] = useState<OptionsResponse | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [optionsReload, setOptionsReload] = useState(0);
  const [countResult, setCountResult] = useState<{ key: string; count: number } | null>(null);
  const [countError, setCountError] = useState<{ key: string; message: string } | null>(null);
  const [countReload, setCountReload] = useState(0);
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [generationError, setGenerationError] = useState("");
  const [pollError, setPollError] = useState("");
  const [pollReload, setPollReload] = useState(0);
  const filtersKey = JSON.stringify(filters);
  const jobId = job?.id;
  const jobStatus = job?.status;
  const busy = creating || isRunning(job);
  const validationError = filters.period === "month" && !/^\d{4}-\d{2}$/.test(filters.month)
    ? "Selecciona el mes y el año."
    : filters.period === "range" && !filters.desde && !filters.hasta
      ? "Selecciona al menos una fecha o elige todo el histórico."
      : filters.period === "range" && filters.desde && filters.hasta && filters.desde > filters.hasta
        ? "La fecha inicial debe ser anterior o igual a la fecha final."
        : "";
  const count = countResult?.key === filtersKey ? countResult.count : null;
  const currentCountError = countError?.key === filtersKey ? countError.message : "";
  const shownCount = job && job.status !== "FAILED" ? job.count : count;

  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    else if (!open && element?.open) element.close();
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  useEffect(() => () => creationController.current?.abort(), []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/solicitudes/export/options", { cache: "no-store", signal: controller.signal })
      .then(readResponse<OptionsResponse>)
      .then(payload => { if (!controller.signal.aborted) setConfiguration(payload); })
      .catch(error => { if (!controller.signal.aborted) setOptionsError(errorMessage(error)); });
    return () => controller.abort();
  }, [open, optionsReload]);

  useEffect(() => {
    if (!open || !configuration || validationError || busy || (job && job.status === "READY")) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch("/api/solicitudes/export/count", {
        method: "POST", headers: { "Content-Type": "application/json" },
        cache: "no-store", signal: controller.signal,
        body: JSON.stringify({ filters: JSON.parse(filtersKey) }),
      })
        .then(readResponse<{ count: number }>)
        .then(payload => {
          if (!Number.isSafeInteger(payload.count) || payload.count < 0) throw new Error("El conteo recibido no es válido.");
          if (!controller.signal.aborted) setCountResult({ key: filtersKey, count: payload.count });
        })
        .catch(error => {
          if (!controller.signal.aborted) setCountError({ key: filtersKey, message: errorMessage(error) });
        });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, configuration, filtersKey, validationError, countReload, busy, job]);

  useEffect(() => {
    if (!open || !jobId || (jobStatus !== "PENDING" && jobStatus !== "PROCESSING")) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/solicitudes/export/${encodeURIComponent(jobId!)}`, {
          cache: "no-store", signal: controller.signal,
        });
        const payload = await readResponse<{ job: ExportJob }>(response);
        if (controller.signal.aborted) return;
        setJob(payload.job);
        if (isRunning(payload.job)) timer = setTimeout(poll, 2000);
      } catch (error) {
        if (!controller.signal.aborted) setPollError(errorMessage(error));
      }
    }
    timer = setTimeout(poll, 500);
    return () => { if (timer) clearTimeout(timer); controller.abort(); };
  }, [open, jobId, jobStatus, pollReload]);

  function openModal() {
    setConfiguration(null);
    setOptionsError("");
    setPollError("");
    const appliedKey = JSON.stringify(appliedFilters);
    if (!busy && (job?.status !== "READY" || sourceWallFilters.current !== appliedKey)) {
      sourceWallFilters.current = appliedKey;
      setFilters(exportFiltersFromWall(appliedFilters));
      setCountResult(null);
      setCountError(null);
      setGenerationError("");
      setPollError("");
      setJob(null);
    }
    setOpen(true);
  }

  function updateFilters(next: ExportFilters) {
    setFilters(next);
    setCountResult(null);
    setCountError(null);
    setJob(null);
    setGenerationError("");
    setPollError("");
  }

  function setField<K extends keyof ExportFilters>(key: K, value: ExportFilters[K]) {
    updateFilters({ ...filters, [key]: value });
  }

  async function generate() {
    if (busy || !count || validationError || !configuration || currentCountError) return;
    setCreating(true);
    setGenerationError("");
    setJob(null);
    const controller = new AbortController();
    creationController.current = controller;
    try {
      const response = await fetch("/api/solicitudes/export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ filters, expectedCount: count }),
      });
      const payload = await readResponse<{ job: ExportJob }>(response);
      if (!controller.signal.aborted) setJob(payload.job);
    } catch (error) {
      if (controller.signal.aborted) return;
      setGenerationError(errorMessage(error));
      if (error instanceof ExportRequestError && error.status === 409) {
        setCountResult(null);
        setCountReload(value => value + 1);
      }
    } finally {
      if (!controller.signal.aborted) setCreating(false);
    }
  }

  const visible = configuration ? visibleExportOptions(configuration.options, filters) : null;
  const platformOptions = plataformas.map(option => typeof option === "object"
    ? { value: String(option.value ?? option.id ?? ""), label: String(option.label ?? option.nombre ?? option.value ?? option.id ?? "") }
    : { value: String(option), label: String(option) });
  if (filters.plataforma && !platformOptions.some(option => option.value === filters.plataforma)) {
    platformOptions.push({ value: filters.plataforma, label: filters.plataforma });
  }

  return <>
    <Button variant="secondary" className={styles.trigger} aria-haspopup="dialog" onClick={openModal}>
      <Download aria-hidden="true" />Descargar base
    </Button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="export-solicitudes-title" aria-describedby="export-solicitudes-description"
      onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header className={styles.header}>
        <div><h2 id="export-solicitudes-title">Descargar base de clientes</h2>
          <p id="export-solicitudes-description">Una fila por solicitud, con los datos de su cliente. Se incluyen todos los resultados filtrados.</p>
        </div>
        <Button variant="ghost" className={styles.close} aria-label="Cerrar descarga" onClick={() => setOpen(false)}><X aria-hidden="true" /></Button>
      </header>
      <div className={styles.body}>
        {optionsError ? <><p className={styles.error} role="alert">{optionsError}</p><Button variant="secondary" onClick={() => { setConfiguration(null); setOptionsError(""); setOptionsReload(value => value + 1); }}>Reintentar</Button></>
          : !configuration ? <LoadingState label="Consultando tu alcance autorizado…" />
            : <>
              <dl className={styles.scope}><dt>Alcance de la descarga</dt><dd>{configuration.scopeLabel}</dd></dl>
              <fieldset className={styles.fields} disabled={busy} aria-label="Filtros de la descarga">
                <label className={`${styles.field} ${styles.full}`}><span>Periodo</span>
                  <Select value={filters.period} onChange={event => setField("period", event.target.value as ExportFilters["period"])}>
                    <option value="all">Todo el histórico autorizado</option><option value="month">Mes y año</option><option value="range">Rango de fechas</option>
                  </Select>
                </label>
                {filters.period === "month" && <label className={`${styles.field} ${styles.full}`}><span>Mes y año</span><Input type="month" value={filters.month} onChange={event => setField("month", event.target.value)} /></label>}
                {filters.period === "range" && <>
                  <label className={styles.field}><span>Desde</span><Input type="date" value={filters.desde} max={filters.hasta || undefined} onChange={event => setField("desde", event.target.value)} /></label>
                  <label className={styles.field}><span>Hasta</span><Input type="date" value={filters.hasta} min={filters.desde || undefined} onChange={event => setField("hasta", event.target.value)} /></label>
                </>}
                <p className={`${styles.hint} ${styles.full}`}>El periodo se aplica a la fecha del crédito finalizado o a la fecha de solicitud si aún es un borrador, en hora de Bogotá. Incluye completos los días inicial y final.{filters.period === "range" && " Puedes dejar un extremo vacío para no limitarlo."}</p>
                {configuration.scope === "CENTRAL_ADMIN" && <MultipleSelection label="Aliados" allLabel="Todos los aliados autorizados" options={configuration.options.aliados} selected={filters.aliadoIds} onChange={ids => updateFilters(changeExportSelection(filters, configuration.options, "aliadoIds", ids))} />}
                <MultipleSelection label="Sedes" allLabel="Todas las sedes autorizadas" options={visible!.sedes} selected={filters.sedeIds} context={id => {
                  const sede = configuration.options.sedes.find(option => option.id === id);
                  return configuration.scope === "CENTRAL_ADMIN" ? configuration.options.aliados.find(option => option.id === sede?.aliadoId)?.nombre : undefined;
                }} onChange={ids => updateFilters(changeExportSelection(filters, configuration.options, "sedeIds", ids))} />
                <MultipleSelection label="Vendedores" allLabel="Todos los vendedores autorizados" options={visible!.vendedores} selected={filters.vendedorIds} onChange={ids => updateFilters(changeExportSelection(filters, configuration.options, "vendedorIds", ids))} />
                <label className={styles.field}><span>Estado de solicitud</span><Select value={filters.estado} onChange={event => setField("estado", event.target.value)}>
                  <option value="">Todos los estados</option>{SOLICITUD_FILTER_STATES.map(state => <option key={state} value={state}>{state === "PROCESO" ? "En proceso" : SOLICITUD_STATE_LABELS[state]}</option>)}
                </Select></label>
                <label className={styles.field}><span>Plataforma</span><Select value={filters.plataforma} onChange={event => setField("plataforma", event.target.value)}>
                  <option value="">Todas las plataformas</option>{platformOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select></label>
                <label className={styles.field}><span>Buscar</span><Input type="search" value={filters.q} onChange={event => setField("q", event.target.value)} placeholder="Nombre, cédula, solicitud o IMEI" /></label>
              </fieldset>
              <div className={styles.feedback} aria-live="polite" aria-atomic="true">
                {validationError ? <p className={styles.error}>{validationError}</p>
                  : currentCountError ? <><p className={styles.error}>{currentCountError}</p><Button variant="secondary" onClick={() => { setCountResult(null); setCountError(null); setCountReload(value => value + 1); }}>Reintentar conteo</Button></>
                    : shownCount === null ? <LoadingState label="Contando registros…" />
                      : <><p className={styles.count}><strong>{number(shownCount)}</strong>{shownCount === 1 ? "registro a exportar" : "registros a exportar"}</p>
                        {shownCount === 0 && <p className={styles.hint}>No hay solicitudes para estos filtros. Ajusta el alcance o el periodo.</p>}</>}
              </div>
            </>}
        {generationError && <p className={styles.error} role="alert">{generationError}</p>}
        {creating && <LoadingState label="Iniciando la descarga…" />}
        {job && <div className={styles.job} role="status" aria-live="polite">
          {isRunning(job) && <>
            <Badge tone="warning">{job.status === "PENDING" ? "En cola" : "Generando Excel"}</Badge>
            <ProgressBar label="Generación del archivo Excel" value={job.count ? job.processed / job.count * 100 : 0} />
            <p>{number(job.processed)} de {number(job.count)} registros procesados. Puedes cerrar esta ventana y volver a abrirla para consultar el estado.</p>
          </>}
          {job.status === "READY" && <><Badge tone="positive">Archivo listo</Badge><p>El Excel contiene {number(job.count)} {job.count === 1 ? "solicitud" : "solicitudes"}. Descárgalo con el botón inferior.</p></>}
          {job.status === "FAILED" && <p className={styles.error}>{job.error || "No fue posible generar el archivo. Intenta nuevamente."}</p>}
        </div>}
        {pollError && <><p className={styles.error} role="alert">{pollError} La consulta del estado se ha pausado.</p><Button variant="secondary" onClick={() => { setPollError(""); setPollReload(value => value + 1); }}>Consultar estado</Button></>}
      </div>
      <footer className={styles.footer}>
        <Button variant="secondary" onClick={() => setOpen(false)}>Cerrar</Button>
        {job?.status === "READY" ? <a className={`fp-ui-button is-primary ${styles.download}`} href={`/api/solicitudes/export/${encodeURIComponent(job.id)}/download`} download={job.filename || true}><Download aria-hidden="true" />Descargar Excel</a>
          : <Button onClick={generate} disabled={busy || !configuration || !count || Boolean(validationError || currentCountError)}><Download aria-hidden="true" />{busy ? "Preparando Excel…" : "Descargar Excel"}</Button>}
      </footer>
    </dialog>
  </>;
}
