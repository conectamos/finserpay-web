import type { EqualityDeliveryStatus } from "@/lib/equality-device-meta";
import { getColombiaDateParts } from "@/lib/colombia-date";

export type CreditAdminCommand =
  | "consult-device"
  | "payment-reference"
  | "toggle-stolen-lock"
  | "toggle-mora-lock"
  | "update-due-date"
  | "update-plan"
  | "extend-1h"
  | "extend-24h"
  | "extend-48h"
  | "warranty-15d"
  | "warranty-20d"
  | "remove-lock"
  | "annul-credit";

export const CREDIT_ABONO_CAJA_MARKER = "ABONO_CREDITO_ID:";
export const DEFAULT_LEGAL_CONSUMER_RATE_EA = 17.84;
export const DEFAULT_FIANCO_SURETY_PERCENTAGE = 60;
export const DEFAULT_INITIAL_PAYMENT_PERCENTAGE = 20;
export const ANDROID_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE = 30;
export const ANDROID_SIMULATOR_TOTAL_SURETY_PERCENTAGE = 75;
export const DEFAULT_CREDIT_INSTALLMENTS = 12;
export const DEFAULT_MAX_CREDIT_INSTALLMENTS = 16;
export const MAX_CREDIT_INSTALLMENTS = 60;
export const DEFAULT_PAYMENT_FREQUENCY = "QUINCENAL";
export const MAX_DEVICE_FINANCING_BASE = 800_000;
export const IPHONE_INITIAL_PAYMENT_PERCENTAGE = 30;
export const IPHONE_DEFAULT_CREDIT_INSTALLMENTS = 24;
export const IPHONE_MAX_CREDIT_INSTALLMENTS = 48;
export const IPHONE_MAX_FINANCED_AMOUNT = 3_500_000;
export const IPHONE_MAX_INSTALLMENT_VALUE = 160_000;
export const MAX_VIDEO_DATA_URL_LENGTH = 64_000_000;
export const MAX_VIDEO_UPLOAD_BYTES = 45 * 1024 * 1024;
export const DEFAULT_LEGAL_RATE_REFERENCE =
  "SFC consumo y ordinario vigente del 1 al 30 de abril de 2026";

export const PAYMENT_FREQUENCY_OPTIONS = [
  { value: "SEMANAL", label: "Semanal", days: 7, periodsPerYear: 52 },
  { value: "CATORCENAL", label: "Catorcenal", days: 14, periodsPerYear: 26 },
  { value: "QUINCENAL", label: "Quincenal", days: 15, periodsPerYear: 24 },
  { value: "MENSUAL", label: "Mensual", days: 30, periodsPerYear: 12 },
] as const;

export type PaymentFrequency = (typeof PAYMENT_FREQUENCY_OPTIONS)[number]["value"];

