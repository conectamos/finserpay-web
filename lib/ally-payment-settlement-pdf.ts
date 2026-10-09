import PDFDocument from "pdfkit";
import { creditDisplayNumber } from "@/lib/credit-display-number";

export type AllyPaymentSettlementPdfLine = {
  creditId: number; creditDate: string; allyName: string; siteName: string;
  clientName: string; clientDocument: string; equipment: string; imei: string;
  platform: "ANDROID" | "IPHONE"; saleValue: number; initialPayment: number;
  authorizedCredit: number; intermediationPercentage: number;
  intermediationValue: number; payableValue: number; status: string;
};

export type AllyPaymentSettlementPdfBucket = {
  creditCount: number; intermediationPercentage: number | null; payableValue: number;
};

export type AllyPaymentSettlementPdfCollection = {
  paymentDate: string; folio: string; numeroCreditoVisible?: string;
  clientName: string; clientDocument: string; siteName: string;
  paymentMethod: string; value: number; status: string;
};

export type AllyPaymentSettlementPdfAnnulmentAdjustment = {
  adjustmentId: number; creditId: number; annulledAt: string; folio: string;
  visibleCreditNumber?: string; clientName: string; clientDocument: string;
  equipment: string; imei: string; platform: "ANDROID" | "IPHONE";
  siteName: string; sourceSettlementId: number; discountValue: number;
  reason: string; status: string;
};

export type AllyPaymentSettlementPdfInput = {
  settlementId: number; allyName: string; periodStart: string; periodEnd: string;
  bankApprovalNumber: string; status: string; paidAt: Date; registeredBy: string;
  creditCount: number; totalSaleValue: number; totalInitialPayment: number;
  totalAuthorizedCredit: number; totalIntermediation: number; totalPayable: number;
  totalAllyCollections: number; totalAnnulmentAdjustments: number;
  netBalance: number; balanceDirection: string;
  platformSummary: { ANDROID: AllyPaymentSettlementPdfBucket; IPHONE: AllyPaymentSettlementPdfBucket };
  lines: AllyPaymentSettlementPdfLine[];
  collections: AllyPaymentSettlementPdfCollection[];
  annulmentAdjustments: AllyPaymentSettlementPdfAnnulmentAdjustment[];
};

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const PAGE_MARGIN = 34;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const FOOTER_Y = PAGE_HEIGHT - 24;
const TABLE_HEADER_HEIGHT = 34;
const MIN_ROW_HEIGHT = 42;

const COLORS = {
  graphite: "#101827", lime: "#70D814", limeDark: "#2F7D0A",
  limePale: "#F3FBEA", porcelain: "#FCFCFA", white: "#FFFFFF",
  ink: "#141A28", muted: "#667085", line: "#D9DEE7",
  soft: "#F7F8FA", headerSoft: "#EEF0F3",
  danger: "#B42318", dangerDark: "#7A271A", dangerPale: "#FFF1F0",
  dangerLine: "#F3B7B2",
} as const;

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", minimumFractionDigits: 0, maximumFractionDigits: 20,
});
const numberFormatter = new Intl.NumberFormat("es-CO", { maximumFractionDigits: 4 });

const TABLE_COLUMNS = [
  { key: "date", label: "Fecha", width: 55, align: "left" },
  { key: "client", label: "Cliente / cédula", width: 110, align: "left" },
  { key: "equipment", label: "Equipo", width: 135, align: "left" },
  { key: "site", label: "Sede", width: 75, align: "left" },
  { key: "sale", label: "Venta", width: 65, align: "right" },
  { key: "initial", label: "Inicial", width: 62, align: "right" },
  { key: "credit", label: "Crédito", width: 67, align: "right" },
  { key: "commission", label: "Comisión", width: 78, align: "right" },
  { key: "net", label: "Neto", width: 67, align: "right" },
  { key: "status", label: "Estado", width: 60, align: "center" },
] as const;

