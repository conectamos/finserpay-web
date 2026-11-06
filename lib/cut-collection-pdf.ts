import PDFDocument from "pdfkit";
import type { CutReport } from "./cut-collection-types";

// Shared FINSER PAY palette (app/globals.css); built-in fonts travel with PDFKit.
const COLORS = {
  graphite: "#151A21", muted: "#667085", border: "#D8DEE5", lime: "#B7E63D",
  porcelain: "#F5F6F4", white: "#FFFFFF", amber: "#B86B10", amberSoft: "#FFF6DF",
};
const MARGIN = 40;
const MONEY = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", minimumFractionDigits: 2, maximumFractionDigits: 2,
});
const NUMBER = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const RISK_LABELS = ["DPF 3", "DPF 7", "DPF 15", "40/60"] as const;

function clean(value: string) { return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(); }
function money(value: number) { return Number.isFinite(value) ? MONEY.format(value).replace(/\u00A0/g, " ") : "No disponible"; }
function count(value: number) { return Number.isFinite(value) ? NUMBER.format(value) : "-"; }
function percent(value: number | null) { return value != null && Number.isFinite(value) ? `${PERCENT.format(value)} %` : "No aplica"; }
function dateLabel(value: string, timestamp = false) {
  const date = new Date(timestamp ? value : `${value}T12:00:00-05:00`);
  if (!Number.isFinite(+date)) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "long", year: "numeric",
    ...(timestamp ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  }).format(date);
}

