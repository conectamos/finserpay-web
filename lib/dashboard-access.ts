import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isFinserPayCentralAlly } from "@/lib/aliados";
import { isAdminRole, isApprovalAnalystRole } from "@/lib/roles";

export async function getDashboardAccess(options: { allowApprovalAnalyst?: boolean } = {}) {
  const session = await getSessionUser(options) || (options.allowApprovalAnalyst
    ? await getSessionUser({ allowApprovalAnalyst: true, preferApprovalAccess: true }) : null);

  if (!session) {
    return null;
  }

  const admin = isAdminRole(session.rolNombre);
  const approvalAnalyst = isApprovalAnalystRole(session.rolNombre);
  const seller = admin || approvalAnalyst ? null : await getSellerSessionUser(session);

  return {
    session,
    admin,
    approvalAnalyst,
    seller,
    supervisor: !admin && seller?.tipoPerfil === "SUPERVISOR",
    vendedor: !admin && seller?.tipoPerfil === "VENDEDOR",
  };
}

export async function requireDashboardAccess(options: { allowApprovalAnalyst?: boolean } = {}) {
  const access = await getDashboardAccess(options);

  if (!access) {
    redirect("/");
  }

  return access;
}

export async function requireAdminDashboardAccess() {
  const access = await requireDashboardAccess();

  if (!access.admin) {
    redirect("/dashboard");
  }

  return access;
}

export async function requireCentralAdminDashboardAccess() {
  const access = await requireAdminDashboardAccess();

  if (!isFinserPayCentralAlly(access.session.aliadoAccesoCodigo)) {
    redirect("/dashboard");
  }

  return access;
}

export async function requireAdminOrSupervisorDashboardAccess() {
  const access = await requireDashboardAccess();

  if (!access.admin && !access.supervisor) {
    redirect("/dashboard");
  }

  return access;
}
