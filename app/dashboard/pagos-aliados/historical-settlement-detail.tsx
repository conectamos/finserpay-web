"use client";

import { useState, type ReactNode } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Database, Download, Printer, X } from "lucide-react";
import { Button, Card, StatusPill } from "@/app/_components/finser-ui";
import { PlatformIcon } from "./ally-payment-views";
import { formatDate, formatMoney, formatNumber, numberValue, statusTone } from "./ally-payment-format";
import type { PaymentCreditItem, PaymentSummary, PaymentSummaryBucket, Settlement } from "./ally-payment-types";
import styles from "./historical-settlement-detail.module.css";

const PAGE_SIZE = 10;
const savedPercentFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 });

function savedPercent(value: number | null | undefined) {
  return value === undefined ? "—" : value === null ? "Mixto" : `${savedPercentFormatter.format(value)}%`;
}

function savedAmount(bucket: PaymentSummaryBucket | null | undefined, key: keyof PaymentSummaryBucket, fallback: keyof PaymentSummaryBucket) {
  return formatMoney(bucket?.[key] ?? bucket?.[fallback]);
}

function paymentTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = new Intl.DateTimeFormat("es-CO", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Bogota" }).format(date);
  return `${formatDate(value)} · ${time}`;
}

function identifier(value: string | null | undefined) {
  return value?.replace(/[.\s]/g, "") || "—";
}

function SavedProductSummary({ platform, bucket }: { platform: "IPHONE" | "ANDROID"; bucket: PaymentSummaryBucket | null | undefined }) {
  return (
    <Card className={styles.productCard}>
      <div className={styles.productHeading}>
        <PlatformIcon platform={platform} />
        <h2>{platform === "IPHONE" ? "iPhone" : "Android"}</h2>
        {bucket && <span className={styles.countBadge}>{formatNumber(bucket.numeroCreditos)} créditos</span>}
      </div>
      {bucket ? <>
        <dl className={styles.productAmounts}>
          <div><dt>Valor venta</dt><dd>{savedAmount(bucket, "totalValorVenta", "valorVenta")}</dd></div>
          <div><dt>Inicial</dt><dd>{savedAmount(bucket, "totalCuotaInicial", "cuotaInicial")}</dd></div>
          <div><dt>Crédito autorizado</dt><dd>{savedAmount(bucket, "totalCreditoAutorizado", "creditoAutorizado")}</dd></div>
          <div><dt>Intermediación</dt><dd>{numberValue(bucket.numeroCreditos) > 0 ? <>{savedPercent(bucket.porcentajeIntermediacion)} · {savedAmount(bucket, "totalIntermediacion", "valorIntermediacion")}</> : "—"}</dd></div>
        </dl>
        <div className={styles.productTotal}><span>Valor por créditos</span><strong>{savedAmount(bucket, "totalPagar", "valorPagar")}</strong></div>
      </> : <p className={styles.missingBreakdown}>Sin desglose guardado</p>}
    </Card>
  );
}

