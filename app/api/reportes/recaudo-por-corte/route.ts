import { CutCollectionError, getCutCollectionAccess, parseCutFilters } from "@/lib/cut-collection-access";
import { buildCutCollectionWorkbook } from "@/lib/cut-collection-excel";
import { getDirectCutCollectionReport } from "@/lib/cut-collection-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: privateHeaders });
}

function failure(error: unknown) {
  if (error instanceof CutCollectionError && error.status >= 400 && error.status < 500) {
    return json({ error: error.message }, error.status);
  }
  // Database messages can contain SQL, credentials or customer details. Neither
  // the HTTP response nor the application log receives those messages.
  console.error("[recaudo-por-corte] No fue posible completar la operación.");
  const unavailable = error instanceof Error && (
    error.name === "TimeoutError" || error.name === "AbortError" ||
    ("code" in error && ["ETIMEDOUT", "57014", "P2024"].includes(String(error.code))) ||
    (error instanceof CutCollectionError && [503, 504].includes(error.status))
  );
  return json({ error: unavailable
    ? "El reporte no está disponible en este momento. Intenta nuevamente."
    : "No se pudo completar el reporte de recaudo por corte. Intenta nuevamente.",
  }, unavailable ? 503 : 500);
}

function readQuery(request: Request) {
  const query = new URL(request.url).searchParams;
  // Bookmarked projection URLs now resolve the selected date directly.
  query.delete("projectionId");
  query.delete("historyPage");
  for (const name of new Set(query.keys())) {
    if (query.getAll(name).length > 1) throw new CutCollectionError("Hay filtros repetidos en la solicitud.", 400);
  }
  return query;
}

function pdfFilename(cutDate: string) {
  return `FINSERPAY_Recaudo_${cutDate}.pdf`;
}

export async function GET(request: Request) {
  try {
    const access = await getCutCollectionAccess();
    const query = readQuery(request);
    const filters = parseCutFilters(query);
    const format = query.get("format");
    if (format !== null && format !== "xlsx" && format !== "pdf") throw new CutCollectionError("Formato de exportación no válido.", 400);
    const report = await getDirectCutCollectionReport(access, filters);
    if (format === "pdf") {
      const { buildCutCollectionPdf } = await import("@/lib/cut-collection-pdf");
      const pdf = await buildCutCollectionPdf(report);
      return new Response(new Uint8Array(pdf), { headers: {
        ...privateHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfFilename(report.cutDate)}"`,
        "Content-Length": String(pdf.byteLength),
      } });
    }
    if (format !== "xlsx") return json(report);
    const workbook = buildCutCollectionWorkbook(report);
    const bytes = await workbook.xlsx.writeBuffer();
    const filename = `FINSERPAY_Recaudo_${report.cutDate}.xlsx`;
    return new Response(new Uint8Array(bytes), { headers: {
      ...privateHeaders,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.byteLength),
    } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const access = await getCutCollectionAccess();
    const action = new URL(request.url).searchParams.get("action");
    if (action !== "email" && action !== "whatsapp") {
      return json({ error: "El recaudo por corte se consulta directamente. Ya no se guardan nuevas proyecciones." }, 410);
    }
    const { assertAttentionOrigin } = await import("@/lib/atencion-http");
    try { assertAttentionOrigin(request); }
    catch { throw new CutCollectionError("Origen de solicitud no permitido.", 403); }
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new CutCollectionError("La solicitud de envío debe usar JSON.", 415);
    }
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key)) {
      throw new CutCollectionError("Identificador de envío inválido.", 400);
    }
    const filters = parseCutFilters(readQuery(request));
    if (!filters.aliadoId) throw new CutCollectionError("Selecciona un aliado para enviar el informe.", 400);
    const report = await getDirectCutCollectionReport(access, filters);
    if (action === "whatsapp") {
      const { CutCollectionWhatsAppError, sendCutCollectionWhatsApp } = await import("@/lib/cut-collection-whatsapp");
      try {
        const recipient = await sendCutCollectionWhatsApp({ userId: access.userId, key, allyId: filters.aliadoId, report });
        return json({ ok: true, recipient });
      } catch (error) {
        if (error instanceof CutCollectionWhatsAppError) {
          return json({ error: error.message, ...(error.retryWithNewKey && { retryWithNewKey: true }) }, error.status);
        }
        throw error;
      }
    }
    const { CutCollectionEmailError, getCutCollectionRecipient, sendCutCollectionEmail } = await import("@/lib/cut-collection-email");
    const recipient = await getCutCollectionRecipient(filters.aliadoId);
    const { buildCutCollectionPdf } = await import("@/lib/cut-collection-pdf");
    const pdf = await buildCutCollectionPdf(report);
    try {
      await sendCutCollectionEmail({
        recipient, pdf, cutDate: report.cutDate,
        filename: pdfFilename(report.cutDate), idempotencyKey: `${access.userId}/${filters.aliadoId}/${key}`,
      });
    } catch (error) {
      if (error instanceof CutCollectionEmailError) return json({ error: error.message }, error.status);
      throw error;
    }
    return json({ ok: true, recipient });
  } catch (error) { return failure(error); }
}
