import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole } from "@/lib/roles";

type VeriffAccessUser = {
  aliadoAccesoCodigo?: string | null;
  aliadoAccesoId?: number | null;
  id: number;
  rolNombre?: string | null;
  sedeId: number;
} | null;

type VeriffAccessRow = {
  aliadoId?: number | null;
  sedeId?: number | null;
  usuarioId?: number | null;
} | null;

export function canAccessVeriffValidation(
  user: VeriffAccessUser,
  row: VeriffAccessRow
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

  return row.sedeId === user.sedeId || row.usuarioId === user.id;
}
