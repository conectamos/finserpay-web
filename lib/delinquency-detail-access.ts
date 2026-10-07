import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";

export type DelinquencyDetailAlly = { id: number; nombre: string; codigo: string | null };
type DelinquencySession = {
  rolNombre: string;
  aliadoAccesoCodigo?: string | null;
  aliadoAccesoId?: number | null;
  aliadoAccesoNombre?: string | null;
};

export class DelinquencyScopeError extends Error {
  constructor(message: string, public readonly status: 403 | 404) {
    super(message);
    this.name = "DelinquencyScopeError";
  }
}

export function resolveDelinquencyDetailScope(
  session: DelinquencySession,
  requestedAllyId: string | undefined | null,
  allies: DelinquencyDetailAlly[],
) {
  if (!isAdminRole(session.rolNombre)) {
    throw new DelinquencyScopeError("Solo el administrador puede consultar el detalle de mora", 403);
  }
  const adminCentral = isFinserPayCentralAlly(session.aliadoAccesoCodigo);
  if (!adminCentral) {
    const ownId = session.aliadoAccesoId;
    if (!Number.isSafeInteger(ownId) || !ownId || ownId <= 0) {
      throw new DelinquencyScopeError("No hay un aliado autorizado para consultar cartera", 403);
    }
    return { adminCentral: false, aliadoId: ownId, scopeLabel: session.aliadoAccesoNombre || "Mi aliado", selectedAlly: null };
  }
  if (!requestedAllyId) {
    return { adminCentral: true, aliadoId: null, scopeLabel: "Todos los aliados", selectedAlly: null };
  }
  const id = Number(requestedAllyId);
  const selectedAlly = /^[1-9]\d*$/.test(requestedAllyId) && Number.isSafeInteger(id)
    ? allies.find(ally => ally.id === id) : undefined;
  if (!selectedAlly) throw new DelinquencyScopeError("Aliado no encontrado", 404);
  return { adminCentral: true, aliadoId: selectedAlly.id, scopeLabel: selectedAlly.nombre, selectedAlly };
}

export function delinquencyDetailHref(aliadoId: number | null, group?: { type: "sede" | "vendedor"; key: string }) {
  const params = new URLSearchParams();
  if (aliadoId) params.set("aliadoId", String(aliadoId));
  if (group) { params.set("tipo", group.type); params.set("grupo", group.key); }
  const query = params.toString();
  return `/dashboard/cartera/detalle-mora${query ? `?${query}` : ""}`;
}
