"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Database,
  FilePenLine,
  Filter,
  History,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
} from "@/app/_components/finser-ui";
import SharedNoveltyHistory from "@/app/revision-creditos/shared-novelty-history";
import SharedApprovalWorkspace from "@/app/revision-creditos/shared-approval-workspace";
import { creditDisplayNumber } from "@/lib/credit-display-number";
import type {
  ApprovalDetail,
  ApprovalQueueItem,
  ApprovalView,
} from "./approval-client";

type Props = {
  view: ApprovalView;
  counts: { pending: number; approved: number } | null;
  query: string;
  items: ApprovalQueueItem[];
  selectedId: number | null;
  selectedItem: ApprovalQueueItem | null;
  detail: ApprovalDetail | null;
  queueLoaded: boolean;
  searching: boolean;
  searchError: string;
  nextCursor: string | null;
  loadingDetail: boolean;
  detailError: string;
  busy: boolean;
  correctionDisabled: boolean;
  notice: { text: string; warning: boolean } | null;
  onSelect: (id: number) => void;
  onView: (view: ApprovalView) => void;
  onSearch: (query: string) => void;
  onFilters: (filters: { aliado?: string; desde?: string; hasta?: string }) => void;
  onRefresh: () => void;
  onMore: () => void;
  onBack: () => void;
  onRetryDetail: () => void;
  onUpdated: () => Promise<void>;
  onCorrectionBusy: (busy: boolean) => void;
  onOpenSadmin?: () => void;
  callPanel: ReactNode;
  noveltyPanel: ReactNode;
  signaturePanel: ReactNode;
  approvalPanel: ReactNode;
  confirmationDialog: ReactNode;
};

const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

type DatePreset = "all" | "today" | "7d" | "30d" | "custom";

function bogotaDateInput(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Bogota",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return [value.year, value.month, value.day].join("-");
}

function displayDate(value: string | null | undefined) {
  if (!value) return "No disponible";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateTime.format(parsed) : "No disponible";
}

