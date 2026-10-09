"use client";

import { creditDisplayNumber } from "@/lib/credit-display-number";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleMinus,
  Info,
  RefreshCw,
  RotateCcw,
  Search,
  WalletCards,
  X,
} from "lucide-react";
import ConfirmDialog from "@/app/_components/finser-confirm-dialog";
import {
  Badge,
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
import {
  ALLY_PAYMENTS_AVAILABLE_FROM,
  ALLY_PAYMENTS_AVAILABLE_FROM_LABEL,
  calculateAllyPaymentAmounts,
  roundAllyPaymentMoney,
  summarizeAllyPayments,
  type AllyPaymentIntermediationAdjustment,
} from "@/lib/ally-payments-core";

import { PendingPaymentsView, PlatformIcon, ReceivedPaymentsView } from "./ally-payment-views";
import styles from "./ally-payments-console.module.css";
import HistoricalSettlementDetail from "./historical-settlement-detail";
import type { AllyOption, PaymentAnnulmentAdjustmentItem, PaymentCreditItem, PaymentCollectionItem, PaymentSummaryBucket, PaymentSummary, Settlement, PaymentPreview, AllyPaymentsResponse } from "./ally-payment-types";
import { numberValue, formatMoney, formatNumber, formatPercent, formatDate, formatDateTime, statusTone, platformLabel } from "./ally-payment-format";
import {
  emptyAllyPaymentViewFilters, filterPendingAllyAnnulmentAdjustments, filterPendingAllyCollections, filterPendingAllyCredits,
  filterReceivedAllyPayments, type AllyPaymentViewFilters,
} from "@/lib/ally-payment-view-filters";

type PaymentsTab = "liquidar" | "recibidos" | "pendientes";

function itemDate(item: PaymentCreditItem) {
  return item.fechaCredito || item.fecha || null;
}

function itemClient(item: PaymentCreditItem) {
  return item.clienteNombre || item.cliente || "Cliente sin nombre";
}

function itemSite(item: PaymentCreditItem) {
  return item.sede?.nombre || "Sede sin nombre";
}

function itemStatus(item: PaymentCreditItem) {
  return item.estadoLiquidacion || item.estado || "PENDIENTE";
}

function itemKey(item: PaymentCreditItem, index: number) {
  return String(item.creditoId ?? item.id ?? item.imei ?? index);
}

function itemCreditId(item: PaymentCreditItem) {
  const creditId = Number(item.creditoId);
  return Number.isSafeInteger(creditId) && creditId > 0 ? creditId : null;
}

function parseIntermediationInput(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) {
    return { value: null, error: "Ingresa un porcentaje." } as const;
  }
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) {
    return { value: null, error: "Usa maximo dos decimales." } as const;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return { value: null, error: "Debe estar entre 0 y 100." } as const;
  }
  return { value: parsed, error: null } as const;
}

function buildIntermediationAdjustmentState(
  items: PaymentCreditItem[],
  values: Record<string, string>
) {
  const adjustments: AllyPaymentIntermediationAdjustment[] = [];
  const errors: Record<string, string> = {};
  const changedKeys = new Set<string>();

  for (const item of items) {
    const creditId = itemCreditId(item);
    if (!creditId) continue;
    const key = String(creditId);
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;

    const parsed = parseIntermediationInput(values[key]);
    if (parsed.error || parsed.value === null) {
      errors[key] = parsed.error || "Porcentaje no valido.";
      continue;
    }

    if (parsed.value !== numberValue(item.porcentajeIntermediacion)) {
      adjustments.push({
        creditoId: creditId,
        porcentajeIntermediacion: parsed.value,
      });
      changedKeys.add(key);
    }
  }

  adjustments.sort((left, right) => left.creditoId - right.creditoId);
  return { adjustments, changedKeys, errors };
}

function recalculatePreviewItems(
  items: PaymentCreditItem[],
  adjustments: readonly AllyPaymentIntermediationAdjustment[]
) {
  const percentageByCredit = new Map(
    adjustments.map((adjustment) => [
      adjustment.creditoId,
      adjustment.porcentajeIntermediacion,
    ])
  );

  return items.map((item) => {
    const creditId = itemCreditId(item);
    if (!creditId || !percentageByCredit.has(creditId)) return item;
    return {
      ...item,
      ...calculateAllyPaymentAmounts({
        valorVenta: item.valorVenta,
        cuotaInicial: item.cuotaInicial,
        porcentajeIntermediacion: percentageByCredit.get(creditId),
      }),
    };
  });
}

function summarizePreviewItems(items: PaymentCreditItem[]): PaymentSummary {
  const recognizedItems = items.flatMap((item) => {
    const normalizedPlatform = String(item.plataforma || "").toUpperCase();
    const platform =
      normalizedPlatform === "ANDROID"
        ? ("ANDROID" as const)
        : normalizedPlatform === "IPHONE"
          ? ("IPHONE" as const)
          : null;
    if (!platform) return [];
    return [{
      plataforma: platform,
      valorVenta: numberValue(item.valorVenta),
      cuotaInicial: numberValue(item.cuotaInicial),
      creditoAutorizado: numberValue(item.creditoAutorizado),
      porcentajeIntermediacion: numberValue(item.porcentajeIntermediacion),
      valorIntermediacion: numberValue(item.valorIntermediacion),
      valorPagar: numberValue(item.valorPagar),
    }];
  });

  return summarizeAllyPayments(recognizedItems);
}

function summaryValue(
  bucket: PaymentSummaryBucket | null | undefined,
  totalKey:
    | "totalValorVenta"
    | "totalCreditoAutorizado"
    | "totalCuotaInicial"
    | "totalIntermediacion"
    | "totalPagar",
  fallbackKey:
    | "valorVenta"
    | "creditoAutorizado"
    | "cuotaInicial"
    | "valorIntermediacion"
    | "valorPagar"
) {
  return numberValue(bucket?.[totalKey] ?? bucket?.[fallbackKey]);
}

function previewItems(preview: PaymentPreview | null) {
  if (Array.isArray(preview?.items)) return preview.items;
  return Array.isArray(preview?.creditos) ? preview.creditos : [];
}

function collectionItems(source: { recaudos?: PaymentCollectionItem[] | null } | null) {
  return Array.isArray(source?.recaudos) ? source.recaudos : [];
}

function annulmentAdjustmentItems(
  source: { ajustesAnulacion?: PaymentAnnulmentAdjustmentItem[] | null } | null
) {
  return Array.isArray(source?.ajustesAnulacion) ? source.ajustesAnulacion : [];
}

function totalAnnulmentAdjustments(source: {
  totalAjustesAnulacion?: number | null;
  ajustesAnulacion?: PaymentAnnulmentAdjustmentItem[] | null;
} | null) {
  if (source?.totalAjustesAnulacion != null) {
    return Math.max(0, roundAllyPaymentMoney(source.totalAjustesAnulacion));
  }
  return roundAllyPaymentMoney(
    annulmentAdjustmentItems(source).reduce(
      (total, item) => total + Math.max(0, numberValue(item.valorDescuento)),
      0
    )
  );
}

function calculateDisplayedSettlementBalance(
  totalPagarCreditos: unknown,
  totalRecaudosAliado: unknown,
  totalAjustesAnulacion: unknown
) {
  const saldoNeto = roundAllyPaymentMoney(
    Math.max(0, numberValue(totalPagarCreditos)) -
      Math.max(0, numberValue(totalRecaudosAliado)) -
      Math.max(0, numberValue(totalAjustesAnulacion))
  );
  return {
    saldoNeto,
    direccionSaldo: saldoNeto > 0
      ? "PAGO_ALIADO"
      : saldoNeto < 0
        ? "CONSIGNACION_ALIADO"
        : "SALDO_CERO",
  } as const;
}

