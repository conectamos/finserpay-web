import { createHash } from "node:crypto";
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

function formatCurrency(value: number) {
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

function getSnapshotReferences(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return [];
  }

  const root = snapshot as Record<string, unknown>;
  const cliente =
    typeof root.cliente === "object" && root.cliente !== null
      ? (root.cliente as Record<string, unknown>)
      : null;
  const references = Array.isArray(cliente?.referenciasFamiliares)
    ? cliente.referenciasFamiliares
    : [];

  return references
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return null;
      }

      const record = item as Record<string, unknown>;

      return {
        nombre: typeof record.nombre === "string" ? record.nombre : "",
        parentesco:
          typeof record.parentesco === "string" ? record.parentesco : "",
        telefono: typeof record.telefono === "string" ? record.telefono : "",
      };
    })
    .filter(
      (item): item is { nombre: string; parentesco: string; telefono: string } =>
        Boolean(item?.nombre || item?.parentesco || item?.telefono)
    );
}

function getSnapshotRoot(snapshot: unknown) {
  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }

  return snapshot as Record<string, unknown>;
}

function getSnapshotAuthenticity(snapshot: unknown) {
  const root = getSnapshotRoot(snapshot);
  const evidencia =
    typeof root?.evidencia === "object" && root.evidencia !== null
      ? (root.evidencia as Record<string, unknown>)
      : null;
  const autenticidad =
    typeof evidencia?.autenticidad === "object" && evidencia.autenticidad !== null
      ? (evidencia.autenticidad as Record<string, unknown>)
      : null;

  return {
    autenticadoCon: Array.isArray(autenticidad?.autenticadoCon)
      ? autenticidad.autenticadoCon
          .filter((item): item is string => typeof item === "string" && Boolean(item))
          .join(", ")
      : "Correo electronico, Direccion IP, Fotografia",
    email: typeof autenticidad?.email === "string" ? autenticidad.email : "",
    ip: typeof autenticidad?.ip === "string" ? autenticidad.ip : "",
    firmadoAt: typeof autenticidad?.firmadoAt === "string" ? autenticidad.firmadoAt : "",
    documento:
      typeof autenticidad?.documento === "string" ? autenticidad.documento : "",
  };
}

function getSnapshotEvidenceAudit(snapshot: unknown, key: string) {
  const root = getSnapshotRoot(snapshot);
  const evidencia =
    typeof root?.evidencia === "object" && root.evidencia !== null
      ? (root.evidencia as Record<string, unknown>)
      : null;
  const section =
    typeof evidencia?.[key] === "object" && evidencia[key] !== null
      ? (evidencia[key] as Record<string, unknown>)
      : null;

  return {
    registrada: Boolean(section?.registrada),
    capturedAt:
      typeof section?.capturedAt === "string" ? section.capturedAt : "",
    source: typeof section?.source === "string" ? section.source : "",
    ip: typeof section?.ip === "string" ? section.ip : "",
    email: typeof section?.email === "string" ? section.email : "",
  };
}

function dataUrlToBuffer(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const match = value.match(/^data:(.+?);base64,(.+)$/);

  if (!match) {
    return null;
  }

  try {
    return Buffer.from(match[2], "base64");
  } catch {
    return null;
  }
}

function addSectionTitle(doc: PDFKit.PDFDocument, title: string, fonts: ReturnType<typeof getPdfFonts>) {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.font(fonts.bold).fontSize(15).fillColor("#0F172A").text(title);
  doc.moveDown(0.3);
}

function addParagraph(
  doc: PDFKit.PDFDocument,
  text: string,
  fonts: ReturnType<typeof getPdfFonts>
) {
  doc.font(fonts.regular).fontSize(10.5).fillColor("#334155").text(text, {
    align: "justify",
    lineGap: 2,
  });
  doc.moveDown(0.45);
}

function addFieldGrid(
  doc: PDFKit.PDFDocument,
  items: Array<{ label: string; value: string }>,
  fonts: ReturnType<typeof getPdfFonts>
) {
  for (const item of items) {
    ensureSpace(doc, 26);
    doc.font(fonts.bold).fontSize(9).fillColor("#64748B").text(item.label);
    doc.font(fonts.regular).fontSize(11).fillColor("#0F172A").text(item.value);
    doc.moveDown(0.25);
  }
}

