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

export type CreditRemissionClosureData = CreditRemissionData & {
  frecuenciaPago: string;
};

type SignedCreditRemissionSnapshot = {
  clienteNombre?: unknown;
  documento?: unknown;
  referenciaEquipo?: unknown;
  valorVenta?: unknown;
  cuotaInicial?: unknown;
  numeroCuotas?: unknown;
  calculoVersion?: unknown;
  cuotaPactada?: unknown;
  cuotaComercial?: unknown;
  cuotaTotalExacta?: unknown;
  fechaPrimerPago?: unknown;
  frecuenciaPago?: unknown;
};

function finiteNumber(value: unknown) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && !value.trim())
  ) {
    return Number.NaN;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function opaqueFingerprint(value: string) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }

  return [first, second]
    .map((part) => (part >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

export function creditRemissionFromSignedSnapshot(
  snapshot: SignedCreditRemissionSnapshot,
): CreditRemissionClosureData | null {
  const calculationVersion = String(snapshot.calculoVersion || "").trim();
  const cuotaPactada = finiteNumber(snapshot.cuotaPactada);
  const cuotaTotalExacta = finiteNumber(snapshot.cuotaTotalExacta);
  const valorCuota =
    calculationVersion === "ARES_FRANCES_V2"
      ? cuotaPactada
      : calculationVersion === "ARES_FRANCES_V1" ||
          calculationVersion === "FRANCES_V1"
        ? cuotaTotalExacta
        : Number.NaN;
  const data: CreditRemissionClosureData = {
    clienteNombre: String(snapshot.clienteNombre ?? "").trim(),
    clienteDocumento: String(snapshot.documento ?? "").trim(),
    referenciaEquipo: String(snapshot.referenciaEquipo ?? "").trim(),
    valorVenta: finiteNumber(snapshot.valorVenta),
    valorInicial: finiteNumber(snapshot.cuotaInicial),
    numeroCuotas: finiteNumber(snapshot.numeroCuotas),
    valorCuota,
    fechaPrimerPago: String(snapshot.fechaPrimerPago ?? "").trim(),
    frecuenciaPago: String(snapshot.frecuenciaPago ?? "").trim(),
  };

  return isCreditRemissionReady(data) && data.frecuenciaPago
    ? data
    : null;
}

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

export function getCreditRemissionFingerprint(
  data: CreditRemissionData,
  frecuenciaPago: string,
) {
  return opaqueFingerprint(
    JSON.stringify([
      data.clienteNombre,
      data.clienteDocumento,
      data.referenciaEquipo,
      data.valorVenta,
      data.valorInicial,
      data.numeroCuotas,
      data.valorCuota,
      data.fechaPrimerPago,
      frecuenciaPago,
    ]),
  );
}
