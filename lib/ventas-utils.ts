import {
  extraerFinancierasDetalle,
  financierasTextoDesdeDetalle,
} from "@/lib/ventas-financieras";

export const BOGOTA_TIMEZONE = "America/Bogota";
const BOGOTA_OFFSET = "-05:00";

export type NumericValue =
  | string
  | number
  | { toString(): string }
  | null
  | undefined;

export type VentaLike = {
  fecha: string | Date;
  hora?: string | null;
  idVenta: string;
  servicio: string;
  descripcion?: string | null;
  serial: string;
  jalador?: string | null;
  cerrador?: string | null;
  ingreso?: NumericValue;
  alcanos?: NumericValue;
  payjoy?: NumericValue;
  sistecredito?: NumericValue;
  addi?: NumericValue;
  sumaspay?: NumericValue;
  celya?: NumericValue;
  bogota?: NumericValue;
  alocredit?: NumericValue;
  esmio?: NumericValue;
  kaiowa?: NumericValue;
  finser?: NumericValue;
  gora?: NumericValue;
  utilidad?: NumericValue;
  comision?: NumericValue;
  salida?: NumericValue;
  cajaOficina?: NumericValue;
  tipoIngreso?: string | null;
  ingreso1?: string | null;
  ingreso2?: string | null;
  primerValor?: NumericValue;
  segundoValor?: NumericValue;
  financierasDetalle?: unknown;
  sede?: {
    nombre: string;
  } | null;
};

export function dinero(v: NumericValue) {
  return Number(v ?? 0);
}

export function formatoPesos(v: NumericValue) {
  return `$ ${dinero(v).toLocaleString("es-CO")}`;
}

function bogotaDateParts(value: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOGOTA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";

  return { year, month, day };
}

export function getBogotaDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const { year, month, day } = bogotaDateParts(date);
  return `${year}-${month}-${day}`;
}

export function getTodayBogotaDateKey() {
  return getBogotaDateKey(new Date());
}

export function isTodayBogota(value: string | Date, todayKey = getTodayBogotaDateKey()) {
  return getBogotaDateKey(value) === todayKey;
}

export function getTodayBogotaRange() {
  const { year, month, day } = bogotaDateParts(new Date());
  const start = new Date(`${year}-${month}-${day}T00:00:00${BOGOTA_OFFSET}`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    start,
    end,
    key: `${year}-${month}-${day}`,
    label: `${day}/${month}/${year}`,
  };
}

export function getCurrentBogotaMonthRange() {
  const { year, month } = bogotaDateParts(new Date());
  const start = new Date(`${year}-${month}-01T00:00:00${BOGOTA_OFFSET}`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);

  const label = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA_TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(start);

  return {
    start,
    end,
    key: `${year}-${month}`,
    label,
  };
}

export function getCurrentBogotaMonthInput() {
  const { year, month } = bogotaDateParts(new Date());
  return `${year}-${month}`;
}

export function getBogotaMonthRangeFromInput(value: string) {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    return null;
  }

  const start = new Date(`${value}-01T00:00:00${BOGOTA_OFFSET}`);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);

  const label = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA_TIMEZONE,
    month: "long",
    year: "numeric",
  }).format(start);

  return {
    start,
    end,
    key: value,
    label,
  };
}

export function getBogotaDayRangeFromInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const start = new Date(`${value}T00:00:00${BOGOTA_OFFSET}`);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  const [year, month, day] = value.split("-");

  return {
    start,
    end,
    key: value,
    label: `${day}/${month}/${year}`,
  };
}

export function formatoFechaHoraVenta(fecha: string | Date, hora?: string | null) {
  const date = fecha instanceof Date ? fecha : new Date(fecha);

  const textoFecha = new Intl.DateTimeFormat("es-CO", {
    timeZone: BOGOTA_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);

  return hora ? `${textoFecha} ${hora}` : textoFecha;
}

export function detalleIngresosTexto(v: VentaLike) {
  const partes: string[] = [];

  if (v.ingreso1) {
    partes.push(`${v.ingreso1}: ${formatoPesos(v.primerValor)}`);
  }

  if (v.ingreso2) {
    partes.push(`${v.ingreso2}: ${formatoPesos(v.segundoValor)}`);
  }

  return partes.length ? partes.join(" | ") : "Sin detalle";
}

export function financierasTexto(v: VentaLike) {
  const detalle = extraerFinancierasDetalle(v as Record<string, unknown>);
  return financierasTextoDesdeDetalle(detalle);
}
