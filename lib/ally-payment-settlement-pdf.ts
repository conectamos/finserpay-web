import PDFDocument from "pdfkit";

export type AllyPaymentSettlementPdfLine = {
  creditId: number;
  creditDate: string;
  allyName: string;
  clientName: string;
  clientDocument: string;
  equipment: string;
  imei: string;
  platform: "ANDROID" | "IPHONE";
  saleValue: number;
  initialPayment: number;
  authorizedCredit: number;
  intermediationPercentage: number;
  intermediationValue: number;
  payableValue: number;
  status: string;
};

export type AllyPaymentSettlementPdfBucket = {
  creditCount: number;
  intermediationPercentage: number | null;
  payableValue: number;
};

export type AllyPaymentSettlementPdfInput = {
  settlementId: number;
  allyName: string;
  periodStart: string;
  periodEnd: string;
  bankApprovalNumber: string;
  status: string;
  paidAt: Date;
  registeredBy: string;
  creditCount: number;
  totalSaleValue: number;
  totalInitialPayment: number;
  totalAuthorizedCredit: number;
  totalIntermediation: number;
  totalPayable: number;
  platformSummary: {
    ANDROID: AllyPaymentSettlementPdfBucket;
    IPHONE: AllyPaymentSettlementPdfBucket;
  };
  lines: AllyPaymentSettlementPdfLine[];
};

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const PAGE_MARGIN = 34;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const FOOTER_Y = PAGE_HEIGHT - 24;
const TABLE_HEADER_HEIGHT = 32;
const ROW_HEIGHT = 32;

const COLORS = {
  graphite: "#101214",
  graphiteSoft: "#282B2E",
  lime: "#9AED28",
  limeDark: "#4D7F10",
  limePale: "#F1FADB",
  porcelain: "#FAF9F6",
  white: "#FFFFFF",
  ink: "#17191B",
  muted: "#687078",
  line: "#DDE1D8",
  soft: "#F5F6F3",
} as const;

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("es-CO", {
  maximumFractionDigits: 2,
});

const TABLE_COLUMNS = [
  { key: "date", label: "Fecha", width: 46, align: "left" },
  { key: "ally", label: "Aliado", width: 58, align: "left" },
  { key: "client", label: "Cliente", width: 68, align: "left" },
  { key: "document", label: "Cedula", width: 54, align: "left" },
  { key: "equipment", label: "Equipo / IMEI", width: 100, align: "left" },
  { key: "platform", label: "Plataforma", width: 44, align: "left" },
  { key: "sale", label: "Valor venta", width: 58, align: "right" },
  { key: "initial", label: "Inicial", width: 55, align: "right" },
  { key: "credit", label: "Credito autorizado", width: 66, align: "right" },
  { key: "percentage", label: "Intermediacion", width: 46, align: "right" },
  { key: "intermediation", label: "Valor intermediacion", width: 66, align: "right" },
  { key: "payable", label: "Valor a pagar", width: 70, align: "right" },
  { key: "status", label: "Estado", width: 43, align: "left" },
] as const;

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function safeText(value: unknown, fallback = "-", maxLength = 80) {
  const normalized = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return fallback;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function money(value: unknown) {
  const numeric = Number(value);
  return moneyFormatter.format(Number.isFinite(numeric) ? Math.max(0, numeric) : 0);
}

function percentage(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "Mixto";
  }
  return `${numberFormatter.format(Number(value))}%`;
}

