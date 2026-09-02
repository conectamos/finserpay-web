"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowRightLeft,
  Ban,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Eye,
  Filter,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Store,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
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
  SOLICITUD_FILTER_STATES,
  SOLICITUD_STATE_LABELS,
  type SolicitudAction,
  type SolicitudStage,
  type SolicitudState,
} from "@/lib/solicitudes";

type ViewerRole = "ADMIN" | "SUPERVISOR" | "SELLER";
type NamedEntity = { id: number; nombre: string };

type SolicitudItem = {
  id: string;
  source: "DRAFT" | "CREDIT";
  numero: string;
  clienteNombre: string;
  documento: string | null;
  telefono?: string | null;
  imei: string | null;
  plataforma: string | null;
  estado: SolicitudState;
  processStage?: Exclude<SolicitudStage, "ENTREGADA"> | null;
  deliveryStage?: "LISTA_PARA_ENTREGA" | "ENTREGADA" | null;
  creadoPor: string | null;
  aliado: NamedEntity | null;
  sede: NamedEntity | null;
  asesor: NamedEntity | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  fechaCreacion?: string | null;
  fechaActualizacion?: string | null;
  fechaVencimiento?: string | null;
  currentStep?: number | null;
  closedReason?: string | null;
  technicalError?: boolean;
  technicalErrorCode?: string | null;
  retomarHref?: string | null;
  creditHref?: string | null;
  replacementHref?: string | null;
  actions: SolicitudAction[];
};

type FilterOption =
  | string
  | number
  | {
      id?: string | number;
      value?: string | number;
      label?: string;
      nombre?: string;
    };

type SolicitudOptions = {
  aliados?: FilterOption[];
  sedes?: FilterOption[];
  asesores?: FilterOption[];
  plataformas?: FilterOption[];
};

type ListResponse = {
  items: SolicitudItem[];
  total: number;
  page: number;
  pageSize: number;
  options?: SolicitudOptions;
};

type FormFilters = {
  q: string;
  desde: string;
  hasta: string;
  aliadoId: string;
  sedeId: string;
  asesorId: string;
  plataforma: string;
  estado: string;
};

const FILTER_KEYS: Array<keyof FormFilters> = [
  "q",
  "desde",
  "hasta",
  "aliadoId",
  "sedeId",
  "asesorId",
  "plataforma",
  "estado",
];

function readFilters(params: URLSearchParams): FormFilters {
  return {
    q: params.get("q") || "",
    desde: params.get("desde") || "",
    hasta: params.get("hasta") || "",
    aliadoId: params.get("aliadoId") || "",
    sedeId: params.get("sedeId") || "",
    asesorId: params.get("asesorId") || "",
    plataforma: params.get("plataforma") || "",
    estado: params.get("estado") || "",
  };
}

function displayDate(value?: string | null) {
  if (!value) return "Sin registro";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Sin registro";

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(parsed);
}

function stateTone(state: SolicitudState) {
  if (["APROBADA", "LISTA_PARA_ENTREGA", "ENTREGADA"].includes(state)) {
    return "positive" as const;
  }
  if (["RECHAZADA", "CANCELADA", "ERROR_TECNICO"].includes(state)) {
    return "danger" as const;
  }
  return "warning" as const;
}

function StateBadges({ item }: { item: SolicitudItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusPill tone={stateTone(item.estado)}>
        {SOLICITUD_STATE_LABELS[item.estado] || item.estado}
      </StatusPill>
      {item.processStage ? (
        <Badge tone="warning">
          {SOLICITUD_STATE_LABELS[item.processStage]}
        </Badge>
      ) : null}
      {item.deliveryStage ? (
        <Badge tone="positive">
          {SOLICITUD_STATE_LABELS[item.deliveryStage]}
        </Badge>
      ) : null}
    </div>
  );
}

function optionValue(option: FilterOption) {
  if (typeof option === "string" || typeof option === "number") return String(option);
  return String(option.value ?? option.id ?? "");
}

function optionLabel(option: FilterOption) {
  if (typeof option === "string" || typeof option === "number") return String(option);
  return String(option.label ?? option.nombre ?? option.value ?? option.id ?? "");
}