const COLLECTION_COLUMNS = [
  { key: "date", label: "Fecha", width: 82, align: "left" },
  { key: "folio", label: "Crédito", width: 80, align: "left" },
  { key: "client", label: "Cliente / cédula", width: 145, align: "left" },
  { key: "site", label: "Sede que recaudó", width: 142, align: "left" },
  { key: "method", label: "Método", width: 95, align: "left" },
  { key: "value", label: "Valor", width: 115, align: "right" },
  { key: "status", label: "Estado", width: 115, align: "center" },
] as const;

const ANNULMENT_COLUMNS = [
  { key: "date", label: "Fecha anulación", width: 70, align: "left" },
  { key: "credit", label: "Crédito", width: 70, align: "left" },
  { key: "client", label: "Cliente / cédula", width: 120, align: "left" },
  { key: "equipment", label: "Equipo / plataforma", width: 135, align: "left" },
  { key: "site", label: "Sede", width: 75, align: "left" },
  { key: "source", label: "Liq. original", width: 65, align: "left" },
  { key: "reason", label: "Motivo", width: 100, align: "left" },
  { key: "value", label: "Descuento", width: 75, align: "right" },
  { key: "status", label: "Estado", width: 64, align: "center" },
] as const;

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}
function safeText(value: unknown, fallback = "-", maxLength = 120) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function money(value: unknown) {
  const numeric = Number(value);
  return moneyFormatter.format(Number.isFinite(numeric) ? Math.max(0, numeric) : 0);
}

function percentage(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "Mixto";
  return `${numberFormatter.format(Number(value))} %`;
}

