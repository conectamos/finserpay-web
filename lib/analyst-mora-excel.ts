import ExcelJS from "exceljs";
import type { MoraPortfolioExportItem } from "@/lib/analyst-mora-management";

type FilterKey = "q" | "ally" | "responsible" | "minDays" | "maxDays" | "status" | "followUp";
type ExportOptions = { generatedAt: Date; filters?: Partial<Record<FilterKey, string>> };
type Value = string | number | Date | null;
type Column = { header: string; width: number; format?: string; value: (item: MoraPortfolioExportItem) => Value };

const COP = '[$$-es-CO] #,##0.00';
const DATE = "dd/mm/yyyy";
const DATETIME = "dd/mm/yyyy hh:mm:ss";
const colombia = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const statuses: Record<string, string> = {
  PENDIENTE: "Pendiente", CONTACTADO: "Contactado", SIN_RESPUESTA: "Sin respuesta",
  PROMESA_PAGO: "Promesa de pago", ACUERDO_PAGO: "Acuerdo de pago", SOPORTE_RECIBIDO: "Soporte recibido",
  ESCALADO: "Escalado", CERRADO: "Cerrado", SOLUCIONADO: "Solucionado", SEGUIMIENTO: "Seguimiento", PRORROGA: "Prórroga",
};
const text = (value: unknown) => value == null ? "" : String(value);
const amount = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
const statusLabel = (value: string) => Object.hasOwn(statuses, value) ? statuses[value] : text(value);

function calendarDate(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() >= 1900 && date.toISOString().slice(0, 10) === value ? date : null;
}

function colombiaTimestamp(value: string | Date | null | undefined) {
  if (!value) return null;
  if (typeof value === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    // Reject impossible calendar days and zone-less timestamps instead of
    // letting Date normalize them or use the server's local timezone.
    if (!match || !calendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = colombia.formatToParts(parsed);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === name)?.value);
  const year = part("year");
  if (year < 1900 || year > 9999) return null;
  // Excel stores a wall-clock time without a timezone. UTC fields encode the
  // Bogotá time so that opening the workbook elsewhere does not shift it.
  return new Date(Date.UTC(year, part("month") - 1, part("day"), part("hour"), part("minute"), part("second")));
}

function creditDate(value: string | null | undefined) {
  const dateOnly = calendarDate(value);
  if (dateOnly) return dateOnly;
  const timestamp = colombiaTimestamp(value);
  return timestamp ? new Date(Date.UTC(timestamp.getUTCFullYear(), timestamp.getUTCMonth(), timestamp.getUTCDate())) : null;
}

const columns: Column[] = [
  { header: "Crédito", width: 29, value: item => text(item.numeroCreditoVisible || item.folio) },
  { header: "Cliente", width: 34, value: item => text(item.clienteNombre) },
  { header: "Documento", width: 23, value: item => text(item.clienteDocumento) },
  { header: "Teléfono", width: 22, value: item => text(item.clienteTelefono) },
  { header: "Aliado", width: 30, value: item => text(item.aliadoNombre) },
  { header: "Equipo", width: 32, value: item => text(item.equipo) },
  { header: "IMEI", width: 23, value: item => text(item.imei) },
  { header: "Días de mora", width: 15, format: "0", value: item => amount(item.diasMora) },
  { header: "Valor vencido (COP)", width: 23, format: COP, value: item => amount(item.valorVencido) },
  { header: "Saldo pendiente (COP)", width: 24, format: COP, value: item => amount(item.saldoPendiente) },
  { header: "Último pago (Bogotá)", width: 24, format: DATETIME, value: item => colombiaTimestamp(item.ultimoPago) },
  { header: "Estado de gestión", width: 24, value: item => statusLabel(item.estadoGestion) },
  { header: "Última gestión (resultado)", width: 44, value: item => text(item.ultimaGestion?.result) },
  { header: "Responsable", width: 30, value: item => text(item.ultimaGestion?.responsibleName) },
  { header: "Fecha última gestión (Bogotá)", width: 26, format: DATETIME, value: item => colombiaTimestamp(item.ultimaGestion?.actedAt) },
  { header: "Próxima gestión (Bogotá)", width: 26, format: DATETIME, value: item => colombiaTimestamp(item.ultimaGestion?.nextFollowUpAt) },
  { header: "Prórroga activa", width: 18, value: item => item.prorrogaActiva ? "Sí" : "No" },
  { header: "Prórroga hasta", width: 18, format: DATE, value: item => calendarDate(item.prorrogaActiva?.expiresOn) },
  { header: "Fecha crédito", width: 18, format: DATE, value: item => creditDate(item.fechaCredito) },
];

