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
    dateStyle: "medium",
    timeStyle: "short",
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

function paymentMethodLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  const labels: Record<string, string> = {
    BANCOLOMBIA: "Bancolombia",
    EFECTIVO: "Efectivo",
    NEQUI: "Nequi",
    WOMPI: "Wompi",
  };

  return labels[normalized] || textValue(value);
}

function drawInfoBox(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string },
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  accent = "#0F172A"
) {
  doc.save().roundedRect(x, y, width, 58, 14).fillAndStroke("#FFFFFF", "#DDE7EC").restore();
  doc
    .fillColor("#64748B")
    .font(fonts.bold)
    .fontSize(8)
    .text(label.toUpperCase(), x + 14, y + 13, { width: width - 28 });
  doc
    .fillColor(accent)
    .font(fonts.bold)
    .fontSize(13)
    .text(value, x + 14, y + 31, { width: width - 28 });
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
    const currentPlan = buildCreditPaymentPlan({
      montoCredito: Number(abono.credito.montoCredito || 0),
      valorCuota: Number(abono.credito.valorCuota || 0),
      plazoMeses: Number(abono.credito.plazoMeses || 1),
      frecuenciaPago: abono.credito.frecuenciaPago,
      fechaPrimerPago: abono.credito.fechaPrimerPago || abono.credito.fechaProximoPago,
      abonos: activeUntilThisPayment.map((item) => ({
        valor: Number(item.valor || 0),
        fechaAbono: item.fechaAbono,
      })),
    });
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
    const fonts = getPdfFonts();
    const doc = new PDFDocument({
      size: "A4",
      margin: 36,
      compress: true,
      font: fonts.regular,
      info: {
        Title: `Recibo de pago ${reciboNumero}`,
        Author: "FINSER PAY",
      },
    });
    const bufferPromise = toBuffer(doc);

    doc.save().roundedRect(36, 36, 523, 132, 18).fill("#F8FAFC").restore();
    doc.save().roundedRect(36, 36, 8, 132, 4).fill(isAnnulled ? "#DC2626" : "#0F766E").restore();
    doc.fillColor("#0F766E").font(fonts.bold).fontSize(10).text("FINSER PAY", 58, 55);
    doc.fillColor("#0F172A").font(fonts.bold).fontSize(25).text("Recibo de pago", 58, 75);
    doc
      .fillColor("#475569")
      .font(fonts.regular)
      .fontSize(10.5)
      .text(
        `Recibo: ${reciboNumero}\nFolio credito: ${abono.credito.folio}\nSede: ${abono.sede.nombre}\nGenerado: ${dateTimeLabel(new Date())}`,
        58,
        109,
        { width: 320 }
      );
    doc
      .fillColor(isAnnulled ? "#B91C1C" : "#047857")
      .font(fonts.bold)
      .fontSize(12)
      .text(isAnnulled ? "ANULADO" : "ABONO RECIBIDO", 400, 62, {
        width: 120,
        align: "right",
      });
    doc
      .fillColor("#0F172A")
      .font(fonts.bold)
      .fontSize(21)
      .text(money(Number(abono.valor || 0)), 382, 86, {
        width: 150,
        align: "right",
      });
    doc
      .fillColor("#64748B")
      .font(fonts.regular)
      .fontSize(9)
      .text("Valor recibido", 400, 113, { width: 120, align: "right" });

    if (isAnnulled) {
      doc
        .save()
        .rotate(-18, { origin: [298, 390] })
        .fillColor("#FCA5A5")
        .opacity(0.22)
        .font(fonts.bold)
        .fontSize(72)
        .text("ANULADO", 126, 360, { width: 350, align: "center" })
        .restore();
    }

    drawInfoBox(doc, fonts, 36, 194, 248, "Cliente", textValue(abono.credito.clienteNombre));
    drawInfoBox(doc, fonts, 304, 194, 255, "Documento", textValue(abono.credito.clienteDocumento));
    drawInfoBox(doc, fonts, 36, 268, 248, "Telefono", textValue(abono.credito.clienteTelefono));
    drawInfoBox(doc, fonts, 304, 268, 255, "Equipo", textValue(equipo));
    drawInfoBox(doc, fonts, 36, 342, 248, "IMEI", textValue(abono.credito.imei));
    drawInfoBox(doc, fonts, 304, 342, 255, "Metodo de pago", paymentMethodLabel(abono.metodoPago));
    drawInfoBox(doc, fonts, 36, 416, 248, "Fecha del abono", dateTimeLabel(abono.fechaAbono));
    drawInfoBox(doc, fonts, 304, 416, 255, "Recibido por", textValue(recibidoPor));
    drawInfoBox(
      doc,
      fonts,
      36,
      490,
      248,
      "Total abonado a esta fecha",
      isAnnulled ? "No aplica" : money(currentPlan.totalPaid),
      isAnnulled ? "#B91C1C" : "#0F172A"
    );
    drawInfoBox(
      doc,
      fonts,
      304,
      490,
      255,
      "Saldo posterior del credito",
      isAnnulled ? "No aplica" : money(currentPlan.saldoPendiente),
      isAnnulled ? "#B91C1C" : "#0F172A"
    );

    doc
      .save()
      .roundedRect(36, 580, 523, isAnnulled ? 112 : 82, 16)
      .fillAndStroke("#FFFFFF", "#DDE7EC")
      .restore();
    doc
      .fillColor("#64748B")
      .font(fonts.bold)
      .fontSize(8)
      .text("OBSERVACION", 52, 598);
    doc
      .fillColor("#0F172A")
      .font(fonts.regular)
      .fontSize(10)
      .text(textValue(abono.observacion), 52, 616, { width: 491, height: 38 });

    if (isAnnulled) {
      doc
        .fillColor("#B91C1C")
        .font(fonts.bold)
        .fontSize(9)
        .text("Detalle de anulacion", 52, 654);
      doc
        .fillColor("#475569")
        .font(fonts.regular)
        .fontSize(9.5)
        .text(
          `Fecha: ${dateTimeLabel(abono.anuladoAt)}\nMotivo: ${textValue(abono.anulacionMotivo)}`,
          52,
          670,
          { width: 491 }
        );
    }

    const footerY = isAnnulled ? 726 : 704;
    doc
      .fillColor("#64748B")
      .font(fonts.regular)
      .fontSize(9)
      .text(
        `Frecuencia del credito: ${getPaymentFrequencyLabel(
          abono.credito.frecuenciaPago
        )}. Este recibo soporta el abono registrado en FINSER PAY y no constituye paz y salvo.`,
        36,
        footerY,
        { width: 523, align: "center" }
      );
    doc
      .fillColor("#94A3B8")
      .font(fonts.regular)
      .fontSize(8)
      .text("Documento generado automaticamente por FINSER PAY.", 36, footerY + 34, {
        width: 523,
        align: "center",
      });

    doc.end();

    const buffer = await bufferPromise;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="recibo-abono-${cleanFilePart(
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
