import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSessionUser } from "@/lib/auth";
import { getCommercialMonthlyReport } from "@/lib/commercial-monthly-report";
import { getCurrentBogotaMonthInput } from "@/lib/ventas-utils";

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
    doc.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function formatoPesos(valor: number) {
  return `$ ${Number(valor || 0).toLocaleString("es-CO")}`;
}

function normalizeMonth(value: string | null) {
  if (!value) {
    return getCurrentBogotaMonthInput();
  }

  return /^\d{4}-\d{2}$/.test(value) ? value : null;
}

function drawStatCard(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  label: string,
  value: string,
  fonts: { regular: string; bold: string }
) {
  doc.save().roundedRect(x, y, width, 54, 12).fillAndStroke("#FFFFFF", "#E2E8F0").restore();
  doc.fillColor("#64748B").font(fonts.regular).fontSize(8.5).text(label, x + 12, y + 10, {
    width: width - 24,
  });
  doc.fillColor("#0F172A").font(fonts.bold).fontSize(16).text(value, x + 12, y + 24, {
    width: width - 24,
  });
}

function ensurePageSpace(doc: PDFKit.PDFDocument, currentY: number, neededHeight: number) {
  if (currentY + neededHeight <= doc.page.height - 40) {
    return currentY;
  }

  doc.addPage();
  return 34;
}

