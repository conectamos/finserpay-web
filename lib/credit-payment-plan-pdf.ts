import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { creditDisplayNumber } from "@/lib/credit-display-number";
import type { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";

type PaymentPlan = ReturnType<typeof buildCreditPaymentPlan>;
type Fonts = { regular: string; bold: string };

export type CreditPaymentPlanPdfInput = {
  folio: string;
  numeroCreditoVisible?: string;
  clienteNombre: string;
  clienteDocumento: string;
  sedeNombre: string;
  equipo: string;
  fechaGeneracion: Date;
  valorCuota: number;
  frecuencia: string;
  referenciaEfecty: string;
  convenioEfecty: string;
  plan: PaymentPlan;
};

const BUNDLED_FONT_REGULAR = path.join(process.cwd(), "public", "pdf-fonts", "Geist-Regular.ttf");
const MONEY_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
// Print equivalents of the shared FINSER PAY graphite, border and client-green tokens.
const COLORS = {
  graphite: "#151A21",
  muted: "#667085",
  border: "#D8DEE5",
  green: "#237F0B",
  greenSoft: "#F2F9DF",
  red: "#B42318",
  redSoft: "#FFF1F0",
  white: "#FFFFFF",
};
const MARGIN = 36;
const TABLE_FONT_SIZE = 9.5;
const ROW_MIN_HEIGHT = 28;
const CELL_PADDING = 8;
const CELL_VERTICAL_PADDING = 6;
const FOOTER_HEIGHT = 48;

function money(value: number) {
  return MONEY_FORMATTER.format(Math.round(Number(value || 0))).replace("COP", "$");
}

export function paymentPlanDateLabel(value: Date | string | null | undefined) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "-";
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function stateLabel(item: PaymentPlan["installments"][number], nextNumber: number | null) {
  if (item.eliminada) return "Eliminada";
  if (item.estado === "PAGO") return "Pagada";
  if (item.estaEnMora) return "En mora";
  if (item.numero === nextNumber) return "Próxima";
  return "Pendiente";
}

function fontSet(): Fonts {
  return {
    regular: existsSync(BUNDLED_FONT_REGULAR) ? BUNDLED_FONT_REGULAR : "Helvetica",
    bold: "Helvetica-Bold",
  };
}

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function rule(doc: PDFKit.PDFDocument, y: number) {
  doc.save().lineWidth(0.6).strokeColor(COLORS.border)
    .moveTo(MARGIN, y).lineTo(doc.page.width - MARGIN, y).stroke().restore();
}

function wordmark(doc: PDFKit.PDFDocument, fonts: Fonts, x: number, y: number, size: number) {
  doc.font(fonts.bold).fontSize(size).fillColor(COLORS.green).text("FINSER", x, y, { lineBreak: false });
  const payX = x + doc.widthOfString("FINSER ");
  doc.fillColor(COLORS.graphite).text("PAY", payX, y, { lineBreak: false });
}

function textHeight(doc: PDFKit.PDFDocument, fonts: Fonts, value: string, width: number, size: number, bold = false) {
  return doc.font(bold ? fonts.bold : fonts.regular).fontSize(size)
    .heightOfString(value, { width, lineGap: 2 });
}

function field(doc: PDFKit.PDFDocument, fonts: Fonts, x: number, y: number, width: number, label: string, value: string) {
  const content = String(value || "-").trim() || "-";
  const height = textHeight(doc, fonts, content, width, 12);
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted).text(label, x, y, { width });
  doc.fontSize(12).fillColor(COLORS.graphite).text(content, x, y + 17, { width, lineGap: 2 });
  return 17 + height;
}

function calendarIcon(doc: PDFKit.PDFDocument, x: number, y: number) {
  doc.save().lineWidth(1.5).strokeColor(COLORS.green);
  doc.roundedRect(x, y + 3, 19, 19, 2).stroke();
  doc.moveTo(x, y + 9).lineTo(x + 19, y + 9).stroke();
  doc.moveTo(x + 5, y).lineTo(x + 5, y + 6).stroke();
  doc.moveTo(x + 14, y).lineTo(x + 14, y + 6).stroke();
  doc.restore();
}

function amountIcon(doc: PDFKit.PDFDocument, fonts: Fonts, x: number, y: number) {
  doc.save().lineWidth(1.5).strokeColor(COLORS.green).circle(x + 10, y + 12, 10).stroke();
  doc.font(fonts.bold).fontSize(13).fillColor(COLORS.green).text("$", x, y + 5, { width: 20, align: "center", lineBreak: false });
  doc.restore();
}

function fitFontSize(doc: PDFKit.PDFDocument, font: string, value: string, width: number, preferred: number) {
  let size = preferred;
  while (size > 16 && doc.font(font).fontSize(size).widthOfString(value) > width) size -= 0.5;
  return size;
}

function columnWidths(width: number) {
  return [45, 108, 98, 98, 98, width - 447];
}

