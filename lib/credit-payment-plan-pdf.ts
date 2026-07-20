import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";

type PaymentPlan = ReturnType<typeof buildCreditPaymentPlan>;

export type CreditPaymentPlanPdfInput = {
  folio: string;
  clienteNombre: string;
  clienteDocumento: string;
  sedeNombre: string;
  equipo: string;
  fechaGeneracion: Date;
  valorCuota: number;
  frecuencia: string;
  saldoContractual: number;
  referenciaEfecty: string;
  convenioEfecty: string;
  plan: PaymentPlan;
};

const BUNDLED_FONT_REGULAR = path.join(
  process.cwd(),
  "public",
  "pdf-fonts",
  "Geist-Regular.ttf"
);
const LOGO_PATH = path.join(process.cwd(), "public", "branding", "finserpay-logo.jpg");
const MONEY_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const MONTHS = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

const COLORS = {
  navy: "#071827",
  graphite: "#151A21",
  muted: "#667085",
  border: "#D8DEE5",
  porcelain: "#F5F6F4",
  lime: "#B7E63D",
  limeDark: "#5C7A13",
  limeSoft: "#F2F9DF",
  amber: "#B86B10",
  amberSoft: "#FFF6DF",
  red: "#B42318",
  redSoft: "#FFF1F0",
  white: "#FFFFFF",
};

function money(value: number) {
  return MONEY_FORMATTER.format(Math.round(Number(value || 0))).replace("COP", "$");
}

export function paymentPlanDateLabel(value: Date | string | null | undefined) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return "-";

  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function stateLabel(
  item: PaymentPlan["installments"][number],
  nextNumber: number | null
) {
  if (item.estado === "PAGO") return "Pagada";
  if (item.numero === nextNumber) return "Proxima";
  if (item.estaEnMora) return "En mora";
  return "Pendiente";
}

