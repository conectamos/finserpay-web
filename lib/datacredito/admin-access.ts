import "server-only";

import { isFinserPayCentralAlly } from "@/lib/aliados";
import { getNominalApprovalAnalystSessionUser, getSessionUser } from "@/lib/auth";
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

/**
 * Narrow access used only by the safe TX06 retry-release workflow. It keeps
 * every other DataCrédito administration endpoint restricted to central
 * administrators while allowing a nominal approval analyst to resolve the
 * support case with full actor attribution.
 */
export async function getDataCreditoRetryReleaseActor() {
  const adminAccess = await getDataCreditoCentralAdmin();
  if (adminAccess.ok) return adminAccess;

  const analyst = await getNominalApprovalAnalystSessionUser();
  if (analyst) return { ok: true as const, status: 200 as const, user: analyst };

  return adminAccess;
}
