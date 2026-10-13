import ExcelJS from "exceljs";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { setImmediate as yieldToIO } from "node:timers/promises";

/** Explicit allowlist: never hand client, assessment or evidence objects to ExcelJS. */
export type SolicitudExportRow = {
  solicitudNumero?: string | null;
  createdAt?: Date | string | null;
  estado?: string | null;
  numeroCredito?: string | null;
  numeroSadmin?: string | null;
  nombreCompleto?: string | null;
  tipoDocumento?: string | null;
  numeroDocumento?: string | null;
  celular?: string | null;
  correo?: string | null;
  departamento?: string | null;
  ciudad?: string | null;
  direccion?: string | null;
  aliado?: string | null;
  sede?: string | null;
  vendedor?: string | null;
  marcaEquipo?: string | null;
  referenciaEquipo?: string | null;
  imei?: string | null;
  valorEquipo?: number | null;
  inicial?: number | null;
  valorFinanciado?: number | null;
  numeroCuotas?: number | null;
  valorCuota?: number | null;
  frecuencia?: string | null;
  primerPago?: Date | string | null;
};

const MAX_DATA_ROWS_PER_SHEET = 1_048_575; // XLSX limit minus the header.
const COP_FORMAT = '[$$-es-CO] #,##0.00';
const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Bogota",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function dateValue(value: Date | string | null | undefined) {
  if (value == null || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function creationDate(value: SolicitudExportRow["createdAt"]) {
  const parsed = dateValue(value);
  if (!parsed) return null;
  // Excel stores wall-clock values without a timezone. Encode the Bogotá time
  // in its UTC fields, independent of the server's own timezone.
  const parts = dateTimeFormatter.formatToParts(parsed);
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === name)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")));
}

function firstPaymentDate(value: SolicitudExportRow["primerPago"]) {
  // SQL timestamp::text has no offset. Read its calendar prefix directly so
  // hosts outside Colombia cannot shift the due date while parsing it.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T]|$)/.test(value)) {
    const key = value.slice(0, 10);
    const day = new Date(`${key}T00:00:00.000Z`);
    return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== key ? null : day;
  }
  const parsed = dateValue(value);
  if (!parsed) return null;
  // Same storage convention as credit-payment-plan: due dates are calendar
  // dates stored at UTC midnight, not timestamps to shift to the previous day.
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function textValue(value: string | null | undefined) {
  // Never accept ExcelJS formula/rich-text/hyperlink objects from stored JSON.
  // Literal strings serialize as XLSX strings, even when starting =, +, - or @.
  return value == null ? "" : String(value);
}

