"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCheck,
  ChevronDown,
  FileSearch,
  Files,
  Info,
  Link2,
  LoaderCircle,
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
  MetricCard,
  Select,
  StatusPill,
} from "@/app/_components/finser-ui";
import type {
  DataCreditoAdminRiskSummary,
  DataCreditoSanitizedProviderPayload,
} from "@/lib/datacredito/admin-report";
import styles from "./datacredito-history.module.css";

type Offer = {
  initialPaymentPercentage: number;
  suretyPercentage: number;
  maxFinancedAmount: number;
  decisionRule?:
    | "SCORE_BAND"
    | "TELCO_DELINQUENCY_THRESHOLD"
    | "TOTAL_DELINQUENCY_THRESHOLD";
  telcoRejectionThresholdCop?: number | null;
  totalDelinquencyRejectionThresholdCop?: number | null;
  riskMetricVersion?: "MIDECISOR_PN_MILES_COP_V1" | null;
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
  reusedFromAssessmentId: string | null;
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

function statusLabel(status: string) {
  if (status === "APROBADO") return "Aprobado";
  if (status === "RECHAZADO") return "Rechazado";
  if (status === "NO_EVALUADO") return "No evaluado";
  if (status === "PENDING") return "En proceso";
  return status.replaceAll("_", " ");
}

function numberLabel(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "No disponible"
    : new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(value);
}

function percentage(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "No disponible"
    : numberLabel(value) + " %";
}

function providerFlag(value: boolean | null | undefined) {
  if (value === true) return "Sí";
  if (value === false) return "No";
  return "No informado";
}

function displayText(value: string | null | undefined) {
  return value || "No disponible";
}

function ReportSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details className={styles.reportSection}>
      <summary aria-labelledby={id}>
        <span id={id}>{title}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className={styles.reportContent}>
        {description ? <p className={styles.sectionDescription}>{description}</p> : null}
        {children}
      </div>
    </details>
  );
}

function HelpDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className={styles.help}>
    <summary><Info size={16} aria-hidden="true" />{label}<ChevronDown size={15} aria-hidden="true" /></summary>
    <div>{children}</div>
  </details>;
}

function DetailValue({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="min-w-0 border-t border-[var(--fp-border)] px-4 py-3 first:border-t-0 sm:border-l sm:first:border-l-0 sm:[&:nth-child(-n+3)]:border-t-0 sm:[&:nth-child(3n+1)]:border-l-0">
      <dt className="text-xs font-bold text-[var(--fp-muted)]">{label}</dt>
      <dd className="mt-1 break-words font-black text-[var(--fp-graphite)]">
        {value}
      </dd>
      {detail ? (
        <dd className="mt-1 text-xs leading-5 text-[var(--fp-muted)]">{detail}</dd>
      ) : null}
    </div>
  );
}

function EmptyReportValue({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--fp-radius-md)] border border-dashed border-[var(--fp-border)] bg-[var(--fp-bg)] px-4 py-4 text-sm text-[var(--fp-muted)]">
      {children}
    </p>
  );
}

function isProductionProviderEnvironment(value: string | null | undefined) {
  return ["prod", "production"].includes(String(value || "").toLowerCase());
}

