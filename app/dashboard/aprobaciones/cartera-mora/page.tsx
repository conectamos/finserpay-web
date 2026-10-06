import AdminWorkspaceTopbar from "@/app/dashboard/_components/admin-workspace-topbar";
import ApprovalDashboardShell from "../approval-dashboard-shell";
import { requireMoraDashboardAccess } from "../mora-dashboard-access";
import MoraPortfolioClient from "./mora-portfolio-client";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Cartera en mora | Aprobaciones | FINSER PAY",
  description: "Seguimiento operativo de créditos con cuotas vencidas.",
};

export default async function ApprovalMoraPortfolioPage() {
  const { user } = await requireMoraDashboardAccess();

  return (
    <ApprovalDashboardShell
      activeHref="/dashboard/aprobaciones/cartera-mora"
      user={user}
    >
      <AdminWorkspaceTopbar
        parent="Aprobaciones"
        current="Cartera en mora"
        userName={user.nombre}
        userRole={user.rolNombre}
      />
      <MoraPortfolioClient />
    </ApprovalDashboardShell>
  );
}