function drawSectionTable<T extends Record<string, unknown>>(
  doc: PDFKit.PDFDocument,
  options: {
    startY: number;
    title: string;
    columns: Array<{ key: keyof T; title: string; width: number; align?: "left" | "right" }>;
    rows: T[];
    emptyLabel: string;
    fonts: { regular: string; bold: string };
  }
) {
  const pageWidth = doc.page.width - 56;
  let y = ensurePageSpace(doc, options.startY, 80);

  doc.fillColor("#0F172A").font(options.fonts.bold).fontSize(15).text(options.title, 28, y);
  y += 18;

  doc.save().roundedRect(28, y, pageWidth, 24, 10).fill("#0F172A").restore();

  let x = 40;
  for (const column of options.columns) {
    doc
      .fillColor("#FFFFFF")
      .font(options.fonts.bold)
      .fontSize(8.5)
      .text(column.title, x, y + 8, {
        width: column.width - 8,
        align: column.align ?? "left",
      });
    x += column.width;
  }

  y += 32;

  if (!options.rows.length) {
    doc
      .save()
      .roundedRect(28, y, pageWidth, 42, 12)
      .fillAndStroke("#FFFFFF", "#E2E8F0")
      .restore();
    doc
      .fillColor("#64748B")
      .font(options.fonts.regular)
      .fontSize(10)
      .text(options.emptyLabel, 28, y + 14, {
        width: pageWidth,
        align: "center",
      });
    return y + 56;
  }

  for (const row of options.rows) {
    y = ensurePageSpace(doc, y, 38);

    doc
      .save()
      .roundedRect(28, y, pageWidth, 34, 10)
      .fillAndStroke("#FFFFFF", "#E2E8F0")
      .restore();

    x = 40;
    for (const column of options.columns) {
      doc
        .fillColor("#0F172A")
        .font(options.fonts.regular)
        .fontSize(9.5)
        .text(String(row[column.key] ?? "-"), x, y + 11, {
          width: column.width - 8,
          align: column.align ?? "left",
        });
      x += column.width;
    }

    y += 40;
  }

  return y;
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();

    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (String(user.rolNombre || "").toUpperCase() !== "ADMIN") {
      return NextResponse.json(
        { error: "Solo el administrador puede generar este reporte" },
        { status: 403 }
      );
    }

    const url = new URL(req.url);
    const month = normalizeMonth(url.searchParams.get("month"));

    if (!month) {
      return NextResponse.json({ error: "El mes del reporte no es valido" }, { status: 400 });
    }

    const sedeIdParam = Number(url.searchParams.get("sedeId") || 0);
    const sedeId = Number.isInteger(sedeIdParam) && sedeIdParam > 0 ? sedeIdParam : null;

    let sedeNombre = "Todas las sedes";
    if (sedeId) {
      const sede = await prisma.sede.findUnique({
        where: { id: sedeId },
        select: { nombre: true },
      });

      if (!sede) {
        return NextResponse.json({ error: "La sede seleccionada no existe" }, { status: 404 });
      }

      sedeNombre = sede.nombre;
    }

    const reporte = await getCommercialMonthlyReport({
      month,
      sedeId,
    });

    const pdfFonts = getPdfFonts();

    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margin: 28,
      compress: true,
      bufferPages: true,
      font: pdfFonts.regular,
      info: {
        Title: `Reporte mensual comercial - ${reporte.periodo.label}`,
        Author: "Conectamos",
      },
    });

    const bufferPromise = toBuffer(doc);
    const pageWidth = doc.page.width - 56;

    const headerHeight = 126;
    doc.save().roundedRect(28, 28, pageWidth, headerHeight, 22).fill("#FFF7F7").restore();
    doc
      .save()
      .roundedRect(28, 28, pageWidth, headerHeight, 22)
      .lineWidth(1)
      .stroke("#FECACA")
      .restore();
    doc.save().roundedRect(28, 28, 6, headerHeight, 3).fill("#DC2626").restore();

    doc.fillColor("#B91C1C").font(pdfFonts.bold).fontSize(10).text("REPORTE MENSUAL", 52, 42);
    doc.fillColor("#0F172A").font(pdfFonts.bold).fontSize(28).text("Comercial por sede", 52, 58);
    doc.fillColor("#475569").font(pdfFonts.regular).fontSize(11).text(
      `Periodo: ${reporte.periodo.label}\nCobertura: ${sedeNombre}\nGenerado por: ${user.nombre}`,
      52,
      92,
      { width: 300 }
    );

    const statsStartX = doc.page.width - 320;
    const statsTopY = 42;
    const statsGap = 12;
    const smallCardWidth = 140;

    drawStatCard(doc, statsStartX, statsTopY, smallCardWidth, "Ventas del mes", String(reporte.ventasTotal), pdfFonts);
    drawStatCard(
      doc,
      statsStartX + smallCardWidth + statsGap,
      statsTopY,
      smallCardWidth,
      "Comision jaladores",
      formatoPesos(reporte.comisionTotal),
      pdfFonts
    );
    drawStatCard(
      doc,
      statsStartX,
      statsTopY + 62,
      smallCardWidth,
      "Financieras",
      String(reporte.financierasUnidades),
      pdfFonts
    );
    drawStatCard(
      doc,
      statsStartX + smallCardWidth + statsGap,
      statsTopY + 62,
      smallCardWidth,
      "Valor bruto",
      formatoPesos(reporte.financierasValor),
      pdfFonts
    );

    let y = 178;

    y = drawSectionTable(doc, {
      startY: y,
      title: "Jaladores del mes",
      columns: [
        { key: "nombre", title: "Jalador", width: 260 },
        { key: "ventas", title: "Ventas", width: 100, align: "right" },
        { key: "comision", title: "Comision", width: 140, align: "right" },
      ],
      rows: reporte.jaladores.map((item) => ({
        nombre: item.nombre,
        ventas: item.ventas,
        comision: formatoPesos(item.comision),
      })),
      emptyLabel: "No hay jaladores con ventas en este mes.",
      fonts: pdfFonts,
    });

    y += 12;

    y = drawSectionTable(doc, {
      startY: y,
      title: "Cerradores del mes",
      columns: [
        { key: "nombre", title: "Cerrador", width: 260 },
        { key: "ventas", title: "Ventas", width: 100, align: "right" },
      ],
      rows: reporte.cerradores.map((item) => ({
        nombre: item.nombre,
        ventas: item.ventas,
      })),
      emptyLabel: "No hay cerradores con ventas en este mes.",
      fonts: pdfFonts,
    });

    y += 12;

    drawSectionTable(doc, {
      startY: y,
      title: "Financieras sin intermediacion",
      columns: [
        { key: "nombre", title: "Financiera", width: 240 },
        { key: "unidades", title: "Unidades", width: 120, align: "right" },
        { key: "valor", title: "Valor bruto acumulado", width: 180, align: "right" },
      ],
      rows: reporte.financieras.map((item) => ({
        nombre: item.nombre,
        unidades: item.unidades,
        valor: formatoPesos(item.valor),
      })),
      emptyLabel: "No hay financieras registradas en este mes.",
      fonts: pdfFonts,
    });

    doc.end();

    const pdfBuffer = await bufferPromise;

    return new Response(Uint8Array.from(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="reporte-comercial-${month}${sedeId ? `-sede-${sedeId}` : "-general"}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("ERROR REPORTE MENSUAL COMERCIAL:", error);
    return NextResponse.json(
      {
        error: "Error generando reporte mensual comercial",
        detail:
          error instanceof Error ? error.message : undefined,
      },
      { status: 500 }
    );
  }
}
