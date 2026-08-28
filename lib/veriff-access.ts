import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";
import { canSellerOperateSolicitud } from "@/lib/solicitud-operation-access";

type VeriffAccessUser = {
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
  const adminCentral =
    isAdminRole(user.rolNombre) &&
    isFinserPayCentralAlly(user.aliadoAccesoCodigo);
  return (
    adminCentral || canSellerOperateSolicitud(seller, user.aliadoId, row)
  );
}
