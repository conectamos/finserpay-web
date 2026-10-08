"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  History,
  RefreshCw,
  Search,
  UserRound,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";
import {
  MORA_ACTIONS,
  MORA_MANAGEMENT_STATES,
  type MoraManagementEvent,
  type MoraManagementInput,
  type MoraPortfolioItem,
} from "@/lib/analyst-mora-types";
import MoraSupports from "../mora-supports";

type NamedOption = { id: number; nombre: string };
type PortfolioResponse = {
  ok: true;
  items: MoraPortfolioItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  allies: NamedOption[];
  responsibles: NamedOption[];
};
type MoraCreditDetail = Omit<MoraPortfolioItem, "ultimaGestion"> & {
  clienteTelefono: string | null;
  enMora: boolean;
};
type DetailResponse = {
  ok: true;
  credit: MoraCreditDetail;
  currentResponsible: NamedOption;
  history: MoraManagementEvent[];
  responsibles: NamedOption[];
};
type SaveResponse = { ok: true; item: MoraManagementEvent; unchanged: boolean };
type Filters = {
  q: string;
  ally: string;
  responsible: string;
  minDays: string;
  maxDays: string;
  status: string;
  followUp: string;
};
type ManagementForm = {
  action: MoraManagementInput["action"];
  actedAt: string;
  responsibleUserId: string;
  result: string;
  comment: string;
  nextFollowUpAt: string;
  managementStatus: MoraManagementInput["managementStatus"];
};

const emptyFilters: Filters = {
  q: "",
  ally: "",
  responsible: "",
  minDays: "",
  maxDays: "",
  status: "",
  followUp: "",
};

const actionLabels: Record<MoraManagementInput["action"], string> = {
  LLAMADA: "Llamada",
  WHATSAPP: "WhatsApp",
  SIN_RESPUESTA: "Sin respuesta",
  PROMESA_PAGO: "Promesa de pago",
  ACUERDO_PAGO: "Acuerdo de pago",
  SOPORTE_RECIBIDO: "Soporte recibido",
  ESCALADO: "Escalado",
  VISITA_PENDIENTE: "Visita pendiente",
};

const statusLabels: Record<MoraManagementInput["managementStatus"], string> = {
  PENDIENTE: "Pendiente",
  CONTACTADO: "Contactado",
  SIN_RESPUESTA: "Sin respuesta",
  PROMESA_PAGO: "Promesa de pago",
  ACUERDO_PAGO: "Acuerdo de pago",
  SOPORTE_RECIBIDO: "Soporte recibido",
  ESCALADO: "Escalado",
  CERRADO: "Cerrado",
};

const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const bogotaDateTime = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

const bogotaInputParts = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "America/Bogota",
});

function displayDateTime(value: string | null | undefined) {
  if (!value) return "Sin registro";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? bogotaDateTime.format(date) : "Sin registro";
}

function bogotaInputValue(date: Date) {
  const parts = Object.fromEntries(
    bogotaInputParts.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function bogotaIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return "";
  return `${value.length === 16 ? `${value}:00` : value}-05:00`;
}

function freshManagement(responsibleUserId = ""): ManagementForm {
  const now = new Date();
  return {
    action: "LLAMADA",
    actedAt: bogotaInputValue(now),
    responsibleUserId,
    result: "",
    comment: "",
    nextFollowUpAt: bogotaInputValue(new Date(now.getTime() + 86_400_000)),
    managementStatus: "PENDIENTE",
  };
}

function statusTone(status: MoraManagementInput["managementStatus"] | undefined) {
  if (status === "CERRADO") return "positive" as const;
  if (status === "ESCALADO" || status === "SIN_RESPUESTA") return "danger" as const;
  if (status === "PROMESA_PAGO" || status === "ACUERDO_PAGO" || status === "SOPORTE_RECIBIDO") return "warning" as const;
  return "neutral" as const;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "No fue posible completar la solicitud.");
  }
  return payload as T;
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--fp-muted)]">{label}</dt><dd className="mt-1 break-words text-sm font-semibold">{value}</dd></div>;
}

