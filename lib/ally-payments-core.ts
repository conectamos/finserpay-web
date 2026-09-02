export type AllyPaymentPlatform = "ANDROID" | "IPHONE";

export const ALLY_PAYMENTS_AVAILABLE_FROM = "2026-09-01";
export const ALLY_PAYMENTS_AVAILABLE_FROM_LABEL = "1 de septiembre de 2026";

export type AllyPaymentViewerScope =
  | { kind: "UNAUTHENTICATED" }
  | { kind: "FORBIDDEN" }
  | { kind: "CENTRAL_ADMIN"; allyId: null }
  | { kind: "ALLY_ADMIN"; allyId: number };

export type ColombiaPaymentPeriod = {
  startDate: string;
  endDate: string;
  start: Date;
  endExclusive: Date;
};

export type AllyPaymentCalculationInput = {
  valorVenta: unknown;
  cuotaInicial: unknown;
  porcentajeIntermediacion: unknown;
};

export type AllyPaymentAmounts = {
  valorVenta: number;
  cuotaInicial: number;
  porcentajeIntermediacion: number;
  creditoAutorizado: number;
  valorIntermediacion: number;
  valorPagar: number;
};

export type AllyPaymentSummaryItem = AllyPaymentAmounts & {
  plataforma: AllyPaymentPlatform;
};

export type AllyPaymentSummaryBucket = {
  plataforma: AllyPaymentPlatform | "TOTAL";
  numeroCreditos: number;
  valorVenta: number;
  cuotaInicial: number;
  creditoAutorizado: number;
  valorIntermediacion: number;
  valorPagar: number;
  porcentajeIntermediacion: number | null;
};

export type AllyPaymentSummary = {
  ANDROID: AllyPaymentSummaryBucket;
  IPHONE: AllyPaymentSummaryBucket;
  total: AllyPaymentSummaryBucket;
};

export type AllyPaymentIntermediationAdjustment = {
  creditoId: number;
  porcentajeIntermediacion: number;
};

const COLOMBIA_UTC_OFFSET_HOURS = -5;
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CANCELLED_CREDIT_STATES = new Set([
  "ANULADO",
  "ANULADA",
  "CANCELADO",
  "CANCELADA",
]);

export function resolveAllyPaymentViewerScope(input: {
  authenticated: boolean;
  roleName: unknown;
  allyAccessCode: unknown;
  allyAccessId: unknown;
}): AllyPaymentViewerScope {
  if (!input.authenticated) {
    return { kind: "UNAUTHENTICATED" };
  }

  if (String(input.roleName ?? "").trim().toUpperCase() !== "ADMIN") {
    return { kind: "FORBIDDEN" };
  }

  if (
    String(input.allyAccessCode ?? "").trim().toUpperCase() === "FINSERPAY"
  ) {
    return { kind: "CENTRAL_ADMIN", allyId: null };
  }

  const allyId = Number(input.allyAccessId);
  if (!Number.isSafeInteger(allyId) || allyId <= 0) {
    return { kind: "FORBIDDEN" };
  }

  return { kind: "ALLY_ADMIN", allyId };
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function roundAllyPaymentMoney(value: unknown) {
  const numeric = finiteNumber(value);
  return Math.round((numeric + Number.EPSILON) * 100) / 100;
}

export function normalizeAllyIntermediationPercentage(value: unknown) {
  const numeric = finiteNumber(
    typeof value === "string" ? value.replace(",", ".").trim() : value
  );

  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100));
}

