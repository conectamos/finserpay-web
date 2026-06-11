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

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) {
    return;
  }

  doc.addPage();
}

function documentTitle(
  doc: PDFKit.PDFDocument,
  label: string,
  title: string,
  fonts: { regular: string; bold: string }
) {
  doc.addPage();
  doc
    .font(fonts.bold)
    .fontSize(8)
    .fillColor("#0F766E")
    .text(label.toUpperCase(), 42, 42, { width: 511 });
  doc
    .font(fonts.bold)
    .fontSize(16)
    .fillColor("#0F172A")
    .text(title.toUpperCase(), 42, 60, { width: 511, lineGap: 2 });
  doc
    .strokeColor("#D1FAE5")
    .lineWidth(1)
    .moveTo(42, doc.y + 8)
    .lineTo(553, doc.y + 8)
    .stroke();
  doc.y += 24;
}

function bulletParagraph(
  doc: PDFKit.PDFDocument,
  items: string[],
  fonts: { regular: string; bold: string }
) {
  paragraph(doc, items.map((item) => `- ${item}`).join("\n"), fonts);
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
  const boxHeight = 150;

  ensureSpace(doc, boxHeight + 12);
  const x = doc.page.margins.left;
  const y = doc.y;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc
    .save()
    .roundedRect(x, y, width, boxHeight, 12)
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
  const slotWidth = 154;

  imageSlots.forEach((slot, index) => {
    const slotX = x + 14 + index * (slotWidth + 12);
    const slotY = y + 34;
    doc
      .save()
      .roundedRect(slotX, slotY, slotWidth, 92, 10)
      .fill("#FFFFFF")
      .restore();

    if (slot.buffer) {
      try {
        doc.image(slot.buffer, slotX + 8, slotY + 8, {
          fit: [slotWidth - 16, 72],
          align: "center",
          valign: "center",
        });
      } catch {
        doc
          .font(fonts.regular)
          .fontSize(8)
          .fillColor("#94A3B8")
          .text("Imagen no disponible", slotX + 10, slotY + 36, {
            width: slotWidth - 20,
            align: "center",
          });
      }
    } else {
      doc
        .font(fonts.regular)
        .fontSize(8)
        .fillColor("#94A3B8")
        .text("[ PENDIENTE ]", slotX + 10, slotY + 36, {
          width: slotWidth - 20,
          align: "center",
        });
    }

    doc
      .font(fonts.bold)
      .fontSize(7)
      .fillColor("#475569")
      .text(slot.label.toUpperCase(), slotX + 8, slotY + 102, {
        width: slotWidth - 16,
        align: "center",
      });
  });

  doc.y = y + boxHeight + 8;
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
  ensureSpace(doc, 58);
  doc.moveDown(0.8);
  doc
    .font(fonts.bold)
    .fontSize(12)
    .fillColor("#0F766E")
    .text(title.toUpperCase());
  doc.moveDown(0.35);
  doc
    .strokeColor("#D1FAE5")
    .lineWidth(1)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.7);
}

function paragraph(
  doc: PDFKit.PDFDocument,
  text: string,
  fonts: { regular: string; bold: string }
) {
  ensureSpace(doc, 50);
  doc
    .font(fonts.regular)
    .fontSize(9.3)
    .fillColor("#1F2937")
    .text(text, {
      align: "justify",
      lineGap: 3,
    });
  doc.moveDown(0.45);
}

function keyValueGrid(
  doc: PDFKit.PDFDocument,
  items: Array<{ label: string; value: string }>,
  fonts: { regular: string; bold: string }
) {
  const startX = doc.page.margins.left;
  const colWidth = 250;
  const rowHeight = 48;

  items.forEach((item, index) => {
    const col = index % 2;
    if (col === 0) {
      ensureSpace(doc, rowHeight + 10);
    }

    const x = startX + col * (colWidth + 14);
    const y = doc.y;
    doc
      .save()
      .roundedRect(x, y, colWidth, rowHeight, 10)
      .fill("#F8FAFC")
      .restore();
    doc
      .font(fonts.bold)
      .fontSize(7.5)
      .fillColor("#64748B")
      .text(item.label.toUpperCase(), x + 12, y + 10, {
        width: colWidth - 24,
      });
    doc
      .font(fonts.bold)
      .fontSize(10.5)
      .fillColor("#0F172A")
      .text(item.value || "-", x + 12, y + 24, {
        width: colWidth - 24,
        height: 18,
        ellipsis: true,
      });

    if (col === 1 || index === items.length - 1) {
      doc.y = y + rowHeight + 10;
    }
  });
}