export function sanitizeDeviceValue(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

export function sanitizeText(value: unknown) {
  return String(value ?? "").trim();
}

export function sanitizeSearch(value: unknown) {
  return String(value ?? "").trim().slice(0, 80);
}

export function toNumber(value: unknown) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

export function calculateAndroidSimulatorInitialPayment(
  valorTotalEquipo: number | null | undefined
) {
  const total = Number(valorTotalEquipo || 0);
  if (!Number.isFinite(total) || total <= 0) return 0;

  return Math.round(
    (total * ANDROID_SIMULATOR_INITIAL_PAYMENT_PERCENTAGE) / 100
  );
}

export function calculateAndroidSimulatorInstallmentSuretyPercentage(
  numeroCuotas: number
) {
  if (!Number.isSafeInteger(numeroCuotas) || numeroCuotas <= 0) {
    throw new Error("numeroCuotas debe ser un entero positivo");
  }

  return ANDROID_SIMULATOR_TOTAL_SURETY_PERCENTAGE / numeroCuotas;
}

export function normalizeCreditInstallmentLimit(
  value: unknown,
  fallback = DEFAULT_MAX_CREDIT_INSTALLMENTS
) {
  const parsed = Math.trunc(Number(value));
  const fallbackValue = Math.trunc(Number(fallback));
  const candidate =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : Number.isFinite(fallbackValue) && fallbackValue > 0
        ? fallbackValue
        : DEFAULT_MAX_CREDIT_INSTALLMENTS;

  return Math.max(1, Math.min(MAX_CREDIT_INSTALLMENTS, candidate));
}

export function normalizeCreditInstallments(
  value: unknown,
  fallback = DEFAULT_CREDIT_INSTALLMENTS,
  maxInstallments: unknown = DEFAULT_MAX_CREDIT_INSTALLMENTS
) {
  const max = normalizeCreditInstallmentLimit(maxInstallments);
  const parsed = Math.trunc(Number(value));
  const fallbackValue = Math.trunc(Number(fallback));
  const candidate =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : Number.isFinite(fallbackValue) && fallbackValue > 0
        ? fallbackValue
        : DEFAULT_CREDIT_INSTALLMENTS;

  return Math.max(1, Math.min(max, candidate));
}

export function parseCreditInstallmentSelection(
  value: unknown,
  maxInstallments: unknown
) {
  const parsed = Number(value);
  const max = normalizeCreditInstallmentLimit(maxInstallments);

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max
    ? parsed
    : null;
}

export function getCreditInstallmentOptions(maxInstallments: unknown) {
  return Array.from(
    { length: normalizeCreditInstallmentLimit(maxInstallments) },
    (_, index) => String(index + 1)
  );
}

export function toNullableDate(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function generateCreditFolio() {
  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `FC-${timestamp}-${suffix}`;
}

export function generatePagareNumber(reference?: string | null) {
  const base = sanitizeText(reference).replace(/\W/g, "").slice(-18);

  if (base) {
    return `PG-${base}`;
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `PG-${timestamp}-${suffix}`;
}

export function generatePaymentReference(folio: string, document: string) {
  const cleanDocument = sanitizeText(document).replace(/\W/g, "").slice(-6) || "CLIENTE";
  return `REF-${folio}-${cleanDocument}`.slice(0, 40);
}

export function resolveCreditState(options: {
  bloqueoRobo?: boolean;
  bloqueoMora?: boolean;
  deliverable?: EqualityDeliveryStatus | null;
  pazYSalvoEmitidoAt?: Date | null;
}) {
  if (options.pazYSalvoEmitidoAt) {
    return "PAZ_Y_SALVO";
  }

  if (options.bloqueoRobo) {
    return "ROBO_BLOQUEADO";
  }

  if (options.bloqueoMora) {
    return "MORA_BLOQUEADO";
  }

  if (options.deliverable?.ready) {
    return "ENTREGABLE";
  }

  if (options.deliverable) {
    return "INSCRITO";
  }

  return "GENERADO";
}

export function extendFromNow(hours: number, current: Date | null) {
  const base =
    current && current.getTime() > Date.now() ? current.getTime() : Date.now();

  return new Date(base + hours * 60 * 60 * 1000);
}

export function extendDays(days: number, current: Date | null) {
  const base =
    current && current.getTime() > Date.now() ? current.getTime() : Date.now();

  return new Date(base + days * 24 * 60 * 60 * 1000);
}

export function normalizePaymentMethod(value: unknown) {
  const method = String(value ?? "").trim().toUpperCase();

  if (["EFECTIVO", "TRANSFERENCIA", "NEQUI", "DAVIPLATA", "OTRO"].includes(method)) {
    return method;
  }

  return "EFECTIVO";
}

export function normalizePaymentFrequency(value: unknown): PaymentFrequency {
  const frequency = String(value ?? "").trim().toUpperCase();
  const match = PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === frequency);

  return match?.value || DEFAULT_PAYMENT_FREQUENCY;
}

export function getPaymentFrequencyLabel(value: unknown) {
  const frequency = normalizePaymentFrequency(value);
  return (
    PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === frequency)?.label ||
    "Quincenal"
  );
}

export function getPaymentFrequencyPeriodsPerYear(value: unknown) {
  const frequency = normalizePaymentFrequency(value);
  return (
    PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === frequency)
      ?.periodsPerYear || 24
  );
}

function normalizeDateAtNoon(value: Date | number | string = new Date()) {
  const normalizedValue = String(value || "").trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalizedValue);

  if (dateOnly) {
    return new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12)
    );
  }

  const baseDate = new Date(value);
  const normalized = Number.isNaN(baseDate.getTime()) ? new Date() : baseDate;
  return new Date(
    Date.UTC(
      normalized.getUTCFullYear(),
      normalized.getUTCMonth(),
      normalized.getUTCDate(),
      12
    )
  );
}

