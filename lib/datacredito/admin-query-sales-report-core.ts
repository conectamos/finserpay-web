export const DATACREDITO_QUERY_SALES_TIMEZONE = "America/Bogota";

const BOGOTA_UTC_OFFSET_HOURS = 5;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type DataCreditoQuerySalesMode = "day" | "month" | "range";

export type DataCreditoQuerySalesFilters = {
  mode: DataCreditoQuerySalesMode;
  allyId: number | null;
  day: string | null;
  month: string | null;
  from: string | null;
  to: string | null;
};

export type DataCreditoQuerySalesMetric = {
  originalQueries: number;
  reusedAssessments: number;
  sales: number;
  salesVsOriginalQueriesPercent: number | null;
};

export type DataCreditoQuerySalesRow = DataCreditoQuerySalesMetric & {
  allyId: number | null;
  allyName: string;
  allyCode: string | null;
  active: boolean | null;
};

export type DataCreditoQuerySalesPeriod = {
  timezone: typeof DATACREDITO_QUERY_SALES_TIMEZONE;
  start: string;
  endExclusive: string;
  label: string;
};

export type ParsedDataCreditoQuerySalesReportInput = {
  filters: DataCreditoQuerySalesFilters;
  period: DataCreditoQuerySalesPeriod;
  start: Date;
  endExclusive: Date;
};

export type DataCreditoQuerySalesAllyInput = {
  id: number;
  name: string;
  code: string | null;
  active: boolean;
};

export type DataCreditoQueryMetricInput = {
  allyId: number | null;
  originalQueries: number;
  reusedAssessments: number;
};

export type DataCreditoSalesMetricInput = {
  allyId: number | null;
  sales: number;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type MetricAccumulator = {
  originalQueries: number;
  reusedAssessments: number;
  sales: number;
};

export class DataCreditoQuerySalesReportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataCreditoQuerySalesReportInputError";
  }
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function parseDateKey(value: unknown): DateParts | null {
  const match = cleanText(value).match(ISO_DATE_PATTERN);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseMonthKey(value: unknown) {
  const match = cleanText(value).match(ISO_MONTH_PATTERN);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 2000 && month >= 1 && month <= 12 ? { year, month } : null;
}

function addUtcDays(parts: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function bogotaMidnight(parts: DateParts) {
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      BOGOTA_UTC_OFFSET_HOURS
    )
  );
}

function dateLabel(parts: DateParts) {
  return `${String(parts.day).padStart(2, "0")}/${String(parts.month).padStart(
    2,
    "0"
  )}/${parts.year}`;
}

function parseAllyId(value: unknown) {
  if (value === null || value === undefined || cleanText(value) === "") {
    return null;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > MAX_POSTGRES_INTEGER
  ) {
    throw new DataCreditoQuerySalesReportInputError(
      "El aliado seleccionado no es valido"
    );
  }
  return parsed;
}

export function parseDataCreditoQuerySalesReportInput(
  input: Record<string, unknown>
): ParsedDataCreditoQuerySalesReportInput {
  const mode = cleanText(input.mode).toLowerCase();
  const allyId = parseAllyId(input.allyId);

  if (mode === "day") {
    const rawDay = cleanText(input.day);
    const day = parseDateKey(rawDay);
    if (!day) {
      throw new DataCreditoQuerySalesReportInputError(
        "El dia debe tener formato AAAA-MM-DD"
      );
    }
    const start = bogotaMidnight(day);
    const endExclusive = bogotaMidnight(addUtcDays(day, 1));
    return {
      start,
      endExclusive,
      filters: {
        mode,
        allyId,
        day: rawDay,
        month: null,
        from: null,
        to: null,
      },
      period: {
        timezone: DATACREDITO_QUERY_SALES_TIMEZONE,
        start: start.toISOString(),
        endExclusive: endExclusive.toISOString(),
        label: dateLabel(day),
      },
    };
  }

  if (mode === "month") {
    const rawMonth = cleanText(input.month);
    const month = parseMonthKey(rawMonth);
    if (!month) {
      throw new DataCreditoQuerySalesReportInputError(
        "El mes debe tener formato AAAA-MM"
      );
    }
    const firstDay = { ...month, day: 1 };
    const nextMonth =
      month.month === 12
        ? { year: month.year + 1, month: 1, day: 1 }
        : { year: month.year, month: month.month + 1, day: 1 };
    const start = bogotaMidnight(firstDay);
    const endExclusive = bogotaMidnight(nextMonth);
    const label = new Intl.DateTimeFormat("es-CO", {
      timeZone: DATACREDITO_QUERY_SALES_TIMEZONE,
      month: "long",
      year: "numeric",
    }).format(start);
    return {
      start,
      endExclusive,
      filters: {
        mode,
        allyId,
        day: null,
        month: rawMonth,
        from: null,
        to: null,
      },
      period: {
        timezone: DATACREDITO_QUERY_SALES_TIMEZONE,
        start: start.toISOString(),
        endExclusive: endExclusive.toISOString(),
        label,
      },
    };
  }

  if (mode === "range") {
    const rawFrom = cleanText(input.from);
    const rawTo = cleanText(input.to);
    const from = parseDateKey(rawFrom);
    const to = parseDateKey(rawTo);
    if (!from || !to) {
      throw new DataCreditoQuerySalesReportInputError(
        "El rango debe usar fechas con formato AAAA-MM-DD"
      );
    }
    const start = bogotaMidnight(from);
    const endExclusive = bogotaMidnight(addUtcDays(to, 1));
    if (start >= endExclusive) {
      throw new DataCreditoQuerySalesReportInputError(
        "La fecha inicial no puede ser posterior a la fecha final"
      );
    }
    return {
      start,
      endExclusive,
      filters: {
        mode,
        allyId,
        day: null,
        month: null,
        from: rawFrom,
        to: rawTo,
      },
      period: {
        timezone: DATACREDITO_QUERY_SALES_TIMEZONE,
        start: start.toISOString(),
        endExclusive: endExclusive.toISOString(),
        label: `${dateLabel(from)} - ${dateLabel(to)}`,
      },
    };
  }

  throw new DataCreditoQuerySalesReportInputError(
    "El modo debe ser day, month o range"
  );
}