function drawTableHeader(doc: PDFKit.PDFDocument, fonts: Fonts, y: number) {
  const headers = ["Cuota", "Vencimiento", "Valor", "Abonado", "Pendiente", "Estado"];
  const widths = columnWidths(doc.page.width - MARGIN * 2);
  let x = MARGIN;
  headers.forEach((header, index) => {
    doc.font(fonts.regular).fontSize(TABLE_FONT_SIZE).fillColor(COLORS.muted).text(header, x + CELL_PADDING, y + 7, {
      width: widths[index] - CELL_PADDING * 2,
      align: index > 1 && index < 5 ? "right" : "left",
      lineBreak: false,
    });
    x += widths[index];
  });
  rule(doc, y + 27);
  return y + 28;
}

function continuationHeader(doc: PDFKit.PDFDocument, fonts: Fonts, input: CreditPaymentPlanPdfInput) {
  const width = doc.page.width - MARGIN * 2;
  wordmark(doc, fonts, MARGIN, MARGIN, 17);
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted).text("Plan de pagos", MARGIN, MARGIN + 27);
  const number = creditDisplayNumber(input);
  const numberWidth = width - 200;
  const height = textHeight(doc, fonts, number, numberWidth, 10);
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.graphite).text(number, MARGIN + 200, MARGIN + 6, {
    width: numberWidth, align: "right", lineGap: 2,
  });
  const bottom = Math.max(MARGIN + 49, MARGIN + 6 + height + 12);
  rule(doc, bottom);
  return drawTableHeader(doc, fonts, bottom + 12);
}

