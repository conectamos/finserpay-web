"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, Eye } from "lucide-react";
import { Badge, Button, DataTable, EmptyState, Select, StatusPill } from "@/app/_components/finser-ui";
import type { CutReport, CutRow } from "@/lib/cut-collection-types";
import styles from "./cut-installment-detail.module.css";

type Props = {
  report: CutReport;
  onExport: () => void;
  exporting: boolean;
  onViewPayments: (row: CutRow) => void;
};

const PAGE_SIZE = 25;
const countFormat = new Intl.NumberFormat("es-CO");
const moneyFormat = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const statusLabels = { pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" };
const statusTones = { pendiente: "neutral", parcial: "warning", pagado: "positive" } as const;

function dateLabel(value: string) {
  return dateFormat.format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
}

function LastPayment({ row }: { row: CutRow }) {
  if (!row.lastPaymentAt) return row.reconciledReceived ? "Sin fecha individual" : "Sin pagos";
  return <time dateTime={row.lastPaymentAt}>{timeFormat.format(new Date(row.lastPaymentAt))}</time>;
}

function PaymentAction({ row, onViewPayments }: Pick<Props, "onViewPayments"> & { row: CutRow }) {
  return <Button variant="ghost" className={styles.paymentButton} onClick={() => onViewPayments(row)}
    aria-label={`Ver pagos de ${row.clientName}, crédito ${row.folio}, cuota ${row.installment}`}>
    <Eye size={16} aria-hidden="true" />Ver pagos
  </Button>;
}

function MobileInstallment({ row, onViewPayments }: Pick<Props, "onViewPayments"> & { row: CutRow }) {
  return <details className={styles.mobileRow}>
    <summary>
      <span className={styles.mobileIdentity}><strong>{row.clientName}</strong><small>Crédito {row.folio} · Cuota {row.installment}</small></span>
      <ChevronDown className={styles.chevron} size={18} aria-hidden="true" />
      <span className={styles.mobileOverview}><StatusPill tone={statusTones[row.status]}>{statusLabels[row.status]}</StatusPill>
        <span>Pendiente <b>{moneyFormat.format(row.pending)}</b></span>
      </span>
    </summary>
    <div className={styles.expanded}>
      <dl className={styles.facts}>
        <div><dt>Cédula</dt><dd>{row.document}</dd></div>
        <div><dt>Vencimiento</dt><dd><time dateTime={row.dueDate}>{dateLabel(row.dueDate)}</time></dd></div>
        <div><dt>Aliado</dt><dd>{row.aliado}</dd></div>
        <div><dt>Sede</dt><dd>{row.sede}</dd></div>
        <div><dt>Valor de cuota</dt><dd>{moneyFormat.format(row.installmentAmount)}</dd></div>
        <div><dt>Esperado</dt><dd>{moneyFormat.format(row.expected)}</dd></div>
        <div><dt>Recibido</dt><dd>{moneyFormat.format(row.received)}</dd></div>
        <div><dt>Anticipos incluidos</dt><dd>{moneyFormat.format(row.priorPayments)}</dd></div>
        <div className={styles.wide}><dt>Último pago · Colombia</dt><dd><LastPayment row={row} /></dd></div>
      </dl>
      {row.warning && <p className={styles.warningText}>{row.warning}</p>}
      <PaymentAction row={row} onViewPayments={onViewPayments} />
    </div>
  </details>;
}

export default function CutInstallmentDetail({ report, onExport, exporting, onViewPayments }: Props) {
  const [requestedPage, setRequestedPage] = useState(1);
  const heading = useRef<HTMLHeadingElement>(null);
  const { rows, summary } = report;
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, pageCount);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  const installmentTotal = rows.reduce((sum, row) => sum + row.installmentAmount, 0);
  const count = countFormat.format(total);

  function goToPage(page: number) {
    setRequestedPage(Math.max(1, Math.min(pageCount, page)));
    heading.current?.focus();
  }

  return <section className={styles.detail} aria-labelledby="cut-detail-title">
    <header className={styles.header}>
      <div>
        <div className={styles.titleLine}><h2 id="cut-detail-title" ref={heading} tabIndex={-1}>Detalle de cuotas</h2>
          <Badge tone="neutral">{count} {total === 1 ? "cuota" : "cuotas"}</Badge>
        </div>
        <p>Vencimientos del {dateLabel(report.cutDate)}. El Excel incluye todas las cuotas filtradas.</p>
      </div>
      <Button variant="secondary" onClick={onExport} disabled={exporting || !total}>
        <Download size={17} aria-hidden="true" />{exporting ? "Generando Excel…" : "Exportar a Excel"}
      </Button>
    </header>

    {total === 0 ? <EmptyState className={styles.empty} title="No hay cuotas con estos filtros" description="Selecciona otro corte, aliado, sede o estado para consultar sus créditos y pagos." /> : <>
      <div className={styles.desktop}>
        <DataTable className={styles.tableFrame}><table className={styles.table}>
          <caption className={styles.srOnly}>Cuotas del corte del {dateLabel(report.cutDate)}. Página {currentPage} de {pageCount}. Fechas y horas de Colombia.</caption>
          <thead><tr>
            <th scope="col">Cliente / crédito</th><th scope="col">Aliado / sede</th><th scope="col">Cuota</th>
            <th scope="col" className={styles.amount}>Esperado</th><th scope="col" className={styles.amount}>Recibido</th>
            <th scope="col" className={styles.amount}>Pendiente</th><th scope="col">Estado / último pago</th>
            <th scope="col"><span className={styles.srOnly}>Detalle de pagos</span></th>
          </tr></thead>
          <tbody>{pageRows.map(row => <tr key={row.key}>
            <th scope="row" className={styles.identity}>
              <strong>{row.clientName}</strong><small>CC {row.document}</small><small>Crédito {row.folio} · Cuota {row.installment}</small>
              {row.warning && <details className={styles.warning}><summary>Observación</summary><p>{row.warning}</p></details>}
            </th>
            <td className={styles.location}><span>{row.aliado}</span><small>{row.sede}</small></td>
            <td><span>{moneyFormat.format(row.installmentAmount)}</span><small>Vence <time dateTime={row.dueDate}>{dateLabel(row.dueDate)}</time></small></td>
            <td className={styles.amount}>{moneyFormat.format(row.expected)}</td>
            <td className={styles.amount}><strong>{moneyFormat.format(row.received)}</strong><small>Anticipos: {moneyFormat.format(row.priorPayments)}</small></td>
            <td className={styles.amount}>{moneyFormat.format(row.pending)}</td>
            <td><StatusPill tone={statusTones[row.status]}>{statusLabels[row.status]}</StatusPill><small><LastPayment row={row} /></small></td>
            <td className={styles.actionCell}><PaymentAction row={row} onViewPayments={onViewPayments} /></td>
          </tr>)}</tbody>
          <tfoot><tr>
            <th scope="row" colSpan={2}>Total de las cuotas filtradas<small>{count} {total === 1 ? "cuota" : "cuotas"}</small></th>
            <td>{moneyFormat.format(installmentTotal)}</td><td className={styles.amount}>{moneyFormat.format(summary.expected)}</td>
            <td className={styles.amount}>{moneyFormat.format(summary.received)}<small>Anticipos: {moneyFormat.format(summary.priorPayments)}</small></td>
            <td className={styles.amount}>{moneyFormat.format(summary.pending)}</td><td colSpan={2} />
          </tr></tfoot>
        </table></DataTable>
      </div>
      <div className={styles.mobile}>
        <div className={styles.mobileList}>{pageRows.map(row => <MobileInstallment key={row.key} row={row} onViewPayments={onViewPayments} />)}</div>
        <section className={styles.mobileTotals} aria-labelledby="cut-mobile-totals">
          <h3 id="cut-mobile-totals">Total de las cuotas filtradas</h3>
          <dl className={styles.facts}>
            <div><dt>Valor de cuotas</dt><dd>{moneyFormat.format(installmentTotal)}</dd></div>
            <div><dt>Esperado</dt><dd>{moneyFormat.format(summary.expected)}</dd></div>
            <div><dt>Recibido</dt><dd>{moneyFormat.format(summary.received)}</dd></div>
            <div><dt>Anticipos incluidos</dt><dd>{moneyFormat.format(summary.priorPayments)}</dd></div>
            <div><dt>Pendiente</dt><dd>{moneyFormat.format(summary.pending)}</dd></div>
          </dl>
        </section>
      </div>
      <footer className={styles.footer}>
        <p role="status">Mostrando {countFormat.format(start + 1)}–{countFormat.format(start + pageRows.length)} de {count} cuotas</p>
        {pageCount > 1 && <nav className={styles.pagination} aria-label="Páginas del detalle de cuotas">
          <Button variant="secondary" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)} aria-label="Página anterior"><ChevronLeft size={17} aria-hidden="true" /></Button>
          <Select aria-label="Ir a la página de cuotas" value={currentPage} onChange={event => goToPage(Number(event.target.value))}>
            {Array.from({ length: pageCount }, (_, index) => <option key={index} value={index + 1}>Página {countFormat.format(index + 1)} de {countFormat.format(pageCount)}</option>)}
          </Select>
          <Button variant="secondary" disabled={currentPage === pageCount} onClick={() => goToPage(currentPage + 1)} aria-label="Página siguiente"><ChevronRight size={17} aria-hidden="true" /></Button>
        </nav>}
      </footer>
    </>}
  </section>;
}
