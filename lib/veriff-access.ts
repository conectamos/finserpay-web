import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { canActAsAllySalesAdmin, canOperateSolicitud, canSellerOperateSolicitud } from "@/lib/solicitud-operation-access";

type VeriffAccessUser = {
  activo?: boolean;
  sedeAccesoId?: number | null;
  sedeAccesoActiva?: boolean;
  aliadoAccesoActivo?: boolean;
  aliadoId?: number | null;
  aliadoAccesoCodigo?: string | null;
  aliadoAccesoId?: number | null;
  id: number;
  rolNombre?: string | null;
  sedeId: number;
} | null;

type VeriffAccessSeller = {
  id: number;
  sedeId: number;
  tipoPerfil?: string | null;
} | null;

type VeriffAccessRow = {
  aliadoId?: number | null;
  estado?: string | null;
  sedeId?: number | null;
  usuarioId?: number | null;
  vendedorId?: number | null;
} | null;

export function canAccessVeriffValidation(
  user: VeriffAccessUser,
  row: VeriffAccessRow,
  seller: VeriffAccessSeller
) {
  if (!user || !row) {
    return false;
  }

  const admin = isAdminRole(user.rolNombre);
  const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);

  if (adminCentral) {
    return true;
  }

  if (admin && user.aliadoAccesoId && row.aliadoId === user.aliadoAccesoId) {
    return true;
  }

  return canSellerOperateSolicitud(seller, user.aliadoId, row);
}

export function canOperateVeriffDraft(
  user: VeriffAccessUser,
  row: VeriffAccessRow,
  seller: VeriffAccessSeller
) {
  if (
    !user ||
    !row ||
    String(row.estado || "").trim().toUpperCase() !== "ABIERTO"
  ) {
    return false;
  }
  const admin = isAdminRole(user.rolNombre);
  const adminCentral = admin && isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  return canOperateSolicitud({
    central: adminCentral, admin: canActAsAllySalesAdmin(user), userId: user.id,
    seller: admin ? null : seller, viewerAllyId: user.aliadoId, owner: row,
  });
}