function addEvidenceImage(
  doc: PDFKit.PDFDocument,
  title: string,
  dataUrl: string | null | undefined,
  audit:
    | {
        capturedAt?: string;
        email?: string;
        ip?: string;
        source?: string;
      }
    | null,
  fonts: ReturnType<typeof getPdfFonts>
) {
  const imageBuffer = dataUrlToBuffer(dataUrl);
  ensureSpace(doc, imageBuffer ? 320 : 140);
  doc.font(fonts.bold).fontSize(12).fillColor("#0F172A").text(title);
  doc.moveDown(0.4);

  if (!imageBuffer) {
    doc
      .font(fonts.regular)
      .fontSize(10.5)
      .fillColor("#64748B")
      .text("No hay evidencia cargada para este documento.");
    if (audit) {
      doc.moveDown(0.35);
      addFieldGrid(
        doc,
        [
          { label: "Capturado", value: formatDate(audit.capturedAt) },
          { label: "IP", value: audit.ip || "-" },
          { label: "Correo", value: audit.email || "-" },
          {
            label: "Origen",
            value:
              audit.source === "camera"
                ? "Camara"
                : audit.source === "upload"
                  ? "Archivo"
                  : audit.source === "signature"
                    ? "Firma digital"
                    : audit.source || "-",
          },
        ],
        fonts
      );
    }
    doc.moveDown(0.6);
    return;
  }

  const startY = doc.y;
  doc.save().roundedRect(40, startY, 515, 220, 16).fillAndStroke("#FFFFFF", "#E2E8F0").restore();
  doc.image(imageBuffer, 52, startY + 12, {
    fit: [491, 196],
    align: "center",
    valign: "center",
  });
  doc.y = startY + 228;
  if (audit) {
    addFieldGrid(
      doc,
      [
        { label: "Capturado", value: formatDate(audit.capturedAt) },
        { label: "IP", value: audit.ip || "-" },
        { label: "Correo", value: audit.email || "-" },
        {
          label: "Origen",
          value:
            audit.source === "camera"
              ? "Camara"
              : audit.source === "upload"
                ? "Archivo"
                : audit.source === "signature"
                  ? "Firma digital"
                  : audit.source || "-",
        },
      ],
      fonts
    );
  }
  doc.moveDown(0.4);
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
        { error: "Solo supervisor o administrador puede descargar el expediente" },
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

    if (!credito) {
      return NextResponse.json({ error: "Credito no encontrado" }, { status: 404 });
    }

    const fonts = getPdfFonts();
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      compress: true,
      font: fonts.regular,
      info: {
        Title: `Expediente ${credito.folio}`,
        Author: "FINSER PAY",
      },
    });
    const bufferPromise = toBuffer(doc);
    const snapshot = getSnapshotRoot(credito.contratoSnapshot);
    const pagareSnapshot =
      typeof snapshot?.pagare === "object" && snapshot.pagare !== null
        ? (snapshot.pagare as Record<string, unknown>)
        : null;
    const pagareNumeroPdf =
      typeof pagareSnapshot?.numero === "string" && pagareSnapshot.numero.trim()
        ? pagareSnapshot.numero
        : credito.folio;
    const references = getSnapshotReferences(credito.contratoSnapshot);
    const authenticity = getSnapshotAuthenticity(credito.contratoSnapshot);
    const selfieAudit = getSnapshotEvidenceAudit(credito.contratoSnapshot, "selfie");
    const cedulaFrenteAudit = getSnapshotEvidenceAudit(
      credito.contratoSnapshot,
      "cedulaFrente"
    );
    const cedulaRespaldoAudit = getSnapshotEvidenceAudit(
      credito.contratoSnapshot,
      "cedulaRespaldo"
    );
    const documentHash = createHash("sha256")
      .update(JSON.stringify(credito.contratoSnapshot || {}))
      .digest("hex");

    doc.save().roundedRect(40, 40, 515, 124, 22).fill("#F8FAFC").restore();
    doc.save().roundedRect(40, 40, 8, 124, 4).fill("#111827").restore();
    doc.font(fonts.bold).fontSize(11).fillColor("#64748B").text("EXPEDIENTE DIGITAL", 64, 56);
    doc.font(fonts.bold).fontSize(26).fillColor("#0F172A").text("Credito y documentos firmados", 64, 76);
    doc
      .font(fonts.regular)
      .fontSize(10.5)
      .fillColor("#475569")
      .text(
        `Folio: ${credito.folio}\nCliente: ${credito.clienteNombre}\nDocumento: ${
          credito.clienteDocumento || "-"
        }\nSede: ${credito.sede.nombre}\nAsesor: ${
          credito.vendedor?.nombre || credito.usuario.nombre
        }`,
        64,
        112
      );

    doc.y = 192;

    addSectionTitle(doc, "1. Ficha del cliente", fonts);
    addFieldGrid(
      doc,
      [
        { label: "Nombre completo", value: credito.clienteNombre },
        { label: "Tipo de documento", value: credito.clienteTipoDocumento || "-" },
        { label: "Documento", value: credito.clienteDocumento || "-" },
        { label: "Telefono", value: credito.clienteTelefono || "-" },
        { label: "Correo", value: credito.clienteCorreo || "-" },
        { label: "Direccion", value: credito.clienteDireccion || "-" },
        {
          label: "Ubicacion",
          value:
            [credito.clienteCiudad, credito.clienteDepartamento].filter(Boolean).join(", ") ||
            "-",
        },
        { label: "Genero", value: credito.clienteGenero || "-" },
        { label: "Fecha de nacimiento", value: formatDate(credito.clienteFechaNacimiento) },
        { label: "Fecha de expedicion", value: formatDate(credito.clienteFechaExpedicion) },
      ],
      fonts
    );

    addSectionTitle(doc, "2. Autenticidad e integridad", fonts);
    addFieldGrid(
      doc,
      [
        {
          label: "Autenticado con",
          value: authenticity.autenticadoCon,
        },
        { label: "Correo", value: authenticity.email || credito.clienteCorreo || "-" },
        { label: "IP", value: authenticity.ip || credito.contratoIp || "-" },
        {
          label: "Firmado",
          value: formatDate(authenticity.firmadoAt || credito.contratoAceptadoAt),
        },
        {
          label: "Numero de documento",
          value: authenticity.documento || credito.clienteDocumento || "-",
        },
        {
          label: "Funcion hash",
          value: documentHash,
        },
      ],
      fonts
    );
    addParagraph(
      doc,
      "El expediente puede consultarse por su folio y numero de identificacion dentro del panel de FINSER PAY, conservando integridad documental, trazabilidad de IP y evidencia fotografica del proceso.",
      fonts
    );

    addSectionTitle(doc, "3. Referencias familiares", fonts);
    if (references.length) {
      references.forEach((reference, index) => {
        addFieldGrid(
          doc,
          [
            {
              label: `Referencia ${index + 1}`,
              value: `${reference.nombre} | ${reference.parentesco} | ${reference.telefono}`,
            },
          ],
          fonts
        );
      });
    } else {
      addParagraph(doc, "No se encontraron referencias familiares registradas en el snapshot del contrato.", fonts);
    }

    addSectionTitle(doc, "4. Resumen del credito", fonts);
    addFieldGrid(
      doc,
      [
        { label: "Equipo", value: credito.referenciaEquipo || "-" },
        { label: "IMEI / Device UID", value: `${credito.imei} / ${credito.deviceUid}` },
        { label: "Valor total del equipo", value: formatCurrency(credito.valorEquipoTotal) },
        { label: "Cuota inicial", value: formatCurrency(credito.cuotaInicial) },
        { label: "Credito autorizado", value: formatCurrency(credito.saldoBaseFinanciado) },
        { label: "Interes estimado", value: formatCurrency(credito.valorInteres) },
        {
          label: `FIANCO ${credito.fianzaPorcentaje}%`,
          value: formatCurrency(credito.valorFianza),
        },
        { label: "Valor total a pagar", value: formatCurrency(credito.montoCredito) },
        { label: "Numero de cuotas", value: String(credito.plazoMeses || "-") },
        { label: "Valor de cada cuota", value: formatCurrency(credito.valorCuota) },
        { label: "Primer pago", value: formatDate(credito.fechaPrimerPago) },
        { label: "Referencia de pago", value: credito.referenciaPago || "-" },
      ],
      fonts
    );

    doc.addPage();

    addSectionTitle(
      doc,
      "5. Contrato de financiacion de equipo movil, tratamiento de datos y herramientas tecnologicas",
      fonts
    );
    addParagraph(
      doc,
      "FINSER PAY S.A.S. | NIT: 902052909-4 | Domicilio: Ibague - Tolima.",
      fonts
    );
    addParagraph(
      doc,
      `Entre los suscritos a saber: EL ACREEDOR, FINSER PAY S.A.S.; y EL DEUDOR, ${credito.clienteNombre}, identificado con ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} No. ${credito.clienteDocumento || "documento no registrado"}.`,
      fonts
    );
    addParagraph(
      doc,
      `1. OBJETO. El ACREEDOR financia al DEUDOR la adquisicion del equipo movil ${credito.referenciaEquipo || `${credito.equipoMarca || ""} ${credito.equipoModelo || ""}`.trim() || "-"}, IMEI ${credito.imei}, por valor total de ${formatCurrency(credito.valorEquipoTotal)}, con cuota inicial de ${formatCurrency(credito.cuotaInicial)} y valor financiado de ${formatCurrency(credito.saldoBaseFinanciado)}.`,
      fonts
    );
    addParagraph(
      doc,
      `2. CONDICIONES DEL CREDITO. Total a pagar: ${formatCurrency(credito.montoCredito)}. Total fianza a pagar: ${formatCurrency(credito.valorFianza)}. Numero de cuotas: ${credito.plazoMeses || "-"}. Valor por cuota: ${formatCurrency(credito.valorCuota)}. Fecha primer pago: ${formatDate(credito.fechaPrimerPago)}. El incumplimiento de una o mas cuotas dara lugar a exigibilidad inmediata, intereses de mora y gastos de cobranza.`,
      fonts
    );
    addParagraph(
      doc,
      "3. NATURALEZA DEL CONTRATO. El presente contrato es de caracter comercial y privado, no constituye actividad financiera vigilada por la Superintendencia Financiera, sino una financiacion directa entre particulares.",
      fonts
    );
    addParagraph(
      doc,
      "4. AUTORIZACION DE TRATAMIENTO DE DATOS. El DEUDOR autoriza de manera libre, previa, expresa e informada a FINSER PAY S.A.S. para consultar, reportar y actualizar informacion en centrales de riesgo, verificar identidad y comportamiento crediticio, y usar sus datos para gestion de cobro, en cumplimiento de la Ley 1581 de 2012 y normas concordantes.",
      fonts
    );
    addParagraph(
      doc,
      "5. AUTORIZACION DE HERRAMIENTAS TECNOLOGICAS. El DEUDOR acepta que el equipo financiado podra contar con restricciones de uso, configuraciones de seguridad y limitaciones operativas en caso de incumplimiento, como mecanismo de gestion del riesgo y garantia del credito.",
      fonts
    );
    addParagraph(
      doc,
      "6. DECLARACIONES DEL DEUDOR. El DEUDOR manifiesta que ha leido y comprendido el contrato, acepta voluntariamente las condiciones, recibe el equipo en perfecto estado y declara que la informacion suministrada es veraz.",
      fonts
    );
    addParagraph(
      doc,
      "7. MERITO EJECUTIVO. El presente contrato presta merito ejecutivo conforme a la ley, junto con el pagare suscrito.",
      fonts
    );
    addParagraph(
      doc,
      `8. FIRMA ELECTRONICA. El DEUDOR acepta que la firma realizada mediante codigo OTP, registro de IP, correo electronico y evidencia fotografica constituye firma valida conforme a la Ley 527 de 1999. OTP: ${credito.contratoOtpVerificadoAt ? `verificado ${formatDate(credito.contratoOtpVerificadoAt)}` : "sin verificacion OTP"}.`,
      fonts
    );
    addParagraph(
      doc,
      "9. JURISDICCION. Para todos los efectos legales, las partes fijan como domicilio la ciudad de Ibague - Tolima.",
      fonts
    );
    addParagraph(
      doc,
      `10. ACEPTACION. El presente contrato se entiende aceptado electronicamente por el DEUDOR en la fecha ${formatDate(credito.contratoAceptadoAt)}, quedando registro digital verificable. IP: ${credito.contratoIp || "-"}.`,
      fonts
    );
    addParagraph(
      doc,
      `FINSER PAY S.A.S. | EL DEUDOR: ${credito.clienteNombre} | ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} ${credito.clienteDocumento || "-"}.`,
      fonts
    );

    /*
    addSectionTitle(doc, "6. Pagare digital", fonts);
    addParagraph(
      doc,
      `${credito.clienteNombre} se obliga de manera incondicional a pagar a la orden de FINSER PAY S.A.S. la suma de ${formatCurrency(credito.montoCredito)}, en ${credito.plazoMeses || "-"} cuotas de ${formatCurrency(credito.valorCuota)}. El pagaré presta merito ejecutivo y autoriza el diligenciamiento de espacios en blanco conforme al credito otorgado.`,
      fonts
    );
    addParagraph(
      doc,
      `Aceptacion del pagare: ${formatDate(credito.pagareAceptadoAt)}.`,
      fonts
    );

    */

    addSectionTitle(doc, "6. Pagare digital", fonts);
    addParagraph(
      doc,
      `PAGARE No. ${pagareNumeroPdf}. Yo, ${credito.clienteNombre}, identificado con ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} No. ${credito.clienteDocumento || "documento no registrado"}, actuando en calidad de DEUDOR, me obligo de manera clara, expresa e incondicional a pagar a la orden de FINSER PAY S.A.S., NIT 902052909-4, la suma de ${formatCurrency(credito.montoCredito)} (PESOS COLOMBIANOS).`,
      fonts
    );
    addParagraph(
      doc,
      `1. FORMA DE PAGO. La suma sera cancelada en ${credito.plazoMeses || "-"} cuotas de ${formatCurrency(credito.valorCuota)} cada una, con fecha de inicio ${formatDate(credito.fechaPrimerPago)}.`,
      fonts
    );
    addParagraph(
      doc,
      "2. VENCIMIENTO ANTICIPADO. El incumplimiento en el pago de una sola cuota dara derecho al ACREEDOR a declarar vencido el plazo y exigir el pago inmediato del saldo total de la obligacion.",
      fonts
    );
    addParagraph(
      doc,
      "3. INTERESES. En caso de mora, se causaran intereses moratorios a la maxima tasa legal permitida en Colombia.",
      fonts
    );
    addParagraph(
      doc,
      "4. MERITO EJECUTIVO. El presente pagare presta merito ejecutivo conforme a la ley, siendo exigible judicialmente sin necesidad de requerimientos adicionales.",
      fonts
    );
    addParagraph(
      doc,
      "5. RENUNCIA A REQUERIMIENTOS. El DEUDOR renuncia expresamente a requerimientos judiciales y extrajudiciales para la constitucion en mora.",
      fonts
    );
    addParagraph(
      doc,
      "6. GASTOS DE COBRANZA. El DEUDOR asumira todos los gastos de cobranza judicial y extrajudicial en caso de incumplimiento.",
      fonts
    );
    addParagraph(
      doc,
      `7. FIRMA ELECTRONICA. El DEUDOR acepta que este pagare es suscrito mediante mecanismos electronicos validos, incluyendo codigo OTP, direccion IP, correo electronico y evidencia fotografica, de conformidad con la Ley 527 de 1999. OTP: ${credito.contratoOtpVerificadoAt ? `verificado ${formatDate(credito.contratoOtpVerificadoAt)}` : "sin verificacion OTP"}. IP: ${credito.contratoIp || "-"}.`,
      fonts
    );
    addParagraph(
      doc,
      "8. LUGAR DE CUMPLIMIENTO. El pago debera realizarse en la ciudad de Ibague - Tolima.",
      fonts
    );
    addParagraph(
      doc,
      `9. FECHA DE EMISION. ${formatDate(credito.contratoAceptadoAt)}.`,
      fonts
    );
    addParagraph(
      doc,
      `EL DEUDOR: ${credito.clienteNombre} | ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} ${credito.clienteDocumento || "-"}. FINSER PAY S.A.S. | NIT 902052909-4.`,
      fonts
    );

    addSectionTitle(doc, "7. Carta de instrucciones", fonts);
    addParagraph(
      doc,
      `CARTA DE INSTRUCCIONES PARA DILIGENCIAMIENTO DE PAGARE. Yo, ${credito.clienteNombre}, identificado con ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} No. ${credito.clienteDocumento || "documento no registrado"}, en calidad de DEUDOR, autorizo de manera expresa, irrevocable y permanente a FINSER PAY S.A.S., NIT 902052909-4, para diligenciar el pagare suscrito por mi con base en las siguientes instrucciones:`,
      fonts
    );
    addParagraph(
      doc,
      "1. VALOR. El ACREEDOR podra llenar el pagare por el valor total de la obligacion, incluyendo capital, intereses corrientes, intereses de mora, gastos de cobranza y costas judiciales.",
      fonts
    );
    addParagraph(
      doc,
      "2. FECHAS. Podra establecer fecha de exigibilidad, fechas de vencimiento y fecha de mora.",
      fonts
    );
    addParagraph(
      doc,
      "3. VENCIMIENTO ANTICIPADO. En caso de incumplimiento, el ACREEDOR podra declarar vencido el plazo y exigir la totalidad de la obligacion.",
      fonts
    );
    addParagraph(
      doc,
      "4. ESPACIOS EN BLANCO. El DEUDOR autoriza el diligenciamiento de cualquier espacio en blanco del pagare conforme a las condiciones del credito otorgado.",
      fonts
    );
    addParagraph(
      doc,
      "5. USO JUDICIAL. El pagare podra ser utilizado para iniciar procesos ejecutivos sin requerimientos adicionales.",
      fonts
    );
    addParagraph(
      doc,
      "6. IRREVOCABILIDAD. La presente autorizacion es irrevocable y se mantendra vigente hasta la cancelacion total de la obligacion.",
      fonts
    );
    addParagraph(
      doc,
      `7. ACEPTACION ELECTRONICA. Esta carta se entiende aceptada mediante mecanismos electronicos validos: OTP, IP, correo y evidencia digital, conforme a la Ley 527 de 1999. OTP: ${credito.contratoOtpVerificadoAt ? `verificado ${formatDate(credito.contratoOtpVerificadoAt)}` : "sin verificacion OTP"}. IP: ${credito.contratoIp || "-"}.`,
      fonts
    );
    addParagraph(
      doc,
      `8. FECHA. ${formatDate(credito.contratoAceptadoAt)}.`,
      fonts
    );
    addParagraph(
      doc,
      `EL DEUDOR: ${credito.clienteNombre} | ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} ${credito.clienteDocumento || "-"}.`,
      fonts
    );

    doc.addPage();

    addSectionTitle(doc, "8. Autorizacion de tratamiento de datos personales", fonts);
    addParagraph(
      doc,
      `AUTORIZACION PARA EL TRATAMIENTO DE DATOS PERSONALES (Ley 1581 de 2012 y Decreto 1377 de 2013). FINSER PAY S.A.S., NIT 902052909-4, Domicilio: Ibague - Tolima. En calidad de titular de la informacion, yo, ${credito.clienteNombre}, identificado con ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} No. ${credito.clienteDocumento || "documento no registrado"}, autorizo de manera previa, expresa e informada a FINSER PAY S.A.S. para recolectar, almacenar, usar, circular, actualizar y suprimir mis datos personales conforme a las siguientes condiciones:`,
      fonts
    );
    addParagraph(
      doc,
      "1. FINALIDAD DEL TRATAMIENTO. Mis datos seran utilizados para evaluacion y aprobacion de solicitudes de credito, gestion de cobranza judicial y extrajudicial, consulta, reporte y actualizacion en centrales de riesgo, verificacion de identidad, prevencion de fraude, gestion comercial y contacto, y cumplimiento de obligaciones contractuales.",
      fonts
    );
    addParagraph(
      doc,
      "2. DATOS TRATADOS. Autorizo el tratamiento de datos personales basicos, datos financieros y crediticios, informacion de contacto, datos biometricos como fotografia y selfie, y datos tecnicos como direccion IP, dispositivo y geolocalizacion.",
      fonts
    );
    addParagraph(
      doc,
      "3. CENTRALES DE RIESGO. Autorizo de manera expresa a FINSER PAY S.A.S. para consultar mi informacion en centrales de riesgo, reportar mi comportamiento de pago, y actualizar y compartir dicha informacion con terceros autorizados.",
      fonts
    );
    addParagraph(
      doc,
      "4. DERECHOS DEL TITULAR. Tengo derecho a conocer, actualizar y rectificar mis datos, solicitar prueba de esta autorizacion, ser informado del uso de mis datos, revocar la autorizacion y/o solicitar la supresion, y acceder gratuitamente a mis datos.",
      fonts
    );
    addParagraph(
      doc,
      "5. MEDIDAS DE SEGURIDAD. FINSER PAY S.A.S. implementara medidas de seguridad para proteger la informacion contra acceso no autorizado, perdida o alteracion.",
      fonts
    );
    addParagraph(
      doc,
      "6. TRANSFERENCIA Y TRANSMISION. Autorizo que mis datos puedan ser compartidos con aliados comerciales, plataformas tecnologicas, entidades de cobranza y operadores de verificacion, unicamente para las finalidades aqui descritas.",
      fonts
    );
    addParagraph(
      doc,
      "7. VIGENCIA. La presente autorizacion permanecera vigente durante la relacion contractual y hasta por el tiempo necesario para el cumplimiento de obligaciones legales.",
      fonts
    );
    addParagraph(
      doc,
      `8. ACEPTACION ELECTRONICA. Esta autorizacion se otorga mediante mecanismos electronicos validos como codigo OTP, direccion IP, correo electronico y evidencia digital, de conformidad con la Ley 527 de 1999. OTP: ${credito.contratoOtpVerificadoAt ? `verificado ${formatDate(credito.contratoOtpVerificadoAt)}` : "sin verificacion OTP"}. IP: ${credito.contratoIp || "-"}.`,
      fonts
    );
    addParagraph(
      doc,
      `9. FECHA DE AUTORIZACION. ${formatDate(credito.contratoAceptadoAt)}. EL TITULAR: ${credito.clienteNombre} | ${(credito.clienteTipoDocumento || "CC").replace(/_/g, " ")} ${credito.clienteDocumento || "-"}.`,
      fonts
    );

    doc.addPage();

    addSectionTitle(doc, "9. Evidencias del expediente", fonts);
    addEvidenceImage(
      doc,
      "Selfie del cliente",
      credito.contratoSelfieDataUrl || credito.contratoFotoDataUrl,
      selfieAudit,
      fonts
    );
    addEvidenceImage(
      doc,
      "Cedula frente",
      credito.contratoCedulaFrenteDataUrl,
      cedulaFrenteAudit,
      fonts
    );
    addEvidenceImage(
      doc,
      "Cedula respaldo",
      credito.contratoCedulaRespaldoDataUrl,
      cedulaRespaldoAudit,
      fonts
    );
    addEvidenceImage(
      doc,
      "Firma digital",
      credito.contratoFirmaDataUrl,
      {
        capturedAt: credito.contratoAceptadoAt?.toISOString() || "",
        email: credito.clienteCorreo || "",
        ip: credito.contratoIp || "",
        source: "signature",
      },
      fonts
    );

    doc.end();

    const buffer = await bufferPromise;

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="expediente-${credito.folio}.pdf"`,
      },
    });
  } catch (error) {
    console.error("ERROR DESCARGANDO EXPEDIENTE DEL CREDITO:", error);
    return NextResponse.json(
      { error: "No se pudo descargar el expediente del credito" },
      { status: 500 }
    );
  }
}