function signatureBlock(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  fonts: { regular: string; bold: string }
) {
  ensureSpace(doc, 116);
  const x = doc.page.margins.left;
  const y = doc.y + 12;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc
    .save()
    .roundedRect(x, y, width, 92, 12)
    .strokeColor("#CBD5E1")
    .stroke()
    .restore();
  doc
    .font(fonts.bold)
    .fontSize(9)
    .fillColor("#64748B")
    .text(label.toUpperCase(), x + 14, y + 12);
  doc
    .font(fonts.regular)
    .fontSize(9)
    .fillColor("#334155")
    .text(value, x + 14, y + 30, { width: width - 28 });
  doc
    .moveTo(x + 14, y + 68)
    .lineTo(x + width - 14, y + 68)
    .strokeColor("#94A3B8")
    .stroke();
  doc
    .font(fonts.bold)
    .fontSize(8)
    .fillColor("#475569")
    .text("Firma electronica certificada por FirmaSeguro", x + 14, y + 74);
  doc.y = y + 106;
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
    margin: 42,
    compress: true,
    font: fonts.regular,
    info: {
      Title: `Paquete documental FINSER PAY ${credito.folio}`,
      Author: "FINSER PAY",
    },
  });
  const bufferPromise = toBuffer(doc);
  const tipoDocumento = (credito.clienteTipoDocumento || "CC").replace(/_/g, " ");
  const asesor = credito.vendedor?.nombre || credito.usuario.nombre;
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
  const firmaDigital = "Firma electronica certificada por FirmaSeguro";

  doc.save().roundedRect(42, 42, 511, 126, 22).fill("#F8FAFC").restore();
  doc.save().roundedRect(42, 42, 8, 126, 4).fill("#111827").restore();
  doc.font(fonts.bold).fontSize(10).fillColor("#0F766E").text("FINSER PAY", 66, 58);
  doc
    .font(fonts.bold)
    .fontSize(24)
    .fillColor("#0F172A")
    .text("Paquete legal FirmaSeguro", 66, 78, { width: 430 });
  doc
    .font(fonts.regular)
    .fontSize(10)
    .fillColor("#475569")
    .text(
      `Folio: ${credito.folio}\nCliente: ${credito.clienteNombre}\nDocumento: ${
        credito.clienteDocumento || "-"
      }\nSede: ${credito.sede.nombre}\nAsesor: ${asesor}`,
      66,
      116
    );

  doc.y = 194;
  sectionTitle(doc, "Orden de firma", fonts);
  paragraph(
    doc,
    "El cliente firma este paquete documental en el siguiente orden: 1) Autorizacion de tratamiento de datos personales. 2) Contrato de financiacion, autorizacion de control tecnologico y tratamiento de datos. 3) Pagare. 4) Carta de instrucciones para diligenciamiento de pagare en blanco.",
    fonts
  );

  sectionTitle(doc, "Ficha del expediente", fonts);
  keyValueGrid(
    doc,
    [
      { label: "Cliente", value: credito.clienteNombre },
      { label: "Documento", value: `${tipoDocumento} ${credito.clienteDocumento || "-"}` },
      { label: "Telefono", value: credito.clienteTelefono || "-" },
      { label: "Correo", value: credito.clienteCorreo || "-" },
      { label: "Direccion", value: credito.clienteDireccion || "-" },
      { label: "Equipo", value: equipo },
      { label: "IMEI", value: credito.imei || credito.deviceUid || "-" },
      { label: "Valor equipo", value: formatCurrency(credito.valorEquipoTotal) },
      { label: "Saldo financiado", value: formatCurrency(saldoFinanciado) },
      { label: "Cuota inicial", value: formatCurrency(credito.cuotaInicial) },
      { label: "Valor cuota", value: formatCurrency(credito.valorCuota) },
      { label: "Plazo", value: `${credito.plazoMeses || "-"} cuotas` },
      { label: "Frecuencia", value: getPaymentFrequencyLabel(credito.frecuenciaPago) },
      { label: "Primer pago", value: formatDate(credito.fechaPrimerPago) },
      { label: "Referencia pago", value: credito.referenciaPago || credito.clienteDocumento || "-" },
    ],
    fonts
  );

  documentTitle(
    doc,
    "Documento 1 de 4",
    "Autorizacion para el tratamiento de datos personales",
    fonts
  );
  paragraph(
    doc,
    "FINSER PAY S.A.S. - NIT 902052909-4 - Ibague, Tolima.",
    fonts
  );
  keyValueGrid(
    doc,
    [
      { label: "Nombre completo", value: credito.clienteNombre },
      { label: "Cedula de ciudadania", value: credito.clienteDocumento || "-" },
      { label: "Telefono", value: credito.clienteTelefono || "-" },
      { label: "Correo", value: credito.clienteCorreo || "-" },
    ],
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
      "Estudio y otorgamiento de credito: validar identidad, analizar capacidad de pago, verificar informacion y evaluar solicitudes de financiacion.",
      "Gestion contractual: celebrar contratos de financiacion, administrar obligaciones vigentes y gestionar pagos, recaudos y cartera.",
      "Gestion de cobranza: realizar actividades preventivas, administrativas, prejuridicas y juridicas por llamadas, mensajes de texto, WhatsApp, correo electronico y demas canales autorizados.",
      "Consulta y reporte a centrales de riesgo: consultar, reportar, actualizar, rectificar y compartir informacion financiera, crediticia, comercial y de servicios ante operadores autorizados por la ley.",
      "Prevencion del fraude: verificar documentos, validar identidad y detectar posibles conductas fraudulentas.",
      "Evidencia digital: almacenar firma electronica o digital, fotografias, videos, grabaciones y evidencias relacionadas con la solicitud de credito y la aceptacion contractual.",
      "Cumplimiento legal: atender requerimientos de autoridades judiciales o administrativas y cumplir obligaciones legales y regulatorias.",
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
  addElectronicSignatureClause(doc, fonts);
  sectionTitle(doc, "Declaracion y aceptacion", fonts);
  paragraph(
    doc,
    "Declaro que he leido y comprendido el contenido de la presente autorizacion y que otorgo mi consentimiento de manera libre, expresa e informada.",
    fonts
  );
  photoEvidenceBlock(doc, credito, fonts);
  signatureBlock(
    doc,
    "Firma del titular",
    `Nombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFirma digital: ${firmaDigital}\nFecha: ${fecha}\nHora: ${hora}\nDireccion IP: ${
      credito.contratoIp || "Registrada por FirmaSeguro"
    }`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 2 de 4",
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
  addElectronicSignatureClause(doc, fonts);
  photoEvidenceBlock(doc, credito, fonts);
  signatureBlock(
    doc,
    "Firma digital del cliente",
    `Firma: ${firmaDigital}\nNombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}`,
    fonts
  );

  documentTitle(doc, "Documento 3 de 4", `Pagare No. ${pagareNumero}`, fonts);
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
  addElectronicSignatureClause(doc, fonts);
  signatureBlock(
    doc,
    "Firma del deudor",
    `Firma: ${firmaDigital}\nNombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }`,
    fonts
  );

  documentTitle(
    doc,
    "Documento 4 de 4",
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
  addElectronicSignatureClause(doc, fonts);
  signatureBlock(
    doc,
    "Firma del deudor",
    `Firma: ${firmaDigital}\nNombre: ${credito.clienteNombre}\nCedula: ${
      credito.clienteDocumento || "-"
    }\nFecha: ${fecha}`,
    fonts
  );

  doc.end();
  return bufferPromise;
}
