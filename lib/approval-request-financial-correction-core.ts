import { calculateFrenchAmortization } from "@/lib/credit-amortization";
import { normalizePaymentFrequency, resolveRequiredInitialPaymentByPlatform, validateIphoneInstallmentLimit } from "@/lib/credit-factory";
import { hasCurrentCreditOriginationTerms } from "@/lib/credit-current-origination-terms";
import type { ResolvedCreditPolicyFinancialSettings } from "@/lib/credit-policy-financial-settings";

export const REQUEST_FINANCIAL_FIELDS = ["valorEquipoTotal", "cuotaInicial", "plazoMeses"] as const;
export const REQUEST_FINANCIAL_SYNC_FIELDS = [...REQUEST_FINANCIAL_FIELDS,
  "frecuenciaPago", "fechaPrimerPago", "tasaInteresEa", "fianzaPorcentaje", "fianzaCuotaPorcentaje",
  "seguroCuotaPorcentaje", "metodoCalculo", "calculoVersion", "cuotaExacta", "cuotaComercial",
  "valorCuota", "saldoBaseFinanciado", "montoCreditoTotal"] as const;
const invalidatedFinancialFields = ["financialTermsSeal", "fotoRemisionDataUrl", "fotoRemisionCapturedAt", "fotoRemisionSource"] as const;
const syncFields = new Set<string>(REQUEST_FINANCIAL_SYNC_FIELDS);

export type RequestFinancialConfig = {
  platform: "ANDROID" | "IPHONE";
  initialPaymentPercentage: number;
  catalogBasePrice: number | null;
  iphoneMaxFinancedAmount: number;
  maxFinancedAmount: number | null;
  maxInstallments: number;
  maxInstallmentAmount: number | null;
  financialSettings: ResolvedCreditPolicyFinancialSettings;
  firstPaymentDateKey: string;
};
export type RequestFinancialPreview = {
  valorVenta: number; cuotaInicial: number; valorFinanciado: number; numeroCuotas: number;
  valorCuota: number; totalPagar: number; frecuenciaPago: string; fechaPrimerPago: string; initialMinimum: number;
};
export type RequestFinancialCorrectionInput = {
  values: Record<string, string>; expectedValues: Record<string, string>; expectedRevision: number;
  expectedConfigVersion: string; reason: string; confirmed: true;
};
export class RequestFinancialCorrectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message); this.name = "RequestFinancialCorrectionError";
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return value === null || value === undefined ? "" : String(value).trim(); }
export function requestFinancialRevision(payload: Record<string, unknown>) {
  return Number.isSafeInteger(payload.analystFinancialRevision) && Number(payload.analystFinancialRevision) >= 0
    ? Number(payload.analystFinancialRevision) : 0;
}
export function requestFinancialValues(payload: Record<string, unknown>) {
  return Object.fromEntries(REQUEST_FINANCIAL_SYNC_FIELDS.map((field) => [field, text(payload[field])]));
}
export function requestFinancialEligibility(input: { open: boolean; expired: boolean; signatureStarted: boolean; correctionPending: boolean }) {
  const reason = !input.open ? "La solicitud está cerrada o ya se convirtió en crédito. Sus condiciones no se pueden modificar aquí."
    : input.expired ? "La solicitud está vencida. No se pueden corregir sus condiciones."
    : input.signatureStarted || input.correctionPending
      ? "El contrato ya tiene un envío o una corrección en curso. El administrador central debe revisar los valores y generar una nueva versión para firma."
      : null;
  return { editableFields: reason ? [] : [...REQUEST_FINANCIAL_FIELDS], reason,
    canManageContract: false };
}
export function parseRequestFinancialCorrection(value: unknown): RequestFinancialCorrectionInput {
  const body = record(value), values = record(body.values), expected = record(body.expectedValues);
  if (Object.keys(body).some((key) => !["values", "expectedValues", "expectedRevision", "expectedConfigVersion", "reason", "confirmed"].includes(key)) ||
    !Object.keys(values).length || Object.keys(values).some((field) => !(REQUEST_FINANCIAL_FIELDS as readonly string[]).includes(field) ||
      typeof values[field] !== "string") || REQUEST_FINANCIAL_FIELDS.some((field) => typeof expected[field] !== "string") ||
    Object.keys(expected).some((field) => !(REQUEST_FINANCIAL_FIELDS as readonly string[]).includes(field)))
    throw new RequestFinancialCorrectionError("INVALID_FIELDS", "Selecciona únicamente valor de venta, inicial o número de cuotas.", 400);
  if (body.confirmed !== true)
    throw new RequestFinancialCorrectionError("CONFIRMATION_REQUIRED", "Confirma los nuevos valores calculados antes de guardar.", 400);
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || !/^[a-f0-9]{64}$/.test(text(body.expectedConfigVersion)))
    throw new RequestFinancialCorrectionError("INVALID_REVISION", "Actualiza las condiciones antes de corregirlas.", 400);
  const reason = text(body.reason).normalize("NFKC").replace(/\s+/g, " ");
  if (reason.length < 5 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason))
    throw new RequestFinancialCorrectionError("INVALID_REASON", "Describe el motivo en 5 a 500 caracteres.", 400);
  return { values: values as Record<string, string>, expectedValues: expected as Record<string, string>,
    expectedRevision: Number(body.expectedRevision), expectedConfigVersion: text(body.expectedConfigVersion), reason, confirmed: true };
}
function integer(value: unknown, field: string, min: number, max: number) {
  const raw = text(value), parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new RequestFinancialCorrectionError("INVALID_VALUE", `${field} debe ser un número entero entre ${min} y ${max}.`, 422);
  return parsed;
}