function SavedCreditTable({ items }: { items: PaymentCreditItem[] }) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const start = (current - 1) * PAGE_SIZE;
  const pageNumbers = Array.from({ length: pages }, (_, index) => index + 1)
    .filter(value => value === 1 || value === pages || Math.abs(value - current) <= 1);
  return (
    <Card className={styles.creditCard}>
      <div className={styles.tableHeading}><h2>Detalle por crédito</h2><span className={styles.countBadge}>{formatNumber(items.length)} créditos</span></div>
      <div className={styles.tableScroll} role="region" aria-label="Créditos liquidados, tabla desplazable" tabIndex={0}>
        <table className={styles.creditTable}>
          <caption className="sr-only">Créditos de la liquidación guardada, con sus importes históricos</caption>
          <thead><tr><th>Fecha</th><th>Cliente / Cédula</th><th>Sede</th><th>Equipo / IMEI</th><th className={styles.numeric}>Venta</th><th className={styles.numeric}>Inicial</th><th className={styles.numeric}>Crédito autorizado</th><th className={styles.numeric}>Intermediación</th><th className={styles.numeric}>Valor liquidado</th><th>Estado</th></tr></thead>
          <tbody>
            {items.slice(start, start + PAGE_SIZE).map((item, index) => {
              const platform = String(item.plataforma || "").toUpperCase();
              const state = item.estadoLiquidacion || item.estado || "—";
              return <tr key={String(item.creditoId ?? item.id ?? start + index)}>
                <td className={styles.dateCell}>{formatDate(item.fechaCredito || item.fecha)}</td>
                <td className={styles.clientCell}><span>{item.clienteNombre || item.cliente || "—"}</span><small>{identifier(item.clienteDocumento)}</small></td>
                <td>{item.sede?.nombre || "—"}</td>
                <td><div className={styles.equipment}>{(platform === "IPHONE" || platform === "ANDROID") && <PlatformIcon platform={platform} />}<div><span>{item.equipo || "—"}</span><small>IMEI {identifier(item.imei)}</small></div></div></td>
                <td className={styles.numeric}>{formatMoney(item.valorVenta)}</td>
                <td className={styles.numeric}>{formatMoney(item.cuotaInicial)}</td>
                <td className={styles.numeric}>{formatMoney(item.creditoAutorizado)}</td>
                <td className={styles.numeric}>{savedPercent(item.porcentajeIntermediacion)} · {formatMoney(item.valorIntermediacion)}</td>
                <td className={`${styles.numeric} ${styles.payable}`}>{formatMoney(item.valorPagar)}</td>
                <td className={styles.statusCell}><StatusPill tone={statusTone(state)}>{state}</StatusPill></td>
              </tr>;
            })}
            {!items.length && <tr><td colSpan={10} className={styles.emptyTable}>Sin créditos asociados</td></tr>}
          </tbody>
        </table>
      </div>
      <footer className={styles.tableFooter}>
        <p aria-live="polite">Mostrando {items.length ? start + 1 : 0}–{Math.min(start + PAGE_SIZE, items.length)} de {formatNumber(items.length)} créditos</p>
        <div className={styles.paginationControls}>
          <span className={styles.pageSize}>10 por página</span>
          <nav className={styles.pagination} aria-label="Páginas de créditos liquidados">
            <button type="button" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft size={16} aria-hidden="true" /><span>Anterior</span></button>
            {pageNumbers.map((value, index) => <span className={styles.pageItem} key={value}>
              {index > 0 && value - pageNumbers[index - 1] > 1 && <span className={styles.ellipsis}>…</span>}
              <button type="button" aria-label={`Página ${value}`} aria-current={current === value ? "page" : undefined} onClick={() => setPage(value)}>{value}</button>
            </span>)}
            <button type="button" disabled={current === pages} onClick={() => setPage(current + 1)}><span>Siguiente</span><ChevronRight size={16} aria-hidden="true" /></button>
          </nav>
        </div>
      </footer>
    </Card>
  );
}

