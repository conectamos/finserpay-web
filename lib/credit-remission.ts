const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type CreditRemissionData = {
  clienteNombre: string;
  clienteDocumento: string;
  referenciaEquipo: string;
  valorVenta: number;
  valorInicial: number;
  numeroCuotas: number;
  valorCuota: number;
  fechaPrimerPago: string;
};

function getDateOnlyParts(value: string) {
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

export function formatCreditRemissionDate(value: Date | string) {
  if (typeof value === "string") {
    const normalizedValue = value.trim();
    if (DATE_ONLY_PATTERN.test(normalizedValue)) {
      const dateOnly = getDateOnlyParts(normalizedValue);
      return dateOnly
        ? `${String(dateOnly.day).padStart(2, "0")}/${String(dateOnly.month).padStart(2, "0")}/${dateOnly.year}`
        : "Pendiente";
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Pendiente";

  return new Intl.DateTimeFormat("es-CO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "America/Bogota",
  }).format(parsed);
}

export function formatCreditRemissionCurrency(value: number) {
  const normalizedValue = Number.isFinite(value) ? Math.max(0, value) : 0;
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(normalizedValue);
}

export function getCreditRemissionPaymentSchedule(
  frecuenciaPago: string,
  fechaPrimerPago: string,
) {
  const normalizedFrequency = frecuenciaPago.trim().toUpperCase();

  if (normalizedFrequency === "QUINCENAL") return "02 y 17 de cada mes";
  if (normalizedFrequency === "SEMANAL") return "Cada 7 días";
  if (normalizedFrequency === "CATORCENAL") return "Cada 14 días";

  if (normalizedFrequency === "MENSUAL") {
    const dateOnly = getDateOnlyParts(fechaPrimerPago);
    return dateOnly
      ? `Día ${String(dateOnly.day).padStart(2, "0")} de cada mes`
      : "Una vez al mes";
  }

  return "Según el plan de pagos";
}

export function isCreditRemissionReady(data: CreditRemissionData) {
  return Boolean(
    data.clienteNombre.trim() &&
      data.clienteDocumento.trim() &&
      data.referenciaEquipo.trim() &&
      Number.isFinite(data.valorVenta) &&
      data.valorVenta > 0 &&
      Number.isFinite(data.valorInicial) &&
      data.valorInicial >= 0 &&
      Number.isInteger(data.numeroCuotas) &&
      data.numeroCuotas > 0 &&
      Number.isFinite(data.valorCuota) &&
      data.valorCuota > 0 &&
      getDateOnlyParts(data.fechaPrimerPago),
  );
}
