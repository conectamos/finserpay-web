import "server-only";

import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";

/** Administrative identity is always taken from the login, not a seller scope. */
export async function getDataCreditoAllyBranchQuotaAdmin() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, status: 401 as const, user: null, allyId: null };
  if (!isAdminRole(user.rolNombre) || user.activo !== true ||
    user.sedeAccesoActiva !== true || user.aliadoAccesoActivo !== true ||
    !Number.isSafeInteger(user.aliadoAccesoId) || Number(user.aliadoAccesoId) <= 0) {
    return { ok: false as const, status: 403 as const, user: null, allyId: null };
  }
  return { ok: true as const, status: 200 as const, user, allyId: Number(user.aliadoAccesoId) };
}
