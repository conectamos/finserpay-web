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
  fechaPrimerPago?: Date | string | null;
  referenciaPago?: string | null;
  valorFianza?: number | null;
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

function ensureSpace(doc: PDFKit.PDFDocument, height: number) {
  if (doc.y + height <= doc.page.height - doc.page.margins.bottom) {
    return;
  }

  doc.addPage();
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
  const deudor = `${credito.clienteNombre} | ${tipoDocumento} ${
    credito.clienteDocumento || "-"
  }`;
  const asesor = credito.vendedor?.nombre || credito.usuario.nombre;
  const pagareNumero = getPagareNumber(credito);

  doc.save().roundedRect(42, 42, 511, 126, 22).fill("#F8FAFC").restore();
  doc.save().roundedRect(42, 42, 8, 126, 4).fill("#111827").restore();
  doc.font(fonts.bold).fontSize(10).fillColor("#0F766E").text("FINSER PAY", 66, 58);
  doc
    .font(fonts.bold)
    .fontSize(24)
    .fillColor("#0F172A")
    .text("Paquete documental unico", 66, 78, { width: 430 });
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
  sectionTitle(doc, "Documento unico para FirmaSeguro", fonts);
  paragraph(
    doc,
    "Este PDF consolida en un solo archivo el contrato de financiacion, pagare, carta de instrucciones, autorizaciones de datos, fianza, control tecnologico y evidencias del credito. La firma electronica del cliente aplica sobre el paquete documental completo.",
    fonts
  );

  sectionTitle(doc, "Ficha del credito", fonts);
  keyValueGrid(
    doc,
    [
      { label: "Cliente", value: credito.clienteNombre },
      { label: "Documento", value: `${tipoDocumento} ${credito.clienteDocumento || "-"}` },
      { label: "Telefono", value: credito.clienteTelefono || "-" },
      { label: "Correo", value: credito.clienteCorreo || "-" },
      { label: "Equipo", value: credito.referenciaEquipo || `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`.trim() || "-" },
      { label: "IMEI", value: credito.imei || credito.deviceUid || "-" },
      { label: "Valor equipo", value: formatCurrency(credito.valorEquipoTotal) },
      { label: "Valor credito", value: formatCurrency(credito.montoCredito) },
      { label: "Cuota inicial", value: formatCurrency(credito.cuotaInicial) },
      { label: "Valor cuota", value: formatCurrency(credito.valorCuota) },
      { label: "Plazo", value: `${credito.plazoMeses || "-"} cuotas` },
      { label: "Frecuencia", value: getPaymentFrequencyLabel(credito.frecuenciaPago) },
      { label: "Primer pago", value: formatDate(credito.fechaPrimerPago) },
      { label: "Referencia pago", value: credito.referenciaPago || credito.clienteDocumento || "-" },
    ],
    fonts
  );

  sectionTitle(doc, "Contrato de financiacion", fonts);
  paragraph(
    doc,
    `Entre FINSER PAY S.A.S., identificada con NIT 902052909-4, como acreedor y administrador de la obligacion, y ${deudor}, como deudor, se celebra contrato de financiacion para la adquisicion del equipo descrito en este documento. El deudor declara que recibio informacion clara sobre valor del equipo, cuota inicial, monto financiado, plazo, frecuencia, intereses, fianza y medios de pago.`,
    fonts
  );
  paragraph(
    doc,
    `El valor del credito corresponde a ${formatCurrency(
      credito.montoCredito
    )}. La cuota pactada es de ${formatCurrency(
      credito.valorCuota
    )}, con frecuencia ${getPaymentFrequencyLabel(
      credito.frecuenciaPago
    )}, iniciando el ${formatDate(credito.fechaPrimerPago)}.`,
    fonts
  );
  paragraph(
    doc,
    "El deudor acepta que el incumplimiento de sus obligaciones de pago habilita a FINSER PAY S.A.S. para realizar gestion de cobranza, reportes permitidos por la ley, y activar controles tecnologicos de proteccion del equipo cuando aplique al servicio contratado.",
    fonts
  );

  sectionTitle(doc, "Pagare", fonts);
  paragraph(
    doc,
    `PAGARE No. ${pagareNumero}. Yo, ${deudor}, prometo pagar incondicionalmente a favor de FINSER PAY S.A.S. o a quien represente sus derechos, la suma derivada del credito otorgado, junto con intereses, fianza, gastos y demas conceptos legalmente exigibles conforme al plan financiero aceptado.`,
    fonts
  );
  paragraph(
    doc,
    "Este pagare presta merito ejecutivo. En caso de mora o incumplimiento, el acreedor podra exigir el pago total de la obligacion pendiente, descontando los pagos realizados y aplicando las reglas pactadas en el contrato.",
    fonts
  );

  sectionTitle(doc, "Carta de instrucciones", fonts);
  paragraph(
    doc,
    `El deudor autoriza expresamente a FINSER PAY S.A.S. para diligenciar los espacios en blanco del pagare No. ${pagareNumero}, incluyendo valor total, fechas, cuotas, intereses, fianza, gastos, vencimiento y demas datos necesarios para hacer efectiva la obligacion, conforme a las condiciones reales del credito y a los saldos pendientes al momento de su exigibilidad.`,
    fonts
  );
  paragraph(
    doc,
    "La autorizacion se otorga de manera libre, voluntaria e irrevocable mientras exista saldo pendiente, sin perjuicio de los derechos legales del deudor para conocer, controvertir y solicitar soporte de la liquidacion aplicada.",
    fonts
  );

  sectionTitle(doc, "Fianza, autorizaciones y datos personales", fonts);
  paragraph(
    doc,
    `El deudor reconoce que dentro de la operacion puede existir un valor de fianza por ${formatCurrency(
      credito.valorFianza
    )}, destinado a respaldar riesgos de la obligacion segun las condiciones pactadas. Tambien autoriza el tratamiento de sus datos personales para estudio, originacion, administracion del credito, cobranza, verificacion de identidad, reportes permitidos y contacto comercial relacionado con la obligacion.`,
    fonts
  );
  paragraph(
    doc,
    "La informacion sera tratada conforme a la Ley 1581 de 2012, Decreto 1377 de 2013 y demas normas aplicables. El titular puede solicitar acceso, actualizacion, rectificacion o supresion conforme a los canales definidos por FINSER PAY S.A.S.",
    fonts
  );

  sectionTitle(doc, "Aceptacion electronica", fonts);
  paragraph(
    doc,
    "El deudor acepta que la firma electronica realizada por medio de FirmaSeguro, con autenticacion OTP y evidencias del proceso, tiene validez para acreditar su aceptacion del paquete documental unico, incluyendo contrato, pagare, carta de instrucciones, fianza, control tecnologico, tratamiento de datos y demas autorizaciones incluidas en este expediente.",
    fonts
  );
  signatureBlock(doc, "Firma del deudor", deudor, fonts);
  signatureBlock(
    doc,
    "Firma del acreedor",
    "FINSER PAY S.A.S. | NIT 902052909-4",
    fonts
  );

  doc.end();
  return bufferPromise;
}
