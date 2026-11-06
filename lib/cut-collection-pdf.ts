import PDFDocument from "pdfkit";
import type { CutReport, CutRiskComparisonItem } from "./cut-collection-types";
import { getCutFpdLevel } from "./cut-risk-presentation";

// Shared FINSER PAY palette (app/globals.css); built-in fonts travel with PDFKit.
const COLORS = {
  graphite: "#151A21", muted: "#667085", border: "#D8DEE5", lime: "#B7E63D",
  porcelain: "#F5F6F4", white: "#FFFFFF",
};
const MARGIN = 40;
const TABLE_HEADING = 35;
const ROW_HEIGHT = 89;
const NUMBER = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const RISK_LABELS = ["DPF 3", "DPF 7", "DPF 15", "40/60"] as const;
const FPD_COLORS = {
  EXCELENTE: { background: "#F2F9DF", foreground: "#365314" },
  BUENO: { background: "#EDF6ED", foreground: "#285334" },
  REGULAR: { background: "#FFF6DF", foreground: "#7C450D" },
  MALO: { background: "#FFF1F0", foreground: "#B42318" },
};

function clean(value: string) { return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(); }
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
export async function buildCutCollectionPdf(report: CutReport, comparison?: CutRiskComparisonItem[]): Promise<Buffer> {
  const cuts = comparison?.length ? comparison : [{
    cutDate: report.cutDate, queriedAt: report.asOf, earlyRisk: report.earlyRisk ?? [],
  }];
  const title = "Riesgo temprano por corte";
  const doc = new PDFDocument({
    size: "A4", margin: MARGIN, bufferPages: true, compress: true,
    info: { Title: cuts.length === 1 ? `${title} - ${cuts[0].cutDate}` : title, Author: "FINSER PAY", Subject: "Indicadores de riesgo temprano" },
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
  function brand() {
    text("FINSER", MARGIN, 31, 81, 19, true);
    text("PAY", MARGIN + 83, 31, 50, 19, true);
    doc.roundedRect(MARGIN + 134, 33, 7, 16, 3).fill(COLORS.lime);
    text("RIESGO TEMPRANO", MARGIN + 270, 38, width - 270, 8, true, COLORS.muted, "right");
  }
  function ensureSpace(required: number) {
    if (y + required <= bottom) return;
    doc.addPage();
    brand();
    text(title, MARGIN, 65, width, 14, true);
    fitted(ally, MARGIN, 87, width, 9, COLORS.muted);
    line(106);
    y = 122;
  }
  const ally = report.filters.aliadoId == null ? "Todos los permitidos" : clean(
    report.options.aliados.find(item => item.id === report.filters.aliadoId)?.nombre || `Aliado ${report.filters.aliadoId}`);
  const site = report.filters.sedeId == null ? "Todas las permitidas" : clean(
    report.options.sedes.find(item => item.id === report.filters.sedeId)?.nombre || `Sede ${report.filters.sedeId}`);
  brand();
  text(title, MARGIN, 69, width, 27, true);
  text(`Consultado al ${dateLabel(cuts[0].queriedAt, true)} | Hora de Colombia (UTC-05:00)`, MARGIN, 106, width, 9, false, COLORS.muted);
  y = 132;
  // Full-width scope values wrap, including long unbroken names, without truncation.
  for (const [label, value] of [["ALIADO", ally], ["SEDE", site]]) {
    const labelWidth = 110;
    const rowHeight = Math.max(14, height(value, width - labelWidth, 10));
    ensureSpace(rowHeight + 8);
    text(label, MARGIN, y + 1, labelWidth - 8, 8, true, COLORS.muted);
    text(value, MARGIN + labelWidth, y, width - labelWidth, 10);
    y += rowHeight + 5;
  }
  y += 12;
  const dateWidth = 120;
  const metricWidth = (width - dateWidth) / RISK_LABELS.length;
  function matrixHeader() {
    doc.roundedRect(MARGIN, y, width, TABLE_HEADING + 5, 7).fill(COLORS.graphite);
    doc.roundedRect(MARGIN + 12, y + 10, 4, 15, 2).fill(COLORS.lime);
    text("CORTE", MARGIN + 24, y + 13, dateWidth - 30, 9, true, COLORS.white);
    RISK_LABELS.forEach((label, column) => {
      const x = MARGIN + dateWidth + column * metricWidth + 10;
      text(label.replace("DPF", "FPD"), x, y + (label === "40/60" ? 7 : 12), metricWidth - 18, 11, true, COLORS.white);
      if (label === "40/60") fitted("6 cuotas en 3 meses", x, y + 21, metricWidth - 18, 8, COLORS.lime);
    });
    y += TABLE_HEADING;
  }
  ensureSpace(TABLE_HEADING + ROW_HEIGHT);
  matrixHeader();
  for (const [position, cut] of cuts.entries()) {
    if (y + ROW_HEIGHT > bottom) {
      ensureSpace(TABLE_HEADING + ROW_HEIGHT);
      matrixHeader();
    }
    doc.rect(MARGIN, y, width, ROW_HEIGHT).fill(position % 2 ? "#FAFBFA" : COLORS.white);
    doc.rect(MARGIN, y, dateWidth, ROW_HEIGHT).fill(COLORS.porcelain);
    const [dayMonth, year] = dateLabel(cut.cutDate).split(/ de (?=\d{4}$)/);
    text(`CORTE ${String(position + 1).padStart(2, "0")}`, MARGIN + 12, y + 13, dateWidth - 24, 8, true, COLORS.muted);
    fitted(dayMonth, MARGIN + 12, y + 29, dateWidth - 24, 12);
    if (year) text(year, MARGIN + 12, y + 45, dateWidth - 24, 11, true);
    RISK_LABELS.forEach((label, column) => {
      const left = MARGIN + dateWidth + column * metricWidth;
      doc.moveTo(left, y).lineTo(left, y + ROW_HEIGHT).lineWidth(0.5).strokeColor(COLORS.border).stroke();
      const x = left + 10;
      const available = metricWidth - 20;
      const metric = cut.earlyRisk.find(item => item.label === label);
      const rate = metric && metric.eligible > 0 ? metric.cases / metric.eligible * 100 : null;
      const level = label !== "40/60" && rate !== null ? getCutFpdLevel(rate) : null;
      fitted(rate === null ? "Sin base" : percent(rate), x, y + 10, available, rate === null ? 12 : 16);
      const status = level ?? (rate !== null ? "" : metric?.pending ? "POR MADURAR" : metric?.unavailable ? "SIN DATOS" : "");
      if (status) {
        const tone = level ? FPD_COLORS[level] : { background: "#FFF6DF", foreground: "#7C450D" };
        const pillWidth = Math.min(available, 72);
        doc.roundedRect(x, y + 28, pillWidth, 14, 4).fill(tone.background);
        text(status, x, y + 31, pillWidth, 7, true, tone.foreground, "center");
      }
      const details = metric ? [
        metric.eligible > 0 ? `${count(metric.cases)} de ${count(metric.eligible)} en riesgo` : "0 evaluados",
        `Por madurar: ${count(metric.pending)}`, `Sin datos: ${count(metric.unavailable)}`,
      ] : ["Sin datos disponibles"];
      details.forEach((detail, index) => fitted(detail, x, y + 48 + index * 12, available, 8, COLORS.muted));
    });
    y += ROW_HEIGHT;
    line(y);
  }

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index++) {
    doc.switchToPage(index);
    const footer = doc.page.height - 52;
    line(footer - 10);
    text("FINSER PAY  |  Indicadores de riesgo", MARGIN, footer, width - 105, 8, false, COLORS.muted);
    text(`Página ${index + 1} de ${pages.count}`, MARGIN + width - 105, footer, 105, 8, false, COLORS.muted, "right");
  }
  doc.end();
  return result;
}