function dateLabel(value: string) {
  const normalized = String(value || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00-05:00`) : new Date(normalized);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

function dateTimeLabel(value: Date) {
  return value.toLocaleString("es-CO", {
    timeZone: "America/Bogota", day: "2-digit", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function assertFinancialConsistency(input: AllyPaymentSettlementPdfInput) {
  const lineTotal = (key: "saleValue" | "initialPayment" | "authorizedCredit" | "intermediationValue" | "payableValue") =>
    input.lines.reduce((sum, line) => sum + line[key], 0);
  const collectionTotal = input.collections.reduce((sum, item) => sum + item.value, 0);
  const annulmentTotal = input.annulmentAdjustments.reduce(
    (sum, item) => sum + item.discountValue,
    0
  );
  const checks = [
    ["crédito autorizado", input.totalAuthorizedCredit, input.totalSaleValue - input.totalInitialPayment],
    ["valor por créditos", input.totalPayable, input.totalAuthorizedCredit - input.totalIntermediation],
    ["saldo neto", input.netBalance, input.totalPayable - input.totalAllyCollections - input.totalAnnulmentAdjustments],
    ["ventas del detalle", input.totalSaleValue, lineTotal("saleValue")],
    ["iniciales del detalle", input.totalInitialPayment, lineTotal("initialPayment")],
    ["créditos del detalle", input.totalAuthorizedCredit, lineTotal("authorizedCredit")],
    ["intermediación del detalle", input.totalIntermediation, lineTotal("intermediationValue")],
    ["netos del detalle", input.totalPayable, lineTotal("payableValue")],
    ["recaudos del detalle", input.totalAllyCollections, collectionTotal],
    ["anulaciones del detalle", input.totalAnnulmentAdjustments, annulmentTotal],
  ] as const;
  if (input.creditCount !== input.lines.length) {
    throw new Error("El número de créditos de la liquidación no coincide con su detalle.");
  }
  for (const [label, actual, expected] of checks) {
    if (Math.abs(actual - expected) > 1) throw new Error(`La liquidación no cuadra en ${label}.`);
  }
}

function commonIntermediationLabel(input: AllyPaymentSettlementPdfInput) {
  const percentages = new Set(input.lines.map((line) => numberFormatter.format(line.intermediationPercentage)));
  if (!percentages.size) return null;
  return percentages.size === 1 ? `${[...percentages][0]} %` : "mixta";
}

function balanceCopy(input: AllyPaymentSettlementPdfInput) {
  if (input.netBalance < 0 || input.balanceDirection === "CONSIGNACION_ALIADO") {
    return {
      headline: "Total a consignar por el aliado", resultLabel: "Neto (consigna el aliado)",
      description: "Diferencia a consignar a FINSER PAY después de aplicar recaudos y descuentos por créditos anulados.",
    };
  }
  if (input.netBalance > 0 || input.balanceDirection === "PAGO_ALIADO") {
    return {
      headline: "Total pagado al aliado", resultLabel: "Neto (pagado al aliado)",
      description: "Valor neto de las ventas del período, después de intermediación, recaudos y créditos anulados.",
    };
  }
  return {
    headline: "Liquidación conciliada", resultLabel: "Neto conciliado",
    description: "Ventas, recaudos y créditos anulados quedan compensados sin saldo pendiente entre las partes.",
  };
}

function drawBrand(doc: PDFKit.PDFDocument, y: number) {
  doc.font("Helvetica-Bold").fontSize(20).fillColor(COLORS.graphite)
    .text("FINSER", PAGE_MARGIN, y, { continued: true }).fillColor(COLORS.lime).text(" PAY");
  doc.font("Helvetica").fontSize(7.4).fillColor(COLORS.muted)
    .text("INNOVACIÓN FINANCIERA CON CONFIANZA", PAGE_MARGIN, y + 25);
}

function drawStatusPill(doc: PDFKit.PDFDocument, text: string, x: number, y: number, width = 78) {
  doc.roundedRect(x, y, width, 25, 12).fill(COLORS.limePale);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.limeDark)
    .text(safeText(text, "PAGADA", 18).toUpperCase(), x, y + 8, { width, align: "center" });
}

function drawHeader(doc: PDFKit.PDFDocument, input: AllyPaymentSettlementPdfInput, continuation = false) {
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(COLORS.porcelain);
  drawBrand(doc, continuation ? 22 : 27);
  doc.font("Helvetica-Bold").fontSize(continuation ? 14 : 18).fillColor(COLORS.graphite)
    .text("Liquidación a aliado", 500, continuation ? 22 : 26, { width: 220 });
  doc.font("Helvetica").fontSize(9).fillColor(COLORS.muted)
    .text(continuation ? `Continuación · Folio LA-${input.settlementId}` : `Folio: LA-${input.settlementId}`,
      500, continuation ? 45 : 51, { width: 220 });
  drawStatusPill(doc, input.status, PAGE_WIDTH - PAGE_MARGIN - 78, continuation ? 24 : 30);
  const ruleY = continuation ? 72 : 83;
  doc.moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_WIDTH - PAGE_MARGIN, ruleY)
    .lineWidth(1.6).strokeColor(COLORS.lime).stroke();
}

function drawInfoCell(doc: PDFKit.PDFDocument, x: number, y: number, width: number, label: string, value: string) {
  doc.font("Helvetica").fontSize(7.2).fillColor(COLORS.muted).text(label.toUpperCase(), x, y, { width });
  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(COLORS.ink)
    .text(value, x, y + 16, { width, height: 27, ellipsis: true });
}

function drawFirstPageOverview(doc: PDFKit.PDFDocument, input: AllyPaymentSettlementPdfInput) {
  const infoY = 101;
  const infoWidth = CONTENT_WIDTH / 4;
  const metadata = [
    ["Aliado", safeText(input.allyName, "Aliado", 54)],
    ["Período", `${dateLabel(input.periodStart)} al ${dateLabel(input.periodEnd)}`],
    ["Pagado", dateTimeLabel(input.paidAt)],
    ["Aprobación bancaria", safeText(input.bankApprovalNumber, "-", 40)],
  ] as const;
  metadata.forEach(([label, value], index) => {
    const x = PAGE_MARGIN + infoWidth * index;
    if (index > 0) doc.moveTo(x, infoY - 2).lineTo(x, infoY + 43)
      .lineWidth(0.6).strokeColor(COLORS.line).stroke();
    drawInfoCell(doc, x + (index ? 18 : 9), infoY + 3, infoWidth - 27, label, value);
  });
  doc.font("Helvetica").fontSize(6.8).fillColor(COLORS.muted)
    .text(`Registrado por ${safeText(input.registeredBy, "Administrador FINSER PAY", 80)}`,
      PAGE_MARGIN + 9, 151, { width: CONTENT_WIDTH - 18, align: "right" });

  const cardY = 165;
  const gap = 12;
  const totalWidth = 402;
  const detailWidth = CONTENT_WIDTH - totalWidth - gap;
  const cardHeight = 176;
  const copy = balanceCopy(input);
  doc.roundedRect(PAGE_MARGIN, cardY, totalWidth, cardHeight, 7).fillAndStroke(COLORS.limePale, "#D8EDC2");
  doc.font("Helvetica-Bold").fontSize(14).fillColor(COLORS.graphite)
    .text(copy.headline, PAGE_MARGIN + 25, cardY + 25, { width: totalWidth - 50 });
  doc.font("Helvetica-Bold").fontSize(34).fillColor(COLORS.limeDark)
    .text(money(Math.abs(input.netBalance)), PAGE_MARGIN + 25, cardY + 55,
      { width: totalWidth - 50, height: 43 });
  doc.font("Helvetica").fontSize(9.4).fillColor(COLORS.muted)
    .text(copy.description, PAGE_MARGIN + 25, cardY + 111, { width: totalWidth - 50, height: 46 });

  const detailX = PAGE_MARGIN + totalWidth + gap;
  doc.roundedRect(detailX, cardY, detailWidth, cardHeight, 7).fillAndStroke(COLORS.white, COLORS.line);
  const intermediationLabel = commonIntermediationLabel(input);
  const rows: Array<{ label: string; value: string; divider?: boolean; danger?: boolean }> = [
    { label: "Valor venta", value: money(input.totalSaleValue) },
    { label: "Inicial", value: `-  ${money(input.totalInitialPayment)}` },
    { label: "Crédito autorizado", value: money(input.totalAuthorizedCredit), divider: true },
    { label: intermediationLabel ? `Intermediación (${intermediationLabel})` : "Intermediación", value: `-  ${money(input.totalIntermediation)}` },
    { label: "Recaudos aliado", value: `-  ${money(input.totalAllyCollections)}` },
    { label: "Créditos anulados", value: `-  ${money(input.totalAnnulmentAdjustments)}`, danger: true },
  ];
  rows.forEach(({ label, value, divider, danger }, index) => {
    const rowY = cardY + 13 + index * 20;
    if (divider) doc.moveTo(detailX + 18, rowY - 5).lineTo(detailX + detailWidth - 18, rowY - 5)
      .lineWidth(0.5).strokeColor(COLORS.line).stroke();
    doc.font("Helvetica").fontSize(8.8).fillColor(danger ? COLORS.danger : COLORS.muted)
      .text(label, detailX + 18, rowY, { width: detailWidth - 150 });
    doc.font("Helvetica-Bold").fontSize(9.1).fillColor(danger ? COLORS.danger : COLORS.ink)
      .text(value, detailX + detailWidth - 140, rowY, { width: 122, align: "right" });
  });
  doc.roundedRect(detailX + 7, cardY + 143, detailWidth - 14, 26, 4).fill(COLORS.limePale);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(COLORS.limeDark)
    .text(copy.resultLabel, detailX + 18, cardY + 152, { width: detailWidth - 160 });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.limeDark)
    .text(money(Math.abs(input.netBalance)), detailX + detailWidth - 145, cardY + 149,
      { width: 127, align: "right" });
  return cardY + cardHeight + 13;
}

function drawPlatformCards(doc: PDFKit.PDFDocument, input: AllyPaymentSettlementPdfInput, y: number) {
  const platforms = (["IPHONE", "ANDROID"] as const)
    .filter((platform) => input.platformSummary[platform].creditCount > 0);
  if (!platforms.length) return y;
  const gap = 12;
  const width = (CONTENT_WIDTH - gap * (platforms.length - 1)) / platforms.length;
  platforms.forEach((platform, index) => {
    const bucket = input.platformSummary[platform];
    const x = PAGE_MARGIN + index * (width + gap);
    const name = platform === "IPHONE" ? "iPhone" : "Android";
    doc.roundedRect(x, y, width, 38, 6).fillAndStroke(COLORS.white, COLORS.line);
    doc.roundedRect(x + 13, y + 9, 21, 21, 10).fill(COLORS.limePale);
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(COLORS.limeDark)
      .text(platform === "IPHONE" ? "i" : "A", x + 13, y + 15, { width: 21, align: "center" });
    doc.font("Helvetica-Bold").fontSize(9.2).fillColor(COLORS.ink).text(name, x + 43, y + 10);
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted)
      .text(`${bucket.creditCount} ${bucket.creditCount === 1 ? "crédito" : "créditos"}   ·   ${percentage(bucket.intermediationPercentage)} intermediación`,
        x + 105, y + 11, { width: width - 120 });
  });
  return y + 49;
}

function drawTableHeader(doc: PDFKit.PDFDocument, y: number) {
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, 4).fill(COLORS.headerSoft);
  let x = PAGE_MARGIN;
  TABLE_COLUMNS.forEach((column, index) => {
    if (index > 0) doc.moveTo(x, y).lineTo(x, y + TABLE_HEADER_HEIGHT)
      .lineWidth(0.35).strokeColor(COLORS.line).stroke();
    doc.font("Helvetica-Bold").fontSize(6.8).fillColor(COLORS.graphite)
      .text(column.label, x + 5, y + 11,
        { width: column.width - 10, height: 18, align: column.align });
    x += column.width;
  });
  return y + TABLE_HEADER_HEIGHT;
}

function lineValues(line: AllyPaymentSettlementPdfLine) {
  return {
    date: dateLabel(line.creditDate),
    client: `${safeText(line.clientName, "Cliente", 60)}\nCC ${safeText(line.clientDocument.replace(/[.\s]/g, ""), "-", 28)}`,
    equipment: `${safeText(line.equipment, "Equipo", 70)}\n${safeText(line.imei, "Sin IMEI", 30)}`,
    site: safeText(line.siteName, "Sede sin nombre", 55),
    sale: money(line.saleValue), initial: money(line.initialPayment),
    credit: money(line.authorizedCredit),
    commission: `${money(line.intermediationValue)}\n(${percentage(line.intermediationPercentage)})`,
    net: money(line.payableValue), status: safeText(line.status, "PAGADO", 18).toUpperCase(),
  };
}

function tableRowHeight(doc: PDFKit.PDFDocument, line: AllyPaymentSettlementPdfLine) {
  const values = lineValues(line);
  let height = MIN_ROW_HEIGHT;
  for (const column of TABLE_COLUMNS) {
    if (column.key === "status") continue;
    doc.font(column.key === "net" ? "Helvetica-Bold" : "Helvetica").fontSize(7.1);
    height = Math.max(height, doc.heightOfString(values[column.key], { width: column.width - 10 }) + 14);
  }
  return Math.min(Math.ceil(height), 64);
}

function drawTableRow(doc: PDFKit.PDFDocument, line: AllyPaymentSettlementPdfLine,
  y: number, height: number, index: number) {
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, height).fill(index % 2 === 0 ? COLORS.white : COLORS.soft);
  const values = lineValues(line);
  let x = PAGE_MARGIN;
  TABLE_COLUMNS.forEach((column, columnIndex) => {
    if (columnIndex > 0) doc.moveTo(x, y).lineTo(x, y + height)
      .lineWidth(0.3).strokeColor(COLORS.line).stroke();
    if (column.key === "status") {
      const pillX = x + 4;
      const pillWidth = column.width - 8;
      doc.roundedRect(pillX, y + (height - 18) / 2, pillWidth, 18, 8).fill(COLORS.limePale);
      doc.font("Helvetica-Bold").fontSize(5.6).fillColor(COLORS.limeDark);
      const statusX = pillX + (pillWidth - doc.widthOfString(values.status)) / 2;
      doc.text(values.status, statusX, y + (height - 18) / 2 + 6, { lineBreak: false });
    } else {
      doc.font(column.key === "net" ? "Helvetica-Bold" : "Helvetica").fontSize(7.1)
        .fillColor(COLORS.ink).text(values[column.key], x + 5, y + 9,
          { width: column.width - 10, height: height - 14, align: column.align, ellipsis: true });
    }
    x += column.width;
  });
  doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_WIDTH - PAGE_MARGIN, y + height)
    .lineWidth(0.4).strokeColor(COLORS.line).stroke();
  return y + height;
}

function drawCollectionHeader(doc: PDFKit.PDFDocument, y: number) {
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, 4).fill(COLORS.headerSoft);
  let x = PAGE_MARGIN;
  COLLECTION_COLUMNS.forEach((column, index) => {
    if (index > 0) doc.moveTo(x, y).lineTo(x, y + TABLE_HEADER_HEIGHT)
      .lineWidth(0.35).strokeColor(COLORS.line).stroke();
    doc.font("Helvetica-Bold").fontSize(6.8).fillColor(COLORS.graphite)
      .text(column.label, x + 5, y + 11, { width: column.width - 10, align: column.align });
    x += column.width;
  });
  return y + TABLE_HEADER_HEIGHT;
}

function collectionValues(item: AllyPaymentSettlementPdfCollection) {
  return {
    date: dateTimeLabel(new Date(item.paymentDate)),
    folio: safeText(creditDisplayNumber(item), "-", 30),
    client: `${safeText(item.clientName, "Cliente", 60)}\nCC ${safeText(item.clientDocument.replace(/[.\s]/g, ""), "-", 28)}`,
    site: safeText(item.siteName, "Sede", 60), method: safeText(item.paymentMethod, "-", 30),
    value: money(item.value), status: safeText(item.status, "DESCONTADO", 18).toUpperCase(),
  };
}

function collectionRowHeight(doc: PDFKit.PDFDocument, item: AllyPaymentSettlementPdfCollection) {
  const values = collectionValues(item);
  let height = MIN_ROW_HEIGHT;
  for (const column of COLLECTION_COLUMNS) {
    if (column.key === "status") continue;
    doc.font(column.key === "value" ? "Helvetica-Bold" : "Helvetica").fontSize(7.1);
    height = Math.max(height, doc.heightOfString(values[column.key], { width: column.width - 10 }) + 14);
  }
  return Math.min(Math.ceil(height), 60);
}

function drawCollectionRow(doc: PDFKit.PDFDocument, item: AllyPaymentSettlementPdfCollection,
  y: number, height: number, index: number) {
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, height).fill(index % 2 === 0 ? COLORS.white : COLORS.soft);
  const values = collectionValues(item);
  let x = PAGE_MARGIN;
  COLLECTION_COLUMNS.forEach((column, columnIndex) => {
    if (columnIndex > 0) doc.moveTo(x, y).lineTo(x, y + height)
      .lineWidth(0.3).strokeColor(COLORS.line).stroke();
    if (column.key === "status") {
      const pillX = x + 10;
      const pillWidth = column.width - 20;
      doc.roundedRect(pillX, y + (height - 18) / 2, pillWidth, 18, 8).fill(COLORS.limePale);
      doc.font("Helvetica-Bold").fontSize(6.2).fillColor(COLORS.limeDark);
      const statusX = pillX + (pillWidth - doc.widthOfString(values.status)) / 2;
      doc.text(values.status, statusX, y + (height - 18) / 2 + 6, { lineBreak: false });
    } else {
      doc.font(column.key === "value" ? "Helvetica-Bold" : "Helvetica").fontSize(7.1)
        .fillColor(COLORS.ink).text(values[column.key], x + 5, y + 9,
          { width: column.width - 10, height: height - 14, align: column.align, ellipsis: true });
    }
    x += column.width;
  });
  doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_WIDTH - PAGE_MARGIN, y + height)
    .lineWidth(0.4).strokeColor(COLORS.line).stroke();
  return y + height;
}

function drawAnnulmentHeader(doc: PDFKit.PDFDocument, y: number) {
  doc.roundedRect(PAGE_MARGIN, y, CONTENT_WIDTH, TABLE_HEADER_HEIGHT, 4).fill(COLORS.dangerPale);
  let x = PAGE_MARGIN;
  ANNULMENT_COLUMNS.forEach((column, index) => {
    if (index > 0) doc.moveTo(x, y).lineTo(x, y + TABLE_HEADER_HEIGHT)
      .lineWidth(0.35).strokeColor(COLORS.dangerLine).stroke();
    doc.font("Helvetica-Bold").fontSize(6.5).fillColor(COLORS.dangerDark)
      .text(column.label, x + 5, y + 10, { width: column.width - 10, height: 20, align: column.align });
    x += column.width;
  });
  return y + TABLE_HEADER_HEIGHT;
}

function annulmentValues(item: AllyPaymentSettlementPdfAnnulmentAdjustment) {
  const platform = item.platform === "ANDROID" ? "Android" : "iPhone";
  return {
    date: dateLabel(item.annulledAt),
    credit: safeText(creditDisplayNumber({
      numeroCreditoVisible: item.visibleCreditNumber,
      folio: item.folio,
    }), "-", 30),
    client: `${safeText(item.clientName, "Cliente", 60)}\nCC ${safeText(item.clientDocument.replace(/[.\s]/g, ""), "-", 28)}`,
    equipment: `${platform} · ${safeText(item.equipment, "Equipo", 58)}\nIMEI ${safeText(item.imei, "-", 30)}`,
    site: safeText(item.siteName, "Sede", 50),
    source: `LA-${item.sourceSettlementId}`,
    reason: safeText(item.reason, "Anulación aprobada", 80),
    value: `- ${money(item.discountValue)}`,
    status: safeText(item.status, "DESCONTADO", 24).replaceAll("_", " ").toUpperCase(),
  };
}

function annulmentRowHeight(doc: PDFKit.PDFDocument, item: AllyPaymentSettlementPdfAnnulmentAdjustment) {
  const values = annulmentValues(item);
  let height = MIN_ROW_HEIGHT;
  for (const column of ANNULMENT_COLUMNS) {
    if (column.key === "status") continue;
    doc.font(column.key === "value" ? "Helvetica-Bold" : "Helvetica").fontSize(6.9);
    height = Math.max(height, doc.heightOfString(values[column.key], { width: column.width - 10 }) + 14);
  }
  return Math.min(Math.ceil(height), 72);
}

function drawAnnulmentRow(
  doc: PDFKit.PDFDocument,
  item: AllyPaymentSettlementPdfAnnulmentAdjustment,
  y: number,
  height: number,
  index: number
) {
  doc.rect(PAGE_MARGIN, y, CONTENT_WIDTH, height)
    .fill(index % 2 === 0 ? COLORS.white : COLORS.dangerPale);
  const values = annulmentValues(item);
  let x = PAGE_MARGIN;
  ANNULMENT_COLUMNS.forEach((column, columnIndex) => {
    if (columnIndex > 0) doc.moveTo(x, y).lineTo(x, y + height)
      .lineWidth(0.3).strokeColor(COLORS.dangerLine).stroke();
    if (column.key === "status") {
      const pillX = x + 3;
      const pillWidth = column.width - 6;
      doc.roundedRect(pillX, y + (height - 22) / 2, pillWidth, 22, 9).fill(COLORS.dangerPale);
      doc.font("Helvetica-Bold").fontSize(5.2).fillColor(COLORS.danger);
      doc.text(values.status, pillX + 3, y + (height - 22) / 2 + 5,
        { width: pillWidth - 6, height: 14, align: "center", ellipsis: true });
    } else {
      doc.font(column.key === "value" ? "Helvetica-Bold" : "Helvetica").fontSize(6.9)
        .fillColor(column.key === "value" || column.key === "credit" || column.key === "source"
          ? COLORS.danger
          : COLORS.ink)
        .text(values[column.key], x + 5, y + 8,
          { width: column.width - 10, height: height - 13, align: column.align, ellipsis: true });
    }
    x += column.width;
  });
  doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_WIDTH - PAGE_MARGIN, y + height)
    .lineWidth(0.4).strokeColor(COLORS.dangerLine).stroke();
  return y + height;
}

function drawFooter(doc: PDFKit.PDFDocument, page: number, totalPages: number) {
  doc.moveTo(PAGE_MARGIN, FOOTER_Y - 8).lineTo(PAGE_WIDTH - PAGE_MARGIN, FOOTER_Y - 8)
    .lineWidth(0.5).strokeColor(COLORS.line).stroke();
  doc.font("Helvetica").fontSize(6.8).fillColor(COLORS.muted)
    .text("Valores expresados en pesos colombianos.", PAGE_MARGIN, FOOTER_Y,
      { width: CONTENT_WIDTH - 120 });
  doc.font("Helvetica-Bold").fillColor(COLORS.graphite)
    .text(`Página ${page} de ${totalPages}`, PAGE_WIDTH - PAGE_MARGIN - 100, FOOTER_Y,
      { width: 100, align: "right" });
}

function addCreditContinuationPage(doc: PDFKit.PDFDocument, input: AllyPaymentSettlementPdfInput) {
  doc.addPage();
  drawHeader(doc, input, true);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.ink)
    .text("Detalle por crédito", PAGE_MARGIN, 91);
  return drawTableHeader(doc, 108);
}

function addAnnulmentPage(
  doc: PDFKit.PDFDocument,
  input: AllyPaymentSettlementPdfInput,
  continuation: boolean
) {
  doc.addPage();
  drawHeader(doc, input, true);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.danger)
    .text(continuation
      ? "Descuentos por créditos anulados · continuación"
      : "Descuentos por créditos anulados", PAGE_MARGIN, 91);
  if (!continuation) {
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.dangerDark)
      .text(`Total descontado en esta liquidación: - ${money(input.totalAnnulmentAdjustments)}`,
        PAGE_MARGIN, 107);
    return drawAnnulmentHeader(doc, 124);
  }
  return drawAnnulmentHeader(doc, 108);
}

function addCollectionPage(doc: PDFKit.PDFDocument, input: AllyPaymentSettlementPdfInput,
  continuation: boolean) {
  doc.addPage();
  drawHeader(doc, input, true);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.ink)
    .text(continuation ? "Recaudos aplicados · continuación" : "Recaudos aplicados", PAGE_MARGIN, 91);
  if (!continuation) {
    doc.font("Helvetica").fontSize(7.5).fillColor(COLORS.muted)
      .text(`Total descontado en esta liquidación: ${money(input.totalAllyCollections)}`, PAGE_MARGIN, 107);
    return drawCollectionHeader(doc, 124);
  }
  return drawCollectionHeader(doc, 108);
}

export async function buildAllyPaymentSettlementPdf(input: AllyPaymentSettlementPdfInput) {
  assertFinancialConsistency(input);
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 0, compress: true,
    bufferPages: true, autoFirstPage: false,
    info: {
      Title: `Liquidación a aliado LA-${input.settlementId}`, Author: "FINSER PAY",
      Subject: "Comprobante de liquidación pagada a aliado",
      Keywords: "FINSER PAY, aliado, liquidación, pago",
    },
  });
  const bufferPromise = toBuffer(doc);
  doc.addPage();
  drawHeader(doc, input);
  let y = drawFirstPageOverview(doc, input);
  y = drawPlatformCards(doc, input, y);
  if (input.lines.length) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(COLORS.ink)
      .text("Detalle por crédito", PAGE_MARGIN, y);
    y = drawTableHeader(doc, y + 17);
    input.lines.forEach((line, index) => {
      const rowHeight = tableRowHeight(doc, line);
      if (y + rowHeight > FOOTER_Y - 14) y = addCreditContinuationPage(doc, input);
      y = drawTableRow(doc, line, y, rowHeight, index);
    });
  }
  if (input.annulmentAdjustments.length) {
    y = addAnnulmentPage(doc, input, false);
    input.annulmentAdjustments.forEach((item, index) => {
      const rowHeight = annulmentRowHeight(doc, item);
      if (y + rowHeight > FOOTER_Y - 14) y = addAnnulmentPage(doc, input, true);
      y = drawAnnulmentRow(doc, item, y, rowHeight, index);
    });
  }
  if (input.collections.length) {
    y = addCollectionPage(doc, input, false);
    input.collections.forEach((item, index) => {
      const rowHeight = collectionRowHeight(doc, item);
      if (y + rowHeight > FOOTER_Y - 14) y = addCollectionPage(doc, input, true);
      y = drawCollectionRow(doc, item, y, rowHeight, index);
    });
  }
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    drawFooter(doc, index - pages.start + 1, pages.count);
  }
  doc.end();
  return bufferPromise;
}
