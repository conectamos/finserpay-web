import { after } from "next/server";
import { exportFailure, exportJson, getExportViewer } from "@/lib/solicitudes-export-http";
import { getSolicitudExportStore, processSolicitudExports, serializeExportJob } from "@/lib/solicitudes-export-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const viewer = await getExportViewer();
    const { id } = await context.params;
    const store = await getSolicitudExportStore();
    const job = await store.get(viewer, id);
    if (job.status === "PENDING" || job.status === "PROCESSING") after(() => processSolicitudExports());
    return exportJson({ job: serializeExportJob(job) });
  } catch (error) { return exportFailure(error); }
}
