import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import Tx06ReleaseConsole from "@/app/dashboard/datacredito/liberaciones/tx06-release-console";
import { requireNominalApprovalDashboardAccess } from "../approval-dashboard-access";
import ApprovalDashboardShell from "../approval-dashboard-shell";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Liberar consulta | Aprobaciones | FINSER PAY",
  description: "Liberación auditada de consultas TX06 sin puntaje.",
};

export default async function ApprovalReleasePage() {
  const user = await requireNominalApprovalDashboardAccess();

  return (
    <ApprovalDashboardShell
      activeHref="/dashboard/aprobaciones/liberar-consulta"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Liberar consulta"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <Tx06ReleaseConsole mode="analyst" />
    </ApprovalDashboardShell>
  );
}
