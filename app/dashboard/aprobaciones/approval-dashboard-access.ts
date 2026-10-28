import "server-only";

import { redirect } from "next/navigation";
import { getApprovalSharedRequestActor } from "@/lib/approval-shared-session";
import { getNominalApprovalWorkspaceSessionUser } from "@/lib/auth";

export async function requireNominalApprovalDashboardAccess() {
  const user = await getNominalApprovalWorkspaceSessionUser();

  if (!user) redirect("/dashboard/aprobaciones");

  if ((await getApprovalSharedRequestActor()) !== undefined) {
    redirect("/dashboard/aprobaciones");
  }

  return user;
}