export function normalizeAllyPaymentIntermediationAdjustments(
  value: unknown
): AllyPaymentIntermediationAdjustment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new RangeError("Los ajustes de intermediacion deben ser una lista.");
  }
  if (value.length > 2_000) {
    throw new RangeError("No puedes ajustar mas de 2.000 creditos por liquidacion.");
  }

  const seenCreditIds = new Set<number>();
  const adjustments = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RangeError(`El ajuste ${index + 1} no es valido.`);
    }

    const record = item as Record<string, unknown>;
    const creditoId = record.creditoId;
    const rawPercentage = record.porcentajeIntermediacion;
    if (!Number.isSafeInteger(creditoId) || Number(creditoId) <= 0) {
      throw new RangeError(`El credito del ajuste ${index + 1} no es valido.`);
    }
    if (
      typeof rawPercentage !== "number" ||
      !Number.isFinite(rawPercentage) ||
      rawPercentage < 0 ||
      rawPercentage > 100
    ) {
      throw new RangeError(
        `La intermediacion del ajuste ${index + 1} debe estar entre 0 y 100.`
      );
    }

    const percentage = Math.round((rawPercentage + Number.EPSILON) * 100) / 100;
    if (Math.abs(percentage - rawPercentage) > 1e-9) {
      throw new RangeError(
        `La intermediacion del ajuste ${index + 1} admite maximo dos decimales.`
      );
    }

    const normalizedCreditId = Number(creditoId);
    if (seenCreditIds.has(normalizedCreditId)) {
      throw new RangeError(`El credito ${normalizedCreditId} tiene ajustes duplicados.`);
    }
    seenCreditIds.add(normalizedCreditId);

    return {
      creditoId: normalizedCreditId,
      porcentajeIntermediacion: Object.is(percentage, -0) ? 0 : percentage,
    };
  });

  return adjustments.sort((left, right) => left.creditoId - right.creditoId);
}

function normalizePlatform(value: unknown): AllyPaymentPlatform | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized === "ANDROID" || normalized === "IPHONE"
    ? normalized
    : null;
}

function isIphoneBrand(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  return (
    normalized === "IPHONE" ||
    normalized === "APPLE" ||
    normalized === "APPLEIPHONE"
  );
}

