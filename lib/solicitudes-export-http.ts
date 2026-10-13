import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { exportViewerFromSession } from "@/lib/solicitudes-export-access";
import { ExportError } from "@/lib/solicitudes-export-core";

export const EXPORT_HEADERS = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
export async function getExportViewer() { return exportViewerFromSession(await getSessionUser()); }
export function exportJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: EXPORT_HEADERS });
}
export function exportFailure(error: unknown) {
  if (error instanceof ExportError) return exportJson({ error: error.message }, error.status);
  // Do not log database errors containing parameters/customer details.
  console.error("[solicitudes-export] Error al atender la exportación.");
  return exportJson({ error: "No se pudo completar la exportación. Intenta nuevamente." }, 500);
}
export async function readExportBody(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new ExportError(403, "Origen no autorizado.");
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new ExportError(403, "Origen no autorizado."); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new ExportError(403, "Origen no autorizado.");
    }
    // Railway terminates TLS before forwarding to Node. Browser Host retains
    // the public authority even when the internal request URL uses HTTP.
    const publicHost = request.headers.get("host");
    const matches = publicHost
      ? parsed.host.toLowerCase() === publicHost.toLowerCase()
      : parsed.origin === new URL(request.url).origin;
    if (!matches) throw new ExportError(403, "Origen no autorizado.");
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ExportError(415, "Se requiere JSON.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ExportError(400, "Solicitud inválida.");
  const parts: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 64 * 1024) { await reader.cancel(); throw new ExportError(413, "Demasiados filtros."); }
    parts.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new ExportError(400, "Solicitud inválida."); }
}
