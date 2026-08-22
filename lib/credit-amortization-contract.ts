import { createHash } from "node:crypto";
import type { FrenchAmortizationResult } from "@/lib/credit-amortization";

export const FINANCING_TERMS_SEAL_VERSION = "FINANCIACION_FIRMADA_V1";

export type FinancingTermsSnapshot = {
  folio: string;
  documento: string;
  tipoDocumento: string;
  clienteNombre: string;
  clienteTelefono: string;
  clienteCorreo: string;
  clienteDireccion: string;
  equipoMarca: string;
  equipoModelo: string;
  referenciaEquipo: string;
  imei: string;
  calculoVersion: string;
  valorVenta: string;
  cuotaInicial: string;
  valorFinanciado: string;
  numeroCuotas: number;
  frecuenciaPago: string;
  fechaPrimerPago: string;
  tasaInteresEa: string;
  tasaPeriodo: string;
  fianzaCuotaPorcentaje: string;
  seguroCuotaPorcentaje: string;
  cuotaCreditoExacta: string;
  cuotaFianzaExacta: string;
  cuotaSeguroExacta: string;
  cuotaTotalExacta: string;
  cuotaComercial: string;
  totalPagar: string;
};

export type FinancingTermsSeal = {
  version: typeof FINANCING_TERMS_SEAL_VERSION;
  checksum: string;
  snapshot: FinancingTermsSnapshot;
};

function money(value: number) {
  return Number(value).toFixed(6);
}

function rate(value: number) {
  return Number(value).toFixed(12);
}

function normalizedDocument(value: unknown) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

function normalizedText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizedEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function checksum(snapshot: FinancingTermsSnapshot) {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function createFinancingTermsSeal(input: {
  folio: string;
  documento: string;
  contrato: {
    tipoDocumento: string;
    clienteNombre: string;
    clienteTelefono: string;
    clienteCorreo: string;
    clienteDireccion: string;
    equipoMarca: string;
    equipoModelo: string;
    referenciaEquipo: string;
    imei: string;
  };
  amortizacion: FrenchAmortizationResult;
}): FinancingTermsSeal {
  const plan = input.amortizacion;
  const snapshot: FinancingTermsSnapshot = {
    folio: String(input.folio || "").trim(),
    documento: normalizedDocument(input.documento),
    tipoDocumento: normalizedText(input.contrato.tipoDocumento),
    clienteNombre: normalizedText(input.contrato.clienteNombre),
    clienteTelefono: normalizedDocument(input.contrato.clienteTelefono),
    clienteCorreo: normalizedEmail(input.contrato.clienteCorreo),
    clienteDireccion: normalizedText(input.contrato.clienteDireccion),
    equipoMarca: normalizedText(input.contrato.equipoMarca),
    equipoModelo: normalizedText(input.contrato.equipoModelo),
    referenciaEquipo: normalizedText(input.contrato.referenciaEquipo),
    imei: normalizedDocument(input.contrato.imei),
    calculoVersion: plan.version,
    valorVenta: money(plan.valorVenta),
    cuotaInicial: money(plan.cuotaInicial),
    valorFinanciado: money(plan.valorFinanciado),
    numeroCuotas: plan.numeroCuotas,
    frecuenciaPago: plan.frecuenciaPago,
    fechaPrimerPago: plan.cuotas[0]?.fechaVencimiento || "",
    tasaInteresEa: rate(plan.tasaInteresEa),
    tasaPeriodo: rate(plan.tasaPeriodo),
    fianzaCuotaPorcentaje: rate(plan.fianzaCuotaPorcentaje),
    seguroCuotaPorcentaje: rate(plan.seguroCuotaPorcentaje),
    cuotaCreditoExacta: money(plan.cuotaCredito),
    cuotaFianzaExacta: money(plan.cuotaFianza),
    cuotaSeguroExacta: money(plan.cuotaSeguro),
    cuotaTotalExacta: money(plan.cuotaTotal),
    cuotaComercial: money(plan.cuotaComercial),
    totalPagar: money(plan.montoTotal),
  };

  return {
    version: FINANCING_TERMS_SEAL_VERSION,
    checksum: checksum(snapshot),
    snapshot,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readFinancingTermsSeal(value: unknown): FinancingTermsSeal | null {
  if (!isRecord(value) || value.version !== FINANCING_TERMS_SEAL_VERSION) {
    return null;
  }

  if (typeof value.checksum !== "string" || !isRecord(value.snapshot)) {
    return null;
  }

  const snapshot = value.snapshot as FinancingTermsSnapshot;
  if (checksum(snapshot) !== value.checksum) {
    return null;
  }

  return value as FinancingTermsSeal;
}

export function financingTermsSealsMatch(
  storedValue: unknown,
  current: FinancingTermsSeal
) {
  const stored = readFinancingTermsSeal(storedValue);
  return Boolean(stored && stored.checksum === current.checksum);
}
