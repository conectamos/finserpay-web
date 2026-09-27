import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { creditDisplayNumber } from "@/lib/credit-display-number";

export type CreditPazYSalvoPdfInput = {
  clienteDocumento?: string | null;
  clienteNombre: string;
  deliverableLabel?: string | null;
  deviceUid?: string | null;
  equipo?: string | null;
  estado?: string | null;
  folio: string;
  numeroCreditoVisible?: string;
  imei?: string | null;
  issuedAt: Date;
  issuer: string;
  referenciaPago?: string | null;
  sedeNombre: string;
};

export function getCreditPazYSalvoPdfErrorCode(error: unknown) {
  if (!(error instanceof Error)) return null;
  return /^PYS_PDF_[A-Z_]+$/.test(error.message) ? error.message : null;
}

const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const SYSTEM_FONT_REGULAR = path.join(windowsFontDir, "arial.ttf");
const SYSTEM_FONT_BOLD = path.join(windowsFontDir, "arialbd.ttf");
const BUNDLED_FONT_REGULAR = path.join(process.cwd(), "public", "pdf-fonts", "Geist-Regular.ttf");
const MARGIN = 48;
const COLORS = {
  graphite: "#151A21",
  muted: "#667085",
  border: "#D8DEE5",
  green: "#237F0B",
};

type PdfFonts = { regular: string; bold: string };

function getPdfFonts(useBrandAssets: boolean): PdfFonts {
  if (useBrandAssets && existsSync(SYSTEM_FONT_REGULAR) && existsSync(SYSTEM_FONT_BOLD)) {
    return { regular: SYSTEM_FONT_REGULAR, bold: SYSTEM_FONT_BOLD };
  }
  if (useBrandAssets && existsSync(BUNDLED_FONT_REGULAR)) {
    return { regular: BUNDLED_FONT_REGULAR, bold: "Helvetica-Bold" };
  }
  return { regular: "Helvetica", bold: "Helvetica-Bold" };
}

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function valueOrDash(value: string | null | undefined) {
  return String(value || "").trim() || "-";
}

function stateLabel(value: string | null | undefined) {
  const normalized = valueOrDash(value).replace(/_/g, " ").toLowerCase();
  if (normalized === "-") return "Paz y salvo";
  return normalized.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function issuedAtLabel(value: Date) {
  const issuedAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(issuedAt.getTime())) return "-";
  try {
    return new Intl.DateTimeFormat("es-CO", {
      day: "2-digit", month: "long", year: "numeric", hour: "numeric", minute: "2-digit",
      timeZone: "America/Bogota",
    }).format(issuedAt);
  } catch {
    return issuedAt.toISOString().replace("T", " ").slice(0, 16);
  }
}

