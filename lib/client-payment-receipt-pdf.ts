import PDFDocument from "pdfkit";

export type ClientPaymentReceiptPdfInput = {
  receiptNumber: string;
  paymentDate: Date;
  paymentMethod: string | null;
  paymentAmount: number;
  clientName: string;
  clientDocument: string;
  creditFolio: string;
  totalPaidThroughPayment: number;
  paymentSequence: number;
  paymentType: "PAYMENT" | "EARLY_PAYOFF";
  creditClosed: boolean;
  settledAt?: Date | null;
};

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const PAGE_MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

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
};

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

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

function money(value: number) {
  return moneyFormatter.format(Math.round(Math.max(0, Number(value || 0))));
}

function safeText(value: string | null | undefined, maxLength = 72) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "-";
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function maskedDocument(value: string) {
  const document = String(value || "").replace(/\D/g, "");
  const visible = document.slice(-4);
  return visible ? `Documento terminado en ${visible}` : "Documento validado";
}

function dateTimeLabel(value: Date) {
  return value.toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "long",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateLabel(value: Date | string) {
  const normalized = String(value || "").trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00-05:00`)
    : value instanceof Date
      ? value
      : new Date(normalized);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "long",
    day: "2-digit",
  });
}

function paymentMethodLabel(value: string | null) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  const labels: Record<string, string> = {
    BANCOLOMBIA: "Bancolombia",
    EFECTIVO: "Efectivo",
    NEQUI: "Nequi / Wompi",
    WOMPI: "Wompi",
  };

  return labels[normalized] || safeText(value, 30);
}

function drawCheck(doc: PDFKit.PDFDocument, x: number, y: number, radius: number) {
  doc.circle(x, y, radius).fill(COLORS.lime);
  doc
    .moveTo(x - radius * 0.46, y)
    .lineTo(x - radius * 0.1, y + radius * 0.36)
    .lineTo(x + radius * 0.52, y - radius * 0.4)
    .lineWidth(2.4)
    .lineCap("round")
    .lineJoin("round")
    .strokeColor(COLORS.graphite)
    .stroke();
}

function drawDetailRow(
  doc: PDFKit.PDFDocument,
  y: number,
  label: string,
  value: string,
  options: { last?: boolean; valueColor?: string } = {}
) {
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(label.toUpperCase(), PAGE_MARGIN + 22, y, { width: 166 });
  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(options.valueColor || COLORS.ink)
    .text(value, PAGE_MARGIN + 190, y - 1, {
      width: CONTENT_WIDTH - 212,
      align: "right",
    });

  if (!options.last) {
    doc
      .moveTo(PAGE_MARGIN + 22, y + 24)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN - 22, y + 24)
      .lineWidth(0.6)
      .strokeColor(COLORS.line)
      .stroke();
  }
}

function drawMetric(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  value: string,
  label: string,
  accent = false
) {
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor(accent ? COLORS.limeDark : COLORS.ink)
    .text(value, x, y, { width, align: "center" });
  doc
    .font("Helvetica")
    .fontSize(8.5)
    .fillColor(COLORS.muted)
    .text(label, x, y + 23, { width, align: "center" });
}

export async function buildClientPaymentReceiptPdf(
  input: ClientPaymentReceiptPdfInput
) {
  const receiptNumber = safeText(input.receiptNumber, 56);
  const closed = Boolean(input.creditClosed);
  const earlyPayoff = input.paymentType === "EARLY_PAYOFF";
  const paymentSequence = Math.max(1, Math.trunc(Number(input.paymentSequence || 1)));
  const doc = new PDFDocument({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margin: 0,
    compress: true,
    info: {
      Title: `Recibo de pago ${receiptNumber}`,
      Author: "FINSER PAY",
      Subject: "Comprobante de pago de crédito",
      Keywords: "FINSER PAY, recibo, pago",
    },
  });
  const bufferPromise = toBuffer(doc);

  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(COLORS.porcelain);
  doc.rect(0, 0, PAGE_WIDTH, 176).fill(COLORS.graphite);
  doc.rect(0, 171, PAGE_WIDTH, 5).fill(COLORS.lime);

  doc
    .font("Helvetica-Bold")
    .fontSize(23)
    .fillColor(COLORS.white)
    .text("FINSER", PAGE_MARGIN, 39, { continued: true })
    .fillColor(COLORS.lime)
    .text(" PAY");
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#C7CBC7")
    .text("Tu crédito, siempre contigo.", PAGE_MARGIN, 70);

  doc
    .font("Helvetica")
    .fontSize(8)
    .fillColor("#AEB3AE")
    .text("RECIBO", PAGE_WIDTH - PAGE_MARGIN - 190, 40, {
      width: 190,
      align: "right",
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(COLORS.white)
    .text(receiptNumber, PAGE_WIDTH - PAGE_MARGIN - 235, 55, {
      width: 235,
      align: "right",
    });

  drawCheck(doc, PAGE_MARGIN + 15, 120, 15);
  doc
    .font("Helvetica-Bold")
    .fontSize(15)
    .fillColor(COLORS.white)
    .text(
      closed
        ? earlyPayoff
          ? "Liquidación anticipada aplicada - obligación cerrada"
          : "Pago aplicado - obligación cerrada"
        : earlyPayoff
          ? "Liquidación anticipada registrada"
          : "Pago aplicado correctamente",
      PAGE_MARGIN + 42,
      110
    );
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor("#C7CBC7")
    .text(dateTimeLabel(input.paymentDate), PAGE_MARGIN + 42, 132);

  const amountY = 198;
  doc
    .roundedRect(PAGE_MARGIN, amountY, CONTENT_WIDTH, 104, 16)
    .fillAndStroke(COLORS.limePale, "#D3E8AB");
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.limeDark)
    .text("VALOR DEL PAGO", PAGE_MARGIN + 22, amountY + 20);
  doc
    .font("Helvetica-Bold")
    .fontSize(31)
    .fillColor(COLORS.graphite)
    .text(money(input.paymentAmount), PAGE_MARGIN + 22, amountY + 38, {
      width: CONTENT_WIDTH - 44,
    });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(`Medio: ${paymentMethodLabel(input.paymentMethod)}`, PAGE_MARGIN + 22, amountY + 82);

  const clientY = 322;
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(COLORS.ink)
    .text("Datos del pago", PAGE_MARGIN, clientY);
  doc
    .roundedRect(PAGE_MARGIN, clientY + 24, CONTENT_WIDTH, 142, 14)
    .fillAndStroke(COLORS.white, COLORS.line);

  drawDetailRow(doc, clientY + 45, "Cliente", safeText(input.clientName, 52));
  drawDetailRow(doc, clientY + 82, "Identificación", maskedDocument(input.clientDocument));
  drawDetailRow(doc, clientY + 119, "Crédito", safeText(input.creditFolio, 42), {
    last: true,
  });

  const progressY = 510;
  doc
    .font("Helvetica-Bold")
    .fontSize(12)
    .fillColor(COLORS.ink)
    .text("Estado después de este pago", PAGE_MARGIN, progressY);
  doc
    .roundedRect(PAGE_MARGIN, progressY + 24, CONTENT_WIDTH, 82, 14)
    .fillAndStroke(COLORS.white, COLORS.line);

  const metricWidth = CONTENT_WIDTH / 3;
  drawMetric(
    doc,
    PAGE_MARGIN,
    progressY + 43,
    metricWidth,
    money(input.totalPaidThroughPayment),
    "Acumulado hasta este pago"
  );
  drawMetric(
    doc,
    PAGE_MARGIN + metricWidth,
    progressY + 43,
    metricWidth,
    `#${paymentSequence}`,
    "Secuencia de recaudo"
  );
  drawMetric(
    doc,
    PAGE_MARGIN + metricWidth * 2,
    progressY + 43,
    metricWidth,
    earlyPayoff ? "Liquidación" : "Abono",
    "Tipo de recaudo",
    earlyPayoff
  );
  doc
    .moveTo(PAGE_MARGIN + metricWidth, progressY + 39)
    .lineTo(PAGE_MARGIN + metricWidth, progressY + 89)
    .lineWidth(0.6)
    .strokeColor(COLORS.line)
    .stroke();
  doc
    .moveTo(PAGE_MARGIN + metricWidth * 2, progressY + 39)
    .lineTo(PAGE_MARGIN + metricWidth * 2, progressY + 89)
    .stroke();

  const statusY = 636;
  if (closed) {
    doc
      .roundedRect(PAGE_MARGIN, statusY, CONTENT_WIDTH, 78, 14)
      .fillAndStroke(COLORS.graphite, COLORS.graphite);
    drawCheck(doc, PAGE_MARGIN + 31, statusY + 30, 13);
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(COLORS.white)
      .text(
        earlyPayoff
          ? "Liquidación anticipada - obligación cerrada"
          : "Obligación cerrada",
        PAGE_MARGIN + 56,
        statusY + 17
      );
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor("#C7CBC7")
      .text(
        input.settledAt
          ? `Crédito finalizado el ${dateLabel(input.settledAt)}. El paz y salvo está disponible en el portal.`
          : "El crédito figura pagado en su totalidad. El paz y salvo está disponible en el portal.",
        PAGE_MARGIN + 56,
        statusY + 39,
        { width: CONTENT_WIDTH - 78 }
      );
  } else {
    doc
      .roundedRect(PAGE_MARGIN, statusY, CONTENT_WIDTH, 78, 14)
      .fillAndStroke(COLORS.white, COLORS.line);
    doc
      .font("Helvetica-Bold")
      .fontSize(11.5)
      .fillColor(COLORS.ink)
      .text(
        earlyPayoff ? "Liquidación anticipada registrada" : "Abono registrado",
        PAGE_MARGIN + 22,
        statusY + 17
      );
    doc
      .font("Helvetica")
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text(
        "Este comprobante certifica el recaudo. No certifica saldo pendiente ni cierre de la obligación.",
        PAGE_MARGIN + 22,
        statusY + 39,
        { width: CONTENT_WIDTH - 44 }
      );
  }

  doc
    .font("Helvetica")
    .fontSize(7.8)
    .fillColor(COLORS.muted)
    .text(
      "Este recibo confirma la aplicación del pago registrado. No reemplaza el paz y salvo.",
      PAGE_MARGIN,
      742,
      { width: CONTENT_WIDTH, align: "center" }
    );
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(COLORS.graphite)
    .text("finserpay.com/clientes", PAGE_MARGIN, 758, {
      width: CONTENT_WIDTH,
      align: "center",
    });

  doc.end();
  return bufferPromise;
}
