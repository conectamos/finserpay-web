import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { getPaymentFrequencyLabel } from "@/lib/credit-factory";
import type { CreditForFirmaSeguroPdf } from "@/lib/firmaseguro-credit-pdf";

type PdfFonts = {
  regular: string;
  bold: string;
};

type PdfField = {
  label: string;
  value: string;
};

const PAGE_TOTAL = 6;
const PAGE_MARGIN = 36;
const COMPANY_NAME = "FINSER PAY S.A.S.";
const COMPANY_NIT = "902.052.909-4";
const COMPANY_CITY = "Ibague, Tolima";
const INK = "#15171C";
const MUTED = "#536174";
const LINE = "#CAD2DC";
const SOFT = "#F4F7F8";
const ACCENT = "#A7D129";
const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const systemRegular = path.join(windowsFontDir, "arial.ttf");
const systemBold = path.join(windowsFontDir, "arialbd.ttf");
const bundledRegular = path.join(
  process.cwd(),
  "public",
  "pdf-fonts",
  "Geist-Regular.ttf"
);
const brandLogo = path.join(
  process.cwd(),
  "public",
  "branding",
  "finserpay-logo.jpg"
);

export function buildFirmaSeguroFolioFileName(folio: string) {
  const safeFolio = String(folio || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "");

  return `TALONARIO_FINSERPAY_${safeFolio || "CREDITO"}.pdf`;
}

