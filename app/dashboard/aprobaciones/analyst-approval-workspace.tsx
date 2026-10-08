"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Filter, Smartphone, FilePenLine, ClipboardList } from "lucide-react";
import { Button, Input, Select } from "@/app/_components/finser-ui";
import SharedApprovalWorkspace from "@/app/revision-creditos/shared-approval-workspace";
import { creditDisplayNumber } from "@/lib/credit-display-number";
import type { ApprovalDetail, ApprovalQueueItem, ApprovalView } from "./approval-client";

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

function operationHref(path: string, detail: ApprovalDetail) {
  const lookup = creditDisplayNumber(detail) || detail.clienteDocumento || "";
  return `${path}?buscar=${encodeURIComponent(lookup)}`;
}

export default function AnalystApprovalWorkspace(props: Props) {
  const [allyFilter, setAllyFilter] = useState("");
  const [catalogAllies, setCatalogAllies] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [datePreset, setDatePreset] = useState<DatePreset>("all");
  const [showMoreFilters, setShowMoreFilters] = useState(false);

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

  return <SharedApprovalWorkspace key={props.query} {...props} filtersPanel={<details className="relative"><summary className="fp-ui-button is-secondary cursor-pointer list-none"><Filter size={16} aria-hidden="true" />Filtros</summary><div className="absolute right-0 top-full z-20 mt-2 w-[min(600px,calc(100vw-48px))] rounded-lg border border-[var(--fp-border)] bg-[var(--fp-surface)] p-4 shadow-lg"><div className="flex flex-wrap items-center gap-2">
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
          </div>
          {showMoreFilters ? <div className="flex flex-wrap items-end gap-3 border-b border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-3 text-sm text-[var(--fp-muted)] sm:px-6 lg:px-7 xl:px-8">
            <label className="space-y-1"><span className="block text-xs font-bold uppercase tracking-[0.08em]">Fecha desde</span><Input type="date" value={dateFrom} max={dateTo || undefined} disabled={props.busy} onChange={(event) => { const value = event.target.value; setDateFrom(value); setDatePreset("custom"); if (!dateTo || !value || value <= dateTo) props.onFilters({ aliado: allyFilter, desde: value, hasta: dateTo }); }} className="!w-auto min-w-40" /></label>
            <label className="space-y-1"><span className="block text-xs font-bold uppercase tracking-[0.08em]">Fecha hasta</span><Input type="date" value={dateTo} min={dateFrom || undefined} disabled={props.busy} onChange={(event) => { const value = event.target.value; setDateTo(value); setDatePreset("custom"); if (!dateFrom || !value || dateFrom <= value) props.onFilters({ aliado: allyFilter, desde: dateFrom, hasta: value }); }} className="!w-auto min-w-40" /></label>
            <span className="pb-3">{visibleItems.length} solicitudes visibles con los filtros aplicados.</span>
            <Button variant="ghost" className="ml-auto" onClick={() => { setAllyFilter(""); setDateFrom(""); setDateTo(""); setDatePreset("all"); props.onSearch(""); props.onFilters({}); }}>Limpiar filtros</Button>
          </div> : null}

</div></details>} operationLinks={<div className="flex flex-wrap gap-2 py-3">
    <Link href="/dashboard/aprobaciones/solicitudes" className="fp-ui-button is-secondary"><ClipboardList size={16} aria-hidden="true" />Consultar solicitudes</Link>
    {props.detail ? <><Link href={operationHref("/dashboard/aprobaciones/cambio-imei", props.detail)} className="fp-ui-button is-secondary"><Smartphone size={16} aria-hidden="true" />Cambiar IMEI</Link><Link href={operationHref("/dashboard/aprobaciones/firma-seguro", props.detail)} className="fp-ui-button is-secondary"><FilePenLine size={16} aria-hidden="true" />Gestionar firma</Link></> : null}
  </div>} />;
}