/** Wrap complete values, including long identifiers, without reducing their font or omitting characters. */
function wrapText(doc: PDFKit.PDFDocument, text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (doc.widthOfString(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const letter of word) {
        if (line && doc.widthOfString(line + letter) > width) {
          lines.push(line);
          line = "";
        }
        line += letter;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawBrand(doc: PDFKit.PDFDocument, fonts: PdfFonts, x: number, y: number, size: number) {
  doc.font(fonts.bold).fontSize(size).fillColor(COLORS.graphite).text("FINSER", x, y, { lineBreak: false });
  const brandWidth = doc.widthOfString("FINSER ");
  doc.fillColor(COLORS.green).text("PAY", x + brandWidth, y, { lineBreak: false });
}

function drawFulfilledSeal(doc: PDFKit.PDFDocument, fonts: PdfFonts, x: number, y: number) {
  doc.save().strokeColor(COLORS.green).lineWidth(1.4).circle(x, y, 48).stroke();
  doc.lineWidth(0.6).circle(x, y, 43).stroke();
  doc.lineWidth(2.8).lineCap("round").lineJoin("round")
    .moveTo(x - 12, y - 3).lineTo(x - 4, y + 5).lineTo(x + 13, y - 13).stroke().restore();
  doc.font(fonts.bold).fontSize(9.5).fillColor(COLORS.green)
    .text("OBLIGACIÓN", x - 42, y - 31, { width: 84, align: "center", lineBreak: false })
    .text("CUMPLIDA", x - 42, y + 20, { width: 84, align: "center", lineBreak: false });
}

async function renderCreditPazYSalvoPdf(input: CreditPazYSalvoPdfInput, useBrandAssets: boolean) {
  let renderStage = "FONTS";
  try {
    const fonts = getPdfFonts(useBrandAssets);
    renderStage = "DOCUMENT";
    const doc = new PDFDocument({
      size: "A4", margin: MARGIN, compress: true, bufferPages: true, font: fonts.regular,
      info: { Title: `Paz y salvo ${creditDisplayNumber(input)}`, Author: "FINSER PAY" },
    });
    const bufferPromise = toBuffer(doc);
    const width = doc.page.width - MARGIN * 2;
    doc.font(fonts.regular).fontSize(9);
    const footerLineHeight = doc.currentLineHeight(true);
    const footerTop = doc.page.height - MARGIN - footerLineHeight * 2 - 9;
    const bottom = footerTop - 24;
    const creditNumber = creditDisplayNumber(input);
    let y = MARGIN;

    function header(continued = false) {
      renderStage = "HEADER";
      drawBrand(doc, fonts, MARGIN, MARGIN, 22);
      const folioX = MARGIN + width - 258;
      let folioY = MARGIN;
      doc.font(fonts.regular).fontSize(9.5).fillColor(COLORS.muted)
        .text("Folio", folioX, folioY, { width: 258, align: "right", lineBreak: false });
      folioY += 15;
      doc.font(fonts.bold).fontSize(11).fillColor(COLORS.graphite);
      for (const line of wrapText(doc, creditNumber, 258)) {
        doc.text(line, folioX, folioY, { width: 258, align: "right", lineBreak: false });
        folioY += 14;
      }
      if (creditNumber !== valueOrDash(input.folio)) {
        doc.font(fonts.regular).fontSize(9.5).fillColor(COLORS.muted);
        for (const line of wrapText(doc, `Folio original: ${valueOrDash(input.folio)}`, 258)) {
          doc.text(line, folioX, folioY, { width: 258, align: "right", lineBreak: false });
          folioY += 12;
        }
      }
      y = Math.max(MARGIN + 35, folioY) + 17;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.7).strokeColor(COLORS.border).stroke();
      y += continued ? 20 : 31;
      doc.font("Times-Bold").fontSize(continued ? 20 : 27).fillColor(COLORS.graphite)
        .text("Certificado de paz y salvo", MARGIN, y, { width, align: "center", lineBreak: false });
      y += continued ? 39 : 53;
    }

    function ensureSpace(height: number) {
      if (y + height <= bottom) return;
      doc.addPage();
      header(true);
    }

    function flowText(text: string, font: string, size: number, color: string, lineGap = 4) {
      doc.font(font).fontSize(size);
      const lines = wrapText(doc, text, width);
      const lineHeight = doc.currentLineHeight(true) + lineGap;
      for (const line of lines) {
        ensureSpace(lineHeight);
        doc.font(font).fontSize(size).fillColor(color)
          .text(line, MARGIN, y, { width, lineBreak: false });
        y += lineHeight;
      }
    }

    function field(label: string, value: string) {
      const labelWidth = 136;
      const valueWidth = width - labelWidth;
      doc.font(fonts.regular).fontSize(11);
      const lines = wrapText(doc, value, valueWidth);
      const lineHeight = doc.currentLineHeight(true) + 3;
      ensureSpace(Math.min(lines.length * lineHeight + 16, bottom - MARGIN - 150));
      let first = true;
      for (const line of lines) {
        ensureSpace(lineHeight + 7);
        if (first) {
          doc.font(fonts.regular).fontSize(9.5).fillColor(COLORS.muted)
            .text(label, MARGIN, y + 1, { width: labelWidth - 12, lineBreak: false });
          first = false;
        }
        doc.font(fonts.regular).fontSize(11).fillColor(COLORS.graphite)
          .text(line, MARGIN + labelWidth, y, { width: valueWidth, lineBreak: false });
        y += lineHeight;
      }
      y += 7;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.5).strokeColor(COLORS.border).stroke();
      y += 9;
    }

    header();
    renderStage = "SUMMARY";
    flowText(`Fecha de expedición: ${issuedAtLabel(input.issuedAt)}`, fonts.regular, 10, COLORS.muted);
    y += 19;
    const client = valueOrDash(input.clienteNombre);
    const document = valueOrDash(input.clienteDocumento);
    const equipment = valueOrDash(input.equipo);
    const equipmentText = equipment === "-" ? "" : `, correspondiente al equipo ${equipment},`;
    flowText(
      `FINSER PAY certifica que ${client}, identificado(a) con documento número ${document}, ha pagado en su totalidad el crédito ${creditNumber}${equipmentText} y, a la fecha de expedición de este certificado, no presenta saldo pendiente por esta obligación.`,
      "Times-Roman", 12.5, COLORS.graphite, 5
    );
    y += 24;

    renderStage = "DETAILS";
    const details: Array<[string, string]> = [
      ["Equipo financiado", equipment],
      ...(valueOrDash(input.imei) !== "-" ? [["IMEI", valueOrDash(input.imei)] as [string, string]] : []),
      ...(valueOrDash(input.deviceUid) !== "-" ? [["Device UID", valueOrDash(input.deviceUid)] as [string, string]] : []),
      ["Sede", valueOrDash(input.sedeNombre)],
      ["Estado actual", stateLabel(input.estado)],
      ...(valueOrDash(input.deliverableLabel) !== "-" ? [["Entregabilidad", valueOrDash(input.deliverableLabel)] as [string, string]] : []),
      ["Referencia de pago", valueOrDash(input.referenciaPago)],
      ["Emitido por", valueOrDash(input.issuer)],
    ];
    const columnGap = 24;
    const columnWidth = (width - columnGap) / 2;
    doc.font(fonts.regular).fontSize(9.5);
    const labelHeight = doc.currentLineHeight(true);
    doc.font(fonts.regular).fontSize(11);
    const detailLineHeight = doc.currentLineHeight(true) + 2;
    const detailCells = details.map(([label, value]) => ({
      label, value, lines: wrapText(doc, value, columnWidth),
    }));
    for (let index = 0; index < detailCells.length; index += 2) {
      const cells = detailCells.slice(index, index + 2);
      const rowHeight = labelHeight + 5 + Math.max(...cells.map(cell => cell.lines.length)) * detailLineHeight + 13;
      // Very large historical values retain the complete paginated representation.
      if (rowHeight > bottom - MARGIN - 180) {
        for (const cell of cells) field(cell.label, cell.value);
        continue;
      }
      ensureSpace(rowHeight);
      const rowTop = y;
      cells.forEach((cell, column) => {
        const x = MARGIN + column * (columnWidth + columnGap);
        doc.font(fonts.regular).fontSize(9.5).fillColor(COLORS.muted)
          .text(cell.label, x, rowTop, { lineBreak: false });
        doc.font(fonts.regular).fontSize(11).fillColor(COLORS.graphite);
        cell.lines.forEach((line, lineIndex) => {
          doc.text(line, x, rowTop + labelHeight + 5 + lineIndex * detailLineHeight, { lineBreak: false });
        });
      });
      y = rowTop + rowHeight;
      doc.moveTo(MARGIN, y - 5).lineTo(MARGIN + width, y - 5)
        .lineWidth(0.5).strokeColor(COLORS.border).stroke();
    }

    renderStage = "STATUS";
    ensureSpace(132);
    y += 18;
    drawFulfilledSeal(doc, fonts, MARGIN + 70, y + 48);
    const signatureX = MARGIN + width - 220;
    drawBrand(doc, fonts, signatureX + 28, y + 37, 20);
    doc.moveTo(signatureX, y + 70).lineTo(signatureX + 220, y + 70)
      .lineWidth(0.7).strokeColor(COLORS.graphite).stroke();
    doc.font(fonts.regular).fontSize(10).fillColor(COLORS.muted)
      .text("Emisor del certificado", signatureX, y + 80, { width: 220, align: "center", lineBreak: false });

    renderStage = "TRACE";
    const range = doc.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page++) {
      doc.switchToPage(page);
      doc.moveTo(MARGIN, footerTop - 12).lineTo(MARGIN + width, footerTop - 12)
        .lineWidth(0.5).strokeColor(COLORS.border).stroke();
      // Fixed footer lines must bypass PDFKit's automatic width-based pagination.
      doc.font(fonts.regular).fontSize(9).fillColor(COLORS.muted)
        .text("FINSER PAY S.A.S. | NIT 902052909-4 | Ibagué, Tolima", MARGIN, footerTop, { lineBreak: false })
        .text("Documento generado por FINSER PAY", MARGIN, footerTop + footerLineHeight + 3, { lineBreak: false });
      const pageLabel = `Página ${page + 1} de ${range.count}`;
      doc.text(pageLabel, MARGIN + width - doc.widthOfString(pageLabel), footerTop + footerLineHeight + 3,
        { lineBreak: false });
    }

    renderStage = "FINALIZE";
    doc.end();
    return await bufferPromise;
  } catch (error) {
    throw new Error(`PYS_PDF_${renderStage}`, { cause: error });
  }
}

export async function buildCreditPazYSalvoPdf(input: CreditPazYSalvoPdfInput) {
  try {
    return await renderCreditPazYSalvoPdf(input, true);
  } catch (error) {
    console.error("ERROR RENDERIZANDO PAZ Y SALVO CON RECURSOS DE MARCA:", error);
    return renderCreditPazYSalvoPdf(input, false);
  }
}