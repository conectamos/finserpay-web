import {
  addPaymentFrequency,
  getPaymentFrequencyPeriodsPerYear,
  normalizePaymentFrequency,
  type PaymentFrequency,
} from "@/lib/credit-factory";

export const FRENCH_AMORTIZATION_VERSION = "FRANCES_V1";
export const DEFAULT_INSTALLMENT_SURETY_PERCENTAGE = 2.083333;
export const DEFAULT_INSTALLMENT_INSURANCE_PERCENTAGE = 0.03;

export type FrenchAmortizationInput = {
  valorVenta: number;
  cuotaInicial: number;
  numeroCuotas: number;
  tasaInteresEa: number;
  fianzaCuotaPorcentaje: number;
  seguroCuotaPorcentaje: number;
  frecuenciaPago: string;
  fechaPrimerPago: Date | string;
};

export type FrenchAmortizationInstallment = {
  numero: number;
  fechaVencimiento: string;
  saldoInicial: number;
  interes: number;
  abonoCapital: number;
  fianza: number;
  seguro: number;
  cuotaCredito: number;
  cuotaTotal: number;
  cuotaCobro: number;
  saldoFinal: number;
};

export type FrenchAmortizationResult = {
  metodo: "FRANCES_CUOTA_FIJA";
  version: typeof FRENCH_AMORTIZATION_VERSION;
  valorVenta: number;
  cuotaInicial: number;
  valorFinanciado: number;
  numeroCuotas: number;
  tasaInteresEa: number;
  tasaPeriodo: number;
  periodosPorAno: number;
  frecuenciaPago: PaymentFrequency;
  fianzaCuotaPorcentaje: number;
  seguroCuotaPorcentaje: number;
  cuotaCredito: number;
  cuotaFianza: number;
  cuotaSeguro: number;
  cuotaTotal: number;
  cuotaComercial: number;
  valorInteresTotal: number;
  valorFianzaTotal: number;
  valorSeguroTotal: number;
  montoTotal: number;
  cuotas: FrenchAmortizationInstallment[];
};

function finiteNumber(value: unknown, field: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} debe ser un numero finito.`);
  }

  return parsed;
}

function nonNegativeNumber(value: unknown, field: string) {
  const parsed = finiteNumber(value, field);

  if (parsed < 0) {
    throw new Error(`${field} no puede ser negativo.`);
  }

  return parsed;
}

function positiveInteger(value: unknown, field: string) {
  const parsed = finiteNumber(value, field);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} debe ser un entero positivo.`);
  }

  return parsed;
}

function normalizeFirstPaymentDate(value: Date | string) {
  const normalized = value instanceof Date ? new Date(value) : new Date(String(value));

  if (Number.isNaN(normalized.getTime())) {
    throw new Error("fechaPrimerPago debe ser una fecha valida.");
  }

  return normalized;
}

function calendarDateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function roundCurrency(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function annualEffectiveToPeriodicRate(
  annualEffectiveRatePercent: number,
  periodsPerYear: number
) {
  const annualRate = nonNegativeNumber(
    annualEffectiveRatePercent,
    "tasaInteresEa"
  );
  const periods = positiveInteger(periodsPerYear, "periodosPorAno");

  return Math.pow(1 + annualRate / 100, 1 / periods) - 1;
}

export function roundCommercialInstallment(value: number, increment = 100) {
  const amount = nonNegativeNumber(value, "cuotaTotal");
  const commercialIncrement = positiveInteger(increment, "incrementoComercial");

  return Math.round(amount / commercialIncrement) * commercialIncrement;
}

export function calculateFrenchAmortization(
  input: FrenchAmortizationInput
): FrenchAmortizationResult {
  const valorVenta = nonNegativeNumber(input.valorVenta, "valorVenta");
  const cuotaInicial = nonNegativeNumber(input.cuotaInicial, "cuotaInicial");
  const numeroCuotas = positiveInteger(input.numeroCuotas, "numeroCuotas");
  const tasaInteresEa = nonNegativeNumber(input.tasaInteresEa, "tasaInteresEa");
  const fianzaCuotaPorcentaje = nonNegativeNumber(
    input.fianzaCuotaPorcentaje,
    "fianzaCuotaPorcentaje"
  );
  const seguroCuotaPorcentaje = nonNegativeNumber(
    input.seguroCuotaPorcentaje,
    "seguroCuotaPorcentaje"
  );

  if (valorVenta <= 0) {
    throw new Error("valorVenta debe ser mayor que cero.");
  }

  if (cuotaInicial >= valorVenta) {
    throw new Error("cuotaInicial debe ser menor que valorVenta.");
  }

  const valorFinanciado = valorVenta - cuotaInicial;
  const frecuenciaPago = normalizePaymentFrequency(input.frecuenciaPago);
  const periodosPorAno = getPaymentFrequencyPeriodsPerYear(frecuenciaPago);
  const tasaPeriodo = annualEffectiveToPeriodicRate(
    tasaInteresEa,
    periodosPorAno
  );
  const fechaPrimerPago = normalizeFirstPaymentDate(input.fechaPrimerPago);
  const cuotaCredito =
    tasaPeriodo === 0
      ? valorFinanciado / numeroCuotas
      : (valorFinanciado * tasaPeriodo) /
        (1 - Math.pow(1 + tasaPeriodo, -numeroCuotas));
  const cuotaFianza = valorFinanciado * (fianzaCuotaPorcentaje / 100);
  const cuotaSeguro = valorFinanciado * (seguroCuotaPorcentaje / 100);
  const cuotaTotal = cuotaCredito + cuotaFianza + cuotaSeguro;

  let saldo = valorFinanciado;
  let valorInteresTotal = 0;
  let valorFianzaTotal = 0;
  let valorSeguroTotal = 0;

  const cuotasExactas = Array.from({ length: numeroCuotas }, (_, index) => {
    const numero = index + 1;
    const ultimaCuota = numero === numeroCuotas;
    const saldoInicial = saldo;
    const interes = saldoInicial * tasaPeriodo;
    const abonoCapital = ultimaCuota ? saldoInicial : cuotaCredito - interes;
    const cuotaCreditoPeriodo = interes + abonoCapital;
    const saldoFinal = ultimaCuota ? 0 : saldoInicial - abonoCapital;
    const cuotaTotalPeriodo = cuotaCreditoPeriodo + cuotaFianza + cuotaSeguro;

    valorInteresTotal += interes;
    valorFianzaTotal += cuotaFianza;
    valorSeguroTotal += cuotaSeguro;
    saldo = saldoFinal;

    return {
      numero,
      fechaVencimiento: calendarDateKey(
        addPaymentFrequency(fechaPrimerPago, frecuenciaPago, index)
      ),
      saldoInicial,
      interes,
      abonoCapital,
      fianza: cuotaFianza,
      seguro: cuotaSeguro,
      cuotaCredito: cuotaCreditoPeriodo,
      cuotaTotal: cuotaTotalPeriodo,
      saldoFinal,
    };
  });

  const montoTotal =
    valorFinanciado + valorInteresTotal + valorFianzaTotal + valorSeguroTotal;
  const montoCobro = roundCurrency(montoTotal);
  let cobroAsignado = 0;
  const cuotas = cuotasExactas.map((cuota, index) => {
    const ultimaCuota = index === cuotasExactas.length - 1;
    const cuotaCobro = ultimaCuota
      ? roundCurrency(montoCobro - cobroAsignado)
      : roundCurrency(cuota.cuotaTotal);
    cobroAsignado = roundCurrency(cobroAsignado + cuotaCobro);
    return { ...cuota, cuotaCobro };
  });

  return {
    metodo: "FRANCES_CUOTA_FIJA",
    version: FRENCH_AMORTIZATION_VERSION,
    valorVenta,
    cuotaInicial,
    valorFinanciado,
    numeroCuotas,
    tasaInteresEa,
    tasaPeriodo,
    periodosPorAno,
    frecuenciaPago,
    fianzaCuotaPorcentaje,
    seguroCuotaPorcentaje,
    cuotaCredito,
    cuotaFianza,
    cuotaSeguro,
    cuotaTotal,
    cuotaComercial: roundCommercialInstallment(cuotaTotal),
    valorInteresTotal,
    valorFianzaTotal,
    valorSeguroTotal,
    montoTotal,
    cuotas,
  };
}
