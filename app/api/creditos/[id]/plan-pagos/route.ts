import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { buildCreditPaymentPlan } from "@/lib/credit-payment-plan";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";
import { ensureCreditAbonoAuditColumns } from "@/lib/credit-abono-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const SYSTEM_FONT_REGULAR = path.join(windowsFontDir, "arial.ttf");
const SYSTEM_FONT_BOLD = path.join(windowsFontDir, "arialbd.ttf");
const BUNDLED_FONT_REGULAR = path.join(
  process.cwd(),
  "public",
  "pdf-fonts",
  "Geist-Regular.ttf"
);

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const EFECTY_CONVENIO_FINSER_PAY =
  process.env.EFECTY_CONVENIO_FINSER_PAY || "113950";

function getPdfFonts() {
  if (existsSync(SYSTEM_FONT_REGULAR) && existsSync(SYSTEM_FONT_BOLD)) {
    return {
      regular: SYSTEM_FONT_REGULAR,
      bold: SYSTEM_FONT_BOLD,
    };
  }

  if (existsSync(BUNDLED_FONT_REGULAR)) {
    return {
      regular: BUNDLED_FONT_REGULAR,
      bold: BUNDLED_FONT_REGULAR,
    };
  }

  return {
    regular: SYSTEM_FONT_REGULAR,
    bold: SYSTEM_FONT_BOLD,
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

function parseId(value: string) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function money(value: number) {
  return moneyFormatter.format(Math.round(Number(value || 0)));
}

function dateLabel(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("es-CO");
}

function textOrDash(value: string | null | undefined) {
  const text = String(value || "").trim();
  return text || "-";
}

function drawInfoCard(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  options?: { accent?: boolean }
) {
  doc
    .save()
    .roundedRect(x, y, width, 48, 14)
    .fillAndStroke(options?.accent ? "#ECFDF5" : "#FFFFFF", options?.accent ? "#A7F3D0" : "#E2E8F0")
    .restore();
  doc
    .fillColor(options?.accent ? "#047857" : "#64748B")
    .font(fonts.bold)
    .fontSize(7.5)
    .text(label.toUpperCase(), x + 12, y + 11, { width: width - 24 });
  doc
    .fillColor("#0F172A")
    .font(fonts.bold)
    .fontSize(10.5)
    .text(value, x + 12, y + 27, { width: width - 24, lineGap: -1 });
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && !sellerSession) {
      return NextResponse.json(
        { error: "Debes abrir primero el perfil del vendedor" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditId = parseId(params.id);

    if (!creditId) {
      return NextResponse.json({ error: "Credito invalido" }, { status: 400 });
    }

    const credito = await prisma.credito.findFirst({
      where: admin ? { id: creditId } : { id: creditId, sedeId: user.sedeId },
      include: {
        sede: {
          select: {
            nombre: true,
          },
        },
      },
    });

    if (!credito) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const abonos = await prisma.creditoAbono.findMany({
      where: {
        creditoId: credito.id,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        valor: true,
        fechaAbono: true,
      },
      orderBy: {
        fechaAbono: "asc",
      },
    });
    const plan = buildCreditPaymentPlan({
      montoCredito: Number(credito.montoCredito || 0),
      valorCuota: Number(credito.valorCuota || 0),
      plazoMeses: Number(credito.plazoMeses || 1),
      frecuenciaPago: credito.frecuenciaPago,
      fechaPrimerPago: credito.fechaPrimerPago || credito.fechaProximoPago,
      abonos: abonos.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });

    const fonts = getPdfFonts();
    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      compress: true,
      font: fonts.regular,
      info: {
        Title: `Plan de pagos ${credito.folio}`,
        Author: "FINSER PAY",
      },
    });
    const bufferPromise = toBuffer(doc);

    const referenciaEfecty = credito.clienteDocumento || credito.folio;
    const totalCuotas = plan.installments.length;

    doc.save().roundedRect(36, 36, 523, 134, 22).fill("#F0FDF4").restore();
    doc.save().roundedRect(36, 36, 9, 134, 5).fill("#0F766E").restore();
    doc.fillColor("#0F766E").font(fonts.bold).fontSize(10).text("FINSER PAY", 62, 55);
    doc.fillColor("#0F172A").font(fonts.bold).fontSize(27).text("Plan de pagos", 62, 76);
    doc
      .fillColor("#475569")
      .font(fonts.regular)
      .fontSize(10.5)
      .text(
        `Folio: ${credito.folio}\nCliente: ${credito.clienteNombre}\nDocumento: ${textOrDash(
          credito.clienteDocumento
        )}\nEquipo: ${credito.referenciaEquipo || credito.imei}\nSede: ${credito.sede.nombre}`,
        62,
        112,
        { width: 300, lineGap: 1 }
      );
    doc
      .fillColor(plan.estadoPago === "MORA" ? "#B91C1C" : "#047857")
      .font(fonts.bold)
      .fontSize(12)
      .text(`Estado: ${plan.estadoPago}`, 397, 58, { width: 132, align: "right" });
    doc
      .fillColor("#047857")
      .font(fonts.bold)
      .fontSize(18)
      .text(EFECTY_CONVENIO_FINSER_PAY, 397, 83, { width: 132, align: "right" });
    doc
      .fillColor("#64748B")
      .font(fonts.regular)
      .fontSize(8.5)
      .text("Convenio EFECTY", 397, 104, { width: 132, align: "right" });
    doc
      .fillColor("#475569")
      .font(fonts.bold)
      .fontSize(8.5)
      .text(`Referencia: ${referenciaEfecty}`, 397, 125, {
        width: 132,
        align: "right",
      });

    const summaryRows = [
      ["Valor cuota", money(Number(credito.valorCuota || 0))],
      ["Cuotas", String(totalCuotas)],
      ["Frecuencia", getPaymentFrequencyLabel(credito.frecuenciaPago)],
      ["Primer pago", dateLabel(credito.fechaPrimerPago)],
      ["Abonado", money(plan.totalPaid)],
    ];

    const starts = [36, 142, 248, 354, 460];
    summaryRows.forEach(([label, value], index) => {
      const x = starts[index];
      drawInfoCard(doc, fonts, x, 196, 94, label, value, { accent: index === 0 });
    });

    doc
      .save()
      .roundedRect(36, 258, 523, 62, 18)
      .fillAndStroke("#FFFBEB", "#FDE68A")
      .restore();
    doc
      .fillColor("#92400E")
      .font(fonts.bold)
      .fontSize(9)
      .text("PAGO EN EFECTY", 58, 274);
    doc
      .fillColor("#0F172A")
      .font(fonts.bold)
      .fontSize(11)
      .text(`Convenio ${EFECTY_CONVENIO_FINSER_PAY}`, 58, 292, { width: 135 });
    doc
      .font(fonts.bold)
      .fontSize(11)
      .text(`Referencia ${referenciaEfecty}`, 202, 292, { width: 160 });
    doc
      .fillColor("#475569")
      .font(fonts.regular)
      .fontSize(8.5)
      .text(
        "Indica el convenio y la referencia al pagar. Conserva el comprobante para soporte.",
        378,
        278,
        { width: 150, lineGap: 2 }
      );

    const headers = ["Cuota", "Vence", "Valor", "Abonado", "Pendiente", "Estado"];
    const widths = [44, 86, 92, 92, 92, 82];
    const x0 = 36;
    let y = 350;

    doc.save().roundedRect(x0, y, 523, 26, 10).fill("#0F172A").restore();
    let x = x0 + 12;
    headers.forEach((header, index) => {
      doc.fillColor("#FFFFFF").font(fonts.bold).fontSize(8.5).text(header, x, y + 9, {
        width: widths[index] - 8,
      });
      x += widths[index];
    });

    y += 31;
    for (const item of plan.installments) {
      if (y > 740) {
        doc.addPage();
        y = 48;
        doc.save().roundedRect(x0, y, 523, 26, 10).fill("#0F172A").restore();
        x = x0 + 12;
        headers.forEach((header, index) => {
          doc.fillColor("#FFFFFF").font(fonts.bold).fontSize(8.5).text(header, x, y + 9, {
            width: widths[index] - 8,
          });
          x += widths[index];
        });
        y += 31;
      }

      doc.save().roundedRect(x0, y, 523, 28, 9).fillAndStroke("#FFFFFF", "#E2E8F0").restore();
      x = x0 + 12;
      const row = [
        String(item.numero),
        dateLabel(item.fechaVencimiento),
        money(item.valorProgramado),
        money(item.valorAbonado),
        money(item.saldoPendiente),
        item.estado,
      ];
      row.forEach((value, index) => {
        doc
          .fillColor(item.estaEnMora ? "#B91C1C" : "#0F172A")
          .font(index === 5 ? fonts.bold : fonts.regular)
          .fontSize(8.5)
          .text(value, x, y + 9, { width: widths[index] - 8 });
        x += widths[index];
      });
      y += 34;
    }

    doc
      .fillColor("#64748B")
      .font(fonts.regular)
      .fontSize(9)
      .text(
        "Este plan refleja los abonos registrados en FINSER PAY a la fecha de generacion.",
        36,
        Math.min(y + 18, 770),
        { width: 523 }
      );

    doc.end();

    const buffer = await bufferPromise;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="plan-pagos-${credito.folio}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO PLAN DE PAGOS:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el plan de pagos" },
      { status: 500 }
    );
  }
}
