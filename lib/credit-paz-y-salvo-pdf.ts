import "server-only";

import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

export type CreditPazYSalvoPdfInput = {
  clienteDocumento?: string | null;
  clienteNombre: string;
  deliverableLabel?: string | null;
  deviceUid?: string | null;
  equipo?: string | null;
  estado?: string | null;
  folio: string;
  imei?: string | null;
  issuedAt: Date;
  issuer: string;
  referenciaPago?: string | null;
  sedeNombre: string;
};

const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const SYSTEM_FONT_REGULAR = path.join(windowsFontDir, "arial.ttf");
const SYSTEM_FONT_BOLD = path.join(windowsFontDir, "arialbd.ttf");
const BUNDLED_FONT_REGULAR = path.join(
  process.cwd(),
  "public",
  "pdf-fonts",
  "Geist-Regular.ttf"
);
const LOGO_PATH = path.join(
  process.cwd(),
  "public",
  "icons",
  "finserpay-client-512.png"
);

const COLORS = {
  navy: "#071827",
  graphite: "#151A21",
  muted: "#667085",
  border: "#D8DEE5",
  porcelain: "#F5F6F4",
  lime: "#B7E63D",
  limeDark: "#5C7A13",
  limeSoft: "#F2F9DF",
  white: "#FFFFFF",
};

function getPdfFonts(useBrandAssets: boolean) {
  if (!useBrandAssets) {
    return {
      regular: "Helvetica",
      bold: "Helvetica-Bold",
    };
  }

  if (existsSync(SYSTEM_FONT_REGULAR) && existsSync(SYSTEM_FONT_BOLD)) {
    return {
      regular: SYSTEM_FONT_REGULAR,
      bold: SYSTEM_FONT_BOLD,
    };
  }

  if (existsSync(BUNDLED_FONT_REGULAR)) {
    return {
      regular: BUNDLED_FONT_REGULAR,
      bold: "Helvetica-Bold",
    };
  }

  return {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
  };
}

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
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

function identifierLabel(input: CreditPazYSalvoPdfInput) {
  const identifiers = [input.imei, input.deviceUid]
    .map((value) => valueOrDash(value))
    .filter((value) => value !== "-");

  return [...new Set(identifiers)].join(" / ") || "-";
}

function issuedAtLabel(value: Date) {
  const issuedAt = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(issuedAt.getTime())) {
    return "-";
  }

  try {
    return new Intl.DateTimeFormat("es-CO", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Bogota",
    }).format(issuedAt);
  } catch {
    return issuedAt.toISOString().replace("T", " ").slice(0, 16);
  }
}

function drawFallbackBrandMark(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string }
) {
  doc
    .save()
    .roundedRect(48, 48, 46, 46, 8)
    .lineWidth(1.2)
    .strokeColor("#526272")
    .stroke()
    .restore();
  doc
    .fillColor(COLORS.white)
    .font(fonts.bold)
    .fontSize(15)
    .text("FP", 48, 64, { width: 46, align: "center" });
}

function drawCheck(
  doc: PDFKit.PDFDocument,
  centerX: number,
  centerY: number,
  radius: number
) {
  doc.save().circle(centerX, centerY, radius).fill(COLORS.lime).restore();
  doc
    .save()
    .lineWidth(2.4)
    .lineCap("round")
    .strokeColor(COLORS.navy)
    .moveTo(centerX - 7, centerY)
    .lineTo(centerX - 2, centerY + 5)
    .lineTo(centerX + 8, centerY - 6)
    .stroke()
    .restore();
}

function drawField(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  x: number,
  y: number,
  width: number,
  label: string,
  value: string
) {
  doc
    .fillColor(COLORS.muted)
    .font(fonts.regular)
    .fontSize(7.2)
    .text(label, x, y, { width });
  doc
    .fillColor(COLORS.graphite)
    .font(fonts.bold)
    .fontSize(10)
    .text(value, x, y + 15, {
      width,
      height: 27,
      ellipsis: true,
      lineBreak: true,
    });
}

