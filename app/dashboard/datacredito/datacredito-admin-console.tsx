"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  FileSearch,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  Input,
  LoadingState,
  MetricCard,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";
import type {
  DataCreditoAdminRiskSummary,
  DataCreditoSanitizedProviderPayload,
} from "@/lib/datacredito/admin-report";

type Offer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
} | null;

type AssessmentItem = {
  id: string;
  documentLabel: string;
  platform: "ANDROID" | "IPHONE";
  providerEnvironment: string;
  status: string;
  score: number | null;
  decision: string | null;
  offer: Offer;
  policyVersion: number;
  consentAt: string | null;
  actor: {
    userId: number;
    userName: string;
    sellerId: number | null;
    sellerName: string | null;
    sedeId: number;
    sedeName: string;
    aliadoId: number | null;
    aliadoName: string | null;
  };
  correlationId: string;
  transactionCode: string | null;
  providerStatus: string | null;
  errorCode: string | null;
  durationMs: number | null;
  expiresAt: string | null;
  consumedAt: string | null;
  creditId: number | null;
  retainedUntil: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

type ProviderInfo = {
  enabled: boolean;
  environment: string;
  isProduction: boolean;
};

type ListResponse = {
  ok?: boolean;
  error?: string;
  items?: AssessmentItem[];
  nextCursor?: string | null;
  provider?: ProviderInfo;
};

type DetailResponse = {
  ok?: boolean;
  error?: string;
  assessment?: AssessmentItem;
  identity?: {
    documentNumber: string;
    firstSurname: string;
  } | null;
  summary?: DataCreditoAdminRiskSummary | null;
  providerData?: DataCreditoSanitizedProviderPayload | null;
  historicWithoutDossier?: boolean;
};

type Filters = {
  documentNumber: string;
  status: string;
  platform: string;
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: Filters = {
  documentNumber: "",
  status: "",
  platform: "",
  dateFrom: "",
  dateTo: "",
};

function currency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "No disponible";
  }

  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

function dateTime(value: string | null | undefined) {
  if (!value) return "No disponible";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "No disponible"
    : new Intl.DateTimeFormat("es-CO", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "America/Bogota",
      }).format(date);
}

function scoreLabel(score: number | null | undefined) {
  if (score === -1) return "Sin información";
  return Number.isInteger(score) ? String(score) : "No disponible";
}

function statusTone(status: string) {
  if (status === "APROBADO") return "positive" as const;
  if (status === "RECHAZADO") return "danger" as const;
  if (status === "PENDING") return "warning" as const;
  return "neutral" as const;
}

function isProductionProviderEnvironment(value: string | null | undefined) {
  return ["prod", "production"].includes(String(value || "").toLowerCase());
}