export function resolveAllyPaymentPlatform(
  contractSnapshot: unknown,
  equipmentBrand?: unknown
): AllyPaymentPlatform | null {
  const root =
    typeof contractSnapshot === "object" && contractSnapshot !== null
      ? (contractSnapshot as Record<string, unknown>)
      : null;
  const equipment =
    typeof root?.equipo === "object" && root.equipo !== null
      ? (root.equipo as Record<string, unknown>)
      : null;
  const snapshotPlatform = normalizePlatform(equipment?.plataforma);

  if (snapshotPlatform) {
    return snapshotPlatform;
  }

  if (isIphoneBrand(equipmentBrand)) {
    return "IPHONE";
  }

  return String(equipmentBrand ?? "").trim() ? "ANDROID" : null;
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number) {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseDateKey(value: unknown, label: string) {
  const dateKey = String(value ?? "").trim();
  const match = DATE_KEY_PATTERN.exec(dateKey);

  if (!match) {
    throw new RangeError(`${label} debe usar el formato YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new RangeError(`${label} no es una fecha calendario valida.`);
  }

  return { dateKey, year, month, day };
}

function colombiaMidnightUtc(year: number, month: number, day: number) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(-COLOMBIA_UTC_OFFSET_HOURS, 0, 0, 0);
  return date;
}

export function resolveColombiaPaymentPeriod(
  startDate: unknown,
  endDate: unknown
): ColombiaPaymentPeriod {
  const startParts = parseDateKey(startDate, "La fecha inicial");
  const endParts = parseDateKey(endDate, "La fecha final");
  const start = colombiaMidnightUtc(
    startParts.year,
    startParts.month,
    startParts.day
  );
  const inclusiveEnd = colombiaMidnightUtc(
    endParts.year,
    endParts.month,
    endParts.day
  );

  if (start.getTime() > inclusiveEnd.getTime()) {
    throw new RangeError("La fecha inicial no puede ser posterior a la fecha final.");
  }

  return {
    startDate: startParts.dateKey,
    endDate: endParts.dateKey,
    start,
    endExclusive: new Date(inclusiveEnd.getTime() + 86_400_000),
  };
}

export function resolveAvailableAllyPaymentPeriod(
  startDate: unknown,
  endDate: unknown
) {
  const period = resolveColombiaPaymentPeriod(startDate, endDate);

  if (period.startDate < ALLY_PAYMENTS_AVAILABLE_FROM) {
    throw new RangeError(
      `La informacion de pagos esta disponible desde el ${ALLY_PAYMENTS_AVAILABLE_FROM_LABEL}.`
    );
  }

  return period;
}

export function isAnnulledCreditState(value: unknown) {
  return CANCELLED_CREDIT_STATES.has(
    String(value ?? "").trim().toUpperCase()
  );
}

export function normalizeBankApprovalNumber(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function calculateAllyPaymentAmounts(
  input: AllyPaymentCalculationInput
): AllyPaymentAmounts {
  const valorVenta = Math.max(0, roundAllyPaymentMoney(input.valorVenta));
  const cuotaInicial = Math.max(0, roundAllyPaymentMoney(input.cuotaInicial));
  const porcentajeIntermediacion = normalizeAllyIntermediationPercentage(
    input.porcentajeIntermediacion
  );
  const creditoAutorizado = roundAllyPaymentMoney(
    Math.max(valorVenta - cuotaInicial, 0)
  );
  const valorIntermediacion = roundAllyPaymentMoney(
    (creditoAutorizado * porcentajeIntermediacion) / 100
  );
  const valorPagar = roundAllyPaymentMoney(
    creditoAutorizado - valorIntermediacion
  );

  return {
    valorVenta,
    cuotaInicial,
    porcentajeIntermediacion,
    creditoAutorizado,
    valorIntermediacion,
    valorPagar,
  };
}

export function applyAllyPaymentIntermediationAdjustments<
  T extends AllyPaymentSummaryItem & { creditoId: number },
>(
  items: readonly T[],
  adjustments: readonly AllyPaymentIntermediationAdjustment[]
): T[] {
  if (!adjustments.length) return [...items];

  const eligibleCreditIds = new Set(items.map((item) => item.creditoId));
  for (const adjustment of adjustments) {
    if (!eligibleCreditIds.has(adjustment.creditoId)) {
      throw new RangeError(
        `El credito ${adjustment.creditoId} no pertenece a la previsualizacion vigente.`
      );
    }
  }

  const percentageByCredit = new Map(
    adjustments.map((adjustment) => [
      adjustment.creditoId,
      adjustment.porcentajeIntermediacion,
    ])
  );

  return items.map((item) => {
    if (!percentageByCredit.has(item.creditoId)) return item;
    const amounts = calculateAllyPaymentAmounts({
      valorVenta: item.valorVenta,
      cuotaInicial: item.cuotaInicial,
      porcentajeIntermediacion: percentageByCredit.get(item.creditoId),
    });
    return { ...item, ...amounts };
  });
}

function emptySummaryBucket(
  plataforma: AllyPaymentSummaryBucket["plataforma"]
): AllyPaymentSummaryBucket {
  return {
    plataforma,
    numeroCreditos: 0,
    valorVenta: 0,
    cuotaInicial: 0,
    creditoAutorizado: 0,
    valorIntermediacion: 0,
    valorPagar: 0,
    porcentajeIntermediacion: null,
  };
}

function summarizeBucket(
  plataforma: AllyPaymentSummaryBucket["plataforma"],
  items: readonly AllyPaymentSummaryItem[]
) {
  const bucket = emptySummaryBucket(plataforma);
  const percentages = new Set<number>();

  for (const item of items) {
    bucket.numeroCreditos += 1;
    bucket.valorVenta = roundAllyPaymentMoney(
      bucket.valorVenta + Math.max(0, roundAllyPaymentMoney(item.valorVenta))
    );
    bucket.cuotaInicial = roundAllyPaymentMoney(
      bucket.cuotaInicial + Math.max(0, roundAllyPaymentMoney(item.cuotaInicial))
    );
    bucket.creditoAutorizado = roundAllyPaymentMoney(
      bucket.creditoAutorizado +
        Math.max(0, roundAllyPaymentMoney(item.creditoAutorizado))
    );
    bucket.valorIntermediacion = roundAllyPaymentMoney(
      bucket.valorIntermediacion +
        Math.max(0, roundAllyPaymentMoney(item.valorIntermediacion))
    );
    bucket.valorPagar = roundAllyPaymentMoney(
      bucket.valorPagar + Math.max(0, roundAllyPaymentMoney(item.valorPagar))
    );
    percentages.add(
      normalizeAllyIntermediationPercentage(item.porcentajeIntermediacion)
    );
  }

  bucket.porcentajeIntermediacion =
    percentages.size === 1 ? [...percentages][0] : null;

  return bucket;
}

export function summarizeAllyPayments(
  items: readonly AllyPaymentSummaryItem[]
): AllyPaymentSummary {
  const androidItems = items.filter((item) => item.plataforma === "ANDROID");
  const iphoneItems = items.filter((item) => item.plataforma === "IPHONE");
  const recognizedItems = [...androidItems, ...iphoneItems];

  return {
    ANDROID: summarizeBucket("ANDROID", androidItems),
    IPHONE: summarizeBucket("IPHONE", iphoneItems),
    total: summarizeBucket("TOTAL", recognizedItems),
  };
}
