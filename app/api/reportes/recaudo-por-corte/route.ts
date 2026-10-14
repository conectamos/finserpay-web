import { CutCollectionError, getCutCollectionAccess, parseCutFilters } from "@/lib/cut-collection-access";
import { buildCutCollectionWorkbook } from "@/lib/cut-collection-excel";
import { getCutCollectionReport, saveCutCollectionProjection } from "@/lib/cut-collection-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
  Vary: "Cookie",
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function identifier(value: unknown, label: string) {
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new CutCollectionError(`${label} no válido.`, 400);
  }
  return value;
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")) {
    throw new CutCollectionError("Origen de solicitud no permitido.", 403);
  }
  let parsed: URL;
  try { parsed = new URL(origin); }
  catch { throw new CutCollectionError("Origen de solicitud no permitido.", 403); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new CutCollectionError("Origen de solicitud no permitido.", 403);
  }
  const target = new URL(request.url);
  const publicHost = request.headers.get("host");
  // Railway terminates TLS before forwarding to Node; Host preserves the
  // public authority even when the internal request URL uses HTTP.
  const host = publicHost || target.host;
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? `${forwardedProtocol}:` : target.protocol;
  const proxyTls = publicHost && publicHost.toLowerCase() !== target.host.toLowerCase() &&
    target.protocol === "http:" && parsed.protocol === "https:" && !forwardedProtocol;
  if (parsed.host.toLowerCase() !== host.toLowerCase() || (!proxyTls && parsed.protocol !== protocol)) {
    throw new CutCollectionError("Origen de solicitud no permitido.", 403);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new CutCollectionError("Envía los filtros en formato JSON.", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new CutCollectionError("Solicitud no válida.", 400);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new CutCollectionError("La solicitud es demasiado grande.", 413);
    }
    parts.push(value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new CutCollectionError("Solicitud no válida.", 400); }
}

export async function GET(request: Request) {
  try {
    const access = await getCutCollectionAccess();
    const query = new URL(request.url).searchParams;
    for (const name of new Set(query.keys())) {
      if (query.getAll(name).length > 1) throw new CutCollectionError("Hay filtros repetidos en la solicitud.", 400);
    }
    const filters = parseCutFilters(query);
    const projectionId = query.has("projectionId") ? identifier(query.get("projectionId"), "Identificador de proyección") : null;
    const page = query.get("historyPage") ?? "0";
    if (!/^\d+$/.test(page) || !Number.isSafeInteger(Number(page)) || Number(page) > 100000) {
      throw new CutCollectionError("Página de historial no válida.", 400);
    }
    const format = query.get("format");
    if (format !== null && format !== "xlsx") throw new CutCollectionError("Formato de exportación no válido.", 400);
    const report = await getCutCollectionReport(access, filters, projectionId, Number(page));
    if (format !== "xlsx") return json(report);
    const workbook = buildCutCollectionWorkbook(report);
    const bytes = await workbook.xlsx.writeBuffer();
    const filename = `FINSERPAY_Recaudo_${report.cutDate}_${report.projection ? report.projection.id : "vista-previa"}.xlsx`;
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
    assertSameOrigin(request);
    const access = await getCutCollectionAccess();
    const body = await readBody(request);
    const filters = parseCutFilters(body);
    const requestKey = identifier(body.requestKey, "Identificador de solicitud");
    return json(await saveCutCollectionProjection(access, filters, requestKey), 201);
  } catch (error) { return failure(error); }
}
