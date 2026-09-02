"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  Download,
  Eye,
  Filter,
  Printer,
  RefreshCw,
  RotateCcw,
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
  PageHeader,
  Select,
  StatusPill,
  Tabs,
} from "@/app/_components/finser-ui";
import {
  ALLY_PAYMENTS_AVAILABLE_FROM,
  ALLY_PAYMENTS_AVAILABLE_FROM_LABEL,
  calculateAllyPaymentAmounts,
  summarizeAllyPayments,
  type AllyPaymentIntermediationAdjustment,
} from "@/lib/ally-payments-core";

type PaymentsTab = "liquidar" | "recibidos" | "pendientes";

type AllyOption = {
  id: number;
  nombre: string;
  codigo?: string | null;
  activo?: boolean;
};

type PaymentCreditItem = {
  id?: number | string;
  creditoId?: number | string;
  fecha?: string | null;
  fechaCredito?: string | null;
  folio?: string | null;
  cliente?: string | null;
  clienteNombre?: string | null;
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
};

type PaymentSummaryBucket = {
  plataforma?: string | null;
  numeroCreditos?: number | null;
  totalValorVenta?: number | null;
  totalCreditoAutorizado?: number | null;
  totalCuotaInicial?: number | null;
  totalIntermediacion?: number | null;
  totalPagar?: number | null;
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
  } | null;
  preview?: PaymentPreview | null;
  error?: string;
  message?: string;
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  currency: "COP",
  maximumFractionDigits: 0,
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
  return moneyFormatter.format(Math.round(numberValue(value)));
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
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(normalized);

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

function itemStatus(item: PaymentCreditItem) {
  return item.estadoLiquidacion || item.estado || "PENDIENTE";
}