/** The same policy resolver and amortization engine used by sale preview and FirmaSeguro. */
export function calculateRequestFinancialTerms(source: Record<string, unknown>, config: RequestFinancialConfig) {
  const valorVenta = integer(source.valorEquipoTotal, "El valor de venta", 1, 2_000_000_000);
  const cuotaInicial = integer(source.cuotaInicial, "La inicial", 0, 2_000_000_000);
  const numeroCuotas = integer(source.plazoMeses, "El número de cuotas", 1, config.maxInstallments);
  if (cuotaInicial >= valorVenta)
    throw new RequestFinancialCorrectionError("INVALID_INITIAL", "La inicial debe ser menor que el valor de venta.", 422);
  const initialMinimum = resolveRequiredInitialPaymentByPlatform({ valorTotalEquipo: valorVenta,
    precioBaseVenta: config.catalogBasePrice, initialPaymentPercentage: config.initialPaymentPercentage,
    platform: config.platform, iphoneMaxFinancedAmount: config.iphoneMaxFinancedAmount,
    maxFinancedAmount: config.maxFinancedAmount }).requiredInitialPayment;
  if (cuotaInicial < initialMinimum)
    throw new RequestFinancialCorrectionError("INITIAL_BELOW_MINIMUM", `La política requiere una inicial mínima de $ ${initialMinimum.toLocaleString("es-CO")}.`, 422);
  if (config.maxFinancedAmount !== null && valorVenta - cuotaInicial > config.maxFinancedAmount)
    throw new RequestFinancialCorrectionError("FINANCING_LIMIT_EXCEEDED", "El monto financiado supera el autorizado por la precalificación.", 422);
  const settings = { ...config.financialSettings,
    fianzaCuotaPorcentaje: config.financialSettings.fianzaModalidad === "TOTAL_CREDITO"
      ? Number(config.financialSettings.fianzaTotalPorcentaje) / numeroCuotas : config.financialSettings.fianzaCuotaPorcentaje };
  if (!hasCurrentCreditOriginationTerms(settings))
    throw new RequestFinancialCorrectionError("DATACREDITO_FINANCIAL_TERMS_OUTDATED", "Renueva la oferta vigente antes de modificar estas condiciones.", 409);
  const frecuenciaPago = normalizePaymentFrequency(settings.frecuenciaPago);
  const plan = calculateFrenchAmortization({ valorVenta, cuotaInicial, numeroCuotas,
    tasaInteresEa: settings.tasaInteresEa, fianzaCuotaPorcentaje: settings.fianzaCuotaPorcentaje,
    seguroCuotaPorcentaje: settings.seguroCuotaPorcentaje, calculoVersion: settings.calculoVersion,
    tasaPeriodoDecimales: settings.tasaPeriodoDecimales, redondeoComercial: settings.redondeoComercial,
    frecuenciaPago, fechaPrimerPago: config.firstPaymentDateKey });
  const limit = validateIphoneInstallmentLimit({ platform: config.platform, valorCuota: plan.cuotaCobro,
    enforceFactoryRange: true, iphoneMaxInstallmentValue: config.maxInstallmentAmount });
  if (limit.outsideRange) throw new RequestFinancialCorrectionError("INSTALLMENT_LIMIT", limit.message, 422);
  const values: Record<string, string> = {
    valorEquipoTotal: String(valorVenta), cuotaInicial: String(cuotaInicial), plazoMeses: String(numeroCuotas),
    frecuenciaPago, fechaPrimerPago: config.firstPaymentDateKey, tasaInteresEa: String(plan.tasaInteresEa),
    fianzaPorcentaje: String(settings.fianzaTotalPorcentaje ?? plan.fianzaCuotaPorcentaje * numeroCuotas),
    fianzaCuotaPorcentaje: String(plan.fianzaCuotaPorcentaje), seguroCuotaPorcentaje: String(plan.seguroCuotaPorcentaje),
    metodoCalculo: plan.metodo, calculoVersion: plan.version, cuotaExacta: String(plan.cuotaTotal),
    cuotaComercial: String(plan.cuotaComercial), valorCuota: String(plan.cuotaCobro),
    saldoBaseFinanciado: String(plan.valorFinanciado), montoCreditoTotal: String(plan.montoTotal),
  };
  const preview: RequestFinancialPreview = { valorVenta, cuotaInicial, valorFinanciado: plan.valorFinanciado,
    numeroCuotas, valorCuota: plan.cuotaCobro, totalPagar: plan.montoTotal, frecuenciaPago,
    fechaPrimerPago: config.firstPaymentDateKey, initialMinimum };
  return { values, preview };
}