export default function DataCreditoAdminConsole() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<Filters>(EMPTY_FILTERS);
  const [items, setItems] = useState<AssessmentItem[]>([]);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const listRequestSequenceRef = useRef(0);
  const detailRequestSequenceRef = useRef(0);

  const loadItems = useCallback(
    async (input: Filters, cursor: string | null = null) => {
      const requestSequence = ++listRequestSequenceRef.current;
      if (cursor) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError("");
      try {
        const response = await fetch(
          "/api/creditos/datacredito/admin/evaluaciones",
          {
            method: "POST",
            cache: "no-store",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...input, cursor, limit: 25 }),
          }
        );
        const payload = (await response.json().catch(() => ({}))) as ListResponse;
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.error || "No se pudo cargar el historial");
        }
        if (requestSequence !== listRequestSequenceRef.current) return;
        const page = Array.isArray(payload.items) ? payload.items : [];
        setItems((current) => (cursor ? [...current, ...page] : page));
        setNextCursor(payload.nextCursor || null);
        setProvider(payload.provider || null);
      } catch (loadError) {
        if (requestSequence !== listRequestSequenceRef.current) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "No se pudo cargar el historial"
        );
      } finally {
        if (requestSequence === listRequestSequenceRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadItems(EMPTY_FILTERS);
  }, [loadItems]);

  const openDetail = useCallback(async (id: string) => {
    const requestSequence = ++detailRequestSequenceRef.current;
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    setError("");
    try {
      const response = await fetch(
        "/api/creditos/datacredito/admin/evaluaciones/" +
          encodeURIComponent(id),
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      const payload = (await response.json().catch(() => ({}))) as DetailResponse;
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error || "No se pudo abrir el expediente");
      }
      if (requestSequence !== detailRequestSequenceRef.current) return;
      setDetail(payload);
    } catch (detailError) {
      if (requestSequence !== detailRequestSequenceRef.current) return;
      setError(
        detailError instanceof Error
          ? detailError.message
          : "No se pudo abrir el expediente"
      );
      setSelectedId(null);
    } finally {
      if (requestSequence === detailRequestSequenceRef.current) {
        setDetailLoading(false);
      }
    }
  }, []);

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = {
      ...filters,
      documentNumber: filters.documentNumber.replace(/\D/g, "").slice(0, 13),
    };
    setAppliedFilters(normalized);
    detailRequestSequenceRef.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    void loadItems(normalized);
  }

  const summary = detail?.summary ?? null;
  const risk = summary?.risk ?? null;
  const totals = summary?.totals ?? null;
  const sectors = summary?.sectors ?? [];
  const providerScore = risk?.score ?? null;
  const appliedScore = detail?.assessment?.score ?? null;
  const scoreMismatch =
    Number.isInteger(providerScore) &&
    Number.isInteger(appliedScore) &&
    providerScore !== appliedScore;
  const nonProductionVisibleCount = items.filter(
    (item) => !isProductionProviderEnvironment(item.providerEnvironment)
  ).length;
  const telco = sectors.find((sector) => sector.isTelcos) ?? null;
  const reportIdentity = summary?.identity ?? null;
  const detailDocument =
    detail?.identity?.documentNumber ||
    reportIdentity?.documentNumber ||
    reportIdentity?.queriedDocumentNumber ||
    detail?.assessment?.documentLabel ||
    "No disponible";
  const reportName = [
    reportIdentity?.firstName,
    reportIdentity?.secondName,
    reportIdentity?.firstSurname,
    reportIdentity?.secondSurname,
  ]
    .filter(Boolean)
    .join(" ");
  const detailName =
    reportIdentity?.fullName ||
    reportName ||
    detail?.identity?.firstSurname ||
    "Consulta histórica sin identidad recuperable";

  return (
    <main className="px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <div className="mx-auto max-w-[1680px] space-y-5">
        <header className="flex flex-col gap-4 border-b border-[var(--fp-border)] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#6d8c19]">
              Auditoría de riesgo
            </p>
            <h1 className="mt-2 text-3xl font-black sm:text-4xl">
              Historial DataCrédito
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--fp-muted)]">
              Consulta el resultado, la oferta y el expediente MiDecisor. El
              puntaje y la cédula completa solo aparecen para el administrador central.
            </p>
          </div>
          <StatusPill tone={provider?.isProduction ? "positive" : "warning"}>
            {provider
              ? "Ambiente " + provider.environment.toUpperCase()
              : "Verificando ambiente"}
          </StatusPill>
        </header>

        {provider && !provider.isProduction ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-4 text-sm text-[var(--fp-graphite)]"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              Este ambiente usa datos ficticios o enmascarados de certificación.
              No utilices sus puntajes para aprobar ventas reales.
            </p>
          </div>
        ) : null}

        {provider?.isProduction && nonProductionVisibleCount > 0 ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-4 text-sm text-[var(--fp-graphite)]"
          >
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>
              La vista incluye {nonProductionVisibleCount} consulta(s) de ambiente
              DEMO, certificación o legado. No uses esos resultados para decisiones
              de crédito reales.
            </p>
          </div>
        ) : null}

        <Card className="p-5 sm:p-6">
          <form
            onSubmit={submitFilters}
            className="grid gap-4 lg:grid-cols-[1.25fr_0.8fr_0.8fr_0.8fr_0.8fr_auto]"
          >
            <label className="grid gap-2 text-xs font-black">
              Cédula exacta
              <Input
                inputMode="numeric"
                value={filters.documentNumber}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    documentNumber: event.target.value
                      .replace(/\D/g, "")
                      .slice(0, 13),
                  }))
                }
                placeholder="Número de cédula"
              />
            </label>
            <label className="grid gap-2 text-xs font-black">
              Resultado
              <Select
                value={filters.status}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                <option value="">Todos</option>
                <option value="APROBADO">Aprobado</option>
                <option value="RECHAZADO">Rechazado</option>
                <option value="NO_EVALUADO">No evaluado</option>
                <option value="PENDING">En proceso</option>
              </Select>
            </label>
            <label className="grid gap-2 text-xs font-black">
              Plataforma
              <Select
                value={filters.platform}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    platform: event.target.value,
                  }))
                }
              >
                <option value="">Todas</option>
                <option value="ANDROID">Android</option>
                <option value="IPHONE">iPhone</option>
              </Select>
            </label>
            <label className="grid gap-2 text-xs font-black">
              Desde
              <Input
                type="date"
                value={filters.dateFrom}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    dateFrom: event.target.value,
                  }))
                }
              />
            </label>
            <label className="grid gap-2 text-xs font-black">
              Hasta
              <Input
                type="date"
                value={filters.dateTo}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    dateTo: event.target.value,
                  }))
                }
              />
            </label>
            <Button type="submit" className="self-end" disabled={loading}>
              <Search className="h-4 w-4" aria-hidden="true" />
              Consultar
            </Button>
          </form>
        </Card>

        {error ? (
          <div
            role="alert"
            className="rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-5 py-4 text-sm font-bold text-[var(--fp-danger)]"
          >
            {error}
          </div>
        ) : null}

        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.05fr)_minmax(480px,0.95fr)]">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-[var(--fp-border)] px-5 py-5">
              <div>
                <h2 className="text-xl font-black">Consultas registradas</h2>
                <p className="mt-1 text-sm text-[var(--fp-muted)]">
                  {items.length} resultado(s) en esta vista
                </p>
              </div>
              <Button
                variant="ghost"
                onClick={() => void loadItems(appliedFilters)}
                disabled={loading}
                aria-label="Actualizar historial"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            {loading ? (
              <LoadingState label="Cargando consultas..." />
            ) : items.length === 0 ? (
              <EmptyState
                title="No hay consultas para estos filtros"
                description="Prueba otra cédula, rango de fechas o resultado."
              />
            ) : (
              <DataTable>
                <div className="min-w-[1040px]">
                  <div className="grid grid-cols-[1.05fr_0.75fr_0.65fr_0.7fr_0.95fr_1fr_0.5fr] gap-4 bg-[var(--fp-bg)] px-5 py-3 text-[11px] font-black uppercase text-[var(--fp-muted)]">
                    <span>Fecha / cédula</span>
                    <span>Resultado</span>
                    <span>Puntaje</span>
                    <span>Plataforma</span>
                    <span>Oferta</span>
                    <span>Consultó</span>
                    <span className="sr-only">Acciones</span>
                  </div>
                  <div className="divide-y divide-[var(--fp-border)]">
                    {items.map((item) => (
                      <article
                        key={item.id}
                        className={[
                          "grid grid-cols-[1.05fr_0.75fr_0.65fr_0.7fr_0.95fr_1fr_0.5fr] items-center gap-4 px-5 py-4 text-sm transition",
                          selectedId === item.id
                            ? "bg-[var(--fp-lime-soft)]"
                            : "hover:bg-[#fbfcf8]",
                        ].join(" ")}
                      >
                        <div>
                          <p className="font-black">{item.documentLabel}</p>
                          <p className="mt-1 text-xs text-[var(--fp-muted)]">
                            {dateTime(item.createdAt)}
                          </p>
                        </div>
                        <StatusPill tone={statusTone(item.status)}>
                          {item.status.replace("_", " ")}
                        </StatusPill>
                        <strong>{scoreLabel(item.score)}</strong>
                        <div>
                          <span className="inline-flex items-center gap-1.5 font-bold">
                            <Smartphone className="h-4 w-4" aria-hidden="true" />
                            {item.platform}
                          </span>
                          <span
                            className={[
                              "mt-1 block text-[10px] font-black uppercase tracking-[0.08em]",
                              isProductionProviderEnvironment(
                                item.providerEnvironment
                              )
                                ? "text-[var(--fp-muted)]"
                                : "text-[var(--fp-amber)]",
                            ].join(" ")}
                          >
                            {isProductionProviderEnvironment(
                              item.providerEnvironment
                            )
                              ? "Ambiente " + item.providerEnvironment
                              : "Advertencia: ambiente " +
                                (item.providerEnvironment || "legacy")}
                          </span>
                        </div>
                        <div className="text-xs leading-5">
                          {item.offer ? (
                            <>
                              <strong>
                                Inicial {item.offer.initialPaymentPercentage} %
                              </strong>
                              <br />
                              Máx. {currency(item.offer.maxFinancedAmount)}
                            </>
                          ) : (
                            "Sin oferta"
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-bold">
                            {item.actor.sellerName || item.actor.userName}
                          </p>
                          <p className="mt-1 truncate text-xs text-[var(--fp-muted)]">
                            {item.actor.aliadoName || "FINSER PAY"} ·{" "}
                            {item.actor.sedeName}
                          </p>
                        </div>
                        <Button
                          variant="secondary"
                          onClick={() => void openDetail(item.id)}
                          aria-label={"Ver expediente de " + item.documentLabel}
                        >
                          Ver
                        </Button>
                      </article>
                    ))}
                  </div>
                </div>
              </DataTable>
            )}
            {nextCursor ? (
              <div className="border-t border-[var(--fp-border)] px-5 py-4 text-center">
                <Button
                  variant="secondary"
                  disabled={loadingMore}
                  onClick={() =>
                    void loadItems(appliedFilters, nextCursor)
                  }
                >
                  {loadingMore ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                  Cargar más
                </Button>
              </div>
            ) : null}
          </Card>

          <Card className="min-h-[520px] p-5 sm:p-6">
            {detailLoading ? (
              <LoadingState label="Abriendo expediente cifrado..." />
            ) : !detail ? (
              <EmptyState
                title="Selecciona una consulta"
                description="Aquí aparecerán la cédula, el puntaje, la mora y el detalle entregado por MiDecisor."
                action={<FileSearch className="mx-auto h-8 w-8 text-[var(--fp-muted)]" />}
              />
            ) : (
              <div className="space-y-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#6d8c19]">
                      Expediente MiDecisor
                    </p>
                    <h2 className="mt-2 text-2xl font-black">
                      CC {detailDocument}
                    </h2>
                    <p className="mt-1 text-sm text-[var(--fp-muted)]">
                      {detailName}
                    </p>
                  </div>
                  <StatusPill
                    tone={statusTone(detail.assessment?.status || "NO_EVALUADO")}
                  >
                    {(detail.assessment?.status || "NO_EVALUADO").replace(
                      "_",
                      " "
                    )}
                  </StatusPill>
                </div>

                <div className="grid gap-2 rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-bg)] p-4 text-xs text-[var(--fp-muted)] sm:grid-cols-2">
                  <p>
                    <strong className="text-[var(--fp-graphite)]">Consultó:</strong>{" "}
                    {detail.assessment?.actor.sellerName ||
                      detail.assessment?.actor.userName ||
                      "No disponible"}
                  </p>
                  <p>
                    <strong className="text-[var(--fp-graphite)]">Sede:</strong>{" "}
                    {detail.assessment?.actor.sedeName || "No disponible"}
                  </p>
                  <p>
                    <strong className="text-[var(--fp-graphite)]">
                      Plataforma:
                    </strong>{" "}
                    {detail.assessment?.platform || "No disponible"}
                  </p>
                  <p>
                    <strong className="text-[var(--fp-graphite)]">Fecha:</strong>{" "}
                    {dateTime(detail.assessment?.createdAt)}
                  </p>
                </div>

                {detail.historicWithoutDossier ? (
                  <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-4 text-sm">
                    Esta consulta ocurrió antes de habilitar el expediente cifrado.
                    No se realizará una nueva consulta automática.
                  </div>
                ) : null}

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <MetricCard
                    label="Puntaje MiDecisor"
                    value={scoreLabel(providerScore)}
                    detail="Valor informado por el proveedor"
                  />
                  <MetricCard
                    label="Puntaje aplicado"
                    value={scoreLabel(appliedScore)}
                    detail={
                      detail.assessment?.providerEnvironment
                        ? "Ambiente " +
                          detail.assessment.providerEnvironment.toUpperCase()
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Saldo actual total"
                    value={currency(totals?.currentBalance)}
                  />
                  <MetricCard
                    label="Mora vigente total"
                    value={currency(totals?.delinquentBalance)}
                    detail={
                      totals?.debtPercentage !== null &&
                      totals?.debtPercentage !== undefined
                        ? String(totals.debtPercentage) + " % de deuda"
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Cuota total"
                    value={currency(totals?.installmentAmount)}
                  />
                  <MetricCard
                    label="Créditos vigentes"
                    value={String(totals?.activeCredits ?? "No disponible")}
                    detail={
                      totals?.closedCredits !== null &&
                      totals?.closedCredits !== undefined
                        ? String(totals.closedCredits) + " cerrados"
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Sector telefonía"
                    value={telco ? currency(telco.currentBalance) : "Sin agregado"}
                    detail={
                      telco
                        ? "Mora " + currency(telco.delinquentBalance)
                        : "MiDecisor no informó Sector Telcos"
                    }
                  />
                </div>

                {scoreMismatch ? (
                  <div
                    role="alert"
                    className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-4 text-sm text-[var(--fp-graphite)]"
                  >
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-danger)]" />
                    <p>
                      MiDecisor informó el puntaje {providerScore}, pero la evaluación
                      aplicó {appliedScore}. No uses esta oferta hasta revisar la
                      inconsistencia.
                    </p>
                  </div>
                ) : null}

                {detail.assessment?.offer ? (
                  <div className="grid gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-lime)] bg-[var(--fp-lime-soft)] p-4 sm:grid-cols-3">
                    <div>
                      <span className="text-xs font-bold text-[var(--fp-muted)]">
                        Inicial
                      </span>
                      <strong className="mt-1 block text-xl">
                        {detail.assessment.offer.initialPaymentPercentage} %
                      </strong>
                    </div>
                    <div>
                      <span className="text-xs font-bold text-[var(--fp-muted)]">
                        Fianza
                      </span>
                      <strong className="mt-1 block text-xl">
                        {detail.assessment.offer.suretyPercentage} %
                      </strong>
                    </div>
                    <div>
                      <span className="text-xs font-bold text-[var(--fp-muted)]">
                        Crédito máximo
                      </span>
                      <strong className="mt-1 block text-xl">
                        {currency(detail.assessment.offer.maxFinancedAmount)}
                      </strong>
                    </div>
                  </div>
                ) : null}

                {sectors.length ? (
                  <section>
                    <h3 className="text-lg font-black">Obligaciones por sector</h3>
                    <p className="mt-1 text-sm text-[var(--fp-muted)]">
                      MiDecisor entrega agregados por sector; no identifica operador
                      o cuenta individual.
                    </p>
                    <DataTable className="mt-3">
                      <div className="min-w-[620px]">
                        <div className="grid grid-cols-[1.1fr_repeat(4,0.7fr)] gap-3 bg-[#f8fafb] px-4 py-3 text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <span>Sector</span>
                          <span>Vigentes</span>
                          <span>Saldo</span>
                          <span>Cuota</span>
                          <span>Mora</span>
                        </div>
                        {sectors.map((sector, index) => (
                          <div
                            key={String(sector.sector || index)}
                            className={[
                              "grid grid-cols-[1.1fr_repeat(4,0.7fr)] gap-3 border-t border-[var(--fp-border)] px-4 py-3 text-sm",
                              sector.isTelcos ? "bg-[var(--fp-lime-soft)]" : "",
                            ].join(" ")}
                          >
                            <strong>{String(sector.sector || "Sin sector")}</strong>
                            <span>{String(sector.activeCredits ?? "—")}</span>
                            <span>{currency(sector.currentBalance)}</span>
                            <span>{currency(sector.installmentAmount)}</span>
                            <span>{currency(sector.delinquentBalance)}</span>
                          </div>
                        ))}
                      </div>
                    </DataTable>
                  </section>
                ) : null}

                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-4">
                    <span className="text-xs font-bold text-[var(--fp-muted)]">
                      Viabilidad
                    </span>
                    <strong className="mt-1 block">
                      {risk?.viability || "No disponible"}
                    </strong>
                  </div>
                  <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] p-4">
                    <span className="text-xs font-bold text-[var(--fp-muted)]">
                      Monto sugerido
                    </span>
                    <strong className="mt-1 block">
                      {currency(risk?.suggestedAmount)}
                    </strong>
                  </div>
                </div>

                {detail.providerData ? (
                  <details className="rounded-[var(--fp-radius-md)] border border-[var(--fp-border)]">
                    <summary className="min-h-11 cursor-pointer px-4 py-3 text-sm font-black">
                      Ver información completa entregada por MiDecisor
                    </summary>
                    <pre className="max-h-[520px] overflow-auto border-t border-[var(--fp-border)] bg-[#f8fafb] p-4 text-xs leading-5 whitespace-pre-wrap break-words">
                      {JSON.stringify(detail.providerData, null, 2)}
                    </pre>
                  </details>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--fp-muted)]">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  Acceso registrado · Política v{detail.assessment?.policyVersion ?? "—"}
                  {detail.assessment?.transactionCode
                    ? " · TX " + detail.assessment.transactionCode
                    : ""}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </main>
  );
}
