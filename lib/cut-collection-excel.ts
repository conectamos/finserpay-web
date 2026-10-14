import ExcelJS from "exceljs";
import type { CutReport } from "./cut-collection-types";

const COP = '[$$-es-CO] #,##0.00';
const DATE = "dd/mm/yyyy";
const DATETIME = "dd/mm/yyyy hh:mm:ss";
const colombia = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function text(value: unknown) { return value == null ? "" : String(value); }
function amount(value: number | null) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function date(value: string | null, timestamp = false) {
  if (!value) return null;
  if (!timestamp) {
    const key = value.slice(0, 10);
    const parsed = new Date(`${key}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== key ? null : parsed;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // Excel timestamps have no timezone. Encode Bogotá's wall-clock fields.
  const parts = colombia.formatToParts(parsed);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === name)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")));
}

type Column = { header: string; width?: number; format?: string };
function sheet(workbook: ExcelJS.Workbook, name: string, columns: Column[]) {
  const result = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  result.columns = columns.map(({ header, width, format }) => ({ header, width: width || 24, style: {
    numFmt: format || "@", font: { name: "Calibri", size: 11, color: { argb: "FF151A21" } },
    alignment: { vertical: "middle", horizontal: format === COP || format === "0" || format === "0.00%" ? "right" : "left", wrapText: true },
  } }));
  return result;
}

function finish(worksheet: ExcelJS.Worksheet, autoFilter = true) {
  worksheet.eachRow((row, index) => {
    row.height = index === 1 ? 38 : 32;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = { bottom: { style: "hair", color: { argb: "FFD8DEE5" } } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: index === 1 ? "FF151A21" : index % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" } };
      if (index === 1) {
        cell.numFmt = "@";
        cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      }
    });
  });
  if (autoFilter) worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, worksheet.rowCount), column: worksheet.columnCount } };
}

/** Uses the exact authorized, filtered report used by the screen. No queries or writes. */
export function buildCutCollectionWorkbook(report: CutReport) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  workbook.lastModifiedBy = "FINSER PAY";
  workbook.title = "Recaudo por corte";

  const summary = sheet(workbook, "Resumen", [{ header: "Concepto", width: 43 }, { header: "Valor", width: 55 }]);
  const entry = (label: string, value: string | number | Date | null, format = "@") => {
    const row = summary.addRow([label, value]);
    row.getCell(2).numFmt = format;
  };
  entry("Corte", date(report.cutDate), DATE);
  entry("Día de corte", String(report.filters.day).padStart(2, "0"));
  entry("Mes", report.filters.month, "0");
  entry("Año", report.filters.year, "0");
  entry("Aliado", report.filters.aliadoId == null ? "Todos los permitidos" :
    text(report.options.aliados.find((item) => item.id === report.filters.aliadoId)?.nombre || report.filters.aliadoId));
  entry("Sede", report.filters.sedeId == null ? "Todas las permitidas" :
    text(report.options.sedes.find((item) => item.id === report.filters.sedeId)?.nombre || report.filters.sedeId));
  entry("Estado de cuota", text(report.filters.status));
  entry("Versión / ID de proyección", report.projection ? text(report.projection.id) : "Vista previa sin guardar");
  entry("Proyección guardada (Bogotá)", date(report.projection?.createdAt || null, true), DATETIME);
  entry("Consultado al (Bogotá)", date(report.asOf, true), DATETIME);
  entry("Zona horaria", "America/Bogota (UTC-05:00)");
  entry("Recaudo esperado", amount(report.summary.expected), COP);
  entry("Recaudo recibido", amount(report.summary.received), COP);
  entry("Pendiente por recaudar", amount(report.summary.pending), COP);
  entry("Porcentaje de cumplimiento", report.summary.completion == null ? "No aplica: esperado cero" : report.summary.completion / 100,
    report.summary.completion == null ? "@" : "0.00%");
  entry("Clientes pendientes", amount(report.summary.pendingClients), "0");
  entry("Anticipos previos", amount(report.summary.priorPayments), COP);
  entry("Ajustes de anticipos previos", amount(report.summary.priorReversals), COP);
  entry("Recuperación de cuotas anteriores", amount(report.summary.previousRecovery), COP);
  entry("Anticipos de cuotas futuras", amount(report.summary.futureAdvances), COP);
  entry("Cuotas en el detalle filtrado", report.rows.length, "0");
  entry("Comparación histórica", "Cada versión conserva su esperado; consulta su ID para ver sus cuotas.");
  entry("Página de historial exportada", (report.historyPage ?? 0) + 1, "0");
  entry("Alcance del histórico exportado", "Solo las versiones de la página actual. Cambia la página para exportar otras versiones.");
  entry("Hay más páginas de historial", report.historyHasMore ? "Sí" : "No");
  for (const warning of report.warnings) entry("Observación", text(warning));

  const detail = sheet(workbook, "Cuotas", [
    { header: "Cliente", width: 36 }, { header: "Cédula" }, { header: "Número de crédito", width: 28 },
    { header: "Aliado", width: 30 }, { header: "Sede", width: 30 }, { header: "Vencimiento", format: DATE },
    { header: "Valor de cuota", format: COP }, { header: "Anticipos previos", format: COP },
    { header: "Esperado", format: COP }, { header: "Recibido", format: COP }, { header: "Pendiente", format: COP },
    { header: "Último pago (Bogotá)", format: DATETIME }, { header: "Estado" },
    { header: "Ajustes de anticipos previos", format: COP }, { header: "Número de cuota", format: "0" }, { header: "Observación", width: 50 },
  ]);
  const payments = sheet(workbook, "Pagos aplicados", [
    { header: "Cliente", width: 36 }, { header: "Cédula" }, { header: "Número de crédito", width: 28 },
    { header: "Número de cuota", format: "0" }, { header: "ID de pago" }, { header: "Fecha de pago (Bogotá)", format: DATETIME },
    { header: "Registrado (Bogotá)", format: DATETIME }, { header: "Método" }, { header: "Estado de pago" },
    { header: "Valor total del pago (referencia)", format: COP, width: 30 },
    { header: "Aplicado a cuota al guardar", format: COP }, { header: "Aplicado a cuota actualmente", format: COP },
    { header: "Recibido contra esperado", format: COP }, { header: "Pago previo a proyección" }, { header: "Origen de la atribución", width: 55 },
  ]);
  for (const row of report.rows) {
    detail.addRow([
      text(row.clientName), text(row.document), text(row.folio), text(row.aliado), text(row.sede), date(row.dueDate),
      amount(row.installmentAmount), amount(row.priorPayments), amount(row.expected), amount(row.received), amount(row.pending),
      date(row.lastPaymentAt, true), text(row.status), amount(row.priorReversals), row.installment, text(row.warning),
    ]);
    for (const payment of row.payments) payments.addRow([
      text(row.clientName), text(row.document), text(row.folio), row.installment, text(payment.id),
      date(payment.paidAt, true), date(payment.createdAt, true), text(payment.method), text(payment.state),
      amount(payment.amount), amount(payment.appliedBefore), amount(payment.appliedNow), amount(payment.received), payment.previous ? "Sí" : "No", "Distribución por cuota",
    ]);
    for (const payment of row.sourcePayments || []) payments.addRow([
      text(row.clientName), text(row.document), text(row.folio), row.installment, text(payment.id),
      date(payment.paidAt, true), date(payment.createdAt, true), text(payment.method), text(payment.state),
      amount(payment.amount), null, null, null, "Sí", "Conciliación base; distribución no individualizada",
    ]);
  }
  const history = sheet(workbook, "Histórico", [
    { header: "Versión / ID de proyección", width: 40 }, { header: "Corte", format: DATE },
    { header: "Guardada (Bogotá)", format: DATETIME }, { header: "Esperado", format: COP },
    { header: "Recibido", format: COP }, { header: "Pendiente", format: COP },
    { header: "Cumplimiento", format: "0.00%" }, { header: "Cuotas", format: "0" }, { header: "Observación", width: 55 },
  ]);
  for (const item of report.history) history.addRow([
    text(item.id), date(item.cutDate), date(item.createdAt, true), amount(item.expected), amount(item.received), amount(item.pending),
    item.completion == null ? item.expected == null ? "Requiere conciliación" : "No aplica: esperado cero" : item.completion / 100,
    amount(item.rowCount), text(item.warning),
  ]);
  finish(summary, false);
  for (const worksheet of [detail, payments, history]) finish(worksheet);
  return workbook;
}
