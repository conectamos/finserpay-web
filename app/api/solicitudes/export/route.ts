import { after } from "next/server";
import { exportFailure, exportJson, getExportViewer, readExportBody } from "@/lib/solicitudes-export-http";
import { getSolicitudExportStore, processSolicitudExports } from "@/lib/solicitudes-export-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1800;

export async function POST(request: Request) {
  try {
    const viewer = await getExportViewer();
    const body = await readExportBody(request);
    const store = await getSolicitudExportStore();
    await store.cleanup();
    const job = await store.create(viewer, body.filters, body.expectedCount);
    after(() => processSolicitudExports());
    return exportJson({ job }, 202);
  } catch (error) { return exportFailure(error); }
}
