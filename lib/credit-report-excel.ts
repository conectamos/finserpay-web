import ExcelJS from "exceljs";

export type CreditReportExportItem = {
  fechaCredito: string;
  folio: string;
  clienteNombre: string;
  clienteDocumento: string | null;
  clienteTelefono: string | null;
  referenciaEquipo: string | null;
  equipoMarca: string | null;
  equipoModelo: string | null;
  imei: string;
  sede: {
    nombre: string;
    aliado?: { nombre: string } | null;
  };
  usuario: { nombre: string };
  valorEquipoTotal: number;
  cuotaInicial: number;
  creditoAutorizado: number;
  estado: string;
  estadoReporte?: string;
};

function excelDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;

  // Preserve the calendar day displayed by the report in the user's browser.
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()));
}

export function buildCreditReportWorkbook(items: CreditReportExportItem[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "FINSER PAY";
  const sheet = workbook.addWorksheet("Créditos", {
    views: [{ state: "frozen", ySplit: 1, showGridLines: false }],
  });

  sheet.columns = [
    { header: "Fecha", width: 13 },
    { header: "Folio", width: 30 },
    { header: "Cliente", width: 28 },
    { header: "Documento", width: 17 },
    { header: "Teléfono", width: 20 },
    { header: "Referencia", width: 38 },
    { header: "IMEI", width: 22 },
    { header: "Aliado", width: 25 },
    { header: "Sede", width: 23 },
    { header: "Vendedor", width: 28 },
    { header: "Valor venta", width: 20 },
    { header: "Inicial", width: 20 },
    { header: "Valor crédito autorizado", width: 25 },
    { header: "Estado", width: 20 },
  ];

  sheet.columns.forEach((column, index) => {
    const isMoney = index >= 10 && index <= 12;
    column.numFmt = index === 0 ? "dd/mm/yyyy" : isMoney ? '"$" #,##0' : "@";
    column.font = { name: "Calibri", size: 11, color: { argb: "FF151A21" } };
    column.alignment = {
      vertical: "middle",
      horizontal: isMoney ? "right" : "left",
      wrapText: true,
    };
  });

  for (const item of items) {
    // Plain string cell values stay literal in XLSX, including =, + and leading zeros.
    const row = sheet.addRow([
      excelDate(item.fechaCredito),
      item.folio,
      item.clienteNombre,
      item.clienteDocumento ?? "",
      item.clienteTelefono ?? "",
      item.referenciaEquipo || [item.equipoMarca, item.equipoModelo].filter(Boolean).join(" "),
      item.imei,
      item.sede.aliado?.nombre ?? "",
      item.sede.nombre,
      item.usuario.nombre,
      item.valorEquipoTotal,
      item.cuotaInicial,
      item.creditoAutorizado,
      item.estadoReporte ?? item.estado,
    ]);
    row.height = 32;
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: row.number % 2 === 0 ? "FFFFFFFF" : "FFF5F6F4" },
      };
      cell.border = { bottom: { style: "hair", color: { argb: "FFD8DEE5" } } };
    });
  }

  const header = sheet.getRow(1);
  header.height = 34;
  header.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  });
  sheet.autoFilter = `A1:N${sheet.rowCount}`;

  return workbook;
}
