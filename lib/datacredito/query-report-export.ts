import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
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

export async function buildQueryReportPdf(report: DetailedQueryReport) {
  const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36, bufferPages: true, info: { Title: "FINSER PAY - Consultas DataCrédito y ventas" } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("data", chunk => chunks.push(Buffer.from(chunk))); doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });
  const width = doc.page.width - 72;
  const pageTitle = (title: string) => {
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#0B1F2D").text(title, 36, 36, { width });
    doc.font("Helvetica").fontSize(10).fillColor("#596778").text(`${report.period.label} | ${report.period.timezone}`, 36, 66, { width });
    doc.moveTo(36, 88).lineTo(doc.page.width - 36, 88).strokeColor("#B5D92A").stroke();
  };
  for (const [index, section] of queryReportTables(report).entries()) {
    if (index) doc.addPage(); pageTitle(section.name);
    const widths = section.headers.length === 8 ? [165,85,75,75,85,85,95,width-665] : section.headers.length === 4 ? [190,95,width-380,95] : [165,195,85,75,75,85,width-680];
    let y = 108;
    const header = () => {
      doc.rect(36,y,width,36).fill("#171C24"); let x = 36;
      section.headers.forEach((h,i) => { doc.font("Helvetica-Bold").fontSize(9).fillColor("white").text(h,x+6,y+7,{ width:widths[i]-12 }); x += widths[i]; }); y += 36;
    };
    header();
    for (const [rowIndex, row] of section.rows.entries()) {
      const values = row.map((v,i) => typeof v === "number" ? section.name === "Resumen por aliado" && i === 7 ? `${(v*100).toLocaleString("es-CO",{maximumFractionDigits:1})} %` : v.toLocaleString("es-CO") : String(v));
      doc.font("Helvetica").fontSize(10);
      const h = Math.max(30,...values.map((v,i) => doc.heightOfString(v,{width:widths[i]-12})+16));
      if (y+h > doc.page.height-54) { doc.addPage(); pageTitle(section.name + " (continuación)"); y = 108; header(); }
      doc.rect(36,y,width,h).fill(rowIndex%2 ? "#EEF1F4" : "#FFFFFF"); let x=36;
      values.forEach((v,i) => { doc.font("Helvetica").fontSize(10).fillColor("#171C24").text(v,x+6,y+8,{width:widths[i]-12,align:typeof row[i] === "number" ? "right" : "left"});x+=widths[i]; });y+=h;
    }
    if (!section.rows.length) doc.font("Helvetica").fontSize(11).fillColor("#596778").text("Sin actividad para los filtros aplicados.",36,y+16);
  }
  doc.addPage(); pageTitle("Criterios y fuentes"); let y=112;
  for (const note of ["Fuente: FINSER PAY / Reportes / DataCrédito vs. ventas", ...queryReportNotes(report)]) { doc.font("Helvetica").fontSize(11).fillColor("#171C24").text(note,36,y,{width});y=doc.y+15; }
  const pages=doc.bufferedPageRange();
  for(let i=0;i<pages.count;i++){doc.switchToPage(i);doc.font("Helvetica").fontSize(8).fillColor("#596778").text(`FINSER PAY | Generado: ${new Date(report.generatedAt).toLocaleString("es-CO",{timeZone:"America/Bogota"})} | ${i+1} / ${pages.count}`,36,doc.page.height-45,{lineBreak:false});}
  doc.end(); return done;
}
