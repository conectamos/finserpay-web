import "server-only";

import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getSessionUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/roles";

export async function getDataCreditoCentralAdmin() {
  const user = await getSessionUser();
  if (!user) return { ok: false as const, status: 401 as const, user: null };
  if (
    !isAdminRole(user.rolNombre) ||
    !isFinserPayCentralAlly(user.aliadoAccesoCodigo)
  ) {
    return { ok: false as const, status: 403 as const, user: null };
  }
  return { ok: true as const, status: 200 as const, user };
}
