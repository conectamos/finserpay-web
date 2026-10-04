import { generatePaymentReference, resolveActivationFirstPaymentDate, sanitizeImageDataUrl, sanitizeText } from "@/lib/credit-factory";
import { readFinancingTermsSeal, resealFinancingTermsIdentity } from "@/lib/credit-amortization-contract";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";
import type { FirmaSeguroProcessRow } from "@/lib/firmaseguro-storage";

type DraftIdentity = {
  id: number; payload: unknown; usuarioNombre: string | null; usuarioLogin: string | null;
  vendedorId: number | null; vendedorNombre: string | null; vendedorDocumento: string | null;
  vendedorTelefono: string | null; vendedorEmail: string | null; sedeNombre: string | null;
  sedeCodigo: string | null; sedeAliadoId: number | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const UNCHANGED_FIELDS = [
  "clienteDocumento", "clienteTipoDocumento", "clienteNombre", "clientePrimerNombre",
  "clientePrimerApellido", "clienteDireccion", "equipoMarca", "equipoModelo",
  "referenciaEquipo", "equipoCatalogoId", "valorEquipoTotal", "cuotaInicial",
  "plazoMeses", "dataCreditoAssessmentId", "plataformaDispositivo",
] as const;

function money(value: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("FIRMASEGURO_SOURCE_SEAL_INVALID");
  return number;
}

/** Reissue a corrected draft using the signed figures, never today's policy settings. */
export function buildFrozenDraftCorrection(input: {
  draft: DraftIdentity; source: FirmaSeguroProcessRow; folio: string; imei: string;
}) {
  const current = record(input.draft.payload);
  const previous = record(input.source.draftPayload);
  const sourceSeal = readFinancingTermsSeal(previous.financialTermsSeal);
  const signedBytes = input.source.signedDocumentBase64
    ? Buffer.from(input.source.signedDocumentBase64, "base64") : null;
  if (!sourceSeal || !signedBytes || signedBytes.subarray(0, 5).toString() !== "%PDF-") {
    throw new Error("FIRMASEGURO_SIGNED_SOURCE_UNAVAILABLE");
  }
  for (const field of UNCHANGED_FIELDS) {
    if (JSON.stringify(current[field] ?? null) !== JSON.stringify(previous[field] ?? null)) {
      throw new Error("FIRMASEGURO_SIGNED_TERMS_CHANGED");
    }
  }
  if (!/^\d{15}$/.test(input.imei) || !input.folio.trim()) {
    throw new Error("FIRMASEGURO_CORRECTED_IDENTITY_INVALID");
  }
  const sourceTerms = sourceSeal.snapshot;
  const firstPayment = resolveActivationFirstPaymentDate({
    frequency: sourceTerms.frecuenciaPago, activatedAt: new Date(),
  });
  if (firstPayment.dateKey !== sourceTerms.fechaPrimerPago) {
    throw new Error("FIRMASEGURO_FIRST_PAYMENT_DATE_CHANGED");
  }
  const phone = sanitizeText(current.clienteTelefono);
  const email = sanitizeText(current.clienteCorreo).toLowerCase();
  const seal = resealFinancingTermsIdentity(sourceSeal, {
    folio: input.folio,
    clienteTelefono: phone,
    clienteCorreo: email,
    imei: input.imei,
  });
  const terms = seal.snapshot;
  const commercial = terms.calculoVersion === "ARES_FRANCES_V2";
  const cuota = money(commercial ? terms.cuotaPactada || "" : terms.cuotaTotalExacta);
  const credit: CreditForFirmaSeguroPdf = {
    folio: input.folio,
    contratoSnapshot: {
      borradorId: input.draft.id,
      origen: "BORRADOR_FIRMASEGURO_CORREGIDO",
      financiero: { calculoVersion: terms.calculoVersion, cuotaPactada: cuota,
        cuotaTotalExacta: money(terms.cuotaTotalExacta), cuotaComercial: money(terms.cuotaComercial),
        descuentoRedondeo: commercial ? money(terms.descuentoRedondeo || "") : 0 },
    },
    clienteTipoDocumento: terms.tipoDocumento,
    clienteNombre: terms.clienteNombre,
    clientePrimerNombre: sanitizeText(current.clientePrimerNombre) || null,
    clientePrimerApellido: sanitizeText(current.clientePrimerApellido) || null,
    clienteDocumento: terms.documento,
    clienteTelefono: phone,
    clienteCorreo: email,
    clienteDireccion: terms.clienteDireccion,
    referenciaEquipo: terms.referenciaEquipo,
    equipoMarca: terms.equipoMarca,
    equipoModelo: terms.equipoModelo,
    imei: input.imei, deviceUid: input.imei,
    valorEquipoTotal: money(terms.valorVenta),
    montoCredito: money(terms.totalPagar),
    cuotaInicial: money(terms.cuotaInicial),
    valorCuota: cuota,
    valorCuotaComercial: money(terms.cuotaComercial),
    calculoVersion: terms.calculoVersion,
    cuotaTotalExacta: money(terms.cuotaTotalExacta),
    ...(commercial ? { descuentoRedondeo: money(terms.descuentoRedondeo || "") } : {}),
    tasaInteresEa: money(terms.tasaInteresEa),
    tasaPeriodo: money(terms.tasaPeriodo),
    fianzaCuotaPorcentaje: money(terms.fianzaCuotaPorcentaje),
    fianzaTotalPorcentaje: money(terms.fianzaTotalPorcentaje),
    fianzaModalidad: terms.fianzaModalidad,
    seguroCuotaPorcentaje: money(terms.seguroCuotaPorcentaje),
    redondeoComercialModo: terms.redondeoComercialModo,
    redondeoComercialMultiplo: terms.redondeoComercialMultiplo,
    valorFianza: money(terms.cuotaFianzaExacta) * terms.numeroCuotas,
    plazoMeses: terms.numeroCuotas,
    frecuenciaPago: terms.frecuenciaPago,
    fechaPrimerPago: firstPayment.date,
    fechaCredito: new Date(),
    referenciaPago: generatePaymentReference(input.folio, terms.documento),
    contratoIp: sanitizeText(current.contratoIp) || null,
    contratoFotoDataUrl: sanitizeImageDataUrl(current.contratoSelfieDataUrl || current.contratoFotoDataUrl),
    contratoSelfieDataUrl: sanitizeImageDataUrl(current.contratoSelfieDataUrl || current.contratoFotoDataUrl),
    contratoCedulaFrenteDataUrl: sanitizeImageDataUrl(current.contratoCedulaFrenteDataUrl || current.cedulaFrenteDataUrl),
    contratoCedulaRespaldoDataUrl: sanitizeImageDataUrl(current.contratoCedulaRespaldoDataUrl || current.cedulaRespaldoDataUrl),
    usuario: { nombre: input.draft.usuarioNombre || "Usuario FINSER PAY", usuario: input.draft.usuarioLogin },
    vendedor: input.draft.vendedorId ? { nombre: input.draft.vendedorNombre,
      documento: input.draft.vendedorDocumento, telefono: input.draft.vendedorTelefono,
      email: input.draft.vendedorEmail } : null,
    sede: { nombre: input.draft.sedeNombre || "Sede", codigo: input.draft.sedeCodigo,
      aliadoId: input.draft.sedeAliadoId },
  };
  return { credit, seal, firstPaymentDateKey: firstPayment.dateKey };
}
