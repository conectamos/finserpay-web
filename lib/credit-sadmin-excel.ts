import ExcelJS from "exceljs";
import type { SadminCreditRow } from "@/lib/credit-sadmin-types";

type ColumnKind = "text" | "date" | "datetime" | "money" | "integer" | "percent";
type CellValue = string | number | Date | null;
type SadminColumn = {
  header: string;
  width: number;
  kind: ColumnKind;
  value: (item: SadminCreditRow) => CellValue;
};

const colombiaTimestamp = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function excelCalendarDate(value: string | null | undefined) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function excelColombiaTimestamp(value: string | null | undefined) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  const parts = Object.fromEntries(
    colombiaTimestamp.formatToParts(parsed)
      .filter(part => part.type !== "literal")
      .map(part => [part.type, Number(part.value)]),
  );
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
}

const yesNo = (value: boolean) => value ? "Sí" : "No";
const sadminStatus = (item: SadminCreditRow) =>
  item.sadmin.estado === "CREADO_SADMIN" ? "CREADO SADMIN" : "PENDIENTE SADMIN";

const columns: SadminColumn[] = [
  { header: "Fecha crédito", width: 15, kind: "date", value: item => excelCalendarDate(item.fechaCredito) },
  { header: "Creado", width: 20, kind: "datetime", value: item => excelColombiaTimestamp(item.createdAt) },
  { header: "Número crédito", width: 30, kind: "text", value: item => item.numeroCreditoVisible },
  { header: "Folio original", width: 30, kind: "text", value: item => item.folio },
  { header: "Estado SADMIN", width: 20, kind: "text", value: sadminStatus },
  { header: "Número SADMIN", width: 25, kind: "text", value: item => item.sadmin.numeroCredito || "" },
  { header: "Codeudor creado", width: 18, kind: "text", value: item => yesNo(item.sadmin.codeudorCreado) },
  { header: "Crédito creado", width: 18, kind: "text", value: item => yesNo(item.sadmin.creditoCreado) },
  { header: "Número confirmado", width: 20, kind: "text", value: item => yesNo(item.sadmin.numeroCreditoConfirmado) },
  { header: "Actualizado SADMIN", width: 22, kind: "datetime", value: item => excelColombiaTimestamp(item.sadmin.updatedAt) },
  { header: "Completado SADMIN", width: 22, kind: "datetime", value: item => excelColombiaTimestamp(item.sadmin.completedAt) },
  { header: "Nombre", width: 30, kind: "text", value: item => item.clienteNombre },
  { header: "Cédula", width: 18, kind: "text", value: item => item.clienteDocumento },
  { header: "Teléfono", width: 20, kind: "text", value: item => item.clienteTelefono },
  { header: "Correo", width: 32, kind: "text", value: item => item.clienteCorreo },
  { header: "Dirección", width: 38, kind: "text", value: item => item.clienteDireccion },
  { header: "Fecha nacimiento", width: 18, kind: "date", value: item => excelCalendarDate(item.clienteFechaNacimiento) },
  { header: "Género", width: 15, kind: "text", value: item => item.clienteGenero },
  { header: "Referencia", width: 38, kind: "text", value: item => item.referenciaEquipo },
  { header: "IMEI", width: 22, kind: "text", value: item => item.imei },

  { header: "Aliado", width: 28, kind: "text", value: item => item.aliadoNombre },
  { header: "Sede", width: 24, kind: "text", value: item => item.sedeNombre },
  { header: "Valor venta", width: 18, kind: "money", value: item => item.valorVenta },
  { header: "Inicial", width: 18, kind: "money", value: item => item.cuotaInicial },
  { header: "Crédito autorizado", width: 22, kind: "money", value: item => item.creditoAutorizado },
  { header: "N.º cuotas", width: 14, kind: "integer", value: item => item.numeroCuotas },
  { header: "Valor cuota", width: 18, kind: "money", value: item => item.valorCuota },
  { header: "Frecuencia", width: 18, kind: "text", value: item => item.frecuenciaPago },
  { header: "Interés mensual efectivo", width: 25, kind: "percent", value: item => item.interesMensual },
  { header: "Fianza total del crédito", width: 25, kind: "percent", value: item => item.fianza },
  { header: "Seguro por cuota", width: 20, kind: "percent", value: item => item.seguro },
  { header: "Próximo pago", width: 17, kind: "date", value: item => excelCalendarDate(item.fechaProximoPago) },
  { header: "Cuotas pagadas", width: 17, kind: "integer", value: item => item.cuotasPagadas },
  { header: "Cuotas pendientes", width: 19, kind: "integer", value: item => item.cuotasPendientes },
  { header: "Días vencidos", width: 17, kind: "integer", value: item => item.diasVencidos },
  { header: "Último pago", width: 32, kind: "text", value: item => item.ultimoPago || "" },
  { header: "Saldo obligación", width: 20, kind: "money", value: item => item.saldoObligacion },
  { header: "Saldo capital", width: 20, kind: "money", value: item => item.saldoCapital },
  { header: "Saldo fianza", width: 20, kind: "money", value: item => item.saldoFianza },
  { header: "Saldo intereses", width: 20, kind: "money", value: item => item.saldoIntereses },
];

function numberFormat(kind: ColumnKind) {
  if (kind === "date") return "dd/mm/yyyy";
  if (kind === "datetime") return "dd/mm/yyyy hh:mm";
  if (kind === "money") return '"$" #,##0';
  if (kind === "integer") return "0";
  if (kind === "percent") return "0.0000%";
  return "@";
}

function numericColumn(kind: ColumnKind) {
  return kind === "money" || kind === "integer" || kind === "percent";
}

export function buildSadminWorkbook(items: SadminCreditRow[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  workbook.subject = "Control de creación en SADMIN";

  const sheet = workbook.addWorksheet("Creación SADMIN", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });
  sheet.columns = columns.map(column => ({
    header: column.header,
    width: column.width,
  }));

  columns.forEach((definition, index) => {
    const column = sheet.getColumn(index + 1);
    column.numFmt = numberFormat(definition.kind);
    column.font = { name: "Calibri", size: 11, color: { argb: "FF151A21" } };
    column.alignment = {
      vertical: "middle",
      horizontal: numericColumn(definition.kind) ? "right" : "left",
      wrapText: true,
    };
  });

  for (const item of items) {
    const row = sheet.addRow(columns.map(column => column.value(item)));
    row.height = 30;
    row.eachCell({ includeEmpty: true }, cell => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: row.number % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" },
      };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFD8DEE5" } },
      };
    });
  }

  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell(cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  sheet.autoFilter = `A1:AN${sheet.rowCount}`;

  return workbook;
}