function getPdfFonts(): PdfFonts {
  if (existsSync(systemRegular) && existsSync(systemBold)) {
    return { regular: systemRegular, bold: systemBold };
  }

  return {
    regular: bundledRegular,
    bold: bundledRegular,
  };
}

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function asDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value: Date | string | null | undefined) {
  const date = asDate(value);
  if (!date) {
    return "-";
  }

  return date.toLocaleDateString("es-CO", {
    timeZone: "America/Bogota",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}


function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatExactCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatPercentage(value: number | null | undefined, digits = 6) {
  return `${new Intl.NumberFormat("es-CO", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(value || 0))}%`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return value !== null && value !== undefined && Number.isFinite(parsed)
    ? parsed
    : null;
}

export function resolveFirmaSeguroFinancialDisclosure(
  credito: CreditForFirmaSeguroPdf
) {
  const snapshot = asRecord(credito.contratoSnapshot);
  const financiero = asRecord(snapshot?.financiero);
  const snapshotRounding = asRecord(financiero?.redondeoComercial);
  const cuotaExacta =
    finiteNumber(credito.valorCuota) ??
    finiteNumber(financiero?.cuotaTotalExacta) ??
    0;
  const cuotaComercial =
    finiteNumber(credito.valorCuotaComercial) ??
    finiteNumber(financiero?.cuotaComercial) ??
    cuotaExacta;

  return {
    cuotaExacta,
    cuotaComercial,
    tasaInteresEa:
      finiteNumber(credito.tasaInteresEa) ??
      finiteNumber(financiero?.tasaInteresEa),
    fianzaCuotaPorcentaje:
      finiteNumber(credito.fianzaCuotaPorcentaje) ??
      finiteNumber(financiero?.fianzaCuotaPorcentaje),
    fianzaTotalPorcentaje:
      finiteNumber(credito.fianzaTotalPorcentaje) ??
      finiteNumber(financiero?.fianzaTotalPorcentaje),
    fianzaModalidad:
      credito.fianzaModalidad === "TOTAL_CREDITO" ||
      financiero?.fianzaModalidad === "TOTAL_CREDITO"
        ? ("TOTAL_CREDITO" as const)
        : ("POR_CUOTA" as const),
    seguroCuotaPorcentaje:
      finiteNumber(credito.seguroCuotaPorcentaje) ??
      finiteNumber(financiero?.seguroCuotaPorcentaje),
    redondeoComercialModo:
      credito.redondeoComercialModo === "PISO" ||
      snapshotRounding?.modo === "PISO"
        ? ("PISO" as const)
        : ("REDONDEO" as const),
    redondeoComercialMultiplo:
      finiteNumber(credito.redondeoComercialMultiplo) ??
      finiteNumber(snapshotRounding?.multiplo),
  };
}

function valueOrDash(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  return text || "-";
}


function left(doc: PDFKit.PDFDocument) {
  return doc.page.margins.left;
}

function right(doc: PDFKit.PDFDocument) {
  return doc.page.width - doc.page.margins.right;
}

function width(doc: PDFKit.PDFDocument) {
  return right(doc) - left(doc);
}

function bottom(doc: PDFKit.PDFDocument) {
  return doc.page.height - doc.page.margins.bottom;
}

function resetX(doc: PDFKit.PDFDocument) {
  doc.x = left(doc);
}

function drawBrandHeader(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  pageNumber: number,
  title: string,
  fonts: PdfFonts
) {
  const x = left(doc);
  const top = PAGE_MARGIN;
  const contentWidth = width(doc);

  if (existsSync(brandLogo)) {
    try {
      doc.image(brandLogo, x, top, {
        fit: [58, 58],
        align: "center",
        valign: "center",
      });
    } catch {
      doc
        .save()
        .roundedRect(x, top, 52, 52, 8)
        .fill(INK)
        .restore()
        .font(fonts.bold)
        .fontSize(18)
        .fillColor("#FFFFFF")
        .text("FP", x, top + 17, { width: 52, align: "center" });
    }
  }

  doc
    .font(fonts.bold)
    .fontSize(11)
    .fillColor(INK)
    .text(COMPANY_NAME, x + 70, top + 7, { width: 235 });
  doc
    .font(fonts.regular)
    .fontSize(7.3)
    .fillColor(MUTED)
    .text(`NIT. ${COMPANY_NIT}`, x + 70, top + 25, { width: 235 })
    .text(COMPANY_CITY, x + 70, top + 38, { width: 235 });

  doc
    .font(fonts.bold)
    .fontSize(7.2)
    .fillColor(MUTED)
    .text(`FOLIO ${credito.folio}`, x + 315, top + 8, {
      width: contentWidth - 315,
      align: "right",
    })
    .text(`DOCUMENTO ${pageNumber} DE ${PAGE_TOTAL}`, x + 315, top + 25, {
      width: contentWidth - 315,
      align: "right",
    });

  const lineY = top + 68;
  doc
    .strokeColor(INK)
    .lineWidth(1)
    .moveTo(x, lineY)
    .lineTo(right(doc), lineY)
    .stroke();
  doc
    .strokeColor(ACCENT)
    .lineWidth(3)
    .moveTo(x, lineY)
    .lineTo(x + 84, lineY)
    .stroke();

  doc
    .font(fonts.bold)
    .fontSize(11.2)
    .fillColor(INK)
    .text(title.toUpperCase(), x, lineY + 13, {
      width: contentWidth,
      align: "center",
      lineGap: 1,
    });
  doc.y = Math.max(doc.y + 10, lineY + 50);
  resetX(doc);
}

function startPage(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  pageNumber: number,
  title: string,
  fonts: PdfFonts
) {
  if (pageNumber > 1) {
    doc.addPage();
  }

  drawBrandHeader(doc, credito, pageNumber, title, fonts);
}

function writeParagraph(
  doc: PDFKit.PDFDocument,
  text: string,
  fonts: PdfFonts,
  options: { size?: number; gap?: number; boldLead?: string } = {}
) {
  const size = options.size || 7.45;
  const gap = options.gap ?? 5;
  const x = left(doc);
  const y = doc.y;

  if (options.boldLead && text.startsWith(options.boldLead)) {
    doc
      .font(fonts.bold)
      .fontSize(size)
      .fillColor(INK)
      .text(options.boldLead, x, y, { continued: true });
    doc
      .font(fonts.regular)
      .fillColor(INK)
      .text(text.slice(options.boldLead.length), {
        width: width(doc),
        align: "justify",
        lineGap: 1,
      });
  } else {
    doc
      .font(fonts.regular)
      .fontSize(size)
      .fillColor(INK)
      .text(text, x, y, {
        width: width(doc),
        align: "justify",
        lineGap: 1,
      });
  }

  doc.y += gap;
  resetX(doc);
}

function writeSection(
  doc: PDFKit.PDFDocument,
  title: string,
  fonts: PdfFonts,
  options: { gapTop?: number } = {}
) {
  doc.y += options.gapTop ?? 3;
  doc
    .font(fonts.bold)
    .fontSize(8)
    .fillColor(INK)
    .text(title.toUpperCase(), left(doc), doc.y, { width: width(doc) });
  doc.y += 2;
  doc
    .strokeColor(LINE)
    .lineWidth(0.6)
    .moveTo(left(doc), doc.y)
    .lineTo(right(doc), doc.y)
    .stroke();
  doc.y += 5;
  resetX(doc);
}


function drawFields(
  doc: PDFKit.PDFDocument,
  fields: PdfField[],
  fonts: PdfFonts,
  columns = 2
) {
  const gap = 8;
  const cellWidth = (width(doc) - gap * (columns - 1)) / columns;
  const rowHeight = 36;
  const startY = doc.y;

  fields.forEach((field, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const x = left(doc) + column * (cellWidth + gap);
    const y = startY + row * (rowHeight + 6);

    doc
      .save()
      .roundedRect(x, y, cellWidth, rowHeight, 5)
      .fill(SOFT)
      .strokeColor(LINE)
      .lineWidth(0.5)
      .stroke()
      .restore();
    doc
      .font(fonts.bold)
      .fontSize(6)
      .fillColor(MUTED)
      .text(field.label.toUpperCase(), x + 8, y + 6, {
        width: cellWidth - 16,
      });
    doc
      .font(fonts.bold)
      .fontSize(7.5)
      .fillColor(INK)
      .text(valueOrDash(field.value), x + 8, y + 18, {
        width: cellWidth - 16,
        ellipsis: true,
      });
  });

  const rows = Math.ceil(fields.length / columns);
  doc.y = startY + rows * (rowHeight + 6) + 1;
  resetX(doc);
}

function drawIdentityTable(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  date: string,
  fonts: PdfFonts
) {
  drawFields(
    doc,
    [
      { label: "Nombre", value: credito.clienteNombre },
      { label: "Fecha", value: date },
      { label: "Direccion", value: valueOrDash(credito.clienteDireccion) },
      {
        label: valueOrDash(credito.clienteTipoDocumento || "CC"),
        value: valueOrDash(credito.clienteDocumento),
      },
      { label: "Correo", value: valueOrDash(credito.clienteCorreo) },
      { label: "Telefono", value: valueOrDash(credito.clienteTelefono) },
    ],
    fonts
  );
}

function writeOpenLine(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  fonts: PdfFonts,
  size = 7.2
) {
  doc
    .font(fonts.regular)
    .fontSize(size)
    .fillColor(INK)
    .text(`${label}: ${value}`, left(doc), doc.y, {
      width: width(doc),
      lineGap: 1,
    });
  doc.y += 4;
  resetX(doc);
}

function drawSignature(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  fonts: PdfFonts,
  role = "Firma del cliente"
) {
  const signatureY = bottom(doc) - 60;

  if (doc.y > signatureY - 8) {
    throw new Error(
      `El contenido del talonario excede el espacio de firma en el folio ${credito.folio}`
    );
  }

  doc
    .strokeColor(INK)
    .lineWidth(0.65)
    .moveTo(left(doc), signatureY + 14)
    .lineTo(left(doc) + 235, signatureY + 14)
    .stroke();
  doc
    .font(fonts.bold)
    .fontSize(7.2)
    .fillColor(INK)
    .text(credito.clienteNombre, left(doc), signatureY + 20, {
      width: 235,
    });
  doc
    .font(fonts.regular)
    .fontSize(6.3)
    .fillColor(MUTED)
    .text(role.toUpperCase(), left(doc), signatureY + 34, {
      width: 235,
    });
  doc.y = signatureY + 48;
  resetX(doc);
}
function drawFooters(
  doc: PDFKit.PDFDocument,
  credito: CreditForFirmaSeguroPdf,
  fonts: PdfFonts
) {
  const pages = doc.bufferedPageRange();

  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    const y = bottom(doc) - 8;
    doc
      .strokeColor(LINE)
      .lineWidth(0.5)
      .moveTo(left(doc), y - 5)
      .lineTo(right(doc), y - 5)
      .stroke();
    doc
      .font(fonts.regular)
      .fontSize(5.9)
      .fillColor(MUTED)
      .text(
        `${COMPANY_NAME} | Folio ${credito.folio} | Pagina ${index + 1} de ${pages.count}`,
        left(doc),
        y,
        { width: width(doc), align: "center", lineBreak: false }
      );
  }
}

export async function buildFirmaSeguroCreditPdf(
  credito: CreditForFirmaSeguroPdf
) {
  const fonts = getPdfFonts();
  const doc = new PDFDocument({
    size: "A4",
    margins: {
      top: PAGE_MARGIN,
      right: PAGE_MARGIN,
      bottom: PAGE_MARGIN,
      left: PAGE_MARGIN,
    },
    bufferPages: true,
    compress: true,
    font: fonts.regular,
    info: {
      Title: `Talonario FINSER PAY ${credito.folio}`,
      Author: COMPANY_NAME,
      Subject: "Documentos para firma electronica certificada por FirmaSeguro",
    },
  });
  const bufferPromise = toBuffer(doc);
  const signedAt = credito.fechaCredito || new Date();
  const date = formatDate(signedAt);
  const equipment =
    credito.referenciaEquipo ||
    `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`.trim() ||
    "-";
  const imei = valueOrDash(credito.imei || credito.deviceUid);
  const financedAmount = Number(credito.montoCredito || 0);
  const financialDisclosure = resolveFirmaSeguroFinancialDisclosure(credito);
  const paymentFrequency = getPaymentFrequencyLabel(credito.frecuenciaPago);
  const compact = { size: 6.35, gap: 3 };

  startPage(
    doc,
    credito,
    1,
    "Autorizacion para el tratamiento de datos personales",
    fonts
  );
  drawIdentityTable(doc, credito, date, fonts);
  writeParagraph(
    doc,
    "El presente documento tiene como finalidad dar cumplimiento a la Ley Estatutaria 1581 de 2012, reglamentada por el Decreto 1377 de 2013 y el Decreto 1081 de 2015, y desarrollar el derecho constitucional de todas las personas a conocer, actualizar y rectificar la informacion recogida sobre ellas en bases de datos o archivos, asi como los derechos previstos en los articulos 15 y 20 de la Constitucion Politica.",
    fonts,
    compact
  );
  writeParagraph(
    doc,
    `${COMPANY_NAME} garantiza el derecho a la privacidad, intimidad y buen nombre en el tratamiento de datos personales. Sus actuaciones se regiran por los principios de legalidad, finalidad, libertad, veracidad o calidad, transparencia, acceso y circulacion restringida, seguridad y confidencialidad. El titular podra conocer, actualizar y rectificar la informacion que suministre con ocasion de relaciones contractuales, comerciales o de cualquier otra naturaleza.`,
    fonts,
    compact
  );
  writeParagraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado(a) con ${valueOrDash(
      credito.clienteTipoDocumento || "CC"
    )} No. ${valueOrDash(
      credito.clienteDocumento
    )}, certifico que lei y comprendi la politica de tratamiento de datos de ${COMPANY_NAME}, disponible en https://finserpay.com/politica-privacidad, y autorizo de manera libre, previa, expresa e informada la recoleccion, almacenamiento, consulta, actualizacion, uso, circulacion, transmision y conservacion de mis datos para validar mi identidad, estudiar y administrar el credito, gestionar pagos y cartera, prevenir fraude, atender requerimientos y conservar las evidencias del proceso digital.`,
    fonts,
    compact
  );
  writeParagraph(
    doc,
    `En cumplimiento de la Ley 2300 de 2023, autorizo a ${COMPANY_NAME} para realizar gestiones comerciales o de cobranza de lunes a viernes de 7:00 a. m. a 7:00 p. m. y los sabados de 8:00 a. m. a 3:00 p. m., por medios fisicos, tecnologicos o electronicos.`,
    fonts,
    compact
  );
  writeParagraph(
    doc,
    `Autorizo a ${COMPANY_NAME}, REVIEW COLOMBIA S.A.S. o al tercero que la sociedad designe para administrar sus bases de datos, a consultar informacion personal, financiera, crediticia, comercial y de seguridad social ante fuentes publicas o privadas y operadores legalmente autorizados, y a reportar, actualizar, rectificar y compartir mi comportamiento de pago en los terminos de la Ley 1266 de 2008. Tambien autorizo recibir informacion comercial, legal, de seguridad y avisos previos a reportes negativos mediante mensajes de texto, correo electronico, medios tecnologicos o comunicaciones fisicas enviados a los datos registrados.`,
    fonts,
    compact
  );
  drawSignature(doc, credito, fonts);

  startPage(doc, credito, 2, "Pagare", fonts);
  writeOpenLine(doc, "FECHA", date, fonts);
  writeOpenLine(
    doc,
    "Valor",
    "$ _________________________________, ______________________________________________ pesos",
    fonts
  );
  writeOpenLine(
    doc,
    "Yo",
    "________________________________________________ identificado como aparece al pie de mi firma, obrando en mi propio nombre, hago las siguientes declaraciones",
    fonts
  );
  writeSection(doc, "Primera - Objeto", fonts);
  writeParagraph(
    doc,
    `Por virtud del presente titulo valor pagare, debo y pagare incondicionalmente a la orden de ${COMPANY_NAME}, identificada con NIT ${COMPANY_NIT}, o a quien represente sus derechos, la suma que sea diligenciada conforme a la carta de instrucciones anexa. El pago se realizara en las oficinas o canales autorizados por ${COMPANY_NAME}.`,
    fonts,
    { size: 7.05, gap: 5 }
  );
  writeSection(doc, "Segunda - Intereses, seguros y fianza", fonts);
  writeParagraph(
    doc,
    `Sobre el saldo de capital reconocere intereses remuneratorios a una tasa efectiva anual de ${formatPercentage(
      financialDisclosure.tasaInteresEa,
      4
    )}. La fianza corresponde a ${formatPercentage(
      financialDisclosure.fianzaTotalPorcentaje,
      6
    )} total del credito, equivalente a ${formatPercentage(
      financialDisclosure.fianzaCuotaPorcentaje,
      6
    )} por cuota, y el seguro a ${formatPercentage(
      financialDisclosure.seguroCuotaPorcentaje,
      6
    )} por cuota. En caso de mora reconocere intereses moratorios sin exceder la maxima tasa legal permitida y los saldos pendientes de seguro y fianza legalmente procedentes.`,
    fonts,
    { size: 7.05, gap: 5 }
  );
  writeSection(doc, "Tercera - Gastos", fonts);
  writeParagraph(
    doc,
    "Todos los gastos que ocasione la cobranza de este titulo valor por mi incumplimiento seran asumidos por mi cuenta. Para constancia se firma en la ciudad de ____________________, a los ______ dias del mes de ____________________ del ano ________.",
    fonts,
    { size: 7.05, gap: 5 }
  );
  drawSignature(doc, credito, fonts, "Firma del deudor");

  startPage(
    doc,
    credito,
    3,
    "Carta de instrucciones abierta anexa a pagare",
    fonts
  );
  writeOpenLine(doc, "FECHA", date, fonts);
  writeOpenLine(
    doc,
    "Valor",
    "$ _________________________________, ______________________________________________ pesos",
    fonts
  );
  writeParagraph(
    doc,
    `Yo, ________________________________________________, mayor de edad, identificado como aparece al pie de mi firma y obrando en mi propio nombre, entrego a ${COMPANY_NAME} un pagare con espacios en blanco y la autorizo de manera irrevocable para que, sin previo aviso, diligencie dichos espacios conforme a las siguientes instrucciones:`,
    fonts,
    { size: 7.05, gap: 6 }
  );
  writeSection(doc, "Valor a pagar", fonts);
  writeParagraph(
    doc,
    "Los espacios en blanco podran ser diligenciados por el acreedor en cualquier fecha en que se incurra en mora de una cuota o en retardo de cualquier obligacion respaldada. El valor correspondera a: a) saldo de capital; b) intereses corrientes, remuneratorios y moratorios causados hasta el dia en que sea completado el pagare; c) saldo de la poliza de seguro de fallecimiento, cuando aplique; y d) saldo pendiente del Fondo de Garantias AFIANZAMOS.",
    fonts,
    { size: 7.05, gap: 6 }
  );
  writeSection(doc, "Fecha de vencimiento e intereses", fonts);
  writeParagraph(
    doc,
    "La fecha de vencimiento sera el dia habil siguiente a la fecha en que sea llenado el pagare. La tasa de interes de plazo sera la vigente al momento de su suscripcion y la tasa moratoria sera la maxima legal permitida. La obligacion se origina en productos, servicios y facilidades de pago adquiridos con FINSER PAY S.A.S.",
    fonts,
    { size: 7.05, gap: 6 }
  );
  writeSection(doc, "Entrega y gastos", fonts);
  writeParagraph(
    doc,
    "El original de esta carta se entrega al tenedor del pagare con sus espacios en blanco y una copia al suscriptor al momento de la firma. Los impuestos que origine el pagare y los gastos de cobranza derivados del incumplimiento estaran a cargo del deudor.",
    fonts,
    { size: 7.05, gap: 6 }
  );
  drawSignature(doc, credito, fonts, "Firma del deudor");

  startPage(
    doc,
    credito,
    4,
    "Autorizacion de bloqueo equipo electronico o bien mueble",
    fonts
  );
  writeParagraph(doc, `SENORES: ${COMPANY_NAME}`, fonts, {
    size: 7,
    gap: 4,
  });
  writeParagraph(
    doc,
    `Yo, ${credito.clienteNombre}, identificado(a) con documento No. ${valueOrDash(
      credito.clienteDocumento
    )}, autorizo expresa, previa e informadamente a ${COMPANY_NAME}, NIT ${COMPANY_NIT}, para bloquear o restringir remotamente el equipo descrito en este documento cuando exista mora de una o mas cuotas de la financiacion.`,
    fonts,
    { size: 6.65, gap: 3 }
  );
  writeParagraph(
    doc,
    "Declaro que el asesor comercial me explico de forma completa que el mecanismo consiste en instalar o asociar al equipo una aplicacion o software de control. Durante el plazo del credito, el terminal podra ser inhabilitado temporalmente hasta que la obligacion se ponga al dia mediante el pago de por lo menos una cuota vencida y pendiente. Autorizo de manera expresa e irrevocable dicha inhabilitacion ante cualquier evento de mora.",
    fonts,
    { size: 6.65, gap: 3 }
  );
  writeParagraph(
    doc,
    `${COMPANY_NAME} debera gestionar la habilitacion del terminal dentro de las 24 horas siguientes a la verificacion del pago de la cuota vencida. Esta restriccion no corresponde al bloqueo de codigo IMEI por hurto o perdida ante operadores de telecomunicaciones, sino exclusivamente a un control de garantia por pago.`,
    fonts,
    { size: 6.65, gap: 3 }
  );
  writeParagraph(
    doc,
    "Autorizo el envio de notificaciones de mora, recordatorios de cuotas y comunicaciones de cobranza mediante la aplicacion o software instalado. Conozco que, cuando sea necesario, el equipo nuevo debera abrirse y encenderse para instalar o validar el mecanismo. Me obligo a no retirar, alterar, evadir ni desinstalar las herramientas de control y dejo el bien financiado como garantia sin tenencia a favor de FINSER PAY S.A.S.",
    fonts,
    { size: 6.65, gap: 4 }
  );
  writeOpenLine(doc, "DIRECCION", valueOrDash(credito.clienteDireccion), fonts, 6.8);
  writeOpenLine(doc, "NOMBRE", credito.clienteNombre, fonts, 6.8);
  writeOpenLine(doc, "TELEFONO", valueOrDash(credito.clienteTelefono), fonts, 6.8);
  writeOpenLine(doc, "CC. O NIT", valueOrDash(credito.clienteDocumento), fonts, 6.8);
  writeOpenLine(doc, "E-MAIL", valueOrDash(credito.clienteCorreo), fonts, 6.8);
  writeOpenLine(doc, "EQUIPO", `${equipment} - IMEI ${imei}`, fonts, 6.8);
  writeOpenLine(doc, "ESTUDIO DE FINANCIACION", credito.folio, fonts, 6.8);
  drawSignature(doc, credito, fonts);

  startPage(
    doc,
    credito,
    5,
    "Aceptacion de la garantia y autorizaciones Fondo de Garantias - Afianzamos Fintech S.A.S.",
    fonts
  );
  writeParagraph(
    doc,
    "El suscrito, ya identificado en este documento, declara:",
    fonts,
    { size: 6.5, gap: 3 }
  );
  writeParagraph(
    doc,
    "a) Que conoce y acepta el servicio de FIANZA prestado por AFIANZAMOS FINTECH S.A.S. (AFIANZAMOS), identificada con NIT 901.229.892, y las condiciones publicadas en http://www.afianzamos.com.co. Acepta de manera expresa e irrevocable el pago de las comisiones, incluido el IVA, derivadas de la fianza. La garantia no extingue su obligacion con FINSER PAY S.A.S.; si AFIANZAMOS paga la deuda garantizada, operara la subrogacion y podra recobrar lo pagado, junto con intereses y gastos legalmente procedentes.",
    fonts,
    { size: 6.45, gap: 3 }
  );
  writeParagraph(
    doc,
    "b) Autoriza a AFIANZAMOS o a quien ostente la calidad de acreedor para consultar informacion financiera, crediticia, comercial, de servicios y proveniente de otros paises, relacionada con el sistema financiero, comercial o de cualquier sector, bajo la Ley 1266 de 2008. Autoriza igualmente a reportar, actualizar, solicitar, compartir y divulgar su comportamiento crediticio ante operadores y fuentes de informacion legalmente establecidos en Colombia.",
    fonts,
    { size: 6.45, gap: 3 }
  );
  writeParagraph(
    doc,
    "c) Declara que los recursos destinados al pago de la obligacion y de las comisiones tienen origen licito, que la informacion suministrada es veraz y que autoriza su verificacion. Autoriza a FINSER PAY S.A.S. a entregar a AFIANZAMOS la informacion relacionada con la operacion afianzada, y a AFIANZAMOS a compartirla con quienes realicen la administracion y cobranza de la cartera, conforme a la normativa colombiana.",
    fonts,
    { size: 6.45, gap: 3 }
  );
  writeParagraph(
    doc,
    "d) Declara que conoce y acepta la politica de tratamiento de datos personales de AFIANZAMOS publicada en http://www.afianzamos.com.co. Podra ejercer sus derechos mediante peticion al correo notificaciones@afianzamos.com.co, en la Cr 48 #6-159 Oficina 25 Santorini, Neiva (Huila), o en el telefono 3205630814 en horario de lunes a viernes. Esta aceptacion estara vigente durante la fianza, la obligacion garantizada y los terminos legales de conservacion.",
    fonts,
    { size: 6.45, gap: 3 }
  );
  drawSignature(doc, credito, fonts, "Firma del deudor");

  startPage(
    doc,
    credito,
    6,
    "Endoso / Contrato de arrendamiento de equipo celular con opcion de compra",
    fonts
  );
  writeParagraph(
    doc,
    `PARTES. ARRENDADOR: ${COMPANY_NAME}, NIT ${COMPANY_NIT}. ARRENDATARIO: ${credito.clienteNombre}, documento No. ${valueOrDash(
      credito.clienteDocumento
    )}.`,
    fonts,
    { size: 6.15, gap: 2.5 }
  );
  writeParagraph(
    doc,
    `1. OBJETO. Arrendamiento con opcion de compra del equipo ${equipment}, identificado con IMEI o Device UID ${imei}, durante ${valueOrDash(
      credito.plazoMeses
    )} periodos a partir de la entrega. 2. EQUIPO. Valor comercial: ${formatCurrency(
      credito.valorEquipoTotal
    )}. Cuota inicial: ${formatCurrency(credito.cuotaInicial)}.`,
    fonts,
    { size: 6.15, gap: 2.5 }
  );
  writeParagraph(
    doc,
    `3. OBLIGACIONES. El arrendador entregara el equipo operativo y garantizara su funcionamiento, salvo danos por mal uso. El arrendatario pagara ${valueOrDash(
      credito.plazoMeses
    )} cuotas con valor exacto de referencia de ${formatExactCurrency(
      financialDisclosure.cuotaExacta
    )} y cuota comercial informativa de ${formatCurrency(
      financialDisclosure.cuotaComercial
    )}${
      financialDisclosure.redondeoComercialModo === "PISO" &&
      Number(financialDisclosure.redondeoComercialMultiplo || 0) > 0
        ? `, calculada al piso en multiplos de ${formatCurrency(
            financialDisclosure.redondeoComercialMultiplo
          )}`
        : ""
    }, con frecuencia ${paymentFrequency.toLowerCase()}. El plan exacto determina el recaudo y la ultima cuota puede ajustarse por centavos. El arrendatario conservara el equipo en buen estado y no lo subarrendara, no alterara su IMEI ni retirara los controles instalados.`,
    fonts,
    { size: 6.15, gap: 2.5 }
  );
  writeParagraph(
    doc,
    `4. PAGOS Y PENALIZACIONES. La obligacion total corresponde a ${formatExactCurrency(
      financedAmount
    )}. La mora causara intereses hasta la maxima tasa legal vigente. La perdida o hurto no extingue el deber de pagar las cuotas pendientes. Cualquier descuento por pago anticipado debera constar por escrito. 5. OPCION DE COMPRA. El precio final y las condiciones de ejercicio seran los que consten en el plan y en los acuerdos escritos entre las partes.`,
    fonts,
    { size: 6.15, gap: 2.5 }
  );
  writeParagraph(
    doc,
    "6. TERMINACION. El contrato terminara por vencimiento del plazo, incumplimiento, muerte del arrendatario o ejercicio de la opcion de compra. 7. BLOQUEO REMOTO. El arrendatario autoriza la inhabilitacion temporal por mora, sin afectar llamadas de emergencia, y la reactivacion dentro de las 24 horas siguientes a la verificacion del pago. 8. GENERALES. Se aplica la ley colombiana y toda modificacion debera constar por escrito.",
    fonts,
    { size: 6.15, gap: 2.5 }
  );
  writeSection(doc, "Clausula penal por vulneracion de seguridad", fonts, {
    gapTop: 1,
  });
  writeParagraph(
    doc,
    "El arrendatario reconoce que cualquier intento de vulnerar la seguridad del equipo, incluido desbloqueo no autorizado, jailbreak, root, alteracion de firmware o del software de control remoto, asi como el desenrolamiento, eliminacion, desinstalacion o modificacion no autorizada del sistema de gestion, generara una penalidad equivalente al 20% del valor comercial por cada evento detectado, sin perjuicio de la terminacion inmediata, el pago de las cuotas pendientes y las acciones legales por danos. El arrendador podra verificar remotamente la integridad del software.",
    fonts,
    { size: 6.05, gap: 2.5 }
  );
  writeSection(
    doc,
    "Declaracion unica de aceptacion y ratificacion mediante firma digital",
    fonts,
    { gapTop: 1 }
  );
  writeParagraph(
    doc,
    "Declaro que lei, comprendi y acepto integralmente este talonario; que recibi informacion clara sobre plazo, cuotas, intereses, costos y consecuencias del incumplimiento; y que con una sola firma electronica ratifico el pagare y su carta de instrucciones, la autorizacion de tratamiento de datos, la autorizacion de bloqueo, la aceptacion de la garantia de AFIANZAMOS y este contrato. Reconozco la validez juridica y probatoria de la firma electronica y del certificado de FirmaSeguro conforme a la Ley 527 de 1999 y las normas concordantes.",
    fonts,
    { size: 6.05, gap: 2.5 }
  );
  drawSignature(doc, credito, fonts, "Firma digital del cliente");

  drawFooters(doc, credito, fonts);
  const pageCount = doc.bufferedPageRange().count;
  if (pageCount !== PAGE_TOTAL) {
    throw new Error(
      `El talonario ${credito.folio} genero ${pageCount} paginas y debe generar ${PAGE_TOTAL}`
    );
  }

  doc.end();
  return bufferPromise;
}