function itemKey(item: PaymentCreditItem, index: number) {
  return String(item.creditoId ?? item.id ?? item.folio ?? index);
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
          aria-label={`Porcentaje de intermediacion del credito ${item.folio || creditId}`}
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
  emptyDescription,
  intermediationEditor = null,
  items,
}: {
  emptyDescription: string;
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

      <div className="mt-3 divide-y divide-[var(--fp-border)] overflow-hidden rounded-lg border border-[var(--fp-border)] bg-white lg:hidden">
        {items.map((item, index) => (
          <article key={itemKey(item, index)} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-all text-sm font-black text-[var(--fp-graphite)]">
                  {item.folio || "Sin folio"}
                </p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--fp-muted)]">
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatDate(itemDate(item))}
                </p>
              </div>
              <StatusPill tone={statusTone(itemStatus(item))}>{itemStatus(item)}</StatusPill>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Cliente
                </p>
                <p className="mt-1 font-bold text-[var(--fp-graphite)]">{itemClient(item)}</p>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                  Equipo
                </p>
                <p className="mt-1 text-sm font-semibold text-[#344054]">
                  {item.equipo || "Sin referencia"}
                </p>
              </div>
              {item.aliado?.nombre ? (
                <div className="sm:col-span-2">
                  <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--fp-muted)]">
                    Aliado
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#344054]">{item.aliado.nombre}</p>
                </div>
              ) : null}
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
                <p className="text-xs text-[var(--fp-muted)]">Credito autorizado</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.creditoAutorizado)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Inicial</p>
                <p className="mt-1 font-bold tabular-nums">{formatMoney(item.cuotaInicial)}</p>
              </div>
              <div>
                <p className="text-xs text-[var(--fp-muted)]">Intermediacion</p>
                <div className="mt-1 font-bold tabular-nums">
                  <IntermediationField editor={intermediationEditor} item={item} />
                  <p className="mt-1 text-xs text-[var(--fp-muted)]">
                    {formatMoney(item.valorIntermediacion)}
                  </p>
                </div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-xs font-bold uppercase text-[var(--fp-muted)]">Valor a pagar</span>
              <strong className="tabular-nums text-[var(--fp-graphite)]">{formatMoney(item.valorPagar)}</strong>
            </div>
          </article>
        ))}
      </div>

      <DataTable className="mt-3 hidden lg:block">
        <table className="w-full min-w-[1540px] text-[13px]">
          <caption className="sr-only">Detalle de creditos incluidos en el pago a aliados</caption>
          <thead className="bg-[var(--fp-graphite)] text-white">
            <tr>
              <th className="px-3 py-3 text-left">Fecha</th>
              <th className="px-3 py-3 text-left">Folio</th>
              <th className="px-3 py-3 text-left">Cliente</th>
              <th className="px-3 py-3 text-left">Equipo</th>
              <th className="px-3 py-3 text-left">Aliado</th>
              <th className="px-3 py-3 text-left">Plataforma</th>
              <th className="px-3 py-3 text-right">Valor venta</th>
              <th className="px-3 py-3 text-right">Credito autorizado</th>
              <th className="px-3 py-3 text-right">Inicial</th>
              <th className="px-3 py-3 text-right">% intermediacion</th>
              <th className="px-3 py-3 text-right">Intermediacion</th>
              <th className="px-3 py-3 text-right">Valor a pagar</th>
              <th className="px-3 py-3 text-left">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--fp-border)]">
            {items.map((item, index) => (
              <tr key={itemKey(item, index)} className="bg-white even:bg-[#fbfcfa]">
                <td className="whitespace-nowrap px-3 py-3">{formatDate(itemDate(item))}</td>
                <td className="max-w-40 break-all px-3 py-3 font-bold">{item.folio || "-"}</td>
                <td className="px-3 py-3 font-semibold">{itemClient(item)}</td>
                <td className="max-w-56 break-words px-3 py-3">{item.equipo || "-"}</td>
                <td className="max-w-44 break-words px-3 py-3">{item.aliado?.nombre || "-"}</td>
                <td className="px-3 py-3">
                  <Badge tone="neutral">{platformLabel(item.plataforma)}</Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.valorVenta)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.creditoAutorizado)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">
                  {formatMoney(item.cuotaInicial)}
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

function settlementAllyName(settlement: Settlement) {
  return settlement.aliado?.nombre || settlement.aliadoNombre || "Aliado";
}

function settlementTotal(settlement: Settlement) {
  return (
    settlement.totalPagar ??
    settlementSummary(settlement)?.total?.totalPagar ??
    settlementSummary(settlement)?.total?.valorPagar ??
    0
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

function SettlementsList({
  detailLoadingId,
  onOpen,
  settlements,
}: {
  detailLoadingId: string | null;
  onOpen: (settlement: Settlement) => void;
  settlements: Settlement[];
}) {
  if (!settlements.length) {
    return (
      <EmptyState
        className="mt-4"
        title="Aun no hay pagos registrados"
        description="Los periodos liquidados y pagados apareceran aqui con su aprobacion bancaria."
      />
    );
  }

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-black text-[var(--fp-graphite)]">Periodos pagados</h2>
        <Badge tone="positive">{formatNumber(settlements.length)} periodos</Badge>
      </div>

      <div className="mt-3 grid gap-3 lg:hidden">
        {settlements.map((settlement) => {
          const loading = detailLoadingId === String(settlement.id);
          return (
            <Card key={settlement.id} className="!rounded-lg !p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black text-[var(--fp-graphite)]">{settlementAllyName(settlement)}</p>
                  <p className="mt-1 text-sm text-[var(--fp-muted)]">
                    {formatDate(settlement.periodoInicio)} al {formatDate(settlement.periodoFin)}
                  </p>
                </div>
                <StatusPill tone="positive">{settlement.estado || "PAGADO"}</StatusPill>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Creditos</dt>
                  <dd className="mt-1 font-bold">{formatNumber(settlement.numeroCreditos)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--fp-muted)]">Total pagado</dt>
                  <dd className="mt-1 font-black tabular-nums">{formatMoney(settlementTotal(settlement))}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-[var(--fp-muted)]">Aprobacion bancaria</dt>
                  <dd className="mt-1 break-all font-bold">{settlement.numeroAprobacionBancaria || "-"}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-xs text-[var(--fp-muted)]">Fecha de pago</dt>
                  <dd className="mt-1 font-bold">
                    {formatDateTime(settlement.pagadoAt || settlement.createdAt)}
                  </dd>
                </div>
              </dl>
              <Button
                className="mt-4 w-full"
                variant="secondary"
                onClick={() => onOpen(settlement)}
                disabled={loading}
              >
                <Eye className="h-4 w-4" aria-hidden="true" />
                {loading ? "Cargando detalle..." : "Abrir detalle"}
              </Button>
            </Card>
          );
        })}
      </div>

      <DataTable className="mt-3 hidden lg:block">
        <table className="w-full min-w-[1180px] text-sm">
          <caption className="sr-only">Periodos pagados a aliados</caption>
          <thead className="bg-[var(--fp-graphite)] text-white">
            <tr>
              <th className="px-4 py-3 text-left">Periodo</th>
              <th className="px-4 py-3 text-left">Aliado</th>
              <th className="px-4 py-3 text-right">Creditos</th>
              <th className="px-4 py-3 text-right">Credito autorizado</th>
              <th className="px-4 py-3 text-right">Inicial</th>
              <th className="px-4 py-3 text-right">Intermediacion</th>
              <th className="px-4 py-3 text-right">Total pagado</th>
              <th className="px-4 py-3 text-left">Aprobacion</th>
              <th className="px-4 py-3 text-left">Registro</th>
              <th className="px-4 py-3 text-right">Detalle</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--fp-border)]">
            {settlements.map((settlement) => {
              const loading = detailLoadingId === String(settlement.id);
              return (
                <tr key={settlement.id} className="bg-white even:bg-[#fbfcfa]">
                  <td className="whitespace-nowrap px-4 py-3">
                    {formatDate(settlement.periodoInicio)} - {formatDate(settlement.periodoFin)}
                  </td>
                  <td className="px-4 py-3 font-bold">{settlementAllyName(settlement)}</td>
                  <td className="px-4 py-3 text-right">{formatNumber(settlement.numeroCreditos)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {formatMoney(settlement.totalCreditoAutorizado)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {formatMoney(settlement.totalCuotaInicial)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                    {formatMoney(settlement.totalIntermediacion)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-black tabular-nums">
                    {formatMoney(settlementTotal(settlement))}
                  </td>
                  <td className="max-w-44 break-all px-4 py-3 font-semibold">
                    {settlement.numeroAprobacionBancaria || "-"}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold">{settlement.registradoPorNombre || "-"}</p>
                    <p className="mt-1 whitespace-nowrap text-xs text-[var(--fp-muted)]">
                      {formatDateTime(settlement.pagadoAt || settlement.createdAt)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      onClick={() => onOpen(settlement)}
                      disabled={loading}
                      aria-label={`Abrir detalle del periodo ${formatDate(settlement.periodoInicio)} a ${formatDate(settlement.periodoFin)}`}
                    >
                      <Eye className="h-4 w-4" aria-hidden="true" />
                      {loading ? "Cargando" : "Ver"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DataTable>
    </section>
  );
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
      setPending({
        items: Array.isArray(payload.pending?.items) ? payload.pending.items : [],
        summary: payload.pending?.summary || null,
      });
      return true;
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error cargando pagos a aliados",
      });
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
      setNotice({ tone: "error", text: "El numero de aprobacion bancaria es obligatorio." });
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
          ? responseMessage(raw, "Pago registrado correctamente.")
          : `${responseMessage(
              raw,
              "Pago registrado correctamente."
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
    } catch (error) {
      setNotice({
        tone: "error",
        text: error instanceof Error ? error.message : "Error cargando el detalle",
      });
    } finally {
      setDetailLoadingId(null);
    }
  };

  const previewTotal = summaryValue(
    adjustedPreviewSummary?.total,
    "totalPagar",
    "valorPagar"
  );
  const effectiveAllyName =
    selectedAlly?.nombre ||
    preview?.aliado?.nombre ||
    (accessAllyId ? allies.find((ally) => ally.id === accessAllyId)?.nombre : null) ||
    "tu aliado";
  const pendingItems = Array.isArray(pending.items) ? pending.items : [];
  const hasPendingData =
    pendingItems.length > 0 ||
    numberValue(pending.summary?.total?.numeroCreditos) > 0;
  const refreshBusy = loading || previewLoading || submitting || Boolean(detailLoadingId);

  return (
    <main className="mx-auto w-full max-w-[1680px] px-4 py-6 sm:px-6 lg:px-7 xl:px-8">
      <PageHeader
        eyebrow={adminCentral ? "Operacion financiera" : "Consulta del aliado"}
        title="PAGOS ALIADO"
        description={
          adminCentral
            ? "Previsualiza creditos elegibles, confirma la liquidacion y consulta el historial pagado."
            : "Consulta los periodos pagados y los creditos que aun estan pendientes de liquidacion."
        }
        actions={
          <Button variant="secondary" onClick={() => void loadOverview()} disabled={refreshBusy}>
            <RefreshCw className={["h-4 w-4", loading ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
            Actualizar
          </Button>
        }
      />

      <Tabs className="mt-5" aria-label="Secciones de pagos a aliados">
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
              La informacion esta disponible desde el {ALLY_PAYMENTS_AVAILABLE_FROM_LABEL}. El periodo usa fechas de Colombia y solo muestra creditos finalizados, elegibles y no incluidos en pagos anteriores.
            </p>
            <p className="mt-1 text-xs leading-5 text-[var(--fp-muted)]">
              Credito autorizado = valor venta - inicial. La intermediacion se calcula sobre ese credito; valor a pagar = credito autorizado - intermediacion.
            </p>
            <p className="mt-1 text-xs font-semibold leading-5 text-[#5c7a13]">
              En la previsualizacion puedes ajustar el porcentaje de cada venta; la fila y el total se recalculan antes de confirmar.
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
              <CreditItems
                items={adjustedPreviewItems}
                intermediationEditor={intermediationEditor}
                emptyDescription="La previsualizacion no contiene detalle de creditos."
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
                      Numero de aprobacion bancaria
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
                      placeholder="Ingresa el numero entregado por el banco"
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
                    Registrar pago por {formatMoney(previewTotal)}
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
              title="No hay creditos elegibles en este periodo"
              description="Amplia el periodo o selecciona otro aliado. Los creditos posteriores permaneceran pendientes automaticamente."
            />
          ) : null}
        </div>
      ) : null}

      {!loading && activeTab === "recibidos" ? (
        <div
          id="ally-payments-received-panel"
          role="tabpanel"
          aria-labelledby="ally-payments-received-tab"
        >
          <SettlementsList
            settlements={settlements}
            detailLoadingId={detailLoadingId}
            onOpen={(settlement) => void openSettlement(settlement)}
          />

          {selectedSettlement ? (
            <section className="mt-5" aria-label="Detalle del periodo pagado">
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
              <CreditItems
                items={settlementItems(selectedSettlement)}
                emptyDescription="El servidor no entrego el detalle de creditos de este periodo."
              />
            </section>
          ) : null}
        </div>
      ) : null}

      {!loading && activeTab === "pendientes" ? (
        <div
          id="ally-payments-pending-panel"
          role="tabpanel"
          aria-labelledby="ally-payments-pending-tab"
        >
          <Card className="mt-4 flex items-start gap-3 !rounded-lg !p-4">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[var(--fp-amber-soft)] text-[var(--fp-amber)]">
              <Clock3 className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="font-black text-[var(--fp-graphite)]">Creditos pendientes de pago</h2>
              <p className="mt-1 text-sm leading-5 text-[var(--fp-muted)]">
                Incluye creditos elegibles que todavia no forman parte de una liquidacion pagada.
              </p>
            </div>
          </Card>
          {hasPendingData ? (
            <>
              {pending.summary ? (
                <SummaryGrid summary={pending.summary} title="Resumen pendiente" />
              ) : null}
              <CreditItems
                items={pendingItems}
                emptyDescription="El servidor no entrego el detalle de los creditos pendientes."
              />
            </>
          ) : (
            <EmptyState
              className="mt-4"
              title="No hay pagos pendientes"
              description="No existen creditos elegibles sin liquidar para este aliado."
            />
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title="Confirmar pago al aliado"
        description={`Se registrara un pago a ${effectiveAllyName} por ${formatMoney(
          previewTotal
        )}, correspondiente al periodo ${formatDate(fechaInicio)} al ${formatDate(
          fechaFin
        )}. Aprobacion bancaria: ${approvalNumber.trim() || "-"}. ${
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