function dateLabel(value: string) {
  const normalized = String(value || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00-05:00`)
    : new Date(normalized);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function dateTimeLabel(value: Date) {
  return value.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function drawHeader(
  doc: PDFKit.PDFDocument,
  input: AllyPaymentSettlementPdfInput,
  continuation = false
) {
  doc.rect(0, 0, PAGE_WIDTH, continuation ? 78 : 92).fill(COLORS.graphite);
  doc
    .rect(0, continuation ? 74 : 88, PAGE_WIDTH, 4)
    .fill(COLORS.lime);

  doc
    .font("Helvetica-Bold")
    .fontSize(21)
    .fillColor(COLORS.white)
    .text("FINSER", PAGE_MARGIN, 25, { continued: true })
    .fillColor(COLORS.lime)
    .text(" PAY");
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#C7CBC7")
    .text("Tu credito, siempre contigo.", PAGE_MARGIN, 52);

  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#B6BBB6")
    .text(
      continuation ? "DETALLE DE CREDITOS - CONTINUACION" : "COMPROBANTE DE LIQUIDACION A ALIADO",
      PAGE_WIDTH - PAGE_MARGIN - 290,
      23,
      { width: 290, align: "right" }
    );
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor(COLORS.white)
    .text(`LA-${input.settlementId}`, PAGE_WIDTH - PAGE_MARGIN - 290, 40, {
      width: 290,
      align: "right",
    });
}

function drawInfoCell(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  accent = false
) {
  doc
    .font("Helvetica-Bold")
    .fontSize(6.8)
    .fillColor(COLORS.muted)
    .text(label.toUpperCase(), x, y, { width });
  doc
    .font("Helvetica-Bold")
    .fontSize(accent ? 9.5 : 8.7)
    .fillColor(accent ? COLORS.limeDark : COLORS.ink)
    .text(value, x, y + 14, { width, height: 26, ellipsis: true });
}

function drawFirstPageOverview(
  doc: PDFKit.PDFDocument,
  input: AllyPaymentSettlementPdfInput
) {
  const infoY = 108;
  doc
    .roundedRect(PAGE_MARGIN, infoY, CONTENT_WIDTH, 68, 10)
    .fillAndStroke(COLORS.white, COLORS.line);
  const infoWidth = CONTENT_WIDTH / 5;
  drawInfoCell(doc, PAGE_MARGIN + 14, infoY + 12, infoWidth - 22, "Aliado", safeText(input.allyName, "Aliado", 48));
  drawInfoCell(doc, PAGE_MARGIN + infoWidth + 8, infoY + 12, infoWidth - 16, "Periodo", `${dateLabel(input.periodStart)} al ${dateLabel(input.periodEnd)}`);
  drawInfoCell(doc, PAGE_MARGIN + infoWidth * 2 + 8, infoY + 12, infoWidth - 16, "Fecha de pago", dateTimeLabel(input.paidAt), true);
  drawInfoCell(doc, PAGE_MARGIN + infoWidth * 3 + 8, infoY + 12, infoWidth - 16, "Aprobacion bancaria", safeText(input.bankApprovalNumber, "-", 36));
  drawInfoCell(doc, PAGE_MARGIN + infoWidth * 4 + 8, infoY + 12, infoWidth - 22, "Estado", safeText(input.status, "PAGADA", 20));

  doc
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(COLORS.ink)
    .text("Resumen de la liquidacion", PAGE_MARGIN, 192);

  const summaryY = 209;
  doc
    .roundedRect(PAGE_MARGIN, summaryY, CONTENT_WIDTH, 62, 10)
    .fillAndStroke(COLORS.limePale, "#D3E8AB");
  const metrics = [
    ["Valor venta", money(input.totalSaleValue)],
    ["Inicial", money(input.totalInitialPayment)],
    ["Credito autorizado", money(input.totalAuthorizedCredit)],
    ["Intermediacion", money(input.totalIntermediation)],
    ["Total pagado", money(input.totalPayable)],
  ] as const;
  const metricWidth = CONTENT_WIDTH / metrics.length;
  metrics.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + metricWidth * index;
    if (index > 0) {
      doc
        .moveTo(x, summaryY + 11)
        .lineTo(x, summaryY + 51)
        .lineWidth(0.5)
        .strokeColor("#D3E8AB")
        .stroke();
    }
    doc
      .font("Helvetica-Bold")
      .fontSize(index === metrics.length - 1 ? 12.5 : 10.5)
      .fillColor(index === metrics.length - 1 ? COLORS.limeDark : COLORS.graphite)
      .text(value, x + 5, summaryY + 16, { width: metricWidth - 10, align: "center" });
    doc
      .font("Helvetica")
      .fontSize(6.8)
      .fillColor(COLORS.muted)
      .text(label, x + 5, summaryY + 39, { width: metricWidth - 10, align: "center" });
  });

  const platformsY = 283;
  const platformWidth = (CONTENT_WIDTH - 10) / 2;
  (["ANDROID", "IPHONE"] as const).forEach((platform, index) => {
    const bucket = input.platformSummary[platform];
    const x = PAGE_MARGIN + index * (platformWidth + 10);
    doc
      .roundedRect(x, platformsY, platformWidth, 42, 8)
      .fillAndStroke(COLORS.white, COLORS.line);
    doc
      .font("Helvetica-Bold")
      .fontSize(8.5)
      .fillColor(COLORS.ink)
      .text(platform === "IPHONE" ? "iPhone" : "Android", x + 12, platformsY + 10);
    doc
      .font("Helvetica")
      .fontSize(7.2)
      .fillColor(COLORS.muted)
      .text(
        `${bucket.creditCount} creditos  |  ${percentage(bucket.intermediationPercentage)} intermediacion`,
        x + 76,
        platformsY + 10,
        { width: platformWidth - 176 }
      );
    doc
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLORS.graphite)
      .text(money(bucket.payableValue), x + platformWidth - 105, platformsY + 9, {
        width: 93,
        align: "right",
      });
  });

  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor(COLORS.muted)
    .text(
      `Registrado por ${safeText(input.registeredBy, "Administrador FINSER PAY", 70)}. Credito autorizado = venta - inicial; valor a pagar = credito autorizado - intermediacion.`,
      PAGE_MARGIN,
      336,
      { width: CONTENT_WIDTH }
    );

  return 354;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number) {
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT).fill(COLORS.graphiteSoft);
  let x = PAGE_MARGIN;
  TABLE_COLUMNS.forEach((column) => {
    doc
      .font("Helvetica-Bold")
      .fontSize(5.8)
      .fillColor(COLORS.white)
      .text(column.label, x + 3, y + 6, {
        width: column.width - 8,
        height: 21,
        align: column.align,
      });
    x += column.width;
  });
  return y + TABLE_HEADER_HEIGHT;
}

function lineValues(line: AllyPaymentSettlementPdfLine) {
  return {
    date: dateLabel(line.creditDate),
    ally: safeText(line.allyName, "Aliado", 28),
    client: safeText(line.clientName, "Cliente", 34),
    document: safeText(line.clientDocument, "Sin documento", 24),
    equipment: `${safeText(line.equipment, "Equipo", 36)}\nIMEI ${safeText(
      line.imei,
      "Sin IMEI",
      24
    )}`,
    platform: line.platform === "IPHONE" ? "iPhone" : "Android",
    sale: money(line.saleValue),
    initial: money(line.initialPayment),
    credit: money(line.authorizedCredit),
    percentage: percentage(line.intermediationPercentage),
    intermediation: money(line.intermediationValue),
    payable: money(line.payableValue),
    status: safeText(line.status, "PAGADO", 16),
  };
}

function drawTableRow(
  doc: PDFKit.PDFDocument,
  line: AllyPaymentSettlementPdfLine,
  y: number,
  index: number
) {
  doc
    .rect(PAGE_MARGIN, y, CONTENT_WIDTH, ROW_HEIGHT)
    .fill(index % 2 === 0 ? COLORS.white : COLORS.soft);
  const values = lineValues(line);
  let x = PAGE_MARGIN;
  TABLE_COLUMNS.forEach((column) => {
    const emphasized = column.key === "payable";
    doc
      .font(emphasized ? "Helvetica-Bold" : "Helvetica")
      .fontSize(emphasized ? 6.2 : 5.8)
      .fillColor(COLORS.ink)
      .text(values[column.key], x + 3, y + 5, {
        width: column.width - 8,
        height: 23,
        align: column.align,
        ellipsis: true,
      });
    x += column.width;
  });
  doc
    .moveTo(PAGE_MARGIN, y + ROW_HEIGHT)
    .lineTo(PAGE_WIDTH - PAGE_MARGIN, y + ROW_HEIGHT)
    .lineWidth(0.4)
    .strokeColor(COLORS.line)
    .stroke();
  return y + ROW_HEIGHT;
}

function drawFooter(doc: PDFKit.PDFDocument, page: number, totalPages: number) {
  doc
    .font("Helvetica")
    .fontSize(6.8)
    .fillColor(COLORS.muted)
    .text(
      "Documento generado desde el registro historico de FINSER PAY. Valores expresados en pesos colombianos.",
      PAGE_MARGIN,
      FOOTER_Y,
      { width: CONTENT_WIDTH - 120 }
    );
  doc
    .font("Helvetica-Bold")
    .fillColor(COLORS.graphite)
    .text(`Pagina ${page} de ${totalPages}`, PAGE_WIDTH - PAGE_MARGIN - 100, FOOTER_Y, {
      width: 100,
      align: "right",
    });
}

export async function buildAllyPaymentSettlementPdf(
  input: AllyPaymentSettlementPdfInput
) {
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: 0,
    compress: true,
    bufferPages: true,
    autoFirstPage: false,
    info: {
      Title: `Liquidacion a aliado LA-${input.settlementId}`,
      Author: "FINSER PAY",
      Subject: "Comprobante de liquidacion pagada a aliado",
      Keywords: "FINSER PAY, aliado, liquidacion, pago",
    },
  });
  const bufferPromise = toBuffer(doc);

  doc.addPage();
  drawHeader(doc, input);
  let y = drawFirstPageOverview(doc, input);
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor(COLORS.ink)
    .text(`Detalle por credito (${input.creditCount})`, PAGE_MARGIN, y);
  y = drawTableHeader(doc, y + 15);

  if (!input.lines.length) {
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text("No hay creditos en esta liquidacion.", PAGE_MARGIN + 10, y + 14);
  }

  input.lines.forEach((line, index) => {
    if (y + ROW_HEIGHT > FOOTER_Y - 8) {
      doc.addPage();
      drawHeader(doc, input, true);
      doc
        .font("Helvetica-Bold")
        .fontSize(9.5)
        .fillColor(COLORS.ink)
        .text("Detalle por credito", PAGE_MARGIN, 94);
      y = drawTableHeader(doc, 109);
    }
    y = drawTableRow(doc, line, y, index);
  });

  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    drawFooter(doc, index - pages.start + 1, pages.count);
  }

  doc.end();
  return bufferPromise;
}