function settlementSummary(settlement: Settlement | null) {
  if (!settlement) return null;
  if (settlement.summary || settlement.resumen) {
    return settlement.summary || settlement.resumen || null;
  }

  return {
    total: {
      numeroCreditos: settlement.numeroCreditos,
      totalValorVenta: settlement.totalValorVenta,
      totalCreditoAutorizado: settlement.totalCreditoAutorizado,
      totalCuotaInicial: settlement.totalCuotaInicial,
      totalIntermediacion: settlement.totalIntermediacion,
      totalPagar: settlement.totalPagar,
      numeroAjustesAnulacion: settlement.numeroAjustesAnulacion,
      totalAjustesAnulacion: settlement.totalAjustesAnulacion,
      porcentajeIntermediacion: null,
    },
  };
}

function settlementItems(settlement: Settlement | null) {
  if (!settlement) return [];
  if (Array.isArray(settlement.items)) return settlement.items;
  if (Array.isArray(settlement.creditos)) return settlement.creditos;
  return Array.isArray(settlement.detalles) ? settlement.detalles : [];
}

function responseMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const data = payload as { error?: unknown; message?: unknown };
    if (typeof data.error === "string" && data.error.trim()) return data.error;
    if (typeof data.message === "string" && data.message.trim()) return data.message;
  }
  return fallback;
}

type IntermediationEditor = {
  disabled?: boolean;
  basePercentages: Record<string, number>;
  changedKeys: ReadonlySet<string>;
  errors: Record<string, string>;
  onChange: (creditId: number, value: string) => void;
  values: Record<string, string>;
};

function IntermediationField({
  editor,
  item,
  compact = false,
}: {
  editor: IntermediationEditor | null;
  item: PaymentCreditItem;
  compact?: boolean;
}) {
  const creditId = itemCreditId(item);
  if (!editor || !creditId) {
    return <>{formatPercent(item.porcentajeIntermediacion)}</>;
  }

  const key = String(creditId);
  const basePercentage = editor.basePercentages[key] ?? numberValue(item.porcentajeIntermediacion);
  const value = Object.prototype.hasOwnProperty.call(editor.values, key)
    ? editor.values[key]
    : String(basePercentage);
  const error = editor.errors[key];
  const changed = editor.changedKeys.has(key);

  return (
    <div className={compact ? styles.intermediationField : "flex min-w-28 flex-col items-end gap-1"}>
      <div className={compact ? styles.percentageInput : "relative w-28"}>
        <Input
          className={[
            compact ? "tabular-nums" : "!h-10 !pr-8 text-right tabular-nums",
            changed ? "!border-[#9cc84b] !bg-[var(--fp-lime-soft)]" : "",
          ].join(" ")}
          type="number"
          min={0}
          max={100}
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(event) => editor.onChange(creditId, event.target.value)}
          aria-label={`Porcentaje de intermediacion del credito ${item.imei || creditId}`}
          aria-invalid={Boolean(error)}
          disabled={editor.disabled}
        />
        <span className={compact ? styles.percentageSymbol : "pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-[var(--fp-muted)]"}>
          %
        </span>
      </div>
      {changed && !compact ? (
        <span className="text-[10px] font-bold text-[#5c7a13]">
          Base {formatPercent(basePercentage)}
        </span>
      ) : null}
      {error ? (
        <span className="max-w-36 text-right text-[10px] font-semibold text-[var(--fp-danger)]" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function PaymentInfo({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className={styles.info}>
      <summary aria-label={label}>
        <Info size={16} aria-hidden="true" />
      </summary>
      <div>{children}</div>
    </details>
  );
}

function SettlementSummary({
  summary,
  totalPagarCreditos,
  totalRecaudosAliado,
  totalAjustesAnulacion,
}: {
  summary: PaymentSummary | null;
  totalPagarCreditos: number;
  totalRecaudosAliado: number;
  totalAjustesAnulacion: number;
}) {
  const balance = calculateDisplayedSettlementBalance(
    totalPagarCreditos,
    totalRecaudosAliado,
    totalAjustesAnulacion
  );
  const direction = balance.saldoNeto < 0
    ? "El aliado paga a FINSER PAY"
    : balance.saldoNeto === 0
      ? "Sin saldo por transferir"
      : "FINSER PAY paga al aliado";

  return (
    <section className={styles.previewSummary} aria-label="Resumen de liquidación">
      {(["IPHONE", "ANDROID"] as const).map((platform) => {
        const bucket = summary?.[platform];
        const count = numberValue(bucket?.numeroCreditos);
        return (
          <Card className={styles.productCard} key={platform}>
            <div className={styles.productHeading}>
              <PlatformIcon platform={platform} />
              <h2>{platformLabel(platform)}</h2>
              <span className={styles.countBadge}>{formatNumber(count)} créditos</span>
            </div>
            <dl className={styles.productAmounts}>
              <div><dt>Valor venta</dt><dd>{formatMoney(summaryValue(bucket, "totalValorVenta", "valorVenta"))}</dd></div>
              <div><dt>Inicial</dt><dd>{formatMoney(summaryValue(bucket, "totalCuotaInicial", "cuotaInicial"))}</dd></div>
              <div><dt>Crédito autorizado</dt><dd>{formatMoney(summaryValue(bucket, "totalCreditoAutorizado", "creditoAutorizado"))}</dd></div>
              <div><dt>Intermediación</dt><dd>{count ? <>{formatPercent(bucket?.porcentajeIntermediacion)} <span>·</span> {formatMoney(summaryValue(bucket, "totalIntermediacion", "valorIntermediacion"))}</> : "—"}</dd></div>
            </dl>
            <div className={styles.productTotal}>
              <span>Valor por créditos</span>
              <strong>{formatMoney(summaryValue(bucket, "totalPagar", "valorPagar"))}</strong>
            </div>
          </Card>
        );
      })}
      <Card className={styles.netCard}>
        <div className={styles.netHeading}>
          <WalletCards size={26} aria-hidden="true" />
          <h2>TOTAL A CONSIGNAR</h2>
          <span className={styles.directionBadge}>{direction}</span>
        </div>
        <strong className={styles.netAmount}>{formatMoney(Math.abs(balance.saldoNeto))}</strong>
        <dl className={styles.netBreakdown}>
          <div><dt>Valor por créditos</dt><dd>{formatMoney(totalPagarCreditos)}</dd></div>
          <div><dt>Recaudos del aliado</dt><dd>− {formatMoney(totalRecaudosAliado)}</dd></div>
          <div className={styles.annulmentBreakdown}><dt>Créditos anulados</dt><dd>− {formatMoney(totalAjustesAnulacion)}</dd></div>
        </dl>
      </Card>
    </section>
  );
}

const PREVIEW_PAGE_SIZE = 10;

function normalizeDetailSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO").trim();
}

function SettlementCreditItems({
  items,
  intermediationEditor,
}: {
  items: PaymentCreditItem[];
  intermediationEditor: IntermediationEditor;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const filtered = useMemo(() => {
    const search = normalizeDetailSearch(query);
    if (!search) return items;
    const identifierSearch = search.replace(/[.\s]/g, "");
    return items.filter((item) =>
      normalizeDetailSearch(`${itemClient(item)} ${item.equipo || ""}`).includes(search) ||
      (identifierSearch.length > 0 && [item.clienteDocumento, item.imei].some((value) =>
        String(value || "").replace(/[.\s]/g, "").includes(identifierSearch)
      ))
    );
  }, [items, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * PREVIEW_PAGE_SIZE;
  const visible = filtered.slice(start, start + PREVIEW_PAGE_SIZE);
  const pageNumbers = Array.from({ length: pages }, (_, index) => index + 1)
    .filter((value) => value === 1 || value === pages || Math.abs(value - currentPage) <= 1);

  return (
    <Card className={styles.creditDetail}>
      <div className={styles.detailHeading}>
        <h2>Detalle por crédito</h2>
        <span className={styles.countBadge}>{formatNumber(filtered.length)} registros</span>
        <label className={styles.detailSearch}>
          <Search size={18} aria-hidden="true" />
          <Input
            aria-label="Buscar cliente, cédula, equipo o IMEI"
            placeholder="Buscar cliente, cédula, equipo o IMEI..."
            value={query}
            maxLength={100}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }}
          />
        </label>
      </div>
      <div className={styles.previewTableScroll} role="region" aria-label="Detalle por crédito, tabla desplazable" tabIndex={0}>
        <table className={styles.previewTable}>
          <caption className="sr-only">Créditos incluidos en la previsualización de liquidación</caption>
          <thead>
            <tr>
              <th>Fecha</th><th>Cliente / Cédula</th><th>Sede</th><th>Equipo / IMEI</th>
              <th className={styles.moneyColumn}>Valor venta<br />Inicial</th>
              <th className={styles.moneyColumn}>Crédito autorizado</th>
              <th className={styles.moneyColumn}><span className={styles.intermediationHeading}>Intermediación <PaymentInfo label="Cómo se calcula la intermediación">Se aplica sobre el crédito autorizado, con IVA incluido y el redondeo vigente. Puedes ajustar cada porcentaje antes de confirmar.</PaymentInfo></span></th>
              <th className={styles.moneyColumn}>Valor a pagar</th><th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item, index) => (
              <tr key={itemKey(item, start + index)}>
                <td className={styles.dateCell}>{formatDate(itemDate(item))}</td>
                <td className={styles.clientCell}><strong>{itemClient(item)}</strong><span>{item.clienteDocumento?.replace(/[.\s]/g, "") || "Sin documento"}</span></td>
                <td className={styles.siteCell}>{itemSite(item)}</td>
                <td><div className={styles.equipmentCell}><PlatformIcon platform={String(item.plataforma).toUpperCase() === "ANDROID" ? "ANDROID" : "IPHONE"} /><div><span>{item.equipo || "Sin referencia"}</span><small>IMEI: {item.imei?.replace(/[.\s]/g, "") || "Sin IMEI"}</small></div></div></td>
                <td className={styles.moneyColumn}><strong>{formatMoney(item.valorVenta)}</strong><span className={styles.secondaryAmount}>{formatMoney(item.cuotaInicial)}</span></td>
                <td className={styles.moneyColumn}>{formatMoney(item.creditoAutorizado)}</td>
                <td className={styles.moneyColumn}><IntermediationField compact editor={intermediationEditor} item={item} /><span className={styles.feeAmount}>{formatMoney(item.valorIntermediacion)}</span></td>
                <td className={`${styles.moneyColumn} ${styles.payableCell}`}>{formatMoney(item.valorPagar)}</td>
                <td className={styles.statusCell}><StatusPill tone={statusTone(itemStatus(item))}>{itemStatus(item)}</StatusPill></td>
              </tr>
            ))}
            {!visible.length && <tr><td colSpan={9} className={styles.emptyDetail}>{items.length ? "No hay créditos que coincidan con la búsqueda." : "No hay créditos en esta liquidación."}</td></tr>}
          </tbody>
        </table>
      </div>
      <div className={styles.detailFooter}>
        <p>Mostrando {filtered.length ? start + 1 : 0}–{Math.min(start + PREVIEW_PAGE_SIZE, filtered.length)} de {formatNumber(filtered.length)} créditos</p>
        <nav className={styles.pagination} aria-label="Páginas del detalle de créditos">
          <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} aria-hidden="true" /><span>Anterior</span></button>
          {pageNumbers.map((value, index) => (
            <span className={styles.pageItem} key={value}>
              {index > 0 && value - pageNumbers[index - 1] > 1 && <span className={styles.pageEllipsis}>…</span>}
              <button type="button" aria-label={`Página ${value}`} aria-current={value === currentPage ? "page" : undefined} onClick={() => setPage(value)}>{value}</button>
            </span>
          ))}
          <button type="button" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><span>Siguiente</span><ChevronRight size={16} aria-hidden="true" /></button>
        </nav>
      </div>
    </Card>
  );
}