function entityName(value?: NamedEntity | null) {
  return value?.nombre || null;
}

function rawId(id: string) {
  return id.replace(/^[A-Z]-/i, "");
}

function resumeHref(item: SolicitudItem) {
  if (item.retomarHref) return item.retomarHref;
  const params = new URLSearchParams({
    draft: rawId(item.id),
    mode: "create-client",
  });
  const platform = String(item.plataforma || "").trim().toLowerCase();
  if (platform === "android" || platform === "iphone") {
    params.set("platform", platform);
  }
  return `/dashboard/creditos?${params.toString()}`;
}

function creditHref(item: SolicitudItem, viewerRole: ViewerRole) {
  if (item.creditHref) return item.creditHref;
  const id = rawId(item.id);
  return viewerRole === "ADMIN"
    ? `/dashboard/creditos?mode=correction&selected=${encodeURIComponent(id)}`
    : `/dashboard/clientes?selected=${encodeURIComponent(id)}`;
}

function replacementHref(item: SolicitudItem, returnTo: string) {
  const configuredHref = item.replacementHref;
  const href = configuredHref || `/dashboard/creditos?mode=replacement&selected=${encodeURIComponent(rawId(item.id))}`;
  const [pathname, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set("returnTo", returnTo);
  return `${pathname}?${params.toString()}`;
}

function factoryHref(
  item: SolicitudItem,
  viewerRole: ViewerRole,
  returnTo: string
) {
  const href = item.source === "DRAFT"
    ? resumeHref(item)
    : creditHref(item, viewerRole);
  const [pathname, query = ""] = href.split("?");
  if (pathname !== "/dashboard/creditos") return href;
  const params = new URLSearchParams(query);
  params.set("returnTo", returnTo);
  return `${pathname}?${params.toString()}`;
}

function DetailLine({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  return (
    <div className="min-w-0 border-b border-[var(--fp-border)] py-3 last:border-b-0">
      <dt className="text-xs font-bold uppercase tracking-wide text-[var(--fp-muted)]">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm font-semibold text-[var(--fp-graphite)]">
        {value || "Sin registro"}
      </dd>
    </div>
  );
}

export default function SolicitudesWallClient({
  viewerRole = "ADMIN",
}: {
  viewerRole?: ViewerRole;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const paramsKey = searchParams.toString();
  const wallReturnHref = `/dashboard/solicitudes${
    paramsKey ? `?${paramsKey}` : ""
  }`;
  const selectedId = searchParams.get("id") || "";
  const [formFilters, setFormFilters] = useState<FormFilters>(() =>
    readFilters(new URLSearchParams(paramsKey))
  );
  const [list, setList] = useState<ListResponse | null>(null);
  const [detail, setDetail] = useState<SolicitudItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [desistTarget, setDesistTarget] = useState<SolicitudItem | null>(null);
  const [desisting, setDesisting] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    setFormFilters(readFilters(new URLSearchParams(paramsKey)));
  }, [paramsKey]);

  const listQuery = useMemo(() => {
    const params = new URLSearchParams(paramsKey);
    params.delete("id");
    return params.toString();
  }, [paramsKey]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");

    fetch(`/api/solicitudes${listQuery ? `?${listQuery}` : ""}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (ListResponse & { error?: string })
          | null;
        if (!response.ok) {
          throw new Error(payload?.error || "No fue posible cargar las solicitudes.");
        }
        return payload;
      })
      .then((payload) => {
        if (!payload) throw new Error("La respuesta del muro no es válida.");
        setList({
          items: Array.isArray(payload.items) ? payload.items : [],
          total: Number(payload.total || 0),
          page: Math.max(1, Number(payload.page || 1)),
          pageSize: Math.max(1, Number(payload.pageSize || 25)),
          options: payload.options || {},
        });
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : "No fue posible cargar las solicitudes."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [listQuery, reloadToken]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError("");
      return;
    }

    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);

    fetch(`/api/solicitudes?id=${encodeURIComponent(selectedId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | {
              detail?: SolicitudItem;
              item?: SolicitudItem;
              solicitud?: SolicitudItem;
              items?: SolicitudItem[];
              error?: string;
              id?: string;
            }
          | null;
        if (!response.ok) {
          throw new Error(payload?.error || "No fue posible abrir el detalle.");
        }
        const candidate =
          payload?.detail ||
          payload?.item ||
          payload?.solicitud ||
          payload?.items?.[0] ||
          (payload?.id ? (payload as SolicitudItem) : null);
        if (!candidate) throw new Error("La solicitud ya no está disponible.");
        return candidate;
      })
      .then(setDetail)
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setDetailError(
          requestError instanceof Error
            ? requestError.message
            : "No fue posible abrir el detalle."
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });

    return () => controller.abort();
  }, [selectedId, reloadToken]);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !desisting && !desistTarget) closeDetail();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  const updateUrl = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(paramsKey);
      mutate(params);
      router.push(`/dashboard/solicitudes${params.size ? `?${params.toString()}` : ""}`);
    },
    [paramsKey, router]
  );

  function closeDetail() {
    updateUrl((params) => params.delete("id"));
  }

  function openDetail(item: SolicitudItem) {
    updateUrl((params) => params.set("id", item.id));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateUrl((params) => {
      for (const key of FILTER_KEYS) {
        const value = formFilters[key].trim();
        if (value) params.set(key, value);
        else params.delete(key);
      }
      params.delete("id");
      params.delete("page");
    });
  }

  function clearFilters() {
    setFormFilters(readFilters(new URLSearchParams()));
    router.push("/dashboard/solicitudes");
  }

  function goToPage(page: number) {
    updateUrl((params) => {
      params.set("page", String(page));
      params.delete("id");
    });
  }

  async function confirmDesist() {
    if (!desistTarget) return;
    setDesisting(true);
    setNotice("");
    try {
      const response = await fetch("/api/solicitudes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: desistTarget.id, action: "DESISTIR" }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; identityReleased?: boolean }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error || "No fue posible desistir la solicitud.");
      }
      setDesistTarget(null);
      setNotice(
        payload?.identityReleased
          ? "La solicitud fue desistida y dejó de bloquear una nueva venta."
          : "La solicitud fue desistida, pero existen otros expedientes para esta cédula. El administrador central debe gestionarlos antes de iniciar otra venta."
      );
      updateUrl((params) => params.delete("id"));
      setReloadToken((value) => value + 1);
    } catch (requestError) {
      setNotice(
        requestError instanceof Error
          ? requestError.message
          : "No fue posible desistir la solicitud."
      );
    } finally {
      setDesisting(false);
    }
  }

  const totalPages = list
    ? Math.max(1, Math.ceil(list.total / Math.max(1, list.pageSize)))
    : 1;
  const options = list?.options || {};
  const hasFilters = FILTER_KEYS.some((key) => Boolean(searchParams.get(key)));

  return (
    <>
      <PageHeader
        eyebrow="Operación"
        title="Muro de solicitudes"
        description="Consulta el avance de cada venta sin ejecutar nuevas validaciones externas."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone="neutral">
              {loading && !list ? "Consultando" : `${list?.total || 0} solicitudes`}
            </Badge>
            <Button
              variant="secondary"
              onClick={() => setReloadToken((value) => value + 1)}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Actualizar
            </Button>
          </div>
        }
      />

      {notice ? (
        <div
          className="mt-4 flex items-start justify-between gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-white px-4 py-3 text-sm text-[var(--fp-graphite)]"
          role="status"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-md text-[var(--fp-muted)] hover:bg-[var(--fp-bg)]"
            aria-label="Cerrar mensaje"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      <Card className="mt-5 p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2">
          <Filter className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />
          <h2 className="text-sm font-black text-[var(--fp-graphite)]">Filtros operativos</h2>
        </div>

        <form onSubmit={applyFilters} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-12">
          <label className="sm:col-span-2 xl:col-span-4">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Buscar</span>
            <span className="relative block">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--fp-muted)]"
                aria-hidden="true"
              />
              <Input
                value={formFilters.q}
                onChange={(event) =>
                  setFormFilters((current) => ({ ...current, q: event.target.value }))
                }
                placeholder="Cédula, nombre, solicitud o IMEI"
                className="pl-10"
                style={{ paddingLeft: "2.5rem" }}
              />
            </span>
          </label>

          <label className="xl:col-span-2">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Desde</span>
            <Input
              type="date"
              value={formFilters.desde}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, desde: event.target.value }))
              }
            />
          </label>

          <label className="xl:col-span-2">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Hasta</span>
            <Input
              type="date"
              value={formFilters.hasta}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, hasta: event.target.value }))
              }
            />
          </label>

          <label className="xl:col-span-2">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Estado</span>
            <Select
              value={formFilters.estado}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, estado: event.target.value }))
              }
            >
              <option value="">Todos</option>
              {SOLICITUD_FILTER_STATES.map((state) => (
                <option key={state} value={state}>
                  {SOLICITUD_STATE_LABELS[state]}
                </option>
              ))}
            </Select>
          </label>

          <label className="xl:col-span-2">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Plataforma</span>
            <Select
              value={formFilters.plataforma}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, plataforma: event.target.value }))
              }
            >
              <option value="">Todas</option>
              {(options.plataformas || []).map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </Select>
          </label>

          <label className="xl:col-span-4">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Aliado</span>
            <Select
              value={formFilters.aliadoId}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, aliadoId: event.target.value }))
              }
            >
              <option value="">Todos los permitidos</option>
              {(options.aliados || []).map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </Select>
          </label>

          <label className="xl:col-span-4">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Sede</span>
            <Select
              value={formFilters.sedeId}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, sedeId: event.target.value }))
              }
            >
              <option value="">Todas las permitidas</option>
              {(options.sedes || []).map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </Select>
          </label>

          <label className="xl:col-span-4">
            <span className="mb-1.5 block text-xs font-bold text-[var(--fp-muted)]">Asesor</span>
            <Select
              value={formFilters.asesorId}
              onChange={(event) =>
                setFormFilters((current) => ({ ...current, asesorId: event.target.value }))
              }
            >
              <option value="">Todos los permitidos</option>
              {(options.asesores || []).map((option) => (
                <option key={optionValue(option)} value={optionValue(option)}>
                  {optionLabel(option)}
                </option>
              ))}
            </Select>
          </label>

          <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row sm:justify-end xl:col-span-12">
            {hasFilters ? (
              <Button type="button" variant="ghost" onClick={clearFilters}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Limpiar
              </Button>
            ) : null}
            <Button type="submit">
              <Search className="h-4 w-4" aria-hidden="true" />
              Aplicar filtros
            </Button>
          </div>
        </form>
      </Card>

      <section className="mt-5" aria-labelledby="solicitudes-results-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="solicitudes-results-title" className="text-lg font-black">
              Solicitudes visibles
            </h2>
            <p className="mt-1 text-sm text-[var(--fp-muted)]">
              El alcance se aplica automáticamente según organización, sede y asesor.
            </p>
          </div>
          {list && list.total > 0 ? (
            <span className="text-xs font-semibold text-[var(--fp-muted)]">
              Página {list.page} de {totalPages}
            </span>
          ) : null}
        </div>

        {loading && !list ? (
          <LoadingState label="Cargando solicitudes..." />
        ) : error ? (
          <EmptyState
            title="No se pudo cargar el muro"
            description={error}
            action={
              <Button variant="secondary" onClick={() => setReloadToken((value) => value + 1)}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Reintentar
              </Button>
            }
          />
        ) : !list?.items.length ? (
          <EmptyState
            title="No hay solicitudes para estos filtros"
            description="Ajusta la búsqueda o limpia los filtros para ampliar los resultados."
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clearFilters}>
                  Limpiar filtros
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden lg:block">
              <DataTable className="bg-white">
                <table className="w-full min-w-[1120px] border-collapse text-left text-sm">
                  <thead className="bg-[var(--fp-graphite)] text-white">
                    <tr>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Solicitud</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Estado</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Organización</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Responsable</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Equipo</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-wide">Fecha de creación</th>
                      <th className="px-4 py-3 text-right text-xs font-bold uppercase tracking-wide">Acciones</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--fp-border)]">
                    {list.items.map((item) => (
                      <tr key={item.id} className="align-top transition hover:bg-[var(--fp-bg)]">
                        <td className="px-4 py-4">
                          <strong className="block text-[var(--fp-graphite)]">{item.clienteNombre || "Sin nombre"}</strong>
                          <span className="mt-1 block text-xs text-[var(--fp-muted)]">{item.numero}</span>
                          <span className="mt-1 block text-xs font-semibold text-[var(--fp-muted)]">{item.documento || "Documento no disponible"}</span>
                        </td>
                        <td className="px-4 py-4"><StateBadges item={item} /></td>
                        <td className="px-4 py-4 text-sm">
                          <span className="block font-semibold">{entityName(item.aliado) || "Sin aliado"}</span>
                          <span className="mt-1 block text-xs text-[var(--fp-muted)]">{entityName(item.sede) || "Sin sede"}</span>
                        </td>
                        <td className="px-4 py-4 text-sm">
                          <span className="block font-semibold">{entityName(item.asesor) || item.creadoPor || "Sin asignar"}</span>
                          <span className="mt-1 block text-xs text-[var(--fp-muted)]">Creó: {item.creadoPor || "Sin registro"}</span>
                        </td>
                        <td className="px-4 py-4 text-sm">
                          <span className="block font-semibold">{item.plataforma || "Sin plataforma"}</span>
                          <span className="mt-1 block font-mono text-xs text-[var(--fp-muted)]">{item.imei || "IMEI no disponible"}</span>
                        </td>
                        <td className="px-4 py-4 text-xs text-[var(--fp-muted)]">
                          <span className="block">{displayDate(item.createdAt || item.fechaCreacion)}</span>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex justify-end gap-2">
                            {item.actions.includes("DESISTIR") ? (
                              <Button variant="danger" onClick={() => setDesistTarget(item)}>
                                <Ban className="h-4 w-4" aria-hidden="true" />
                                Desistir
                              </Button>
                            ) : null}
                            {item.actions.includes("CAMBIO_GARANTIA") ? (
                              <Link
                                href={replacementHref(item, wallReturnHref)}
                                className="fp-ui-button is-secondary whitespace-nowrap"
                              >
                                <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                                Cambio garantía
                              </Link>
                            ) : null}
                            {item.actions.includes("ABRIR_FABRICA") ? (
                              <Link
                                href={factoryHref(item, viewerRole, wallReturnHref)}
                                className="fp-ui-button is-secondary whitespace-nowrap"
                              >
                                {item.source === "DRAFT" ? (
                                  <PlayCircle className="h-4 w-4" aria-hidden="true" />
                                ) : (
                                  <Eye className="h-4 w-4" aria-hidden="true" />
                                )}
                                {item.source === "DRAFT" ? "Continuar" : "Ver"}
                              </Link>
                            ) : item.actions.includes("VER_DETALLE") ? (
                              <Button variant="secondary" onClick={() => openDetail(item)}>
                                <Eye className="h-4 w-4" aria-hidden="true" />
                                Ver
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </DataTable>
            </div>

            <div className="grid gap-3 lg:hidden">
              {list.items.map((item) => (
                <Card key={item.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-black">{item.clienteNombre || "Sin nombre"}</p>
                      <p className="mt-1 text-xs text-[var(--fp-muted)]">{item.numero} · {item.documento || "Sin documento"}</p>
                    </div>
                    <ClipboardList className="h-5 w-5 shrink-0 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                  </div>
                  <div className="mt-3"><StateBadges item={item} /></div>
                  <dl className="mt-3 grid gap-2 border-y border-[var(--fp-border)] py-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-bold text-[var(--fp-muted)]">Sede</dt>
                      <dd className="mt-1 font-semibold">{entityName(item.sede) || entityName(item.aliado) || "Sin registro"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-[var(--fp-muted)]">Asesor</dt>
                      <dd className="mt-1 font-semibold">{entityName(item.asesor) || item.creadoPor || "Sin asignar"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-[var(--fp-muted)]">Plataforma / IMEI</dt>
                      <dd className="mt-1 font-semibold">{item.plataforma || "—"} · <span className="font-mono text-xs">{item.imei || "—"}</span></dd>
                    </div>
                    <div>
                      <dt className="text-xs font-bold text-[var(--fp-muted)]">Fecha de creación</dt>
                      <dd className="mt-1 font-semibold">{displayDate(item.createdAt || item.fechaCreacion)}</dd>
                    </div>
                  </dl>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    {item.actions.includes("DESISTIR") ? (
                      <Button variant="danger" onClick={() => setDesistTarget(item)}>
                        <Ban className="h-4 w-4" aria-hidden="true" />
                        Desistir
                      </Button>
                    ) : null}
                    {item.actions.includes("CAMBIO_GARANTIA") ? (
                      <Link
                        href={replacementHref(item, wallReturnHref)}
                        className="fp-ui-button is-secondary"
                      >
                        <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                        Cambio garantía
                      </Link>
                    ) : null}
                    {item.actions.includes("ABRIR_FABRICA") ? (
                      <Link
                        href={factoryHref(item, viewerRole, wallReturnHref)}
                        className="fp-ui-button is-secondary"
                      >
                        {item.source === "DRAFT" ? (
                          <PlayCircle className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <Eye className="h-4 w-4" aria-hidden="true" />
                        )}
                        {item.source === "DRAFT" ? "Continuar" : "Ver"}
                      </Link>
                    ) : item.actions.includes("VER_DETALLE") ? (
                      <Button variant="secondary" onClick={() => openDetail(item)}>
                        <Eye className="h-4 w-4" aria-hidden="true" />
                        Ver detalle
                      </Button>
                    ) : null}
                  </div>
                </Card>
              ))}
            </div>

            {totalPages > 1 ? (
              <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Paginación de solicitudes">
                <Button
                  variant="secondary"
                  onClick={() => goToPage(Math.max(1, (list?.page || 1) - 1))}
                  disabled={(list?.page || 1) <= 1 || loading}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Anterior
                </Button>
                <span className="text-sm font-semibold text-[var(--fp-muted)]">
                  {list?.page || 1} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  onClick={() => goToPage(Math.min(totalPages, (list?.page || 1) + 1))}
                  disabled={(list?.page || 1) >= totalPages || loading}
                >
                  Siguiente
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </nav>
            ) : null}
          </>
        )}
      </section>

      {selectedId ? (
        <div
          className="fixed inset-0 z-70 flex justify-end bg-[#071827]/65"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !desisting) closeDetail();
          }}
        >
          <aside
            className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-[var(--fp-border)] bg-white shadow-[var(--fp-shadow-md)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="solicitud-detail-title"
          >
            <header className="flex items-start justify-between gap-4 border-b border-[var(--fp-border)] px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-xs font-bold uppercase tracking-wide text-[var(--fp-lime-strong)]">Detalle operativo</p>
                <h2 id="solicitud-detail-title" className="mt-1 truncate text-xl font-black">
                  {detail?.numero || selectedId}
                </h2>
              </div>
              <button
                type="button"
                onClick={closeDetail}
                disabled={desisting}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--fp-radius-md)] text-[var(--fp-muted)] transition hover:bg-[var(--fp-bg)] hover:text-[var(--fp-graphite)] disabled:opacity-50"
                aria-label="Cerrar detalle"
                autoFocus
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
              {detailLoading ? (
                <LoadingState label="Abriendo solicitud..." />
              ) : detailError ? (
                <EmptyState
                  title="No se pudo abrir el detalle"
                  description={detailError}
                  action={
                    <Button variant="secondary" onClick={() => setReloadToken((value) => value + 1)}>
                      Reintentar
                    </Button>
                  }
                />
              ) : detail ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <StateBadges item={detail} />
                    <Badge tone="neutral">{detail.source === "DRAFT" ? "Solicitud en proceso" : "Crédito finalizado"}</Badge>
                  </div>

                  <section className="mt-5" aria-labelledby="detail-client-title">
                    <div className="flex items-center gap-2">
                      <UserRound className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                      <h3 id="detail-client-title" className="text-sm font-black">Cliente y equipo</h3>
                    </div>
                    <dl className="mt-2">
                      <DetailLine label="Cliente" value={detail.clienteNombre} />
                      <DetailLine label="Documento" value={detail.documento} />
                      <DetailLine label="Plataforma" value={detail.plataforma} />
                      <DetailLine label="IMEI" value={detail.imei} />
                    </dl>
                  </section>

                  <section className="mt-6" aria-labelledby="detail-assignment-title">
                    <div className="flex items-center gap-2">
                      <Store className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                      <h3 id="detail-assignment-title" className="text-sm font-black">Asignación</h3>
                    </div>
                    <dl className="mt-2">
                      <DetailLine label="Aliado" value={entityName(detail.aliado)} />
                      <DetailLine label="Sede" value={entityName(detail.sede)} />
                      <DetailLine label="Asesor titular" value={entityName(detail.asesor)} />
                      <DetailLine label="Creada por" value={detail.creadoPor} />
                    </dl>
                  </section>

                  <section className="mt-6" aria-labelledby="detail-dates-title">
                    <div className="flex items-center gap-2">
                      <CalendarDays className="h-4 w-4 text-[var(--fp-lime-strong)]" aria-hidden="true" />
                      <h3 id="detail-dates-title" className="text-sm font-black">Trazabilidad</h3>
                    </div>
                    <dl className="mt-2">
                      <DetailLine label="Creada" value={displayDate(detail.createdAt || detail.fechaCreacion)} />
                      <DetailLine label="Última actualización" value={displayDate(detail.updatedAt || detail.fechaActualizacion)} />
                      {detail.expiresAt || detail.fechaVencimiento ? (
                        <DetailLine label="Desistimiento automático" value={displayDate(detail.expiresAt || detail.fechaVencimiento)} />
                      ) : null}
                    </dl>
                  </section>

                  {detail.technicalError ? (
                    <div className="mt-6 rounded-[var(--fp-radius-md)] border border-[#f3b7b2] bg-[var(--fp-danger-soft)] p-4 text-sm text-[var(--fp-danger)]" role="alert">
                      <strong className="block">Error técnico registrado</strong>
                      <span className="mt-1 block">
                        {detail.technicalErrorCode ||
                          "La integración reportó un error. El asesor puede retomar o desistir según las acciones disponibles."}
                      </span>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            {detail ? (
              <footer className="border-t border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-4 sm:px-6">
                <div className="flex flex-wrap justify-end gap-2">
                  {detail.actions.includes("CAMBIO_GARANTIA") ? (
                    <Link
                      href={replacementHref(detail, wallReturnHref)}
                      className="fp-ui-button is-secondary"
                    >
                      <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
                      Cambio por garantía
                    </Link>
                  ) : null}
                  {detail.actions.includes("ABRIR_FABRICA") ? (
                    <Link
                      href={factoryHref(detail, viewerRole, wallReturnHref)}
                      className="fp-ui-button is-primary"
                    >
                      <PlayCircle className="h-4 w-4" aria-hidden="true" />
                      {detail.source === "DRAFT"
                        ? "Continuar solicitud"
                        : "Abrir fábrica"}
                    </Link>
                  ) : null}
                </div>
                {detail.actions.includes("DESISTIR") ? (
                  <div className="mt-4 border-t border-[var(--fp-border)] pt-4">
                    <Button variant="danger" onClick={() => setDesistTarget(detail)}>
                      <Ban className="h-4 w-4" aria-hidden="true" />
                      Desistir solicitud
                    </Button>
                    <p className="mt-2 text-xs leading-5 text-[var(--fp-muted)]">
                      Esta acción libera el documento para una nueva venta y no elimina el historial.
                    </p>
                  </div>
                ) : null}
              </footer>
            ) : null}
          </aside>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(desistTarget)}
        title="Desistir esta solicitud"
        description={`La solicitud ${desistTarget?.numero || "seleccionada"} se cerrará y conservará su historial. Si existen otros expedientes para la misma cédula, el administrador central deberá gestionarlos antes de iniciar otra venta.`}
        confirmLabel="Sí, desistir"
        danger
        busy={desisting}
        onCancel={() => {
          if (!desisting) setDesistTarget(null);
        }}
        onConfirm={confirmDesist}
      />
    </>
  );
}
