"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Download,
  History,
  RefreshCw,
  Search,
  SlidersHorizontal,
  UserRound,
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
  MORA_PORTFOLIO_STATES,
  CREDIT_MANAGEMENT_RESULTS,
  moraResultsForAction,
  moraResultLabel,
  type MoraManagementEvent,
  type MoraManagementInput,
  type MoraPortfolioItem,
} from "@/lib/analyst-mora-types";
import MoraSupports from "../mora-supports";
import FinserSidePanel from "@/app/_components/finser-side-panel";
import styles from "./mora-portfolio.module.css";
import MoraPortfolioExtensionActions, { type ExtensionChange } from "./mora-portfolio-extension-actions";
import type { MoraExtensionActions } from "@/lib/mora-exception-types";
import CreditCommunications from "../gestion-cartera/credit-communications";

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
  counts?: { total: number; enMora: number; alDia: number; pagados: number; anulados: number };
};
type MoraCreditDetail = Omit<MoraPortfolioItem, "ultimaGestion"> & {
  clienteTelefono: string | null;
  referenciaFamiliar1Telefono: string | null;
  referenciaFamiliar2Telefono: string | null;
  enMora: boolean;
};
type DetailResponse = {
  ok: true;
  credit: MoraCreditDetail;
  currentResponsible: NamedOption;
  history: MoraManagementEvent[];
  responsibles: NamedOption[];
  extensionActions: MoraExtensionActions;
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
  financialStatus: string;
};
type ManagementForm = {
  action: MoraManagementInput["action"];
  actedAt: string;
  responsibleUserId: string;
  result: MoraManagementInput["result"] | "";
  agreementDate: string;
  agreementAmount: string;
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
  financialStatus: "",
};

const xlsxMime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
class MoraExportError extends Error {}

function exportFileName(contentDisposition: string | null) {
  const fallback = "cartera-mora.xlsx";
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = contentDisposition?.match(/filename="([^"]+)"/i)?.[1]
    ?? contentDisposition?.match(/filename=([^;]+)/i)?.[1];
  let candidate = encoded ?? plain;
  if (!candidate) return fallback;
  try { candidate = decodeURIComponent(candidate.trim()); } catch { candidate = candidate.trim(); }
  const safe = candidate.split(/[\\/]/).pop()?.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/^\.+/, "").trim().slice(0, 180);
  return safe?.toLowerCase().endsWith(".xlsx") ? safe : fallback;
}

const financialLabels: Record<string, string> = {
  EN_MORA: "En mora", AL_DIA: "Al día", PAGADO: "Pagado", ANULADO: "Anulado",
};

function financialTone(status?: string) {
  return status === "EN_MORA" ? "danger" as const : status === "AL_DIA" || status === "PAGADO" ? "positive" as const : "neutral" as const;
}

const actionLabels: Record<string, string> = {
  LLAMADA: "Llamada",
  MSJ_TEXTO: "Msj de texto",
  WHATSAPP: "WhatsApp",
  SIN_RESPUESTA: "Sin respuesta",
  PROMESA_PAGO: "Promesa de pago",
  ACUERDO_PAGO: "Acuerdo de pago",
  SOPORTE_RECIBIDO: "Soporte recibido",
  ESCALADO: "Escalado",
  VISITA_PENDIENTE: "Visita pendiente",
};

const statusLabels: Record<string, string> = {
  PENDIENTE: "Pendiente",
  CONTACTADO: "Contactado",
  SIN_RESPUESTA: "Sin respuesta",
  PROMESA_PAGO: "Promesa de pago",
  ACUERDO_PAGO: "Acuerdo de pago",
  SOPORTE_RECIBIDO: "Soporte recibido",
  ESCALADO: "Escalado",
  CERRADO: "Cerrado",
  SOLUCIONADO: "Solucionado",
  SEGUIMIENTO: "Seguimiento",
  PRORROGA: "Prórroga",
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

const bogotaDate = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit", month: "short", year: "numeric", timeZone: "America/Bogota",
});

function displayDay(value: string | null | undefined) {
  if (!value) return "Sin fecha límite";
  const date = new Date(`${value.slice(0, 10)}T12:00:00-05:00`);
  return Number.isFinite(date.getTime()) ? bogotaDate.format(date) : "Fecha no disponible";
}

function portfolioStatus(credit: Pick<MoraPortfolioItem, "estadoGestion" | "prorrogaActiva"> & {
  ultimaGestion?: MoraManagementEvent | null;
}) {
  if (credit.prorrogaActiva) return "PRORROGA";
  return (credit.estadoGestion !== "PRORROGA" && credit.estadoGestion) ||
    credit.ultimaGestion?.managementStatus || "PENDIENTE";
}

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
    agreementDate: "",
    agreementAmount: "",
    comment: "",
    nextFollowUpAt: bogotaInputValue(new Date(now.getTime() + 86_400_000)),
    managementStatus: "SEGUIMIENTO",
  };
}