/** Aggregate presentation of the authorized report. No queries, writes or personal detail. */
export async function buildCutCollectionPdf(report: CutReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4", margin: MARGIN, bufferPages: true, compress: true,
    info: { Title: `Recaudo por corte - ${report.cutDate}`, Author: "FINSER PAY", Subject: "Resumen agregado del recaudo y riesgo temprano" },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - MARGIN * 2;
  const bottom = doc.page.height - 66;
  let y = MARGIN;

  function text(value: string, x: number, top: number, available: number, size = 10, bold = false, color = COLORS.graphite,
    align: "left" | "right" | "center" = "left") {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color)
      .text(value, x, top, { width: available, lineGap: 2, align });
  }
  function height(value: string, available: number, size = 10, bold = false) {
    return doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size)
      .heightOfString(value, { width: available, lineGap: 2 });
  }
  function fitted(value: string, x: number, top: number, available: number, preferred: number, color = COLORS.graphite,
    align: "left" | "right" = "left") {
    doc.font("Helvetica-Bold").fontSize(preferred);
    const actual = Math.min(preferred, preferred * available / Math.max(1, doc.widthOfString(value)));
    doc.fontSize(actual).fillColor(color).text(value, x, top, { width: available, align, lineBreak: false });
  }
  function line(top: number) {
    doc.moveTo(MARGIN, top).lineTo(MARGIN + width, top).lineWidth(0.7).strokeColor(COLORS.border).stroke();
  }
  function brand(continuation = false) {
    text("FINSER", MARGIN, 31, 81, 19, true);
    text("PAY", MARGIN + 83, 31, 50, 19, true);
    doc.roundedRect(MARGIN + 134, 33, 7, 16, 3).fill(COLORS.lime);
    text("RESUMEN DE RECAUDO", MARGIN + 270, 38, width - 270, 8, true, COLORS.muted, "right");
    if (continuation) {
      text(`Recaudo por corte | ${dateLabel(report.cutDate)}`, MARGIN, 66, width, 10, true);
      line(86);
      y = 103;
    }
  }
  function ensureSpace(required: number) {
    if (y + required <= bottom) return;
    doc.addPage();
    brand(true);
  }
  function paragraph(value: string, size = 9, color = COLORS.muted, gap = 8) {
    const required = height(value, width, size);
    ensureSpace(required + gap);
    text(value, MARGIN, y, width, size, false, color);
    y += required + gap;
  }

  brand();
  text("Recaudo por corte", MARGIN, 74, width, 27, true);
  text(dateLabel(report.cutDate), MARGIN, 110, width, 14, true);
  text(`Consultado al ${dateLabel(report.asOf, true)} | Hora de Colombia (UTC-05:00)`, MARGIN, 133, width, 9, false, COLORS.muted);
  y = 151;

  const ally = report.filters.aliadoId == null ? "Todos los permitidos" : clean(
    report.options.aliados.find(item => item.id === report.filters.aliadoId)?.nombre || `Aliado ${report.filters.aliadoId}`);
  const site = report.filters.sedeId == null ? "Todas las permitidas" : clean(
    report.options.sedes.find(item => item.id === report.filters.sedeId)?.nombre || `Sede ${report.filters.sedeId}`);
  const state = { todos: "Todos", pendiente: "Pendiente", parcial: "Parcial", pagado: "Pagado" }[report.filters.status];
  // Full-width scope values wrap, including long unbroken names, without truncation.
  for (const [label, value] of [["ALIADO", ally], ["SEDE", site], ["ESTADO DE CUOTA", state]]) {
    const labelWidth = 110;
    const rowHeight = Math.max(14, height(value, width - labelWidth, 10));
    ensureSpace(rowHeight + 8);
    text(label, MARGIN, y + 1, labelWidth - 8, 8, true, COLORS.muted);
    text(value, MARGIN + labelWidth, y, width - labelWidth, 10);
    y += rowHeight + 5;
  }
  line(y + 3);
  y += 14;

  const summary = report.summary;
  ensureSpace(184);
  doc.roundedRect(MARGIN, y, width, 130, 11).fill(COLORS.graphite);
  text("RECAUDO ESPERADO", MARGIN + 20, y + 17, width - 40, 9, true, COLORS.lime);
  fitted(money(summary.expected), MARGIN + 20, y + 35, width - 40, 30, COLORS.white);
  const half = (width - 56) / 2;
  text("Recibido", MARGIN + 20, y + 84, half, 10, false, COLORS.white);
  text("Pendiente por recaudar", MARGIN + 36 + half, y + 84, half, 10, false, COLORS.white);
  fitted(money(summary.received), MARGIN + 20, y + 101, half, 20, COLORS.lime);
  fitted(money(summary.pending), MARGIN + 36 + half, y + 101, half, 20, COLORS.white);
  y += 145;
  text("Cumplimiento del corte", MARGIN, y, width - 135, 10, true);
  fitted(percent(summary.completion), MARGIN + width - 135, y - 2, 135, 15, COLORS.graphite, "right");
  doc.roundedRect(MARGIN, y + 23, width, 7, 3.5).fill(COLORS.porcelain);
  const progress = summary.completion != null && Number.isFinite(summary.completion) ? Math.max(0, Math.min(100, summary.completion)) / 100 : 0;
  if (progress > 0) doc.roundedRect(MARGIN, y + 23, width * progress, 7, Math.min(3.5, width * progress / 2)).fill(COLORS.lime);
  y += 44;

  paragraph(`${count(summary.creditsCount)} créditos del corte  |  ${count(summary.pendingClients)} clientes pendientes`, 10, COLORS.graphite, 12);
  if (summary.completion == null) paragraph("Cumplimiento no aplicable: no hay valor esperado en este alcance.");

  const distribution: [string, number, boolean][] = [
    ["Anticipos del corte (ya incluidos en recibido)", summary.priorPayments, true],
    ["Recuperación de cuotas anteriores", summary.previousRecovery, false],
    ["Anticipos de cuotas futuras", summary.futureAdvances, false],
  ];
  ensureSpace(85);
  for (const [label, value, included] of distribution) {
    text(label, MARGIN, y, width - 165, 9, included);
    fitted(money(value), MARGIN + width - 155, y, 155, 10, COLORS.graphite, "right");
    y += 18;
  }
  paragraph("Recuperación y anticipos futuros: pagos desde el corte; se excluyen de su cumplimiento.", 8.5, COLORS.muted, 13);

  const notes: { value: string; size: number; color: string; gap: number }[] = [
    { value: "DPF 3/7/15: primera cuota incompleta al cierre del día 3, 7 o 15 desde su vencimiento. 40/60: menos de 4 cuotas completas al cierre del día 60 desde la fecha del crédito.", size: 8.5, color: COLORS.muted, gap: 7 },
    { value: "Base: solo créditos evaluados; excluye por madurar y sin datos comparables.", size: 8.5, color: COLORS.muted, gap: 8 },
  ];
  if (report.filters.status !== "todos") notes.push({ value: "Indicadores por aliado y sede, sin filtro de estado.", size: 8.5, color: COLORS.muted, gap: 8 });
  if ((summary.unclassifiedReceived || 0) > 0) notes.push({
    value: `${money(summary.unclassifiedReceived || 0)} del recibido no tiene fecha individual atribuible y no se clasifica como anticipo.`, size: 9, color: COLORS.amber, gap: 8,
  });
  if (report.warnings.length > 0) notes.push({
    value: `${count(report.warnings.length)} ${report.warnings.length === 1 ? "observación disponible" : "observaciones disponibles"} en la plataforma. Se omite el detalle individual.`, size: 9, color: COLORS.amber, gap: 8,
  });
  notes.push({ value: "Esperado: valor total de las cuotas del corte. Recibido: efectivo aplicado a esas cuotas, incluidos anticipos y pagos tardíos. Las cifras corresponden a los filtros y a la consulta indicada.", size: 8.5, color: COLORS.muted, gap: 0 });
  // Keep definitions and caveats with their indicators rather than orphaning a final note.
  ensureSpace(23 + 25 + RISK_LABELS.length * 23 + 10 + notes.reduce((total, note) => total + height(note.value, width, note.size) + note.gap, 0));
  text("Riesgo temprano del corte", MARGIN, y, width, 14, true);
  y += 23;
  const columns = [0, 78, 146, 223, 306, 398, width];
  const headers = ["Indicador", "En riesgo", "Evaluados", "Tasa", "Por madurar", "Sin datos"];
  function riskHeader() {
    doc.roundedRect(MARGIN, y, width, 25, 5).fill(COLORS.porcelain);
    headers.forEach((label, index) => text(label, MARGIN + columns[index] + 8, y + 8,
      columns[index + 1] - columns[index] - 16, 8, true, COLORS.muted, index ? "right" : "left"));
    y += 25;
  }
  riskHeader();
  for (const label of RISK_LABELS) {
    if (y + 23 > bottom) { ensureSpace(48); riskHeader(); }
    const metric = report.earlyRisk?.find(item => item.label === label);
    const cells = metric ? [label, count(metric.cases), count(metric.eligible),
      metric.eligible > 0 ? percent(metric.cases / metric.eligible * 100) : "No aplica", count(metric.pending), count(metric.unavailable)]
      : [label, "-", "-", "No disponible", "-", "-"];
    cells.forEach((value, index) => fitted(value, MARGIN + columns[index] + 8, y + 8,
      columns[index + 1] - columns[index] - 16, index ? 9 : 10, COLORS.graphite, index ? "right" : "left"));
    y += 23;
    line(y);
  }
  y += 10;
  for (const note of notes) paragraph(note.value, note.size, note.color, note.gap);

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    const footer = doc.page.height - 52;
    line(footer - 10);
    text("FINSER PAY  |  Resumen agregado  |  Valores en COP", MARGIN, footer, width - 105, 8, false, COLORS.muted);
    text(`Página ${index + 1} de ${pages.count}`, MARGIN + width - 105, footer, 105, 8, false, COLORS.muted, "right");
  }
  doc.end();
  return result;
}