function fontSet() {
  if (existsSync(BUNDLED_FONT_REGULAR)) {
    return { regular: BUNDLED_FONT_REGULAR, bold: BUNDLED_FONT_REGULAR };
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

function fitText(value: string, max = 42) {
  const normalized = String(value || "-").trim() || "-";
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function drawLabelValue(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  x: number,
  y: number,
  width: number,
  label: string,
  value: string
) {
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(7).text(label, x, y, { width });
  doc.fillColor(COLORS.graphite).font(fonts.bold).fontSize(9.5).text(value, x, y + 13, {
    width,
    ellipsis: true,
    lineBreak: false,
  });
}

function drawMetric(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  detail: string
) {
  doc.save().roundedRect(x, y, width, 55, 7).fillAndStroke(COLORS.white, COLORS.border).restore();
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(7).text(label, x + 10, y + 9, { width: width - 20 });
  doc.fillColor(COLORS.graphite).font(fonts.bold).fontSize(13).text(value, x + 10, y + 23, { width: width - 20, ellipsis: true, lineBreak: false });
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(7).text(detail, x + 10, y + 43, { width: width - 20, ellipsis: true, lineBreak: false });
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  y: number
) {
  const headers = ["Cuota", "Vencimiento", "Valor", "Abonado", "Pendiente", "Estado"];
  const widths = [48, 96, 88, 88, 92, 91];
  let x = 46;

  doc.save().roundedRect(32, y, 531, 25, 5).fill(COLORS.navy).restore();
  headers.forEach((header, index) => {
    doc.fillColor(COLORS.white).font(fonts.bold).fontSize(7.5).text(header, x, y + 9, {
      width: widths[index] - 6,
      align: index > 1 && index < 5 ? "right" : "left",
    });
    x += widths[index];
  });
}

function drawContinuationHeader(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  input: CreditPaymentPlanPdfInput
) {
  doc.fillColor(COLORS.navy).font(fonts.bold).fontSize(15).text("FINSER PAY", 32, 34);
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(8.5).text(`Plan de pagos · ${input.folio}`, 32, 55);
  doc.moveTo(32, 73).lineTo(563, 73).strokeColor(COLORS.border).stroke();
}

export async function buildCreditPaymentPlanPdf(input: CreditPaymentPlanPdfInput) {
  const fonts = fontSet();
  const doc = new PDFDocument({
    size: "A4",
    margin: 32,
    compress: true,
    bufferPages: true,
    font: fonts.regular,
    info: {
      Title: `Plan de pagos ${input.folio}`,
      Author: "FINSER PAY",
    },
  });
  const bufferPromise = toBuffer(doc);
  const nextNumber = input.plan.nextInstallment?.numero || null;
  const state =
    input.plan.estadoPago === "MORA"
      ? "En mora"
      : input.plan.estadoPago === "PAGADO"
        ? "Pagado"
        : "Al dia";
  const stateColors =
    input.plan.estadoPago === "MORA"
      ? { fill: COLORS.redSoft, text: COLORS.red }
      : { fill: COLORS.limeSoft, text: COLORS.limeDark };
  const paidPercent = input.plan.installments.length
    ? (input.plan.paidCount / input.plan.installments.length) * 100
    : 0;

  doc.save().roundedRect(32, 30, 531, 92, 10).fill(COLORS.navy).restore();
  if (existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 48, 44, { fit: [54, 54], align: "center", valign: "center" });
  }
  doc.fillColor(COLORS.white).font(fonts.bold).fontSize(18).text("FINSER PAY", 116, 48);
  doc.fillColor("#DCE4EC").font(fonts.regular).fontSize(8.5).text("Plan de pagos", 116, 72);
  doc.fillColor(COLORS.white).font(fonts.bold).fontSize(15).text(input.folio, 116, 88, {
    width: 260,
    ellipsis: true,
    lineBreak: false,
  });
  doc.save().roundedRect(446, 48, 92, 25, 12).fill(stateColors.fill).restore();
  doc.fillColor(stateColors.text).font(fonts.bold).fontSize(8.5).text(state, 446, 57, {
    width: 92,
    align: "center",
  });
  doc.fillColor("#DCE4EC").font(fonts.regular).fontSize(7.5).text(
    `Generado ${paymentPlanDateLabel(input.fechaGeneracion)}`,
    406,
    91,
    { width: 132, align: "right" }
  );

  doc.save().roundedRect(32, 134, 531, 70, 8).fillAndStroke(COLORS.white, COLORS.border).restore();
  drawLabelValue(doc, fonts, 46, 149, 190, "CLIENTE", fitText(input.clienteNombre, 36));
  drawLabelValue(doc, fonts, 250, 149, 128, "DOCUMENTO", fitText(input.clienteDocumento, 22));
  drawLabelValue(doc, fonts, 392, 149, 150, "SEDE", fitText(input.sedeNombre, 26));
  drawLabelValue(doc, fonts, 46, 178, 332, "EQUIPO", fitText(input.equipo, 52));
  drawLabelValue(doc, fonts, 392, 178, 150, "FRECUENCIA", fitText(input.frecuencia, 24));

  doc.fillColor(COLORS.graphite).font(fonts.bold).fontSize(10).text("Progreso de cuotas", 32, 220);
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(8).text(
    `${input.plan.paidCount} de ${input.plan.installments.length} pagadas`,
    430,
    221,
    { width: 133, align: "right" }
  );
  doc.save().roundedRect(32, 242, 531, 7, 4).fill("#E8ECF0").restore();
  if (paidPercent > 0) {
    doc.save().roundedRect(32, 242, Math.max(7, 531 * Math.min(1, paidPercent / 100)), 7, 4).fill(COLORS.lime).restore();
  }

  doc.save().roundedRect(32, 265, 531, 54, 8).fillAndStroke(COLORS.limeSoft, "#C9DF91").restore();
  doc.fillColor(COLORS.limeDark).font(fonts.bold).fontSize(8).text("PAGO EN EFECTY", 47, 277);
  doc.fillColor(COLORS.graphite).font(fonts.bold).fontSize(12).text(`Convenio ${input.convenioEfecty}`, 47, 291, { width: 150 });
  doc.fillColor(COLORS.graphite).font(fonts.bold).fontSize(12).text(`Referencia ${input.referenciaEfecty}`, 210, 291, { width: 210, ellipsis: true, lineBreak: false });
  doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(7.5).text("Conserva el comprobante de pago.", 431, 280, { width: 112, align: "right" });

  const next = input.plan.nextInstallment;
  const metrics = [
    ["VALOR CUOTA", money(input.valorCuota), `${input.plan.installments.length} cuotas`],
    ["VALOR ABONADO", money(input.plan.totalPaid), `${Math.round(paidPercent)}% completado`],
    ["SALDO CONTRACTUAL", money(input.saldoContractual), "Saldo del credito"],
    ["PROXIMA CUOTA", money(next?.saldoPendiente || 0), paymentPlanDateLabel(next?.fechaVencimiento)],
  ];
  metrics.forEach(([label, value, detail], index) =>
    drawMetric(doc, fonts, 32 + index * 135, 335, index === 3 ? 126 : 126, label, value, detail)
  );

  let y = 408;
  drawTableHeader(doc, fonts, y);
  y += 29;
  const rowHeight = 28;
  const widths = [48, 96, 88, 88, 92, 91];

  input.plan.installments.forEach((item) => {
    if (y + rowHeight > 775) {
      doc.addPage();
      drawContinuationHeader(doc, fonts, input);
      y = 92;
      drawTableHeader(doc, fonts, y);
      y += 29;
    }

    const isNext = item.numero === nextNumber;
    const label = stateLabel(item, nextNumber);
    const fill = item.estado === "PAGO" ? COLORS.limeSoft : isNext ? COLORS.amberSoft : COLORS.white;
    const line = item.estado === "PAGO" ? "#C9DF91" : isNext ? "#F0D28D" : COLORS.border;
    doc.save().roundedRect(32, y, 531, rowHeight - 2, 4).fillAndStroke(fill, line).restore();

    const values = [
      String(item.numero),
      paymentPlanDateLabel(item.fechaVencimiento),
      money(item.valorProgramado),
      money(item.valorAbonado),
      money(item.saldoPendiente),
      label,
    ];
    let x = 46;
    values.forEach((value, index) => {
      const color = item.estaEnMora ? COLORS.red : isNext ? COLORS.amber : index === 5 && item.estado === "PAGO" ? COLORS.limeDark : COLORS.graphite;
      doc.fillColor(color).font(index === 0 || index === 5 ? fonts.bold : fonts.regular).fontSize(8).text(value, x, y + 9, {
        width: widths[index] - 6,
        align: index > 1 && index < 5 ? "right" : "left",
        ellipsis: true,
        lineBreak: false,
      });
      x += widths[index];
    });
    y += rowHeight;
  });

  const planDifference = Math.round(input.saldoContractual - input.plan.saldoPendiente);
  if (planDifference !== 0) {
    doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(6.8).text(
      `Nota: el saldo contractual difiere ${money(Math.abs(planDifference))} de la suma pendiente del plan por distribucion y redondeo de cuotas.`,
      32,
      Math.min(y + 8, 786),
      { width: 531 }
    );
  }

  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    doc.moveTo(32, 786).lineTo(563, 786).strokeColor(COLORS.border).stroke();
    doc.fillColor(COLORS.muted).font(fonts.regular).fontSize(7.5).text(
      "Este documento refleja los abonos registrados en FINSER PAY a la fecha de generacion.",
      32,
      796,
      { width: 440 }
    );
    doc.fillColor(COLORS.muted).font(fonts.bold).fontSize(7.5).text(
      `Pagina ${index - range.start + 1} de ${range.count}`,
      474,
      796,
      { width: 89, align: "right" }
    );
  }

  doc.end();
  return bufferPromise;
}
