import ExcelJS from "exceljs";

export const MASS_CREDIT_XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ROWS = 250;
const TEXT_COLUMNS = new Set(["FECHA", "FECHA DE PAGO", "FECHA DE NACIMIENTO", "CEDULA", "TELEFONO", "IMEI", "Número de crédito en SADMIN"]);

export async function buildMassCreditWorkbook(headers: string[], example: string[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.views = [{ x: 0, y: 0, width: 10000, height: 8000, firstSheet: 0, activeTab: 0, visibility: "visible" }];
  const sheet = workbook.addWorksheet("Creditos", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = headers.map(header => ({ header, width: header === "IMEI" ? 23 : header === "Número de crédito en SADMIN" ? 32 : 24,
    style: TEXT_COLUMNS.has(header) ? { numFmt: "@" } : {} }));
  sheet.addRow(example);
  // Preformat the entry range so values entered in Excel stay as text.
  for (let row = 2; row <= MAX_ROWS + 1; row++) {
    headers.forEach((header, index) => {
      if (TEXT_COLUMNS.has(header)) sheet.getCell(row, index + 1).numFmt = "@";
    });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF151A21" } };
  sheet.getRow(1).height = 32;
  sheet.getRow(1).alignment = { vertical: "middle", wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  const guide = workbook.addWorksheet("Instrucciones");
  guide.columns = [{ width: 110 }];
  ["FINSER PAY — Créditos masivos", "Reemplaza la fila de ejemplo en la hoja Creditos. Máximo 250 créditos.",
    "IMEI, cédula, teléfono y número SADMIN están configurados como Texto para conservar todos sus dígitos y ceros iniciales. Las fechas también usan Texto para conservar el formato.",
    "Pega valores en las celdas, conserva el formato Texto y verifica que el IMEI original tenga 15 dígitos y un dígito de control válido antes de guardar.",
    "En Excel, usa Archivo → Guardar como → CSV UTF-8. Sube el archivo .csv generado a FINSER PAY.",
    "Al guardar, cierra el libro si Excel lo solicita. No vuelvas a abrir el CSV con doble clic; súbelo directamente a FINSER PAY.",
    "Si ves 1E+15, revisa la barra de fórmulas. Si el archivo ya perdió dígitos, recupera el IMEI desde su fuente original.",
    "Usa fechas AAAA-MM-DD o D/M/AAAA, por ejemplo 1990-05-20 o 20/5/1990. No incluyas fórmulas. Revisa los errores por fila antes de crear créditos.",
    "DIRECCION, CORREO, FECHA DE NACIMIENTO y SEXO son obligatorios. Completa la dirección y un correo válido; el cliente debe tener al menos 18 años.",
    "SEXO admite MASCULINO, FEMENINO, OTRO o PREFIERO_NO_DECIR. En la carga también se pueden usar M y F para masculino y femenino.",
    "FRECUENCIA: QUINCENAL paga los días 02 y 17 de cada mes; CATORCENAL paga cada 14 días; MENSUAL conserva el día mensual. No son equivalentes.",
    "Para QUINCENAL, FECHA DE PAGO debe ser el día 17 del mismo mes si FECHA está entre el 1 y el 5; el día 02 del siguiente mes si está entre el 6 y el 20; el día 17 del siguiente mes si está entre el 21 y el 31.",
    "En FINSER PAY selecciona si los créditos ya existen en SADMIN o están pendientes de creación. El número SADMIN es obligatorio solo si ya existe; si está pendiente, deja la columna vacía. El administrador completará el número real y confirmará la creación desde Aprobaciones de SADMIN. Las demás reglas de aprobación siguen vigentes."]
    .forEach(line => guide.addRow([line]));
  guide.getRow(1).font = { bold: true };
  guide.eachRow(row => { row.alignment = { wrapText: true, vertical: "top" }; row.height = 36; });
  guide.lastRow!.height = 72;
  return workbook.xlsx.writeBuffer();
}
