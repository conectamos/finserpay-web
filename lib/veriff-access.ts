import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";

type VeriffAccessUser = {
  aliadoAccesoCodigo?: string | null;
  aliadoAccesoId?: number | null;
  id: number;
  rolNombre?: string | null;
  sedeId: number;
} | null;

type VeriffAccessSeller = {
  id: number;
  sedeId: number;
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

  return Boolean(
    seller &&
      row.vendedorId === seller.id &&
      row.sedeId === seller.sedeId
  );
}

export function canOperateVeriffDraft(
  user: VeriffAccessUser,
  row: VeriffAccessRow,
  seller: VeriffAccessSeller
) {
  return (
    String(row?.estado || "").trim().toUpperCase() === "ABIERTO" &&
    canAccessVeriffValidation(user, row, seller)
  );
}