function normalizeColombiaInstantAtNoon(
  value: Date | number | string = new Date()
) {
  const parts = getColombiaDateParts(
    typeof value === "number" ? new Date(value) : value
  );
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12));
}

function createNoonDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day, 12));
}

export function getQuincenalFirstPaymentDateObject(
  from: Date | number | string = new Date()
) {
  const baseDate = normalizeDateAtNoon(from);
  const creditDay = baseDate.getUTCDate();
  let dueMonth = baseDate.getUTCMonth();
  let dueYear = baseDate.getUTCFullYear();
  let dueDay = 17;

  if (creditDay <= 5) {
    dueDay = 17;
  } else if (creditDay <= 20) {
    dueDay = 2;
    dueMonth += 1;
  } else {
    dueDay = 17;
    dueMonth += 1;
  }

  const dueDate = createNoonDate(dueYear, dueMonth, dueDay);
  dueYear = dueDate.getUTCFullYear();
  dueMonth = dueDate.getUTCMonth();

  return createNoonDate(dueYear, dueMonth, dueDay);
}

function addQuincenalPaymentPeriod(date: Date | number | string, periods: number) {
  const baseDate = normalizeDateAtNoon(date);
  let dueMonth = baseDate.getUTCMonth();
  let dueYear = baseDate.getUTCFullYear();
  let dueDay = baseDate.getUTCDate() <= 2 ? 2 : 17;
  const steps = Math.max(0, Math.trunc(Number(periods || 0)));

  for (let index = 0; index < steps; index += 1) {
    if (dueDay === 2) {
      dueDay = 17;
    } else {
      dueDay = 2;
      dueMonth += 1;
    }

    const normalized = createNoonDate(dueYear, dueMonth, dueDay);
    dueYear = normalized.getUTCFullYear();
    dueMonth = normalized.getUTCMonth();
  }

  return createNoonDate(dueYear, dueMonth, dueDay);
}

export function addPaymentFrequency(
  date: Date | number | string,
  frequencyValue: unknown,
  periods = 1
) {
  const frequency = normalizePaymentFrequency(frequencyValue);
  const next = normalizeDateAtNoon(date);

  if (frequency === "QUINCENAL") {
    return addQuincenalPaymentPeriod(next, periods);
  }

  if (frequency === "MENSUAL") {
    const targetDay = next.getUTCDate();
    next.setUTCDate(1);
    next.setUTCMonth(next.getUTCMonth() + periods);
    const lastDayOfTargetMonth = new Date(
      Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0, 12)
    ).getUTCDate();
    next.setUTCDate(Math.min(targetDay, lastDayOfTargetMonth));
    return next;
  }

  const days =
    PAYMENT_FREQUENCY_OPTIONS.find((option) => option.value === frequency)?.days || 15;
  next.setUTCDate(next.getUTCDate() + days * periods);

  return next;
}

export function calculateFinancedBalance(
  valorTotalEquipo: number | null | undefined,
  cuotaInicial: number | null | undefined
) {
  const total = Math.max(0, Number(valorTotalEquipo || 0));
  const inicial = Math.max(0, Number(cuotaInicial || 0));
  return Math.max(0, total - inicial);
}

export function calculateRequiredInitialPayment(
  valorTotalEquipo: number | null | undefined,
  precioBaseVenta?: number | null,
  initialPaymentPercentage: number | null | undefined = DEFAULT_INITIAL_PAYMENT_PERCENTAGE
) {
  const total = Math.max(0, Number(valorTotalEquipo || 0));
  const catalogBase = Math.max(0, Number(precioBaseVenta || 0));
  const percentage = Math.max(
    0,
    Math.min(100, Number(initialPaymentPercentage ?? DEFAULT_INITIAL_PAYMENT_PERCENTAGE))
  );
  const limit = catalogBase > 0 ? catalogBase : MAX_DEVICE_FINANCING_BASE;
  const financedBase = Math.min(total, limit);
  const excedente = Math.max(0, total - limit);
  const initial = (financedBase * percentage) / 100 + excedente;

  return Math.round(initial * 100) / 100;
}