function statusTone(status: string | undefined) {
  if (status === "CERRADO" || status === "SOLUCIONADO") return "positive" as const;
  if (status === "ESCALADO" || status === "SIN_RESPUESTA") return "danger" as const;
  if (status === "PRORROGA" || status === "PROMESA_PAGO" || status === "ACUERDO_PAGO" || status === "SOPORTE_RECIBIDO") return "warning" as const;
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

export default function MoraPortfolioClient({ scope = "overdue", initialCreditId = null }: {
  scope?: "overdue" | "all"; initialCreditId?: number | null;
} = {}) {
  const allCredits = scope === "all";
  const apiBase = allCredits ? "/api/aprobaciones/gestion-cartera" : "/api/aprobaciones/cartera-mora";
  const resultOptions = (action: ManagementForm["action"]) => allCredits ? CREDIT_MANAGEMENT_RESULTS : moraResultsForAction(action);
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
  const [extensionBusy, setExtensionBusy] = useState(false);
  const [extensionNotice, setExtensionNotice] = useState<{ message: string; warning: string | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportFlight = useRef(false);
  const extensionFlight = useRef(false);
  const detailController = useRef<AbortController | null>(null);
  const selectedCreditId = useRef<number | null>(null);
  const submitting = useRef(false);
  const idempotencyKey = useRef<string | null>(null);

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page) });
    for (const [key, value] of Object.entries(filters)) {
      const normalized = value.trim();
      if (normalized) params.set(key, normalized);
    }
    return `${apiBase}?${params.toString()}`;
  }, [apiBase, filters, page]);

  const managementFingerprint = useMemo(() => JSON.stringify(management), [management]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setListError("");
    void requestJson<PortfolioResponse>(listUrl, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setPortfolio(result);
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (result.page > lastPage) setPage(lastPage);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "No fue posible cargar la cartera en mora.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [listUrl, refreshVersion]);

  useEffect(() => () => detailController.current?.abort(), []);

  // The deep link only selects a record. The existing protected detail endpoint
  // still authorizes the read; it does not submit a management or a communication.
  useEffect(() => {
    if (!allCredits || !initialCreditId || !Number.isSafeInteger(initialCreditId) || initialCreditId < 1) return;
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    selectedCreditId.current = initialCreditId;
    setSelectedId(initialCreditId);
    setDetail(null);
    setLoadingDetail(true);
    setDetailError("");
    setSaveError("");
    setNotice("");
    setExtensionNotice(null);
    setLastSavedFingerprint("");
    idempotencyKey.current = null;
    void requestJson<DetailResponse>(`${apiBase}/${initialCreditId}`, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted || selectedCreditId.current !== initialCreditId) return;
        if (result.credit.id !== initialCreditId) throw new Error("La respuesta no corresponde al crédito seleccionado. Actualiza la consulta.");
        setDetail(result);
        setManagement(freshManagement(String(result.currentResponsible.id)));
      })
      .catch(error => {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "No fue posible abrir el crédito.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingDetail(false); });
    return () => controller.abort();
  }, [allCredits, apiBase, initialCreditId]);

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
    setManagement((current) => {
      const next = { ...current, [key]: value };
      if (next.result && !resultOptions(next.action).includes(next.result)) next.result = "";
      if (next.result !== "ACUERDO_PAGO") {
        next.agreementDate = "";
        next.agreementAmount = "";
      }
      return next;
    });
    setSaveError("");
    setNotice("");
  }

  async function loadCredit(id: number, preserveForm = false) {
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    if (!preserveForm) {
      setDetail(null);
      setLoadingDetail(true);
      setSaveError("");
      setNotice("");
      setLastSavedFingerprint("");
      idempotencyKey.current = null;
    }
    setDetailError("");
    try {
      const result = await requestJson<DetailResponse>(`${apiBase}/${id}`, { signal: controller.signal });
      if (controller.signal.aborted || selectedCreditId.current !== id) return;
      if (result.credit.id !== id) throw new Error("La respuesta no corresponde al crédito seleccionado. Actualiza la consulta.");
      setDetail(result);
      if (!preserveForm) {
        const preferredResponsible = result.currentResponsible.id;
        setManagement(freshManagement(preferredResponsible ? String(preferredResponsible) : ""));
      }
    } catch (error) {
      if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : "No fue posible abrir el crédito.");
    } finally {
      if (!controller.signal.aborted) setLoadingDetail(false);
    }
  }

  async function openCredit(item: MoraPortfolioItem) {
    if (submitting.current || extensionFlight.current) return;
    selectedCreditId.current = item.id;
    setSelectedId(item.id);
    setExtensionNotice(null);
    await loadCredit(item.id);
  }

  function refreshPortfolio() {
    if (submitting.current || extensionFlight.current) return;
    setRefreshVersion((value) => value + 1);
    if (selectedCreditId.current) void loadCredit(selectedCreditId.current, true);
  }

  async function exportExcel() {
    if (allCredits || exportFlight.current || loading || saving || submitting.current || extensionBusy
      || extensionFlight.current || listError || !portfolio || portfolio.total === 0) return;
    exportFlight.current = true;
    setExporting(true);
    setExportError("");
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value.trim()) params.set(key, value.trim());
      }
      const response = await fetch(`${apiBase}/export?${params}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new MoraExportError(typeof payload?.error === "string" ? payload.error : "No fue posible generar el Excel. Intenta de nuevo.");
      }
      const mime = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (mime !== xlsxMime) throw new MoraExportError("El servidor no devolvió un archivo Excel válido. Intenta de nuevo.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exportFileName(response.headers.get("Content-Disposition"));
      link.style.display = "none";
      try {
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) {
      setExportError(error instanceof MoraExportError ? error.message : "No fue posible generar el Excel. Revisa tu conexión e intenta de nuevo.");
    } finally {
      exportFlight.current = false;
      setExporting(false);
    }
  }

  function closeDetail() {
    if (submitting.current || extensionFlight.current) return;
    detailController.current?.abort();
    selectedCreditId.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailError("");
    setNotice("");
    setSaveError("");
    setExtensionNotice(null);
  }

  function extensionBusyChanged(busy: boolean) {
    extensionFlight.current = busy;
    setExtensionBusy(busy);
    if (busy) detailController.current?.abort();
  }

  async function extensionChanged(result: ExtensionChange) {
    const id = selectedCreditId.current;
    if (!id || result.item.creditoId !== id) return;
    const item = result.item;
    const active = item.status === "APPROVED" && item.conditionStatus !== "FULFILLED" ? {
      id: item.id, expiresOn: item.expiresOn, reason: item.reason,
      approvedAt: item.decidedAt, approvedByName: item.decidedByName,
      installmentNumber: item.installmentNumber, installmentDueDate: item.installmentDueDate,
    } : null;
    setDetail(current => current?.credit.id === id ? { ...current, credit: { ...current.credit, prorrogaActiva: active,
      estadoGestion: active ? "PRORROGA" : current.history[0]?.managementStatus || "PENDIENTE" } } : current);
    setPortfolio(current => current ? { ...current,
      ...(filters.status === "PRORROGA" && !active ? {
        items: current.items.filter(credit => credit.id !== id),
        total: Math.max(0, current.total - Number(current.items.some(credit => credit.id === id))),
      } : { items: current.items.map(credit => credit.id === id ? { ...credit, prorrogaActiva: active,
        estadoGestion: active ? "PRORROGA" : credit.ultimaGestion?.managementStatus || "PENDIENTE" } : credit) }),
    } : current);
    setExtensionNotice({ message: result.message, warning: result.warning });
    setRefreshVersion(value => value + 1);
    await loadCredit(id, true);
  }

  async function saveManagement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedId || !detail || submitting.current || extensionFlight.current || managementFingerprint === lastSavedFingerprint) return;
    const actedAt = bogotaIso(management.actedAt);
    const nextFollowUpAt = bogotaIso(management.nextFollowUpAt);
    const responsibleUserId = detail.currentResponsible.id;
    if (!actedAt || !nextFollowUpAt || !Number.isSafeInteger(responsibleUserId) || responsibleUserId < 1
      || !management.result || !resultOptions(management.action).includes(management.result) || management.comment.trim().length < 5) {
      setSaveError("Completa la fecha y hora, el responsable, el resultado, el comentario y la próxima gestión.");
      return;
    }
    if (Date.parse(nextFollowUpAt) <= Date.parse(actedAt)) {
      setSaveError("La próxima gestión debe programarse después de la fecha y hora de esta gestión.");
      return;
    }
    const agreementAmount = Number(management.agreementAmount);
    if (management.result === "ACUERDO_PAGO" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(management.agreementDate) ||
        !Number.isFinite(Date.parse(`${management.agreementDate}T12:00:00Z`)) ||
        new Date(`${management.agreementDate}T12:00:00Z`).toISOString().slice(0, 10) !== management.agreementDate ||
        management.agreementDate < management.actedAt.slice(0, 10) ||
        !Number.isFinite(agreementAmount) || agreementAmount <= 0 || agreementAmount > 999_999_999_999.99 ||
        Math.abs(agreementAmount * 100 - Math.round(agreementAmount * 100)) > 0.001)) {
      setSaveError("Indica una fecha de pago válida desde el día de la gestión y un valor acordado mayor a cero.");
      return;
    }

    const key = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = key;
    const input: MoraManagementInput = {
      action: management.action,
      actedAt,
      responsibleUserId,
      result: management.result,
      agreementDate: management.result === "ACUERDO_PAGO" ? management.agreementDate : null,
      agreementAmount: management.result === "ACUERDO_PAGO" ? agreementAmount : null,
      comment: management.comment.trim(),
      nextFollowUpAt,
      managementStatus: management.managementStatus,
      idempotencyKey: key,
    };
    submitting.current = true;
    detailController.current?.abort();
    setSaving(true);
    setSaveError("");
    setNotice("");
    try {
      const result = await requestJson<SaveResponse>(`${apiBase}/${selectedId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      setDetail((current) => current ? {
        ...current,
        credit: { ...current.credit, estadoGestion: current.credit.prorrogaActiva ? "PRORROGA" : result.item.managementStatus },
        history: [result.item, ...current.history.filter((item) => item.id !== result.item.id)],
      } : current);
      setPortfolio((current) => current ? {
        ...current,
        items: current.items.map((item) => item.id === selectedId ? { ...item, ultimaGestion: result.item,
          estadoGestion: item.prorrogaActiva ? "PRORROGA" : result.item.managementStatus } : item),
      } : current);
      setLastSavedFingerprint(managementFingerprint);
      idempotencyKey.current = null;
      setNotice(result.unchanged ? "La gestión ya estaba guardada y se recuperó sin duplicarla." : "Gestión guardada. El historial anterior se conserva.");
      setRefreshVersion((value) => value + 1);
      void loadCredit(selectedId, true);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "No fue posible guardar la gestión.");
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <main className={styles.workspace}>
      <div className={styles.content}>
        <PageHeader
          eyebrow="Aprobaciones"
          title={allCredits ? "Gestión de cartera" : "Cartera en mora"}
          description={allCredits ? "Todos los créditos y su seguimiento. El historial se conserva aunque el cliente se ponga al día." : "Organiza el seguimiento, consulta las prórrogas vigentes y conserva cada gestión. El Excel incluye todos los resultados filtrados, con una fila por crédito."}
          actions={<><Button variant="secondary" disabled={loading || saving || extensionBusy} onClick={refreshPortfolio}><RefreshCw className="h-4 w-4" aria-hidden="true" />Actualizar</Button>{!allCredits ? <Button variant="secondary" disabled={loading || saving || extensionBusy || exporting || !portfolio || portfolio.total === 0 || Boolean(listError)} aria-busy={exporting} onClick={() => void exportExcel()}><Download className="h-4 w-4" aria-hidden="true" />{exporting ? "Exportando..." : "Exportar Excel"}</Button> : null}</>}
        />

        <nav className={styles.views} aria-label="Vistas de cartera">
          {allCredits ? [
            { value: "", label: "Todos", count: portfolio?.counts?.total },
            { value: "EN_MORA", label: "En mora", count: portfolio?.counts?.enMora },
            { value: "AL_DIA", label: "Al día", count: portfolio?.counts?.alDia },
            { value: "PAGADO", label: "Pagados", count: portfolio?.counts?.pagados },
            { value: "ANULADO", label: "Anulados", count: portfolio?.counts?.anulados },
          ].map(view => <button key={view.value} type="button" aria-pressed={filters.financialStatus === view.value} disabled={loading || saving || extensionBusy} onClick={() => { setFormFilters(current => ({ ...current, financialStatus: view.value })); setFilters(current => ({ ...current, financialStatus: view.value })); setPage(1); }}>{view.label}{view.count !== undefined ? <Badge>{view.count.toLocaleString("es-CO")}</Badge> : null}</button>) : <button type="button" aria-pressed={!filters.status} disabled={loading || saving || extensionBusy} onClick={() => { setFormFilters(current => ({ ...current, status: "" })); setFilters(current => ({ ...current, status: "" })); setPage(1); }}>Toda la cartera</button>}
          <button type="button" aria-pressed={filters.status === "PRORROGA"} disabled={loading || saving || extensionBusy} onClick={() => { setFormFilters(current => ({ ...current, status: "PRORROGA" })); setFilters(current => ({ ...current, status: "PRORROGA" })); setPage(1); }}><CalendarClock aria-hidden="true" />Prórrogas activas</button>
        </nav>

        <Card className={styles.filters}>
          <form onSubmit={applyFilters} aria-label={allCredits ? "Filtros de gestión de cartera" : "Filtros de cartera en mora"}>
            <div className={styles.primaryFilters}>
              <label className={styles.search}><span>Buscar crédito o cliente</span><span className={styles.searchField}><Search aria-hidden="true" /><Input value={formFilters.q} onChange={(event) => updateFilter("q", event.target.value)} maxLength={100} placeholder="Número de crédito, nombre, cédula o IMEI" style={{ paddingLeft: "2.5rem" }} /></span></label>
              <label><span>Aliado</span><Select value={formFilters.ally} onChange={(event) => updateFilter("ally", event.target.value)}><option value="">Todos los aliados</option>{portfolio?.allies.map((ally) => <option key={ally.id} value={ally.id}>{ally.nombre}</option>)}</Select></label>
              <label><span>{allCredits ? "Estado de gestión" : "Estado"}</span><Select id="mora-portfolio-status" value={formFilters.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="">Todos los estados</option>{MORA_PORTFOLIO_STATES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</Select></label>
              <Button type="submit" disabled={loading || saving || extensionBusy}><Search aria-hidden="true" />Aplicar filtros</Button>
            </div>
            <div className={styles.filterBottom}>
              <details className={styles.moreFilters}>
                <summary><SlidersHorizontal aria-hidden="true" />Más filtros{[formFilters.responsible, formFilters.followUp, formFilters.minDays, formFilters.maxDays].filter(Boolean).length ? <Badge>{[formFilters.responsible, formFilters.followUp, formFilters.minDays, formFilters.maxDays].filter(Boolean).length}</Badge> : null}</summary>
                <div className={styles.secondaryFilters}>
                  <label><span>Responsable</span><Select value={formFilters.responsible} onChange={(event) => updateFilter("responsible", event.target.value)}><option value="">Todos</option>{portfolio?.responsibles.map((responsible) => <option key={responsible.id} value={responsible.id}>{responsible.nombre}</option>)}</Select></label>
                  <label><span>Próxima gestión</span><Input type="date" value={formFilters.followUp} onChange={(event) => updateFilter("followUp", event.target.value)} /></label>
                  <label><span>Mora desde</span><Input type="number" min={0} step={1} inputMode="numeric" value={formFilters.minDays} onChange={(event) => updateFilter("minDays", event.target.value)} placeholder="Días" /></label>
                  <label><span>Mora hasta</span><Input type="number" min={0} step={1} inputMode="numeric" value={formFilters.maxDays} onChange={(event) => updateFilter("maxDays", event.target.value)} placeholder="Días" /></label>
                </div>
              </details>
              <Button variant="ghost" disabled={loading || saving || extensionBusy} onClick={clearFilters}>Limpiar filtros</Button>
            </div>
          </form>
        </Card>

        {listError ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm">{listError}</div> : null}
        {!allCredits && exportError ? <div role="alert" className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-3 text-sm">{exportError}</div> : null}
        {loading && !portfolio ? <LoadingState label={allCredits ? "Cargando todos los créditos..." : "Cargando cartera en mora..."} /> : null}

        <div className={styles.results}>
          <section className={styles.portfolio} aria-label={allCredits ? "Todos los créditos" : "Créditos en mora"} aria-busy={loading}>
            <header className={styles.listHeader}><div><h2>{filters.status === "PRORROGA" ? "Prórrogas activas" : allCredits ? "Créditos y seguimiento" : "Créditos en mora"}</h2><p>{filters.status === "PRORROGA" ? "Créditos con una prórroga aprobada y vigente." : allCredits ? "Consulta el estado de la cartera y registra llamadas, mensajes y compromisos sin perder gestiones anteriores." : "Revisa el estado vigente y abre un crédito para registrar su seguimiento."}</p></div><span aria-live="polite">{loading ? "Consultando cartera…" : portfolio ? `${portfolio.total.toLocaleString("es-CO")} créditos encontrados` : "Consulta no disponible"}</span></header>
            {portfolio && !portfolio.items.length && !loading ? <Card><EmptyState title="No hay créditos para estos filtros" description="Ajusta los filtros o actualiza la consulta para revisar la cartera disponible." /></Card> : null}
            {portfolio?.items.length ? <DataTable className={styles.tableScroll}>
              <table className={styles.table}>
                <thead><tr>
                  <th scope="col">Crédito y cliente</th><th scope="col">Aliado y equipo</th><th scope="col">{allCredits ? "Estado de cartera" : "Valor vencido"}</th><th scope="col">Última gestión</th><th scope="col">Próxima gestión</th><th scope="col">{allCredits ? "Estado de gestión" : "Estado"}</th><th scope="col">Acciones</th>
                </tr></thead>
                <tbody>{portfolio.items.map((item) => {
                  const managementStatus = portfolioStatus(item);
                  return <tr key={item.id} data-selected={selectedId === item.id || undefined} data-extension={Boolean(item.prorrogaActiva) || undefined}>
                    <td><div className={styles.cellStack}><strong>{item.clienteNombre}</strong><span className={styles.creditNumber}>{item.numeroCreditoVisible}</span><span>Cédula: {item.clienteDocumento || "No disponible"}</span>{item.prorrogaActiva ? <div className={styles.mobileExtension}><StatusPill tone="warning">Prórroga</StatusPill><span>{item.prorrogaActiva.expiresOn ? `Hasta ${displayDay(item.prorrogaActiva.expiresOn)}` : "Sin fecha límite"}</span></div> : null}</div></td>
                    <td><div className={styles.cellStack}><strong>{item.aliadoNombre}</strong><span className={styles.equipment}>{item.equipo || "Equipo no disponible"}</span><span className={styles.imei}>IMEI: {item.imei || "No disponible"}</span></div></td>
                    <td><div className={styles.cellStack}>{allCredits ? <><StatusPill tone={financialTone(item.estadoCartera)}>{financialLabels[item.estadoCartera || ""] || "Estado no disponible"}</StatusPill>{item.estadoCartera === "EN_MORA" ? <><strong className={styles.amount}>{money.format(item.valorVencido)}</strong><span className={styles.overdue}>{item.diasMora} {item.diasMora === 1 ? "día" : "días"} en mora</span></> : item.estadoCartera === "AL_DIA" ? <span>Próximo pago: {item.fechaProximoPago ? displayDay(item.fechaProximoPago) : "Sin fecha pendiente"}</span> : <span>Historial disponible</span>}</> : <><strong className={styles.amount}>{money.format(item.valorVencido)}</strong><span className={styles.overdue}>{item.diasMora} {item.diasMora === 1 ? "día" : "días"} en mora</span></>}</div></td>
                    <td><div className={styles.cellStack}><strong className={styles.result}>{item.ultimaGestion?.result || "Sin gestión"}</strong><span>{item.ultimaGestion?.responsibleName || "Sin asignar"}</span><span>{displayDateTime(item.ultimaGestion?.actedAt)}</span></div></td>
                    <td><div className={styles.cellStack}><span className={styles.followUp}>{displayDateTime(item.ultimaGestion?.nextFollowUpAt)}</span></div></td>
                    <td><div className={styles.cellStack}><StatusPill tone={statusTone(managementStatus)}>{statusLabels[managementStatus] || managementStatus}</StatusPill>{item.prorrogaActiva ? <span className={styles.extensionUntil}>{item.prorrogaActiva.expiresOn ? `Hasta ${displayDay(item.prorrogaActiva.expiresOn)}` : "Sin fecha límite"}</span> : null}</div></td>
                    <td><Button variant="secondary" disabled={saving || extensionBusy} aria-pressed={selectedId === item.id} onClick={() => void openCredit(item)}>Gestionar<ChevronRight className="h-4 w-4" aria-hidden="true" /></Button></td>
                  </tr>;
                })}</tbody>
              </table>
            </DataTable> : null}
            {portfolio ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--fp-border)] px-2 py-4 text-sm text-[var(--fp-muted)]"><span>Página {portfolio.page} · {portfolio.items.length} de {portfolio.total.toLocaleString("es-CO")}</span><div className="flex gap-2"><Button variant="secondary" disabled={loading || saving || extensionBusy || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft className="h-4 w-4" aria-hidden="true" />Anterior</Button><Button variant="secondary" disabled={loading || saving || extensionBusy || !portfolio.hasMore} onClick={() => setPage((value) => value + 1)}>Siguiente<ChevronRight className="h-4 w-4" aria-hidden="true" /></Button></div></div> : null}
          </section>

          <FinserSidePanel open={Boolean(selectedId)} title={allCredits ? "Gestión del crédito" : "Gestión del crédito en mora"} closeLabel="Cerrar gestión" busy={saving || extensionBusy} onClose={closeDetail}>
            {loadingDetail ? <div className="p-5"><LoadingState label="Cargando crédito e historial..." /></div> : null}
            {detailError ? <div className="space-y-3 p-5"><p role="alert" className="text-sm text-[var(--fp-danger)]">{detailError}</p>{portfolio?.items.find((item) => item.id === selectedId) ? <Button variant="secondary" onClick={() => void openCredit(portfolio.items.find((item) => item.id === selectedId)!)}>Reintentar</Button> : null}</div> : null}
            {detail ? <>
              <section className={styles.detailSummary} aria-labelledby="mora-credit-summary">
                <div className={styles.detailHeading}><div><p className={styles.creditNumber}>{detail.credit.numeroCreditoVisible}</p><h3 id="mora-credit-summary">{detail.credit.clienteNombre}</h3><p>{detail.credit.aliadoNombre}</p></div><StatusPill tone={statusTone(portfolioStatus(detail.credit))}>{statusLabels[portfolioStatus(detail.credit)] || portfolioStatus(detail.credit)}</StatusPill></div>
                {detail.credit.prorrogaActiva ? <div className={styles.extensionBanner} role="status"><CalendarClock aria-hidden="true" /><div><strong>Prórroga activa</strong><p>{detail.credit.prorrogaActiva.expiresOn ? `Vigente hasta el ${displayDay(detail.credit.prorrogaActiva.expiresOn)}` : "Sin fecha límite"}</p>{detail.credit.prorrogaActiva.installmentNumber ? <p>Cuota {detail.credit.prorrogaActiva.installmentNumber}{detail.credit.prorrogaActiva.installmentDueDate ? ` · Fecha original: ${displayDay(detail.credit.prorrogaActiva.installmentDueDate)}` : ""}</p> : null}<p>{detail.credit.prorrogaActiva.reason}</p>{detail.credit.prorrogaActiva.approvedByName ? <small>Aprobada por {detail.credit.prorrogaActiva.approvedByName}{detail.credit.prorrogaActiva.approvedAt ? ` · ${displayDateTime(detail.credit.prorrogaActiva.approvedAt)}` : ""}</small> : null}</div></div> : null}
                {extensionNotice ? <div role="status" className={styles.extensionNotice}><p>{extensionNotice.message}</p>{extensionNotice.warning ? <p className={styles.extensionWarning}>{extensionNotice.warning}</p> : null}</div> : null}
                {detail.credit.prorrogaActiva && detail.extensionActions ? <MoraPortfolioExtensionActions
                  key={`${detail.credit.id}:${detail.credit.prorrogaActiva.id}`} creditId={detail.credit.id}
                  extension={detail.credit.prorrogaActiva} capabilities={detail.extensionActions} disabled={saving || extensionBusy}
                  onBusyChange={extensionBusyChanged} onChanged={extensionChanged} /> : null}
                <dl className="grid grid-cols-2 gap-4">
                  {allCredits ? <><DetailValue label="Estado de cartera" value={financialLabels[detail.credit.estadoCartera || ""] || "No disponible"} /><DetailValue label="Saldo pendiente" value={detail.credit.estadoCartera === "ANULADO" ? "No aplica: crédito anulado" : money.format(detail.credit.saldoPendiente || 0)} /><DetailValue label="Próximo pago" value={detail.credit.fechaProximoPago ? displayDay(detail.credit.fechaProximoPago) : "Sin fecha pendiente"} /></> : null}
                  <DetailValue label="Cédula" value={detail.credit.clienteDocumento || "No disponible"} />
                  <DetailValue label="Teléfono" value={detail.credit.clienteTelefono || "No disponible"} />
                  {detail.credit.referenciaFamiliar1Telefono && <DetailValue label="Teléfono de referencia 1" value={detail.credit.referenciaFamiliar1Telefono} />}
                  {detail.credit.referenciaFamiliar2Telefono && <DetailValue label="Teléfono de referencia 2" value={detail.credit.referenciaFamiliar2Telefono} />}
                  <DetailValue label="Equipo" value={detail.credit.equipo || "No disponible"} />
                  <DetailValue label="IMEI" value={detail.credit.imei || "No disponible"} />
                  <DetailValue label="Valor vencido" value={money.format(detail.credit.valorVencido)} />
                  <DetailValue label="Días en mora" value={String(detail.credit.diasMora)} />
                  <DetailValue label="Último pago" value={displayDateTime(detail.credit.ultimoPago)} />
                </dl>
              </section>

              {allCredits ? <CreditCommunications key={detail.credit.id} creditId={detail.credit.id} phone={detail.credit.clienteTelefono}
                disabled={saving || extensionBusy} onBusyChange={extensionBusyChanged}
                onChanged={() => { setRefreshVersion(value => value + 1); if (selectedCreditId.current) void loadCredit(selectedCreditId.current, true); }} /> : null}

              <form onSubmit={saveManagement} className="space-y-4 border-b border-[var(--fp-border)] p-5" aria-labelledby="mora-management-form"><div><h3 id="mora-management-form" className="flex items-center gap-2 font-black"><CircleDollarSign className="h-5 w-5" aria-hidden="true" />{allCredits ? "Registrar gestión realizada" : "Nueva gestión"}</h3><p className="mt-1 text-sm text-[var(--fp-muted)]">{allCredits ? "Registra aquí el resultado real de una llamada o mensaje. Guardar este formulario no envía una comunicación." : "Todos los campos son obligatorios. Cada registro se agrega al historial."}</p></div>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Acción realizada</span><Select id="mora-management-action" required value={management.action} disabled={saving || extensionBusy} onChange={(event) => updateManagement("action", event.target.value as ManagementForm["action"])}>{MORA_ACTIONS.map((action) => <option key={action} value={action}>{actionLabels[action]}</option>)}</Select></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Fecha y hora de gestión <span className="font-normal text-[var(--fp-muted)]">(Bogotá)</span></span><Input required type="datetime-local" step={60} value={management.actedAt} disabled={saving || extensionBusy} onChange={(event) => updateManagement("actedAt", event.target.value)} /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Responsable</span><Input value={detail.currentResponsible.nombre} readOnly aria-readonly="true" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Resultado</span><Select id="mora-management-result" required value={management.result} disabled={saving || extensionBusy} onChange={(event) => updateManagement("result", event.target.value as ManagementForm["result"])}>
                  <option value="">Selecciona el resultado</option>
                  {resultOptions(management.action).map(result => <option key={result} value={result}>{moraResultLabel(result, management.action)}</option>)}
                </Select></label>
                {management.result === "ACUERDO_PAGO" && <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block min-w-0 space-y-1.5"><span className="text-sm font-bold">Fecha de pago acordada</span><Input id="mora-management-agreement-date" required type="date" min={management.actedAt.slice(0, 10)} value={management.agreementDate} disabled={saving || extensionBusy} onChange={event => updateManagement("agreementDate", event.target.value)} /></label>
                  <label className="block min-w-0 space-y-1.5"><span className="text-sm font-bold">Valor acordado (COP)</span><Input id="mora-management-agreement-amount" required type="number" min="0.01" max="999999999999.99" step="0.01" inputMode="decimal" value={management.agreementAmount} disabled={saving || extensionBusy} onChange={event => updateManagement("agreementAmount", event.target.value)} /></label>
                </div>}
                <label className="block space-y-1.5"><span className="text-sm font-bold">Comentario</span><textarea required minLength={5} maxLength={2000} rows={4} value={management.comment} disabled={saving || extensionBusy} onChange={(event) => updateManagement("comment", event.target.value)} placeholder="Registra el contexto y los compromisos acordados" className="fp-ui-input min-h-28 w-full resize-y" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Próxima gestión <span className="font-normal text-[var(--fp-muted)]">(Bogotá)</span></span><Input required type="datetime-local" step={60} value={management.nextFollowUpAt} disabled={saving || extensionBusy} onChange={(event) => updateManagement("nextFollowUpAt", event.target.value)} /></label>
                <label className="block space-y-1.5"><span className="text-sm font-bold">Estado de gestión</span><Select id="mora-management-status" required value={management.managementStatus} disabled={saving || extensionBusy} onChange={(event) => updateManagement("managementStatus", event.target.value as ManagementForm["managementStatus"])}>{MORA_MANAGEMENT_STATES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}</Select></label>
                {saveError ? <p role="alert" className="rounded-[var(--fp-radius-sm)] bg-[var(--fp-danger-soft)] px-3 py-2 text-sm text-[var(--fp-danger)]">{saveError}</p> : null}{notice ? <p role="status" className="rounded-[var(--fp-radius-sm)] bg-[var(--fp-lime-soft)] px-3 py-2 text-sm">{notice}</p> : null}
                <Button type="submit" className="w-full" disabled={saving || extensionBusy || managementFingerprint === lastSavedFingerprint}>{saving ? "Guardando..." : managementFingerprint === lastSavedFingerprint ? "Gestión guardada" : "Guardar gestión"}</Button>
              </form>

              <section className="p-5" aria-labelledby="mora-history-title"><div className="flex items-center justify-between gap-3"><h3 id="mora-history-title" className="flex items-center gap-2 font-black"><History className="h-5 w-5" aria-hidden="true" />Línea de tiempo</h3><Badge>{detail.history.length}</Badge></div>{detail.history.length ? <ol className="mt-4 space-y-4 border-l-2 border-[var(--fp-border)] pl-4">{detail.history.map((item, index) => <li key={item.id} className="relative"><span className="absolute -left-[1.34rem] top-1 h-2.5 w-2.5 rounded-full bg-[var(--fp-lime-strong)] ring-4 ring-[var(--fp-surface)]" /><article className="space-y-2 rounded-[var(--fp-radius-sm)] bg-[var(--fp-bg)] p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><h4 className="font-bold">{actionLabels[item.action]}</h4><p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--fp-muted)]"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{displayDateTime(item.actedAt)}</p></div><StatusPill tone={statusTone(item.managementStatus)}>{statusLabels[item.managementStatus]}</StatusPill></div><p className="flex items-center gap-1 text-sm"><UserRound className="h-4 w-4 text-[var(--fp-muted)]" aria-hidden="true" /><strong>{item.responsibleName}</strong></p><div><p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">Resultado</p><p className="mt-1 break-words text-sm">{item.result}</p></div><div><p className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">Comentario</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.comment}</p></div><p className="flex items-center gap-1 text-xs text-[var(--fp-muted)]"><CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />Próxima gestión: {displayDateTime(item.nextFollowUpAt)}</p><p className="text-xs text-[var(--fp-muted)]">Registró {item.actorName} · {displayDateTime(item.createdAt)}</p><MoraSupports creditoId={detail.credit.id} subjectKind="GESTION" subjectId={item.id} defaultOpen={index === 0} /></article></li>)}</ol> : <EmptyState className="mt-4" title="Sin gestiones registradas" description="La primera gestión quedará visible aquí y no reemplazará registros anteriores." />}</section>
            </> : null}
          </FinserSidePanel>
        </div>
      </div>
    </main>
  );
}