async function renderCreditPazYSalvoPdf(
  input: CreditPazYSalvoPdfInput,
  useBrandAssets: boolean
) {
  const fonts = getPdfFonts(useBrandAssets);
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
    compress: true,
    font: fonts.regular,
    info: {
      Title: `Paz y salvo ${input.folio}`,
      Author: "FINSER PAY",
    },
  });
  const bufferPromise = toBuffer(doc);

  doc.rect(0, 0, 595.28, 841.89).fill(COLORS.porcelain);

  doc.save().roundedRect(32, 30, 531, 150, 10).fill(COLORS.navy).restore();
  if (useBrandAssets && existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, 48, 48, {
        fit: [46, 46],
        align: "center",
        valign: "center",
      });
    } catch (error) {
      console.error("ERROR CARGANDO LOGO EN PAZ Y SALVO:", error);
      drawFallbackBrandMark(doc, fonts);
    }
  } else {
    drawFallbackBrandMark(doc, fonts);
  }

  doc.fillColor(COLORS.white).font(fonts.bold).fontSize(15).text("FINSER", 108, 50);
  const brandWidth = doc.widthOfString("FINSER");
  doc.fillColor(COLORS.lime).text("PAY", 113 + brandWidth, 50);
  doc
    .fillColor("#CBD5DF")
    .font(fonts.regular)
    .fontSize(7.5)
    .text("CERTIFICADO DIGITAL", 108, 73);

  doc.save().roundedRect(431, 48, 107, 25, 12).fill(COLORS.limeSoft).restore();
  doc
    .fillColor(COLORS.limeDark)
    .font(fonts.bold)
    .fontSize(7.2)
    .text("CR\u00c9DITO PAGADO", 431, 57, { width: 107, align: "center" });

  doc.fillColor(COLORS.white).font(fonts.bold).fontSize(29).text("Paz y salvo", 48, 105);
  doc
    .fillColor("#CBD5DF")
    .font(fonts.regular)
    .fontSize(8.5)
    .text("Certificaci\u00f3n de obligaci\u00f3n cumplida", 48, 143);
  doc
    .fillColor(COLORS.white)
    .font(fonts.bold)
    .fontSize(8.5)
    .text(valueOrDash(input.folio), 324, 143, {
      width: 214,
      align: "right",
      ellipsis: true,
      lineBreak: false,
    });

  doc
    .save()
    .roundedRect(32, 198, 531, 132, 10)
    .fillAndStroke(COLORS.white, COLORS.border)
    .restore();
  drawCheck(doc, 62, 231, 17);
  doc
    .fillColor(COLORS.limeDark)
    .font(fonts.bold)
    .fontSize(7.5)
    .text("OBLIGACI\u00d3N CUMPLIDA", 92, 214);
  doc
    .fillColor(COLORS.graphite)
    .font(fonts.bold)
    .fontSize(15)
    .text(valueOrDash(input.clienteNombre), 92, 232, {
      width: 430,
      ellipsis: true,
      lineBreak: false,
    });
  doc
    .fillColor(COLORS.muted)
    .font(fonts.regular)
    .fontSize(10.2)
    .text(
      "FINSER PAY certifica que el cr\u00e9dito identificado en este documento fue pagado en su totalidad y, a la fecha de expedici\u00f3n, no presenta saldo pendiente.",
      92,
      260,
      { width: 430, lineGap: 3 }
    );

  doc
    .fillColor(COLORS.limeDark)
    .font(fonts.bold)
    .fontSize(7.5)
    .text("DETALLE DE LA OBLIGACI\u00d3N", 32, 354);
  doc.moveTo(181, 359).lineTo(563, 359).strokeColor(COLORS.border).stroke();

  doc
    .save()
    .roundedRect(32, 374, 531, 194, 10)
    .fillAndStroke(COLORS.white, COLORS.border)
    .restore();
  doc.moveTo(297.5, 374).lineTo(297.5, 568).strokeColor(COLORS.border).stroke();
  doc.moveTo(32, 438).lineTo(563, 438).strokeColor(COLORS.border).stroke();
  doc.moveTo(32, 502).lineTo(563, 502).strokeColor(COLORS.border).stroke();

  drawField(doc, fonts, 48, 389, 228, "CLIENTE", valueOrDash(input.clienteNombre));
  drawField(
    doc,
    fonts,
    314,
    389,
    228,
    "DOCUMENTO",
    valueOrDash(input.clienteDocumento)
  );
  drawField(doc, fonts, 48, 453, 228, "FOLIO", valueOrDash(input.folio));
  drawField(
    doc,
    fonts,
    314,
    453,
    228,
    "EQUIPO",
    valueOrDash(input.equipo || input.imei)
  );
  drawField(
    doc,
    fonts,
    48,
    517,
    228,
    "REFERENCIA DE PAGO",
    valueOrDash(input.referenciaPago)
  );
  drawField(doc, fonts, 314, 517, 228, "IMEI / DEVICE UID", identifierLabel(input));

  doc
    .save()
    .roundedRect(32, 592, 531, 72, 10)
    .fillAndStroke(COLORS.limeSoft, "#C9DF91")
    .restore();
  drawCheck(doc, 61, 628, 15);
  drawField(doc, fonts, 92, 608, 170, "ESTADO ACTUAL", stateLabel(input.estado));
  doc.moveTo(279, 606).lineTo(279, 650).strokeColor("#C9DF91").stroke();
  drawField(
    doc,
    fonts,
    301,
    608,
    236,
    "ENTREGABILIDAD TECNOL\u00d3GICA",
    valueOrDash(input.deliverableLabel || "Sin verificacion")
  );

  doc
    .fillColor(COLORS.limeDark)
    .font(fonts.bold)
    .fontSize(7.5)
    .text("EMISI\u00d3N Y TRAZABILIDAD", 32, 693);
  doc.moveTo(170, 698).lineTo(563, 698).strokeColor(COLORS.border).stroke();

  drawField(doc, fonts, 32, 718, 143, "SEDE", valueOrDash(input.sedeNombre));
  drawField(doc, fonts, 195, 718, 150, "EMITIDO POR", valueOrDash(input.issuer));
  drawField(doc, fonts, 365, 718, 198, "FECHA DE EMISI\u00d3N", issuedAtLabel(input.issuedAt));

  doc.moveTo(32, 775).lineTo(563, 775).strokeColor(COLORS.border).stroke();
  doc
    .fillColor(COLORS.muted)
    .font(fonts.regular)
    .fontSize(7.3)
    .text("FINSER PAY S.A.S. | NIT 902052909-4 | Ibagu\u00e9, Tolima", 32, 787, {
      width: 330,
    });
  doc
    .fillColor(COLORS.muted)
    .font(fonts.bold)
    .fontSize(7.3)
    .text("Documento generado por FINSER PAY", 365, 787, {
      width: 198,
      align: "right",
    });

  doc.end();

  return bufferPromise;
}

export async function buildCreditPazYSalvoPdf(
  input: CreditPazYSalvoPdfInput
) {
  try {
    return await renderCreditPazYSalvoPdf(input, true);
  } catch (error) {
    console.error(
      "ERROR RENDERIZANDO PAZ Y SALVO CON RECURSOS DE MARCA:",
      error
    );
    return renderCreditPazYSalvoPdf(input, false);
  }
}
