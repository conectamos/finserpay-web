import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import {
  dinero,
  financierasTexto,
  formatoFechaHoraVenta,
  getTodayBogotaRange,
  type NumericValue,
} from "@/lib/ventas-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const windowsFontDir = path.join(process.env.WINDIR || "C:\\Windows", "Fonts");
const SYSTEM_FONT_REGULAR = path.join(windowsFontDir, "arial.ttf");
const SYSTEM_FONT_BOLD = path.join(windowsFontDir, "arialbd.ttf");
const REPORT_LOGO_PATH = path.join(
  process.cwd(),
  "public",
  "branding",
  "conectamos-logo.png"
);
const BUNDLED_FONT_REGULAR = path.join(
  process.cwd(),
  "public",
  "pdf-fonts",
  "Geist-Regular.ttf"
);
const BOGOTA_OFFSET = "-05:00";

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

function hasReportLogo() {
  return existsSync(REPORT_LOGO_PATH);
}

function toBuffer(doc: PDFKit.PDFDocument) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    doc.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    doc.on("error", reject);
  });
}

const PAGE_MARGIN = 28;
const PAGE_BOTTOM = 24;
const TABLE_COLUMNS = [
  { key: "venta", title: "Venta", width: 110 },
  { key: "equipo", title: "Equipo", width: 164 },
  { key: "cobro", title: "Cobro", width: 92 },
  { key: "detalle", title: "Detalle", width: 118 },
  { key: "financieras", title: "Financieras", width: 202 },
  { key: "resultado", title: "Resultado", width: 100 },
] as const;

type ReportVenta = {
  idVenta: string;
  fecha: Date;
  hora: string | null;
  servicio: string;
  descripcion: string | null;
  serial: string;
  jalador: string | null;
  cerrador: string | null;
  ingreso: NumericValue;
  utilidad: NumericValue;
  cajaOficina: NumericValue;
  comision: NumericValue;
  salida: NumericValue;
  tipoIngreso: string | null;
  ingreso1: string | null;
  ingreso2: string | null;
  primerValor: NumericValue;
  segundoValor: NumericValue;
  financierasDetalle?: unknown;
  alcanos: NumericValue;
  payjoy: NumericValue;
  sistecredito: NumericValue;
  addi: NumericValue;
  sumaspay: NumericValue;
  celya: NumericValue;
  bogota: NumericValue;
  alocredit: NumericValue;
  esmio: NumericValue;
  kaiowa: NumericValue;
  finser: NumericValue;
  gora: NumericValue;
  sede: { nombre: string } | null;
};

type ParsedDateInput = {
  key: string;
  label: string;
  start: Date;
  end: Date;
};

function parseDateInput(value: string): ParsedDateInput | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const [year, month, day] = value.split("-");
  const start = new Date(`${value}T00:00:00${BOGOTA_OFFSET}`);

  if (Number.isNaN(start.getTime())) {
    return null;
  }

  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    key: value,
    label: `${day}/${month}/${year}`,
    start,
    end,
  };
}

function buildReportPeriod(fechaInicial?: string | null, fechaFinal?: string | null) {
  if (!fechaInicial && !fechaFinal) {
    const today = getTodayBogotaRange();
    return {
      start: today.start,
      end: today.end,
      key: today.key,
      label: today.label,
      title: "Ventas del dia",
      labelPrefix: "Corte",
      ventasLabel: "Ventas del dia",
      footerLabel: today.label,
    };
  }

  if (!fechaInicial || !fechaFinal) {
    throw new Error("Debes indicar fecha inicial y fecha final");
  }

  const parsedInicial = parseDateInput(fechaInicial);
  const parsedFinal = parseDateInput(fechaFinal);

  if (!parsedInicial || !parsedFinal) {
    throw new Error("Las fechas del reporte no son validas");
  }

  if (parsedInicial.start.getTime() > parsedFinal.start.getTime()) {
    throw new Error("La fecha inicial no puede ser mayor que la final");
  }

  const sameDay = parsedInicial.key === parsedFinal.key;

  return {
    start: parsedInicial.start,
    end: parsedFinal.end,
    key: sameDay ? parsedInicial.key : `${parsedInicial.key}_a_${parsedFinal.key}`,
    label: sameDay
      ? parsedInicial.label
      : `${parsedInicial.label} a ${parsedFinal.label}`,
    title: sameDay ? "Ventas del dia" : "Ventas del periodo",
    labelPrefix: sameDay ? "Corte" : "Periodo",
    ventasLabel: sameDay ? "Ventas del dia" : "Ventas del periodo",
    footerLabel: sameDay ? parsedInicial.label : `${parsedInicial.label} - ${parsedFinal.label}`,
  };
}

