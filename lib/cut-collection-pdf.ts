import PDFDocument from "pdfkit";
import type { CutReport, CutRiskComparisonItem } from "./cut-collection-types";
import { CUT_RISK_INDICATORS, getCutFpdLevel } from "./cut-risk-presentation";

// Shared FINSER PAY palette (app/globals.css); built-in fonts travel with PDFKit.
const COLORS = {
  graphite: "#151A21", muted: "#667085", border: "#D8DEE5", lime: "#B7E63D",
  porcelain: "#F5F6F4", white: "#FFFFFF", date: "#F5F8ED",
};
const MARGIN = 40;
const TABLE_HEADING = 40;
const ROW_HEIGHT = 92;
const ROW_GAP = 9;
const NUMBER = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const FPD_COLORS = {
  EXCELENTE: { background: "#F2F9DF", foreground: "#365314" },
  BUENO: { background: "#EDF6ED", foreground: "#285334" },
  REGULAR: { background: "#FFF6DF", foreground: "#7C450D" },
  MALO: { background: "#FFF1F0", foreground: "#B42318" },
};

function clean(value: string) { return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim(); }
function count(value: number) { return Number.isFinite(value) ? NUMBER.format(value) : "-"; }
function percent(value: number | null) { return value != null && Number.isFinite(value) ? `${PERCENT.format(value)} %` : "No aplica"; }
function dateLabel(value: string) {
  const date = new Date(`${value}T12:00:00-05:00`);
  if (!Number.isFinite(+date)) return "Fecha no disponible";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "long", year: "numeric",
  }).format(date);
}

/** Aggregate presentation of the authorized report. No queries, writes or personal detail. */
export async function buildCutCollectionPdf(report: CutReport, comparison?: CutRiskComparisonItem[]): Promise<Buffer> {
  const cuts = comparison?.length ? comparison : [{
    cutDate: report.cutDate, queriedAt: report.asOf, earlyRisk: report.earlyRisk ?? [],
  }];
  const title = "Riesgo temprano por corte";
  const doc = new PDFDocument({
    size: "A4", layout: "landscape", margin: MARGIN, bufferPages: true, compress: true,
    info: { Title: cuts.length === 1 ? `${title} - ${cuts[0].cutDate}` : title, Author: "FINSER PAY", Subject: "Indicadores de riesgo temprano" },
  });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  const width = doc.page.width - MARGIN * 2;
  const bottom = doc.page.height - 60;
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
  const ally = report.filters.aliadoId == null ? "Todos los permitidos" : clean(
    report.options.aliados.find(item => item.id === report.filters.aliadoId)?.nombre || `Aliado ${report.filters.aliadoId}`);
  const site = report.filters.sedeId == null ? "Todas las permitidas" : clean(
    report.options.sedes.find(item => item.id === report.filters.sedeId)?.nombre || `Sede ${report.filters.sedeId}`);
  function pageHeader(continued = false) {
    brand();
    text(title, MARGIN, 68, width, continued ? 20 : 29, true);
    const scopeTop = continued ? 99 : 113;
    const half = width / 2;
    const valueWidth = half - 36;
    const scopeHeight = 36 + Math.max(height(ally, valueWidth, 11, true), height(site, valueWidth, 11, true));
    doc.roundedRect(MARGIN, scopeTop, width, scopeHeight, 8).fill(COLORS.porcelain);
    for (const [index, [label, value]] of [["ALIADO", ally], ["SEDE", site]].entries()) {
      const x = MARGIN + index * half + 17;
      text(label, x, scopeTop + 11, valueWidth, 8, true, COLORS.muted);
      text(value, x, scopeTop + 24, valueWidth, 11, true);
    }
    y = scopeTop + scopeHeight + 17;
  }
  const dateWidth = 128;
  const metricWidth = (width - dateWidth) / CUT_RISK_INDICATORS.length;
  function matrixHeader() {
    doc.roundedRect(MARGIN, y, width, TABLE_HEADING, 8).fill(COLORS.graphite);
    doc.roundedRect(MARGIN + 14, y + 12, 4, 16, 2).fill(COLORS.lime);
    text("CORTE", MARGIN + 25, y + 15, dateWidth - 32, 10, true, COLORS.white);
    CUT_RISK_INDICATORS.forEach(({ label }, column) => {
      const x = MARGIN + dateWidth + column * metricWidth + 13;
      fitted(label, x, y + 14, metricWidth - 25, 10, COLORS.white);
    });
    y += TABLE_HEADING + ROW_GAP;
  }
  pageHeader();
  matrixHeader();
  for (const [position, cut] of cuts.entries()) {
    if (y + ROW_HEIGHT > bottom) {
      doc.addPage();
      pageHeader(true);
      matrixHeader();
    }
    doc.roundedRect(MARGIN, y, width, ROW_HEIGHT, 8).lineWidth(0.7).strokeColor(COLORS.border).stroke();
    doc.roundedRect(MARGIN + 1, y + 1, dateWidth - 4, ROW_HEIGHT - 2, 7).fill(COLORS.date);
    const [dayMonth, year] = dateLabel(cut.cutDate).split(/ de (?=\d{4}$)/);
    text(`CORTE ${String(position + 1).padStart(2, "0")}`, MARGIN + 14, y + 16, dateWidth - 27, 8, true, COLORS.muted);
    fitted(dayMonth, MARGIN + 14, y + 33, dateWidth - 27, 13);
    if (year) text(year, MARGIN + 14, y + 51, dateWidth - 27, 11, false, COLORS.muted);
    CUT_RISK_INDICATORS.forEach(({ key, hasFpdLevel }, column) => {
      const left = MARGIN + dateWidth + column * metricWidth;
      if (column > 0) doc.moveTo(left, y + 12).lineTo(left, y + ROW_HEIGHT - 12).lineWidth(0.5).strokeColor(COLORS.border).stroke();
      const x = left + 13;
      const available = metricWidth - 25;
      const metric = cut.earlyRisk.find(item => item.label === key);
      const rate = metric && metric.eligible > 0 ? metric.cases / metric.eligible * 100 : null;
      const level = hasFpdLevel && rate !== null ? getCutFpdLevel(rate) : null;
      fitted(rate === null ? "Sin base" : percent(rate), x, y + 12, available, rate === null ? 13 : 19);
      const status = level ?? (rate !== null ? "" : metric?.pending ? "POR MADURAR" : metric?.unavailable ? "SIN DATOS" : "");
      if (status) {
        const tone = level ? FPD_COLORS[level] : { background: "#FFF6DF", foreground: "#7C450D" };
        const pillWidth = Math.min(available, 78);
        doc.roundedRect(x, y + 36, pillWidth, 16, 4).fill(tone.background);
        text(status, x, y + 40, pillWidth, 7.5, true, tone.foreground, "center");
      }
      const details = metric ? [
        metric.eligible > 0 ? `${count(metric.cases)} de ${count(metric.eligible)} en riesgo` : "0 evaluados",
        metric.pending > 0 ? `Por madurar: ${count(metric.pending)}` : "",
        metric.unavailable > 0 ? `Sin datos: ${count(metric.unavailable)}` : "",
      ] : ["Sin datos disponibles"];
      details.filter(Boolean).forEach((detail, index) => text(detail, x, y + (status ? 58 : 45) + index * 10, available, 8.5, false, COLORS.muted));
    });
    y += ROW_HEIGHT + ROW_GAP;
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
