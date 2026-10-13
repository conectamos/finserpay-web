import { exportFailure, exportJson, getExportViewer } from "@/lib/solicitudes-export-http";
import { getExportOptions } from "@/lib/solicitudes-export-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const viewer = await getExportViewer();
    const options = await getExportOptions(viewer);
    return exportJson({ options, scope: viewer.kind, scopeLabel: viewer.kind === "CENTRAL_ADMIN"
      ? "Base general de todos los aliados autorizados" : "Solicitudes de tu aliado" });
  } catch (error) { return exportFailure(error); }
}