function metricKey(allyId: number | null) {
  return allyId === null ? "null" : String(allyId);
}

function emptyMetric(): MetricAccumulator {
  return { originalQueries: 0, reusedAssessments: 0, sales: 0 };
}

function validatedCount(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Los conteos del reporte deben ser enteros no negativos");
  }
  return value;
}

export function salesVsOriginalQueriesPercent(
  originalQueries: number,
  sales: number
) {
  if (originalQueries === 0) return null;
  return Math.round((sales / originalQueries) * 1_000) / 10;
}

function completeMetric(metric: MetricAccumulator): DataCreditoQuerySalesMetric {
  return {
    ...metric,
    salesVsOriginalQueriesPercent: salesVsOriginalQueriesPercent(
      metric.originalQueries,
      metric.sales
    ),
  };
}

function hasActivity(metric: MetricAccumulator) {
  return (
    metric.originalQueries > 0 ||
    metric.reusedAssessments > 0 ||
    metric.sales > 0
  );
}

export function aggregateDataCreditoQuerySalesReport(input: {
  allies: readonly DataCreditoQuerySalesAllyInput[];
  centralAllyIds: readonly number[];
  queryMetrics: readonly DataCreditoQueryMetricInput[];
  salesMetrics: readonly DataCreditoSalesMetricInput[];
  selectedAllyId: number | null;
}) {
  const metrics = new Map<string, MetricAccumulator>();
  const metricIds = new Map<string, number | null>();

  for (const row of input.queryMetrics) {
    const key = metricKey(row.allyId);
    const metric = metrics.get(key) || emptyMetric();
    metric.originalQueries += validatedCount(row.originalQueries);
    metric.reusedAssessments += validatedCount(row.reusedAssessments);
    metrics.set(key, metric);
    metricIds.set(key, row.allyId);
  }

  for (const row of input.salesMetrics) {
    const key = metricKey(row.allyId);
    const metric = metrics.get(key) || emptyMetric();
    metric.sales += validatedCount(row.sales);
    metrics.set(key, metric);
    metricIds.set(key, row.allyId);
  }

  const rows: DataCreditoQuerySalesRow[] = [];
  const represented = new Set<string>();
  const centralAllyIds = new Set(input.centralAllyIds);

  for (const ally of input.allies) {
    if (input.selectedAllyId !== null && ally.id !== input.selectedAllyId) {
      continue;
    }
    if (centralAllyIds.has(ally.id)) continue;
    const key = metricKey(ally.id);
    const metric = metrics.get(key) || emptyMetric();
    if (!ally.active && !hasActivity(metric)) continue;

    rows.push({
      allyId: ally.id,
      allyName: ally.name,
      allyCode: ally.code,
      active: ally.active,
      ...completeMetric(metric),
    });
    represented.add(key);
  }

  for (const [key, metric] of metrics) {
    if (represented.has(key)) continue;
    const allyId = metricIds.get(key) ?? null;
    if (allyId !== null && centralAllyIds.has(allyId)) continue;
    if (input.selectedAllyId !== null && allyId !== input.selectedAllyId) {
      continue;
    }
    if (!hasActivity(metric)) continue;

    rows.push({
      allyId,
      allyName: allyId === null ? "Sin aliado" : `Aliado #${allyId}`,
      allyCode: null,
      active: null,
      ...completeMetric(metric),
    });
  }

  rows.sort((left, right) => {
    if (left.allyId === null) return right.allyId === null ? 0 : 1;
    if (right.allyId === null) return -1;
    return left.allyName.localeCompare(right.allyName, "es-CO", {
      sensitivity: "base",
    });
  });

  const totals = rows.reduce<MetricAccumulator>(
    (total, row) => ({
      originalQueries: total.originalQueries + row.originalQueries,
      reusedAssessments: total.reusedAssessments + row.reusedAssessments,
      sales: total.sales + row.sales,
    }),
    emptyMetric()
  );

  return {
    rows,
    summary: completeMetric(totals),
  };
}