function createSheet(workbook: ExcelJS.Workbook, name: string, definitions: Pick<Column, "header" | "width" | "format">[]) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  sheet.columns = definitions.map(column => ({ header: column.header, width: column.width, style: {
    numFmt: column.format || "@",
    font: { name: "Calibri", size: 11, color: { argb: "FF151A21" } },
    alignment: { vertical: "middle", wrapText: true, horizontal: column.format === COP || column.format === "0" ? "right" : "left" },
  } }));
  return sheet;
}

function finish(sheet: ExcelJS.Worksheet, autoFilter = false) {
  sheet.eachRow((row, index) => {
    row.height = index === 1 ? 40 : 34;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.border = { bottom: { style: "hair", color: { argb: "FFD8DEE5" } } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index === 1 ? "FF151A21" : index % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" } };
      if (index === 1) {
        cell.numFmt = "@";
        cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
      }
    });
  });
  if (autoFilter) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
}

function total(items: readonly MoraPortfolioExportItem[], field: "valorVencido" | "saldoPendiente") {
  let sum = 0;
  for (const item of items) {
    const value = amount(item[field]);
    if (value === null) return null;
    sum += value;
  }
  return Number.isFinite(sum) ? Number(sum.toFixed(2)) : null;
}

/** Serializes the full authorized, filtered read model. No queries or mutations. */
export function buildMoraPortfolioWorkbook(items: readonly MoraPortfolioExportItem[], options: ExportOptions) {
  const generatedAt = colombiaTimestamp(options.generatedAt);
  if (!generatedAt) throw new RangeError("La fecha de generación del reporte no es válida.");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  workbook.lastModifiedBy = "FINSER PAY";
  workbook.title = "Cartera en mora";
  workbook.subject = "Cartera en mora y seguimiento del analista";
  workbook.created = new Date(options.generatedAt);
  workbook.modified = new Date(options.generatedAt);

  const summary = createSheet(workbook, "Resumen", [{ header: "Concepto", width: 42 }, { header: "Valor", width: 65 }]);
  const entry = (label: string, value: Value, format = "@") => {
    const cell = summary.addRow([label, value]).getCell(2);
    cell.numFmt = format;
    cell.alignment = { vertical: "middle", wrapText: true, horizontal: format === COP || format === "0" ? "right" : "left" };
  };
  entry("Reporte", "Cartera en mora · FINSER PAY");
  entry("Generado el (Bogotá)", generatedAt, DATETIME);
  entry("Zona horaria", "America/Bogota (UTC-05:00)");
  entry("Alcance", "Todos los créditos que cumplen los filtros aplicados.");
  entry("Créditos exportados", items.length, "0");
  entry("Total valor vencido (COP)", total(items, "valorVencido"), COP);
  entry("Total saldo pendiente (COP)", total(items, "saldoPendiente"), COP);
  if (items.some(item => amount(item.valorVencido) === null || amount(item.saldoPendiente) === null)) {
    entry("Importes no disponibles", "Las celdas y los totales sin información completa se dejan vacíos.");
  }

  const filters = options.filters || {};
  const ally = items.find(item => String(item.aliadoId) === filters.ally)?.aliadoNombre;
  const responsible = items.find(item => String(item.ultimaGestion?.responsibleUserId) === filters.responsible)?.ultimaGestion?.responsibleName;
  entry("Búsqueda", text(filters.q) || "Sin búsqueda");
  entry("Aliado", filters.ally ? `${ally ? `${ally} · ` : ""}ID ${text(filters.ally)}` : "Todos");
  entry("Responsable", filters.responsible ? `${responsible ? `${responsible} · ` : ""}ID ${text(filters.responsible)}` : "Todos");
  entry("Días de mora desde", text(filters.minDays) || "Sin límite");
  entry("Días de mora hasta", text(filters.maxDays) || "Sin límite");
  entry("Estado de gestión", filters.status ? statusLabel(filters.status) : "Todos");
  entry("Fecha próxima gestión", filters.followUp ? calendarDate(filters.followUp) : "Cualquier fecha", filters.followUp ? DATE : "@");

  const detail = createSheet(workbook, "Cartera en mora", columns);
  for (const item of items) {
    // ExcelJS string values are literal XLSX cells, including =, +, @ and
    // identifiers with leading zeros. Never construct formula/hyperlink objects.
    detail.addRow(columns.map(column => column.value(item)));
  }
  finish(summary);
  finish(detail, true);
  return workbook;
}
