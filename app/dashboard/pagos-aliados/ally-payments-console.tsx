"use client";

import { creditDisplayNumber } from "@/lib/credit-display-number";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Download,
  Filter,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Smartphone,
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
  calculateAllySettlementBalance,
  summarizeAllyPayments,
  type AllyPaymentIntermediationAdjustment,
} from "@/lib/ally-payments-core";

import { PendingPaymentsView, ReceivedPaymentsView } from "./ally-payment-views";
import styles from "./ally-payments-console.module.css";
import {
  emptyAllyPaymentViewFilters, filterPendingAllyCollections, filterPendingAllyCredits,
  filterReceivedAllyPayments, type AllyPaymentViewFilters,
} from "@/lib/ally-payment-view-filters";

type PaymentsTab = "liquidar" | "recibidos" | "pendientes";

type AllyOption = {
  id: number;
  nombre: string;
  codigo?: string | null;
  activo?: boolean;
};

type PaymentCreditItem = {
  numeroCreditoVisible?: string | null;
  id?: number | string;
  creditoId?: number | string;
  fecha?: string | null;
  fechaCredito?: string | null;
  fechaLiquidacion?: string | null;
  folio?: string | null;
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
  estado?: string | null;
  estadoLiquidacion?: string | null;
  aliado?: AllyOption | null;
  sede?: {
    id?: number | null;
    nombre?: string | null;
  } | null;
};

type PaymentCollectionItem = {
  aliado?: AllyOption | null;
  plataforma?: string | null;
  imei?: string | null;
  numeroCreditoVisible?: string | null;
  id?: number | string;
  abonoId?: number | string;
  creditoId?: number | string;
  sedeId?: number | string;
  fechaAbono?: string | null;
  folio?: string | null;
  clienteNombre?: string | null;
  clienteDocumento?: string | null;
  sedeNombre?: string | null;
  metodoPago?: string | null;
  valor?: number | null;
  estado?: string | null;
};

type PaymentSummaryBucket = {
  plataforma?: string | null;
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
  numeroRecaudos?: number | null;
  porcentajeIntermediacion?: number | null;
  valorVenta?: number | null;
  creditoAutorizado?: number | null;
  cuotaInicial?: number | null;
  valorIntermediacion?: number | null;
  valorPagar?: number | null;
};

type PaymentSummary = {
  ANDROID?: PaymentSummaryBucket | null;
  IPHONE?: PaymentSummaryBucket | null;
  total?: PaymentSummaryBucket | null;
};

type Settlement = {
  id: number | string;
  aliadoId?: number | null;
  aliado?: AllyOption | null;
  aliadoNombre?: string | null;
  periodoInicio?: string | null;
  periodoFin?: string | null;
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
  numeroRecaudos?: number | null;
  numeroAprobacionBancaria?: string | null;
  pagadoAt?: string | null;
  createdAt?: string | null;
  registradoPorNombre?: string | null;
  estado?: string | null;
  summary?: PaymentSummary | null;
  resumen?: PaymentSummary | null;
  items?: PaymentCreditItem[] | null;
  creditos?: PaymentCreditItem[] | null;
  detalles?: PaymentCreditItem[] | null;
  recaudos?: PaymentCollectionItem[] | null;
};

type PaymentPreview = {
  previewToken?: string | null;
  token?: string | null;
  aliado?: AllyOption | null;
  periodoInicio?: string | null;
  periodoFin?: string | null;
  summary?: PaymentSummary | null;
  resumen?: PaymentSummary | null;
  items?: PaymentCreditItem[] | null;
  creditos?: PaymentCreditItem[] | null;
  recaudos?: PaymentCollectionItem[] | null;
  totalPagarCreditos?: number | null;
  totalRecaudosAliado?: number | null;
  saldoNeto?: number | null;
  direccionSaldo?: string | null;
  valorPagarAliado?: number | null;
  valorConsignarAliado?: number | null;
};