export async function buildCreditPaymentPlanPdf(input: CreditPaymentPlanPdfInput) {
  const fonts = fontSet();
  const doc = new PDFDocument({
    size: "A4", margin: MARGIN, compress: true, bufferPages: true, font: fonts.regular,
    info: { Title: `Plan de pagos ${creditDisplayNumber(input)}`, Author: "FINSER PAY" },
  });
  const bufferPromise = toBuffer(doc);
  const width = doc.page.width - MARGIN * 2;
  const right = doc.page.width - MARGIN;
  const next = input.plan.estadoPago === "PAGADO" ? null : input.plan.nextInstallment;
  const nextNumber = next?.numero ?? null;
  const activeInstallments = input.plan.installments.filter((item) => !item.eliminada);
  const paidRatio = activeInstallments.length ? Math.min(1, Math.max(0, input.plan.paidCount / activeInstallments.length)) : 0;
  const inMora = input.plan.estadoPago === "MORA";
  const state = inMora ? "En mora" : input.plan.estadoPago === "PAGADO" ? "Finalizado" : "Al día";
  const stateColor = inMora ? COLORS.red : COLORS.green;

  wordmark(doc, fonts, MARGIN, 36, 26);
  doc.font(fonts.bold).fontSize(23).fillColor(COLORS.graphite).text("Plan de pagos", MARGIN, 74, { width: 280, lineBreak: false });
  const identityWidth = 240;
  const identityX = right - identityWidth;
  const number = creditDisplayNumber(input);
  const numberHeight = textHeight(doc, fonts, number, identityWidth, 10);
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted).text(number, identityX, 39, {
    width: identityWidth, align: "right", lineGap: 2,
  });
  let identityBottom = 39 + numberHeight;
  if (number !== input.folio) {
    const original = `Folio original: ${input.folio}`;
    const originalHeight = textHeight(doc, fonts, original, identityWidth, 8.5);
    doc.font(fonts.regular).fontSize(8.5).fillColor(COLORS.muted).text(original, identityX, identityBottom + 5, {
      width: identityWidth, align: "right", lineGap: 2,
    });
    identityBottom += originalHeight + 5;
  }
  const stateY = Math.max(77, identityBottom + 10);
  doc.save().roundedRect(right - 91, stateY, 91, 25, 12).fill(inMora ? COLORS.redSoft : COLORS.greenSoft).restore();
  doc.font(fonts.bold).fontSize(10).fillColor(stateColor).text(state, right - 91, stateY + 7, { width: 91, align: "center", lineBreak: false });
  let y = Math.max(117, stateY + 39);
  rule(doc, y);
  y += 21;

  const dataGap = 44;
  const leftWidth = width * 0.58;
  const rightX = MARGIN + leftWidth + dataGap;
  const rightWidth = width - leftWidth - dataGap;
  y += Math.max(
    field(doc, fonts, MARGIN, y, leftWidth, "Cliente", input.clienteNombre),
    field(doc, fonts, rightX, y, rightWidth, "Sede", input.sedeNombre)
  ) + 12;
  y += Math.max(
    field(doc, fonts, MARGIN, y, leftWidth, "Documento", input.clienteDocumento),
    field(doc, fonts, rightX, y, rightWidth, "Frecuencia", input.frecuencia)
  ) + 12;
  y += field(doc, fonts, MARGIN, y, width, "Equipo", input.equipo) + 20;
  rule(doc, y);
  y += 19;

  doc.font(fonts.regular).fontSize(15).fillColor(COLORS.graphite).text(next ? (next.estaEnMora ? "Cuota vencida" : "Próxima cuota") : "Crédito finalizado", MARGIN, y);
  const summaryY = y + 31;
  const half = width / 2;
  const date = next ? paymentPlanDateLabel(next.fechaVencimiento) : "Sin cuotas pendientes";
  const dateSize = fitFontSize(doc, fonts.bold, date, half - 39, next ? 25 : 18);
  if (next) calendarIcon(doc, MARGIN + 1, summaryY + 4);
  doc.font(fonts.bold).fontSize(dateSize).fillColor(COLORS.graphite).text(date, MARGIN + (next ? 32 : 0), summaryY, {
    width: half - (next ? 39 : 8), lineGap: 2,
  });
  amountIcon(doc, fonts, MARGIN + half + 18, summaryY + 4);
  const amount = money(next?.saldoPendiente || 0);
  const amountWidth = half - 52;
  doc.font(fonts.bold).fontSize(fitFontSize(doc, fonts.bold, amount, amountWidth, 26)).fillColor(COLORS.graphite).text(amount, MARGIN + half + 50, summaryY, {
    width: amountWidth, lineGap: 2,
  });
  doc.save().strokeColor(COLORS.border).lineWidth(0.6).moveTo(MARGIN + half - 4, summaryY).lineTo(MARGIN + half - 4, summaryY + 37).stroke().restore();
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted).text(
    next ? `Cuota ${next.numero} de ${activeInstallments.length}` : `${input.plan.paidCount} de ${activeInstallments.length} cuotas pagadas`,
    MARGIN + (next ? 32 : 0), summaryY + 39, { width: half - 39 }
  );
  y = summaryY + 64;
  doc.save().roundedRect(MARGIN, y, width, 7, 3.5).fill(COLORS.border).restore();
  if (paidRatio > 0) doc.save().roundedRect(MARGIN, y, Math.max(7, width * paidRatio), 7, 3.5).fill(COLORS.green).restore();
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted).text(`${input.plan.paidCount} de ${activeInstallments.length} pagadas`, MARGIN, y + 14, {
    width, align: "right",
  });
  y += 43;
  const efecty = `Efecty · Convenio ${input.convenioEfecty} · Referencia ${input.referenciaEfecty}`;
  const efectyHeight = textHeight(doc, fonts, efecty, width, 10);
  doc.font(fonts.regular).fontSize(10).fillColor(COLORS.graphite).text(efecty, MARGIN, y, { width, lineGap: 2 });
  y += efectyHeight + 20;
  rule(doc, y);
  y += 11;
  const tableBottom = doc.page.height - MARGIN - FOOTER_HEIGHT;
  if (y + 28 + ROW_MIN_HEIGHT > tableBottom) {
    doc.addPage();
    y = continuationHeader(doc, fonts, input);
  } else {
    y = drawTableHeader(doc, fonts, y);
  }
  const widths = columnWidths(width);
  for (const item of input.plan.installments) {
    const isNext = item.numero === nextNumber;
    const values = [String(item.numero), paymentPlanDateLabel(item.fechaVencimiento), money(item.valorProgramado), money(item.valorAbonado), money(item.saldoPendiente), stateLabel(item, nextNumber)];
    const rowHeight = Math.max(ROW_MIN_HEIGHT, ...values.map((value, index) => textHeight(doc, fonts, value, widths[index] - CELL_PADDING * 2, TABLE_FONT_SIZE) + CELL_VERTICAL_PADDING * 2));
    if (y + rowHeight > tableBottom) {
      doc.addPage();
      y = continuationHeader(doc, fonts, input);
    }
    if (isNext && !item.eliminada) {
      doc.save().roundedRect(MARGIN, y + 1, width, rowHeight - 2, 3).fill(item.estaEnMora ? COLORS.redSoft : COLORS.greenSoft).restore();
    }
    let x = MARGIN;
    values.forEach((value, index) => {
      const color = item.eliminada ? COLORS.muted : index === 5 && item.estaEnMora ? COLORS.red : index === 5 && (item.estado === "PAGO" || isNext) ? COLORS.green : COLORS.graphite;
      doc.font(fonts.regular).fontSize(TABLE_FONT_SIZE).fillColor(color).text(value, x + CELL_PADDING, y + CELL_VERTICAL_PADDING, {
        width: widths[index] - CELL_PADDING * 2, lineGap: 2,
        align: index > 1 && index < 5 ? "right" : "left",
      });
      x += widths[index];
    });
    y += rowHeight;
    rule(doc, y);
  }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    const footerY = doc.page.height - MARGIN - 37;
    rule(doc, footerY);
    doc.font(fonts.regular).fontSize(8.5).fillColor(COLORS.muted).text("Conserva este documento para consultar tus fechas de pago.", MARGIN, footerY + 10, { width: width - 95, lineBreak: false });
    doc.text(`Página ${index - range.start + 1} de ${range.count}`, right - 91, footerY + 10, { width: 91, align: "right", lineBreak: false });
    doc.fontSize(7.5).text(`Generado ${paymentPlanDateLabel(input.fechaGeneracion)} · Abonos registrados a esta fecha.`, MARGIN, footerY + 23, { width, lineBreak: false });
  }
  doc.end();
  return bufferPromise;
}