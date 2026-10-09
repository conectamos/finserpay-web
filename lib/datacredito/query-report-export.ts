import ExcelJS from "exceljs";
export { buildQueryReportPdf } from "./query-report-pdf";
import type { getDataCreditoQuerySalesReport } from "./admin-query-sales-report";

export type DetailedQueryReport = Awaited<ReturnType<typeof getDataCreditoQuerySalesReport>> & {
  retentionDays: number;
  providerEnvironment: string;
};

const counts = (r: DetailedQueryReport["sites"][number]) =>
  [r.originalQueries, r.approved, r.rejected, r.notEvaluated, r.reusedAssessments];

export function queryReportTables(report: DetailedQueryReport) {
  return [
    { name: "Resumen por aliado", headers: ["Aliado", "Consultas nuevas", "Aprobadas", "Rechazadas", "No evaluadas", "Reutilizadas", "Ventas finalizadas", "Ventas / consultas"],
      rows: report.rows.map(r => [r.allyName, r.originalQueries, r.approved, r.rejected, r.notEvaluated, r.reusedAssessments, r.sales, r.salesVsOriginalQueriesPercent === null ? "n.a." : r.salesVsOriginalQueriesPercent / 100]) },
    { name: "Líderes por aliado", headers: ["Aliado", "Ranking", "Sede / vendedor", "Consultas nuevas"],
      rows: report.leaders.flatMap(a => ([ ["Sede", a.sites], ["Vendedor", a.sellers] ] as const).flatMap(([type, winners]) => winners.length ? winners.map(w => [a.allyName, type, w.name, w.originalQueries]) : [[a.allyName, type, "Sin consultas nuevas", 0]])) },
    ...([ ["Detalle sedes", report.sites], ["Detalle vendedores", report.sellers] ] as const).map(([name, rows]) => ({ name,
      headers: ["Aliado", name === "Detalle sedes" ? "Sede" : "Vendedor / consultó", "Consultas nuevas", "Aprobadas", "Rechazadas", "No evaluadas", "Reutilizadas"],
      rows: rows.map(r => [r.allyName, r.name, ...counts(r)]) })),
  ];
}

export function queryReportNotes(report: DetailedQueryReport) {
  return [
    `Ambiente: ${report.providerEnvironment}. Retención disponible: ${report.retentionDays} días.`,
    "Aprobadas, rechazadas y no evaluadas corresponden a consultas nuevas. Las reutilizadas no generan una nueva consulta ni cobro.",
    "No evaluadas incluye errores técnicos; no es un rechazo. Se excluyen intentos pendientes y fallos anteriores a la consulta al proveedor.",
    "Ventas: créditos DataCrédito no anulados creados en el período. Ventas / consultas compara eventos del período, no una cohorte de clientes.",
    "Una venta puede usar una consulta de hasta 15 días antes. Ventas / consultas puede superar el 100 %.",
    "Los rankings cuentan consultas nuevas y conservan todos los empates. Vendedor corresponde a quien consultó; se agrupa por identificador.",
    "El historial depende de los registros conservados; los períodos anteriores a la retención vigente pueden estar incompletos.",
  ];
}

export async function buildQueryReportExcel(report: DetailedQueryReport) {
  const wb = new ExcelJS.Workbook(); wb.creator = "FINSER PAY";
  wb.created = new Date(report.generatedAt);
  for (const section of queryReportTables(report)) {
    const sheet = wb.addWorksheet(section.name, { views: [{ state: "frozen", ySplit: 5, showGridLines: false }] });
    sheet.addRow(["FINSER PAY - Consultas DataCrédito y ventas"]);
    sheet.addRow([report.period.label, report.period.timezone]);
    sheet.addRow(["Generado", new Date(report.generatedAt)]); sheet.getCell("B3").numFmt = 'yyyy-mm-dd hh:mm "UTC"';
    sheet.addRow([]); sheet.addRow(section.headers);
    for (const row of section.rows) sheet.addRow(row);
    sheet.columns.forEach((col, i) => { col.width = i < 2 ? 32 : 21; col.font = { name: "Arial", size: 11 }; col.alignment = { vertical: "middle", wrapText: true }; });
    sheet.getRow(1).font = { name: "Arial", size: 15, bold: true, color: { argb: "FF0B1F2D" } };
    const header = sheet.getRow(5); header.height = 34;
    header.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF171C24" } }; cell.font = { name: "Arial", size: 11, bold: true, color: { argb: "FFFFFFFF" } }; });
    for (let n = 6; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n); row.height = 34;
      row.eachCell(cell => { if (typeof cell.value === "number") { cell.numFmt = "#,##0"; cell.alignment = { horizontal: "right", vertical: "middle" }; } });
      if (section.name === "Resumen por aliado") row.getCell(8).numFmt = "0.0%";
    }
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, sheet.rowCount), column: section.headers.length } };
  }
  const notes = wb.addWorksheet("Criterios y fuentes"); notes.getColumn(1).width = 115;
  for (const note of [report.period.label, "Fuente: FINSER PAY / Reportes / DataCrédito vs. ventas", ...queryReportNotes(report)]) {
    const r = notes.addRow([note]); r.height = 38; r.alignment = { wrapText: true, vertical: "middle" }; r.font = { name: "Arial", size: 11 };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
