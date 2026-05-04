import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { getSellerSessionUser } from "@/lib/seller-auth";
import { isAdminRole } from "@/lib/roles";

export async function getDashboardAccess() {
  const session = await getSessionUser();

  if (!session) {
    return null;
  }

  const admin = isAdminRole(session.rolNombre);
  const seller = admin ? null : await getSellerSessionUser(session);

  return {
    session,
    admin,
    seller,
    supervisor: !admin && seller?.tipoPerfil === "SUPERVISOR",
    vendedor: !admin && seller?.tipoPerfil === "VENDEDOR",
  };
}

export async function requireDashboardAccess() {
  const access = await getDashboardAccess();

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

export async function requireAdminOrSupervisorDashboardAccess() {
  const access = await requireDashboardAccess();

  if (!access.admin && !access.supervisor) {
    redirect("/dashboard");
  }

  return access;
}