function slugify(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function formatoPesosCompacto(v: NumericValue) {
  return `$${dinero(v).toLocaleString("es-CO")}`;
}

function resumirTexto(valor?: string | null) {
  return String(valor || "-").trim().replace(/\s+/g, " ");
}

function resumirIngresoDetalle(venta: ReportVenta) {
  const items: string[] = [];

  if (venta.ingreso1) {
    items.push(`${resumirTexto(venta.ingreso1)} ${formatoPesosCompacto(venta.primerValor)}`);
  }

  if (venta.ingreso2) {
    items.push(`${resumirTexto(venta.ingreso2)} ${formatoPesosCompacto(venta.segundoValor)}`);
  }

  return items.length ? items.join(" | ") : "Sin detalle";
}

function resumirFinancieras(venta: ReportVenta) {
  const texto = financierasTexto(venta);
  return texto === "Sin financieras" ? "-" : texto.replace(/:\s/g, " ");
}

function buildVentaCells(venta: ReportVenta) {
  return {
    venta: `${venta.idVenta}\n${formatoFechaHoraVenta(venta.fecha, venta.hora)}\n${resumirTexto(venta.servicio)}`,
    equipo: `${resumirTexto(venta.descripcion || "Sin descripcion")}\nIMEI ${venta.serial}\nJ:${resumirTexto(
      venta.jalador
    )} | C:${resumirTexto(venta.cerrador)}`,
    cobro: `${formatoPesosCompacto(venta.ingreso)}\n${resumirTexto(venta.tipoIngreso || "Sin tipo")}`,
    detalle: resumirIngresoDetalle(venta),
    financieras: resumirFinancieras(venta),
    resultado: `Util ${formatoPesosCompacto(venta.utilidad)}\nCaja ${formatoPesosCompacto(
      venta.cajaOficina
    )}\nCom ${formatoPesosCompacto(venta.comision)} | Sal ${formatoPesosCompacto(
      venta.salida
    )}\n${resumirTexto(venta.sede?.nombre || "-")}`,
  };
}

function drawHeaderMetric(
  doc: PDFKit.PDFDocument,
  options: {
    x: number;
    y: number;
    w: number;
    label: string;
    value: string;
    fonts: { regular: string; bold: string };
    tone?: "slate" | "emerald" | "red";
  }
) {
  const tones = {
    slate: { accent: "#CBD5E1", label: "#475569", value: "#0F172A" },
    emerald: { accent: "#A7F3D0", label: "#047857", value: "#047857" },
    red: { accent: "#FECACA", label: "#B91C1C", value: "#B91C1C" },
  };

  const tone = tones[options.tone ?? "slate"];

  doc.save().roundedRect(options.x, options.y, 4, 14, 2).fill(tone.accent).restore();

  doc
    .fillColor(tone.label)
    .font(options.fonts.regular)
    .fontSize(8.5)
    .text(options.label, options.x + 12, options.y + 1, {
      width: options.w - 84,
    });

  doc
    .fillColor(tone.value)
    .font(options.fonts.bold)
    .fontSize(10.5)
    .text(options.value, options.x + options.w - 80, options.y, {
      width: 80,
      align: "right",
    });
}

function drawMainHeader(
  doc: PDFKit.PDFDocument,
  options: {
    label: string;
    labelPrefix: string;
    title: string;
    ventasLabel: string;
    coverage: string;
    userName: string;
    ventasCount: number;
    totalComision: number;
    totalSalida: number;
    totalCaja: number;
    totalIngresos: number;
    totalUtilidad: number;
    fonts: { regular: string; bold: string };
  }
) {
  const x = PAGE_MARGIN;
  const y = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const height = 102;
  const summaryWidth = 196;
  const textX = x + 152;
  const summaryX = x + width - summaryWidth - 18;

  doc
    .save()
    .roundedRect(x, y, width, height, 20)
    .fill("#FFF7F7")
    .restore();

  doc
    .save()
    .roundedRect(x, y, width, height, 20)
    .lineWidth(1)
    .stroke("#FECACA")
    .restore();

  doc.save().roundedRect(x, y, 6, height, 3).fill("#DC2626").restore();

  doc
    .save()
    .roundedRect(x + 22, y + 18, 106, 66, 18)
    .fillAndStroke("#FFFFFF", "#F3D4D4")
    .restore();

  if (hasReportLogo()) {
    doc.image(REPORT_LOGO_PATH, x + 30, y + 24, {
      fit: [90, 54],
      align: "center",
      valign: "center",
    });
  }

  doc
    .fillColor("#B91C1C")
    .font(options.fonts.bold)
    .fontSize(9.5)
    .text("REPORTE DIARIO", textX, y + 18, {
      width: summaryX - textX - 18,
    });

  doc
    .fillColor("#0F172A")
    .font(options.fonts.bold)
    .fontSize(22)
    .text(options.title, textX, y + 32, {
      width: summaryX - textX - 18,
    });

  doc
    .fillColor("#475569")
    .font(options.fonts.regular)
    .fontSize(9)
    .text(`${options.labelPrefix}: ${options.label}`, textX, y + 62)
    .text(`Cobertura: ${options.coverage}`, textX, y + 75)
    .text(`Generado por: ${options.userName}`, textX, y + 88);

  doc
    .fillColor("#64748B")
    .font(options.fonts.regular)
    .fontSize(8.5)
    .text(
      `Ingreso bruto ${formatoPesosCompacto(options.totalIngresos)} | Utilidad ${formatoPesosCompacto(
        options.totalUtilidad
      )}`,
      textX + 174,
      y + 88,
      {
        width: summaryX - textX - 190,
        align: "right",
      }
    );

  doc
    .save()
    .roundedRect(summaryX, y + 14, summaryWidth, 74, 18)
    .fillAndStroke("#FFFFFF", "#E2E8F0")
    .restore();

  drawHeaderMetric(doc, {
    x: summaryX + 16,
    y: y + 24,
    w: summaryWidth - 32,
    label: options.ventasLabel,
    value: `${options.ventasCount}`,
    fonts: options.fonts,
  });
  drawHeaderMetric(doc, {
    x: summaryX + 16,
    y: y + 40,
    w: summaryWidth - 32,
    label: "Comisiones del dia",
    value: formatoPesosCompacto(options.totalComision),
    fonts: options.fonts,
  });
  drawHeaderMetric(doc, {
    x: summaryX + 16,
    y: y + 56,
    w: summaryWidth - 32,
    label: "Salidas del dia",
    value: formatoPesosCompacto(options.totalSalida),
    fonts: options.fonts,
    tone: options.totalSalida > 0 ? "red" : "slate",
  });
  drawHeaderMetric(doc, {
    x: summaryX + 16,
    y: y + 72,
    w: summaryWidth - 32,
    label: "Dinero en CAJA",
    value: formatoPesosCompacto(options.totalCaja),
    fonts: options.fonts,
    tone: options.totalCaja >= 0 ? "emerald" : "red",
  });

  return y + height + 16;
}

function drawContinuationHeader(
  doc: PDFKit.PDFDocument,
  options: {
    label: string;
    coverage: string;
    fonts: { regular: string; bold: string };
  }
) {
  const x = PAGE_MARGIN;
  const y = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;

  doc
    .save()
    .roundedRect(x, y, width, 44, 16)
    .fill("#FFFFFF")
    .restore();

  doc
    .save()
    .roundedRect(x, y, width, 44, 16)
    .lineWidth(1)
    .stroke("#E2E8F0")
    .restore();

  doc.save().roundedRect(x, y, 5, 44, 2).fill("#DC2626").restore();

  if (hasReportLogo()) {
    doc.image(REPORT_LOGO_PATH, x + 16, y + 8, {
      fit: [42, 28],
      align: "center",
      valign: "center",
    });
  }

  doc
    .fillColor("#0F172A")
    .font(options.fonts.bold)
    .fontSize(11.5)
    .text("Detalle de ventas", x + 70, y + 11);

  doc
    .fillColor("#64748B")
    .font(options.fonts.regular)
    .fontSize(8.5)
    .text(`${options.label} | ${options.coverage}`, x + width - 220, y + 13, {
      width: 190,
      align: "right",
    });

  return y + 56;
}

function drawTableHeader(
  doc: PDFKit.PDFDocument,
  y: number,
  fonts: { regular: string; bold: string }
) {
  const x = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;

  doc.save().roundedRect(x, y, width, 24, 10).fill("#0F172A").restore();

  let cursorX = x;
  for (const column of TABLE_COLUMNS) {
    doc
      .fillColor("#FFFFFF")
      .font(fonts.bold)
      .fontSize(8.5)
      .text(column.title, cursorX + 8, y + 7, {
        width: column.width - 16,
      });

    cursorX += column.width;
  }

  return y + 28;
}

function getVentaRowHeight(
  doc: PDFKit.PDFDocument,
  cells: ReturnType<typeof buildVentaCells>,
  fonts: { regular: string; bold: string }
) {
  doc.font(fonts.regular).fontSize(7.8);

  const maxHeight = TABLE_COLUMNS.reduce((acc, column) => {
    const text = cells[column.key];
    const height = doc.heightOfString(text, {
      width: column.width - 12,
      lineGap: 1,
    });

    return Math.max(acc, height);
  }, 0);

  return Math.max(36, Math.min(74, Math.ceil(maxHeight) + 10));
}

function drawVentaRow(
  doc: PDFKit.PDFDocument,
  venta: ReportVenta,
  y: number,
  index: number,
  fonts: { regular: string; bold: string }
) {
  const x = PAGE_MARGIN;
  const width = doc.page.width - PAGE_MARGIN * 2;
  const cells = buildVentaCells(venta);
  const height = getVentaRowHeight(doc, cells, fonts);

  doc
    .save()
    .roundedRect(x, y, width, height, 10)
    .fill(index % 2 === 0 ? "#FFFFFF" : "#F8FAFC")
    .restore();

  doc
    .save()
    .roundedRect(x, y, width, height, 10)
    .lineWidth(1)
    .stroke("#E2E8F0")
    .restore();

  let cursorX = x;
  for (const column of TABLE_COLUMNS) {
    if (cursorX > x) {
      doc
        .save()
        .moveTo(cursorX, y + 6)
        .lineTo(cursorX, y + height - 6)
        .lineWidth(0.5)
        .strokeColor("#E2E8F0")
        .stroke()
        .restore();
    }

    doc
      .fillColor(column.key === "financieras" ? "#475569" : "#0F172A")
      .font(column.key === "venta" || column.key === "cobro" ? fonts.bold : fonts.regular)
      .fontSize(column.key === "financieras" ? 7.4 : 7.8)
      .text(cells[column.key], cursorX + 6, y + 6, {
        width: column.width - 12,
        height: height - 12,
        lineGap: 1,
      });

    cursorX += column.width;
  }

  return y + height + 4;
}

export async function GET(request: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const esAdmin = String(user.rolNombre || "").toUpperCase() === "ADMIN";
    const requestUrl = new URL(request.url);
    const sedeIdParam = requestUrl.searchParams.get("sedeId")?.trim() || "";
    const fechaInicialParam = requestUrl.searchParams.get("fechaInicial")?.trim() || "";
    const fechaFinalParam = requestUrl.searchParams.get("fechaFinal")?.trim() || "";
    const period = buildReportPeriod(
      esAdmin ? fechaInicialParam : undefined,
      esAdmin ? fechaFinalParam : undefined
    );

    let selectedSede: { id: number; nombre: string } | null = null;

    if (esAdmin && sedeIdParam && sedeIdParam !== "TODAS") {
      const sedeId = Number(sedeIdParam);

      if (!Number.isInteger(sedeId) || sedeId <= 0) {
        return NextResponse.json({ error: "La sede seleccionada no es valida" }, { status: 400 });
      }

      selectedSede = await prisma.sede.findUnique({
        where: { id: sedeId },
        select: { id: true, nombre: true },
      });

      if (!selectedSede) {
        return NextResponse.json({ error: "La sede seleccionada no existe" }, { status: 404 });
      }
    }

    const ventas = await prisma.venta.findMany({
      where: {
        ...(esAdmin
          ? selectedSede
            ? { sedeId: selectedSede.id }
            : {}
          : { sedeId: user.sedeId }),
        fecha: {
          gte: period.start,
          lt: period.end,
        },
      },
      select: {
        idVenta: true,
        fecha: true,
        hora: true,
        servicio: true,
        descripcion: true,
        serial: true,
        jalador: true,
        cerrador: true,
        ingreso: true,
        alcanos: true,
        payjoy: true,
        sistecredito: true,
        addi: true,
        sumaspay: true,
        celya: true,
        bogota: true,
        alocredit: true,
        esmio: true,
        kaiowa: true,
        finser: true,
        gora: true,
        utilidad: true,
        comision: true,
        salida: true,
        cajaOficina: true,
        tipoIngreso: true,
        ingreso1: true,
        ingreso2: true,
        primerValor: true,
        segundoValor: true,
        financierasDetalle: true,
        sede: {
          select: {
            nombre: true,
          },
        },
      },
      orderBy: [{ fecha: "desc" }, { idVenta: "desc" }],
    });

    const totalIngresos = ventas.reduce((acc, venta) => acc + dinero(venta.ingreso), 0);
    const totalCaja = ventas.reduce((acc, venta) => acc + dinero(venta.cajaOficina), 0);
    const totalUtilidad = ventas.reduce((acc, venta) => acc + dinero(venta.utilidad), 0);
    const totalComision = ventas.reduce((acc, venta) => acc + dinero(venta.comision), 0);
    const totalSalida = ventas.reduce((acc, venta) => acc + dinero(venta.salida), 0);

    const pdfFonts = getPdfFonts();

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: PAGE_MARGIN,
      bufferPages: true,
      font: pdfFonts.regular,
    });

    const bufferPromise = toBuffer(doc);
    const coverage = esAdmin
      ? selectedSede?.nombre || "todas las sedes"
      : user.sedeNombre || "Sede actual";

    const paintPageBackground = () => {
      doc
        .save()
        .rect(0, 0, doc.page.width, doc.page.height)
        .fill("#F8FAFC")
        .restore();
    };

    paintPageBackground();

    let currentY = drawMainHeader(doc, {
      label: period.label,
      labelPrefix: period.labelPrefix,
      title: period.title,
      ventasLabel: period.ventasLabel,
      coverage,
      userName: user.nombre,
      ventasCount: ventas.length,
      totalComision,
      totalSalida,
      totalCaja,
      totalIngresos,
      totalUtilidad,
      fonts: pdfFonts,
    });

    currentY = drawTableHeader(doc, currentY, pdfFonts);

    if (ventas.length === 0) {
      doc
        .save()
        .roundedRect(PAGE_MARGIN, currentY, doc.page.width - PAGE_MARGIN * 2, 86, 18)
        .fillAndStroke("#FFFFFF", "#E2E8F0")
        .restore();

      doc
        .fillColor("#475569")
        .font(pdfFonts.regular)
        .fontSize(11)
        .text(
          "No hay ventas registradas para este alcance en la fecha consultada.",
          PAGE_MARGIN + 24,
          currentY + 32,
          {
            width: doc.page.width - PAGE_MARGIN * 2 - 48,
            align: "center",
          }
        );
    } else {
      ventas.forEach((venta, index) => {
        const previewHeight = getVentaRowHeight(doc, buildVentaCells(venta), pdfFonts) + 4;

        if (currentY + previewHeight > doc.page.height - PAGE_BOTTOM - 10) {
          doc.addPage();
          paintPageBackground();
          currentY = drawContinuationHeader(doc, { label: period.label, coverage, fonts: pdfFonts });
          currentY = drawTableHeader(doc, currentY, pdfFonts);
        }

        currentY = drawVentaRow(doc, venta, currentY, index, pdfFonts);
      });
    }

    const pageCount = doc.bufferedPageRange().count;

    for (let index = 0; index < pageCount; index += 1) {
      doc.switchToPage(index);
      doc
        .fillColor("#94A3B8")
        .font(pdfFonts.regular)
        .fontSize(8)
        .text(
          `Conectamos | Reporte ${period.footerLabel} | Pagina ${index + 1} de ${pageCount}`,
          PAGE_MARGIN,
          doc.page.height - 18,
          {
            width: doc.page.width - PAGE_MARGIN * 2,
            align: "center",
          }
        );
    }

    doc.end();
    const buffer = await bufferPromise;

    return new Response(Uint8Array.from(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="ventas-${period.key}${
          selectedSede ? `-${slugify(selectedSede.nombre)}` : ""
        }.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("ERROR REPORTE VENTAS DIA:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error &&
          [
            "Debes indicar fecha inicial y fecha final",
            "Las fechas del reporte no son validas",
            "La fecha inicial no puede ser mayor que la final",
          ].includes(error.message)
            ? error.message
            : "Error generando reporte PDF del dia",
        detail:
          error instanceof Error ? error.message : undefined,
      },
      {
        status:
          error instanceof Error &&
          [
            "Debes indicar fecha inicial y fecha final",
            "Las fechas del reporte no son validas",
            "La fecha inicial no puede ser mayor que la final",
          ].includes(error.message)
            ? 400
            : 500,
      }
    );
  }
}
