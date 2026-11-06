import PDFDocument from "pdfkit";
import type { CutReport } from "./cut-collection-types";

// Shared FINSER PAY palette (app/globals.css); built-in fonts travel with PDFKit.
const COLORS = {
  graphite: "#151A21", muted: "#667085", border: "#D8DEE5", lime: "#B7E63D",
  porcelain: "#F5F6F4",
};
const MARGIN = 40;
const NUMBER = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat("es-CO", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const RISK_LABELS = ["DPF 3", "DPF 7", "DPF 15", "40/60"] as const;
const FPD_LEVELS = [
  { max: 5, label: "EXCELENTE", background: "#F2F9DF", foreground: "#365314" },
  { max: 10, label: "BUENO", background: "#EDF6ED", foreground: "#285334" },
  { max: 20, label: "REGULAR", background: "#FFF6DF", foreground: "#7C450D" },
  { max: Infinity, label: "MALO", background: "#FFF1F0", foreground: "#B42318" },
] as const;

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
export async function buildCutCollectionPdf(report: CutReport): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4", margin: MARGIN, bufferPages: true, compress: true,
    info: { Title: `Riesgo temprano - ${report.cutDate}`, Author: "FINSER PAY", Subject: "Indicadores de riesgo temprano" },
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
    text("RIESGO TEMPRANO", MARGIN + 270, 38, width - 270, 8, true, COLORS.muted, "right");
    if (continuation) {
      text(`Riesgo temprano por corte | ${dateLabel(report.cutDate)}`, MARGIN, 66, width, 10, true);
      line(86);
      y = 103;
    }
  }
  function ensureSpace(required: number) {
    if (y + required <= bottom) return;
    doc.addPage();
    brand(true);
  }
  brand();
  text("Riesgo temprano por corte", MARGIN, 74, width, 27, true);
  text(dateLabel(report.cutDate), MARGIN, 110, width, 14, true);
  text(`Consultado al ${dateLabel(report.asOf, true)} | Hora de Colombia (UTC-05:00)`, MARGIN, 133, width, 9, false, COLORS.muted);
  y = 151;

  const ally = report.filters.aliadoId == null ? "Todos los permitidos" : clean(
    report.options.aliados.find(item => item.id === report.filters.aliadoId)?.nombre || `Aliado ${report.filters.aliadoId}`);
  const site = report.filters.sedeId == null ? "Todas las permitidas" : clean(
    report.options.sedes.find(item => item.id === report.filters.sedeId)?.nombre || `Sede ${report.filters.sedeId}`);
  // Full-width scope values wrap, including long unbroken names, without truncation.
  for (const [label, value] of [["ALIADO", ally], ["SEDE", site]]) {
    const labelWidth = 110;
    const rowHeight = Math.max(14, height(value, width - labelWidth, 10));
    ensureSpace(rowHeight + 8);
    text(label, MARGIN, y + 1, labelWidth - 8, 8, true, COLORS.muted);
    text(value, MARGIN + labelWidth, y, width - labelWidth, 10);
    y += rowHeight + 5;
  }
  line(y + 3);
  y += 14;

  ensureSpace(25 + RISK_LABELS.length * 32);
  const columns = [0, 62, 125, 186, 244, 327, 426, width];
  const headers = ["Indicador", "En riesgo", "Evaluados", "Tasa", "Nivel FPD", "Por madurar", "Sin datos"];
  function riskHeader() {
    doc.roundedRect(MARGIN, y, width, 25, 5).fill(COLORS.porcelain);
    headers.forEach((label, index) => text(label, MARGIN + columns[index] + 8, y + 8,
      columns[index + 1] - columns[index] - 16, 8, true, COLORS.muted, index ? "right" : "left"));
    y += 25;
  }
  riskHeader();
  for (const label of RISK_LABELS) {
    if (y + 32 > bottom) { ensureSpace(57); riskHeader(); }
    const metric = report.earlyRisk?.find(item => item.label === label);
    const displayLabel = label.replace("DPF", "FPD");
    const rate = metric && metric.eligible > 0 ? metric.cases / metric.eligible * 100 : null;
    const level = label !== "40/60" && rate !== null ? FPD_LEVELS.find(item => rate <= item.max) : undefined;
    const cells = metric ? [displayLabel, count(metric.cases), count(metric.eligible),
      percent(rate), level?.label ?? "-", count(metric.pending), count(metric.unavailable)]
      : [displayLabel, "-", "-", "No disponible", "-", "-", "-"];
    cells.forEach((value, index) => {
      const x = MARGIN + columns[index] + 8;
      const available = columns[index + 1] - columns[index] - 16;
      if (index === 4 && level) {
        doc.roundedRect(x, y + 7, available, 19, 5).fill(level.background);
        text(value, x, y + 12, available, 8, true, level.foreground, "center");
      } else {
        fitted(value, x, y + 11, available, index ? 9 : 10, COLORS.graphite, index ? "right" : "left");
      }
    });
    y += 32;
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