export default function MoraPortfolioClient() {
  const [formFilters, setFormFilters] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [management, setManagement] = useState<ManagementForm>(() => freshManagement());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const [lastSavedFingerprint, setLastSavedFingerprint] = useState("");
  const detailController = useRef<AbortController | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page) });
    for (const [key, value] of Object.entries(filters)) {
      const normalized = value.trim();
      if (normalized) params.set(key, normalized);
    }
    return `/api/aprobaciones/cartera-mora?${params.toString()}`;
  }, [filters, page]);

  const managementFingerprint = useMemo(() => JSON.stringify(management), [management]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    void requestJson<PortfolioResponse>(listUrl, { signal: controller.signal })
      .then((result) => setPortfolio(result))
      .catch((error) => {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "No fue posible cargar la cartera en mora.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listUrl, refreshVersion]);

  useEffect(() => () => detailController.current?.abort(), []);

  function updateFilter(key: keyof Filters, value: string) {
    setFormFilters((current) => ({ ...current, [key]: value }));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setFilters({ ...formFilters });
  }

  function clearFilters() {
    setFormFilters(emptyFilters);
    setFilters(emptyFilters);
    setPage(1);
  }

  function updateManagement<K extends keyof ManagementForm>(key: K, value: ManagementForm[K]) {
    idempotencyKey.current = null;
    setManagement((current) => ({ ...current, [key]: value }));
    setSaveError("");
    setNotice("");
  }

  async function openCredit(item: MoraPortfolioItem) {
    if (saving) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setSelectedId(item.id);
    setDetail(null);
    setLoadingDetail(true);
    setDetailError("");
    setSaveError("");
    setNotice("");
    setLastSavedFingerprint("");
    idempotencyKey.current = null;
    try {
      const result = await requestJson<DetailResponse>(`/api/aprobaciones/cartera-mora/${item.id}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDetail(result);
      const preferredResponsible = result.currentResponsible.id;
      setManagement(freshManagement(preferredResponsible ? String(preferredResponsible) : ""));
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "No fue posible abrir el crédito.");
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }

  function closeDetail() {
    if (saving) return;
    detailController.current?.abort();
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setNotice("");
    setSaveError("");
  }

  async function saveManagement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !detail || saving || managementFingerprint === lastSavedFingerprint) return;
    const actedAt = bogotaIso(management.actedAt);
    const nextFollowUpAt = bogotaIso(management.nextFollowUpAt);
    const responsibleUserId = detail.currentResponsible.id;
    if (!actedAt || !nextFollowUpAt || !Number.isSafeInteger(responsibleUserId) || responsibleUserId < 1
      || management.result.trim().length < 3 || management.comment.trim().length < 5) {
      setSaveError("Completa la fecha y hora, el responsable, el resultado, el comentario y la próxima gestión.");
      return;
    }
    if (Date.parse(nextFollowUpAt) <= Date.parse(actedAt)) {
      setSaveError("La próxima gestión debe programarse después de la fecha y hora de esta gestión.");
      return;
    }

    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    const input: MoraManagementInput = {
      action: management.action,
      actedAt,
      responsibleUserId,
      result: management.result.trim(),
      comment: management.comment.trim(),
      nextFollowUpAt,
      managementStatus: management.managementStatus,
      idempotencyKey: key,
    };
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result = await requestJson<SaveResponse>(`/api/aprobaciones/cartera-mora/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setDetail((current) => current ? {
        ...current,
        history: [result.item, ...current.history.filter((item) => item.id !== result.item.id)],
      } : current);
      setPortfolio((current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === selectedId ? { ...item, ultimaGestion: result.item } : item),
      } : current);
      setLastSavedFingerprint(managementFingerprint);
      idempotencyKey.current = null;
      setNotice(result.unchanged ? "La gestión ya estaba guardada y se recuperó sin duplicarla." : "Gestión guardada. El historial anterior se conserva.");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "No fue posible guardar la gestión.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-w-0 px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <div className="mx-auto max-w-[1920px] space-y-5">
        <PageHeader
          eyebrow="Aprobaciones"
          title="Cartera en mora"
          description="Consulta los créditos vencidos, filtra la cartera y registra cada seguimiento sin perder el historial."
          actions={<Button variant="secondary" disabled={loading || saving} onClick={() => setRefreshVersion((value) => value + 1)}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar</Button>}
        />

        <Card className="p-4 sm:p-5">
          <form onSubmit={applyFilters} className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7" aria-label="Filtros de cartera en mora">
            <label className="space-y-1.5 xl:col-span-2"><span className="text-sm font-bold">Buscar</span><span className="relative block"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-muted)]" aria-hidden="true" /><Input value={formFilters.q} onChange={(event) => updateFilter("q", event.target.value)} maxLength={100} placeholder="Crédito, cliente, cédula o IMEI" style={{ paddingLeft: "2.25rem" }} /></span></label>
            <label className="space-y-1.5"><span className="text-sm font-bold">Aliado</span><Select value={formFilters.ally} onChange={(event) => updateFilter("ally", event.target.value)}><option value="">Todos</option>{portfolio?.allies.map((ally) => <option key={ally.id} value={ally.id}>{ally.nombre}</option>)}</Select></label>
            <label className="space-y-1.5"><span className="text-sm font-bold">Responsable</span><Select value={formFilters.responsible} onChange={(event) => updateFilter("responsible", event.target.value)}><option value="">Todos</option>{portfolio?.responsibles.map((responsible) => <option key={responsible.id} value={responsible.id}>{responsible.nombre}</option>)}</Select></label>
            <label className="space-y-1.5"><span className="text-sm font-bold">Estado</span><Select value={formFilters.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="">Todos</option>{MORA_MANAGEMENT_STATES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</Select></label>
            <label className="space-y-1.5"><span className="text-sm font-bold">Próxima gestión</span><Input type="date" value={formFilters.followUp} onChange={(event) => updateFilter("followUp", event.target.value)} /></label>
            <div className="grid grid-cols-2 gap-2"><label className="space-y-1.5"><span className="text-sm font-bold">Mora desde</span><Input type="number" min={0} step={1} inputMode="numeric" value={formFilters.minDays} onChange={(event) => updateFilter("minDays", event.target.value)} placeholder="Días" /></label><label className="space-y-1.5"><span className="text-sm font-bold">Mora hasta</span><Input type="number" min={0} step={1} inputMode="numeric" value={formFilters.maxDays} onChange={(event) => updateFilter("maxDays", event.target.value)} placeholder="Días" /></label></div>
            <div className="flex flex-wrap items-end gap-2 md:col-span-2 xl:col-span-4 2xl:col-span-7"><Button type="submit" disabled={loading || saving}>Aplicar filtros</Button><Button variant="ghost" disabled={loading || saving} onClick={clearFilters}>Limpiar</Button><span aria-live="polite" className="ml-auto text-sm text-[var(--fp-muted)]">{loading ? "Consultando cartera" : portfolio ? `${portfolio.total.toLocaleString("es-CO")} créditos encontrados` : "Consulta no disponible"}</span></div>
          </form>
        </Card>

        {listError ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm">{listError}</div> : null}
        {loading && !portfolio ? <LoadingState label="Cargando cartera en mora..." /> : null}

        <div className={`grid min-w-0 gap-5 ${selectedId ? "2xl:grid-cols-[minmax(0,1fr)_28rem]" : ""}`}>
          <section className="min-w-0" aria-label="Créditos en mora">
            {portfolio && !portfolio.items.length && !loading ? <Card><EmptyState title="No hay créditos para estos filtros" description="Ajusta los filtros o actualiza la consulta para revisar la cartera disponible." /></Card> : null}
            {portfolio?.items.length ? <DataTable className="max-w-full">
              <table className="w-full min-w-[126rem] border-collapse text-left text-sm">
                <thead className="bg-[var(--fp-bg)] text-xs text-[var(--fp-muted)]"><tr>
                  <th scope="col" className="px-4 py-3 font-bold">Número</th><th scope="col" className="px-4 py-3 font-bold">Cliente</th><th scope="col" className="px-4 py-3 font-bold">Cédula</th><th scope="col" className="px-4 py-3 font-bold">Aliado</th><th scope="col" className="px-4 py-3 font-bold">Equipo</th><th scope="col" className="px-4 py-3 font-bold">IMEI</th><th scope="col" className="px-4 py-3 text-right font-bold">Valor vencido</th><th scope="col" className="px-4 py-3 text-right font-bold">Días en mora</th><th scope="col" className="px-4 py-3 font-bold">Último pago</th><th scope="col" className="px-4 py-3 font-bold">Última gestión</th><th scope="col" className="px-4 py-3 font-bold">Responsable</th><th scope="col" className="px-4 py-3 font-bold">Resultado</th><th scope="col" className="px-4 py-3 font-bold">Próxima gestión</th><th scope="col" className="px-4 py-3 font-bold">Estado</th><th scope="col" className="px-4 py-3 text-center font-bold">Acciones</th>
                </tr></thead>
                <tbody>{portfolio.items.map((item) => {
                  const managementStatus = item.ultimaGestion?.managementStatus || "PENDIENTE";
                  return <tr key={item.id} className={`border-t border-[var(--fp-border)] ${selectedId === item.id ? "bg-[var(--fp-lime-soft)] shadow-[inset_3px_0_0_var(--fp-lime)]" : "bg-[var(--fp-surface)] hover:bg-[var(--fp-bg)]"}`}>
                    <td className="px-4 py-4 font-bold tabular-nums">{item.numeroCreditoVisible}</td><td className="px-4 py-4 font-semibold">{item.clienteNombre}</td><td className="px-4 py-4 tabular-nums text-[var(--fp-muted)]">{item.clienteDocumento || "No disponible"}</td><td className="px-4 py-4">{item.aliadoNombre}</td><td className="px-4 py-4">{item.equipo || "No disponible"}</td><td className="px-4 py-4 tabular-nums">{item.imei || "No disponible"}</td><td className="px-4 py-4 text-right font-bold tabular-nums">{money.format(item.valorVencido)}</td><td className="px-4 py-4 text-right font-black tabular-nums text-[var(--fp-danger)]">{item.diasMora}</td><td className="whitespace-nowrap px-4 py-4">{displayDateTime(item.ultimoPago)}</td><td className="whitespace-nowrap px-4 py-4">{displayDateTime(item.ultimaGestion?.actedAt)}</td><td className="px-4 py-4">{item.ultimaGestion?.responsibleName || "Sin asignar"}</td><td className="max-w-56 px-4 py-4"><span className="line-clamp-2">{item.ultimaGestion?.result || "Sin gestión"}</span></td><td className="whitespace-nowrap px-4 py-4">{displayDateTime(item.ultimaGestion?.nextFollowUpAt)}</td><td className="px-4 py-4"><StatusPill tone={statusTone(managementStatus)}>{statusLabels[managementStatus]}</StatusPill></td><td className="px-4 py-4 text-center"><Button variant="secondary" disabled={saving} aria-pressed={selectedId === item.id} onClick={() => void openCredit(item)}>Gestionar</Button></td>
                  </tr>;
                })}</tbody>
              </table>
            </DataTable> : null}
            {portfolio ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--fp-border)] px-2 py-4 text-sm text-[var(--fp-muted)]"><span>Página {portfolio.page} · {portfolio.items.length} de {portfolio.total.toLocaleString("es-CO")}</span><div className="flex gap-2"><Button variant="secondary" disabled={loading || saving || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="h-4 w-4" aria-hidden="true" />Anterior</Button><Button variant="secondary" disabled={loading || saving || !portfolio.hasMore} onClick={() => setPage((value) => value + 1)}>Siguiente<ChevronRight className="h-4 w-4" aria-hidden="true" /></Button></div></div> : null}
          </section>

          {selectedId ? <aside className="min-w-0 self-start border border-[var(--fp-border)] bg-[var(--fp-surface)] shadow-[var(--fp-shadow-sm)] 2xl:sticky 2xl:top-4 2xl:max-h-[calc(100vh-2rem)] 2xl:overflow-y-auto" aria-label="Gestión del crédito en mora">
            <div className="flex items-start justify-between gap-3 border-b border-[var(--fp-border)] p-5"><div><p className="text-xs font-black uppercase tracking-[0.12em] text-[var(--fp-muted)]">Gestión de cartera</p><h2 className="mt-1 text-xl font-black">{detail?.credit.numeroCreditoVisible || `Crédito ${selectedId}`}</h2></div><Button variant="ghost" disabled={saving} onClick={closeDetail} aria-label="Cerrar gestión"><X className="h-5 w-5" aria-hidden="true" /></Button></div>
            {loadingDetail ? <div className="p-5"><LoadingState label="Cargando crédito e historial..." /></div> : null}
            {detailError ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-[var(--fp-danger)]">{detailError}</p>{portfolio?.items.find((item) => item.id === selectedId) ? <Button variant="secondary" onClick={() => void openCredit(portfolio.items.find((item) => item.id === selectedId)!)}>Reintentar</Button> : null}</div> : null}
            {detail ? <>
              <section className="space-y-4 border-b border-[var(--fp-border)] p-5" aria-labelledby="mora-credit-summary"><div className="flex items-start justify-between gap-3"><div><h3 id="mora-credit-summary" className="font-black">{detail.credit.clienteNombre}</h3><p className="mt-1 text-sm text-[var(--fp-muted)]">{detail.credit.aliadoNombre}</p></div><Badge tone="danger">{detail.credit.diasMora} días</Badge></div><dl className="grid grid-cols-2 gap-4"><DetailValue label="Cédula" value={detail.credit.clienteDocumento || "No disponible"} /><DetailValue label="Teléfono" value={detail.credit.clienteTelefono || "No disponible"} /><DetailValue label="Equipo" value={detail.credit.equipo || "No disponible"} /><DetailValue label="IMEI" value={detail.credit.imei || "No disponible"} /><DetailValue label="Valor vencido" value={money.format(detail.credit.valorVencido)} /><DetailValue label="Último pago" value={displayDateTime(detail.credit.ultimoPago)} /></dl></section>

              <form onSubmit={saveManagement} className="space-y-4 border-b border-[var(--fp-border)] p-5" aria-labelledby="mora-management-form"><div><h3 id="mora-management-form" className="flex items-center gap-2 font-black"><CircleDollarSign className="h-5 w-5" aria-hidden="true" />Nueva gestión</h3><p className="mt-1 text-sm text-[var(--fp-muted)]">Todos los campos son obligatorios. Cada registro se agrega al historial.</p></div>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Acción realizada</span><Select required value={management.action} disabled={saving} onChange={(event) => updateManagement("action", event.target.value as ManagementForm["action"])}>{MORA_ACTIONS.map((action) => <option key={action} value={action}>{actionLabels[action]}</option>)}</Select></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Fecha y hora de gestión <span className="font-normal text-[var(--fp-muted)]">(Bogotá)</span></span><Input required type="datetime-local" step={60} value={management.actedAt} disabled={saving} onChange={(event) => updateManagement("actedAt", event.target.value)} /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Responsable</span><Input value={detail.currentResponsible.nombre} readOnly aria-readonly="true" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Resultado</span><Input required minLength={3} maxLength={500} value={management.result} disabled={saving} onChange={(event) => updateManagement("result", event.target.value)} placeholder="Describe el resultado obtenido" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Comentario</span><textarea required minLength={5} maxLength={2000} rows={4} value={management.comment} disabled={saving} onChange={(event) => updateManagement("comment", event.target.value)} placeholder="Registra el contexto y los compromisos acordados" className="fp-ui-input min-h-28 w-full resize-y" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Próxima gestión <span className="font-normal text-[var(--fp-muted)]">(Bogotá)</span></span><Input required type="datetime-local" step={60} value={management.nextFollowUpAt} disabled={saving} onChange={(event) => updateManagement("nextFollowUpAt", event.target.value)} /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Estado de gestión</span><Select required value={management.managementStatus} disabled={saving} onChange={(event) => updateManagement("managementStatus", event.target.value as ManagementForm["managementStatus"])}>{MORA_MANAGEMENT_STATES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</Select></label>
                {saveError ? <p role="alert" className="rounded-[var(--fp-radius-sm)] bg-[var(--fp-danger-soft)] px-3 py-2 text-sm text-[var(--fp-danger)]">{saveError}</p> : null}{notice ? <p role="status" className="rounded-[var(--fp-radius-sm)] bg-[var(--fp-lime-soft)] px-3 py-2 text-sm">{notice}</p> : null}
                <Button type="submit" className="w-full" disabled={saving || managementFingerprint === lastSavedFingerprint}>{saving ? "Guardando..." : managementFingerprint === lastSavedFingerprint ? "Gestión guardada" : "Guardar gestión"}</Button>
              </form>

              <section className="p-5" aria-labelledby="mora-history-title"><div className="flex items-center justify-between gap-3"><h3 id="mora-history-title" className="flex items-center gap-2 font-black"><History className="h-5 w-5" aria-hidden="true" />Línea de tiempo</h3><Badge>{detail.history.length}</Badge></div>{detail.history.length ? <ol className="mt-4 space-y-4 border-l-2 border-[var(--fp-border)] pl-4">{detail.history.map((item, index) => <li key={item.id} className="relative"><span className="absolute -left-[1.34rem] top-1 h-2.5 w-2.5 rounded-full bg-[var(--fp-lime-strong)] ring-4 ring-[var(--fp-surface)]" /><article className="space-y-2 rounded-[var(--fp-radius-sm)] bg-[var(--fp-bg)] p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-bold">{actionLabels[item.action]}</h4><p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fp-muted)]"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{displayDateTime(item.actedAt)}</p></div><StatusPill tone={statusTone(item.managementStatus)}>{statusLabels[item.managementStatus]}</StatusPill></div><p className="flex items-center gap-1 text-sm"><UserRound className="h-4 w-4 text-[var(--fp-muted)]" aria-hidden="true" /><strong>{item.responsibleName}</strong></p><div><p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">Resultado</p><p className="mt-1 break-words text-sm">{item.result}</p></div><div><p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">Comentario</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.comment}</p></div><p className="flex items-center gap-1 text-xs text-[var(--fp-muted)]"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />Próxima gestión: {displayDateTime(item.nextFollowUpAt)}</p><p className="text-xs text-[var(--fp-muted)]">Registró {item.actorName} · {displayDateTime(item.createdAt)}</p><MoraSupports creditoId={detail.credit.id} subjectKind="GESTION" subjectId={item.id} defaultOpen={index === 0} /></article></li>)}</ol> : <EmptyState className="mt-4" title="Sin gestiones registradas" description="La primera gestión quedará visible aquí y no reemplazará registros anteriores." />}</section>
            </> : null}
          </aside> : null}
        </div>
      </div>
    </main>
  );
}
