import PDFDocument from "pdfkit";

export type ClientPaymentReceiptPdfInput = {
  receiptNumber: string;
  paymentDate: Date;
  paymentMethod: string | null;
  paymentAmount: number;
  clientName: string;
  clientDocument: string;
  creditFolio: string;
  numeroCreditoVisible?: string;
  totalPaidThroughPayment: number;
  paymentSequence: number;
  paymentType: "PAYMENT" | "EARLY_PAYOFF" | "PRINCIPAL";
  principalPayment?: {
    capitalBefore: number;
    capitalAfter: number;
    capitalApplied: number;
    eliminatedInstallments: number;
  };
  creditClosed: boolean;
  settledAt?: Date | null;
  presentation?: {
    format?: "A4" | "POS";
    showFullDocument?: boolean;
    hidePaymentSequence?: boolean;
    status?: string;
    operationalRows?: Array<{ label: string; value: string }>;
    upcomingInstallments?: Array<{ number: string; date: string; amount: number }>;
    historicalPlanNotice?: string;
    observation?: string | null;
    annulment?: { date: Date | string | null; reason: string | null };
  };
};

const COLORS = {
  ink: "#151A21",
  green: "#237F0B",
  muted: "#667085",
  line: "#D8DEE5",
  danger: "#B42318",
};
const DISCLAIMER = "Este comprobante confirma el pago registrado. No certifica saldo pendiente ni cierre de la obligación.";
const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency", currency: "COP", maximumFractionDigits: 0,
});

type ReceiptBlock =
  | { kind: "brand" }
  | { kind: "rule"; green?: boolean }
  | { kind: "text"; value: string; size?: number; bold?: boolean; muted?: boolean; danger?: boolean; gap?: number }
  | { kind: "row"; label: string; value: string; bold?: boolean }
  | { kind: "installment"; number: string; date: string; value: string; heading?: boolean };

function textValue(value: string | number | null | undefined) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || "-";
}
function money(value: number) {
  return moneyFormatter.format(Math.round(Math.max(0, Number(value || 0))));
}
function maskedDocument(value: string) {
  const visible = String(value || "").replace(/\D/g, "").slice(-4);
  return visible ? `Documento terminado en ${visible}` : "Documento validado";
}
function dateTimeLabel(value: Date | string | null) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("es-CO", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}
function paymentMethodLabel(value: string | null) {
  const labels: Record<string, string> = {
    BANCOLOMBIA: "Bancolombia", EFECTIVO: "Efectivo", NEQUI: "Nequi / Wompi", WOMPI: "Wompi",
  };
  return labels[String(value || "").trim().toUpperCase()] || textValue(value);
}
function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

