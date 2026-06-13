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

function formatDate(value: Date | string | null | undefined) {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleString("es-CO");
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
  const valueHeight = doc.heightOfString(value, {
    width,
    lineGap: 1,
  });

  ensureSpace(doc, Math.max(58, Math.ceil(valueHeight + 46)));
  doc.moveDown(0.2);
  doc
    .font(fonts.bold)
    .fontSize(8.1)
    .fillColor("#111827")
    .text(label.toUpperCase(), x, doc.y, { width });
  doc
    .moveTo(x, doc.y + 16)
    .lineTo(x + 190, doc.y + 16)
    .strokeColor("#94A3B8")
    .stroke();
  doc
    .font(fonts.regular)
    .fontSize(7.6)
    .fillColor("#334155")
    .text(value, x, doc.y + 19, {
      width,
      lineGap: 1,
    });
  doc.moveDown(0.18);
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
    "Aceptacion de la garantia y autorizaciones fondo de garantias - Afianzamos Fintech S.A.S.",
    fonts
  );
  paragraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado con cedula de ciudadania No. ${valueOrDash(
      credito.clienteDocumento
    )}, acepto que la obligacion derivada de la financiacion del equipo movil pueda estar respaldada por mecanismos de garantia, fianza o fondo de garantias gestionado por AFIANZAMOS FINTECH S.A.S. o la entidad que FINSER PAY S.A.S. designe para respaldar la operacion.`,
    fonts
  );
  sectionTitle(doc, "Aceptaciones y autorizaciones", fonts);
  bulletParagraph(
    doc,
    [
      "Acepto los costos, comisiones, IVA o cargos asociados a la garantia, cuando estos hagan parte de las condiciones del credito informado.",
      "Autorizo la consulta, validacion, reporte y actualizacion de informacion financiera, comercial y crediticia necesaria para la gestion de la garantia.",
      "Autorizo que la informacion del credito sea compartida con el fondo de garantias, entidades aliadas, operadores de informacion y proveedores que participen en la administracion de la obligacion.",
      "Declaro que conozco que la garantia respalda el pago de la obligacion y no elimina mi responsabilidad como deudor principal.",
      "Acepto que, en caso de incumplimiento, puedan adelantarse gestiones de recuperacion, subrogacion, cobro prejuridico o juridico segun corresponda.",
    ],
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
