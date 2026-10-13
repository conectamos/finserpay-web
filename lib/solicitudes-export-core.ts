import type { SolicitudViewer } from "./solicitudes";

export type ExportViewer = SolicitudViewer;
export type ExportFilters = {
  period: "all" | "month" | "range";
  month: string;
  desde: string;
  hasta: string;
  aliadoIds: number[];
  sedeIds: number[];
  vendedorIds: number[];
  estado: string;
  q: string;
  plataforma: string;
};

export class ExportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ExportError";
    this.status = status;
  }
}

export function assertExportViewer(viewer: ExportViewer) {
  if (
    !viewer ||
    !Number.isSafeInteger(viewer.userId) || viewer.userId <= 0 ||
    !["CENTRAL_ADMIN", "ALLY_ADMIN"].includes(viewer.kind) ||
    (viewer.kind === "ALLY_ADMIN" && (!Number.isSafeInteger(viewer.aliadoId) || Number(viewer.aliadoId) <= 0))
  ) {
    throw new ExportError(403, "No tienes autorización para descargar la base de clientes.");
  }
}

function text(value: unknown, name: string, maximum = 120) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExportError(400, `El filtro ${name} no es válido.`);
  }
  return value.trim();
}

function ids(value: unknown, name: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1000 || value.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2147483647)) {
    throw new ExportError(400, `El filtro ${name} debe contener identificadores válidos.`);
  }
  return [...new Set(value as number[])].sort((a, b) => a - b);
}

function calendarDate(value: unknown, name: string) {
  const result = text(value, name, 10);
  if (!result) return "";
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || result < "1900-01-01" || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new ExportError(400, `La fecha ${name} no es válida.`);
  }
  return result;
}

export function normalizeExportFilters(input: unknown): ExportFilters {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ExportError(400, "Los filtros de descarga no son válidos.");
  }
  const source = input as Record<string, unknown>;
  const period = source.period ?? "all";
  if (period !== "all" && period !== "month" && period !== "range") {
    throw new ExportError(400, "El alcance del periodo no es válido.");
  }
  const month = text(source.month, "mes", 7);
  const desde = calendarDate(source.desde, "inicial");
  const hasta = calendarDate(source.hasta, "final");
  if (period === "month" && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month < "1900-01")) {
    throw new ExportError(400, "Selecciona un mes y año válidos.");
  }
  if (period === "range" && ((!desde && !hasta) || (desde && hasta && desde > hasta))) {
    throw new ExportError(400, "Selecciona un rango de fechas válido.");
  }
  const estado = text(source.estado, "estado", 40).toUpperCase();
  if (!["", "PROCESO", "CONSULTA_PENDIENTE", "APROBADA", "RECHAZADA", "VALIDACION_FACIAL", "CONTRATOS", "LISTA_PARA_ENTREGA", "ENTREGADA", "CANCELADA", "ERROR_TECNICO"].includes(estado)) {
    throw new ExportError(400, "El estado de solicitud no es válido.");
  }
  const plataforma = text(source.plataforma, "plataforma", 20).toUpperCase();
  if (!["", "ANDROID", "IPHONE"].includes(plataforma)) throw new ExportError(400, "La plataforma no es válida.");
  return {
    period, month: period === "month" ? month : "",
    desde: period === "range" ? desde : "", hasta: period === "range" ? hasta : "",
    aliadoIds: ids(source.aliadoIds, "aliados"), sedeIds: ids(source.sedeIds, "sedes"),
    vendedorIds: ids(source.vendedorIds, "vendedores"), estado, plataforma,
    q: text(source.q, "búsqueda"),
  };
}

/** Inclusive local days represented as [start, endExclusive) in America/Bogota. */
export function exportDateBounds(filters: ExportFilters) {
  if (filters.period === "all") return { start: null, endExclusive: null };
  if (filters.period === "month") {
    const start = new Date(`${filters.month}-01T05:00:00.000Z`);
    const endExclusive = new Date(start);
    endExclusive.setUTCMonth(endExclusive.getUTCMonth() + 1);
    return { start, endExclusive };
  }
  const start = filters.desde ? new Date(`${filters.desde}T05:00:00.000Z`) : null;
  const endExclusive = filters.hasta ? new Date(`${filters.hasta}T05:00:00.000Z`) : null;
  if (endExclusive) endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { start, endExclusive };
}