export async function buildClientPaymentReceiptPdf(input: ClientPaymentReceiptPdfInput) {
  const principal = input.paymentType === "PRINCIPAL" ? input.principalPayment : null;
  if (input.paymentType === "PRINCIPAL" && (!principal ||
    ![principal.capitalBefore, principal.capitalApplied, principal.capitalAfter, principal.eliminatedInstallments]
      .every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0))) {
    throw new Error("El comprobante de capital requiere el resultado registrado de la operación.");
  }
  const pos = input.presentation?.format === "POS";
  const pageWidth = pos ? 226.77 : 595.28;
  const left = pos ? 12 : 86;
  const width = pageWidth - left * 2;
  const top = pos ? 18 : 72;
  const baseSize = pos ? 8 : 10;
  const gap = pos ? 7 : 12;
  const blocks: ReceiptBlock[] = [
    { kind: "brand" },
    { kind: "rule", green: true },
    { kind: "text", value: principal ? "ABONO A CAPITAL" : input.paymentType === "EARLY_PAYOFF" ? "LIQUIDACIÓN ANTICIPADA" : "ABONO REGISTRADO", bold: true, size: pos ? 11 : 15, gap: pos ? 10 : 14 },
    { kind: "text", value: money(input.paymentAmount), bold: true, size: pos ? 26 : 43, gap: pos ? 12 : 20 },
    { kind: "row", label: "Comprobante", value: textValue(input.receiptNumber), bold: true },
    { kind: "row", label: "Fecha del abono", value: dateTimeLabel(input.paymentDate) },
    { kind: "row", label: "Medio de pago", value: paymentMethodLabel(input.paymentMethod) },
    { kind: "rule" },
    { kind: "row", label: "Cliente", value: textValue(input.clientName), bold: true },
    { kind: "row", label: "Identificación", value: input.presentation?.showFullDocument ? textValue(input.clientDocument) : maskedDocument(input.clientDocument) },
    { kind: "row", label: "CRÉDITO", value: textValue(input.numeroCreditoVisible || input.creditFolio), bold: true },
    { kind: "row", label: "Folio original", value: textValue(input.creditFolio) },
  ];
  if (input.presentation?.status) {
    blocks.push({ kind: "row", label: "Estado del abono", value: textValue(input.presentation.status), bold: true });
  } else if (input.creditClosed) {
    blocks.push({ kind: "row", label: "Estado en sistema", value: "Pagado en sistema" });
  }
  if (principal) {
    blocks.push(
      { kind: "rule" },
      { kind: "text", value: "RESULTADO DEL ABONO A CAPITAL", bold: true, size: baseSize, gap },
      { kind: "row", label: "Capital anterior", value: money(principal.capitalBefore) },
      { kind: "row", label: "Capital aplicado", value: money(principal.capitalApplied), bold: true },
      { kind: "row", label: "Capital pendiente", value: money(principal.capitalAfter), bold: true },
      { kind: "row", label: "Cuotas eliminadas", value: String(principal.eliminatedInstallments) },
    );
  }
  blocks.push(
    { kind: "rule" },
    ...(input.presentation?.hidePaymentSequence ? [] : [{ kind: "row" as const, label: "Secuencia de recaudo", value: `#${Math.max(1, Math.trunc(Number(input.paymentSequence || 1)))}` }]),
    { kind: "row", label: "Acumulado hasta este pago", value: money(input.totalPaidThroughPayment), bold: true },
  );
  if (input.presentation?.operationalRows?.length) {
    blocks.push({ kind: "rule" });
    for (const item of input.presentation.operationalRows) {
      blocks.push({ kind: "row", label: textValue(item.label), value: textValue(item.value) });
    }
  }
  if (input.presentation?.historicalPlanNotice) {
    blocks.push({ kind: "text", value: input.presentation.historicalPlanNotice, muted: true, size: baseSize - 0.5, gap });
  }
  if (input.presentation?.upcomingInstallments?.length) {
    blocks.push(
      { kind: "rule" },
      { kind: "text", value: "PRÓXIMAS CUOTAS SEGÚN ESTE ABONO", bold: true, size: baseSize, gap },
      { kind: "installment", number: "Cuota", date: "Fecha", value: "Valor", heading: true },
    );
    for (const item of input.presentation.upcomingInstallments) {
      blocks.push({ kind: "installment", number: item.number, date: item.date, value: money(item.amount) });
    }
  }
  if (input.presentation?.observation) {
    blocks.push({ kind: "rule" }, { kind: "text", value: "OBSERVACIÓN", bold: true, size: baseSize, gap: 4 },
      { kind: "text", value: textValue(input.presentation.observation), size: baseSize, gap });
  }
  if (input.presentation?.annulment) {
    blocks.push({ kind: "rule" }, { kind: "text", value: "RECIBO ANULADO", bold: true, danger: true, size: baseSize + 2, gap },
      { kind: "row", label: "Fecha de anulación", value: dateTimeLabel(input.presentation.annulment.date) },
      { kind: "row", label: "Motivo", value: textValue(input.presentation.annulment.reason) });
  }
  blocks.push({ kind: "rule" },
    { kind: "text", value: DISCLAIMER, muted: true, size: pos ? 7.2 : 9, gap: pos ? 10 : 16 },
    { kind: "text", value: "finserpay.com/clientes", bold: true, size: pos ? 8 : 10, gap: 0 });

  const doc = new PDFDocument({
    autoFirstPage: false, margin: 0, compress: true,
    info: { Title: `Recibo de pago ${textValue(input.receiptNumber)}`, Author: "FINSER PAY",
      Subject: "Comprobante de abono registrado", Keywords: "FINSER PAY, recibo, abono" },
  });
  const bufferPromise = toBuffer(doc);
  function configureFont(size: number, bold = false) {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size);
  }
  function textHeight(value: string, columnWidth: number, size: number, bold = false) {
    configureFont(size, bold);
    return doc.heightOfString(value, { width: columnWidth, lineGap: pos ? 1 : 2 });
  }
  function blockHeight(block: ReceiptBlock) {
    if (block.kind === "brand") return pos ? 34 : 47;
    if (block.kind === "rule") return pos ? 15 : 23;
    if (block.kind === "text") return textHeight(block.value, width, block.size || baseSize, block.bold) + (block.gap ?? gap);
    if (block.kind === "row") {
      return Math.max(textHeight(block.label, width * 0.39 - 5, baseSize),
        textHeight(block.value, width * 0.61 - 5, baseSize, block.bold)) + (pos ? 6 : 11);
    }
    return Math.max(textHeight(block.number, width * 0.2, baseSize - 0.4, block.heading),
      textHeight(block.date, width * 0.36, baseSize - 0.4, block.heading),
      textHeight(block.value, width * 0.42, baseSize - 0.4, block.heading)) + (pos ? 6 : 9);
  }
  const heights = blocks.map(blockHeight);
  const pageHeight = pos ? Math.max(280, top + heights.reduce((sum, height) => sum + height, 0) + 18) : 841.89;
  doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
  let y = top;
  function write(value: string, x: number, columnWidth: number, size: number, options: { bold?: boolean; muted?: boolean; danger?: boolean; align?: "left" | "center" | "right" } = {}) {
    configureFont(size, options.bold);
    doc.fillColor(options.danger ? COLORS.danger : options.muted ? COLORS.muted : COLORS.ink)
      .text(value, x, y, { width: columnWidth, lineGap: pos ? 1 : 2, align: options.align || "left" });
  }
  blocks.forEach((block, index) => {
    const height = heights[index];
    if (!pos && y + height > pageHeight - 44) {
      doc.addPage({ size: [pageWidth, pageHeight], margin: 0 });
      y = 44;
    }
    if (block.kind === "brand") {
      const size = pos ? 20 : 26;
      configureFont(size, true);
      const finserWidth = doc.widthOfString("FINSER ");
      const payWidth = doc.widthOfString("PAY");
      const start = left + (width - finserWidth - payWidth) / 2;
      doc.fillColor(COLORS.ink).text("FINSER", start, y, { lineBreak: false });
      doc.fillColor(COLORS.green).text("PAY", start + finserWidth, y, { lineBreak: false });
    } else if (block.kind === "rule") {
      doc.moveTo(left, y + 3).lineTo(left + width, y + 3)
        .lineWidth(block.green ? 2.5 : 0.6).strokeColor(block.green ? COLORS.green : COLORS.line).stroke();
    } else if (block.kind === "text") {
      write(block.value, left, width, block.size || baseSize, { bold: block.bold, muted: block.muted, danger: block.danger, align: "center" });
    } else if (block.kind === "row") {
      write(block.label, left, width * 0.39 - 5, baseSize, { muted: true });
      write(block.value, left + width * 0.39 + 5, width * 0.61 - 5, baseSize, { bold: block.bold, align: "right" });
    } else {
      write(block.number, left, width * 0.2, baseSize - 0.4, { bold: block.heading });
      write(block.date, left + width * 0.22, width * 0.36, baseSize - 0.4, { bold: block.heading });
      write(block.value, left + width * 0.58, width * 0.42, baseSize - 0.4, { bold: block.heading, align: "right" });
    }
    y += height;
  });
  doc.end();
  return bufferPromise;
}
