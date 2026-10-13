import { isAdminRole } from "@/lib/roles";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { ExportError, assertExportViewer, type ExportViewer } from "@/lib/solicitudes-export-core";

export function exportViewerFromSession(user: {
  id: number; rolNombre: string; aliadoAccesoCodigo: string | null;
  aliadoAccesoId: number | null; sedeAccesoId: number;
} | null): ExportViewer {
  if (!user) throw new ExportError(401, "No autenticado");
  if (!isAdminRole(user.rolNombre)) throw new ExportError(403, "La descarga requiere un administrador autorizado.");
  const central = isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  const viewer: ExportViewer = {
    kind: central ? "CENTRAL_ADMIN" : "ALLY_ADMIN", userId: user.id,
    aliadoId: user.aliadoAccesoId, sedeId: user.sedeAccesoId, vendedorId: null,
  };
  assertExportViewer(viewer);
  return viewer;
}
