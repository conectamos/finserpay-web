import { DELIVERY_EVIDENCE_DRAFT_FIELDS } from "@/lib/delivery-evidence-draft";
import type { FinancingTermsSnapshot } from "@/lib/credit-amortization-contract";
import type { ResolvedCreditPolicyFinancialSettings } from "@/lib/credit-policy-financial-settings";

export const SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS = [
  "solicitudId",
  "firmaSeguroPasoContratos",
  "firmaSeguroProcessUuid",
  ...DELIVERY_EVIDENCE_DRAFT_FIELDS,
] as const;

const SIGNED_SNAPSHOT_BODY_FIELDS = {
  documento: "clienteDocumento",
  tipoDocumento: "clienteTipoDocumento",
  clienteNombre: "clienteNombre",
  clienteTelefono: "clienteTelefono",
  clienteCorreo: "clienteCorreo",
  clienteDireccion: "clienteDireccion",
  equipoMarca: "equipoMarca",
  equipoModelo: "equipoModelo",
  referenciaEquipo: "referenciaEquipo",
  imei: "imei",
  valorVenta: "valorEquipoTotal",
  cuotaInicial: "cuotaInicial",
  numeroCuotas: "plazoMeses",
  frecuenciaPago: "frecuenciaPago",
  fechaPrimerPago: "fechaPrimerPago",
} as const;

function signedFiniteNumber(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`El parametro financiero firmado ${field} no es valido.`);
  }
  return parsed;
}

export function resolveSignedCreditPolicyFinancialSettings(
  snapshot: FinancingTermsSnapshot
): ResolvedCreditPolicyFinancialSettings {
  const calculoVersion = snapshot.calculoVersion;
  if (
    calculoVersion !== "FRANCES_V1" &&
    calculoVersion !== "ARES_FRANCES_V1"
  ) {
    throw new Error("La version de calculo financiero firmada no es valida.");
  }

  const fianzaModalidad = snapshot.fianzaModalidad;
  if (
    fianzaModalidad !== "TOTAL_CREDITO" &&
    fianzaModalidad !== "POR_CUOTA"
  ) {
    throw new Error("La modalidad de fianza firmada no es valida.");
  }

  const fianzaSource = snapshot.fianzaFuente;
  if (
    fianzaSource !== "POLITICA" &&
    fianzaSource !== "OFERTA_LEGACY_TOTAL" &&
    fianzaSource !== "GLOBAL"
  ) {
    throw new Error("La fuente de fianza firmada no es valida.");
  }

  const tasaPeriodoDecimales = signedFiniteNumber(
    snapshot.tasaPeriodoDecimales,
    "tasaPeriodoDecimales"
  );
  if (
    !Number.isSafeInteger(tasaPeriodoDecimales) ||
    tasaPeriodoDecimales < 0 ||
    tasaPeriodoDecimales > 12
  ) {
    throw new Error(
      "Los decimales de la tasa periodica firmada no son validos."
    );
  }

  const redondeoComercialMultiplo = signedFiniteNumber(
    snapshot.redondeoComercialMultiplo,
    "redondeoComercialMultiplo"
  );
  if (
    !Number.isSafeInteger(redondeoComercialMultiplo) ||
    redondeoComercialMultiplo <= 0
  ) {
    throw new Error("El multiplo de redondeo comercial firmado no es valido.");
  }

  const redondeoComercialModo = snapshot.redondeoComercialModo;
  if (
    redondeoComercialModo !== "REDONDEO" &&
    redondeoComercialModo !== "PISO"
  ) {
    throw new Error("El modo de redondeo comercial firmado no es valido.");
  }

  return {
    calculoVersion,
    tasaInteresEa: signedFiniteNumber(
      snapshot.tasaInteresEa,
      "tasaInteresEa"
    ),
    fianzaTotalPorcentaje: signedFiniteNumber(
      snapshot.fianzaTotalPorcentaje,
      "fianzaTotalPorcentaje"
    ),
    fianzaCuotaPorcentaje: signedFiniteNumber(
      snapshot.fianzaCuotaPorcentaje,
      "fianzaCuotaPorcentaje"
    ),
    fianzaModalidad,
    seguroCuotaPorcentaje: signedFiniteNumber(
      snapshot.seguroCuotaPorcentaje,
      "seguroCuotaPorcentaje"
    ),
    frecuenciaPago: snapshot.frecuenciaPago,
    tasaPeriodoDecimales,
    redondeoComercialModo,
    redondeoComercial: {
      modo: redondeoComercialModo,
      multiplo: redondeoComercialMultiplo,
    },
    fianzaSource,
  };
}

export function buildSignedCreditClosePayload(
  signedPayload: Record<string, unknown>,
  incomingPayload: Record<string, unknown>,
  signedSnapshot?: Record<string, unknown> | null
) {
  const canonicalPayload: Record<string, unknown> = { ...signedPayload };

  for (const field of DELIVERY_EVIDENCE_DRAFT_FIELDS) {
    delete canonicalPayload[field];
  }

  if (signedSnapshot) {
    for (const [snapshotField, bodyField] of Object.entries(
      SIGNED_SNAPSHOT_BODY_FIELDS
    )) {
      if (Object.prototype.hasOwnProperty.call(signedSnapshot, snapshotField)) {
        canonicalPayload[bodyField] = signedSnapshot[snapshotField];
      }
    }
    if (Object.prototype.hasOwnProperty.call(signedSnapshot, "imei")) {
      canonicalPayload.deviceUid = signedSnapshot.imei;
    }
  }

  for (const field of SIGNED_CREDIT_CLOSE_RUNTIME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incomingPayload, field)) {
      canonicalPayload[field] = incomingPayload[field];
    }
  }

  return canonicalPayload;
}
