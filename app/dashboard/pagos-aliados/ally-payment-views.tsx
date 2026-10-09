"use client";

import { useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { Badge, Button, EmptyState, Select } from "@/app/_components/finser-ui";
import styles from "./ally-payment-views.module.css";

type SummaryBucket = {
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  numeroAjustesAnulacion?: number | null;
  totalAjustesAnulacion?: number | null;
  saldoNeto?: number | null;
  valorVenta?: number | null;
  creditoAutorizado?: number | null;
  cuotaInicial?: number | null;
  valorIntermediacion?: number | null;
  valorPagar?: number | null;
};

export type AllyPaymentViewSummary = {
  ANDROID?: SummaryBucket | null;
  IPHONE?: SummaryBucket | null;
  total?: SummaryBucket | null;
};

export type ReceivedPaymentViewItem = {
  id: number | string;
  aliado?: { nombre: string } | null;
  aliadoNombre?: string | null;
  periodoInicio?: string | null;
  periodoFin?: string | null;
  numeroCreditos?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalRecaudosAliado?: number | null;
  numeroAjustesAnulacion?: number | null;
  totalAjustesAnulacion?: number | null;
  totalPagar?: number | null;
  saldoNeto?: number | null;
  numeroAprobacionBancaria?: string | null;
  registradoPorNombre?: string | null;
  pagadoAt?: string | null;
  createdAt?: string | null;
  summary?: AllyPaymentViewSummary | null;
  resumen?: AllyPaymentViewSummary | null;
};

export type PendingPaymentViewItem = {
  id?: number | string;
  creditoId?: number | string;
  fecha?: string | null;
  fechaCredito?: string | null;
  fechaLiquidacion?: string | null;
  cliente?: string | null;
  clienteNombre?: string | null;
  clienteDocumento?: string | null;
  imei?: string | null;
  equipo?: string | null;
  plataforma?: string | null;
  valorVenta?: number | null;
  creditoAutorizado?: number | null;
  cuotaInicial?: number | null;
  porcentajeIntermediacion?: number | null;
  valorIntermediacion?: number | null;
  valorPagar?: number | null;
  aliado?: { nombre: string } | null;
  sede?: { nombre?: string | null } | null;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 20,
});
const numberFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 20 });
const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Bogota",
});
const timeFormatter = new Intl.DateTimeFormat("es-CO", {
  hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Bogota",
});

function amount(value: number | null | undefined) {
  return moneyFormatter.format(value != null && Number.isFinite(value) ? value : 0);
}

function count(value: number | null | undefined) {
  return numberFormatter.format(value != null && Number.isFinite(value) ? value : 0);
}

function date(value: string | null | undefined) {
  if (!value) return "—";
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function time(value: string | null | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : timeFormatter.format(parsed);
}

function identifier(value: string | null | undefined) {
  return value?.replace(/[.\s]/g, "") || "—";
}

function usePagination<T>(items: T[], keys: string) {
  const [pageSize, setPageSize] = useState(20);
  const [pagination, setPagination] = useState({ keys, page: 1 });
  const changed = pagination.keys !== keys;
  if (changed) setPagination({ keys, page: 1 });
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(changed ? 1 : pagination.page, pageCount);
  const start = (page - 1) * pageSize;
  return {
    page, pageSize, pageCount, start,
    rows: items.slice(start, start + pageSize),
    setPage: (value: number) => setPagination({ keys, page: value }),
    setPageSize: (value: number) => {
      setPageSize(value);
      setPagination({ keys, page: 1 });
    },
  };
}

function Pagination({
  total, noun, page, pageCount, pageSize, start, onPage, onPageSize, action,
}: {
  total: number;
  noun: string;
  page: number;
  pageCount: number;
  pageSize: number;
  start: number;
  onPage: (value: number) => void;
  onPageSize: (value: number) => void;
  action?: ReactNode;
}) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((value) => value === 1 || value === pageCount || Math.abs(value - page) <= 1);
  return (
    <footer className={styles.pagination}>
      <p aria-live="polite">
        Mostrando {total ? count(start + 1) : "0"} – {count(Math.min(start + pageSize, total))} de {count(total)} {noun}
      </p>
      <div className={styles.paginationControls}>
        <label className={styles.pageSize}>Filas
          <Select aria-label={`${noun} por página`} value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
            {[10, 20, 50, 100].map((value) => <option key={value} value={value}>{value} por página</option>)}
          </Select>
        </label>
        <nav className={styles.pages} aria-label={`Paginación de ${noun}`}>
          <Button variant="ghost" disabled={page === 1} onClick={() => onPage(page - 1)} aria-label="Página anterior"><ChevronLeft aria-hidden="true" /></Button>
          {pages.map((value, index) => (
            <span className={styles.pageGroup} key={value}>
              {index > 0 && value - pages[index - 1] > 1 ? <span className={styles.ellipsis} aria-hidden="true">…</span> : null}
              <Button variant="ghost" className={value === page ? styles.currentPage : undefined} onClick={() => onPage(value)} aria-label={`Página ${value}`} aria-current={value === page ? "page" : undefined}>{value}</Button>
            </span>
          ))}
          <Button variant="ghost" disabled={page === pageCount} onClick={() => onPage(page + 1)} aria-label="Página siguiente"><ChevronRight aria-hidden="true" /></Button>
        </nav>
        {action}
      </div>
    </footer>
  );
}