function elapsedLabel(value: string | null | undefined, now: number) {
  if (!value) return "Sin registro";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "Sin registro";
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function statusLabel(item: ApprovalQueueItem) {
  if (item.status === "APPROVED") return "Lista para liquidar";
  if (item.novelty?.status === "WAITING_ALLY") return "Corrección requerida";
  if (item.novelty?.status === "RESPONDED") return "Corrección atendida";
  if (item.reissue?.blocked) return "Firma pendiente";
  return "Pendiente de revisión";
}

function attentionLabel(item: ApprovalQueueItem) {
  if (item.novelty?.status === "WAITING_ALLY") return "Corrección requerida";
  if (item.novelty?.status === "RESPONDED") return "Respuesta por verificar";
  if (item.reissue?.blocked) return "Firma pendiente";
  return "Pendiente de revisión";
}

function operationHref(path: string, detail: ApprovalDetail) {
  const lookup = creditDisplayNumber(detail) || detail.clienteDocumento || "";
  return `${path}?buscar=${encodeURIComponent(lookup)}`;
}

const deskSections = [
  { href: "/dashboard/aprobaciones", label: "Solicitudes", icon: ClipboardList },
  { href: "/dashboard/aprobaciones/cambio-imei", label: "Cambio de IMEI", icon: Smartphone },
  { href: "/dashboard/aprobaciones/firma-seguro", label: "Gestionar firma", icon: FilePenLine },
  { href: "/dashboard/aprobaciones/liberar-consulta", label: "Liberar consulta", icon: ShieldCheck },
  { href: "/dashboard/aprobaciones/sadmin", label: "Creación Sadmin", icon: Database },
] as const;

export default function AnalystApprovalWorkspace(props: Props) {
  const [searchText, setSearchText] = useState(props.query);
  const [allyFilter, setAllyFilter] = useState("");
  const [catalogAllies, setCatalogAllies] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [detailTab, setDetailTab] = useState<"summary" | "history" | "actions">("summary");
  const [fullReview, setFullReview] = useState(false);
  const [filterNow] = useState(() => Date.now());

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/aprobaciones/aliados", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null) as { ok?: boolean; items?: unknown } | null;
        if (!response.ok || !result?.ok || !Array.isArray(result.items)) return [];
        return result.items.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
      })
      .then((items) => {
        if (!controller.signal.aborted) setCatalogAllies(items);
      })
      .catch(() => { /* La cola sigue disponible si el catálogo no responde. */ });
    return () => controller.abort();
  }, []);

  const allies = useMemo(
    () => [...new Set([...catalogAllies, ...props.items.map((item) => item.aliadoNombre).filter(Boolean), ...(allyFilter ? [allyFilter] : [])])].sort((a, b) => a.localeCompare(b, "es")),
    [allyFilter, catalogAllies, props.items]
  );

  const visibleItems = props.items;

  const attentionItems = props.items
    .filter((item) => item.status === "PENDING")
    .sort((a, b) => {
      const priority = (item: ApprovalQueueItem) => item.novelty?.status === "WAITING_ALLY" ? 0 : item.reissue?.blocked ? 1 : 2;
      return priority(a) - priority(b);
    })
    .slice(0, 3);

  const selectedQueueItem = props.selectedItem?.id === props.detail?.id
    ? props.selectedItem
    : props.items.find((item) => item.id === props.detail?.id) || null;

  function applyDatePreset(value: DatePreset) {
    setDatePreset(value);
    if (value === "custom") {
      setShowMoreFilters(true);
      return;
    }
    const to = value === "all" ? "" : bogotaDateInput();
    const from = value === "7d" ? bogotaDateInput(6) : value === "30d" ? bogotaDateInput(29) : to;
    setDateFrom(from);
    setDateTo(to);
    props.onFilters({ aliado: allyFilter, desde: from, hasta: to });
  }

  if (fullReview && props.detail) {
    return <div className="min-w-0 bg-[var(--fp-bg)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--fp-border)] bg-[var(--fp-surface)] px-4 py-3 sm:px-6 lg:px-8">
        <div><p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--fp-muted)]">Revisión completa</p><h1 className="mt-1 text-xl font-black">Expediente {creditDisplayNumber(props.detail)}</h1></div>
        <Button variant="secondary" onClick={() => setFullReview(false)} disabled={props.busy}><ArrowLeft className="h-4 w-4" aria-hidden="true" />Volver a la mesa</Button>
      </div>
      <SharedApprovalWorkspace {...props} onBack={() => { setFullReview(false); props.onBack(); }} />
    </div>;
  }

  return (
    <main className="min-w-0 text-[var(--fp-graphite)]">
      <header className="min-w-0 border-b border-[var(--fp-border)] bg-[var(--fp-surface)] px-4 py-5 sm:px-6 lg:px-7 xl:px-8">
        <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0">
            <h1 className="text-[clamp(1.75rem,2.4vw,2.35rem)] font-black tracking-[-0.035em]">Aprobaciones</h1>
            <p className="mt-1 text-sm text-[var(--fp-muted)] sm:text-base">Revisa y gestiona las solicitudes de crédito de nuestros aliados.</p>
          </div>
          <form
            role="search"
            className="flex min-w-0 w-full max-w-xl items-center gap-2 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] px-3 shadow-[var(--fp-shadow-sm)]"
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.busy) props.onSearch(searchText.trim());
            }}
          >
            <Search className="h-5 w-5 shrink-0 text-[var(--fp-muted)]" aria-hidden="true" />
            <label className="sr-only" htmlFor="analyst-approval-search">Buscar por cédula, crédito o IMEI</label>
            <Input
              id="analyst-approval-search"
              type="search"
              autoComplete="off"
              maxLength={100}
              placeholder="Buscar cédula, crédito o IMEI"
              value={searchText}
              disabled={props.busy}
              onChange={(event) => setSearchText(event.target.value)}
              className="min-h-12 !w-auto min-w-0 flex-1 border-0 bg-transparent shadow-none"
            />
            <Button variant="ghost" type="submit" disabled={props.busy || props.searching}>Buscar</Button>
          </form>
        </div>
      </header>

      <nav className="overflow-x-auto border-b border-[var(--fp-border)] bg-[var(--fp-surface)] px-4 sm:px-6 lg:px-7 xl:px-8" aria-label="Gestiones de aprobaciones">
        <div className="flex min-w-max">
          {deskSections.map(({ href, label, icon: Icon }) => {
            const active = href === "/dashboard/aprobaciones";
            return <Link key={href} href={href} aria-current={active ? "page" : undefined}
              className={`flex min-h-14 items-center gap-2 border-b-2 px-4 text-sm font-bold transition ${active ? "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] text-[var(--fp-graphite)]" : "border-transparent text-[var(--fp-muted)] hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)]"}`}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </Link>;
          })}
        </div>
      </nav>

      <div className="grid min-w-0 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0 border-b border-[var(--fp-border)] xl:border-b-0 xl:border-r" aria-label="Mesa de solicitudes">
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--fp-border)] px-4 py-4 sm:px-6 lg:px-7 xl:px-8">
            <label className="sr-only" htmlFor="analyst-status-filter">Estado</label>
            <Select id="analyst-status-filter" value={props.view} disabled={props.busy}
              onChange={(event) => props.onView(event.target.value as ApprovalView)} className="!w-auto min-w-44">
              <option value="pending">Pendientes</option>
              <option value="approved">Listas para liquidar</option>
            </Select>
            <label className="sr-only" htmlFor="analyst-ally-filter">Aliado</label>
            <Select id="analyst-ally-filter" value={allyFilter} disabled={props.busy}
              onChange={(event) => {
                const value = event.target.value;
                setAllyFilter(value);
                props.onFilters({ aliado: value, desde: dateFrom, hasta: dateTo });
              }} className="!w-auto min-w-44">
              <option value="">Todos los aliados</option>
              {allies.map((ally) => <option key={ally} value={ally}>{ally}</option>)}
            </Select>
            <label className="sr-only" htmlFor="analyst-date-filter">Fecha</label>
            <Select id="analyst-date-filter" value={datePreset} disabled={props.busy}
              onChange={(event) => applyDatePreset(event.target.value as DatePreset)} className="!w-auto min-w-40">
              <option value="all">Todas las fechas</option>
              <option value="today">Hoy</option>
              <option value="7d">Últimos 7 días</option>
              <option value="30d">Últimos 30 días</option>
              {datePreset === "custom" ? <option value="custom">Rango personalizado</option> : null}
            </Select>
            <Button variant="secondary" aria-expanded={showMoreFilters} onClick={() => setShowMoreFilters((value) => !value)}>
              <Filter className="h-4 w-4" aria-hidden="true" />Más filtros
            </Button>
            <Button variant="ghost" className="ml-auto" disabled={props.busy || props.searching} onClick={props.onRefresh}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar
            </Button>
          </div>

          {showMoreFilters ? <div className="flex flex-wrap items-end gap-3 border-b border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-sm text-[var(--fp-muted)] sm:px-6 lg:px-7 xl:px-8">
            <label className="space-y-1"><span className="block text-xs font-bold uppercase tracking-[0.08em]">Fecha desde</span><Input type="date" value={dateFrom} max={dateTo || undefined} disabled={props.busy} onChange={(event) => { const value = event.target.value; setDateFrom(value); setDatePreset("custom"); if (!dateTo || !value || value <= dateTo) props.onFilters({ aliado: allyFilter, desde: value, hasta: dateTo }); }} className="!w-auto min-w-40" /></label>
            <label className="space-y-1"><span className="block text-xs font-bold uppercase tracking-[0.08em]">Fecha hasta</span><Input type="date" value={dateTo} min={dateFrom || undefined} disabled={props.busy} onChange={(event) => { const value = event.target.value; setDateTo(value); setDatePreset("custom"); if (!dateFrom || !value || dateFrom <= value) props.onFilters({ aliado: allyFilter, desde: dateFrom, hasta: value }); }} className="!w-auto min-w-40" /></label>
            <span className="pb-3">{visibleItems.length} solicitudes visibles con los filtros aplicados.</span>
            <Button variant="ghost" className="ml-auto" onClick={() => { setAllyFilter(""); setDateFrom(""); setDateTo(""); setDatePreset("all"); setSearchText(""); props.onSearch(""); props.onFilters({}); }}>Limpiar filtros</Button>
          </div> : null}

          {props.notice ? <div role={props.notice.warning ? "alert" : "status"} className={`m-4 rounded-[var(--fp-radius-md)] border px-4 py-3 text-sm sm:mx-6 lg:mx-7 xl:mx-8 ${props.notice.warning ? "border-[var(--fp-amber)] bg-[var(--fp-amber-soft)]" : "border-[var(--fp-lime)] bg-[var(--fp-lime-soft)]"}`}>{props.notice.text}</div> : null}
          {props.searchError ? <div role="alert" className="m-4 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-3 text-sm sm:mx-6 lg:mx-7 xl:mx-8">{props.searchError}</div> : null}
          {props.searching ? <div className="p-6"><LoadingState label="Actualizando solicitudes..." /></div> : null}
          {!props.searching && props.queueLoaded && !visibleItems.length ? <div className="p-5"><Card><EmptyState title="No hay solicitudes para estos filtros" description="Ajusta los filtros o actualiza la mesa para consultar nuevos expedientes." /></Card></div> : null}

          {visibleItems.length ? <DataTable className="max-w-full rounded-none border-x-0 border-b-0 shadow-none">
            <table className="w-full min-w-[60rem] border-collapse text-left text-[13px]">
              <thead className="bg-[var(--fp-bg)] text-xs text-[var(--fp-muted)]">
                <tr>
                  <th scope="col" className="px-3 py-3 font-bold">Número</th>
                  <th scope="col" className="px-3 py-3 font-bold">Cliente</th>
                  <th scope="col" className="px-3 py-3 font-bold">Cédula</th>
                  <th scope="col" className="px-3 py-3 font-bold">Aliado</th>
                  <th scope="col" className="px-3 py-3 font-bold">Equipo</th>
                  <th scope="col" className="px-3 py-3 text-right font-bold">Monto autorizado</th>
                  <th scope="col" className="px-3 py-3 font-bold">Estado</th>
                  <th scope="col" className="px-3 py-3 font-bold">Tiempo</th>
                  <th scope="col" className="px-3 py-3 text-center font-bold">Acciones</th>
                </tr>
              </thead>
              <tbody>{visibleItems.map((item) => {
                const selected = props.selectedId === item.id;
                return <tr key={item.id} className={`border-t border-[var(--fp-border)] ${selected ? "bg-[var(--fp-lime-soft)] shadow-[inset_3px_0_0_var(--fp-lime)]" : "bg-[var(--fp-surface)] hover:bg-[var(--fp-bg)]"}`}>
                  <td className="px-3 py-4 font-bold tabular-nums"><button type="button" disabled={props.busy} onClick={() => props.onSelect(item.id)} className="min-h-10 text-left underline decoration-[var(--fp-lime)] decoration-2 underline-offset-4">{creditDisplayNumber(item)}</button></td>
                  <td className="px-3 py-4 font-semibold">{item.clienteNombre}</td>
                  <td className="px-3 py-4 tabular-nums text-[var(--fp-muted)]">{item.clienteDocumento?.trim() || "No disponible"}</td>
                  <td className="px-3 py-4">{item.aliadoNombre}{item.sedeNombre ? <span className="mt-1 block text-xs text-[var(--fp-muted)]">{item.sedeNombre}</span> : null}</td>
                  <td className="px-3 py-4">{item.referenciaEquipo?.trim() || "No disponible"}</td>
                  <td className="px-3 py-4 text-right font-bold tabular-nums">{item.creditoAutorizado != null ? money.format(item.creditoAutorizado) : "No disponible"}</td>
                  <td className="px-3 py-4"><StatusPill tone={item.status === "APPROVED" ? "positive" : "warning"}>{statusLabel(item)}</StatusPill></td>
                  <td className="whitespace-nowrap px-3 py-4 tabular-nums text-[var(--fp-muted)]">{elapsedLabel(item.status === "APPROVED" ? item.approvedAt || item.updatedAt || item.createdAt || item.fechaCredito : item.updatedAt || item.createdAt || item.fechaCredito, filterNow)}</td>
                  <td className="px-3 py-4 text-center"><Button variant="ghost" onClick={() => props.onSelect(item.id)} disabled={props.busy} aria-label={`Abrir solicitud ${creditDisplayNumber(item)}`}><MoreHorizontal className="h-5 w-5" aria-hidden="true" /></Button></td>
                </tr>;
              })}</tbody>
            </table>
          </DataTable> : null}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--fp-border)] px-4 py-4 text-sm text-[var(--fp-muted)] sm:px-6 lg:px-7 xl:px-8">
            <span>{visibleItems.length} visibles{props.counts ? ` de ${props.counts[props.view].toLocaleString("es-CO")}` : ""}</span>
            {props.nextCursor ? <Button variant="secondary" disabled={props.busy || props.searching} onClick={props.onMore}>Cargar más</Button> : null}
          </footer>
        </section>

        <aside className="min-w-0 bg-[var(--fp-surface)] xl:sticky xl:top-0 xl:max-h-screen xl:overflow-y-auto" aria-label="Atención y detalle de la solicitud">
          <section className="border-b border-[var(--fp-border)] p-5" aria-labelledby="analyst-attention-title">
            <h2 id="analyst-attention-title" className="text-lg font-black">Requiere atención ({attentionItems.length})</h2>
            {attentionItems.length ? <ul className="mt-3 divide-y divide-[var(--fp-border)]">{attentionItems.map((item) => <li key={item.id}>
              <button type="button" disabled={props.busy} onClick={() => props.onSelect(item.id)} className="flex min-h-16 w-full items-center gap-3 py-3 text-left hover:bg-[var(--fp-bg)] focus-visible:outline-2 focus-visible:outline-[var(--fp-lime)]">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]"><AlertTriangle className="h-4 w-4" aria-hidden="true" /></span>
                <span className="min-w-0 flex-1"><strong className="block truncate">{creditDisplayNumber(item)}</strong><span className="block truncate text-sm text-[var(--fp-muted)]">{item.clienteNombre}</span><span className="block text-xs font-bold text-[var(--fp-amber)]">{attentionLabel(item)}</span></span>
                <span className="text-xs tabular-nums text-[var(--fp-muted)]">{elapsedLabel(item.status === "APPROVED" ? item.approvedAt || item.updatedAt || item.createdAt || item.fechaCredito : item.updatedAt || item.createdAt || item.fechaCredito, filterNow)}</span><ChevronRight className="h-4 w-4 shrink-0 text-[var(--fp-muted)]" aria-hidden="true" />
              </button>
            </li>)}</ul> : <p className="mt-3 text-sm text-[var(--fp-muted)]">No hay solicitudes cargadas que requieran atención.</p>}
          </section>

          <section id="approval-focused-detail" tabIndex={-1} className="min-w-0 scroll-mt-4 focus-visible:outline-2 focus-visible:outline-[var(--fp-lime)]" aria-label="Detalle de la solicitud">
            {props.loadingDetail && !props.detail ? <div className="p-6"><LoadingState label="Cargando detalle..." /></div> : props.detailError ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-[var(--fp-danger)]">{props.detailError}</p><Button variant="secondary" onClick={props.onRetryDetail}>Reintentar</Button></div> : props.detail ? <>
              <div className="flex items-start justify-between gap-3 p-5 pb-3"><div><p className="text-xs font-black uppercase tracking-[0.14em] text-[var(--fp-muted)]">Detalle de la solicitud</p><h2 className="mt-1 text-lg font-black">{creditDisplayNumber(props.detail)}</h2></div><Button variant="ghost" onClick={props.onBack} disabled={props.busy} aria-label="Cerrar detalle"><X className="h-5 w-5" aria-hidden="true" /></Button></div>
              <div className="px-5"><StatusPill tone={props.detail.review.status === "APPROVED" ? "positive" : "warning"}>{selectedQueueItem ? statusLabel(selectedQueueItem) : props.detail.review.status === "APPROVED" ? "Lista para liquidar" : "Pendiente de revisión"}</StatusPill></div>
              <Tabs className="mx-5 mt-4" aria-label="Secciones del detalle">
                {(["summary", "history", "actions"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={detailTab === tab} onClick={() => setDetailTab(tab)}>{tab === "summary" ? "Resumen" : tab === "history" ? "Historial" : "Acciones"}</button>)}
              </Tabs>

              <div hidden={detailTab !== "summary"} className="space-y-4 p-5">
                <dl className="grid gap-3 text-sm">
                  {[
                    ["Cliente", props.detail.clienteNombre],
                    ["Cédula", props.detail.clienteDocumento],
                    ["Aliado", props.detail.aliadoNombre],
                    ["Equipo", props.detail.referenciaEquipo],
                    ["IMEI", selectedQueueItem?.imei || "No disponible"],
                    ["Monto autorizado", money.format(props.detail.creditoAutorizado)],
                    ["Plazo", props.detail.numeroCuotas ? `${props.detail.numeroCuotas} cuotas` : "No disponible"],
                    ["Fecha de solicitud", displayDate(props.detail.fechaCredito)],
                    ["Última actualización", displayDate(selectedQueueItem?.updatedAt || selectedQueueItem?.createdAt || props.detail.fechaCredito)],
                    ...(props.view === "approved" ? [
                      ["Estado Sadmin", selectedQueueItem?.sadmin?.estadoCreacion === "CREADO_CORRECTAMENTE" ? "Creado correctamente" : selectedQueueItem?.sadmin?.estadoCreacion === "ERROR_CREACION" ? "Error de creación" : selectedQueueItem?.sadmin?.estadoCreacion === "REQUIERE_REVISION" ? "Requiere revisión" : "Pendiente de crear"],
                      ["Número Sadmin", selectedQueueItem?.sadmin?.numeroCredito || "Pendiente"],
                    ] : []),
                  ].map(([label, value]) => <div key={label} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3"><dt className="text-[var(--fp-muted)]">{label}</dt><dd className="break-words font-semibold">{value || "No disponible"}</dd></div>)}
                </dl>
                <Button className="w-full" onClick={() => setFullReview(true)}><ClipboardList className="h-4 w-4" aria-hidden="true" />Ver expediente</Button>
                <div className="grid gap-2">
                  <Link href={operationHref("/dashboard/aprobaciones/cambio-imei", props.detail)} className="fp-ui-button is-secondary w-full"><Smartphone className="h-4 w-4" aria-hidden="true" />Cambiar IMEI</Link>
                  <Link href={operationHref("/dashboard/aprobaciones/firma-seguro", props.detail)} className="fp-ui-button is-secondary w-full"><FilePenLine className="h-4 w-4" aria-hidden="true" />Gestionar firma</Link>
                </div>
              </div>

              <div hidden={detailTab !== "history"} className="space-y-4 p-5">
                <Card className="space-y-3 p-4"><h3 className="flex items-center gap-2 font-bold"><History className="h-4 w-4" aria-hidden="true" />Historial del expediente</h3><p className="flex items-center gap-2 text-sm text-[var(--fp-muted)]"><Clock3 className="h-4 w-4" aria-hidden="true" />Solicitud creada {displayDate(props.detail.fechaCredito)}</p>{props.detail.review.status === "APPROVED" ? <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />Aprobada {displayDate(props.detail.review.approvedAt)}</p> : <p className="flex items-center gap-2 text-sm"><AlertTriangle className="h-4 w-4 text-[var(--fp-amber)]" aria-hidden="true" />Revisión pendiente</p>}</Card>
                {props.detail.review.required ? <SharedNoveltyHistory creditId={props.detail.id} evidence={props.detail.evidence} /> : <p className="text-sm text-[var(--fp-muted)]">Este expediente no requiere historial de revisión adicional.</p>}
              </div>

              <div hidden={detailTab !== "actions"} className="space-y-4 p-5">
                <div className="grid gap-2">
                  <Button className="w-full" onClick={() => setFullReview(true)}><ClipboardList className="h-4 w-4" aria-hidden="true" />Ver expediente</Button>
                  <Link href={operationHref("/dashboard/aprobaciones/cambio-imei", props.detail)} className="fp-ui-button is-secondary w-full"><Smartphone className="h-4 w-4" aria-hidden="true" />Cambiar IMEI</Link>
                  <Link href={operationHref("/dashboard/aprobaciones/firma-seguro", props.detail)} className="fp-ui-button is-secondary w-full"><FilePenLine className="h-4 w-4" aria-hidden="true" />Gestionar firma</Link>
                </div>
              </div>
            </> : <div className="p-5"><EmptyState title="Selecciona una solicitud" description="Abre una fila para consultar su resumen, historial y acciones disponibles." /></div>}
          </section>
        </aside>
      </div>
      {props.confirmationDialog}
    </main>
  );
}
