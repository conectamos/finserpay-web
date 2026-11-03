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

export async function GET(request: Request) {
  try {
    const access = await getCutCollectionAccess();
    const query = new URL(request.url).searchParams;
    // Bookmarked projection URLs now resolve the selected date directly.
    query.delete("projectionId");
    query.delete("historyPage");
    for (const name of new Set(query.keys())) {
      if (query.getAll(name).length > 1) throw new CutCollectionError("Hay filtros repetidos en la solicitud.", 400);
    }
    const filters = parseCutFilters(query);
    const format = query.get("format");
    if (format !== null && format !== "xlsx") throw new CutCollectionError("Formato de exportación no válido.", 400);
    const report = await getDirectCutCollectionReport(access, filters);
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

export async function POST() {
  try {
    await getCutCollectionAccess();
    return json({ error: "El recaudo por corte se consulta directamente. Ya no se guardan nuevas proyecciones." }, 410);
  } catch (error) { return failure(error); }
}