type AllyPaymentsResponse = {
  access?: {
    adminCentral?: boolean;
    allyId?: number | null;
  };
  allies?: AllyOption[];
  settlements?: Settlement[];
  pending?: {
    items?: PaymentCreditItem[];
    summary?: PaymentSummary | null;
    recaudos?: PaymentCollectionItem[];
    totalPagarCreditos?: number | null;
    totalRecaudosAliado?: number | null;
    saldoNeto?: number | null;
    direccionSaldo?: string | null;
  } | null;
  preview?: PaymentPreview | null;
  error?: string;
  message?: string;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  minimumFractionDigits: 0,
  maximumFractionDigits: 20,
  style: "currency",
});

const numberFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 2,
});

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: unknown) {
  return moneyFormatter.format(numberValue(value));
}

function formatNumber(value: unknown) {
  return numberFormatter.format(Math.round(numberValue(value)));
}

function formatPercent(value: unknown) {
  if (value === undefined || value === "") return "-";
  if (value === null) return "Mixto";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${percentFormatter.format(parsed)}%` : "-";
}

function formatDate(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);

  if (dateOnly) {
    return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }

  if (!normalized) return "-";
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return normalized;

  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Bogota",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return new Intl.DateTimeFormat("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  }).format(date);
}

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

function statusTone(status: string | null | undefined) {
  const normalized = String(status || "").toUpperCase();
  if (normalized.includes("ANUL") || normalized.includes("ERROR")) return "danger" as const;
  if (normalized.includes("PAG") || normalized.includes("LIQUID")) return "positive" as const;
  if (normalized.includes("PEND") || normalized.includes("PROCES")) return "warning" as const;
  return "neutral" as const;
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

function platformLabel(value: string | null | undefined) {
  const normalized = String(value || "").toUpperCase();
  if (normalized === "IPHONE" || normalized === "IOS") return "iPhone";
  if (normalized === "ANDROID") return "Android";
  return value || "Sin plataforma";
}

function SummaryGrid({
  summary,
  title,
}: {
  summary: PaymentSummary | null | undefined;
  title: string;
}) {
  const buckets = [
    { key: "ANDROID", label: "Android", value: summary?.ANDROID },
    { key: "IPHONE", label: "iPhone", value: summary?.IPHONE },
    { key: "total", label: "Total consolidado", value: summary?.total },
  ] as const;

  if (!summary) {
    return (
      <EmptyState
        className="mt-4"
        title="Sin resumen disponible"
        description="El servidor no entrego valores consolidados para esta consulta."
      />
    );
  }

  return (
    <section className="mt-4" aria-label={title}>
      <h2 className="text-lg font-black text-[var(--fp-graphite)]">{title}</h2>
      <div className="mt-3 grid gap-3 xl:grid-cols-3">
        {buckets.map((entry) => {
          const bucket = entry.value;
          const total = entry.key === "total";

          return (
            <Card
              key={entry.key}
              className={[
                "!rounded-lg !p-4",
                total ? "!border-[#b9d873] !bg-[#fbfdf5]" : "",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-3 border-b border-[var(--fp-border)] pb-3">
                <div className="flex items-center gap-2">
                  {entry.key === "total" ? (
                    <WalletCards className="h-4 w-4 text-[#5c7a13]" aria-hidden="true" />
                  ) : (
                    <Smartphone className="h-4 w-4 text-[#5c7a13]" aria-hidden="true" />
                  )}
                  <h3 className="font-black text-[var(--fp-graphite)]">{entry.label}</h3>
                </div>
                <Badge tone={total ? "positive" : "neutral"}>
                  {formatNumber(bucket?.numeroCreditos)} creditos
                </Badge>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Valor venta</dt>
                  <dd className="mt-1 font-bold tabular-nums text-[var(--fp-graphite)]">
                    {formatMoney(summaryValue(bucket, "totalValorVenta", "valorVenta"))}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Credito autorizado</dt>
                  <dd className="mt-1 font-bold tabular-nums text-[var(--fp-graphite)]">
                    {formatMoney(summaryValue(bucket, "totalCreditoAutorizado", "creditoAutorizado"))}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Inicial</dt>
                  <dd className="mt-1 font-bold tabular-nums text-[var(--fp-graphite)]">
                    {formatMoney(summaryValue(bucket, "totalCuotaInicial", "cuotaInicial"))}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">% intermediacion</dt>
                  <dd className="mt-1 font-bold text-[var(--fp-graphite)]">
                    {formatPercent(bucket?.porcentajeIntermediacion)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Intermediacion</dt>
                  <dd className="mt-1 font-bold tabular-nums text-[var(--fp-graphite)]">
                    {formatMoney(summaryValue(bucket, "totalIntermediacion", "valorIntermediacion"))}
                  </dd>
                </div>
              </dl>
              <div className="mt-4 flex items-end justify-between gap-3 border-t border-[var(--fp-border)] pt-3">
                <span className="text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Valor a pagar
                </span>
                <strong className="text-xl tabular-nums text-[var(--fp-graphite)]">
                  {formatMoney(summaryValue(bucket, "totalPagar", "valorPagar"))}
                </strong>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

type IntermediationEditor = {
  basePercentages: Record<string, number>;
  changedKeys: ReadonlySet<string>;
  errors: Record<string, string>;
  onChange: (creditId: number, value: string) => void;
  values: Record<string, string>;
};

function IntermediationField({
  editor,
  item,
}: {
  editor: IntermediationEditor | null;
  item: PaymentCreditItem;
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
    <div className="flex min-w-28 flex-col items-end gap-1">
      <div className="relative w-28">
        <Input
          className={[
            "!h-10 !pr-8 text-right tabular-nums",
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
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-[var(--fp-muted)]">
          %
        </span>
      </div>
      {changed ? (
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

function CreditItems({
  alwaysTable = false,
  emptyDescription,
  intermediationEditor = null,
  items,
}: {
  emptyDescription: string;
  alwaysTable?: boolean;
  intermediationEditor?: IntermediationEditor | null;
  items: PaymentCreditItem[];
}) {
  if (!items.length) {
    return (
      <EmptyState
        className="mt-4"
        title="No hay creditos para mostrar"
        description={emptyDescription}
      />
    );
  }

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black text-[var(--fp-graphite)]">Detalle por credito</h2>
        <Badge tone="neutral">{formatNumber(items.length)} registros</Badge>
      </div>

      <div className={alwaysTable ? "hidden" : "mt-3 divide-y divide-[var(--fp-border)] overflow-hidden rounded-lg border border-[var(--fp-border)] bg-white lg:hidden"}>
        {items.map((item, index) => (
          <article key={itemKey(item, index)} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Fecha
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-bold text-[var(--fp-graphite)]">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatDate(itemDate(item))}
                </p>
              </div>
              <StatusPill tone={statusTone(itemStatus(item))}>{itemStatus(item)}</StatusPill>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Aliado
                </p>
                <p className="mt-1 font-bold text-[var(--fp-graphite)]">
                  {item.aliado?.nombre || "-"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Sede
                </p>
                <p className="mt-1 font-bold text-[var(--fp-graphite)]">{itemSite(item)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Cliente
                </p>
                <p className="mt-1 font-bold text-[var(--fp-graphite)]">{itemClient(item)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Cédula
                </p>
                <p className="mt-1 font-mono text-sm font-semibold text-[#344054]">
                  {item.clienteDocumento?.replace(/[.\s]/g, "") || "Sin documento"}
                </p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Equipo
                </p>
                <p className="mt-1 text-sm font-semibold text-[#344054]">
                  {item.equipo || "Sin referencia"}
                </p>
                <p className="mt-1 break-all font-mono text-xs text-[var(--fp-muted)]">
                  IMEI: {item.imei?.replace(/[.\s]/g, "") || "Sin IMEI"}
                </p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-md bg-[#f7f8f8] p-3 text-sm">
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Plataforma</p>
                <p className="mt-1 font-bold">{platformLabel(item.plataforma)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Valor venta</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.valorVenta)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Inicial</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.cuotaInicial)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Crédito autorizado</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.creditoAutorizado)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Intermediación</p>
                <div className="mt-1 font-bold tabular-nums">
                  <IntermediationField editor={intermediationEditor} item={item} />
                </div>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Valor intermediación</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.valorIntermediacion)}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs font-bold uppercase text-[var(--fp-muted)]">Valor a pagar</span>
              <strong className="tabular-nums text-[var(--fp-graphite)]">{formatMoney(item.valorPagar)}</strong>
            </div>
          </article>
        ))}
      </div>

      <DataTable className={alwaysTable ? "mt-3" : "mt-3 hidden lg:block"}>
        <table className="w-full min-w-[1760px] text-[13px]">
          <caption className="sr-only">Detalle de creditos incluidos en el pago a aliados</caption>
          <thead className="bg-[var(--fp-graphite)] text-white">
            <tr>
              <th className="px-3 py-3 text-left">Fecha</th>
              <th className="px-3 py-3 text-left">Aliado</th>
              <th className="px-3 py-3 text-left">Sede</th>
              <th className="px-3 py-3 text-left">Cliente</th>
              <th className="px-3 py-3 text-left">Cédula</th>
              <th className="px-3 py-3 text-left">Equipo</th>
              <th className="px-3 py-3 text-left">Plataforma</th>
              <th className="px-3 py-3 text-right">Valor venta</th>
              <th className="px-3 py-3 text-right">Inicial</th>
              <th className="px-3 py-3 text-right">Crédito autorizado</th>
              <th className="px-3 py-3 text-right">Intermediación</th>
              <th className="px-3 py-3 text-right">Valor intermediación</th>
              <th className="px-3 py-3 text-right">Valor a pagar</th>
              <th className="px-3 py-3 text-left">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--fp-border)]">
            {items.map((item, index) => (
              <tr key={itemKey(item, index)} className="bg-white even:bg-[#fbfcfa]">
                <td className="whitespace-nowrap px-3 py-3">{formatDate(itemDate(item))}</td>
                <td className="max-w-44 break-words px-3 py-3">{item.aliado?.nombre || "-"}</td>
                <td className="max-w-44 break-words px-3 py-3 font-semibold">{itemSite(item)}</td>
                <td className="px-3 py-3 font-semibold">{itemClient(item)}</td>
                <td className="whitespace-nowrap px-3 py-3 font-mono">{item.clienteDocumento?.replace(/[.\s]/g, "") || "-"}</td>
                <td className="max-w-60 break-words px-3 py-3">
                  <p>{item.equipo || "-"}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--fp-muted)]">
                    IMEI: {item.imei?.replace(/[.\s]/g, "") || "-"}
                  </p>
                </td>
                <td className="px-3 py-3">
                  <Badge tone="neutral">{platformLabel(item.plataforma)}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.valorVenta)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.cuotaInicial)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.creditoAutorizado)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right">
                  <div className="flex justify-end">
                    <IntermediationField editor={intermediationEditor} item={item} />
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.valorIntermediacion)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right font-black tabular-nums">
                  {formatMoney(item.valorPagar)}
                </td>
                <td className="px-3 py-3">
                  <StatusPill tone={statusTone(itemStatus(item))}>{itemStatus(item)}</StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataTable>
    </section>
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

function ReconciliationCard({
  totalPagarCreditos,
  totalRecaudosAliado,
  storedSettlement,
}: {
  totalPagarCreditos: number;
  totalRecaudosAliado: number;
  storedSettlement?: Settlement;
}) {
  const savedNet = storedSettlement?.saldoNeto ?? storedSettlement?.totalPagar;
  const balance = savedNet != null ? {
    totalPagarCreditos,
    totalRecaudosAliado,
    saldoNeto: savedNet,
    direccionSaldo: storedSettlement?.direccionSaldo || (savedNet < 0 ? "CONSIGNACION_ALIADO" : savedNet > 0 ? "PAGO_ALIADO" : "SALDO_CERO"),
  } : calculateAllySettlementBalance(totalPagarCreditos, totalRecaudosAliado);
  const consignacion = balance.direccionSaldo === "CONSIGNACION_ALIADO";
  const cero = balance.direccionSaldo === "SALDO_CERO";
  return (
    <Card className="mt-4 !rounded-lg !border-[#b9d873] !bg-[#fbfdf5] !p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#5c7a13]">Conciliacion del periodo</p>
          <dl className="mt-3 grid gap-4 sm:grid-cols-2">
            <div><dt className="text-xs text-[var(--fp-muted)]">Valor por creditos</dt><dd className="mt-1 font-black tabular-nums">{formatMoney(balance.totalPagarCreditos)}</dd></div>
            <div><dt className="text-xs text-[var(--fp-muted)]">Menos recaudos del aliado</dt><dd className="mt-1 font-black tabular-nums">- {formatMoney(balance.totalRecaudosAliado)}</dd></div>
          </dl>
        </div>
        <div className="rounded-lg bg-white px-5 py-4 text-right shadow-sm">
          <p className="flex items-center justify-end gap-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
            <WalletCards className="h-4 w-4" />
            {cero ? "Saldo conciliado" : consignacion ? "El aliado debe consignar" : "FINSER PAY paga al aliado"}
          </p>
          <strong className="mt-1 block text-2xl tabular-nums text-[var(--fp-graphite)]">
            {formatMoney(Math.abs(balance.saldoNeto))}
          </strong>
        </div>
      </div>
    </Card>
  );
}

function settlementAllyName(settlement: Settlement) {
  return settlement.aliado?.nombre || settlement.aliadoNombre || "Aliado";
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
        <Input aria-label={pending ? "Buscar cliente, cédula o IMEI" : "Buscar aliado o aprobación"} placeholder={pending ? "Cliente, cédula o IMEI" : "Buscar aliado o aprobación"} value={filters.search} onChange={event => onChange({ ...filters, search: event.target.value })} />
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
  });
  const [receivedDraft, setReceivedDraft] = useState(emptyAllyPaymentViewFilters);
  const [receivedFilters, setReceivedFilters] = useState(emptyAllyPaymentViewFilters);
  const [pendingDraft, setPendingDraft] = useState(emptyAllyPaymentViewFilters);
  const [pendingFilters, setPendingFilters] = useState(emptyAllyPaymentViewFilters);
  const [showPendingCollections, setShowPendingCollections] = useState(false);
  const [overviewError, setOverviewError] = useState(false);
  const detailSectionRef = useRef<HTMLElement>(null);
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingMutationId, setPendingMutationId] = useState<string | null>(null);
  const [selectedSettlement, setSelectedSettlement] = useState<Settlement | null>(null);
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
  const updateIntermediation = useCallback((creditId: number, value: string) => {
    setIntermediationValues((current) => ({ ...current, [String(creditId)]: value }));
    setPendingMutationId(null);
    setNotice(null);
  }, []);
  const intermediationEditor = useMemo<IntermediationEditor>(
    () => ({
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
          text: "No hay creditos elegibles sin liquidar para el aliado y periodo seleccionados.",
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
      setSubmitting(false);
    }
  };

  const openSettlement = async (settlement: Settlement) => {
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
      requestAnimationFrame(() => detailSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
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
  const previewBalance = calculateAllySettlementBalance(
    previewGrossTotal,
    previewCollectionsTotal
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

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>{adminCentral ? "Operación financiera" : "Consulta del aliado"}</div>
          <h1>Pagos a aliados</h1>
          {activeTab !== "pendientes" && <p>{activeTab === "recibidos" ? "Consulta las liquidaciones registradas." : "Consulta y prepara las liquidaciones."}</p>}
        </div>
        <Button variant="secondary" onClick={() => void loadOverview()} disabled={refreshBusy}>
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
          <Card className="mt-4 !rounded-lg !p-4">
            <div className="grid gap-4 lg:grid-cols-[minmax(220px,1.2fr)_minmax(170px,.8fr)_minmax(170px,.8fr)_auto] lg:items-end">
              <label>
                <span className="mb-2 block text-sm font-bold text-[#344054]">Aliado</span>
                <Select
                  value={selectedAllyId}
                  onChange={(event) => {
                    setSelectedAllyId(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={previewLoading || submitting}
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
                <span className="mb-2 block text-sm font-bold text-[#344054]">Fecha inicial</span>
                <Input
                  type="date"
                  value={fechaInicio}
                  min={ALLY_PAYMENTS_AVAILABLE_FROM}
                  onChange={(event) => {
                    setFechaInicio(event.target.value);
                    invalidatePreview();
                  }}
                  disabled={previewLoading || submitting}
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
                  disabled={previewLoading || submitting}
                />
              </label>
              <Button
                variant="primary"
                onClick={() => void requestPreview()}
                disabled={previewLoading || submitting || !selectedAllyId || !fechaInicio || !fechaFin}
              >
                <Filter className="h-4 w-4" aria-hidden="true" />
                {previewLoading ? "Previsualizando..." : "Previsualizar"}
              </Button>
            </div>
            <p className="mt-3 text-xs leading-5 text-[var(--fp-muted)]">
              La informacion esta disponible desde el {ALLY_PAYMENTS_AVAILABLE_FROM_LABEL}. El periodo usa fechas de Colombia y muestra creditos elegibles y recaudos recibidos en sedes del aliado que no hayan sido conciliados antes.
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--fp-muted)]">
              Valor por creditos = credito autorizado - intermediacion. Saldo neto = valor por creditos - recaudos del aliado. Si el resultado es negativo, el aliado debe consignar la diferencia.
            </p>
            <p className="mt-1 text-xs font-semibold leading-5 text-[#5c7a13]">
              En la previsualización puedes ajustar el porcentaje de cada venta; la fila y el total se recalculan antes de confirmar. Al registrar el pago, Finser y el aliado consultarán exactamente los mismos valores guardados.
            </p>
          </Card>

          {previewLoading ? (
            <Card className="mt-4 !rounded-lg px-5 py-12">
              <LoadingState label="Validando creditos elegibles y porcentajes historicos..." />
            </Card>
          ) : null}

          {!previewLoading && preview ? (
            <>
              <Card className="mt-4 flex flex-col gap-3 !rounded-lg !p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--fp-lime-soft)] text-[#5c7a13]">
                    <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h2 className="font-black text-[var(--fp-graphite)]">Previsualizacion lista</h2>
                    <p className="mt-1 text-sm text-[var(--fp-muted)]">
                      {effectiveAllyName} · {formatDate(preview.periodoInicio || fechaInicio)} al{" "}
                      {formatDate(preview.periodoFin || fechaFin)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <StatusPill tone="positive">
                    {formatNumber(adjustedPreviewSummary?.total?.numeroCreditos)} creditos elegibles
                  </StatusPill>
                  {adjustmentState.adjustments.length > 0 ? (
                    <Badge tone="positive">
                      {formatNumber(adjustmentState.adjustments.length)} ajustes
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
                      disabled={submitting}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      Restablecer porcentajes
                    </Button>
                  ) : null}
                </div>
              </Card>

              <SummaryGrid summary={adjustedPreviewSummary} title="Resumen de la liquidacion" />
              <ReconciliationCard
                totalPagarCreditos={previewGrossTotal}
                totalRecaudosAliado={previewCollectionsTotal}
              />
              <CreditItems
                items={adjustedPreviewItems}
                intermediationEditor={intermediationEditor}
                emptyDescription="La previsualizacion no contiene detalle de creditos."
              />
              <CollectionItems
                items={previewCollections}
                emptyDescription="No se encontraron recaudos recibidos por sedes de este aliado dentro del periodo."
              />

              {Object.keys(adjustmentState.errors).length > 0 ? (
                <p className="mt-3 text-sm font-semibold text-[var(--fp-danger)]" role="alert">
                  Corrige los porcentajes marcados antes de registrar el pago.
                </p>
              ) : null}

              <Card className="mt-4 !rounded-lg !p-5">
                <div className="grid gap-4 lg:grid-cols-[minmax(280px,1fr)_minmax(260px,.8fr)] lg:items-end">
                  <label>
                    <span className="mb-2 block text-sm font-black text-[var(--fp-graphite)]">
                      {supportLabel}
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
                      disabled={submitting}
                    />
                    <span className="mt-2 block text-xs text-[var(--fp-muted)]">
                      Obligatorio. Se guardara junto con el usuario y la fecha del registro.
                    </span>
                  </label>
                  <Button
                    className="w-full"
                    variant="primary"
                    onClick={prepareConfirmation}
                    disabled={
                      submitting ||
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
               description="Amplia el periodo o selecciona otro aliado. Los creditos y recaudos posteriores permaneceran pendientes automaticamente."
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

          {selectedSettlement ? (
            <section ref={detailSectionRef} className="mt-5 scroll-mt-6" aria-label="Detalle del periodo pagado">
              <Card className="!rounded-lg !p-4 sm:!p-5">
                <div className="flex items-start justify-between gap-4 border-b border-[var(--fp-border)] pb-4">
                <div>
                  <p className="text-[11px] font-black uppercase tracking-[0.12em] text-[#5c7a13]">
                    Detalle del periodo
                  </p>
                  <h2 className="mt-1 text-xl font-black text-[var(--fp-graphite)]">
                    {settlementAllyName(selectedSettlement)}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--fp-muted)]">
                    {formatDate(selectedSettlement.periodoInicio)} al{" "}
                    {formatDate(selectedSettlement.periodoFin)}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => openSettlementPdf(selectedSettlement.id)}
                  >
                    <Printer className="h-4 w-4" aria-hidden="true" />
                    Ver / imprimir PDF
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => downloadSettlementPdf(selectedSettlement.id)}
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Descargar PDF
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setSelectedSettlement(null)}
                    aria-label="Cerrar detalle del periodo"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    Cerrar
                  </Button>
                </div>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-md bg-[#f7f8f8] p-3">
                  <p className="text-xs text-[var(--fp-muted)]">Aprobacion bancaria</p>
                  <p className="mt-1 break-all font-black">{selectedSettlement.numeroAprobacionBancaria || "-"}</p>
                </div>
                <div className="rounded-md bg-[#f7f8f8] p-3">
                  <p className="text-xs text-[var(--fp-muted)]">Fecha de pago</p>
                  <p className="mt-1 font-black">{formatDateTime(selectedSettlement.pagadoAt || selectedSettlement.createdAt)}</p>
                </div>
                <div className="rounded-md bg-[#f7f8f8] p-3">
                  <p className="text-xs text-[var(--fp-muted)]">Registrado por</p>
                  <p className="mt-1 font-black">{selectedSettlement.registradoPorNombre || "-"}</p>
                </div>
                <div className="rounded-md bg-[#f7f8f8] p-3">
                  <p className="text-xs text-[var(--fp-muted)]">Estado</p>
                  <StatusPill className="mt-1" tone={statusTone(selectedSettlement.estado || "PAGADO")}>
                    {selectedSettlement.estado || "PAGADO"}
                  </StatusPill>
                </div>
                </div>
              </Card>

              <SummaryGrid summary={settlementSummary(selectedSettlement)} title="Android, iPhone y total" />
              <ReconciliationCard
                totalPagarCreditos={numberValue(selectedSettlement.totalPagarCreditos ?? selectedSettlement.totalPagar)}
                totalRecaudosAliado={numberValue(selectedSettlement.totalRecaudosAliado)}
                storedSettlement={selectedSettlement}
              />
              <CreditItems
                items={settlementItems(selectedSettlement)}
                alwaysTable
                emptyDescription="El servidor no entrego el detalle de creditos de este periodo."
              />
              <CollectionItems
                items={collectionItems(selectedSettlement)}
                emptyDescription="Esta liquidacion historica no tiene recaudos del aliado asociados."
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {!loading && !overviewError && activeTab === "pendientes" ? (
        <div id="ally-payments-pending-panel" role="tabpanel" aria-labelledby="ally-payments-pending-tab">
          <PaymentViewFilters pending filters={pendingDraft} onChange={setPendingDraft} allies={allies} adminCentral={adminCentral} onApply={() => applyViewFilters("pendientes")} onClear={() => { const empty = emptyAllyPaymentViewFilters(); setPendingDraft(empty); setPendingFilters(empty); setNotice(null); }} />
          <PendingPaymentsView items={filteredPendingItems} summary={filteredPendingSummary} platform={pendingFilters.platform} platformCounts={pendingCounts}
            onPlatformChange={platform => { const value = platform === "ANDROID" || platform === "IPHONE" ? platform : "ALL"; setPendingFilters(current => ({ ...current, platform: value })); setPendingDraft(current => ({ ...current, platform: value })); }}
            onReviewCollections={() => { setShowPendingCollections(true); requestAnimationFrame(() => collectionsSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })); }} />
          {showPendingCollections && <section className={styles.collections} ref={collectionsSectionRef} aria-label="Recaudos pendientes de liquidar">
            <div className={styles.collectionHeader}>
              <div><h2>Recaudos pendientes de liquidar</h2><p>Se filtran por fecha de abono. Se descontarán al conciliar la liquidación.</p></div>
              <Button variant="ghost" onClick={() => setShowPendingCollections(false)}><X className="h-4 w-4" aria-hidden="true" /> Cerrar</Button>
            </div>
            <CollectionItems items={filteredPendingCollections} emptyDescription="No existen recaudos pendientes de liquidar con los filtros aplicados." />
          </section>}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={previewIsConsignment ? "Confirmar consignacion del aliado" : "Confirmar liquidacion"}
        description={`Se registrara ${previewIsConsignment ? "una consignacion de" : previewIsZero ? "una conciliacion en cero para" : "un pago a"} ${effectiveAllyName}${previewIsZero ? "" : ` por ${formatMoney(previewTotal)}`}, correspondiente al periodo ${formatDate(fechaInicio)} al ${formatDate(
          fechaFin
        )}. ${supportLabel}: ${approvalNumber.trim() || "-"}. Se conciliaron ${formatMoney(previewGrossTotal)} por creditos menos ${formatMoney(previewCollectionsTotal)} en recaudos. ${
          adjustmentState.adjustments.length
            ? `${adjustmentState.adjustments.length} venta(s) con intermediacion ajustada.`
            : "Sin ajustes manuales de intermediacion."
        }`}
        confirmLabel="Confirmar y registrar"
        busy={submitting}
        onCancel={() => {
          if (!submitting) {
            setConfirmOpen(false);
            setPendingMutationId(null);
          }
        }}
        onConfirm={() => void submitSettlement()}
      />
    </main>
  );
}