function numberValue(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const columns = [
  { header: "Número de solicitud", width: 25 },
  { header: "Fecha de creación (Bogotá)", width: 25 },
  { header: "Estado", width: 23 },
  { header: "Número de crédito", width: 28 },
  { header: "Número de Sadmin", width: 25 },
  { header: "Nombres y apellidos completos", width: 36 },
  { header: "Tipo de documento", width: 20 },
  { header: "Número de documento", width: 24 },
  { header: "Celular", width: 22 },
  { header: "Correo", width: 34 },
  { header: "Departamento", width: 22 },
  { header: "Ciudad", width: 22 },
  { header: "Dirección", width: 38 },
  { header: "Aliado", width: 30 },
  { header: "Sede", width: 28 },
  { header: "Vendedor", width: 32 },
  { header: "Marca del equipo", width: 22 },
  { header: "Referencia del equipo", width: 32 },
  { header: "IMEI", width: 25 },
  { header: "Valor del equipo", width: 22 },
  { header: "Inicial", width: 22 },
  { header: "Valor financiado", width: 22 },
  { header: "Número de cuotas", width: 20 },
  { header: "Valor de cuota", width: 22 },
  { header: "Frecuencia", width: 20 },
  { header: "Primer pago", width: 17 },
];

function addSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, index: number) {
  const sheet = workbook.addWorksheet(index === 1 ? "Solicitudes" : `Solicitudes ${index}`, {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  sheet.columns = columns.map((column, index) => {
    const money = [19, 20, 21, 23].includes(index);
    return {
      ...column,
      style: {
        numFmt: index === 1 ? "dd/mm/yyyy hh:mm:ss" : index === 25 ? "dd/mm/yyyy" : money ? COP_FORMAT : index === 22 ? "0" : "@",
        font: { name: "Calibri", size: 11, color: { argb: "FF151A21" } },
        alignment: { vertical: "middle" as const, horizontal: money || index === 22 ? "right" as const : "left" as const },
      },
    };
  });
  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.numFmt = "@";
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  header.commit();
  return sheet;
}

function values(row: SolicitudExportRow) {
  return [
    textValue(row.solicitudNumero), creationDate(row.createdAt), textValue(row.estado),
    textValue(row.numeroCredito), row.numeroSadmin?.trim() ? textValue(row.numeroSadmin) : "PENDIENTE SADMIN",
    textValue(row.nombreCompleto), textValue(row.tipoDocumento), textValue(row.numeroDocumento).replace(/\./g, ""),
    textValue(row.celular), textValue(row.correo), textValue(row.departamento), textValue(row.ciudad),
    textValue(row.direccion), textValue(row.aliado), textValue(row.sede), textValue(row.vendedor),
    textValue(row.marcaEquipo), textValue(row.referenciaEquipo), textValue(row.imei),
    numberValue(row.valorEquipo), numberValue(row.inicial), numberValue(row.valorFinanciado),
    numberValue(row.numeroCuotas), numberValue(row.valorCuota), textValue(row.frecuencia), firstPaymentDate(row.primerPago),
  ];
}

/** Writes all rows to a private new file. A failed export never leaves a partial XLSX. */
export async function writeSolicitudExportWorkbook(
  rows: AsyncIterable<SolicitudExportRow>,
  filename: string,
  onProgress?: (count: number) => void | Promise<void>,
  options: { maxDataRowsPerSheet?: number } = {},
): Promise<{ count: number }> {
  const rowLimit = options.maxDataRowsPerSheet ?? MAX_DATA_ROWS_PER_SHEET;
  if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_DATA_ROWS_PER_SHEET) {
    throw new Error("Límite de filas por hoja inválido.");
  }
  const output = createWriteStream(filename, { flags: "wx", mode: 0o600 });
  // Waiting for open also makes sure cleanup never removes a preexisting file.
  await once(output, "open");
  let writeError: unknown;
  const completion = finished(output);
  void completion.catch((error: unknown) => { writeError = error; });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output, useStyles: true, useSharedStrings: false,
  });
  workbook.creator = "FINSER PAY";
  workbook.lastModifiedBy = "FINSER PAY";
  // ExcelJS 4.x exposes its archiver at runtime but omits it from its types.
  // Abort it on source errors so compression cannot keep a partial export alive.
  const archive = (workbook as unknown as { zip: { abort(): void; on(event: "error", listener: (error: Error) => void): void } }).zip;
  archive.on("error", (error) => { writeError = error; output.destroy(error); });
  let count = 0;
  let sheetIndex = 1;
  let sheetRows = 0;
  try {
    let sheet = addSheet(workbook, sheetIndex);
    for await (const item of rows) {
      if (writeError) throw writeError;
      if (sheetRows === rowLimit) {
        sheet.autoFilter = `A1:Z${sheetRows + 1}`;
        sheet.commit();
        sheet = addSheet(workbook, ++sheetIndex);
        sheetRows = 0;
      }
      const row = sheet.addRow(values(item));
      row.height = 22;
      row.commit();
      count += 1;
      sheetRows += 1;
      if (count % 250 === 0) {
        // Allow compression and file IO to advance when the source is fast.
        await yieldToIO();
        if (writeError) throw writeError;
        if (output.writableNeedDrain) await once(output, "drain");
      }
      if (count % 1_000 === 0) await onProgress?.(count);
    }
    sheet.autoFilter = `A1:Z${sheetRows + 1}`;
    sheet.commit();
    await Promise.all([workbook.commit(), completion]);
    if (writeError) throw writeError;
    await onProgress?.(count);
    return { count };
  } catch (error) {
    archive.abort();
    output.destroy();
    await completion.catch(() => undefined);
    await rm(filename, { force: true });
    throw error;
  }
}