export function calculateRequiredInitialPaymentForFinancingLimit(
  valorTotalEquipo: number | null | undefined,
  maxFinancedAmount: number | null | undefined,
  initialPaymentPercentage: number | null | undefined = DEFAULT_INITIAL_PAYMENT_PERCENTAGE
) {
  const total = Math.max(0, Number(valorTotalEquipo || 0));
  const financingLimit = Math.max(0, Number(maxFinancedAmount || 0));
  const percentage = Math.max(
    0,
    Math.min(100, Number(initialPaymentPercentage ?? DEFAULT_INITIAL_PAYMENT_PERCENTAGE))
  );
  const financedBase =
    financingLimit > 0 ? Math.min(total, financingLimit) : 0;
  const excessToInitial =
    financingLimit > 0 ? Math.max(0, total - financingLimit) : total;
  const requiredInitial =
    (financedBase * percentage) / 100 + excessToInitial;

  return Math.round(requiredInitial * 100) / 100;
}

export function isIphoneCreditPlatform(value: unknown) {
  const normalized = String(value ?? "").trim().toUpperCase();

  return normalized === "IPHONE" || normalized === "IOS" || normalized === "APPLE";
}

export type IphoneDeliveryEvidenceKey = "fotoEntrega" | "fotoRemision";

export type IphoneIdentityEvidenceKey =
  | "cedulaFrente"
  | "cedulaRespaldo"
  | "selfieCedula";

export type IphoneClosureEvidenceKey =
  | IphoneIdentityEvidenceKey
  | IphoneDeliveryEvidenceKey;

export function getMissingIphoneIdentityEvidence(options: {
  platform?: unknown;
  cedulaFrenteDataUrl?: unknown;
  cedulaRespaldoDataUrl?: unknown;
  selfieCedulaDataUrl?: unknown;
}): IphoneIdentityEvidenceKey[] {
  if (!isIphoneCreditPlatform(options.platform)) {
    return [];
  }

  const missing: IphoneIdentityEvidenceKey[] = [];

  if (!String(options.cedulaFrenteDataUrl ?? "").trim()) {
    missing.push("cedulaFrente");
  }

  if (!String(options.cedulaRespaldoDataUrl ?? "").trim()) {
    missing.push("cedulaRespaldo");
  }

  if (!String(options.selfieCedulaDataUrl ?? "").trim()) {
    missing.push("selfieCedula");
  }

  return missing;
}

export function hasDuplicateEvidenceValues(values: unknown[]) {
  const normalized = values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);

  return (
    normalized.length > 1 && new Set(normalized).size !== normalized.length
  );
}

export function getMissingIphoneDeliveryEvidence(options: {
  platform?: unknown;
  fotoEntregaDataUrl?: unknown;
  fotoRemisionDataUrl?: unknown;
}): IphoneDeliveryEvidenceKey[] {
  if (!isIphoneCreditPlatform(options.platform)) {
    return [];
  }

  const missing: IphoneDeliveryEvidenceKey[] = [];

  if (!String(options.fotoEntregaDataUrl ?? "").trim()) {
    missing.push("fotoEntrega");
  }

  if (!String(options.fotoRemisionDataUrl ?? "").trim()) {
    missing.push("fotoRemision");
  }

  return missing;
}

export function getIphoneClosureReadiness(options: {
  platform?: unknown;
  enrollmentConfirmed?: unknown;
  cedulaFrenteDataUrl?: unknown;
  cedulaRespaldoDataUrl?: unknown;
  selfieCedulaDataUrl?: unknown;
  fotoEntregaDataUrl?: unknown;
  fotoRemisionDataUrl?: unknown;
}) {
  const isIphone = isIphoneCreditPlatform(options.platform);
  const missingEvidence: IphoneClosureEvidenceKey[] = [
    ...getMissingIphoneIdentityEvidence(options),
    ...getMissingIphoneDeliveryEvidence(options),
  ];
  const requiredEvidenceCount = isIphone ? 5 : 0;
  const evidenceCount = requiredEvidenceCount - missingEvidence.length;
  const enrollmentConfirmed = !isIphone || Boolean(options.enrollmentConfirmed);
  const evidenceComplete = missingEvidence.length === 0;

  return {
    isIphone,
    enrollmentConfirmed,
    evidenceCount,
    requiredEvidenceCount,
    missingEvidence,
    evidenceComplete,
    complete: enrollmentConfirmed && evidenceComplete,
  };
}

