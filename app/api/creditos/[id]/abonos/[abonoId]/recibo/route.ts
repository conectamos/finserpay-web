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
const POS_WIDTH = 226.77;
const POS_LEFT = 12;
const POS_CONTENT_WIDTH = POS_WIDTH - POS_LEFT * 2;

const moneyFormatter = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

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

function dateTimeLabel(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateLabel(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("es-CO", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function cleanFilePart(value: string | null | undefined) {
  return String(value || "recibo")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function textValue(value: string | number | null | undefined) {
  const normalized = String(value ?? "").trim();
  return normalized || "-";
}

function shortText(value: string | number | null | undefined, maxLength = 42) {
  const normalized = textValue(value).replace(/\s+/g, " ");
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
    : normalized;
}

function paymentMethodLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  const labels: Record<string, string> = {
    BANCOLOMBIA: "BANCOLOMBIA",
    EFECTIVO: "EFECTIVO",
    NEQUI: "NEQUI",
    WOMPI: "WOMPI",
  };

  return labels[normalized] || textValue(value).toUpperCase();
}

function drawCentered(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  y: number,
  text: string,
  options: {
    bold?: boolean;
    size?: number;
    color?: string;
    gap?: number;
  } = {}
) {
  doc
    .fillColor(options.color || "#111111")
    .font(options.bold ? fonts.bold : fonts.regular)
    .fontSize(options.size || 8.5)
    .text(text, POS_LEFT, y, {
      width: POS_CONTENT_WIDTH,
      align: "center",
    });

  return doc.y + (options.gap ?? 2);
}

function drawRule(doc: PDFKit.PDFDocument, y: number) {
  doc
    .moveTo(POS_LEFT, y)
    .lineTo(POS_LEFT + POS_CONTENT_WIDTH, y)
    .dash(2, { space: 2 })
    .lineWidth(0.6)
    .strokeColor("#111111")
    .stroke()
    .undash();

  return y + 8;
}

function drawKeyValue(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  y: number,
  label: string,
  value: string,
  options: {
    boldValue?: boolean;
    size?: number;
  } = {}
) {
  const fontSize = options.size || 7.5;
  const startY = y;

  doc
    .fillColor("#111111")
    .font(fonts.regular)
    .fontSize(fontSize)
    .text(label.toUpperCase(), POS_LEFT, y, { width: 82 });
  const leftY = doc.y;

  doc
    .font(options.boldValue ? fonts.bold : fonts.regular)
    .fontSize(fontSize)
    .text(value, POS_LEFT + 86, y, {
      width: POS_CONTENT_WIDTH - 86,
      align: "right",
    });
  const rightY = doc.y;

  return Math.max(leftY, rightY, startY + fontSize + 2) + 2;
}

function drawAmountLine(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  y: number,
  label: string,
  value: string
) {
  const startY = y;

  doc
    .fillColor("#111111")
    .font(fonts.bold)
    .fontSize(8.5)
    .text(label.toUpperCase(), POS_LEFT, y, { width: 102 });
  const leftY = doc.y;

  doc.font(fonts.bold).fontSize(9.2).text(value, POS_LEFT + 106, y, {
    width: POS_CONTENT_WIDTH - 106,
    align: "right",
  });
  const rightY = doc.y;

  return Math.max(leftY, rightY, startY + 12) + 2;
}

function drawInstallmentLine(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  y: number,
  quota: string,
  date: string,
  value: string,
  bold = false
) {
  const startY = y;
  const font = bold ? fonts.bold : fonts.regular;

  doc.fillColor("#111111").font(font).fontSize(7.3).text(quota, POS_LEFT, y, {
    width: 42,
  });
  const quotaY = doc.y;

  doc.font(font).fontSize(7.3).text(date, POS_LEFT + 44, y, {
    width: 68,
  });
  const dateY = doc.y;

  doc.font(font).fontSize(7.3).text(value, POS_LEFT + 112, y, {
    width: POS_CONTENT_WIDTH - 112,
    align: "right",
  });
  const valueY = doc.y;

  return Math.max(quotaY, dateY, valueY, startY + 9) + 3;
}

function buildPlan(
  credito: {
    montoCredito: number | string;
    valorCuota: number | string;
    plazoMeses: number | null;
    frecuenciaPago: string | null;
    fechaPrimerPago: Date | null;
    fechaProximoPago: Date | null;
  },
  abonos: Array<{ valor: number | string; fechaAbono: Date }>
) {
  return buildCreditPaymentPlan({
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
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string; abonoId: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    await ensureCreditAbonoAuditColumns();

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede imprimir recibos" },
        { status: 403 }
      );
    }

    const params = await context.params;
    const creditId = parseId(params.id);
    const abonoId = parseId(params.abonoId);

    if (!creditId || !abonoId) {
      return NextResponse.json({ error: "Recibo invalido" }, { status: 400 });
    }

    const abono = await prisma.creditoAbono.findFirst({
      where: admin
        ? {
            id: abonoId,
            creditoId: creditId,
          }
        : {
            id: abonoId,
            creditoId: creditId,
            sedeId: user.sedeId,
          },
      include: {
        credito: {
          include: {
            sede: {
              select: {
                nombre: true,
              },
            },
          },
        },
        usuario: {
          select: {
            nombre: true,
            usuario: true,
          },
        },
        vendedor: {
          select: {
            nombre: true,
            documento: true,
          },
        },
        sede: {
          select: {
            nombre: true,
          },
        },
      },
    });

    if (!abono) {
      return NextResponse.json({ error: "Abono no encontrado" }, { status: 404 });
    }

    const activeAbonos = await prisma.creditoAbono.findMany({
      where: {
        creditoId: creditId,
        estado: {
          not: "ANULADO",
        },
      },
      select: {
        id: true,
        valor: true,
        fechaAbono: true,
      },
      orderBy: [
        {
          fechaAbono: "asc",
        },
        {
          id: "asc",
        },
      ],
    });

    const abonoTime = abono.fechaAbono.getTime();
    const activeUntilThisPayment = activeAbonos.filter((item) => {
      const itemTime = item.fechaAbono.getTime();
      return itemTime < abonoTime || (itemTime === abonoTime && item.id <= abono.id);
    });
    const currentPlan = buildPlan(abono.credito, activeUntilThisPayment);
    const isAnnulled = String(abono.estado || "").toUpperCase() === "ANULADO";
    const reciboNumero = `RP-${abono.credito.folio}-${abono.id}`;
    const equipo =
      abono.credito.referenciaEquipo ||
      [abono.credito.equipoMarca, abono.credito.equipoModelo].filter(Boolean).join(" ") ||
      abono.credito.imei;
    const recibidoPor =
      abono.vendedor?.nombre ||
      abono.usuario.nombre ||
      abono.usuario.usuario;
    const totalInstallments = Math.max(1, Math.trunc(Number(abono.credito.plazoMeses || 1)));
    const nextInstallments = currentPlan.installments
      .filter((item) => item.saldoPendiente > 0)
      .slice(0, 6);
    const fonts = getPdfFonts();
    const pageHeight = Math.max(690, 610 + nextInstallments.length * 15 + (isAnnulled ? 56 : 0));
    const doc = new PDFDocument({
      size: [POS_WIDTH, pageHeight],
      margin: 0,
      compress: true,
      font: fonts.regular,
      info: {
        Title: `Recibo de pago ${reciboNumero}`,
        Author: "FINSER PAY",
      },
    });
    const bufferPromise = toBuffer(doc);
    let y = 14;

    y = drawCentered(doc, fonts, y, "FINSER PAY", { bold: true, size: 13, gap: 1 });
    y = drawCentered(doc, fonts, y, "Innovacion financiera con confianza", {
      size: 7.2,
      gap: 7,
    });
    y = drawCentered(doc, fonts, y, "SISTEMA P.O.S", { bold: true, size: 8, gap: 1 });
    y = drawCentered(doc, fonts, y, "RECIBO DE ABONO", { bold: true, size: 10, gap: 6 });

    if (isAnnulled) {
      doc
        .rect(POS_LEFT, y, POS_CONTENT_WIDTH, 18)
        .fillAndStroke("#111111", "#111111");
      doc
        .fillColor("#FFFFFF")
        .font(fonts.bold)
        .fontSize(9)
        .text("RECIBO ANULADO", POS_LEFT, y + 5, {
          width: POS_CONTENT_WIDTH,
          align: "center",
        });
      y += 26;
    }

    y = drawRule(doc, y);
    y = drawKeyValue(doc, fonts, y, "Recibo No.", reciboNumero, { boldValue: true });
    y = drawKeyValue(doc, fonts, y, "Fecha abono", dateTimeLabel(abono.fechaAbono));
    y = drawKeyValue(doc, fonts, y, "Fecha impresion", dateTimeLabel(new Date()));
    y = drawKeyValue(doc, fonts, y, "Sede", shortText(abono.sede.nombre, 34));
    y = drawKeyValue(doc, fonts, y, "Cajero", shortText(recibidoPor, 34));

    y = drawRule(doc, y + 3);
    y = drawCentered(doc, fonts, y, "DATOS DEL CLIENTE", { bold: true, size: 8, gap: 4 });
    y = drawKeyValue(doc, fonts, y, "Cliente", shortText(abono.credito.clienteNombre, 38), {
      boldValue: true,
    });
    y = drawKeyValue(doc, fonts, y, "Documento", textValue(abono.credito.clienteDocumento));
    y = drawKeyValue(doc, fonts, y, "Telefono", textValue(abono.credito.clienteTelefono));
    y = drawKeyValue(doc, fonts, y, "Folio", shortText(abono.credito.folio, 34));
    y = drawKeyValue(doc, fonts, y, "Equipo", shortText(equipo, 36));
    y = drawKeyValue(doc, fonts, y, "IMEI", shortText(abono.credito.imei, 22));

    y = drawRule(doc, y + 3);
    y = drawCentered(doc, fonts, y, "APLICACION DEL ABONO", {
      bold: true,
      size: 8,
      gap: 4,
    });
    y = drawKeyValue(doc, fonts, y, "No. credito", shortText(abono.credito.folio, 34), {
      boldValue: true,
    });
    y = drawKeyValue(doc, fonts, y, "Metodo", paymentMethodLabel(abono.metodoPago));
    y = drawKeyValue(
      doc,
      fonts,
      y,
      "Frecuencia",
      getPaymentFrequencyLabel(abono.credito.frecuenciaPago).toUpperCase()
    );
    y = drawKeyValue(
      doc,
      fonts,
      y,
      "Cuotas pagas",
      `${currentPlan.paidCount} DE ${abono.credito.plazoMeses || 1}`
    );
    y = drawAmountLine(doc, fonts, y + 4, "Abono realizado", money(Number(abono.valor || 0)));

    if (nextInstallments.length) {
      y = drawRule(doc, y + 3);
      y = drawCentered(doc, fonts, y, "PROXIMAS SIGUIENTES 6 CUOTAS", {
        bold: true,
        size: 8,
        gap: 5,
      });
      y = drawInstallmentLine(doc, fonts, y, "Cuota", "Fecha", "Valor", true);

      nextInstallments.forEach((item) => {
        y = drawInstallmentLine(
          doc,
          fonts,
          y,
          `${item.numero}/${totalInstallments}`,
          dateLabel(item.fechaVencimiento),
          money(item.saldoPendiente)
        );
      });
    }

    y = drawRule(doc, y + 5);
    y = drawCentered(doc, fonts, y, "OBSERVACION", { bold: true, size: 8, gap: 4 });
    doc
      .fillColor("#111111")
      .font(fonts.regular)
      .fontSize(7.5)
      .text(shortText(abono.observacion, 170), POS_LEFT, y, {
        width: POS_CONTENT_WIDTH,
        align: "center",
      });
    y = doc.y + 8;

    if (isAnnulled) {
      y = drawRule(doc, y);
      y = drawCentered(doc, fonts, y, "DETALLE DE ANULACION", { bold: true, size: 8, gap: 4 });
      y = drawKeyValue(doc, fonts, y, "Fecha", dateTimeLabel(abono.anuladoAt));
      y = drawKeyValue(doc, fonts, y, "Motivo", shortText(abono.anulacionMotivo, 55));
    }

    y = drawRule(doc, y + 4);
    y = drawCentered(doc, fonts, y, "Este recibo soporta el abono registrado.", {
      size: 7,
      gap: 1,
    });
    y = drawCentered(doc, fonts, y, "No constituye paz y salvo.", { size: 7, gap: 6 });
    y = drawCentered(doc, fonts, y, "Gracias por tu pago.", { bold: true, size: 8.5, gap: 4 });
    drawCentered(doc, fonts, y, "www.finserpay.com/clientes", { size: 7.5 });

    doc.end();

    const buffer = await bufferPromise;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="recibo-pos-abono-${cleanFilePart(
          abono.credito.folio
        )}-${abono.id}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO RECIBO DE ABONO:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el recibo" },
      { status: 500 }
    );
  }
}