export default function HistoricalSettlementDetail({ settlement, summary, items, collectionCount, collectionDetail, annulmentCount, annulmentTotal, annulmentDetail, onPrint, onDownload, onClose }: {
  settlement: Settlement;
  summary: PaymentSummary | null;
  items: PaymentCreditItem[];
  collectionCount: number;
  collectionDetail: ReactNode;
  annulmentCount: number;
  annulmentTotal: number;
  annulmentDetail: ReactNode;
  onPrint: () => void;
  onDownload: () => void;
  onClose: () => void;
}) {
  // Display the confirmed snapshot. Pagination never changes these stored totals.
  const total = summary?.total;
  const net = numberValue(settlement.saldoNeto ?? settlement.totalPagar ?? total?.saldoNeto ?? total?.totalPagar);
  const creditsTotal = numberValue(settlement.totalPagarCreditos ?? total?.totalPagarCreditos ?? total?.totalPagar ?? settlement.totalPagar);
  const collectionsTotal = numberValue(settlement.totalRecaudosAliado ?? total?.totalRecaudosAliado);
  const direction = settlement.direccionSaldo || (net < 0 ? "CONSIGNACION_ALIADO" : net > 0 ? "PAGO_ALIADO" : "SALDO_CERO");
  const isZero = direction === "SALDO_CERO";
  const isConsignment = direction === "CONSIGNACION_ALIADO";
  const state = settlement.estado || "—";
  const annulled = state.toUpperCase().includes("ANUL");
  const title = annulled ? "TOTAL ANULADO" : isZero ? "SALDO CONCILIADO" : isConsignment ? "TOTAL RECIBIDO DEL ALIADO" : "TOTAL PAGADO";
  const result = annulled ? "Liquidación anulada" : isZero ? "Sin saldo por transferir" : isConsignment ? "Consignación a FINSER PAY registrada" : "Pago al aliado registrado";
  return (
    <div className={styles.detail}>
      <nav className={styles.breadcrumb} aria-label="Ruta de liquidación"><button type="button" onClick={onClose}>Pagos a aliados</button><span>/</span><button type="button" onClick={onClose}>Historial</button><span>/</span><strong>Detalle</strong></nav>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>LIQUIDACIÓN DEL ALIADO</p><h1>{settlement.aliado?.nombre || settlement.aliadoNombre || "Aliado"}</h1><p className={styles.period}>{formatDate(settlement.periodoInicio)} al {formatDate(settlement.periodoFin)}</p></div>
        <div className={styles.actions}><Button variant="secondary" onClick={onPrint}><Printer size={18} aria-hidden="true" />Ver / imprimir PDF</Button><Button variant="secondary" onClick={onDownload}><Download size={18} aria-hidden="true" />Descargar PDF</Button><Button variant="secondary" className={styles.close} aria-label="Cerrar detalle de liquidación" onClick={onClose}><X size={20} aria-hidden="true" /><span className="sr-only">Cerrar</span></Button></div>
      </header>
      <Card className={styles.metadata}>
        <dl><div><dt>Aprobación bancaria</dt><dd>{settlement.numeroAprobacionBancaria || "—"}</dd></div><div><dt>Fecha de pago</dt><dd>{paymentTimestamp(settlement.pagadoAt || settlement.createdAt)}</dd></div><div><dt>Registrado por</dt><dd>{settlement.registradoPorNombre || "—"}</dd></div><div><dt>Estado</dt><dd><StatusPill tone={statusTone(state)}>{state}</StatusPill></dd></div></dl>
      </Card>
      <section className={styles.summary} aria-label="Resumen de liquidación guardada">
        <SavedProductSummary platform="IPHONE" bucket={summary?.IPHONE} />
        <SavedProductSummary platform="ANDROID" bucket={summary?.ANDROID} />
        <Card className={styles.netCard}><h2>{title}</h2><strong className={styles.netAmount}>{formatMoney(Math.abs(net))}</strong><div className={`${styles.result} ${annulled ? styles.annulled : ""}`}><CheckCircle2 size={32} aria-hidden="true" /><span>{result}</span></div><dl><div><dt>Valor por créditos</dt><dd>{formatMoney(creditsTotal)}</dd></div><div><dt>Recaudos del aliado</dt><dd>− {formatMoney(collectionsTotal)}</dd></div><div className={styles.annulmentBreakdown}><dt>Créditos anulados</dt><dd>− {formatMoney(annulmentTotal)}</dd></div></dl></Card>
      </section>
      <SavedCreditTable key={String(settlement.id)} items={items} />
      {annulmentCount > 0 ? annulmentDetail : null}
      {collectionCount ? <details className={styles.collections}>
        <summary><Database size={25} aria-hidden="true" /><strong>Recaudos del aliado</strong><span className={styles.countBadge}>{formatNumber(collectionCount)} recaudos</span><span className={styles.collectionValue}>{formatMoney(collectionsTotal)}</span><ChevronRight size={18} aria-hidden="true" /></summary>
        <div className={styles.collectionDetail}>{collectionDetail}</div>
      </details> : <Card className={styles.emptyCollections}><Database size={25} aria-hidden="true" /><strong>Recaudos del aliado</strong><div><strong>{formatMoney(collectionsTotal)}</strong><span>Sin recaudos asociados</span></div></Card>}
    </div>
  );
}