function CollectionItems({
  items,
  emptyDescription,
}: {
  items: PaymentCollectionItem[];
  emptyDescription: string;
}) {
  if (!items.length) {
    return (
      <EmptyState
        className="mt-4"
        title="No hay recaudos del aliado en este periodo"
        description={emptyDescription}
      />
    );
  }

  return (
    <section className="mt-4" aria-label="Recaudos recibidos por el aliado">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black text-[var(--fp-graphite)]">Recaudos recibidos por el aliado</h2>
        <Badge tone="warning">{formatNumber(items.length)} recaudos</Badge>
      </div>
      <p className="mt-1 text-sm text-[var(--fp-muted)]">
        Estos valores fueron recibidos en sedes del aliado y se descuentan del pago de la liquidacion.
      </p>
      <DataTable className="mt-3">
        <table className="w-full min-w-[1040px] text-sm">
          <caption className="sr-only">Relacion de recaudos descontados en la liquidacion</caption>
          <thead className="bg-[var(--fp-graphite)] text-white">
            <tr>
              <th className="px-4 py-3 text-left">Fecha</th>
              <th className="px-4 py-3 text-left">Folio</th>
              <th className="px-4 py-3 text-left">Cliente</th>
              <th className="px-4 py-3 text-left">Cedula</th>
              <th className="px-4 py-3 text-left">Sede que recaudo</th>
              <th className="px-4 py-3 text-left">Metodo</th>
              <th className="px-4 py-3 text-right">Valor recaudado</th>
              <th className="px-4 py-3 text-left">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--fp-border)]">
            {items.map((item, index) => (
              <tr key={String(item.id ?? item.abonoId ?? index)} className="bg-white even:bg-[#fbfcfa]">
                <td className="whitespace-nowrap px-4 py-3">{formatDateTime(item.fechaAbono)}</td>
                <td className="px-4 py-3 font-bold">{creditDisplayNumber(item)}{item.numeroCreditoVisible && item.numeroCreditoVisible !== item.folio ? <span className="block text-xs font-normal text-slate-500">Folio original: {item.folio}</span> : null}</td>
                <td className="px-4 py-3 font-semibold">{item.clienteNombre || "-"}</td>
                <td className="whitespace-nowrap px-4 py-3 font-mono">{item.clienteDocumento?.replace(/[.\s]/g, "") || "-"}</td>
                <td className="px-4 py-3 font-semibold">{item.sedeNombre || "-"}</td>
                <td className="px-4 py-3">{item.metodoPago || "-"}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-black tabular-nums">{formatMoney(item.valor)}</td>
                <td className="px-4 py-3"><StatusPill tone={statusTone(item.estado)}>{item.estado || "PENDIENTE"}</StatusPill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </section>
  );
}

function AnnulmentAdjustmentItems({
  items,
  emptyDescription,
}: {
  items: PaymentAnnulmentAdjustmentItem[];
  emptyDescription: string;
}) {
  if (!items.length) {
    return (
      <EmptyState
        className={styles.annulmentEmpty}
        title="No hay créditos anulados por descontar"
        description={emptyDescription}
      />
    );
  }

  const total = items.reduce(
    (sum, item) => sum + Math.max(0, numberValue(item.valorDescuento)),
    0
  );
  const statusLabel = (value: string | null | undefined) => {
    const normalized = String(value || "PENDIENTE_DESCUENTO").trim().toUpperCase();
    return normalized === "PENDIENTE_DESCUENTO"
      ? "PENDIENTE DE DESCUENTO"
      : normalized.replaceAll("_", " ");
  };

  return (
    <section className={styles.annulmentAdjustments} aria-label="Descuentos por créditos anulados">
      <header className={styles.annulmentHeading}>
        <div>
          <span className={styles.annulmentIcon}><CircleMinus aria-hidden="true" /></span>
          <div>
            <h2>Descuentos por créditos anulados</h2>
            <p>Valores pagados anteriormente que se descuentan una sola vez en esta liquidación.</p>
          </div>
        </div>
        <Badge tone="danger">{formatNumber(items.length)} anulados</Badge>
        <strong className={styles.annulmentTotal}>− {formatMoney(total)}</strong>
      </header>
      <DataTable className={styles.annulmentTableWrap}>
        <table className={styles.annulmentTable}>
          <caption className="sr-only">Relación de créditos anulados descontados en la liquidación</caption>
          <thead>
            <tr>
              <th>Fecha anulación</th><th>Crédito</th><th>Cliente / Cédula</th>
              <th>Sede</th><th>Equipo / IMEI</th><th>Plataforma</th>
              <th>Liquidación original</th><th>Motivo</th>
              <th className={styles.moneyColumn}>Valor descontado</th><th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr className={styles.annulledRow} key={String(item.ajusteId ?? item.id ?? `${item.creditoId}-${index}`)}>
                <td className={styles.dateCell}>{formatDate(item.fechaAnulacion)}</td>
                <td className={styles.annulledCredit}>{creditDisplayNumber(item)}</td>
                <td className={styles.clientCell}><strong>{item.clienteNombre || "Cliente sin nombre"}</strong><span>{item.clienteDocumento?.replace(/[.\s]/g, "") || "Sin documento"}</span></td>
                <td className={styles.siteCell}>{item.sedeNombre || "Sede sin nombre"}</td>
                <td><div className={styles.equipmentCell}><PlatformIcon platform={String(item.plataforma).toUpperCase() === "ANDROID" ? "ANDROID" : "IPHONE"} /><div><span>{item.equipo || "Sin referencia"}</span><small>IMEI: {item.imei?.replace(/[.\s]/g, "") || "Sin IMEI"}</small></div></div></td>
                <td>{platformLabel(item.plataforma)}</td>
                <td className={styles.originSettlement}>{item.liquidacionOrigenId == null ? "—" : `LA-${item.liquidacionOrigenId}`}</td>
                <td className={styles.annulmentReason}>{item.motivo || "Anulación aprobada"}</td>
                <td className={`${styles.moneyColumn} ${styles.annulmentAmount}`}>− {formatMoney(item.valorDescuento)}</td>
                <td className={styles.statusCell}><StatusPill tone="danger">{statusLabel(item.estado)}</StatusPill></td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </section>
  );
}

function settlementPdfUrl(settlementId: Settlement["id"], download = false) {
  const base = `/api/pagos-aliados/${encodeURIComponent(String(settlementId))}/comprobante`;
  return download ? `${base}?download=1` : base;
}

function openSettlementPdf(settlementId: Settlement["id"]) {
  window.open(settlementPdfUrl(settlementId), "_blank", "noopener,noreferrer");
}

function downloadSettlementPdf(settlementId: Settlement["id"]) {
  const anchor = document.createElement("a");
  anchor.href = settlementPdfUrl(settlementId, true);
  anchor.download = "";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function PaymentViewFilters({ filters, onChange, onApply, onClear, allies, adminCentral, pending = false }: {
  filters: AllyPaymentViewFilters;
  onChange: (filters: AllyPaymentViewFilters) => void;
  onApply: () => void;
  onClear: () => void;
  allies: AllyOption[];
  adminCentral: boolean;
  pending?: boolean;
}) {
  return <form className={`${styles.filters} ${pending ? styles.pendingFilters : ""}`} onSubmit={event => { event.preventDefault(); onApply(); }} aria-label={pending ? "Filtros de pagos pendientes" : "Filtros de pagos recibidos"}>
    {pending && <h2 className={styles.filterTitle}>Movimientos pendientes de liquidar</h2>}
    <div className={styles.filterRow}>
      <div className={styles.search}>
        <Search aria-hidden="true" />
        <Input aria-label={pending ? "Buscar crédito, cliente, cédula o IMEI" : "Buscar aliado o aprobación"} placeholder={pending ? "Crédito, cliente, cédula o IMEI" : "Buscar aliado o aprobación"} value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} />
      </div>
      <Select aria-label="Filtrar por aliado" value={filters.allyId} onChange={event => onChange({ ...filters, allyId: event.target.value })}>
        <option value="">{adminCentral ? "Todos los aliados" : "Mi aliado"}</option>
        {allies.map(ally => <option key={ally.id} value={String(ally.id)}>{ally.nombre}</option>)}
      </Select>
      <div className={styles.period} role="group" aria-label="Período">
        <CalendarDays aria-hidden="true" />
        <input aria-label="Período desde" type="date" value={filters.start} onChange={event => onChange({ ...filters, start: event.target.value })} />
        <span aria-hidden="true">–</span>
        <input aria-label="Período hasta" type="date" value={filters.end} onChange={event => onChange({ ...filters, end: event.target.value })} />
      </div>
      <Button type="submit">Filtrar</Button>
      <Button type="button" variant="ghost" className={styles.clear} onClick={onClear}>Limpiar</Button>
    </div>
    <p className={styles.dateHint}>{pending
      ? "Fecha de elegibilidad del crédito para liquidación · Recaudos: fecha de abono · Hora de Colombia."
      : "Filtra por el período de la liquidación, según las fechas de Colombia."}</p>
  </form>;
}

function createMutationId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

type Notice = {
  tone: "error" | "success" | "neutral";
  text: string;
} | null;

export default function AllyPaymentsConsole({
  initialAdminCentral,
  initialAllyId,
}: {
  initialAdminCentral: boolean;
  initialAllyId: number | null;
}) {
  const [adminCentral, setAdminCentral] = useState(initialAdminCentral);
  const [accessAllyId, setAccessAllyId] = useState(initialAllyId);
  const [activeTab, setActiveTab] = useState<PaymentsTab>(
    initialAdminCentral ? "liquidar" : "recibidos"
  );
  const [allies, setAllies] = useState<AllyOption[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [pending, setPending] = useState<NonNullable<AllyPaymentsResponse["pending"]>>({
    items: [],
    summary: null,
    recaudos: [],
    ajustesAnulacion: [],
  });
  const [receivedDraft, setReceivedDraft] = useState(emptyAllyPaymentViewFilters);
  const [receivedFilters, setReceivedFilters] = useState(emptyAllyPaymentViewFilters);
  const [pendingDraft, setPendingDraft] = useState(emptyAllyPaymentViewFilters);
  const [pendingFilters, setPendingFilters] = useState(emptyAllyPaymentViewFilters);
  const [showPendingCollections, setShowPendingCollections] = useState(false);
  const [overviewError, setOverviewError] = useState(false);
  const detailSectionRef = useRef<HTMLElement>(null);
  const historyScrollRef = useRef(0);
  const historyTriggerRef = useRef<HTMLElement | null>(null);
  const collectionsSectionRef = useRef<HTMLElement>(null);
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [selectedAllyId, setSelectedAllyId] = useState(
    initialAdminCentral ? "" : initialAllyId ? String(initialAllyId) : ""
  );
  const [fechaInicio, setFechaInicio] = useState("");
  const [fechaFin, setFechaFin] = useState("");
  const [approvalNumber, setApprovalNumber] = useState("");
  const [intermediationValues, setIntermediationValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMutationId, setPendingMutationId] = useState<string | null>(null);
  const [selectedSettlement, setSelectedSettlement] = useState<Settlement | null>(null);
  const selectedSettlementId = selectedSettlement?.id;
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const selectedAlly = useMemo(
    () => allies.find((ally) => String(ally.id) === selectedAllyId) || null,
    [allies, selectedAllyId]
  );

  const basePreviewItems = useMemo(() => previewItems(preview), [preview]);
  const adjustmentState = useMemo(
    () => buildIntermediationAdjustmentState(basePreviewItems, intermediationValues),
    [basePreviewItems, intermediationValues]
  );
  const basePercentages = useMemo(
    () =>
      Object.fromEntries(
        basePreviewItems.flatMap((item) => {
          const creditId = itemCreditId(item);
          return creditId
            ? [[String(creditId), numberValue(item.porcentajeIntermediacion)] as const]
            : [];
        })
      ),
    [basePreviewItems]
  );
  const adjustedPreviewItems = useMemo(
    () => recalculatePreviewItems(basePreviewItems, adjustmentState.adjustments),
    [adjustmentState.adjustments, basePreviewItems]
  );
  const adjustedPreviewSummary = useMemo(
    () => (preview ? summarizePreviewItems(adjustedPreviewItems) : null),
    [adjustedPreviewItems, preview]
  );
  const previewCollections = useMemo(() => collectionItems(preview), [preview]);
  const previewCollectionsTotal = useMemo(
    () => previewCollections.reduce((total, item) => total + numberValue(item.valor), 0),
    [previewCollections]
  );
  const previewAnnulmentAdjustments = useMemo(
    () => annulmentAdjustmentItems(preview),
    [preview]
  );
  const previewAnnulmentTotal = useMemo(
    () => totalAnnulmentAdjustments(preview),
    [preview]
  );
  const updateIntermediation = useCallback((creditId: number, value: string) => {
    setIntermediationValues((current) => ({ ...current, [String(creditId)]: value }));
    setPendingMutationId(null);
    setNotice(null);
  }, []);
  const intermediationEditor = useMemo<IntermediationEditor>(
    () => ({
      disabled: submitting || confirmOpen,
      basePercentages,
      changedKeys: adjustmentState.changedKeys,
      errors: adjustmentState.errors,
      onChange: updateIntermediation,
      values: intermediationValues,
    }),
    [
      adjustmentState.changedKeys,
      adjustmentState.errors,
      basePercentages,
      intermediationValues,
      submitting,
      confirmOpen,
      updateIntermediation,
    ]
  );

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true);
      setOverviewError(false);
      setNotice(null);

      const response = await fetch("/api/pagos-aliados", { cache: "no-store" });
      const raw = (await response.json().catch(() => null)) as AllyPaymentsResponse | null;

      if (!response.ok) {
        throw new Error(responseMessage(raw, "No se pudo cargar la informacion de pagos"));
      }

      const payload = raw || {};
      if (typeof payload.access?.adminCentral === "boolean") {
        setAdminCentral(payload.access.adminCentral);
      }
      if (payload.access && "allyId" in payload.access) {
        setAccessAllyId(payload.access.allyId ?? null);
        if (!payload.access.adminCentral && payload.access.allyId) {
          setSelectedAllyId(String(payload.access.allyId));
        }
      }
      setAllies(Array.isArray(payload.allies) ? payload.allies : []);
      setSettlements(Array.isArray(payload.settlements) ? payload.settlements : []);
      setSelectedSettlement(current => current && payload.settlements?.some(item => String(item.id) === String(current.id)) ? current : null);
      setPending({
        items: Array.isArray(payload.pending?.items) ? payload.pending.items : [],
        summary: payload.pending?.summary || null,
        recaudos: Array.isArray(payload.pending?.recaudos) ? payload.pending.recaudos : [],
        ajustesAnulacion: Array.isArray(payload.pending?.ajustesAnulacion) ? payload.pending.ajustesAnulacion : [],
        numeroAjustesAnulacion: payload.pending?.numeroAjustesAnulacion ?? 0,
        totalAjustesAnulacion: payload.pending?.totalAjustesAnulacion ?? 0,
      });
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error cargando pagos a aliados",
      });
      setOverviewError(true);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    if (!adminCentral && activeTab === "liquidar") {
      setActiveTab("recibidos");
    }
  }, [activeTab, adminCentral]);

  useEffect(() => {
    if (activeTab !== "recibidos" || selectedSettlementId == null) return;
    const frame = requestAnimationFrame(() => {
      detailSectionRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [activeTab, selectedSettlementId]);

  const invalidatePreview = () => {
    setPreview(null);
    setPreviewRequested(false);
    setIntermediationValues({});
    setPendingMutationId(null);
    setApprovalNumber("");
    setNotice(null);
  };

  const validatePeriod = () => {
    if (!selectedAllyId) return "Selecciona el aliado que recibira el pago.";
    if (!fechaInicio || !fechaFin) return "Selecciona la fecha inicial y final del periodo.";
    if (
      fechaInicio < ALLY_PAYMENTS_AVAILABLE_FROM ||
      fechaFin < ALLY_PAYMENTS_AVAILABLE_FROM
    ) {
      return `La informacion de pagos esta disponible desde el ${ALLY_PAYMENTS_AVAILABLE_FROM_LABEL}.`;
    }
    if (fechaInicio > fechaFin) return "La fecha inicial no puede ser posterior a la fecha final.";
    return "";
  };

  const requestPreview = async () => {
    const validationMessage = validatePeriod();
    if (validationMessage) {
      setNotice({ tone: "error", text: validationMessage });
      return;
    }

    try {
      setPreviewLoading(true);
      setPreviewRequested(true);
      setPreview(null);
      setIntermediationValues({});
      setApprovalNumber("");
      setPendingMutationId(null);
      setNotice(null);

      const query = new URLSearchParams({
        aliadoId: selectedAllyId,
        fechaInicio,
        fechaFin,
      });
      const response = await fetch(`/api/pagos-aliados?${query.toString()}`, {
        cache: "no-store",
      });
      const raw = (await response.json().catch(() => null)) as AllyPaymentsResponse | null;

      if (!response.ok) {
        throw new Error(responseMessage(raw, "No se pudo generar la previsualizacion"));
      }

      setPreview(raw?.preview || null);
      if (!raw?.preview) {
        setNotice({
          tone: "neutral",
          text: "No hay créditos, recaudos ni anulaciones pendientes para el aliado y período seleccionados.",
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error generando la previsualizacion",
      });
    } finally {
      setPreviewLoading(false);
    }
  };

  const prepareConfirmation = () => {
    const validationMessage = validatePeriod();
    if (validationMessage) {
      setNotice({ tone: "error", text: validationMessage });
      return;
    }
    if (!preview) {
      setNotice({ tone: "error", text: "Genera una previsualizacion vigente antes de registrar." });
      return;
    }
    const adjustmentError = Object.values(adjustmentState.errors)[0];
    if (adjustmentError) {
      setNotice({
        tone: "error",
        text: `Corrige la intermediacion antes de registrar: ${adjustmentError}`,
      });
      return;
    }
    if (!approvalNumber.trim()) {
      setNotice({ tone: "error", text: "El numero de soporte bancario es obligatorio." });
      return;
    }

    setPendingMutationId((current) => current || createMutationId());
    setConfirmOpen(true);
    setNotice(null);
  };

  const submitSettlement = async () => {
    if (submittingRef.current) return;
    const previewToken = preview?.previewToken || preview?.token;
    if (!preview || !previewToken || !pendingMutationId) {
      setConfirmOpen(false);
      setNotice({
        tone: "error",
        text: "La previsualizacion no tiene un token vigente. Vuelve a previsualizar el periodo.",
      });
      return;
    }
    if (Object.keys(adjustmentState.errors).length > 0) {
      setConfirmOpen(false);
      setNotice({ tone: "error", text: "Corrige los porcentajes de intermediacion." });
      return;
    }

    submittingRef.current = true;
    try {
      setSubmitting(true);
      const response = await fetch("/api/pagos-aliados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mutationId: pendingMutationId,
          aliadoId: Number(selectedAllyId),
          fechaInicio,
          fechaFin,
          numeroAprobacionBancaria: approvalNumber.trim(),
          previewToken,
          ajustesIntermediacion: adjustmentState.adjustments,
        }),
      });
      const raw = (await response.json().catch(() => null)) as
        | (AllyPaymentsResponse & { settlement?: Settlement })
        | null;

      if (!response.ok) {
        throw new Error(responseMessage(raw, "No se pudo registrar el pago"));
      }

      setConfirmOpen(false);
      setPendingMutationId(null);
      setApprovalNumber("");
      setIntermediationValues({});
      setPreview(null);
      setPreviewRequested(false);
      setActiveTab("recibidos");
      if (raw?.settlement) setSelectedSettlement(raw.settlement);
      const refreshed = await loadOverview();
      setNotice({
        tone: refreshed ? "success" : "neutral",
        text: refreshed
          ? responseMessage(raw, "Liquidacion registrada correctamente.")
          : `${responseMessage(
              raw,
              "Liquidacion registrada correctamente."
            )} No fue posible actualizar el listado; vuelve a intentarlo.`,
      });
    } catch (error) {
      setConfirmOpen(false);
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error registrando el pago",
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const openSettlement = async (settlement: Settlement) => {
    historyScrollRef.current = window.scrollY;
    historyTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      setDetailLoadingId(String(settlement.id));
      setNotice(null);
      const response = await fetch(
        `/api/pagos-aliados/${encodeURIComponent(String(settlement.id))}`,
        { cache: "no-store" }
      );
      const raw = (await response.json().catch(() => null)) as
        | { settlement?: Settlement; error?: string; message?: string }
        | null;

      if (!response.ok || !raw?.settlement) {
        throw new Error(responseMessage(raw, "No se pudo abrir el detalle del periodo"));
      }

      setSelectedSettlement(raw.settlement);
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error cargando el detalle",
      });
    } finally {
      setDetailLoadingId(null);
    }
  };

  const previewGrossTotal = summaryValue(
    adjustedPreviewSummary?.total,
    "totalPagar",
    "valorPagar"
  );
  const previewBalance = calculateDisplayedSettlementBalance(
    previewGrossTotal,
    previewCollectionsTotal,
    previewAnnulmentTotal
  );
  const previewTotal = Math.abs(previewBalance.saldoNeto);
  const previewIsConsignment =
    previewBalance.direccionSaldo === "CONSIGNACION_ALIADO";
  const previewIsZero = previewBalance.direccionSaldo === "SALDO_CERO";
  const supportLabel = previewIsConsignment
    ? "Numero de consignacion del aliado"
    : previewIsZero
      ? "Numero de soporte bancario"
      : "Numero de aprobacion bancaria";
  const effectiveAllyName =
    selectedAlly?.nombre ||
    preview?.aliado?.nombre ||
    (accessAllyId ? allies.find((ally) => ally.id === accessAllyId)?.nombre : null) ||
    "tu aliado";
  const filteredSettlements = useMemo(() => filterReceivedAllyPayments(settlements, receivedFilters), [settlements, receivedFilters]);
  const filteredPendingItems = useMemo(() => filterPendingAllyCredits(pending.items || [], pendingFilters), [pending.items, pendingFilters]);
  const pendingCounts = useMemo(() => {
    const all = filterPendingAllyCredits(pending.items || [], { ...pendingFilters, platform: "ALL" });
    return { all: all.length, ANDROID: all.filter(item => item.plataforma?.toUpperCase() === "ANDROID").length, IPHONE: all.filter(item => item.plataforma?.toUpperCase() === "IPHONE").length };
  }, [pending.items, pendingFilters]);
  const filteredPendingSummary = useMemo(() => summarizePreviewItems(filteredPendingItems), [filteredPendingItems]);
  const filteredPendingCollections = useMemo(() => filterPendingAllyCollections(collectionItems(pending), pendingFilters), [pending, pendingFilters]);
  const filteredPendingAnnulments = useMemo(
    () => filterPendingAllyAnnulmentAdjustments(annulmentAdjustmentItems(pending), pendingFilters),
    [pending, pendingFilters]
  );
  const filteredPendingAnnulmentTotal = useMemo(
    () => filteredPendingAnnulments.reduce(
      (total, item) => total + Math.max(0, numberValue(item.valorDescuento)),
      0
    ),
    [filteredPendingAnnulments]
  );
  const applyViewFilters = (view: "recibidos" | "pendientes") => {
    const draft = view === "recibidos" ? receivedDraft : pendingDraft;
    if (draft.start && draft.end && draft.start > draft.end) {
      setNotice({ tone: "error", text: "La fecha desde no puede ser posterior a la fecha hasta." });
      return;
    }
    setNotice(null);
    if (view === "recibidos") { setReceivedFilters({ ...draft }); setSelectedSettlement(null); }
    else setPendingFilters({ ...draft });
  };
  const refreshBusy = loading || previewLoading || submitting || Boolean(detailLoadingId);
  const historicalDetailOpen = activeTab === "recibidos" && Boolean(selectedSettlement);
  const closeHistoricalDetail = () => {
    setSelectedSettlement(null);
    requestAnimationFrame(() => {
      window.scrollTo({ top: historyScrollRef.current, behavior: "instant" });
      historyTriggerRef.current?.focus({ preventScroll: true });
    });
  };

  return (
    <main className={`${styles.main} ${activeTab === "liquidar" ? styles.liquidateMain : ""} ${historicalDetailOpen ? styles.historyDetailMain : ""}`}>
      <div hidden={historicalDetailOpen}>
      <div className={styles.header}>
        <div>
          {activeTab !== "liquidar" && <div className={styles.eyebrow}>{adminCentral ? "Operación financiera" : "Consulta del aliado"}</div>}
          <h1>Pagos a aliados</h1>
          {activeTab !== "pendientes" && <p>{activeTab === "recibidos" ? "Consulta las liquidaciones registradas." : "Previsualización de liquidación"}</p>}
        </div>
        <Button variant="secondary" onClick={() => void loadOverview()} disabled={refreshBusy || confirmOpen}>
          <RefreshCw className={["h-4 w-4", loading ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
          Actualizar
        </Button>
      </div>

      <Tabs className={styles.tabs} aria-label="Secciones de pagos a aliados">
        {adminCentral ? (
          <button
            id="ally-payments-liquidate-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === "liquidar"}
            aria-controls="ally-payments-liquidate-panel"
            onClick={() => setActiveTab("liquidar")}
          >
            Liquidar
          </button>
        ) : null}
        <button
          id="ally-payments-received-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "recibidos"}
          aria-controls="ally-payments-received-panel"
          onClick={() => setActiveTab("recibidos")}
        >
          Pagos recibidos
        </button>
        <button
          id="ally-payments-pending-tab"
          type="button"
          role="tab"
          aria-selected={activeTab === "pendientes"}
          aria-controls="ally-payments-pending-panel"
          onClick={() => setActiveTab("pendientes")}
        >
          Pagos pendientes
        </button>
      </Tabs>

      {notice ? (
        <div
          className={[
            "mt-4 rounded-lg border px-4 py-3 text-sm font-semibold",
            notice.tone === "error"
              ? "border-[#f3b7b2] bg-[var(--fp-danger-soft)] text-[var(--fp-danger)]"
              : notice.tone === "success"
                ? "border-[#c9df91] bg-[var(--fp-lime-soft)] text-[#4f6f0c]"
                : "border-[var(--fp-border)] bg-white text-[#344054]",
          ].join(" ")}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      ) : null}

      {loading ? (
        <Card className="mt-4 !rounded-lg px-5 py-12">
          <LoadingState label="Cargando pagos y creditos pendientes..." />
        </Card>
      ) : null}

      {!loading && adminCentral && activeTab === "liquidar" ? (
        <div
          id="ally-payments-liquidate-panel"
          role="tabpanel"
          aria-labelledby="ally-payments-liquidate-tab"
        >
          <Card className={styles.previewFilters}>
            <div className={styles.previewFilterRow}>
              <label>
                <span className="mb-2 block text-sm font-bold text-[#344054]">Aliado</span>
                <Select
                  value={selectedAllyId}
                  onChange={(event) => {
                    setSelectedAllyId(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={previewLoading || submitting || confirmOpen}
                >
                  <option value="">Seleccionar aliado</option>
                  {allies.map((ally) => (
                    <option key={ally.id} value={ally.id}>
                      {ally.nombre}{ally.activo === false ? " (inactivo)" : ""}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                <span className="mb-2 flex items-center gap-2 text-sm font-bold text-[#344054]">Fecha inicial <PaymentInfo label="Fechas y movimientos incluidos">Fechas de Colombia. Incluye créditos elegibles por su fecha de liquidación y recaudos recibidos en sedes del aliado por su fecha de pago, sin conciliar. Información disponible desde el {ALLY_PAYMENTS_AVAILABLE_FROM_LABEL}.</PaymentInfo></span>
                <Input
                  type="date"
                  value={fechaInicio}
                  min={ALLY_PAYMENTS_AVAILABLE_FROM}
                  onChange={(event) => {
                    setFechaInicio(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={previewLoading || submitting || confirmOpen}
                />
              </label>
              <label>
                <span className="mb-2 block text-sm font-bold text-[#344054]">Fecha final</span>
                <Input
                  type="date"
                  value={fechaFin}
                  min={fechaInicio || ALLY_PAYMENTS_AVAILABLE_FROM}
                  onChange={(event) => {
                    setFechaFin(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={previewLoading || submitting || confirmOpen}
                />
              </label>
              <Button
                variant="primary"
                onClick={() => void requestPreview()}
                disabled={previewLoading || submitting || confirmOpen || !selectedAllyId || !fechaInicio || !fechaFin}
              >
                <Search className="h-5 w-5" aria-hidden="true" />
                {previewLoading ? "Previsualizando..." : "Previsualizar"}
              </Button>
            </div>
          </Card>

          {previewLoading ? (
            <Card className="mt-4 !rounded-lg px-5 py-12">
              <LoadingState label="Validando creditos elegibles y porcentajes historicos..." />
            </Card>
          ) : null}

          {!previewLoading && preview ? (
            <>
              <div className={styles.previewStatus} role="status">
                <CheckCircle2 size={26} aria-hidden="true" />
                <strong>Previsualización lista</strong>
                <span className={styles.previewPeriod}>{effectiveAllyName} · {formatDate(preview.periodoInicio || fechaInicio)} al {formatDate(preview.periodoFin || fechaFin)}</span>
                <div className={styles.previewStatusActions}>
                  <span className={styles.readyCount}>{formatNumber(adjustedPreviewSummary?.total?.numeroCreditos)} créditos</span>
                  {adjustmentState.adjustments.length > 0 ? (
                    <Badge tone="positive">
                      {formatNumber(adjustmentState.adjustments.length)} tasas modificadas
                    </Badge>
                  ) : null}
                  {previewAnnulmentAdjustments.length > 0 ? (
                    <Badge tone="danger">
                      {formatNumber(previewAnnulmentAdjustments.length)} créditos anulados
                    </Badge>
                  ) : null}
                  {Object.keys(intermediationValues).length > 0 ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setIntermediationValues({});
                        setPendingMutationId(null);
                        setNotice(null);
                      }}
                      disabled={submitting || confirmOpen}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      Restablecer porcentajes
                    </Button>
                  ) : null}
                </div>
              </div>

              <SettlementSummary summary={adjustedPreviewSummary}
                totalPagarCreditos={previewGrossTotal}
                totalRecaudosAliado={previewCollectionsTotal}
                totalAjustesAnulacion={previewAnnulmentTotal}
              />
              <SettlementCreditItems
                key={preview.previewToken || preview.token || "preview"}
                items={adjustedPreviewItems}
                intermediationEditor={intermediationEditor}
              />
              {previewAnnulmentAdjustments.length > 0 ? (
                <AnnulmentAdjustmentItems
                  items={previewAnnulmentAdjustments}
                  emptyDescription="No se encontraron créditos pagados y anulados pendientes de descuento dentro del período."
                />
              ) : null}
              <details className={styles.previewCollections}>
                <summary><WalletCards size={18} aria-hidden="true" />Recaudos del aliado <span className={styles.countBadge}>{formatNumber(previewCollections.length)}</span><span className={styles.collectionsTotal}>{formatMoney(previewCollectionsTotal)}</span><ChevronRight size={18} aria-hidden="true" /></summary>
                <CollectionItems items={previewCollections} emptyDescription="No se encontraron recaudos recibidos por sedes de este aliado dentro del período." />
              </details>

              {Object.keys(adjustmentState.errors).length > 0 ? (
                <p className="mt-3 text-sm font-semibold text-[var(--fp-danger)]" role="alert">
                  Corrige los porcentajes marcados antes de registrar el pago.
                </p>
              ) : null}

              <Card className={styles.registerCard}>
                <div className={styles.registerRow}>
                  <label>
                    <span className="mb-2 flex items-center gap-2 text-sm font-bold text-[var(--fp-graphite)]">
                      {supportLabel} <PaymentInfo label="Confirmación y soporte bancario">Obligatorio. Se guarda junto con el usuario, la fecha, los porcentajes e importes confirmados. FINSER PAY y el aliado consultarán los mismos valores guardados.</PaymentInfo>
                    </span>
                    <Input
                      value={approvalNumber}
                      onChange={(event) => {
                        setApprovalNumber(event.target.value);
                        setPendingMutationId(null);
                        setNotice(null);
                      }}
                      required
                      maxLength={120}
                      autoComplete="off"
                      placeholder={previewIsConsignment ? "Ingresa el numero de la consignacion recibida" : "Ingresa el numero entregado por el banco"}
                      disabled={submitting || confirmOpen}
                    />
                  </label>
                  <Button
                    className="w-full"
                    variant="primary"
                    onClick={prepareConfirmation}
                    disabled={
                      submitting || confirmOpen ||
                      !approvalNumber.trim() ||
                      Object.keys(adjustmentState.errors).length > 0 ||
                      !(preview.previewToken || preview.token)
                    }
                  >
                    <WalletCards className="h-4 w-4" aria-hidden="true" />
                    {previewIsConsignment
                      ? `Registrar consignacion por ${formatMoney(previewTotal)}`
                      : previewIsZero
                        ? "Registrar conciliacion en cero"
                        : `Registrar pago por ${formatMoney(previewTotal)}`}
                  </Button>
                </div>
                {!(preview.previewToken || preview.token) ? (
                  <p className="mt-3 text-sm font-semibold text-[var(--fp-danger)]" role="alert">
                    Esta previsualizacion no tiene token de confirmacion. Actualiza la consulta antes de continuar.
                  </p>
                ) : null}
              </Card>
            </>
          ) : null}

          {!previewLoading && previewRequested && !preview ? (
            <EmptyState
              className="mt-4"
               title="No hay movimientos para conciliar en este periodo"
               description="Amplía el período o selecciona otro aliado. Los créditos, recaudos y anulaciones posteriores permanecerán pendientes automáticamente."
            />
          ) : null}
        </div>
      ) : null}

      {!loading && !overviewError && activeTab === "recibidos" ? (
        <div
          id="ally-payments-received-panel"
          role="tabpanel"
          aria-labelledby="ally-payments-received-tab"
        >
          <PaymentViewFilters filters={receivedDraft} onChange={setReceivedDraft} allies={allies} adminCentral={adminCentral} onApply={() => applyViewFilters("recibidos")} onClear={() => { const empty = emptyAllyPaymentViewFilters(); setReceivedDraft(empty); setReceivedFilters(empty); setSelectedSettlement(null); setNotice(null); }} />
          <ReceivedPaymentsView
            settlements={filteredSettlements}
            detailLoadingId={detailLoadingId}
            onOpen={(settlement) => void openSettlement(settlement)}
          />


        </div>
      ) : null}

      {!loading && !overviewError && activeTab === "pendientes" ? (
        <div id="ally-payments-pending-panel" role="tabpanel" aria-labelledby="ally-payments-pending-tab">
          <PaymentViewFilters pending filters={pendingDraft} onChange={setPendingDraft} allies={allies} adminCentral={adminCentral} onApply={() => applyViewFilters("pendientes")} onClear={() => { const empty = emptyAllyPaymentViewFilters(); setPendingDraft(empty); setPendingFilters(empty); setNotice(null); }} />
          <PendingPaymentsView items={filteredPendingItems} summary={filteredPendingSummary} platform={pendingFilters.platform} platformCounts={pendingCounts}
            annulmentCount={filteredPendingAnnulments.length}
            annulmentTotal={filteredPendingAnnulmentTotal}
            onPlatformChange={platform => { const value = platform === "ANDROID" || platform === "IPHONE" ? platform : "ALL"; setPendingFilters(current => ({ ...current, platform: value })); setPendingDraft(current => ({ ...current, platform: value })); }}
            onReviewCollections={() => { setShowPendingCollections(true); requestAnimationFrame(() => collectionsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }} />
          <AnnulmentAdjustmentItems
            items={filteredPendingAnnulments}
            emptyDescription="No existen créditos anulados pendientes de descuento con los filtros aplicados."
          />
          {showPendingCollections && <section className={styles.collections} ref={collectionsSectionRef} aria-label="Recaudos pendientes de liquidar">
            <div className={styles.collectionHeader}>
              <div><h2>Recaudos pendientes de liquidar</h2><p>Se filtran por fecha de abono. Se descontarán al conciliar la liquidación.</p></div>
              <Button variant="ghost" onClick={() => setShowPendingCollections(false)}><X className="h-4 w-4" aria-hidden="true" /> Cerrar</Button>
            </div>
            <CollectionItems items={filteredPendingCollections} emptyDescription="No existen recaudos pendientes de liquidar con los filtros aplicados." />
          </section>}
        </div>
      ) : null}

      </div>
      {historicalDetailOpen && selectedSettlement && <section ref={detailSectionRef} aria-label="Detalle de liquidación guardada" tabIndex={-1}>
        <HistoricalSettlementDetail
          key={String(selectedSettlement.id)}
          settlement={selectedSettlement}
          summary={settlementSummary(selectedSettlement)}
          items={settlementItems(selectedSettlement)}
          collectionCount={collectionItems(selectedSettlement).length}
          collectionDetail={<CollectionItems items={collectionItems(selectedSettlement)} emptyDescription="Sin recaudos asociados" />}
          annulmentCount={annulmentAdjustmentItems(selectedSettlement).length}
          annulmentTotal={totalAnnulmentAdjustments(selectedSettlement)}
          annulmentDetail={<AnnulmentAdjustmentItems items={annulmentAdjustmentItems(selectedSettlement)} emptyDescription="Sin créditos anulados asociados" />}
          onPrint={() => openSettlementPdf(selectedSettlement.id)}
          onDownload={() => downloadSettlementPdf(selectedSettlement.id)}
          onClose={closeHistoricalDetail}
        />
      </section>}
      <ConfirmDialog
        open={confirmOpen}
        title={previewIsConsignment ? "Confirmar consignacion del aliado" : "Confirmar liquidacion"}
        description={`Se registrara ${previewIsConsignment ? "una consignacion de" : previewIsZero ? "una conciliacion en cero para" : "un pago a"} ${effectiveAllyName}${previewIsZero ? "" : ` por ${formatMoney(previewTotal)}`}, correspondiente al periodo ${formatDate(fechaInicio)} al ${formatDate(
          fechaFin
        )}. ${supportLabel}: ${approvalNumber.trim() || "-"}. Se conciliarán ${formatMoney(previewGrossTotal)} por créditos menos ${formatMoney(previewCollectionsTotal)} en recaudos y ${formatMoney(previewAnnulmentTotal)} por créditos anulados. ${
          adjustmentState.adjustments.length
            ? `${adjustmentState.adjustments.length} venta(s) con intermediacion ajustada.`
            : "Sin ajustes manuales de intermediacion."
        }`}
        confirmLabel="Confirmar y registrar"
        busy={submitting}
        onCancel={() => {
          if (!submittingRef.current) {
            setConfirmOpen(false);
            setPendingMutationId(null);
          }
        }}
        onConfirm={() => void submitSettlement()}
      />
    </main>
  );
}