export function isIphoneEquipmentCatalogBrand(value: unknown) {
  const normalized = sanitizeText(value)
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

export function isEquipmentCatalogItemAllowedForPlatform(
  item: { marca?: string | null } | null | undefined,
  platform?: unknown
) {
  if (!item) {
    return true;
  }

  const isIphoneBrand = isIphoneEquipmentCatalogBrand(item.marca);

  return isIphoneCreditPlatform(platform) ? isIphoneBrand : !isIphoneBrand;
}

export const CREDIT_DEVICE_PLATFORMS = ["ANDROID", "IPHONE"] as const;

export type CreditDevicePlatform = (typeof CREDIT_DEVICE_PLATFORMS)[number];

export type CreditEquipmentPlatformResolution =
  | { ok: true; platform: CreditDevicePlatform }
  | {
      ok: false;
      code:
        | "INVALID_DEVICE_PLATFORM"
        | "EQUIPMENT_CATALOG_NOT_FOUND"
        | "EQUIPMENT_CATALOG_INACTIVE"
        | "EQUIPMENT_CATALOG_IDENTITY_MISMATCH"
        | "EQUIPMENT_PLATFORM_MISMATCH";
      message: string;
    };

export function normalizeCreditDevicePlatform(
  value: unknown
): CreditDevicePlatform | null {
  const normalized = String(value ?? "").trim().toUpperCase();

  return normalized === "ANDROID" || normalized === "IPHONE"
    ? normalized
    : null;
}

function creditEquipmentIdentityKey(value: unknown) {
  return sanitizeText(value)
    .replace(/\s+/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

export function resolveCreditEquipmentPlatform(options: {
  requestedPlatform?: unknown;
  equipoMarca?: unknown;
  equipoModelo?: unknown;
  catalogItemId?: number | null;
  catalogItem?: {
    id?: number | null;
    marca?: string | null;
    modelo?: string | null;
    activo?: boolean | null;
  } | null;
}): CreditEquipmentPlatformResolution {
  const requestedPlatform = normalizeCreditDevicePlatform(
    options.requestedPlatform
  );

  if (!requestedPlatform) {
    return {
      ok: false,
      code: "INVALID_DEVICE_PLATFORM",
      message: "Selecciona una plataforma valida: ANDROID o IPHONE.",
    };
  }

  if (options.catalogItemId) {
    const item = options.catalogItem;

    if (!item || item.id !== options.catalogItemId) {
      return {
        ok: false,
        code: "EQUIPMENT_CATALOG_NOT_FOUND",
        message: "El equipo seleccionado ya no existe en el catalogo.",
      };
    }

    if (item.activo !== true) {
      return {
        ok: false,
        code: "EQUIPMENT_CATALOG_INACTIVE",
        message: "El equipo seleccionado esta inactivo en el catalogo.",
      };
    }

    if (
      creditEquipmentIdentityKey(item.marca) !==
        creditEquipmentIdentityKey(options.equipoMarca) ||
      creditEquipmentIdentityKey(item.modelo) !==
        creditEquipmentIdentityKey(options.equipoModelo)
    ) {
      return {
        ok: false,
        code: "EQUIPMENT_CATALOG_IDENTITY_MISMATCH",
        message:
          "La marca y el modelo enviados no coinciden con el equipo seleccionado del catalogo.",
      };
    }

    const catalogPlatform: CreditDevicePlatform =
      isIphoneEquipmentCatalogBrand(item.marca) ? "IPHONE" : "ANDROID";

    if (requestedPlatform !== catalogPlatform) {
      return {
        ok: false,
        code: "EQUIPMENT_PLATFORM_MISMATCH",
        message: `El equipo seleccionado corresponde a ${catalogPlatform} y no puede registrarse como ${requestedPlatform}.`,
      };
    }

    return { ok: true, platform: catalogPlatform };
  }

  const catalogMarcaKey = creditEquipmentIdentityKey(options.catalogItem?.marca);
  const catalogModeloKey = creditEquipmentIdentityKey(options.catalogItem?.modelo);
  const activeCatalogItemMatches =
    options.catalogItem?.activo === true &&
    Boolean(catalogMarcaKey) &&
    Boolean(catalogModeloKey) &&
    catalogMarcaKey === creditEquipmentIdentityKey(options.equipoMarca) &&
    catalogModeloKey === creditEquipmentIdentityKey(options.equipoModelo);

  if (activeCatalogItemMatches) {
    const catalogPlatform: CreditDevicePlatform =
      isIphoneEquipmentCatalogBrand(options.catalogItem?.marca)
        ? "IPHONE"
        : "ANDROID";

    if (requestedPlatform !== catalogPlatform) {
      return {
        ok: false,
        code: "EQUIPMENT_PLATFORM_MISMATCH",
        message: `El equipo corresponde a ${catalogPlatform} y no puede registrarse como ${requestedPlatform}.`,
      };
    }

    return { ok: true, platform: catalogPlatform };
  }
  if (
    isIphoneEquipmentCatalogBrand(options.equipoMarca) &&
    requestedPlatform !== "IPHONE"
  ) {
    return {
      ok: false,
      code: "EQUIPMENT_PLATFORM_MISMATCH",
      message:
        "Los equipos con marca IPHONE deben registrarse en la plataforma IPHONE.",
    };
  }

  return { ok: true, platform: requestedPlatform };
}
export function normalizeMoneyLimit(value: unknown, fallback: number) {
  const numericValue = Number(value);
  const numericFallback = Number(fallback);

  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.trunc(numericValue);
  }

  if (Number.isFinite(numericFallback) && numericFallback > 0) {
    return Math.trunc(numericFallback);
  }

  return 0;
}

export function resolveEffectiveDataCreditoFinancingLimit(options: {
  platform?: unknown;
  precioBaseVenta?: number | null;
  iphoneMaxFinancedAmount?: number | null | undefined;
  maxFinancedAmount?: number | null | undefined;
}) {
  const policyMaxFinancedAmount = normalizeMoneyLimit(
    options.maxFinancedAmount,
    0
  );

  if (policyMaxFinancedAmount <= 0) {
    return 0;
  }

  const iphoneFinancingLimit = normalizeMoneyLimit(
    options.iphoneMaxFinancedAmount,
    IPHONE_MAX_FINANCED_AMOUNT
  );
  const existingFinancingLimit = isIphoneCreditPlatform(options.platform)
    ? Math.min(
        iphoneFinancingLimit,
        normalizeMoneyLimit(options.precioBaseVenta, iphoneFinancingLimit)
      )
    : normalizeMoneyLimit(
        options.precioBaseVenta,
        MAX_DEVICE_FINANCING_BASE
      );

  return Math.min(policyMaxFinancedAmount, existingFinancingLimit);
}

export function calculateRequiredInitialPaymentByPlatform(options: {
  valorTotalEquipo: number | null | undefined;
  precioBaseVenta?: number | null;
  initialPaymentPercentage?: number | null | undefined;
  platform?: unknown;
  iphoneMaxFinancedAmount?: number | null | undefined;
  maxFinancedAmount?: number | null | undefined;
}) {
  const effectiveFinancingLimit =
    resolveEffectiveDataCreditoFinancingLimit(options);

  if (effectiveFinancingLimit > 0) {

    return calculateRequiredInitialPayment(
      options.valorTotalEquipo,
      effectiveFinancingLimit,
      options.initialPaymentPercentage ?? DEFAULT_INITIAL_PAYMENT_PERCENTAGE
    );
  }

  if (!isIphoneCreditPlatform(options.platform)) {
    return calculateRequiredInitialPayment(
      options.valorTotalEquipo,
      options.precioBaseVenta,
      options.initialPaymentPercentage ?? DEFAULT_INITIAL_PAYMENT_PERCENTAGE
    );
  }

  const total = Math.max(0, Number(options.valorTotalEquipo || 0));
  const percentage = Math.max(
    0,
    Math.min(100, Number(options.initialPaymentPercentage ?? IPHONE_INITIAL_PAYMENT_PERCENTAGE))
  );
  const maxFinanced = normalizeMoneyLimit(
    options.iphoneMaxFinancedAmount,
    IPHONE_MAX_FINANCED_AMOUNT
  );
  const percentageInitial = (total * percentage) / 100;
  const excessInitial = maxFinanced > 0 ? Math.max(0, total - maxFinanced) : 0;
  const initial = Math.max(percentageInitial, excessInitial);

  return Math.round(initial * 100) / 100;
}

function formatCopLimit(value: number) {
  return `$ ${Math.round(Math.max(0, Number(value || 0))).toLocaleString("es-CO")}`;
}

export function getIphoneInstallmentLimitMessage(options: {
  valorCuota: number | null | undefined;
  iphoneMaxInstallmentValue: number | null | undefined;
}) {
  const valorCuota = Math.max(0, Number(options.valorCuota || 0));
  const maxInstallment = normalizeMoneyLimit(
    options.iphoneMaxInstallmentValue,
    IPHONE_MAX_INSTALLMENT_VALUE
  );

  return `La cuota iPhone queda en ${formatCopLimit(valorCuota)} y supera el tope configurado de ${formatCopLimit(maxInstallment)}. Aumenta la inicial o el plazo para continuar.`;
}

export function validateIphoneInstallmentLimit(options: {
  platform?: unknown;
  valorCuota: number | null | undefined;
  iphoneMaxInstallmentValue?: number | null | undefined;
}) {
  const maxInstallment = normalizeMoneyLimit(
    options.iphoneMaxInstallmentValue,
    IPHONE_MAX_INSTALLMENT_VALUE
  );
  const valorCuota = Math.max(0, Number(options.valorCuota || 0));
  const exceeded =
    isIphoneCreditPlatform(options.platform) &&
    maxInstallment > 0 &&
    valorCuota > maxInstallment;

  return {
    exceeded,
    maxInstallment,
    valorCuota,
    message: exceeded
      ? getIphoneInstallmentLimitMessage({
          valorCuota,
          iphoneMaxInstallmentValue: maxInstallment,
        })
      : "",
  };
}

export function getDefaultFirstPaymentDate(
  from: Date | number | string = new Date(),
  frequency: unknown = DEFAULT_PAYMENT_FREQUENCY
) {
  const normalized = normalizeColombiaInstantAtNoon(from);
  const dueDate =
    normalizePaymentFrequency(frequency) === "QUINCENAL"
      ? getQuincenalFirstPaymentDateObject(normalized)
      : addPaymentFrequency(normalized, frequency, 1);

  return dueDate.toISOString().slice(0, 10);
}

export function getDefaultFirstPaymentDateObject(
  frequency: unknown = DEFAULT_PAYMENT_FREQUENCY,
  from: Date | number | string = new Date()
) {
  const normalized = normalizeColombiaInstantAtNoon(from);

  if (normalizePaymentFrequency(frequency) === "QUINCENAL") {
    return getQuincenalFirstPaymentDateObject(normalized);
  }

  return addPaymentFrequency(normalized, frequency, 1);
}

export function calculateInstallmentValue(
  saldoFinanciado: number | null | undefined,
  cuotas: number | null | undefined
) {
  const saldo = Math.max(0, Number(saldoFinanciado || 0));
  const totalCuotas = Math.max(0, Math.trunc(Number(cuotas || 0)));

  if (totalCuotas <= 0) {
    return saldo;
  }

  return Math.round((saldo / totalCuotas) * 100) / 100;
}

export function annualEffectiveToMonthlyEffectiveRate(
  annualRateEaPercent: number | null | undefined
) {
  const annualRate = Math.max(0, Number(annualRateEaPercent || 0)) / 100;
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  return Math.round(monthlyRate * 1000000) / 1000000;
}

export function annualEffectiveToPeriodicEffectiveRate(
  annualRateEaPercent: number | null | undefined,
  periodsPerYear: number | null | undefined
) {
  const annualRate = Math.max(0, Number(annualRateEaPercent || 0)) / 100;
  const periods = Math.max(1, Number(periodsPerYear || 1));
  const periodicRate = Math.pow(1 + annualRate, 1 / periods) - 1;
  return Math.round(periodicRate * 1000000) / 1000000;
}

export function calculateCreditCharges(options: {
  saldoBaseFinanciado?: number | null;
  cuotas?: number | null;
  tasaInteresEa?: number | null;
  fianzaPorcentaje?: number | null;
  frecuenciaPago?: string | null;
}) {
  const saldoBaseFinanciado = Math.max(0, Number(options.saldoBaseFinanciado || 0));
  const cuotas = Math.max(0, Math.trunc(Number(options.cuotas || 0)));
  const tasaInteresEa = Math.max(
    0,
    Number(options.tasaInteresEa ?? DEFAULT_LEGAL_CONSUMER_RATE_EA)
  );
  const fianzaPorcentaje = Math.max(
    0,
    Number(options.fianzaPorcentaje ?? DEFAULT_FIANCO_SURETY_PERCENTAGE)
  );
  const frecuenciaPago = normalizePaymentFrequency(options.frecuenciaPago);
  const tasaMensual = annualEffectiveToMonthlyEffectiveRate(tasaInteresEa);
  const tasaPeriodo = annualEffectiveToPeriodicEffectiveRate(
    tasaInteresEa,
    getPaymentFrequencyPeriodsPerYear(frecuenciaPago)
  );
  const valorInteres =
    Math.round(saldoBaseFinanciado * tasaPeriodo * Math.max(1, cuotas) * 100) / 100;
  const valorFianza =
    Math.round((saldoBaseFinanciado * fianzaPorcentaje) / 100 * 100) / 100;
  const montoCreditoTotal =
    Math.round((saldoBaseFinanciado + valorInteres + valorFianza) * 100) / 100;
  const valorCuota =
    cuotas > 0 ? Math.round((montoCreditoTotal / cuotas) * 100) / 100 : montoCreditoTotal;

  return {
    saldoBaseFinanciado,
    cuotas,
    tasaInteresEa,
    tasaMensual,
    tasaPeriodo,
    frecuenciaPago,
    valorInteres,
    fianzaPorcentaje,
    valorFianza,
    montoCreditoTotal,
    valorCuota,
  };
}

export function sanitizeImageDataUrl(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(normalized)) {
    return "";
  }

  if (normalized.length > 2_500_000) {
    return "";
  }

  return normalized;
}

export function sanitizeVideoDataUrl(value: unknown) {
  const normalized = String(value ?? "").trim();

  if (!/^data:video\/(webm|mp4|ogg|quicktime|mov|x-m4v);base64,/i.test(normalized)) {
    return "";
  }

  if (normalized.length > MAX_VIDEO_DATA_URL_LENGTH) {
    return "";
  }

  return normalized;
}

export function resolveCreditPaymentSummary(options: {
  montoCredito?: number | null;
  cuotaInicial?: number | null;
  totalAbonado?: number | null;
  abonosCount?: number | null;
}) {
  const montoCredito = Math.max(0, Number(options.montoCredito || 0));
  const cuotaInicial = Math.max(0, Number(options.cuotaInicial || 0));
  const totalAbonado = Math.max(0, Number(options.totalAbonado || 0));
  const saldoPendiente = Math.max(0, montoCredito - totalAbonado);
  const porcentajeRecaudado =
    montoCredito > 0 ? Math.min(100, Math.round((totalAbonado / montoCredito) * 100)) : 0;

  return {
    abonosCount: Math.max(0, Number(options.abonosCount || 0)),
    cuotaInicial,
    montoCredito,
    porcentajeRecaudado,
    saldoPendiente,
    totalAbonado,
    totalRecaudado: totalAbonado,
  };
}

export function creditCajaConcept(method: string) {
  return method === "EFECTIVO" ? "ABONO CREDITO EFECTIVO" : "ABONO CREDITO";
}

export function creditCajaDescription(abono: {
  id: number;
  creditoFolio: string;
  clienteNombre: string;
  metodoPago: string;
  observacion?: string | null;
}) {
  const parts = [
    `${CREDIT_ABONO_CAJA_MARKER}${abono.id}`,
    `Folio: ${abono.creditoFolio}`,
    `Cliente: ${abono.clienteNombre}`,
    `Metodo: ${abono.metodoPago}`,
  ];

  if (abono.observacion) {
    parts.push(`Obs: ${abono.observacion}`);
  }

  return parts.join(" | ");
}
