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

export async function buildCreditPazYSalvoPdf(
  input: CreditPazYSalvoPdfInput
) {
  const fonts = getPdfFonts();
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

  doc.save().roundedRect(40, 40, 515, 130, 22).fill("#FFF7ED").restore();
  doc.save().roundedRect(40, 40, 8, 130, 4).fill("#B45309").restore();
  doc.fillColor("#9A3412").font(fonts.bold).fontSize(11).text("CERTIFICADO", 64, 58);
  doc.fillColor("#0F172A").font(fonts.bold).fontSize(27).text("Paz y salvo", 64, 76);
  doc
    .fillColor("#475569")
    .font(fonts.regular)
    .fontSize(11)
    .text(
      `Folio: ${input.folio}\nCliente: ${input.clienteNombre}\nDocumento: ${
        input.clienteDocumento || "-"
      }\nEquipo: ${input.equipo || input.imei || "-"}`,
      64,
      112
    );

  doc
    .fillColor("#0F172A")
    .font(fonts.regular)
    .fontSize(12)
    .text(
      "FINSER PAY certifica que el credito referenciado se encuentra pagado en su totalidad y no presenta saldo pendiente.",
      40,
      210,
      { width: 515, align: "justify" }
    );

  const rows = [
    ["Referencia de pago", input.referenciaPago || "-"],
    ["IMEI / Device UID", `${input.imei || "-"} / ${input.deviceUid || "-"}`],
    ["Estado actual", input.estado || "PAZ_Y_SALVO"],
    ["Entregabilidad", input.deliverableLabel || "Sin verificacion"],
    ["Sede", input.sedeNombre],
    ["Emitido por", input.issuer],
    [
      "Emitido el",
      input.issuedAt.toLocaleString("es-CO", {
        timeZone: "America/Bogota",
      }),
    ],
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
    .text("Documento generado por FINSER PAY.", 40, y + 18);

  doc.end();

  return bufferPromise;
}
