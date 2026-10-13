import { exportFailure, exportJson, getExportViewer, readExportBody } from "@/lib/solicitudes-export-http";
import { normalizeExportFilters } from "@/lib/solicitudes-export-core";
import { countExportRows } from "@/lib/solicitudes-export-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    const viewer = await getExportViewer();
    const { filters } = await readExportBody(request);
    return exportJson({ count: await countExportRows(viewer, normalizeExportFilters(filters)) });
  } catch (error) { return exportFailure(error); }
}
