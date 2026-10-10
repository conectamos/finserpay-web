import { generatePaymentReference, sanitizeImageDataUrl, sanitizeText } from "@/lib/credit-factory";
import { composeCreditClientName } from "@/lib/credit-client-name";
import { readFinancingTermsSeal, resealFinancingTermsIdentity,
  type FinancingTermsSeal } from "@/lib/credit-amortization-contract";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

export type FrozenDraftClientCorrectionValues = Record<string, string>;
export type FrozenDraftClientCorrection = {
  correlationId: string;
  draftId: number;
  previousProcessUuid: string;
  sourceSealChecksum: string;
  before: FrozenDraftClientCorrectionValues;
  after: FrozenDraftClientCorrectionValues;
};
export type FrozenClientCorrectionSource = {
  correlationId: string;
  processUuid: string;
  sourceChecksum: string;
  targetChecksum: string;
};
type Draft = {
  id: number; payload: unknown; usuarioNombre?: string | null; usuarioLogin?: string | null;
  vendedorId?: number | null; vendedorNombre?: string | null; vendedorDocumento?: string | null;
  vendedorTelefono?: string | null; vendedorEmail?: string | null; sedeNombre?: string | null;
  sedeCodigo?: string | null; sedeAliadoId?: number | null;
};
type CorrectionSource = Pick<FirmaSeguroProcessRow,
  "processUuid" | "draftPayload" | "draftFolio" | "signedDocumentBase64" | "completedAt" | "createdAt">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHECKSUM = /^[a-f0-9]{64}$/i;
const CLIENT_FIELDS = [
  "clienteDocumento", "clienteNombre", "clientePrimerNombre", "clientePrimerApellido", "clienteSegundoApellido",
  "clienteFechaNacimiento", "clienteTelefono", "clienteCorreo", "clienteDireccion",
  "clienteDepartamento", "clienteCiudad",
] as const;
const LOCKED_FIELDS = [
  "clienteDocumento", "clienteTipoDocumento", "clientePrimerApellido",
  "equipoMarca", "equipoModelo", "referenciaEquipo", "equipoCatalogoId", "imei", "deviceUid",
  "plataformaDispositivo", "dataCreditoAssessmentId", "valorEquipoTotal", "cuotaInicial", "plazoMeses",
  "frecuenciaPago", "fechaPrimerPago", "valorCuota", "valorCuotaComercial", "montoCredito",
  "montoFinanciado", "saldoBaseFinanciado", "calculoVersion", "cuotaTotalExacta", "cuotaComercial",
  "cuotaPactada", "totalPagarExacto", "descuentoRedondeo", "tasaInteresEa", "tasaPeriodo",
  "fianzaCuotaPorcentaje", "fianzaTotalPorcentaje", "fianzaModalidad", "fianzaFuente",
  "seguroCuotaPorcentaje", "redondeoComercialModo", "redondeoComercialMultiplo",
  "tasaPeriodoDecimales", "policyVersion", "policyRevisionId",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }
function normalized(value: unknown) { return text(value).normalize("NFKC").replace(/\s+/g, " ").toUpperCase(); }
function number(value: unknown) {
  const parsed = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_INVALID");
  return parsed;
}
function sameNumber(value: unknown, sealed: unknown, tolerance = 0.000001) {
  if (Math.abs(number(value) - number(sealed)) > tolerance)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
}
function calendarDate(value: unknown) {
  const key = text(value);
  const date = new Date(`${key}T12:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== key)
    throw new Error("FIRMASEGURO_FIRST_PAYMENT_DATE_INVALID");
  return key;
}

/** The marker is not authorization: its immutable audit row is also required. */
export function readFrozenClientCorrectionSource(value: unknown, targetValue: unknown): FrozenClientCorrectionSource | null {
  const marker = record(value);
  const target = readFinancingTermsSeal(targetValue);
  if (!target || typeof marker.correlationId !== "string" || !UUID.test(marker.correlationId) ||
      typeof marker.processUuid !== "string" || !marker.processUuid.trim() ||
      typeof marker.sourceChecksum !== "string" || !CHECKSUM.test(marker.sourceChecksum) ||
      marker.targetChecksum !== target.checksum) return null;
  try { calendarDate(target.snapshot.fechaPrimerPago); } catch { return null; }
  return marker as FrozenClientCorrectionSource;
}

/**
 * A client correction uses the previous provider contract, signed or pending.
 * Only audit-bound client fields can change; every financial seal field and
 * the original equipment, IMEI, document and first surname remain unchanged.
 */
export function buildFrozenDraftClientCorrection(input: {
  draft: Draft; source: CorrectionSource; correction: FrozenDraftClientCorrection;
}) {
  const current = record(input.draft.payload), previous = record(input.source.draftPayload);
  const sourceSeal = readFinancingTermsSeal(previous.financialTermsSeal);
  if (!sourceSeal || !input.source.draftFolio || input.source.draftFolio !== sourceSeal.snapshot.folio)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_SOURCE_INVALID");
  const signed = input.source.signedDocumentBase64
    ? Buffer.from(input.source.signedDocumentBase64, "base64") : null;
  if ((signed || input.source.completedAt) &&
      (!signed || signed.subarray(0, 5).toString() !== "%PDF-" || !input.source.completedAt ||
       !Number.isFinite(new Date(input.source.completedAt).getTime())))
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_SOURCE_INVALID");
  const correction = input.correction;
  if (!UUID.test(correction.correlationId) || correction.draftId !== input.draft.id ||
      correction.previousProcessUuid !== input.source.processUuid ||
      correction.sourceSealChecksum !== sourceSeal.checksum)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_AUDIT_INVALID");
  for (const field of CLIENT_FIELDS) {
    if (typeof correction.before[field] !== "string" || typeof correction.after[field] !== "string" ||
        text(current[field]) !== text(correction.after[field]) ||
        (Object.hasOwn(previous, field) && text(previous[field]) !== text(correction.before[field])))
      throw new Error("FIRMASEGURO_CLIENT_CORRECTION_AUDIT_INVALID");
  }
  if (text(correction.before.clientePrimerApellido) !== text(correction.after.clientePrimerApellido) ||
      !text(correction.after.clientePrimerApellido) ||
      normalized(correction.after.clienteNombre) !== normalized(composeCreditClientName({
        firstNames: correction.after.clientePrimerNombre, firstSurname: correction.after.clientePrimerApellido,
        secondSurname: correction.after.clienteSegundoApellido,
      }))) throw new Error("FIRMASEGURO_CLIENT_CORRECTION_IDENTITY_INVALID");
  for (const field of LOCKED_FIELDS) {
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(previous[field] ?? null))
      throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  }
  if (current.financialTermsSeal !== undefined && current.financialTermsSeal !== null &&
      readFinancingTermsSeal(current.financialTermsSeal)?.checksum !== sourceSeal.checksum)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  const terms = sourceSeal.snapshot;
  for (const [field, sealed] of [
    ["clienteDocumento", terms.documento], ["clienteTipoDocumento", terms.tipoDocumento],
    ["equipoMarca", terms.equipoMarca], ["equipoModelo", terms.equipoModelo],
    ["referenciaEquipo", terms.referenciaEquipo],
  ] as const) {
    if (!normalized(sealed) || normalized(previous[field]) !== normalized(sealed))
      throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  }
  for (const [field, sealed] of [
    ["valorEquipoTotal", terms.valorVenta], ["cuotaInicial", terms.cuotaInicial], ["plazoMeses", terms.numeroCuotas],
  ] as const) sameNumber(previous[field], sealed);
  for (const [field, sealed] of [
    ["valorCuota", terms.calculoVersion === "ARES_FRANCES_V2" ? terms.cuotaPactada : terms.cuotaTotalExacta],
    ["valorCuotaComercial", terms.cuotaComercial], ["saldoBaseFinanciado", terms.valorFinanciado],
    ["montoFinanciado", terms.valorFinanciado], ["cuotaTotalExacta", terms.cuotaTotalExacta],
    ["cuotaComercial", terms.cuotaComercial], ["tasaInteresEa", terms.tasaInteresEa], ["tasaPeriodo", terms.tasaPeriodo],
    ["fianzaCuotaPorcentaje", terms.fianzaCuotaPorcentaje], ["fianzaTotalPorcentaje", terms.fianzaTotalPorcentaje],
    ["seguroCuotaPorcentaje", terms.seguroCuotaPorcentaje], ["redondeoComercialMultiplo", terms.redondeoComercialMultiplo],
    ["tasaPeriodoDecimales", terms.tasaPeriodoDecimales],
    ...(terms.calculoVersion === "ARES_FRANCES_V2" ? [
      ["cuotaPactada", terms.cuotaPactada], ["totalPagarExacto", terms.totalPagarExacto],
      ["descuentoRedondeo", terms.descuentoRedondeo],
    ] as const : []),
  ] as const) if (Object.hasOwn(previous, field)) sameNumber(previous[field], sealed);
  if (Object.hasOwn(previous, "montoCredito")) sameNumber(previous.montoCredito, terms.totalPagar, 0.005001);
  if (!/^\d{15}$/.test(terms.imei) || sanitizeText(previous.imei || previous.deviceUid).replace(/\D/g, "") !== terms.imei ||
      (previous.deviceUid && sanitizeText(previous.deviceUid).replace(/\D/g, "") !== terms.imei) ||
      normalized(correction.before.clienteNombre) !== normalized(terms.clienteNombre) ||
      normalized(correction.before.clienteDireccion) !== normalized(terms.clienteDireccion) ||
      text(correction.before.clienteTelefono) !== terms.clienteTelefono ||
      text(correction.before.clienteCorreo).toLowerCase() !== terms.clienteCorreo ||
      !["MENSUAL", "QUINCENAL", "SEMANAL"].includes(terms.frecuenciaPago) ||
      !Number.isInteger(terms.numeroCuotas) || terms.numeroCuotas < 1 ||
      number(terms.valorVenta) <= number(terms.cuotaInicial))
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  if (Object.hasOwn(previous, "frecuenciaPago") && normalized(previous.frecuenciaPago) !== terms.frecuenciaPago)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  const firstPaymentDateKey = calendarDate(terms.fechaPrimerPago);
  if (previous.fechaPrimerPago && text(previous.fechaPrimerPago).slice(0, 10) !== firstPaymentDateKey)
    throw new Error("FIRMASEGURO_CLIENT_CORRECTION_TERMS_CHANGED");
  const createdAt = new Date(input.source.createdAt);
  if (!Number.isFinite(createdAt.getTime())) throw new Error("FIRMASEGURO_CLIENT_CORRECTION_SOURCE_INVALID");
  const seal = resealFinancingTermsIdentity(sourceSeal, {
    folio: terms.folio, imei: terms.imei,
    clienteNombre: correction.after.clienteNombre, clienteTelefono: correction.after.clienteTelefono,
    clienteCorreo: correction.after.clienteCorreo, clienteDireccion: correction.after.clienteDireccion,
  });
  const corrected = seal.snapshot;
  const commercial = corrected.calculoVersion === "ARES_FRANCES_V2";
  const cuota = number(commercial ? corrected.cuotaPactada : corrected.cuotaTotalExacta);
  const credit: CreditForFirmaSeguroPdf = {
    folio: corrected.folio,
    contratoSnapshot: {
      borradorId: input.draft.id, origen: "BORRADOR_FIRMASEGURO_CORRECCION_CLIENTE",
      ...(previous.firmaSeguroContractNameVersion === 1 &&
        ["clienteNombre", "clientePrimerNombre", "clientePrimerApellido", "clienteSegundoApellido"]
          .every(field => normalized(correction.before[field]) === normalized(correction.after[field]))
        ? { firmaSeguroContractNameVersion: 1, firmaSeguroIdentity: previous.firmaSeguroIdentity }
        : {}),
      financiero: {
        calculoVersion: corrected.calculoVersion, cuotaPactada: cuota,
        cuotaTotalExacta: number(corrected.cuotaTotalExacta), cuotaComercial: number(corrected.cuotaComercial),
        ...(commercial ? { totalPagarExacto: number(corrected.totalPagarExacto),
          descuentoRedondeo: number(corrected.descuentoRedondeo) } : {}),
      },
    },
    clienteTipoDocumento: corrected.tipoDocumento, clienteNombre: corrected.clienteNombre,
    clientePrimerNombre: correction.after.clientePrimerNombre,
    clientePrimerApellido: correction.after.clientePrimerApellido,
    clienteDocumento: corrected.documento, clienteTelefono: corrected.clienteTelefono,
    clienteCorreo: corrected.clienteCorreo, clienteDireccion: corrected.clienteDireccion,
    referenciaEquipo: corrected.referenciaEquipo, equipoMarca: corrected.equipoMarca, equipoModelo: corrected.equipoModelo,
    imei: corrected.imei, deviceUid: corrected.imei,
    valorEquipoTotal: number(corrected.valorVenta), cuotaInicial: number(corrected.cuotaInicial),
    montoCredito: number(corrected.totalPagar), valorCuota: cuota,
    valorCuotaComercial: number(corrected.cuotaComercial), calculoVersion: corrected.calculoVersion,
    cuotaTotalExacta: number(corrected.cuotaTotalExacta),
    ...(commercial ? { descuentoRedondeo: number(corrected.descuentoRedondeo) } : {}),
    tasaInteresEa: number(corrected.tasaInteresEa), tasaPeriodo: number(corrected.tasaPeriodo),
    fianzaCuotaPorcentaje: number(corrected.fianzaCuotaPorcentaje), fianzaTotalPorcentaje: number(corrected.fianzaTotalPorcentaje),
    fianzaModalidad: corrected.fianzaModalidad, seguroCuotaPorcentaje: number(corrected.seguroCuotaPorcentaje),
    redondeoComercialModo: corrected.redondeoComercialModo, redondeoComercialMultiplo: corrected.redondeoComercialMultiplo,
    valorFianza: number(corrected.cuotaFianzaExacta) * corrected.numeroCuotas,
    valorSeguro: number(corrected.cuotaSeguroExacta) * corrected.numeroCuotas,
    plazoMeses: corrected.numeroCuotas, frecuenciaPago: corrected.frecuenciaPago,
    fechaPrimerPago: firstPaymentDateKey, fechaCredito: createdAt,
    referenciaPago: generatePaymentReference(corrected.folio, corrected.documento),
    contratoIp: sanitizeText(current.contratoIp) || null,
    contratoFotoDataUrl: sanitizeImageDataUrl(current.contratoSelfieDataUrl || current.contratoFotoDataUrl),
    contratoSelfieDataUrl: sanitizeImageDataUrl(current.contratoSelfieDataUrl || current.contratoFotoDataUrl),
    contratoCedulaFrenteDataUrl: sanitizeImageDataUrl(current.contratoCedulaFrenteDataUrl || current.cedulaFrenteDataUrl),
    contratoCedulaRespaldoDataUrl: sanitizeImageDataUrl(current.contratoCedulaRespaldoDataUrl || current.cedulaRespaldoDataUrl),
    usuario: { nombre: input.draft.usuarioNombre || "Usuario FINSER PAY", usuario: input.draft.usuarioLogin },
    vendedor: input.draft.vendedorId ? { nombre: input.draft.vendedorNombre,
      documento: input.draft.vendedorDocumento, telefono: input.draft.vendedorTelefono,
      email: input.draft.vendedorEmail } : null,
    sede: { nombre: input.draft.sedeNombre || "Sede", codigo: input.draft.sedeCodigo, aliadoId: input.draft.sedeAliadoId },
  };
  return { credit, seal, firstPaymentDateKey, frozenClientCorrectionSource: {
    correlationId: correction.correlationId, processUuid: input.source.processUuid,
    sourceChecksum: sourceSeal.checksum, targetChecksum: seal.checksum,
  } satisfies FrozenClientCorrectionSource };
}

/** Compare the dispatch with its server-loaded audit lineage, never a browser claim. */
export function verifiesFrozenClientCorrectionSource(input: {
  marker: unknown; target: FinancingTermsSeal; source: CorrectionSource | null;
  correction: FrozenDraftClientCorrection | null; draft: Draft;
}) {
  const marker = readFrozenClientCorrectionSource(input.marker, input.target);
  if (!marker || !input.source || !input.correction ||
      marker.processUuid !== input.source.processUuid || marker.correlationId !== input.correction.correlationId ||
      marker.sourceChecksum !== input.correction.sourceSealChecksum) return false;
  try {
    const payload = record(input.draft.payload);
    const currentSeal = payload.financialTermsSeal;
    if (currentSeal !== undefined && currentSeal !== null) {
      const checksum = readFinancingTermsSeal(currentSeal)?.checksum;
      if (checksum !== marker.sourceChecksum && checksum !== input.target.checksum) return false;
    }
    // A reserved dispatch stores its new seal in updatedPayload. Rebuild from
    // the audit and source independently; only the exact target above may be
    // removed here, and the expected checksum must still match afterward.
    const rebuildingPayload = { ...payload };
    delete rebuildingPayload.financialTermsSeal;
    const expected = buildFrozenDraftClientCorrection({
      draft: { ...input.draft, payload: rebuildingPayload }, source: input.source, correction: input.correction,
    });
    return expected.seal.checksum === input.target.checksum;
  } catch { return false; }
}
