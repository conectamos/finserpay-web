import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import prisma from "@/lib/prisma";
import { isAdminRole } from "@/lib/roles";

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

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const admin = isAdminRole(user.rolNombre);
    const sellerSession = admin ? null : await getSellerSessionUser(user);

    if (!admin && sellerSession?.tipoPerfil !== "SUPERVISOR") {
      return NextResponse.json(
        { error: "Solo supervisor o administrador puede descargar paz y salvo" },
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
        usuario: {
          select: {
            nombre: true,
            usuario: true,
          },
        },
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

    await prisma.credito.update({
      where: { id: credito.id },
      data: {
        pazYSalvoEmitidoAt: new Date(),
      },
    });

    const fonts = getPdfFonts();
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      compress: true,
      font: fonts.regular,
      info: {
        Title: `Paz y salvo ${credito.folio}`,
        Author: "FINSER PAY",
      },
    });
    const bufferPromise = toBuffer(doc);

    doc.save().roundedRect(40, 40, 515, 130, 22).fill("#FFF7ED").restore();
    doc.save().roundedRect(40, 40, 8, 130, 4).fill("#B45309").restore();
    doc.fillColor("#9A3412").font(fonts.bold).fontSize(11).text("CERTIFICADO", 64, 58);
    doc.fillColor("#0F172A").font(fonts.bold).fontSize(27).text("Paz y salvo", 64, 76);
    doc
      .fillColor("#475569")
      .font(fonts.regular)
      .fontSize(11)
      .text(
        `Folio: ${credito.folio}\nCliente: ${credito.clienteNombre}\nDocumento: ${
          credito.clienteDocumento || "-"
        }\nEquipo: ${credito.referenciaEquipo || credito.imei}`,
        64,
        112
      );

    doc
      .fillColor("#0F172A")
      .font(fonts.regular)
      .fontSize(12)
      .text(
        "FINSER PAY certifica que el credito referenciado cuenta con paz y salvo emitido desde el portal administrativo.",
        40,
        210,
        { width: 515, align: "justify" }
      );

    const rows = [
      ["Referencia de pago", credito.referenciaPago || "-"],
      ["IMEI / Device UID", `${credito.imei} / ${credito.deviceUid}`],
      ["Estado actual", credito.estado],
      ["Entregabilidad", credito.deliverableLabel || "Sin verificacion"],
      ["Sede", credito.sede.nombre],
      ["Emitido por", `${user.nombre} (${user.usuario})`],
      ["Emitido el", new Date().toLocaleString("es-CO")],
    ];

    let y = 280;
    for (const [label, value] of rows) {
      doc.save().roundedRect(40, y, 515, 38, 12).fillAndStroke("#FFFFFF", "#E2E8F0").restore();
      doc.fillColor("#64748B").font(fonts.bold).fontSize(9).text(label, 56, y + 12);
      doc.fillColor("#0F172A").font(fonts.regular).fontSize(10.5).text(value, 210, y + 12, {
        width: 320,
        align: "right",
      });
      y += 48;
    }

    doc
      .fillColor("#64748B")
      .font(fonts.regular)
      .fontSize(10)
      .text(
        "Documento generado desde la fabrica de creditos de FINSER PAY.",
        40,
        y + 18
      );

    doc.end();

    const buffer = await bufferPromise;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="paz-y-salvo-${credito.folio}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO PAZ Y SALVO:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el paz y salvo" },
      { status: 500 }
    );
  }
}
