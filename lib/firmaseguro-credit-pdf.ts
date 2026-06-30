import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";

export type CreditForFirmaSeguroPdf = {
  folio: string;
  contratoSnapshot?: unknown;
  clienteTipoDocumento?: string | null;
  clienteNombre: string;
  clientePrimerNombre?: string | null;
  clientePrimerApellido?: string | null;
  clienteDocumento?: string | null;
  clienteTelefono?: string | null;
  clienteCorreo?: string | null;
  clienteDireccion?: string | null;
  referenciaEquipo?: string | null;
  equipoMarca?: string | null;
  equipoModelo?: string | null;
  imei?: string | null;
  deviceUid?: string | null;
  valorEquipoTotal?: number | null;
  montoCredito?: number | null;
  cuotaInicial?: number | null;
  valorCuota?: number | null;
  plazoMeses?: number | null;
  frecuenciaPago?: string | null;
  fechaCredito?: Date | string | null;
  fechaPrimerPago?: Date | string | null;
  referenciaPago?: string | null;
  valorFianza?: number | null;
  contratoIp?: string | null;
  contratoFotoDataUrl?: string | null;
  contratoSelfieDataUrl?: string | null;
  contratoCedulaFrenteDataUrl?: string | null;
  contratoCedulaRespaldoDataUrl?: string | null;
  usuario: {
    nombre: string;
    usuario?: string | null;
  };
  vendedor?: {
    nombre?: string | null;
    documento?: string | null;
    telefono?: string | null;
    email?: string | null;
  } | null;
  sede: {
    nombre: string;
    codigo?: string | null;
    aliadoId?: number | null;
  };
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

function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function getDateValue(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateOnly(value: Date | string | null | undefined) {
  const date = getDateValue(value);
  if (!date) {
    return "-";
  }

  return date.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formatTimeOnly(value: Date | string | null | undefined) {
  const date = getDateValue(value);
  if (!date) {
    return "-";
  }

  return date.toLocaleTimeString("es-CO", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function valueOrDash(value: string | number | null | undefined) {
  const cleaned = String(value ?? "").trim();
  return cleaned || "-";
}

function pageLeft(doc: PDFKit.PDFDocument) {
  return doc.page.margins.left;
}

function pageRight(doc: PDFKit.PDFDocument) {
  return doc.page.width - doc.page.margins.right;
}

function pageBottom(doc: PDFKit.PDFDocument) {
  return doc.page.height - doc.page.margins.bottom;
}

function contentWidth(doc: PDFKit.PDFDocument) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function resetFlow(doc: PDFKit.PDFDocument) {
  doc.x = pageLeft(doc);
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height <= pageBottom(doc)) {
    resetFlow(doc);
    return;
  }

  doc.addPage();
  resetFlow(doc);
}

function documentTitle(
  doc: PDFKit.PDFDocument,
  label: string,
  title: string,
  fonts: { regular: string; bold: string }
) {
  doc.addPage();
  const x = pageLeft(doc);
  const width = contentWidth(doc);
  const y = doc.page.margins.top;

  doc
    .font(fonts.bold)
    .fontSize(7)
    .fillColor("#111827")
    .text(label.toUpperCase(), x, y, { width });
  doc
    .font(fonts.bold)
    .fontSize(11)
    .fillColor("#0F172A")
    .text(title.toUpperCase(), x, y + 14, { width, lineGap: 1 });
  const lineY = doc.y + 5;
  doc
    .strokeColor("#CBD5E1")
    .lineWidth(1)
    .moveTo(x, lineY)
    .lineTo(pageRight(doc), lineY)
    .stroke();
  doc.y = lineY + 12;
  resetFlow(doc);
}

function bulletParagraph(
  doc: PDFKit.PDFDocument,
  items: string[],
  fonts: { regular: string; bold: string }
) {
  const x = pageLeft(doc);
  const width = contentWidth(doc);

  items.forEach((item) => {
    doc.font(fonts.regular).fontSize(8.1);
    const textWidth = width - 18;
    const height = doc.heightOfString(item, {
      width: textWidth,
      lineGap: 1,
    });

    ensureSpace(doc, Math.max(14, height) + 3);
    const y = doc.y;
    doc.font(fonts.bold).fontSize(8.1).fillColor("#111827").text("-", x, y, {
      width: 10,
    });
    doc
      .font(fonts.regular)
      .fontSize(8.1)
      .fillColor("#1F2937")
      .text(item, x + 18, y, {
        width: textWidth,
        lineGap: 1,
      });
    doc.y = y + Math.max(14, height) + 3;
    resetFlow(doc);
  });

  doc.moveDown(0.12);
  resetFlow(doc);
}

function dataUrlToImageBuffer(value: string | null | undefined) {
  const match = String(value || "").match(
    /^data:image\/(?:png|jpe?g);base64,([a-z0-9+/=\s]+)$/i
  );
  if (!match) {
    return null;
  }

  try {
    return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
}

function photoEvidenceBlock(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  fonts: { regular: string; bold: string }
) {
  const imageBuffer = dataUrlToImageBuffer(
    credito.contratoSelfieDataUrl || credito.contratoFotoDataUrl
  );
  const cedulaFrente = dataUrlToImageBuffer(credito.contratoCedulaFrenteDataUrl);
  const cedulaRespaldo = dataUrlToImageBuffer(
    credito.contratoCedulaRespaldoDataUrl
  );
  if (!imageBuffer && !cedulaFrente && !cedulaRespaldo) {
    return;
  }
  const boxHeight = 184;

  ensureSpace(doc, boxHeight + 12);
  const x = pageLeft(doc);
  const y = doc.y;
  const width = contentWidth(doc);
  doc
    .save()
    .roundedRect(x, y, width, boxHeight, 14)
    .fill("#F8FAFC")
    .restore();
  doc
    .font(fonts.bold)
    .fontSize(8)
    .fillColor("#64748B")
    .text("EVIDENCIA FOTOGRAFICA", x + 14, y + 12);

  const imageSlots = [
    { label: "Foto del titular", buffer: imageBuffer },
    { label: "Cedula frente", buffer: cedulaFrente },
    { label: "Cedula respaldo", buffer: cedulaRespaldo },
  ];
  const gap = 12;
  const slotWidth = (width - 28 - gap * 2) / 3;

  imageSlots.forEach((slot, index) => {
    const slotX = x + 14 + index * (slotWidth + gap);
    const slotY = y + 40;
    doc
      .save()
      .roundedRect(slotX, slotY, slotWidth, 112, 10)
      .fill("#FFFFFF")
      .strokeColor("#E2E8F0")
      .stroke()
      .restore();

    if (slot.buffer) {
      try {
        doc.image(slot.buffer, slotX + 8, slotY + 8, {
          fit: [slotWidth - 16, 92],
          align: "center",
          valign: "center",
        });
      } catch {
        doc
          .font(fonts.regular)
          .fontSize(8)
          .fillColor("#94A3B8")
          .text("Imagen no disponible", slotX + 10, slotY + 48, {
            width: slotWidth - 20,
            align: "center",
          });
      }
    } else {
      doc
        .font(fonts.regular)
        .fontSize(8)
        .fillColor("#94A3B8")
        .text("[ PENDIENTE ]", slotX + 10, slotY + 48, {
          width: slotWidth - 20,
          align: "center",
        });
    }

    doc
      .font(fonts.bold)
      .fontSize(7)
      .fillColor("#475569")
      .text(slot.label.toUpperCase(), slotX + 8, slotY + 124, {
        width: slotWidth - 16,
        align: "center",
      });
  });

  doc.y = y + boxHeight + 8;
  resetFlow(doc);
}

function addElectronicSignatureClause(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string }
) {
  sectionTitle(doc, "Clausula de firma electronica", fonts);
  paragraph(
    doc,
    "Las partes acuerdan que el presente documento podra ser suscrito mediante firma electronica certificada a traves del proveedor tecnologico autorizado utilizado por FINSER PAY S.A.S.",
    fonts
  );
  paragraph(
    doc,
    "El firmante reconoce que el mecanismo de autenticacion implementado permite identificar plenamente su identidad y manifestacion de voluntad, otorgando al documento plena validez juridica y fuerza probatoria de conformidad con la Ley 527 de 1999, el Decreto 2364 de 2012 y demas normas concordantes que regulan el comercio electronico y la firma electronica en Colombia.",
    fonts
  );
  paragraph(
    doc,
    "El titular acepta que los registros electronicos, certificados de firma, sellos de tiempo, evidencias de autenticacion, registros de auditoria y demas soportes generados durante el proceso de firma constituyen prueba suficiente de su aceptacion y consentimiento.",
    fonts
  );
}

function sectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  fonts: { regular: string; bold: string }
) {
  ensureSpace(doc, 24);
  resetFlow(doc);
  doc.moveDown(0.18);
  doc
    .font(fonts.bold)
    .fontSize(8.7)
    .fillColor("#111827")
    .text(title.toUpperCase(), pageLeft(doc), doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.18);
  doc
    .strokeColor("#CBD5E1")
    .lineWidth(1)
    .moveTo(pageLeft(doc), doc.y)
    .lineTo(pageRight(doc), doc.y)
    .stroke();
  doc.moveDown(0.25);
  resetFlow(doc);
}

function paragraph(
  doc: PDFKit.PDFDocument,
  text: string,
  fonts: { regular: string; bold: string }
) {
  const width = contentWidth(doc);
  const x = pageLeft(doc);
  doc
    .font(fonts.regular)
    .fontSize(8.4)
    .fillColor("#1F2937");
  const height = doc.heightOfString(text, {
    width,
    align: "justify",
    lineGap: 1,
  });

  ensureSpace(doc, Math.min(Math.max(height + 6, 24), pageBottom(doc) - doc.page.margins.top));
  doc
    .font(fonts.regular)
    .fontSize(8.4)
    .fillColor("#1F2937")
    .text(text, x, doc.y, {
      width,
      align: "justify",
      lineGap: 1,
    });
  doc.moveDown(0.16);
  resetFlow(doc);
}

function keyValueGrid(
  doc: PDFKit.PDFDocument,
  items: Array<{ label: string; value: string }>,
  fonts: { regular: string; bold: string }
) {
  const x = pageLeft(doc);
  const width = contentWidth(doc);
  const labelWidth = 120;
  const valueWidth = width - labelWidth;

  items.forEach((item, index) => {
    const value = item.value || "-";
    doc.font(fonts.bold).fontSize(6.8);
    const labelHeight = doc.heightOfString(item.label.toUpperCase(), {
      width: labelWidth - 18,
      lineGap: 1,
    });
    doc.font(fonts.regular).fontSize(8.2);
    const valueHeight = doc.heightOfString(value, {
      width: valueWidth - 18,
      lineGap: 1,
    });
    const rowHeight = Math.max(23, Math.ceil(Math.max(labelHeight, valueHeight) + 9));

    ensureSpace(doc, rowHeight + 2);
    const y = doc.y;
    doc
      .save()
      .rect(x, y, width, rowHeight)
      .fill(index % 2 === 0 ? "#FFFFFF" : "#F8FAFC")
      .restore();
    doc.save().rect(x, y, labelWidth, rowHeight).fill("#F1F5F9").restore();
    doc
      .strokeColor("#E2E8F0")
      .lineWidth(0.7)
      .rect(x, y, width, rowHeight)
      .stroke();
    doc
      .strokeColor("#E2E8F0")
      .moveTo(x + labelWidth, y)
      .lineTo(x + labelWidth, y + rowHeight)
      .stroke();

    doc
      .font(fonts.bold)
      .fontSize(6.8)
      .fillColor("#64748B")
      .text(item.label.toUpperCase(), x + 8, y + 7, {
        width: labelWidth - 18,
        lineGap: 1,
      });
    doc
      .font(fonts.bold)
      .fontSize(8.2)
      .fillColor("#0F172A")
      .text(value, x + labelWidth + 8, y + 7, {
        width: valueWidth - 18,
        lineGap: 1,
      });

    doc.y = y + rowHeight;
    resetFlow(doc);
  });

  doc.moveDown(0.28);
  resetFlow(doc);
}

function legalHeader(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  fecha: string,
  fonts: { regular: string; bold: string }
) {
  const x = pageLeft(doc);
  const width = contentWidth(doc);
  const tipoDocumento = (credito.clienteTipoDocumento || "CC").replace(/_/g, " ");
  const rows = [
    ["Nombre", credito.clienteNombre],
    ["Fecha", fecha],
    ["Direccion", credito.clienteDireccion || "-"],
    ["Cedula", credito.clienteDocumento || "-"],
    ["Correo", credito.clienteCorreo || "-"],
    ["Telefono", credito.clienteTelefono || "-"],
  ];

  doc
    .font(fonts.bold)
    .fontSize(12)
    .fillColor("#111827")
    .text("FINSER PAY S.A.S", x, doc.y, { width, align: "center" });
  doc
    .font(fonts.bold)
    .fontSize(10)
    .text("NIT. 902.052.909-4", x, doc.y + 4, { width, align: "center" });
  doc.moveDown(1.2);

  rows.forEach(([label, value]) => {
    const y = doc.y;
    doc.font(fonts.bold).fontSize(9.2).fillColor("#111827").text(`${label}:`, x, y, {
      width: 72,
    });
    doc.font(fonts.regular).fontSize(9.2).fillColor("#111827").text(String(value || "-"), x + 78, y, {
      width: width - 78,
      lineGap: 1,
    });
    doc.y = Math.max(doc.y, y + 14);
  });

  doc.moveDown(0.6);
  doc
    .strokeColor("#111827")
    .lineWidth(0.7)
    .moveTo(x, doc.y)
    .lineTo(pageRight(doc), doc.y)
    .stroke();
  doc.moveDown(0.6);
  doc
    .font(fonts.regular)
    .fontSize(7.4)
    .fillColor("#475569")
    .text(`Tipo documento: ${tipoDocumento}`, x, doc.y, { width, align: "right" });
  doc.moveDown(0.4);
  resetFlow(doc);
}

function signatureBlock(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  fonts: { regular: string; bold: string }
) {
  const x = pageLeft(doc);
  const width = contentWidth(doc);
  const paddingX = 14;
  const paddingY = 13;
  const innerWidth = width - paddingX * 2;
  const certifiedText = "Firma electronica certificada por FirmaSeguro";
  const detailText = value.includes("Firma:")
    ? value
    : `Firma: ${certifiedText}\n${value}`;
  const detailHeight = doc.heightOfString(detailText, {
    width: innerWidth,
    lineGap: 1,
  });
  const boxHeight = Math.max(92, Math.ceil(detailHeight + 76));

  ensureSpace(doc, boxHeight + 10);
  doc.moveDown(0.4);

  const y = doc.y;
  doc
    .save()
    .roundedRect(x, y, width, boxHeight, 10)
    .lineWidth(0.9)
    .strokeColor("#CBD5E1")
    .stroke()
    .restore();

  doc
    .font(fonts.bold)
    .fontSize(7.8)
    .fillColor("#64748B")
    .text(label.toUpperCase(), x + paddingX, y + paddingY, { width: innerWidth });

  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor("#008578")
    .text(certifiedText, x + paddingX, y + paddingY + 24, { width: innerWidth });

  const lineY = y + paddingY + 50;
  doc
    .moveTo(x + paddingX, lineY)
    .lineTo(x + width - paddingX, lineY)
    .lineWidth(0.8)
    .strokeColor("#94A3B8")
    .stroke();

  doc
    .font(fonts.regular)
    .fontSize(7.7)
    .fillColor("#334155")
    .text(detailText, x + paddingX, lineY + 12, {
      width: innerWidth,
      lineGap: 1,
    });

  doc.y = y + boxHeight + 8;
  resetFlow(doc);
}

function getSnapshotRecord(snapshot: unknown, key: string) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }

  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function afianzamosHeader(
  doc: PDFKit.PDFDocument,
  fonts: { regular: string; bold: string }
) {
  const top = Math.max(doc.y, doc.page.margins.top);
  doc
    .font(fonts.bold)
    .fontSize(6.2)
    .fillColor("#111827")
    .text(
      "ANEXO 1: ACEPTACION DE LA GARANTIA Y\nAUTORIZACIONES\nFONDO DE GARANTIAS - AFIANZAMOS FINTECH\nS.A.S.",
      pageLeft(doc),
      top,
      { width: 220, lineGap: 0.4 }
    );

  doc
    .font(fonts.bold)
    .fontSize(24)
    .fillColor("#7E22CE")
    .text("Afianzamos", pageRight(doc) - 180, top - 8, {
      width: 180,
      align: "right",
    });
  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor("#F97316")
    .text("FONDO DE GARANTIAS", pageRight(doc) - 180, top + 24, {
      width: 180,
      align: "right",
    });
  doc.y = top + 62;
  resetFlow(doc);
}

function afianzamosSectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  fonts: { regular: string; bold: string }
) {
  ensureSpace(doc, 18);
  doc
    .font(fonts.bold)
    .fontSize(8.6)
    .fillColor("#111827")
    .text(title, pageLeft(doc), doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.14);
  resetFlow(doc);
}

function afianzamosParagraph(
  doc: PDFKit.PDFDocument,
  text: string,
  fonts: { regular: string; bold: string }
) {
  const width = contentWidth(doc);
  doc.font(fonts.regular).fontSize(8.6);
  const height = doc.heightOfString(text, {
    width,
    align: "justify",
    lineGap: 1,
  });
  ensureSpace(doc, Math.min(height + 8, pageBottom(doc) - doc.page.margins.top));
  doc
    .font(fonts.regular)
    .fontSize(8.6)
    .fillColor("#111827")
    .text(text, pageLeft(doc), doc.y, {
      width,
      align: "justify",
      lineGap: 1,
    });
  doc.moveDown(0.18);
  resetFlow(doc);
}

function afianzamosIndentedItems(
  doc: PDFKit.PDFDocument,
  items: string[],
  fonts: { regular: string; bold: string },
  options: { numbered?: boolean; lettered?: boolean; startIndex?: number } = {}
) {
  const left = pageLeft(doc);
  const textX = left + 26;
  const width = contentWidth(doc) - 26;

  items.forEach((item, index) => {
    const itemIndex = index + (options.startIndex || 0);
    const marker = options.numbered
      ? `${itemIndex + 1}.`
      : options.lettered
      ? `${String.fromCharCode(97 + itemIndex)})`
      : "-";
    doc.font(fonts.regular).fontSize(8.1);
    const height = doc.heightOfString(item, {
      width,
      align: "justify",
      lineGap: 1,
    });
    ensureSpace(doc, Math.max(14, height) + 3);
    const y = doc.y;
    doc
      .font(fonts.regular)
      .fontSize(8.1)
      .fillColor("#111827")
      .text(marker, left + 8, y, { width: 18 });
    doc
      .font(options.lettered ? fonts.bold : fonts.regular)
      .fontSize(8.1)
      .fillColor("#111827")
      .text(item, textX, y, {
        width,
        align: "justify",
        lineGap: 1,
      });
    doc.y = y + Math.max(14, height) + 3;
    resetFlow(doc);
  });
  doc.moveDown(0.15);
  resetFlow(doc);
}

function afianzamosLineSignature(
  doc: PDFKit.PDFDocument,
  role: string,
  fonts: { regular: string; bold: string },
  values?: { nombre?: string; documento?: string; fechaHora?: string }
) {
  const left = pageLeft(doc);
  const lineX = left + 54;
  const lineWidth = 235;
  ensureSpace(doc, 72);
  doc
    .font(fonts.bold)
    .fontSize(8.5)
    .fillColor("#111827")
    .text(role, left, doc.y, { width: contentWidth(doc) });
  doc.moveDown(0.8);

  [
    { label: "Nombre:", value: values?.nombre || "" },
    { label: "C.C. No:", value: values?.documento || "" },
    { label: "Fecha y Hora:", value: values?.fechaHora || "" },
  ].forEach((row) => {
    const y = doc.y;
    doc.font(fonts.regular).fontSize(8.5).fillColor("#111827").text(row.label, left, y, {
      width: 58,
    });
    doc
      .moveTo(lineX, y + 10)
      .lineTo(lineX + lineWidth, y + 10)
      .lineWidth(0.8)
      .strokeColor("#111827")
      .stroke();
    if (row.value) {
      doc
        .font(fonts.regular)
        .fontSize(8.3)
        .fillColor("#111827")
        .text(row.value, lineX + 3, y - 1, { width: lineWidth - 6 });
    }
    doc.y = y + 14;
    resetFlow(doc);
  });
  doc.moveDown(0.8);
  resetFlow(doc);
}

function getPagareNumber(credito: CreditForFirmaSeguroPdf) {
  const pagare = getSnapshotRecord(credito.contratoSnapshot, "pagare");
  const numero = pagare?.numero;
  return typeof numero === "string" && numero.trim() ? numero.trim() : credito.folio;
}

export async function buildFirmaSeguroCreditPdf(credito: CreditForFirmaSeguroPdf) {
  const fonts = getPdfFonts();
  const doc = new PDFDocument({
    size: "A4",
    margin: 46,
    compress: true,
    font: fonts.regular,
    info: {
      Title: `Paquete documental FINSER PAY ${credito.folio}`,
      Author: "FINSER PAY",
    },
  });
  const bufferPromise = toBuffer(doc);
  const pagareNumero = getPagareNumber(credito);
  const fechaCredito = credito.fechaCredito || new Date();
  const fecha = formatDateOnly(fechaCredito);
  const hora = formatTimeOnly(fechaCredito);
  const equipo =
    credito.referenciaEquipo ||
    `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`.trim() ||
    "-";
  const marca = valueOrDash(credito.equipoMarca || equipo.split(" ")[0]);
  const modelo = valueOrDash(credito.equipoModelo || equipo);
  const saldoFinanciado = credito.montoCredito || 0;
  const firmaFechaHora = `${fecha} ${hora}`;

  legalHeader(doc, credito, fecha, fonts);
  doc
    .font(fonts.bold)
    .fontSize(12.5)
    .fillColor("#111827")
    .text("AUTORIZACION PARA EL TRATAMIENTO DE DATOS PERSONALES", pageLeft(doc), doc.y, {
      width: contentWidth(doc),
      align: "center",
    });
  doc.moveDown(0.8);

  paragraph(
    doc,
    "FINSER PAY S.A.S. - NIT 902052909-4 - Ibague, Tolima.",
    fonts
  );
  paragraph(
    doc,
    "Actuando en nombre propio, autorizo de manera libre, previa, expresa, informada e inequivoca a FINSER PAY S.A.S., identificada con NIT 902052909-4, para recolectar, almacenar, consultar, procesar, actualizar, transmitir, transferir y utilizar mis datos personales para las finalidades descritas en el presente documento.",
    fonts
  );
  sectionTitle(doc, "Finalidades del tratamiento", fonts);
  bulletParagraph(
    doc,
    [
      "Estudio y otorgamiento de credito: validar identidad, analizar capacidad de pago, verificar informacion suministrada y evaluar solicitudes de financiacion.",
      "Gestion contractual y de cartera: celebrar contratos, administrar obligaciones vigentes, gestionar pagos, recaudos, cartera y actividades de cobranza preventiva, administrativa, prejuridica y juridica.",
      "Consulta y reporte a centrales de riesgo: consultar, reportar, actualizar, rectificar y compartir informacion financiera, crediticia, comercial y de servicios ante operadores autorizados por la ley.",
      "Prevencion del fraude, evidencia digital y cumplimiento legal: verificar documentos, validar identidad, conservar firma electronica, fotografias y soportes, y atender requerimientos de autoridades.",
      "Contacto comercial: informar sobre productos, servicios, promociones, campanas y beneficios ofrecidos por FINSER PAY S.A.S. o sus aliados comerciales.",
    ],
    fonts
  );
  sectionTitle(doc, "Datos objeto de tratamiento", fonts);
  paragraph(
    doc,
    "La presente autorizacion comprende datos de identificacion, contacto, informacion financiera, informacion crediticia, informacion laboral y economica, fotografias, firma digital o electronica e informacion tecnica generada durante el proceso de contratacion digital.",
    fonts
  );
  sectionTitle(doc, "Derechos del titular", fonts);
  paragraph(
    doc,
    "Como titular conozco que tengo derecho a conocer, actualizar y rectificar mis datos; solicitar prueba de esta autorizacion; ser informado sobre el uso dado a mis datos; presentar consultas y reclamos; solicitar la supresion cuando proceda legalmente; y revocar esta autorizacion cuando sea procedente conforme a la ley.",
    fonts
  );
  sectionTitle(doc, "Canales de atencion", fonts);
  paragraph(
    doc,
    "Podre ejercer mis derechos mediante solicitud escrita dirigida a FINSER PAY S.A.S. a traves de los canales de atencion dispuestos por la compania.",
    fonts
  );
  sectionTitle(doc, "Declaracion y aceptacion", fonts);
  paragraph(
    doc,
    "Declaro que he leido y comprendido el contenido de la presente autorizacion y que otorgo mi consentimiento de manera libre, expresa e informada.",
    fonts
  );
  signatureBlock(
    doc,
    "Firma del titular",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}\nHora: ${hora}\nDireccion IP: ${
      credito.contratoIp || "Registrada por FirmaSeguro"
    }`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 2 de 7",
    "Contrato de financiacion, autorizacion de control tecnologico y tratamiento de datos",
    fonts
  );
  paragraph(
    doc,
    "FINSER PAY S.A.S. - NIT 902052909-4 - Domicilio: Ibague, Tolima.",
    fonts
  );
  sectionTitle(doc, "El cliente", fonts);
  keyValueGrid(
    doc,
    [
      { label: "Nombre", value: credito.clienteNombre },
      { label: "Cedula", value: credito.clienteDocumento || "-" },
      { label: "Telefono", value: credito.clienteTelefono || "-" },
      { label: "Direccion", value: credito.clienteDireccion || "-" },
    ],
    fonts
  );
  sectionTitle(doc, "Primera - Objeto", fonts);
  paragraph(
    doc,
    "EL FINANCIADOR entrega al CLIENTE, bajo modalidad de financiacion, un dispositivo movil cuyas caracteristicas se describen a continuacion.",
    fonts
  );
  keyValueGrid(
    doc,
    [
      { label: "Marca", value: marca },
      { label: "Modelo", value: modelo },
      { label: "Referencia", value: equipo },
      { label: "IMEI", value: credito.imei || credito.deviceUid || "-" },
    ],
    fonts
  );
  sectionTitle(doc, "Segunda - Valor y condiciones", fonts);
  keyValueGrid(
    doc,
    [
      { label: "Valor total del equipo", value: formatCurrency(credito.valorEquipoTotal) },
      { label: "Cuota inicial", value: formatCurrency(credito.cuotaInicial) },
      { label: "Saldo financiado", value: formatCurrency(saldoFinanciado) },
      { label: "Numero de cuotas", value: `${credito.plazoMeses || "-"} cuotas` },
      { label: "Valor de cada cuota", value: formatCurrency(credito.valorCuota) },
      { label: "Frecuencia", value: getPaymentFrequencyLabel(credito.frecuenciaPago) },
    ],
    fonts
  );
  paragraph(
    doc,
    "El CLIENTE se obliga a pagar en las fechas acordadas.",
    fonts
  );
  sectionTitle(doc, "Tercera - Mora", fonts);
  bulletParagraph(
    doc,
    [
      "El incumplimiento en el pago de cualquiera de las cuotas generara exigibilidad inmediata de la totalidad de la obligacion.",
      "Se causaran intereses moratorios a la tasa maxima legal permitida.",
      "Podra iniciarse gestion de cobro prejuridico y juridico.",
    ],
    fonts
  );
  sectionTitle(doc, "Cuarta - Autorizacion de control del dispositivo", fonts);
  bulletParagraph(
    doc,
    [
      "El dispositivo podra ser bloqueado, restringido o limitado en caso de mora.",
      "Podran implementarse medidas tecnologicas de control remoto.",
      "Dichas medidas permaneceran hasta la normalizacion de la obligacion.",
    ],
    fonts
  );
  paragraph(
    doc,
    "Esta autorizacion constituye aceptacion libre de mecanismos de garantia tecnologica.",
    fonts
  );
  sectionTitle(doc, "Quinta - Propiedad y garantia", fonts);
  paragraph(
    doc,
    "El dispositivo permanecera como garantia de la obligacion hasta el pago total.",
    fonts
  );
  sectionTitle(doc, "Sexta - Autorizacion de habeas data", fonts);
  bulletParagraph(
    doc,
    [
      "El CLIENTE autoriza a EL FINANCIADOR para consultar, reportar, procesar y actualizar informacion en centrales de riesgo.",
      "Tambien autoriza compartir informacion con entidades aliadas para gestion de cobranza.",
    ],
    fonts
  );
  sectionTitle(doc, "Septima - Declaraciones del cliente", fonts);
  bulletParagraph(
    doc,
    [
      "La informacion suministrada es veraz.",
      "Recibe el equipo en perfecto estado.",
      "Comprende plenamente las condiciones del contrato.",
    ],
    fonts
  );
  sectionTitle(doc, "Octava - Merito ejecutivo", fonts);
  paragraph(
    doc,
    "El presente contrato presta merito ejecutivo y constituye titulo idoneo para exigir judicialmente el pago de la obligacion.",
    fonts
  );
  sectionTitle(doc, "Novena - Validez digital", fonts);
  paragraph(
    doc,
    "El presente contrato se firma por medios electronicos, teniendo plena validez juridica conforme a la legislacion colombiana.",
    fonts
  );
  sectionTitle(doc, "Decima - Prueba", fonts);
  bulletParagraph(
    doc,
    [
      "Firma digital.",
      "Registro fotografico del cliente.",
      "Datos tecnicos como fecha, hora, IP y dispositivo.",
    ],
    fonts
  );
  signatureBlock(
    doc,
    "Firma digital del cliente",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}`,
    fonts
  );

  documentTitle(doc, "Documento 3 de 7", `Pagare No. ${pagareNumero}`, fonts);
  paragraph(
    doc,
    `Yo, ${credito.clienteNombre}, mayor de edad, identificado con cedula de ciudadania No. ${valueOrDash(
      credito.clienteDocumento
    )}, actuando en nombre propio, me obligo de manera incondicional a pagar a la orden de FINSER PAY S.A.S., NIT 902052909-4, la suma de ${formatCurrency(
      saldoFinanciado
    )} pesos colombianos, correspondiente al saldo financiado de la obligacion.`,
    fonts
  );
  sectionTitle(doc, "Primera - Forma de pago", fonts);
  paragraph(
    doc,
    `La obligacion sera pagada en ${credito.plazoMeses || "-"} cuotas de ${formatCurrency(
      credito.valorCuota
    )} cada una, conforme al plan pactado.`,
    fonts
  );
  sectionTitle(doc, "Segunda - Vencimiento anticipado", fonts);
  bulletParagraph(
    doc,
    [
      "El incumplimiento de cualquiera de las cuotas dara lugar a la exigibilidad inmediata del total de la deuda.",
      "Tambien dara lugar al cobro de intereses moratorios.",
    ],
    fonts
  );
  sectionTitle(doc, "Tercera - Intereses", fonts);
  paragraph(
    doc,
    "Se causaran intereses de mora a la tasa maxima legal vigente.",
    fonts
  );
  sectionTitle(doc, "Cuarta - Gastos de cobranza", fonts);
  paragraph(
    doc,
    "El deudor asumira todos los gastos derivados de cobro, incluyendo honorarios juridicos.",
    fonts
  );
  sectionTitle(doc, "Quinta - Autorizacion", fonts);
  paragraph(doc, "El deudor autoriza el reporte a centrales de riesgo.", fonts);
  sectionTitle(doc, "Sexta - Espacios en blanco", fonts);
  paragraph(
    doc,
    "El deudor autoriza expresa e irrevocablemente a FINSER PAY S.A.S. para llenar los espacios en blanco del presente pagare conforme a las condiciones del credito otorgado.",
    fonts
  );
  sectionTitle(doc, "Septima - Merito ejecutivo", fonts);
  paragraph(doc, "El presente pagare presta merito ejecutivo.", fonts);
  sectionTitle(doc, "Lugar y fecha", fonts);
  paragraph(doc, `Ibague, ${fecha}.`, fonts);
  signatureBlock(
    doc,
    "Firma del deudor",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 4 de 7",
    "Carta de instrucciones para diligenciamiento de pagare en blanco",
    fonts
  );
  paragraph(
    doc,
    "FINSER PAY S.A.S. - NIT 902052909-4 - Domicilio: Ibague, Tolima.",
    fonts
  );
  paragraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado con cedula de ciudadania No. ${valueOrDash(
      credito.clienteDocumento
    )}, actuando en nombre propio, autorizo expresa, previa e irrevocablemente a FINSER PAY S.A.S. para que diligencie el pagare firmado por mi, conforme a las siguientes instrucciones.`,
    fonts
  );
  sectionTitle(doc, "Primera - Objeto", fonts);
  paragraph(
    doc,
    "El pagare respalda todas las obligaciones derivadas del contrato de financiacion de equipo movil suscrito con FINSER PAY S.A.S.",
    fonts
  );
  sectionTitle(doc, "Segunda - Diligenciamiento", fonts);
  bulletParagraph(
    doc,
    [
      "Valor total de la obligacion.",
      "Fecha de creacion.",
      "Fecha de vencimiento.",
      "Numero de cuotas.",
      "Intereses.",
      "Numero del pagare.",
    ],
    fonts
  );
  sectionTitle(doc, "Tercera - Valor", fonts);
  paragraph(
    doc,
    "El valor a diligenciar correspondera al total de la obligacion adquirida, incluyendo capital, intereses corrientes, intereses de mora y gastos de cobranza.",
    fonts
  );
  sectionTitle(doc, "Cuarta - Vencimiento", fonts);
  bulletParagraph(
    doc,
    [
      "El pagare podra ser llenado con vencimiento inmediato en caso de incumplimiento en el pago de una o mas cuotas.",
      "Tambien podra ser llenado por mora en la obligacion o incumplimiento de cualquiera de las condiciones del contrato.",
    ],
    fonts
  );
  sectionTitle(doc, "Quinta - Exigibilidad", fonts);
  paragraph(
    doc,
    "Autorizo expresamente que, en caso de incumplimiento, el pagare sea exigible de manera inmediata en su totalidad.",
    fonts
  );
  sectionTitle(doc, "Sexta - Cesion", fonts);
  paragraph(
    doc,
    "FINSER PAY S.A.S. podra ceder el pagare a terceros sin necesidad de autorizacion adicional del deudor.",
    fonts
  );
  sectionTitle(doc, "Septima - Cobro", fonts);
  paragraph(
    doc,
    "Autorizo el inicio de procesos de cobro prejuridico y juridico, asumiendo todos los costos derivados, incluyendo honorarios de abogados.",
    fonts
  );
  sectionTitle(doc, "Octava - Aceptacion", fonts);
  bulletParagraph(
    doc,
    [
      "He firmado el pagare de manera libre y voluntaria.",
      "Conozco y acepto el contenido de esta carta de instrucciones.",
      "Entiendo las consecuencias legales del incumplimiento.",
    ],
    fonts
  );
  sectionTitle(doc, "Novena - Validez digital", fonts);
  paragraph(
    doc,
    "El presente documento se firma mediante mecanismos electronicos, teniendo plena validez juridica conforme a la legislacion colombiana.",
    fonts
  );
  sectionTitle(doc, "Decima - Prueba", fonts);
  bulletParagraph(
    doc,
    ["Firma digital.", "Registro fotografico.", "Datos tecnicos: fecha, hora, IP y dispositivo."],
    fonts
  );
  signatureBlock(
    doc,
    "Firma del deudor",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 5 de 7",
    "Autorizacion de bloqueo equipo electronico o bien mueble",
    fonts
  );
  paragraph(doc, "Senores: FINSER PAY S.A.S.", fonts);
  paragraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado con cedula de ciudadania No. ${valueOrDash(
      credito.clienteDocumento
    )}, autorizo de manera expresa, previa e informada a FINSER PAY S.A.S. para aplicar mecanismos tecnologicos de control, restriccion o bloqueo sobre el equipo financiado en caso de mora o incumplimiento de la obligacion.`,
    fonts
  );
  keyValueGrid(
    doc,
    [
      { label: "Direccion", value: credito.clienteDireccion || "-" },
      { label: "Nombre", value: credito.clienteNombre },
      { label: "Telefono", value: credito.clienteTelefono || "-" },
      { label: "Cedula", value: credito.clienteDocumento || "-" },
      { label: "Correo", value: credito.clienteCorreo || "-" },
      { label: "Equipo", value: equipo },
      { label: "IMEI", value: credito.imei || credito.deviceUid || "-" },
    ],
    fonts
  );
  sectionTitle(doc, "Alcance de la autorizacion", fonts);
  bulletParagraph(
    doc,
    [
      "El equipo podra ser bloqueado, restringido o limitado cuando la obligacion se encuentre en mora.",
      "FINSER PAY S.A.S. podra utilizar aplicaciones, software o herramientas tecnologicas de control remoto instaladas o asociadas al equipo.",
      "La restriccion permanecera hasta que el cliente normalice la obligacion y el pago sea verificado por FINSER PAY S.A.S.",
      "Esta medida no corresponde a bloqueo por hurto ni a reporte ante operador movil por perdida o robo; corresponde exclusivamente a control de garantia por pago.",
      "Una vez verificado el pago, FINSER PAY S.A.S. realizara la gestion de desbloqueo dentro de los tiempos operativos disponibles.",
    ],
    fonts
  );
  sectionTitle(doc, "Declaracion del cliente", fonts);
  paragraph(
    doc,
    "Declaro que recibo informacion clara sobre el mecanismo de control tecnologico y que acepto su uso como garantia de la obligacion financiera adquirida.",
    fonts
  );
  signatureBlock(
    doc,
    "Firma del cliente",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 6 de 7",
    "Anexo 1 - Aceptacion de la garantia y autorizaciones - Afianzamos Fintech S.A.S.",
    fonts
  );
  afianzamosHeader(doc, fonts);
  afianzamosSectionTitle(doc, "a.) ACEPTACION DE LA GARANTIA:", fonts);
  afianzamosParagraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado como aparece al pie de mi firma, en calidad de cliente/usuario del Credito FINSER PAY, actuando en nombre propio, por medio del presente documento acepto el servicio de FIANZA prestado por el Fondo De Garantias - AFIANZAMOS FINTECH S.A.S. ("AFIANZAMOS") como mecanismo de cobertura de riesgo, para respaldar la operacion de credito aprobado por FINSER PAY S.A.S. bajo el folio ${credito.folio}. Acepto de manera expresa e irrevocable el pago de las comisiones, incluido el valor del IVA, derivado de la fianza conferida por AFIANZAMOS, que se pagara en la proporcion del uso del credito y con las mismas condiciones pactadas para la compra financiada, sin que haya lugar a devolucion o reintegro por prepago de la obligacion crediticia.`,
    fonts
  );
  afianzamosParagraph(
    doc,
    "Declaro conocer las condiciones de la Fianza otorgada por AFIANZAMOS como se describe en el Reglamento de la Fianza publicado en www.afianzamos.com.co y en el documento que firme denominado \"ACEPTACION DE LAS CONDICIONES Y EL VALOR DE LA FIANZA\" dirigido a FINSER PAY S.A.S., por tanto, reconozco que la fianza no extingue parcial, ni totalmente, mi obligacion con FINSER PAY S.A.S. otorgante del credito. Si producto del incumplimiento del pago de la obligacion crediticia adquirida, AFIANZAMOS se ve obligado a pagar esta obligacion a favor de FINSER PAY S.A.S., en consecuencia, operara a favor de AFIANZAMOS la subrogacion del credito, permitiendo recobrar el valor reclamado y pagado. A partir de este momento AFIANZAMOS generara intereses de mora y gastos de cobranza; en efecto cancelare los valores adeudados a AFIANZAMOS, de conformidad con el reglamento interno, el cual puede ser consultado en la pagina web http://www.afianzamos.com.co.",
    fonts
  );
  afianzamosParagraph(
    doc,
    "Autorizo expresa e irrevocablemente a FINSER PAY S.A.S. para entregar a AFIANZAMOS toda la informacion relacionada con la operacion de credito afianzada a mi nombre; del mismo modo, autorizo a AFIANZAMOS para entregar mis datos personales a quien realice la gestion cobranza de la cartera directa o a traves de cobranza delegada, de acuerdo con lo establecido en la normatividad vigente en Colombia.",
    fonts
  );
  afianzamosSectionTitle(
    doc,
    "b.) AUTORIZACION REPORTE ANTE LAS CENTRALES DE RIESGOS:",
    fonts
  );
  afianzamosParagraph(
    doc,
    "Autorizo en nombre propio, expresa, libre, voluntaria e irrevocablemente, al Fondo de Garantias - AFIANZAMOS FINTECH S.A.S. (\"AFIANZAMOS\") a quien represente sus derechos u ostente en el futuro la calidad de acreedor, para que consulte toda la informacion financiera, crediticia, comercial, de servicios y la proveniente de otros paises, atinente a las relaciones comerciales que tenga con el sistema financiero, comercial y de servicios, o de cualquier sector, tanto en Colombia como en el exterior, con sujecion a los principios, terminos y condiciones consagrados en la Ley 1266 de 2008 y demas normas que la modifiquen, aclaren o reglamenten. Asi mismo, el abajo firmante en la calidad indicada o quien hiciere sus veces, autoriza expresa e irrevocablemente a AFIANZAMOS, a reportar, actualizar, solicitar, compartir y divulgar informacion referente a mi comportamiento crediticio a cualquier otro operador y/o fuente de informacion financiera legalmente establecida en Colombia.",
    fonts
  );
  afianzamosSectionTitle(doc, "c.) DECLARACION DE ORIGEN DE FONDOS:", fonts);
  afianzamosParagraph(
    doc,
    "Con el proposito de dar cumplimiento a lo senalado al respecto en el Estatuto Organico del Sistema Financiero (Decreto 663 de 1993), la Circular Externa No. 007 de 1996, expedida por la Superintendencia Financiera, la Ley 1474 de 2011 y demas normas legales para el control de las actividades de lavado de activos vigentes en Colombia; en particular para cumplir con lo establecido en el articulo 27 de la ley 1121 de 2006, pese a no estar obligado a ello, DECLARO que los recursos del pago de las comisiones provienen de:",
    fonts
  );
  afianzamosIndentedItems(
    doc,
    [
      "Mis recursos, ocupacion, actividad y de la compania que represento tienen un origen licito y provienen directamente de la actividad economica senalada en este formulario, la cual se desarrolla dentro del marco legal y normativo colombiano.",
      "Que la fuente de fondos en ningun caso involucra actividades ilicitas propias o de terceras personas, ni relacionadas con los delitos de lavado de activos, rebelion, terrorismo, y/o fabricacion o trafico de estupefacientes.",
      "La informacion aqui suministrada corresponde a la realidad y autorizo su verificacion y actualizacion ante cualquier persona publica o privada sin limitacion alguna, desde ahora y mientras subsista alguna relacion con la sociedad AFIANZAMOS, o con quien represente sus derechos.",
      "Eximo de toda responsabilidad que se derive por informacion erronea, falsa o inexacta que hubiere proporcionado en este documento, o de la violacion del mismo, a AFIANZAMOS, en el caso de comprobarse cualquier infraccion de las normas legales tendientes al control de lavado de activos, rebelion, terrorismo, y/o fabricacion o trafico de estupefacientes, de acuerdo con la legislacion colombiana vigente.",
    ],
    fonts,
    { numbered: true }
  );

  doc.addPage();
  afianzamosHeader(doc, fonts);
  afianzamosSectionTitle(doc, "d.) AVISO DE PRIVACIDAD:", fonts);
  afianzamosParagraph(
    doc,
    "La sociedad AFIANZAMOS FINTECH S.A.S. identificada con NIT. 901.229.892-6 es una sociedad comercial legalmente constituida bajo las leyes de Colombia, y domiciliada en la Calle 67 No. 52 - 20 Piso 2 Torre A Edificio Ruta N. Medellin Antioquia Telefono: 3104264554 / correo electronico notificaciones@afianzamos.com.co; en cumplimiento con el Regimen General de Proteccion de Datos Personales reglamentado por la Constitucion Politica Nacional en sus articulos 15 y 20, de la Ley 1581 de 2012, el Decreto 1377 de 2013 y demas preceptos normativos y la Politica de Tratamiento y Proteccion de Datos Personales, adoptada por AFIANZAMOS y publicada en su pagina web http://www.afianzamos.com.co, por los cuales se establecen disposiciones generales del habeas data y se regula el manejo de la informacion contenida en bases de datos, es responsable del tratamiento de sus datos personales y para tal fin, da el presente AVISO sobre el tratamiento de los datos personales bajo su responsabilidad.",
    fonts
  );
  afianzamosParagraph(doc, "Usted como titular de datos personales, tiene derecho a:", fonts);
  afianzamosIndentedItems(
    doc,
    [
      "Conocer, actualizar y rectificar sus datos personales. Este derecho se podra ejercer, entre otros, frente a datos parciales, inexactos, incompletos, fraccionados, que induzcan a error, o aquellos cuyo tratamiento este expresamente prohibido o no haya sido autorizado.",
      "Por cualquier medio solicitar prueba de la autorizacion otorgada a AFIANZAMOS, en su condicion de responsable del tratamiento.",
      "Recibir informacion, previa solicitud a AFIANZAMOS, respecto del uso que les ha dado a sus datos personales.",
      "Acceder a los Datos Personales que hayan sido objeto de Tratamiento, de manera gratuita.",
      "Acudir ante la Superintendencia de Industria y Comercio y presentar quejas por infracciones a lo dispuesto en la ley 1581 de 2012 y las demas normas que la modifiquen, adicionen o complementen.",
      "Modificar y revocar la autorizacion y/o solicitar la supresion del dato cuando en el tratamiento no se respeten los principios, derechos y garantias constitucionales y legales. Nota: La solicitud de supresion o revocatoria no procederan cuando el titular tenga un deber legal o contractual de permanecer en la base de datos. Para tal efecto, podra enviar peticion al correo electronico notificaciones@afianzamos.com.co o escribiendonos a la Calle 67 No. 52 - 20 Piso 2 Torre A Edificio Ruta N. Medellin Antioquia tambien puede comunicarse a nuestro telefono de servicio al cliente 3104264554 en horarios de lunes a viernes, para recibir la informacion respectiva.",
    ],
    fonts,
    { lettered: true }
  );
  afianzamosParagraph(
    doc,
    "De igual manera, el Fondo De Garantias - AFIANZAMOS FINTECH S.A.S. (\"AFIANZAMOS\") o quien represente sus derechos u ostente su calidad en virtud de la subrogacion, informa que realizara el siguiente tratamiento de sus datos personales asi:",
    fonts
  );
  afianzamosIndentedItems(
    doc,
    [
      "Recolectar, consultar, solicitar, verificar, administrar, actualizar, transferir, transmitir, compartir, almacenar, usar, circular y/o suprimir las bases de datos bajo su responsabilidad, a traves de medios fisicos, electronicos y/o digitales de acuerdo con el tipo y forma de recoleccion de la informacion.",
      "Facilitar el desarrollo de obligaciones contractuales con AFIANZAMOS, relacionadas con el respaldo de la operacion de credito FINSER PAY.",
      "Estructurar base de datos para ser utilizada en el desarrollo de sus funciones tales como la comunicacion con sus clientes, proveedores, usuarios, trabajadores y contratistas y otras obligaciones como: facturacion, gestion de cobro, recaudo, verificaciones, consultas, reportes, generacion de estadistica, control, comportamiento, monitoreo habito de pago, envio de certificados, extractos, comunicaciones, promociones, planes de mercadeo, planes de fidelizacion y relacionamiento comercial-operativo.",
      "Dar atencion y respuestas a las solicitudes, quejas y reclamos presentados ante AFIANZAMOS.",
      "Realizar consulta y recoleccion del dato del titular, sobre informacion financiera, crediticia y comercial a que se refiere la Ley 1266 de 2008, ante las centrales de informacion crediticia, operadores de bancos de datos que tengan el mismo fin y/o entidades publicas o privadas ya sea directa o a traves de terceros contratados para este fin.",
      "Realizar todas las busquedas y recopilacion de informacion que permita realizar el estudio de capacidad crediticia y de pago, valorar el riesgo y corroborar que la informacion suministrada sea veraz, completa, exacta, y actualizada.",
      "Recopilar y transmitir informacion personal, comercial, financiera del titular del dato, para que sea conocida y tratada por terceros en calidad de proveedores, contratista o quien ostente la calidad de acreedor, para la prestacion de servicios de mercadeo, cobranza, operativos, tecnologicos, logisticos, y de apoyo.",
      "Realizar actividades de gestion de cobro, aviso de reporte a las centrales de riesgo, entrega de extractos de obligaciones y actualizar informacion a traves de diferentes actividades como lo son la consulta en bases de datos publicas, paginas de internet y redes sociales y referencias de terceras personas, en particular las personas que han servido de referencia para la utilizacion de los servicios de AFIANZAMOS.",
      "Reportar datos sobre la generacion, modificacion, extincion, cumplimiento o incumplimiento de las obligaciones del titular del dato ante las centrales de informacion crediticia.",
    ],
    fonts,
    { lettered: true }
  );

  doc.addPage();
  afianzamosHeader(doc, fonts);
  afianzamosIndentedItems(
    doc,
    [
      "Realizar el registro, manejo, tratamiento y negociacion de inversiones de titulos o valores que conforman el portafolio de inversion de AFIANZAMOS.",
      "Realizar tratamiento a los datos sensibles tales como huellas dactilares, ubicacion, datos de ordenadores, o telefonos celulares, fotografias, correos electronicos, entre otras para ser utilizados con fines de autenticacion, validacion, verificacion e identificacion de mi firma electronica y/o digital.",
    ],
    fonts,
    { lettered: true, startIndex: 9 }
  );
  afianzamosParagraph(
    doc,
    "Declaro que he sido informado de la politica de tratamiento de datos personales y este aviso de privacidad, los cuales puedo consultar la pagina web de AFIANZAMOS: http://www.afianzamos.com.co.",
    fonts
  );
  afianzamosParagraph(
    doc,
    "En constancia de haber leido y aceptado lo anterior, firmo el presente documento en la ciudad de __________________ a los ______________ dias del mes ______________ ano 20____, el cual tendra validez desde su firma, durante la vigencia de la fianza y durante el tiempo que me encuentre en calidad de deudor de AFIANZAMOS o quien ostente la calidad de acreedor de la obligacion y demas terminos de ley.",
    fonts
  );
  afianzamosLineSignature(doc, "DEUDOR", fonts, {
    nombre: valueOrDash(credito.clienteNombre),
    documento: valueOrDash(credito.clienteDocumento),
    fechaHora: firmaFechaHora,
  });
  afianzamosLineSignature(doc, "CO - DEUDOR 1", fonts);
  afianzamosLineSignature(doc, "CO - DEUDOR 2", fonts);

  documentTitle(
    doc,
    "Documento 7 de 7",
    "Endoso y contrato de arrendamiento de equipo celular con opcion de compra",
    fonts
  );
  paragraph(
    doc,
    `Entre FINSER PAY S.A.S., identificada con NIT 902052909-4, y ${credito.clienteNombre}, identificado con cedula de ciudadania No. ${valueOrDash(
      credito.clienteDocumento
    )}, se deja constancia de las condiciones aplicables al uso, tenencia, garantia, endoso o cesion de derechos relacionados con el equipo financiado.`,
    fonts
  );
  sectionTitle(doc, "Equipo objeto del acuerdo", fonts);
  keyValueGrid(
    doc,
    [
      { label: "Marca", value: marca },
      { label: "Modelo", value: modelo },
      { label: "Referencia", value: equipo },
      { label: "IMEI", value: credito.imei || credito.deviceUid || "-" },
      { label: "Valor equipo", value: formatCurrency(credito.valorEquipoTotal) },
      { label: "Saldo financiado", value: formatCurrency(saldoFinanciado) },
    ],
    fonts
  );
  sectionTitle(doc, "Obligaciones del cliente", fonts);
  bulletParagraph(
    doc,
    [
      "Conservar el equipo en buen estado y usarlo conforme a su destinacion normal.",
      "Pagar oportunamente las cuotas pactadas en el plan de financiacion.",
      "No remover, alterar, eludir ni desinstalar mecanismos tecnologicos de control o garantia instalados en el equipo.",
      "Informar oportunamente cualquier novedad sobre perdida, dano, hurto, cambio de contacto o dificultad de pago.",
    ],
    fonts
  );
  sectionTitle(doc, "Opcion de compra, terminacion y cesion", fonts);
  bulletParagraph(
    doc,
    [
      "El pago total de la obligacion permitira consolidar la propiedad economica del equipo a favor del cliente.",
      "El incumplimiento faculta a FINSER PAY S.A.S. para exigir el pago total, aplicar mecanismos de control tecnologico y adelantar gestiones de cobro.",
      "FINSER PAY S.A.S. podra endosar, ceder o transferir sus derechos economicos sobre la obligacion y sus garantias sin autorizacion adicional del cliente.",
    ],
    fonts
  );
  sectionTitle(doc, "Declaracion unica de aceptacion y ratificacion", fonts);
  bulletParagraph(
    doc,
    [
      "Ratifico la autorizacion de tratamiento de datos personales.",
      "Ratifico el contrato de financiacion y la autorizacion de control tecnologico.",
      "Ratifico el pagare y la carta de instrucciones.",
      "Ratifico la aceptacion de garantia y autorizaciones asociadas al fondo de garantias.",
      "Acepto que la firma electronica certificada aplicada sobre este paquete documental representa mi consentimiento libre, expreso e informado.",
    ],
    fonts
  );
  addElectronicSignatureClause(doc, fonts);
  photoEvidenceBlock(doc, credito, fonts);
  signatureBlock(
    doc,
    "Firma del cliente",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}\nHora: ${hora}\nDireccion IP: ${
      credito.contratoIp || "Registrada por FirmaSeguro"
    }`,
    fonts
  );

  doc.end();
  return bufferPromise;
}