export function applyRequestFinancialCorrection(payload: Record<string, unknown>, input: RequestFinancialCorrectionInput,
  config: RequestFinancialConfig, configVersion: string, actorName: string, now = new Date()) {
  const revision = requestFinancialRevision(payload);
  if (input.expectedRevision !== revision || input.expectedConfigVersion !== configVersion)
    throw new RequestFinancialCorrectionError("REQUEST_CHANGED", "Las condiciones o la política cambiaron. Actualiza y revisa los valores antes de guardar.");
  const merged = { ...payload }; let changes = false;
  // All source fields must match the reviewed baseline: a change to initial or term changes the resulting quota.
  for (const field of REQUEST_FINANCIAL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input.expectedValues, field) && text(payload[field]) !== text(input.expectedValues[field]))
      throw new RequestFinancialCorrectionError("REQUEST_CHANGED", "El asesor cambió las condiciones. Actualiza y revisa los nuevos valores.");
    if (Object.prototype.hasOwnProperty.call(input.values, field)) {
      if (text(payload[field]) !== text(input.expectedValues[field]))
        throw new RequestFinancialCorrectionError("REQUEST_CHANGED", "El asesor cambió las condiciones. Actualiza antes de guardar.");
      changes ||= text(input.values[field]) !== text(payload[field]); merged[field] = input.values[field];
    }
  }
  if (!changes) throw new RequestFinancialCorrectionError("NO_CHANGES", "Modifica una condición antes de guardar.", 400);
  const result = calculateRequestFinancialTerms(merged, config);
  const before = requestFinancialValues(payload), after = result.values;
  const next: Record<string, unknown> = { ...payload, ...after };
  for (const field of invalidatedFinancialFields) delete next[field];
  const previous = record(payload.analystFinancialCorrection);
  const fields = [...new Set([...(Array.isArray(previous.fields) ? previous.fields.filter((field): field is string =>
    typeof field === "string" && syncFields.has(field)) : []), ...REQUEST_FINANCIAL_SYNC_FIELDS])];
  const fieldRevisions = { ...record(previous.fieldRevisions),
    ...Object.fromEntries(fields.map((field) => [field, revision + 1])) };
  next.analystFinancialRevision = revision + 1;
  next.analystFinancialCorrection = { revision: revision + 1, fields, fieldRevisions,
    values: Object.fromEntries(fields.map((field) => [field, text(next[field])])),
    invalidatedFields: [...invalidatedFinancialFields], updatedAt: now.toISOString(), actorName };
  return { payload: next, before, after, revision: revision + 1, preview: result.preview };
}

/** Old browser tabs cannot undo a correction or bring its previous plan/remission back. */
export function preserveAnalystFinancialCorrectionAutosave(stored: Record<string, unknown>, incoming: Record<string, unknown>) {
  const payload = { ...incoming };
  delete payload.analystFinancialRevision; delete payload.analystFinancialCorrection;
  const revision = requestFinancialRevision(stored);
  if (!revision) return payload;
  const correction = record(stored.analystFinancialCorrection);
  const fields = Array.isArray(correction.fields) ? correction.fields.filter((field): field is string =>
    typeof field === "string" && syncFields.has(field)) : [];
  const acknowledged = incoming.analystFinancialRevision === revision;
  for (const field of fields) if (!acknowledged || !Object.prototype.hasOwnProperty.call(payload, field)) payload[field] = stored[field];
  // The seal is server-owned even after acknowledgement. Later dispatch restores the new authoritative seal.
  if (Object.prototype.hasOwnProperty.call(stored, "financialTermsSeal")) payload.financialTermsSeal = stored.financialTermsSeal;
  else delete payload.financialTermsSeal;
  if (!acknowledged) for (const field of invalidatedFinancialFields) {
    if (Object.prototype.hasOwnProperty.call(stored, field)) payload[field] = stored[field]; else delete payload[field];
  }
  payload.analystFinancialRevision = revision;
  payload.analystFinancialCorrection = { ...correction, revision, fields,
    values: Object.fromEntries(fields.map((field) => [field, text(payload[field])])) };
  return payload;
}