export function ReceivedPaymentsView<T extends ReceivedPaymentViewItem>({
  settlements, detailLoadingId, onOpen,
}: {
  settlements: T[];
  detailLoadingId: string | null;
  onOpen: (item: T) => void;
}) {
  const pagination = usePagination(settlements, settlements.map((item) => String(item.id)).join("|"));
  return (
    <section className={styles.receivedView}>
      <div className={styles.sectionHeader}>
        <h2>Períodos pagados</h2>
        <Badge tone="positive" className={styles.countBadge}>{count(settlements.length)} períodos</Badge>
      </div>
      {settlements.length ? (
        <>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Pagos recibidos, tabla desplazable">
            <table className={`${styles.table} ${styles.receivedTable}`}>
              <caption className={styles.srOnly}>Liquidaciones registradas con sus valores históricos</caption>
              <thead><tr>
                <th>Período</th><th>Aliado</th><th className={styles.numeric}>Créditos</th>
                <th className={styles.numeric}>Crédito autorizado</th><th className={styles.numeric}>Inicial</th>
                <th className={styles.numeric}>Intermediación</th><th className={styles.numeric}>Recaudos</th>
                <th className={styles.numeric}>Créditos anulados</th>
                <th className={styles.numeric}>Resultado neto</th><th>Aprobación</th><th>Registro</th><th className={styles.detailHeading}>Detalle</th>
              </tr></thead>
              <tbody>{pagination.rows.map((item) => {
                const stored = (item.summary || item.resumen)?.total;
                const net = item.saldoNeto ?? item.totalPagar ?? stored?.saldoNeto ?? stored?.totalPagar ?? stored?.valorPagar ?? 0;
                const recordedAt = item.pagadoAt || item.createdAt;
                const loading = detailLoadingId === String(item.id);
                return <tr key={item.id}>
                  <td className={styles.period}><span>{date(item.periodoInicio)} –</span><span>{date(item.periodoFin)}</span></td>
                  <td className={styles.allyName}>{item.aliado?.nombre || item.aliadoNombre || "—"}</td>
                  <td className={styles.numeric}>{count(item.numeroCreditos ?? stored?.numeroCreditos)}</td>
                  <td className={styles.numeric}>{amount(item.totalCreditoAutorizado ?? stored?.totalCreditoAutorizado ?? stored?.creditoAutorizado)}</td>
                  <td className={styles.numeric}>{amount(item.totalCuotaInicial ?? stored?.totalCuotaInicial ?? stored?.cuotaInicial)}</td>
                  <td className={styles.numeric}>{amount(item.totalIntermediacion ?? stored?.totalIntermediacion ?? stored?.valorIntermediacion)}</td>
                  <td className={styles.numeric}>{amount(item.totalRecaudosAliado ?? stored?.totalRecaudosAliado)}</td>
                  <td className={`${styles.numeric} ${styles.annulmentAmount}`}>{Number(item.totalAjustesAnulacion ?? stored?.totalAjustesAnulacion) > 0 ? `− ${amount(item.totalAjustesAnulacion ?? stored?.totalAjustesAnulacion)}` : amount(0)}{Number(item.numeroAjustesAnulacion ?? stored?.numeroAjustesAnulacion) > 0 ? <small>{count(item.numeroAjustesAnulacion ?? stored?.numeroAjustesAnulacion)} anulados</small> : null}</td>
                  <td className={`${styles.numeric} ${styles.net}`}><strong>{amount(Math.abs(net))}</strong><small className={net < 0 ? styles.consignation : undefined}>{net < 0 ? "Consignación del aliado" : net > 0 ? "Pago al aliado" : "Saldo cero"}</small></td>
                  <td className={styles.approval}>{item.numeroAprobacionBancaria || "—"}</td>
                  <td className={styles.registration}><span>{item.registradoPorNombre || "—"}</span><small>{date(recordedAt)}{time(recordedAt) ? `, ${time(recordedAt)}` : ""}</small></td>
                  <td className={styles.detailCell}><Button variant="secondary" className={styles.viewButton} disabled={Boolean(detailLoadingId)} onClick={() => onOpen(item)} aria-label={`Ver liquidación de ${item.aliado?.nombre || item.aliadoNombre || "aliado"}, período ${date(item.periodoInicio)} a ${date(item.periodoFin)}`}>{loading ? "Cargando…" : "Ver"}</Button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <Pagination total={settlements.length} noun="períodos" {...pagination} onPage={pagination.setPage} onPageSize={pagination.setPageSize} />
        </>
      ) : <EmptyState className={styles.empty} title="No hay períodos registrados" description="No se encontraron liquidaciones para los filtros aplicados." />}
    </section>
  );
}

export function PlatformIcon({ platform }: { platform: "ANDROID" | "IPHONE" }) {
  return <span aria-hidden="true" className={`${styles.platformIcon} ${platform === "ANDROID" ? styles.androidIcon : styles.appleIcon}`} />;
}

export function PendingPaymentsView({
  items, summary, platform, platformCounts, annulmentCount, annulmentTotal,
  onPlatformChange, onReviewCollections,
}: {
  items: PendingPaymentViewItem[];
  summary: AllyPaymentViewSummary | null | undefined;
  platform: string;
  platformCounts: { all: number; IPHONE: number; ANDROID: number };
  annulmentCount: number;
  annulmentTotal: number;
  onPlatformChange: (value: string) => void;
  onReviewCollections: () => void;
}) {
  const pagination = usePagination(items, items.map((item, index) => String(item.creditoId ?? item.id ?? index)).join("|"));
  const total = summary?.total;
  const metrics = [
    { label: "Valor de venta", value: total?.totalValorVenta ?? total?.valorVenta },
    { label: "Inicial", value: total?.totalCuotaInicial ?? total?.cuotaInicial },
    { label: "Crédito autorizado", value: total?.totalCreditoAutorizado ?? total?.creditoAutorizado },
    { label: "Intermediación", value: total?.totalIntermediacion ?? total?.valorIntermediacion },
  ];
  return (
    <section className={styles.pendingView}>
      <div className={styles.summaryStripe}>
        <dl className={styles.summaryMetrics}>{metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{amount(metric.value)}</dd></div>)}</dl>
        <div className={styles.pendingTotal}><span>Por créditos pendientes</span><strong>{amount(total?.totalPagarCreditos ?? total?.totalPagar ?? total?.valorPagar)}</strong>{annulmentCount > 0 ? <small className={styles.pendingAnnulments}>− {amount(annulmentTotal)} por {count(annulmentCount)} crédito{annulmentCount === 1 ? "" : "s"} anulado{annulmentCount === 1 ? "" : "s"}</small> : null}<small>Antes de descontar recaudos y créditos anulados.</small></div>
      </div>
      <div className={styles.platformSummary}>{(["ANDROID", "IPHONE"] as const).map((key) => {
        const bucket = summary?.[key];
        return <div key={key}><PlatformIcon platform={key} /><p><strong>{key === "ANDROID" ? "Android" : "iPhone"}</strong><span>·</span><span>{count(bucket?.numeroCreditos)} créditos</span><span>·</span><strong>{amount(bucket?.totalPagarCreditos ?? bucket?.totalPagar ?? bucket?.valorPagar)}</strong></p></div>;
      })}</div>
      <div className={styles.pendingPanel}>
        <div className={styles.tableHeader}>
          <h2>Detalle de créditos</h2>
          <div className={styles.platformFilters} role="group" aria-label="Filtrar créditos por plataforma">
            {[
              { value: "", label: "Todos", total: platformCounts.all },
              { value: "IPHONE", label: "iPhone", total: platformCounts.IPHONE },
              { value: "ANDROID", label: "Android", total: platformCounts.ANDROID },
            ].map((option) => <Button key={option.value} variant="secondary" className={platform === option.value || (!option.value && platform === "ALL") ? styles.activeFilter : undefined} aria-pressed={platform === option.value || (!option.value && platform === "ALL")} onClick={() => onPlatformChange(option.value)}>{option.label} ({count(option.total)})</Button>)}
          </div>
        </div>
        {items.length ? <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Créditos pendientes, tabla desplazable">
          <table className={`${styles.table} ${styles.pendingTable}`}>
            <caption className={styles.srOnly}>Créditos pendientes de liquidación</caption>
            <thead><tr><th>Fecha</th><th>Cliente / Cédula</th><th>Aliado / Sede</th><th>Equipo / IMEI</th><th className={styles.numeric}>Venta / Inicial</th><th className={styles.numeric}>Crédito autorizado</th><th className={styles.numeric}>Intermediación</th><th className={styles.numeric}>Por pagar</th></tr></thead>
            <tbody>{pagination.rows.map((item, index) => <tr key={item.creditoId ?? item.id ?? pagination.start + index}>
              <td className={styles.creditDate}>{date(item.fechaLiquidacion || item.fechaCredito || item.fecha)}</td>
              <td className={styles.clientCell}><span>{item.clienteNombre || item.cliente || "—"}</span><small>CC {identifier(item.clienteDocumento)}</small></td>
              <td className={styles.allyCell}><span>{item.aliado?.nombre || "—"}</span><small>{item.sede?.nombre || "—"}</small></td>
              <td className={styles.equipmentCell}><span>{item.equipo || (item.plataforma?.toUpperCase() === "ANDROID" ? "Android" : item.plataforma?.toUpperCase() === "IPHONE" ? "iPhone" : "—")}</span><small>IMEI {identifier(item.imei)}</small></td>
              <td className={styles.numeric}><span>{amount(item.valorVenta)}</span><small>Inicial {amount(item.cuotaInicial)}</small></td>
              <td className={styles.numeric}>{amount(item.creditoAutorizado)}</td>
              <td className={styles.numeric}><span>{item.porcentajeIntermediacion == null ? "—" : `${count(item.porcentajeIntermediacion)}%`}</span><small>{amount(item.valorIntermediacion)}</small></td>
              <td className={`${styles.numeric} ${styles.net}`}><strong>{amount(item.valorPagar)}</strong></td>
            </tr>)}</tbody>
          </table>
        </div> : <EmptyState className={styles.empty} title="No hay créditos pendientes" description="No se encontraron créditos elegibles para los filtros aplicados." />}
        <Pagination total={items.length} noun="créditos" {...pagination} onPage={pagination.setPage} onPageSize={pagination.setPageSize} action={<Button variant="secondary" className={styles.collectionsButton} onClick={onReviewCollections}><FileText aria-hidden="true" />Revisar recaudos pendientes</Button>} />
      </div>
    </section>
  );
}