function AssessmentOriginStatus({
  reusedFromAssessmentId,
}: {
  reusedFromAssessmentId: string | null | undefined;
}) {
  const reused = Boolean(reusedFromAssessmentId);

  return (
    <StatusPill
      tone={reused ? "positive" : "neutral"}
      className={styles.origin}
    >
      {reused
        ? "Reutilizada · sin nueva consulta/cobro"
        : "Original · consulta al proveedor"}
    </StatusPill>
  );
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
  const detailHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (selectedId) detailHeadingRef.current?.focus();
  }, [selectedId]);

  function closeDetail(restoreFocus = true) {
    const previousId = selectedId;
    detailRequestSequenceRef.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailLoading(false);
    if (restoreFocus && previousId && typeof document !== "undefined") {
      document.getElementById("assessment-open-" + previousId)?.focus();
    }
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    closeDetail(false);
    void loadItems(EMPTY_FILTERS);
  }

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
  const telco = summary?.telcos ?? null;
  const providerScore = risk?.score ?? null;
  const appliedScore = detail?.assessment?.score ?? null;
  const scoreMismatch =
    Number.isInteger(providerScore) &&
    Number.isInteger(appliedScore) &&
    providerScore !== appliedScore;
  const telcoPriorityRejectionOffer =
    detail?.assessment?.status === "RECHAZADO" &&
    detail.assessment.offer?.decisionRule === "TELCO_DELINQUENCY_THRESHOLD"
      ? detail.assessment.offer
      : null;
  const totalPriorityRejectionOffer =
    detail?.assessment?.status === "RECHAZADO" &&
    detail.assessment.offer?.decisionRule === "TOTAL_DELINQUENCY_THRESHOLD"
      ? detail.assessment.offer
      : null;
  const nonProductionVisibleCount = items.filter(
    (item) => !isProductionProviderEnvironment(item.providerEnvironment)
  ).length;
  const telcoTone =
    telco?.delinquentBalance === null || telco?.delinquentBalance === undefined
      ? ("warning" as const)
      : telco.delinquentBalance > 0
        ? ("danger" as const)
        : ("positive" as const);
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

  const originalCount = items.filter(item => !item.reusedFromAssessmentId).length;
  const reusedCount = items.length - originalCount;

  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <header className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>AUDITORÍA DE RIESGO</p>
            <h1>Historial DataCrédito</h1>
            <p>Resultados, ofertas y expedientes de tus consultas.</p>
          </div>
          <Button variant="secondary" onClick={() => void loadItems(appliedFilters)} disabled={loading} aria-label="Actualizar historial">
            <RefreshCw size={17} aria-hidden="true" />Actualizar
          </Button>
        </header>

        <section className={styles.overview} aria-label="Estado de la integración y resultados cargados">
          <div><span className={styles.overviewIcon}><Link2 aria-hidden="true" /></span><div><span>Integración</span><strong className={styles.integrationState} data-active={provider?.enabled}>{provider ? <><i aria-hidden="true" />{provider.enabled ? "Activa" : "Inactiva"}</> : "Verificando…"}</strong></div></div>
          <div><span className={styles.overviewIcon}><ShieldCheck aria-hidden="true" /></span><div><span>Ambiente</span><strong>{provider ? (provider.isProduction ? "Producción" : provider.environment.toUpperCase()) : "—"}</strong></div></div>
          <div><span className={styles.overviewIcon}><Files aria-hidden="true" /></span><div><span>Resultados cargados</span><strong>{items.length}<small>{nextCursor ? "Hay más disponibles" : "En esta vista"}</small></strong></div></div>
          <div><span className={styles.overviewIcon}><CheckCheck aria-hidden="true" /></span><div><span>Origen en esta vista</span><strong className={styles.originCounts}>{originalCount} {originalCount === 1 ? "original" : "originales"} <small>{reusedCount} {reusedCount === 1 ? "reutilizada" : "reutilizadas"}</small></strong></div></div>
        </section>

        {provider && !provider.isProduction ? (
          <div role="alert" className={styles.warning}>
            <AlertTriangle size={19} aria-hidden="true" />
            <p>Este ambiente usa datos ficticios o enmascarados de certificación. No utilices sus puntajes para aprobar ventas reales.</p>
          </div>
        ) : null}
        {provider?.isProduction && nonProductionVisibleCount > 0 ? (
          <div role="alert" className={styles.warning}>
            <AlertTriangle size={19} aria-hidden="true" />
            <p>La vista incluye {nonProductionVisibleCount} consulta(s) de ambiente DEMO, certificación o legado. No uses esos resultados para decisiones de crédito reales.</p>
          </div>
        ) : null}

        <Card className={styles.filtersCard}>
          <form onSubmit={submitFilters} className={styles.filters} aria-label="Filtros del historial">
            <label>Cédula exacta<Input inputMode="numeric" value={filters.documentNumber} onChange={event => setFilters(current => ({ ...current, documentNumber: event.target.value.replace(/\D/g, "").slice(0, 13) }))} placeholder="Número de cédula" /></label>
            <label>Resultado<Select value={filters.status} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}>
              <option value="">Todos</option><option value="APROBADO">Aprobado</option><option value="RECHAZADO">Rechazado</option><option value="NO_EVALUADO">No evaluado</option><option value="PENDING">En proceso</option>
            </Select></label>
            <label>Producto<Select value={filters.platform} onChange={event => setFilters(current => ({ ...current, platform: event.target.value }))} aria-label="Plataforma">
              <option value="">Todos los productos</option><option value="ANDROID">Android</option><option value="IPHONE">iPhone</option>
            </Select></label>
            <label>Desde<Input type="date" value={filters.dateFrom} onChange={event => setFilters(current => ({ ...current, dateFrom: event.target.value }))} /></label>
            <label>Hasta<Input type="date" value={filters.dateTo} onChange={event => setFilters(current => ({ ...current, dateTo: event.target.value }))} /></label>
            <div className={styles.filterActions}><Button type="submit" disabled={loading}><Search size={17} aria-hidden="true" />Consultar</Button><Button variant="ghost" onClick={clearFilters} disabled={loading} aria-label="Limpiar filtros">Limpiar</Button></div>
          </form>
        </Card>

        {error ? <div role="alert" className={styles.error}><AlertTriangle size={18} aria-hidden="true" />{error}</div> : null}

        <div className={styles.results}>
          <Card className={styles.listCard}>
            <div className={styles.sectionHeading}>
              <div><h2>Consultas registradas</h2><p>{items.length} resultado(s) en esta vista</p></div>
              <HelpDisclosure label="Sobre este historial">Las reutilizadas conservan una consulta vigente y no generan una nueva consulta ni cobro. El puntaje y la cédula completa solo aparecen para el administrador central.</HelpDisclosure>
            </div>
            {loading ? <LoadingState label="Cargando consultas..." /> : items.length === 0 ? (
              <EmptyState title="No hay consultas para estos filtros" description="Prueba otra cédula, rango de fechas o resultado." action={<FileSearch size={30} aria-hidden="true" />} />
            ) : (
              <DataTable className={styles.resultsTable}>
                <table>
                  <caption className="sr-only">Consultas DataCrédito registradas</caption>
                  <thead><tr><th scope="col">Fecha / cédula</th><th scope="col">Resultado</th><th scope="col">Puntaje</th><th scope="col">Producto</th><th scope="col">Oferta</th><th scope="col"><span>Origen</span></th><th scope="col">Consultó</th><th scope="col"><span className="sr-only">Acciones</span></th></tr></thead>
                  <tbody>{items.map(item => (
                    <tr key={item.id} className={selectedId === item.id ? styles.selectedRow : undefined}>
                      <td><strong>{item.documentLabel}</strong><small>{dateTime(item.createdAt)}</small></td>
                      <td><StatusPill className={styles.resultStatus} tone={statusTone(item.status)}>{statusLabel(item.status)}</StatusPill></td>
                      <td><strong className={Number.isInteger(item.score) && item.score !== -1 ? styles.score : styles.scoreUnavailable}>{scoreLabel(item.score)}</strong></td>
                      <td><span className={styles.product}><Smartphone size={17} aria-hidden="true" />{item.platform === "IPHONE" ? "iPhone" : "Android"}</span><small className={!isProductionProviderEnvironment(item.providerEnvironment) ? styles.environmentWarning : undefined}>{isProductionProviderEnvironment(item.providerEnvironment) ? "Ambiente " + item.providerEnvironment : "Advertencia: ambiente " + (item.providerEnvironment || "legacy")}</small></td>
                      <td>{item.offer?.decisionRule === "TELCO_DELINQUENCY_THRESHOLD" ? <><strong>Rechazo prioritario TELCOS</strong><small>Umbral {currency(item.offer.telcoRejectionThresholdCop)}</small></> : item.offer?.decisionRule === "TOTAL_DELINQUENCY_THRESHOLD" ? <><strong>Rechazo prioritario · mora total</strong><small>Umbral {currency(item.offer.totalDelinquencyRejectionThresholdCop)}</small></> : item.offer ? <><strong>Inicial {item.offer.initialPaymentPercentage} %</strong><small>Máx. {currency(item.offer.maxFinancedAmount)}</small></> : <span className={styles.muted}>Sin oferta</span>}</td>
                      <td><AssessmentOriginStatus reusedFromAssessmentId={item.reusedFromAssessmentId} /></td>
                      <td><strong>{item.actor.sellerName || item.actor.userName}</strong><small>{item.actor.aliadoName || "FINSER PAY"} · {item.actor.sedeName}</small></td>
                      <td><Button id={"assessment-open-" + item.id} variant={selectedId === item.id ? "primary" : "secondary"} onClick={() => void openDetail(item.id)} aria-label={"Ver expediente de " + item.documentLabel} aria-expanded={selectedId === item.id} aria-controls="datacredito-dossier">Ver<ArrowUpRight size={15} aria-hidden="true" /></Button></td>
                    </tr>
                  ))}</tbody>
                </table>
              </DataTable>
            )}
            <div className={styles.listFooter}><span>{items.length} consultas cargadas{nextCursor ? " · Hay más resultados" : ""}</span>{nextCursor ? <Button variant="secondary" disabled={loadingMore} onClick={() => void loadItems(appliedFilters, nextCursor)}>{loadingMore ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}Cargar más</Button> : <span className={styles.muted}>Fin de los resultados</span>}</div>
          </Card>

          {selectedId ? <Card className={styles.dossier} id="datacredito-dossier" role="region" aria-labelledby="dossier-title">
            <div className={styles.dossierHeading}><div><p className={styles.eyebrow}>DETALLE DE LA CONSULTA</p><h2 id="dossier-title" tabIndex={-1} ref={detailHeadingRef}>Expediente MiDecisor</h2></div><Button variant="secondary" onClick={() => closeDetail()} aria-label="Cerrar expediente"><X size={17} aria-hidden="true" />Cerrar</Button></div>
            {detailLoading ? (
              <LoadingState label="Abriendo expediente cifrado..." />
            ) : !detail ? (
              <EmptyState
                title="Selecciona una consulta"
                description="Aquí aparecerán la cédula, el puntaje, la mora y el detalle entregado por MiDecisor."
                action={<FileSearch className="mx-auto h-8 w-8 text-[var(--fp-muted)]" />}
              />
            ) : (
              <div className={styles.dossierContent}>
                <div className={styles.identityHeading}>
                  <div>
                    <p className={styles.identityLabel}>CLIENTE</p>
                    <h3 className={styles.documentTitle}>CC {detailDocument}</h3>
                    <p className="mt-1 text-sm text-[var(--fp-muted)]">
                      {detailName}
                    </p>
                  </div>
                  <StatusPill
                    tone={statusTone(detail.assessment?.status || "NO_EVALUADO")}
                  >
                    {statusLabel(detail.assessment?.status || "NO_EVALUADO")}
                  </StatusPill>
                </div>

                <div className={styles.recordBar}>
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
                  <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <strong className="text-[var(--fp-graphite)]">Origen:</strong>{" "}
                    <AssessmentOriginStatus
                      reusedFromAssessmentId={detail.assessment?.reusedFromAssessmentId}
                    />
                  </div>
                </div>

                {detail.historicWithoutDossier ? (
                  <div className="rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-4 text-sm">
                    Esta consulta ocurrió antes de habilitar el expediente cifrado.
                    No se realizará una nueva consulta automática.
                  </div>
                ) : null}

                <HelpDisclosure label="Cómo leer los valores de MiDecisor">
                  <p>MiDecisor informa saldos, cuotas, moras, cupos y valores
                  iniciales en miles de COP. Por ejemplo, 359 equivale a
                  $359.000. Las reglas prioritarias usan la mora vigente agregada
                  del sector TELCOS y la mora vigente total, ambas convertidas a
                  COP. El total informado no se vuelve a sumar por sectores.</p>
                </HelpDisclosure>

                <div className={styles.riskMetrics}>
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
                    className={
                      totalPriorityRejectionOffer
                        ? "border-[var(--fp-danger)] bg-[var(--fp-danger-soft)]"
                        : undefined
                    }
                    detail={
                      totalPriorityRejectionOffer
                        ? `Superó el umbral de ${currency(
                            totalPriorityRejectionOffer
                              .totalDelinquencyRejectionThresholdCop
                          )}`
                        : totals?.debtPercentage !== null &&
                            totals?.debtPercentage !== undefined
                          ? percentage(totals.debtPercentage) + " de deuda"
                          : undefined
                    }
                  />
                  <MetricCard
                    label="Cuota total"
                    value={currency(totals?.installmentAmount)}
                  />
                  <MetricCard
                    label="Créditos vigentes"
                    value={numberLabel(totals?.activeCredits)}
                    detail={
                      totals?.closedCredits !== null &&
                      totals?.closedCredits !== undefined
                        ? numberLabel(totals.closedCredits) + " cerrados"
                        : undefined
                    }
                  />
                </div>

                {telcoPriorityRejectionOffer ? (
                  <div
                    role="alert"
                    className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-4 text-sm leading-6 text-[var(--fp-graphite)]"
                  >
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-danger)]" />
                    <p>
                      <strong>Rechazo prioritario por mora TELCOS:</strong> la
                      mora vigente agregada del sector TELCOS de
                      {" "}{currency(telco?.delinquentBalance)} superó el umbral
                      de {currency(
                        telcoPriorityRejectionOffer.telcoRejectionThresholdCop
                      )}. Esta regla es independiente del puntaje y se evaluó
                      primero con el umbral configurado para{" "}
                      {detail?.assessment?.platform}.
                    </p>
                  </div>
                ) : null}

                {totalPriorityRejectionOffer ? (
                  <div
                    role="alert"
                    className="flex items-start gap-3 rounded-[var(--fp-radius-md)] border border-[var(--fp-danger)] bg-[var(--fp-danger-soft)] px-4 py-4 text-sm leading-6 text-[var(--fp-graphite)]"
                  >
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--fp-danger)]" />
                    <p>
                      <strong>Rechazo prioritario por mora vigente total:</strong>{" "}
                      la mora total de {currency(totals?.delinquentBalance)} superó
                      el umbral de {currency(
                        totalPriorityRejectionOffer
                          .totalDelinquencyRejectionThresholdCop
                      )}. Se evaluó después de la regla TELCOS y antes del puntaje,
                      usando el tope configurado para{" "}
                      {detail?.assessment?.platform}.
                    </p>
                  </div>
                ) : null}

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

                <details className={styles.reportSection}>
                  <summary aria-labelledby="telcos-summary-title">
                    <span className={styles.telcosHeader}><span id="telcos-summary-title">Resumen Telcos</span><StatusPill tone={telcoTone}>{telco?.delinquencyStatus || "Mora no informada"}</StatusPill></span>
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div className={styles.reportContent}>
                    <p className={styles.sectionDescription}>{telco?.available ? "Agregado Sector Telcos informado" : "Sector Telcos no informado por MiDecisor"}</p>
                  <dl className="grid bg-[var(--fp-surface)] sm:grid-cols-3">
                    <DetailValue
                      label="Obligaciones vigentes"
                      value={numberLabel(telco?.activeCredits)}
                    />
                    <DetailValue
                      label="Obligaciones cerradas"
                      value={numberLabel(telco?.closedCredits)}
                    />
                    <DetailValue
                      label="Saldo actual"
                      value={currency(telco?.currentBalance)}
                    />
                    <DetailValue
                      label="Cuota"
                      value={currency(telco?.installmentAmount)}
                    />
                    <DetailValue
                      label="Mora vigente"
                      value={currency(telco?.delinquentBalance)}
                    />
                    <DetailValue
                      label="Valor inicial"
                      value={currency(telco?.initialAmount)}
                    />
                    <DetailValue
                      label="Como titular/principal"
                      value={numberLabel(telco?.principalCredits)}
                    />
                    <DetailValue
                      label="Como codeudor/u otros"
                      value={numberLabel(telco?.coDebtorOrOtherCredits)}
                    />
                    <DetailValue
                      label="Porcentaje de deuda"
                      value={percentage(telco?.debtPercentage)}
                    />
                    <DetailValue
                      label="Operador"
                      value="No informado por MiDecisor PN"
                    />
                    <DetailValue
                      label="Cuenta individual"
                      value="No informada por MiDecisor PN"
                    />
                    <DetailValue
                      label="Historial de incumplimiento Telco"
                      value="No disponible"
                    />
                  </dl>

                    <HelpDisclosure label="Alcance de la información Telcos"><p><strong>Alcance del dato:</strong> MiDecisor PN actual no identifica
                    operador ni cuenta individual. Una mora de $0 solo indica ausencia
                    de mora vigente agregada reportada; no prueba pagos históricos ni
                    ausencia de mora histórica. El historial global mostrado más abajo
                    no es específico de Telcos.</p></HelpDisclosure>
                  </div>
                </details>

                {detail.assessment?.offer &&
                detail.assessment.offer.decisionRule !==
                  "TELCO_DELINQUENCY_THRESHOLD" &&
                detail.assessment.offer.decisionRule !==
                  "TOTAL_DELINQUENCY_THRESHOLD" ? (
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

                <ReportSection
                  id="identity-validation-title"
                  title="Identidad y validación"
                  description="Contrasta los datos digitados en la consulta con la identidad devuelta por MiDecisor."
                >
                  <dl className="grid overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] sm:grid-cols-3">
                    <DetailValue
                      label="Validación con información"
                      value={providerFlag(summary?.validation?.hasInformation)}
                    />
                    <DetailValue
                      label="Datos básicos con información"
                      value={providerFlag(
                        summary?.validation?.basicDataHasInformation
                      )}
                    />
                    <DetailValue
                      label="Nombre completo"
                      value={displayText(reportIdentity?.fullName || reportName)}
                    />
                    <DetailValue
                      label="Tipo de documento devuelto"
                      value={displayText(reportIdentity?.documentType)}
                    />
                    <DetailValue
                      label="Documento devuelto"
                      value={displayText(reportIdentity?.documentNumber)}
                    />
                    <DetailValue
                      label="Estado del documento"
                      value={displayText(reportIdentity?.documentStatus)}
                    />
                    <DetailValue
                      label="Rango de edad"
                      value={displayText(reportIdentity?.ageRange)}
                    />
                    <DetailValue
                      label="Documento digitado"
                      value={displayText(reportIdentity?.queriedDocumentNumber)}
                      detail={displayText(reportIdentity?.queriedDocumentType)}
                    />
                    <DetailValue
                      label="Apellido digitado"
                      value={displayText(reportIdentity?.queriedSurname)}
                    />
                    <DetailValue
                      label="Primer nombre"
                      value={displayText(reportIdentity?.firstName)}
                    />
                    <DetailValue
                      label="Segundo nombre"
                      value={displayText(reportIdentity?.secondName)}
                    />
                    <DetailValue
                      label="Apellidos devueltos"
                      value={
                        [
                          reportIdentity?.firstSurname,
                          reportIdentity?.secondSurname,
                        ]
                          .filter(Boolean)
                          .join(" ") || "No disponible"
                      }
                    />
                  </dl>
                </ReportSection>

                <ReportSection
                  id="risk-analysis-title"
                  title="Riesgo, recaudos y alertas"
                  description="Campos informativos del proveedor; la oferta continúa siendo determinada por la política interna versionada."
                >
                  <dl className="grid overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] sm:grid-cols-3">
                    <DetailValue
                      label="Información de riesgo disponible"
                      value={providerFlag(risk?.hasInformation)}
                    />
                    <DetailValue
                      label="Score"
                      value={scoreLabel(risk?.score)}
                    />
                    <DetailValue
                      label="Viabilidad"
                      value={displayText(risk?.viability)}
                    />
                    <DetailValue
                      label="Probabilidad"
                      value={displayText(risk?.probabilityText)}
                    />
                    <DetailValue
                      label="Rating de recaudos"
                      value={displayText(risk?.collectionsRating)}
                    />
                    <DetailValue
                      label="Evaluación de recaudos"
                      value={displayText(risk?.collectionsText)}
                    />
                    <DetailValue
                      label="Monto sugerido por MiDecisor"
                      value={currency(risk?.suggestedAmount)}
                      detail="No sustituye la política interna de FINSER PAY."
                    />
                  </dl>

                  <div>
                    <h4 className="text-sm font-black">Alertas del proveedor</h4>
                    {risk?.alerts.length ? (
                      <ul className="mt-2 divide-y divide-[var(--fp-border)] overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)]">
                        {risk.alerts.map((alert, index) => (
                          <li key={String(index)} className="px-4 py-3 text-sm">
                            <strong className="block">
                              {displayText(alert.description)}
                            </strong>
                            <span className="mt-1 block text-xs text-[var(--fp-muted)]">
                              Colocación: {displayText(alert.placedAt)} · Modificación:{" "}
                              {displayText(alert.updatedAt)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <EmptyReportValue>
                        MiDecisor no informó alertas para esta consulta.
                      </EmptyReportValue>
                    )}
                  </div>
                </ReportSection>

                <ReportSection
                  id="portfolio-totals-title"
                  title="Totales de obligaciones"
                  description="Agregados generales del comportamiento crediticio informado por MiDecisor."
                >
                  <dl className="grid overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] sm:grid-cols-3">
                    <DetailValue
                      label="Indicadores con información"
                      value={providerFlag(summary?.indicatorValuesHaveInformation)}
                    />
                    <DetailValue
                      label="Créditos vigentes"
                      value={numberLabel(totals?.activeCredits)}
                    />
                    <DetailValue
                      label="Créditos cerrados"
                      value={numberLabel(totals?.closedCredits)}
                    />
                    <DetailValue
                      label="Como titular/principal"
                      value={numberLabel(totals?.principalCredits)}
                    />
                    <DetailValue
                      label="Como codeudor/u otros"
                      value={numberLabel(totals?.coDebtorOrOtherCredits)}
                    />
                    <DetailValue
                      label="Valor inicial"
                      value={currency(totals?.initialAmount)}
                    />
                    <DetailValue
                      label="Saldo actual"
                      value={currency(totals?.currentBalance)}
                    />
                    <DetailValue
                      label="Cuota"
                      value={currency(totals?.installmentAmount)}
                    />
                    <DetailValue
                      label="Mora vigente"
                      value={currency(totals?.delinquentBalance)}
                    />
                    <DetailValue
                      label="Porcentaje de deuda"
                      value={percentage(totals?.debtPercentage)}
                    />
                  </dl>
                </ReportSection>

                <ReportSection
                  id="sector-obligations-title"
                  title="Obligaciones por sector"
                  description="Agregados sectoriales. MiDecisor PN no identifica entidad, operador ni cuenta individual."
                >
                  {sectors.length ? (
                    <DataTable>
                      <table className="min-w-[1180px] w-full border-collapse text-sm">
                        <caption className="sr-only">
                          Indicadores completos de obligaciones agrupados por sector
                        </caption>
                        <thead className="bg-[#f8fafb] text-left text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <tr>
                            <th scope="col" className="px-4 py-3">Sector</th>
                            <th scope="col" className="px-3 py-3">Vigentes</th>
                            <th scope="col" className="px-3 py-3">Cerrados</th>
                            <th scope="col" className="px-3 py-3">Principal</th>
                            <th scope="col" className="px-3 py-3">Codeudor/otros</th>
                            <th scope="col" className="px-3 py-3">Valor inicial</th>
                            <th scope="col" className="px-3 py-3">Saldo</th>
                            <th scope="col" className="px-3 py-3">Cuota</th>
                            <th scope="col" className="px-3 py-3">Mora</th>
                            <th scope="col" className="px-3 py-3">% deuda</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sectors.map((sector, index) => (
                            <tr
                              key={String(sector.sector || index)}
                              className={
                                sector.isTelcos
                                  ? "border-t border-[var(--fp-border)] bg-[var(--fp-lime-soft)]"
                                  : "border-t border-[var(--fp-border)]"
                              }
                            >
                              <th scope="row" className="px-4 py-3 text-left font-black">
                                {String(sector.sector || "Sin sector")}
                              </th>
                              <td className="px-3 py-3">{numberLabel(sector.activeCredits)}</td>
                              <td className="px-3 py-3">{numberLabel(sector.closedCredits)}</td>
                              <td className="px-3 py-3">{numberLabel(sector.principalCredits)}</td>
                              <td className="px-3 py-3">{numberLabel(sector.coDebtorOrOtherCredits)}</td>
                              <td className="px-3 py-3">{currency(sector.initialAmount)}</td>
                              <td className="px-3 py-3">{currency(sector.currentBalance)}</td>
                              <td className="px-3 py-3">{currency(sector.installmentAmount)}</td>
                              <td className="px-3 py-3">{currency(sector.delinquentBalance)}</td>
                              <td className="px-3 py-3">{percentage(sector.debtPercentage)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó agregados por sector.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                <ReportSection
                  id="balance-evolution-title"
                  title="Evolución de saldos y cuotas"
                  description="Serie trimestral agregada informada por MiDecisor."
                >
                  {summary?.balanceEvolution.length ? (
                    <DataTable>
                      <table className="min-w-[560px] w-full border-collapse text-sm">
                        <caption className="sr-only">
                          Evolución trimestral de saldo total y cuota total
                        </caption>
                        <thead className="bg-[#f8fafb] text-left text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <tr>
                            <th scope="col" className="px-4 py-3">Periodo</th>
                            <th scope="col" className="px-4 py-3">Saldo total</th>
                            <th scope="col" className="px-4 py-3">Cuota total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.balanceEvolution.map((item, index) => (
                            <tr key={String(item.period || index)} className="border-t border-[var(--fp-border)]">
                              <th scope="row" className="px-4 py-3 text-left font-black">
                                {displayText(item.period)}
                              </th>
                              <td className="px-4 py-3">{currency(item.totalBalance)}</td>
                              <td className="px-4 py-3">{currency(item.totalInstallment)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó evolución de saldos y cuotas.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                <ReportSection
                  id="revolving-evolution-title"
                  title="Evolución de productos rotativos"
                  description="Saldo, cupo y utilización agregados por trimestre."
                >
                  {summary?.revolvingEvolution.length ? (
                    <DataTable>
                      <table className="min-w-[700px] w-full border-collapse text-sm">
                        <caption className="sr-only">
                          Evolución trimestral de productos rotativos
                        </caption>
                        <thead className="bg-[#f8fafb] text-left text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <tr>
                            <th scope="col" className="px-4 py-3">Periodo</th>
                            <th scope="col" className="px-4 py-3">Saldo total</th>
                            <th scope="col" className="px-4 py-3">Cupo total</th>
                            <th scope="col" className="px-4 py-3">% deuda</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.revolvingEvolution.map((item, index) => (
                            <tr key={String(item.period || index)} className="border-t border-[var(--fp-border)]">
                              <th scope="row" className="px-4 py-3 text-left font-black">
                                {displayText(item.period)}
                              </th>
                              <td className="px-4 py-3">{currency(item.totalBalance)}</td>
                              <td className="px-4 py-3">{currency(item.totalLimit)}</td>
                              <td className="px-4 py-3">{percentage(item.debtPercentage)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó evolución de productos rotativos.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                <ReportSection
                  id="global-payment-history-title"
                  title="Historial global de comportamiento de pago"
                  description="Este vector es global: no corresponde específicamente a Telcos ni identifica una obligación individual."
                >
                  <div
                    id="payment-code-legend"
                    role="note"
                    className="rounded-[var(--fp-radius-md)] border border-[var(--fp-amber)] bg-[var(--fp-amber-soft)] px-4 py-3 text-sm leading-6"
                  >
                    <strong>Leyenda:</strong> se muestra el código literal informado por
                    MiDecisor. El sistema no tiene un catálogo contractual validado para
                    traducir N, 1–6, C, D o “-”; su significado se presenta como no
                    disponible y no se infieren días de mora.
                  </div>
                  {summary?.paymentHistory.length ? (
                    <DataTable>
                      <table
                        aria-describedby="payment-code-legend"
                        className="min-w-[620px] w-full border-collapse text-sm"
                      >
                        <caption className="sr-only">
                          Vector global de comportamiento de pago
                        </caption>
                        <thead className="bg-[#f8fafb] text-left text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <tr>
                            <th scope="col" className="px-4 py-3">Periodo</th>
                            <th scope="col" className="px-4 py-3">Código MiDecisor</th>
                            <th scope="col" className="px-4 py-3">Significado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.paymentHistory.map((item, index) => (
                            <tr key={String(item.period || index)} className="border-t border-[var(--fp-border)]">
                              <th scope="row" className="px-4 py-3 text-left font-black">
                                {displayText(item.period)}
                              </th>
                              <td className="px-4 py-3 font-black">
                                {displayText(item.code)}
                              </td>
                              <td className="px-4 py-3 text-[var(--fp-muted)]">
                                Significado no disponible
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó historial global de comportamiento de pago.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                <ReportSection
                  id="indebtedness-title"
                  title="Endeudamiento"
                  description="Valores agregados informados por el proveedor."
                >
                  <dl className="grid overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] sm:grid-cols-2">
                    <DetailValue
                      label="Ingreso informado"
                      value={currency(summary?.indebtedness?.income)}
                    />
                    <DetailValue
                      label="Cuota frente al ingreso"
                      value={percentage(
                        summary?.indebtedness?.installmentToIncomePercentage
                      )}
                    />
                  </dl>
                </ReportSection>

                <ReportSection
                  id="provider-suggestions-title"
                  title="Sugerencias de MiDecisor"
                  description="Recomendaciones informativas incluidas por el proveedor."
                >
                  {summary?.suggestions.length ? (
                    <div className="divide-y divide-[var(--fp-border)] overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)]">
                      {summary.suggestions.map((suggestion, index) => (
                        <article key={String(index)} className="px-4 py-4">
                          <h4 className="font-black">
                            {displayText(suggestion.title)}
                          </h4>
                          {suggestion.descriptions.length ? (
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[var(--fp-muted)]">
                              {suggestion.descriptions.map((description, itemIndex) => (
                                <li key={String(itemIndex)}>{description}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-2 text-sm text-[var(--fp-muted)]">
                              Sin detalle informado.
                            </p>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó sugerencias para esta consulta.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                <ReportSection
                  id="provider-transaction-title"
                  title="Información de la transacción"
                  description="Metadatos y códigos de respuesta sanitizados; no incluyen tokens, credenciales ni cabeceras."
                >
                  <dl className="grid overflow-hidden rounded-[var(--fp-radius-md)] border border-[var(--fp-border)] bg-[var(--fp-surface)] sm:grid-cols-3">
                    <DetailValue
                      label="Estado del proveedor"
                      value={displayText(summary?.transaction?.providerStatus)}
                    />
                    <DetailValue
                      label="Fecha de consulta"
                      value={displayText(summary?.transaction?.queryDate)}
                    />
                    <DetailValue
                      label="Hora de consulta"
                      value={displayText(summary?.transaction?.queryTime)}
                    />
                  </dl>

                  {summary?.transaction?.responseCodes.length ? (
                    <DataTable>
                      <table className="min-w-[480px] w-full border-collapse text-sm">
                        <caption className="sr-only">
                          Códigos sanitizados de respuesta de MiDecisor
                        </caption>
                        <thead className="bg-[#f8fafb] text-left text-[10px] font-black uppercase text-[var(--fp-muted)]">
                          <tr>
                            <th scope="col" className="px-4 py-3">Clave</th>
                            <th scope="col" className="px-4 py-3">Valor</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.transaction.responseCodes.map((code, index) => (
                            <tr key={String(index)} className="border-t border-[var(--fp-border)]">
                              <th scope="row" className="px-4 py-3 text-left font-black">
                                {displayText(code.key)}
                              </th>
                              <td className="px-4 py-3">{displayText(code.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </DataTable>
                  ) : (
                    <EmptyReportValue>
                      MiDecisor no informó códigos de respuesta adicionales.
                    </EmptyReportValue>
                  )}
                </ReportSection>

                {detail.providerData ? (
                  <details className={styles.reportSection}>
                    <summary>Ver detalle técnico sanitizado de MiDecisor<ChevronDown aria-hidden="true" /></summary>
                    <p className="border-t border-[var(--fp-border)] bg-[#f8fafb] px-4 pt-4 text-xs leading-5 text-[var(--fp-muted)]">
                      Vista reconstruida mediante allowlist; puede omitir campos no
                      contratados, desconocidos o truncados por seguridad.
                    </p>
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
          </Card> : null}
        </div>
      </div>
    </main>
  );
}
