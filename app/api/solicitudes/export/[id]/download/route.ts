import { EXPORT_HEADERS, exportFailure, getExportViewer } from "@/lib/solicitudes-export-http";
import { getSolicitudExportStore } from "@/lib/solicitudes-export-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getExportViewer();
    const { id } = await context.params;
    const result = await (await getSolicitudExportStore()).download(viewer, id);
    return new Response(result.stream, { headers: {
      ...EXPORT_HEADERS,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${result.job.filename}"`,
      "Content-Length": String(result.bytes),
    } });
  } catch (error) { return exportFailure(error); }
}
